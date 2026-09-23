// v1.2 运行时基准（与 docs/runtime-baseline.json 同程序、同方法，可直接对比）
// 运行：npm run bench（写入 docs/runtime-v1.2-benchmark.json）
// 对比维度：trace 持有内存（full vs checkpoint+delta）、序列化体积、随机 seek、生成开销
import { describe, it } from 'vitest';
import { writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compile, runProgram } from '../../src/core/run';
import { TraceStore } from '../../src/core/trace/trace-store';
import { TraceAssembler } from '../../src/worker/trace-assembler';
import '../helpers'; // 注入 Node 端 wasm 加载器

const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const OUT = resolve(ROOT, 'docs', 'runtime-v1.2-benchmark.json');
const K = 100; // checkpoint 间隔（与产品默认一致）
const BATCH = 100; // 批大小（与产品默认一致）

// 与 baseline 相同的五个程序
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

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}
function gc(): void {
  (globalThis as { gc?: () => void }).gc?.();
}

/** 经 assembler 装入 store（流式等价路径）。
 *  entryJsonBytes = 全部批次的精确 JSON 体积（= store 内容体积 = Worker 传输体积）。
 *  注意：只返回步数而不返回 ref——ref 是全量 trace，若被调用方持有会污染内存测量 */
async function buildStore(src: string): Promise<{ store: TraceStore; buildMs: number; entryJsonBytes: number; steps: number }> {
  const compiled = await compile(src);
  if (!compiled.ok) throw new Error('基准程序编译失败');
  const runs: number[] = [];
  let store: TraceStore | null = null;
  let steps = 0;
  let entryJsonBytes = 0;
  for (let pass = 0; pass < 3; pass++) {
    const t0 = performance.now();
    const r = runProgram(compiled.program, src, {
      onStep: () => undefined, // 与真实 Worker 相同的钩子路径
    });
    const s = new TraceStore();
    s.appendInitial(r.initialSnapshot, src);
    const asm = new TraceAssembler({
      batchSize: BATCH,
      checkpointInterval: K,
      flush: (startIndex, entries) => {
        s.appendBatch(startIndex, entries);
        if (pass === 2) entryJsonBytes += JSON.stringify(entries).length; // 末轮精确计量
      },
    });
    let prev = r.initialSnapshot;
    for (const step of r.steps) {
      asm.feed(step, prev);
      prev = step.snapshot;
    }
    asm.finish();
    s.finalize(r.status, r.output);
    steps = r.steps.length;
    runs.push(performance.now() - t0);
    store = s;
  }
  return { store: store as TraceStore, buildMs: median(runs), entryJsonBytes, steps };
}

/** 固定 seed 随机 seek（经 store 重建） */
function benchStoreSeek(store: TraceStore, seeks = 1000): number {
  let seed = 0x2f6e2b1;
  const rand = (): number => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  const t0 = performance.now();
  let sink = 0;
  for (let k = 0; k < seeks; k++) {
    const i = Math.floor(rand() * store.length);
    sink += store.getSnapshot(i)!.nextAddress;
  }
  const ms = performance.now() - t0;
  if (sink < 0) throw new Error('unreachable');
  return ms;
}

interface Row extends Record<string, unknown> {
  name: string;
  steps: number;
  storeHeapMB: number;
  entryJsonKB: number;
  fullHeapMB: number;
  fullJsonKB: number;
  reductionPercent: number;
  buildMs: number;
  seek1kMs: number;
}

