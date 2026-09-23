// v1.0.1 Public Release Hardening 回归测试
// 覆盖：控制流事件分离 / 播放控制边界 / Pages base 构建 / 文档一致性 / 示例库交叉核对 / 核心导出稳定
import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ExecutionStep, FlowEvent } from '../src/core/steps';
import { splitFlowEvents, FLOW_HISTORY_STEPS } from '../src/ui/flow-history';
import { PLAYBACK_SPEEDS, nextStep, prevStep, advancePlaying, playButtonAction, timelineValue } from '../src/ui/playback';
import { PAGES_BASE } from '../src/site-config';
import { compile, runProgram } from '../src/core/run';
import { getParser, setCstSourcesLoader } from '../src/core/cst';
import { EXAMPLES } from '../src/examples';
import { runSrc } from './helpers';

const require = createRequire(import.meta.url);
setCstSourcesLoader(async () => ({ grammar: require.resolve('tree-sitter-c/tree-sitter-c.wasm') }));

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

// ============ 控制流事件分离（ControlFlowPanel 纯逻辑） ============

let nextId = 0;
function mkStep(flowEvents: FlowEvent[]): ExecutionStep {
  nextId++;
  return {
    id: nextId,
    line: 1,
    endLine: 1,
    statementType: 'expr-stmt',
    snapshot: { scopes: [], cells: {}, callStack: [], nextAddress: 1, output: '' },
    changed: { addresses: [], scopeIds: [] },
    flowEvents,
    description: '',
    status: 'ok',
  };
}

const ev = (n: number): FlowEvent => ({ kind: 'goto', label: `L${n}`, fromLine: n, toLine: n + 1 });

describe('控制流事件分离：past 与 now 严格按 step 边界划分', () => {
  it('当前 step 含 0 个事件：不丢上一事件，now 为空', () => {
    const steps = [mkStep([ev(1), ev(2)]), mkStep([ev(3)]), mkStep([])];
    const { past, now } = splitFlowEvents(steps, 2);
    expect(now).toEqual([]);
    // 旧实现 history.slice(0, -1) 会把 ev(3) 误吞进 "当前"，这里必须保留在 past
    expect(past).toEqual([ev(1), ev(2), ev(3)]);
  });

  it('当前 step 含 1 个事件：past 为之前步骤事件，now 恰为该事件', () => {
    const steps = [mkStep([ev(1)]), mkStep([ev(2)]), mkStep([ev(3)])];
    const { past, now } = splitFlowEvents(steps, 2);
    expect(past).toEqual([ev(1), ev(2)]);
    expect(now).toEqual([ev(3)]);
  });

  it('当前 step 含多个事件：全部进入 now，past 不含任何一个（不重复）', () => {
    const steps = [mkStep([ev(1)]), mkStep([ev(2), ev(3), ev(4)])];
    const { past, now } = splitFlowEvents(steps, 1);
    expect(past).toEqual([ev(1)]);
    expect(now).toEqual([ev(2), ev(3), ev(4)]);
    // 无重复：past 与 now 的并集中没有同一对象出现两次
    const all = [...past, ...now];
    expect(new Set(all).size).toBe(all.length);
  });

  it('历史窗口：past 只含最近 FLOW_HISTORY_STEPS 步的事件', () => {
    const steps = Array.from({ length: 20 }, (_, i) => mkStep([ev(i)]));
    const cur = 15;
    const { past, now } = splitFlowEvents(steps, cur);
    expect(past).toEqual(Array.from({ length: FLOW_HISTORY_STEPS }, (_, i) => ev(cur - FLOW_HISTORY_STEPS + i)));
    expect(now).toEqual([ev(cur)]);
  });

  it('currentStep = -1（未开始）：past 与 now 均为空', () => {
    const steps = [mkStep([ev(1)])];
    const { past, now } = splitFlowEvents(steps, -1);
    expect(past).toEqual([]);
    expect(now).toEqual([]);
  });

  it('真实程序（while 条件含 &&：单步产生 2 个事件）不重复不丢失', async () => {
    const r = await runSrc(`
      int main() {
        int i = 0;
        int sum = 0;
        while (i < 3 && sum < 100) {
          i++;
          sum = sum + i;
        }
        return 0;
      }
    `);
    // while 条件步同时产生 short-circuit + loop-check 两个事件
    const multi = r.steps.map((s, i) => ({ i, n: s.flowEvents.length })).filter((x) => x.n >= 2);
    expect(multi.length).toBeGreaterThanOrEqual(1);
    for (const { i } of multi) {
      expect(r.steps[i].flowEvents.map((e) => e.kind)).toContain('short-circuit');
      const { past, now } = splitFlowEvents(r.steps, i);
      expect(now).toEqual(r.steps[i].flowEvents);
      const pastSet = new Set(past);
      for (const e of now) expect(pastSet.has(e)).toBe(false);
    }
  });

  it('全步骤扫描：past+now 恰为窗口内事件拼接，无重复无遗漏', async () => {
    const r = await runSrc(`
      int main() {
        int sum = 0;
        for (int i = 0; i < 12; i++) {
          if (i % 2 == 0 && i > 2) {
            sum = sum + i;
          }
        }
        return 0;
      }
    `);
    for (let k = 0; k < r.steps.length; k++) {
      const { past, now } = splitFlowEvents(r.steps, k);
      const from = Math.max(0, k - FLOW_HISTORY_STEPS);
      const expected = r.steps.slice(from, k + 1).flatMap((s) => s.flowEvents);
      expect([...past, ...now]).toEqual(expected);
    }
  });
});

