// 真实浏览器冒烟：加载 preview 页面，确认 Worker + wasm 初始化与一次完整运行
// 通过 CDP（原生 WebSocket）驱动 headless Chrome；用于 v1.2 运行时架构验证
// 用法：node scripts/worker-smoke.mjs [baseUrl]
import { spawn } from 'node:child_process';

const BASE = process.argv[2] ?? 'http://localhost:4173/';
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 9223;

const chrome = spawn(CHROME, [
  `--remote-debugging-port=${PORT}`,
  '--headless=new',
  '--no-first-run',
  '--no-default-browser-check',
  '--user-data-dir=' + process.env.TEMP + '/cv-smoke-profile',
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
    const r = await send('Runtime.evaluate', {
      expression: expr,
      awaitPromise: true,
      returnByValue: true,
    }, sessionId);
    if (r.exceptionDetails) throw new Error('页面异常: ' + JSON.stringify(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text));
    return r.result.value;
  };

  await send('Page.enable', {}, sessionId);
  await send('Page.navigate', { url: BASE }, sessionId);
  await sleep(2500); // 等待加载 + worker 预热

  // 1. 页面已渲染且 worker 预热完成（运行按钮可用）
  const ui0 = await evl(`(() => {
    const btn = document.querySelector('button.primary');
    return { label: btn?.textContent ?? null, disabled: btn?.disabled ?? null };
  })()`);
  console.log('初始 UI:', JSON.stringify(ui0));
  if (ui0.disabled) throw new Error('运行按钮仍禁用（worker 预热失败？）');

  // 2. 写入测试程序并运行（for 循环 25 次）
  await evl(`(() => {
    const cm = document.querySelector('.cm-content');
    cm.focus();
    document.execCommand('selectAll');
    document.execCommand('insertText', false, 'int main() {\\n  int sum = 0;\\n  for (int i = 0; i < 25; i++) {\\n    sum = sum + i;\\n  }\\n  return sum;\\n}');
    return true;
  })()`);
  await sleep(200);
  await evl(`document.querySelector('button.primary').click(); true`);
  await sleep(2500); // 等待编译 + 执行 + 渲染

  const ui1 = await evl(`(() => {
    const ind = document.querySelector('.step-indicator');
    const desc = document.querySelector('.step-desc');
    const banner = document.querySelector('.error-banner');
    return {
      indicator: ind?.textContent ?? null,
      desc: desc?.textContent?.slice(0, 60) ?? null,
      error: banner?.textContent ?? null,
    };
  })()`);
  console.log('运行后 UI:', JSON.stringify(ui1));
  if (ui1.error) throw new Error('出现错误横幅: ' + ui1.error);
  if (!/\d+ \/ \d+ 步/.test(ui1.indicator ?? '')) throw new Error('步骤指示器异常: ' + ui1.indicator);

  // 3. Next / Previous / Timeline 跳转仍可用
  await evl(`(() => {
    const btns = [...document.querySelectorAll('button')];
    const next = btns.find((b) => b.title === '下一步');
    next.click();
    return true;
  })()`);
  await sleep(150);
  const ui3 = await evl(`document.querySelector('.step-indicator')?.textContent ?? null`);
  console.log('下一步后:', ui3);
  if (!/第 2 \/ \d+ 步/.test(ui3)) throw new Error('下一步失败: ' + ui3);

  console.log('SMOKE PASS');
}

main()
  .catch((e) => { console.error('SMOKE FAIL:', e.message); process.exitCode = 1; })
  .finally(() => {
    try { chrome.kill(); } catch { /* ignore */ }
  });
