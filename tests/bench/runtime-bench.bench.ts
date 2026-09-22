// 运行时基准（v1.2.0 Phase A baseline；可在重构前后重复运行对比）
// 运行：npm run bench（写入 docs/runtime-baseline.json）
// 指标含义见 docs/P13_V1.2_RUNTIME_ARCHITECTURE.md §11
import { describe, it } from 'vitest';
import { writeFileSync, mkdirSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compile, runProgram } from '../../src/core/run';
import type { RunResult } from '../../src/core/steps';
import '../../tests/helpers'; // 注入 Node 端 wasm 加载器

const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const OUT = resolve(ROOT, 'docs', 'runtime-baseline.json');

// ============ 基准程序（目标规模，实际步数以输出为准） ============

/** 小：约 100 步 × 2 cells */
const SMALL_SUM = `
int main() {
  int sum = 0;
  int i = 0;
  while (i < 30) {
    sum = sum + i;
    i = i + 1;
  }
  return sum;
}
`;

/** 中：约 2000 步 × 100 cells（写扫 + 带分支读扫 + 再写扫 + 再读扫） */
const MEDIUM_ARRAY_100 = `
int a[100];
int main() {
  int i = 0;
  while (i < 100) {
    a[i] = i * 2;
    i = i + 1;
  }
  int sum = 0;
  i = 0;
  while (i < 100) {
    if (a[i] % 2 == 0) {
      sum = sum + a[i];
    } else {
      sum = sum + 1;
    }
    i = i + 1;
  }
  i = 0;
  while (i < 100) {
    a[i] = a[i] + 1;
    i = i + 1;
  }
  i = 0;
  while (i < 100) {
    if (a[i] > 100) {
      sum = sum - a[i];
    }
    i = i + 1;
  }
  return sum % 256;
}
`;

/** 大：约 10000 步（触发 step-limit 保护）× 500 cells */
const LARGE_500_STEP_LIMIT = `
int a[500];
int main() {
  int i = 0;
  while (i < 500) {
    a[i] = i;
    i = i + 1;
  }
  int k = 0;
  while (1) {
    a[k] = a[k] + 1;
    k = k + 1;
    if (k >= 500) {
      k = 0;
    }
  }
  return 0;
}
`;

/** 递归：fib(12)，深调用栈 × 数百 cells 累计作用域 */
const RECURSION_FIB = `
int fib(int n) {
  if (n < 2) {
    return n;
  }
  return fib(n - 1) + fib(n - 2);
}
int main() {
  int r = fib(12);
  return r % 256;
}
`;

/** goto：后向跳转构成循环，约 600 步 × 3 cells */
const GOTO_LOOP = `
int main() {
  int i = 0;
  int sum = 0;
loop:
  sum = sum + i;
  i = i + 1;
  if (i < 200) {
    goto loop;
  }
  return sum % 256;
}
`;

// ============ 测量工具 ============

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function gc(): void {
  (globalThis as { gc?: () => void }).gc?.();
}

/** 估算序列化体积：抽样 100 个快照的 JSON 字节数按比例放大（避免整串爆内存） */
function estimateTraceBytes(r: RunResult): { exact: number | null; estimated: number } {
  const n = r.steps.length;
  const stride = Math.max(1, Math.floor(n / 100));
  let snapBytes = 0;
  let metaBytes = 0;
  let sampled = 0;
  for (let i = 0; i < n; i += stride) {
    const step = r.steps[i];
    snapBytes += JSON.stringify(step.snapshot).length;
    metaBytes += JSON.stringify({ ...step, snapshot: undefined }).length;
    sampled++;
  }
  const initial = JSON.stringify(r.initialSnapshot).length;
  const estimated = Math.round((snapBytes / sampled) * n + (metaBytes / sampled) * n + initial);
  return { exact: null, estimated };
}

/** 随机跳转代理：从全量数组直接读快照（v1.1 路径），固定 seed 可复现 */
function benchSeek(r: RunResult, seeks = 1000): number {
  let seed = 0x2f6e2b1;
  const rand = (): number => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  const t0 = performance.now();
  let sink = 0;
  for (let k = 0; k < seeks; k++) {
    const i = Math.floor(rand() * r.steps.length);
    sink += r.steps[i].snapshot.nextAddress;
  }
  const ms = performance.now() - t0;
  if (sink < 0) throw new Error('unreachable');
  return ms;
}

interface ProgramBench {
  name: string;
  source: string;
}