// ============ 播放控制边界 ============

describe('播放控制边界', () => {
  it('速度档位：正数、递增、与文档口径 0.5/1/2/4/8 步每秒一致', () => {
    expect(PLAYBACK_SPEEDS.length).toBeGreaterThan(0);
    for (const s of PLAYBACK_SPEEDS) expect(s).toBeGreaterThan(0);
    expect([...PLAYBACK_SPEEDS]).toEqual([...PLAYBACK_SPEEDS].sort((a, b) => a - b));
    const spec = readFileSync(path.join(ROOT, 'docs', 'VISUALIZATION_SPEC.md'), 'utf8');
    expect(spec).toContain(`${PLAYBACK_SPEEDS.join('/')} 步每秒`);
  });

  it('nextStep / prevStep：两端钳制', () => {
    expect(nextStep(0, 5)).toBe(1);
    expect(nextStep(4, 5)).toBe(4); // 末尾不越界
    expect(nextStep(0, 0)).toBe(-1); // 空程序（UI 层按钮禁用，纯函数不崩溃即可）
    expect(prevStep(0)).toBe(0);
    expect(prevStep(3)).toBe(2);
  });

  it('advancePlaying：末尾返回 null（停止），中途 +1', () => {
    expect(advancePlaying(0, 5)).toBe(1);
    expect(advancePlaying(3, 5)).toBe(4);
    expect(advancePlaying(4, 5)).toBeNull();
  });

  it('播放/暂停按钮：末尾或未开始时从头播放，否则切换', () => {
    expect(playButtonAction(-1, 5, false)).toEqual({ play: true, step: 0 });
    expect(playButtonAction(4, 5, false)).toEqual({ play: true, step: 0 }); // 末尾重播
    expect(playButtonAction(2, 5, false)).toEqual({ play: true, step: 2 });
    expect(playButtonAction(2, 5, true)).toEqual({ play: false, step: 2 });
  });

  it('时间轴取值：未开始(-1)显示 0', () => {
    expect(timelineValue(-1)).toBe(0);
    expect(timelineValue(7)).toBe(7);
  });
});

// ============ GitHub Pages base 构建 ============

describe('Pages base 构建产物', () => {
  const viteJs = path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js');
  const outPages = path.join(ROOT, 'node_modules', '.release-build', 'pages');
  const outDefault = path.join(ROOT, 'node_modules', '.release-build', 'default');

  function viteBuild(mode: 'pages' | 'production', outDir: string): string {
    const args = [viteJs, 'build', '--mode', mode, '--outDir', outDir, '--emptyOutDir'];
    const res = spawnSync(process.execPath, args, { cwd: ROOT, encoding: 'utf8', timeout: 120000 });
    if (res.status !== 0) {
      throw new Error(`vite build (${mode}) 失败：\n${res.stdout}\n${res.stderr}`);
    }
    return readFileSync(path.join(outDir, 'index.html'), 'utf8');
  }

  it('pages 模式：资源路径以 /C-Visualizer/ 开头，wasm 资源齐全', () => {
    const html = viteBuild('pages', outPages);
    expect(html).toContain(`src="${PAGES_BASE}assets/`);
    expect(html).toContain(`href="${PAGES_BASE}assets/`);
    const assets = readdirSync(path.join(outPages, 'assets'));
    expect(assets.some((f) => f.startsWith('tree-sitter-c') && f.endsWith('.wasm'))).toBe(true);
    expect(assets.some((f) => f.startsWith('web-tree-sitter') && f.endsWith('.wasm'))).toBe(true);
    // wasm 的引用路径也要带上 base（保证 Pages 子路径可加载）
    const js = assets.filter((f) => f.endsWith('.js')).map((f) => readFileSync(path.join(outPages, 'assets', f), 'utf8')).join('\n');
    expect(js).toContain(`${PAGES_BASE}assets/tree-sitter-c`);
    expect(js).toContain(`${PAGES_BASE}assets/web-tree-sitter`);
  }, 180000);

  it('v1.2 worker 产物：worker chunk 独立打包，主入口不再包含 tree-sitter', () => {
    const html = viteBuild('pages', outPages);
    const assets = readdirSync(path.join(outPages, 'assets'));
    // worker chunk（解释器 + 解析器宿主）存在且被主入口以 base 路径引用
    expect(assets.some((f) => f.startsWith('runtime.worker') && f.endsWith('.js'))).toBe(true);
    const workerJs = assets
      .filter((f) => f.startsWith('runtime.worker') && f.endsWith('.js'))
      .map((f) => readFileSync(path.join(outPages, 'assets', f), 'utf8'))
      .join('\n');
    expect(workerJs).toContain(`${PAGES_BASE}assets/tree-sitter-c`);
    // bundle 拆分：主入口不得再引入 tree-sitter 的 wasm 资源引用（P13 §14）；
    // 说明文字里的「tree-sitter」字样不算引用
    const entry = assets
      .filter((f) => /^index-.*\.js$/.test(f))
      .map((f) => readFileSync(path.join(outPages, 'assets', f), 'utf8'))
      .join('\n');
    expect(entry).not.toContain('tree-sitter-c.wasm');
    expect(entry).not.toContain('web-tree-sitter.wasm');
    expect(html).toContain('src=');
  }, 180000);

  it('默认构建：保持根路径 base（本地 preview / 静态部署不受影响）', () => {
    const html = viteBuild('production', outDefault);
    expect(html).toContain('src="/assets/');
    expect(html).not.toContain(`src="${PAGES_BASE}`);
  }, 180000);
});