async function benchProgram(name: string, src: string): Promise<Row> {
  // —— Store（checkpoint+delta）持有内存：解释器结果被丢弃后，store 的保留量 ——
  gc();
  const heapBefore = process.memoryUsage().heapUsed;
  const { store, buildMs, entryJsonBytes, steps } = await buildStore(src);
  gc();
  const heapAfterStore = process.memoryUsage().heapUsed;
  const storeHeap = heapAfterStore - heapBefore;

  // —— Full snapshot（v1.1 路径）持有内存：单独一次运行，运行后立即测量 ——
  const compiled = await compile(src);
  if (!compiled.ok) throw new Error('编译失败');
  gc();
  const heapBeforeFull = process.memoryUsage().heapUsed;
  const full = runProgram(compiled.program, src);
  gc();
  const heapAfterFull = process.memoryUsage().heapUsed;
  const fullHeap = heapAfterFull - heapBeforeFull;
  // full trace 的序列化体积（与 baseline 同口径：抽样估算）
  const n = full.steps.length;
  const stride = Math.max(1, Math.floor(n / 100));
  let snapBytes = 0;
  let metaBytes = 0;
  let sampled = 0;
  for (let i = 0; i < n; i += stride) {
    snapBytes += JSON.stringify(full.steps[i].snapshot).length;
    const step = full.steps[i];
    metaBytes += JSON.stringify({ ...step, snapshot: undefined }).length;
    sampled++;
  }
  const fullJson = Math.round((snapBytes / sampled) * n + (metaBytes / sampled) * n + JSON.stringify(full.initialSnapshot).length);

  // 等价性抽检（基准同时是回归测试）
  if (store.length !== steps) throw new Error('store 与 ref 步数不一致');

  return {
    name,
    steps: store.length,
    storeHeapMB: Math.round(storeHeap / 1048576 * 10) / 10,
    entryJsonKB: Math.round(entryJsonBytes / 1024),
    fullHeapMB: Math.round(fullHeap / 1048576 * 10) / 10,
    fullJsonKB: Math.round(fullJson / 1024),
    reductionPercent: fullHeap > 0 ? Math.round((1 - storeHeap / fullHeap) * 1000) / 10 : 0,
    buildMs: Math.round(buildMs * 100) / 100,
    seek1kMs: Math.round(benchStoreSeek(store) * 100) / 100,
  };
}

describe('runtime v1.2 benchmark', () => {
  it('生成 v1.2 对比数据 docs/runtime-v1.2-benchmark.json', async () => {
    const rows: Row[] = [];
    rows.push(await benchProgram('small-sum-100steps', SMALL_SUM));
    rows.push(await benchProgram('medium-array-100cells', MEDIUM_ARRAY_100));
    rows.push(await benchProgram('recursion-fib12', RECURSION_FIB));
    rows.push(await benchProgram('goto-loop-200', GOTO_LOOP));
    rows.push(await benchProgram('large-array-500cells-step-limit', LARGE_500_STEP_LIMIT));

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
        phase: 'v1.2-checkpoint-delta-worker',
        checkpointInterval: K,
        batchSize: BATCH,
        notes: [
          'storeHeapMB = TraceStore(锚点+delta+缓存) 的强制 gc 保留堆；fullHeapMB = v1.1 全量快照 trace 同方法保留堆。',
          'reductionPercent = 1 − storeHeap/fullHeap。',
          'entryJsonKB = 批次条目（锚点快照+delta+元数据）的精确 JSON 体积，等于 Worker→主线程的传输体积；fullJsonKB 与 baseline 的 traceJsonBytesEstimated 同口径。',
          'buildMs = 解释器执行 + diff 装配 + 入 store 的中位耗时（3 次），可与 baseline runMs 对比生成开销。',
          'seek1kMs = 经 store 重建的 1000 次随机跳转（baseline 的 seek 为数组直读）。',
        ],
      },
      results: rows,
    };
    writeFileSync(OUT, JSON.stringify(payload, null, 2) + '\n', 'utf8');
    console.log('v1.2 benchmark written:', OUT);
    console.table(rows.map((r) => ({
      name: r.name, steps: r.steps,
      fullMB: r.fullHeapMB, storeMB: r.storeHeapMB,
      cut: `${r.reductionPercent}%`,
      fullKB: r.fullJsonKB, entryKB: r.entryJsonKB,
      buildMs: r.buildMs, seek1kMs: r.seek1kMs,
    })));
  }, 600000);
});