async function benchProgram(p: ProgramBench): Promise<Record<string, unknown>> {
  // 预热（JIT + 首次克隆路径）
  const warm = await compile(p.source);
  if (!warm.ok) throw new Error(`基准程序编译失败：${p.name}`);
  runProgram(warm.program, p.source);

  const compileRuns: number[] = [];
  for (let k = 0; k < 5; k++) {
    const t0 = performance.now();
    const c = await compile(p.source);
    compileRuns.push(performance.now() - t0);
    if (!c.ok) throw new Error('编译失败');
  }

  // 计时：5 次运行取中位数（结果不保留，供下一轮覆盖）
  const runRuns: number[] = [];
  let result: RunResult | null = null;
  for (let k = 0; k < 5; k++) {
    const t0 = performance.now();
    result = runProgram(warm.program, p.source);
    runRuns.push(performance.now() - t0);
  }

  // 内存：单独一次运行，强制 gc 前后取 heapUsed 差（= 单份 Trace 持有内存代理）。
  // 先释放计时轮的引用再取基线，否则新旧 trace 大小相抵、差值趋零
  result = null;
  gc();
  const heapBefore = process.memoryUsage().heapUsed;
  result = runProgram(warm.program, p.source);
  gc();
  const heapAfter = process.memoryUsage().heapUsed;
  if (!globalThis.gc) throw new Error('global.gc 不可用：execArgv 未生效，heap 指标无效');

  const r = result as RunResult;
  const lastSnap = r.steps[r.steps.length - 1]?.snapshot;
  const bytes = estimateTraceBytes(r);
  return {
    name: p.name,
    status: r.status,
    steps: r.steps.length,
    cells: lastSnap ? Object.keys(lastSnap.cells).length : 0,
    scopes: lastSnap ? lastSnap.scopes.length : 0,
    outputBytes: r.output.length,
    compileMsMedian: Math.round(median(compileRuns) * 100) / 100,
    runMsMedian: Math.round(median(runRuns) * 100) / 100,
    runMsAll: runRuns.map((x) => Math.round(x * 100) / 100),
    traceJsonBytesEstimated: bytes.estimated,
    heapUsedDeltaBytes: heapAfter - heapBefore,
    seek1000Ms: Math.round(benchSeek(r) * 100) / 100,
  };
}

// ============ 基准主体 ============

describe('runtime baseline benchmark', () => {
  it('生成 v1.2.0 前基线数据 docs/runtime-baseline.json', async () => {
    const programs = [
      { name: 'small-sum-100steps', source: SMALL_SUM },
      { name: 'medium-array-100cells', source: MEDIUM_ARRAY_100 },
      { name: 'large-array-500cells-step-limit', source: LARGE_500_STEP_LIMIT },
      { name: 'recursion-fib12', source: RECURSION_FIB },
      { name: 'goto-loop-200', source: GOTO_LOOP },
    ];
    const results: Record<string, unknown>[] = [];
    for (const p of programs) results.push(await benchProgram(p));

    let commit = 'unknown';
    try {
      commit = execSync('git rev-parse --short HEAD', { cwd: ROOT, encoding: 'utf8' }).trim();
    } catch {
      /* 非 git 环境忽略 */
    }

    const payload = {
      meta: {
        generatedAt: new Date().toISOString(),
        node: process.version,
        platform: `${process.platform} ${process.arch}`,
        commit,
        phase: 'baseline-v1.1-full-snapshot-main-thread',
        notes: [
          'runMsMedian 即 v1.1 主线程阻塞时长代理（解释器同步运行在 UI 主线程）。',
          'traceJsonBytesEstimated 为快照序列化体积抽样估算（100 个采样点线性放大）。',
          'heapUsedDeltaBytes 在强制 gc 前后测量，为 Trace 持有内存的代理值。',
          'seek1000Ms 为 1000 次随机步跳转（读 steps[i].snapshot）耗时。',
        ],
      },
      results,
    };
    mkdirSync(resolve(ROOT, 'docs'), { recursive: true });
    writeFileSync(OUT, JSON.stringify(payload, null, 2) + '\n', 'utf8');
    console.log('baseline written:', OUT);
    console.table(results.map((r) => ({
      name: r.name, steps: r.steps, cells: r.cells,
      compileMs: r.compileMsMedian, runMs: r.runMsMedian,
      traceKB: Math.round((r.traceJsonBytesEstimated as number) / 1024),
      heapMB: Math.round((r.heapUsedDeltaBytes as number) / 1048576),
      seek1kMs: r.seek1000Ms,
    })));
  }, 600000);
});