// ============ 文档一致性 ============

describe('文档与实现一致性', () => {
  const readme = readFileSync(path.join(ROOT, 'README.md'), 'utf8');
  const changelog = readFileSync(path.join(ROOT, 'docs', 'CHANGELOG.md'), 'utf8');
  const roadmap = readFileSync(path.join(ROOT, 'docs', 'ROADMAP.md'), 'utf8');
  const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as { version: string; license: string };

  it('package.json 版本 = CHANGELOG 最新版本', () => {
    const m = changelog.match(/^## \[(\d+\.\d+\.\d+)\]/m);
    expect(m).not.toBeNull();
    expect(pkg.version).toBe(m![1]);
  });

  it('LICENSE 三方一致：文件存在 + package.json 声明 MIT + README 提及', () => {
    expect(existsSync(path.join(ROOT, 'LICENSE'))).toBe(true);
    const license = readFileSync(path.join(ROOT, 'LICENSE'), 'utf8');
    expect(license).toContain('MIT License');
    expect(license).toContain('yangxijia111');
    expect(pkg.license).toBe('MIT');
    expect(readme).toMatch(/MIT/i);
  });

  it('README 包含在线 Demo 地址（与 Pages base 一致）且不含旧倍速表述', () => {
    expect(readme).toContain(`https://yangxijia111.github.io${PAGES_BASE}`);
    expect(readme).toContain('步/秒');
    expect(readme).not.toMatch(/0\.25x|0\.5x|\b1x\b|\b2x\b|\b4x\b|\b8x\b/);
  });

  it('README 提到的示例数量与示例库一致', () => {
    expect(readme).toContain(`${EXAMPLES.length} 个示例`);
  });

  it('CHANGELOG 记录 LICENSE / CI / Pages / 控制流修复', () => {
    expect(changelog).toContain('MIT');
    expect(changelog).toContain('ci.yml');
    expect(changelog).toContain('deploy-pages.yml');
    expect(changelog).toContain('控制流面板');
  });

  it('ROADMAP 包含 v1.0.1 阶段', () => {
    expect(roadmap).toContain('v1.0.1');
  });

  it('README 文档导航中列出的 docs 文件均存在', () => {
    const links = [...readme.matchAll(/\]\((docs\/[A-Za-z0-9_.]+)\)/g)].map((m) => m[1]);
    expect(links.length).toBeGreaterThan(5);
    for (const rel of links) {
      expect(existsSync(path.join(ROOT, rel)), rel).toBe(true);
    }
  });
});

// ============ 示例库交叉核对 ============

describe('示例库交叉核对', () => {
  it('示例 id 唯一且覆盖 README 列举的教学场景', () => {
    const ids = EXAMPLES.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    const joined = ids.join(',');
    for (const scene of ['if', 'switch', 'for', 'factorial', 'pointer', 'goto']) {
      expect(joined, scene).toContain(scene);
    }
  });
});

// ============ 核心导出稳定（公共 API 不被意外破坏） ============

describe('核心导出稳定', () => {
  it('compile / runProgram 可用且类型为函数', async () => {
    expect(typeof compile).toBe('function');
    expect(typeof runProgram).toBe('function');
    const compiled = await compile('int main() { return 0; }');
    expect(compiled.ok).toBe(true);
    if (compiled.ok) {
      const result = runProgram(compiled.program, 'int main() { return 0; }');
      expect(result.steps.length).toBeGreaterThan(0);
      expect(result.status).toBe('completed');
    }
  });

  it('解析器加载接口 / 播放与控制流纯函数 / 站点常量导出存在', () => {
    expect(typeof getParser).toBe('function');
    expect(typeof setCstSourcesLoader).toBe('function');
    expect(typeof splitFlowEvents).toBe('function');
    expect(typeof nextStep).toBe('function');
    expect(typeof PAGES_BASE).toBe('string');
  });
});
