// 浏览器 Stress 实测（P13 §15 / 任务书 §30、§42）：headless Chrome + 原生 CDP
// 覆盖：主线程长任务观测（不冻结）/ 10k step-limit 保护 / 运行中取消 / 快速三连 Run /
// 运行中编辑源码自动取消 / 时间轴随机跳转 / 播放控制
// 用法：先 `npx vite preview --port 4173 --mode pages`，再 `node scripts/browser-stress.mjs`
import { spawn } from 'node:child_process';

const BASE = process.argv[2] ?? 'http://localhost:4173/';
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 9226;

const chrome = spawn(CHROME, [
  `--remote-debugging-port=${PORT}`,
  '--headless=new',
  '--no-first-run',
  '--no-default-browser-check',
  '--user-data-dir=' + process.env.TEMP + '/cv-stress-profile',
  'about:blank',
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getWsUrl() {
  for (let i = 0; i < 30; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const tabs = await res.json();
      const page = tabs.find((t) => t.type === 'page');
      if (page) return page.webSocketDebuggerUrl;
    } catch { /* chrome 尚未就绪 */ }
    await sleep(300);
  }
  throw new Error('无法连接 Chrome CDP');
}

let ws;
let msgId = 0;
const pending = new Map();

function send(method, params, sessionId) {
  const id = ++msgId;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
}

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
  if (!ok) process.exitCode = 1;
}

async function main() {
  const wsUrl = await getWsUrl();
  ws = new WebSocket(wsUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id);
      pending.delete(m.id);
      if (m.error) p.reject(new Error(m.error.message));
      else p.resolve(m.result);
    }
  };

  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  const evl = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }, sessionId);
    if (r.exceptionDetails) throw new Error('页面异常: ' + JSON.stringify(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text));
    return r.result.value;
  };

  // 页面加载前注入长任务观测器（主线程阻塞实测）
  await send('Page.addScriptToEvaluateOnNewDocument', {
    source: `
      window.__longtasks = [];
      try {
        new PerformanceObserver((list) => {
          for (const e of list.getEntries()) window.__longtasks.push(Math.round(e.duration));
        }).observe({ entryTypes: ['longtask'] });
      } catch (e) { /* 不支持则跳过 */ }
    `,
  }, sessionId);
  await send('Page.enable', {}, sessionId);
  await send('Page.navigate', { url: BASE }, sessionId);
  await sleep(3000);

  const BIG_PROGRAM = `int a[500];
int main() {
  int i = 0;
  while (i < 500) { a[i] = i; i = i + 1; }
  int k = 0;
  while (1) { a[k] = a[k] + 1; k = k + 1; if (k >= 500) { k = 0; } }
  return 0;
}`;

  const setProgram = (code) => evl(`(() => {
    const cm = document.querySelector('.cm-content');
    cm.focus();
    document.execCommand('selectAll');
    document.execCommand('insertText', false, ${JSON.stringify(code)});
    return true;
  })()`);
  const ui = () => evl(`(() => {
    const btns = [...document.querySelectorAll('button')];
    const run = document.querySelector('button.primary');
    return {
      runLabel: run?.textContent ?? null,
      runDisabled: run?.disabled ?? null,
      stopVisible: btns.some((b) => b.title === '停止当前执行'),
      indicator: document.querySelector('.step-indicator')?.textContent ?? null,
      desc: document.querySelector('.step-desc')?.textContent?.slice(0, 50) ?? null,
      error: document.querySelector('.error-banner')?.textContent ?? null,
    };
  })()`);
  const resetLongtasks = () => evl('window.__longtasks = []; true');
  const longtasks = () => evl('window.__longtasks');

  // ============ A. 大程序(10k×500 cells)运行：主线程不冻结 + 流式进度 + step-limit 保护 ============
  await setProgram(BIG_PROGRAM);
  await sleep(150);
  await resetLongtasks();
  const t0 = Date.now();
  await evl(`document.querySelector('button.primary').click(); true`);

  // 运行中：停止按钮出现 + 进度显示（流式）
  let sawProgress = false;
  let sawStop = false;
  while (Date.now() - t0 < 20000) {
    const s = await ui();
    if (s.stopVisible) sawStop = true;
    if (/已生成 \d+ 步/.test(s.indicator) && !/已生成 0 步/.test(s.indicator)) sawProgress = true;
    if (!/运行中/.test(s.runLabel)) break;
    await sleep(120);
  }
  const elapsed = Date.now() - t0;
  // 跳到最后一步读取终止描述（运行结束后 currentStep 回到 0）
  await evl(`(() => {
    const tl = document.querySelector('.timeline');
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(tl), 'value').set;
    setter.call(tl, Number(tl.max));
    tl.dispatchEvent(new Event('input', { bubbles: true }));
    tl.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);
  await sleep(150);
  const finalA = await ui();
  check('A1 运行中出现「停止」按钮', sawStop);
  check('A2 流式进度可见（已生成 N 步）', sawProgress, finalA.indicator);
  check('A3 step-limit 保护正常终止（10001 步 + 终止说明）', /10001 步/.test(finalA.indicator) && (finalA.desc.includes('无限循环') || finalA.desc.includes('自动停止')), `${finalA.indicator} / ${finalA.desc}`);
  check('A4 运行期间无错误横幅', !finalA.error);
  const lt = await longtasks();
  const maxTask = lt.length ? Math.max(...lt) : 0;
  check('A5 主线程无长任务（全部 < 200ms）', maxTask < 200, `长任务数=${lt.length}, 最大=${maxTask}ms`);
  console.log(`    (大程序端到端 ${elapsed}ms)`);

  // ============ B. 时间轴随机跳转（播放控制 + 重建） ============
  await setProgram(`int main() { int s = 0; for (int i = 0; i < 200; i++) { s = s + i; } return s % 256; }`);
  await sleep(150);
  await evl(`document.querySelector('button.primary').click(); true`);
  await sleep(1200);
  const seekSeq = [0, 150, 30, 400, 88, 200, 7];
  let seekOk = true;
  for (const target of seekSeq) {
    await evl(`(() => {
      const tl = document.querySelector('.timeline');
      const max = Number(tl.max);
      const proto = Object.getPrototypeOf(tl);
      const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
      setter.call(tl, Math.min(max, ${target}));
      tl.dispatchEvent(new Event('input', { bubbles: true }));
      tl.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`);
    await sleep(80);
    const ind = (await ui()).indicator;
    const m = /第 (\d+) \/ (\d+) 步/.exec(ind);
    if (!m || Number(m[1]) !== Math.min(Number(m[2]), target) + 1) { seekOk = false; }
  }
  check('B1 时间轴随机跳转正确', seekOk);

  // ============ C. 运行中取消（■ 停止） ============
  await setProgram(BIG_PROGRAM);
  await sleep(150);
  await evl(`document.querySelector('button.primary').click(); true`);
  await sleep(500); // 等运行开始
  await evl(`(() => {
    const btns = [...document.querySelectorAll('button')];
    const stop = btns.find((b) => b.title === '停止当前执行');
    if (stop) stop.click();
    return !!stop;
  })()`);
  await sleep(400);
  const finalC = await ui();
  check('C1 停止后立即回到可运行状态', finalC.runLabel === '▶ 运行' && !finalC.runDisabled, JSON.stringify(finalC));

  // ============ D. 快速三连 Run ============
  await setProgram(`int main() { int s = 0; for (int i = 0; i < 50; i++) { s = s + i; } return s % 256; }`);
  await sleep(150);
  await evl(`(() => {
    const run = document.querySelector('button.primary');
    run.click(); run.click(); run.click();
    return true;
  })()`);
  await sleep(1500);
  const finalD = await ui();
  check('D1 三连 Run 无错误且结果完整', !finalD.error && /第 1 \/ \d+ 步/.test(finalD.indicator), finalD.indicator);

  // ============ E. 运行中编辑源码自动取消 ============
  await setProgram(BIG_PROGRAM);
  await sleep(150);
  await evl(`document.querySelector('button.primary').click(); true`);
  await sleep(500);
  const wasRunning = (await ui()).runLabel.includes('运行中');
  await setProgram(`int main() { return 0; }`); // 运行中修改源码
  await sleep(400);
  const finalE = await ui();
  check('E1 编辑自动取消运行', wasRunning && finalE.runLabel === '▶ 运行', JSON.stringify(finalE));

  // ============ F. 汇总长任务 ============
  const ltAll = await longtasks();
  const maxAll = ltAll.length ? Math.max(...ltAll) : 0;
  check('F1 全程主线程无 >200ms 长任务', maxAll < 200, `最大=${maxAll}ms, 条数=${ltAll.length}`);

  const failed = results.filter((r) => !r.ok).length;
  console.log(`\nSTRESS ${failed === 0 ? 'PASS' : 'FAIL'} (${results.length - failed}/${results.length})`);
}

main()
  .catch((e) => { console.error('STRESS ERROR:', e.message); process.exitCode = 1; })
  .finally(() => {
    try { chrome.kill(); } catch { /* ignore */ }
  });
