// 金标等价验收（P13 核心）：同一程序，进程内全量 Trace vs Assembler+TraceStore(delta) 逐字段对拍
// 覆盖：全部内置示例 + goto/递归/指针/数组/switch 穿透/运行错误/step-limit/深度超限
// + 固定种子随机 seek 1000 次/程序 + 多种 checkpoint 间隔
import { describe, expect, it } from 'vitest';
import { compile, runProgram } from '../../src/core/run';
import { TraceStore } from '../../src/core/trace/trace-store';
import { TraceAssembler } from '../../src/worker/trace-assembler';
import type { RunResult } from '../../src/core/steps';
import type { RunOptions } from '../../src/core/interpreter';
import { EXAMPLES } from '../../src/examples';
import '../helpers';

interface ViaStoreOpts {
  batchSize?: number;
  checkpointInterval?: number;
  runOpts?: RunOptions;
}

/**
 * 模拟 Worker 全链路：解释器全量 trace → TraceAssembler（batch+checkpoint 切分）
 * → TraceStore（delta 存储）→ 重建。feed 输入与真实 Worker 的 onStep 流完全同构；
 * 真实 Worker 传输路径由 worker-core 集成测试与浏览器冒烟另行覆盖。
 */
async function runViaStore(src: string, opts: ViaStoreOpts = {}): Promise<{ store: TraceStore; ref: RunResult }> {
  const compiled = await compile(src);
  if (!compiled.ok) {
    const detail = compiled.errors.map((e) => `${e.code}@${e.line}`).join(',');
    throw new Error(`金标程序编译失败：${detail}`);
  }
  const ref = runProgram(compiled.program, src, opts.runOpts);
  const store = new TraceStore();
  store.appendInitial(ref.initialSnapshot, src);
  const assembler = new TraceAssembler({
    batchSize: opts.batchSize ?? 100,
    checkpointInterval: opts.checkpointInterval ?? 100,
    flush: (startIndex, entries) => store.appendBatch(startIndex, entries),
  });
  let prev = ref.initialSnapshot;
  for (const step of ref.steps) {
    assembler.feed(step, prev);
    prev = step.snapshot;
  }
  assembler.finish();
  store.finalize(ref.status, ref.output);
  return { store, ref };
}

/** 逐步对拍：元数据 + 重建快照与全量 reference 完全一致 */
function expectEquivalent(store: TraceStore, ref: RunResult): void {
  expect(store.length).toBe(ref.steps.length);
  expect(store.getFinalStatus()).toBe(ref.status);
  expect(store.getOutput()).toBe(ref.output);
  for (let i = 0; i < ref.steps.length; i++) {
    expect(store.getStepView(i)).toEqual(ref.steps[i]);
  }
  expect(store.toRunResult()).toEqual(ref);
}

// ============ 语料 ============

const EDGE_PROGRAMS: { name: string; source: string; runOpts?: RunOptions }[] = [
  {
    name: 'goto-后向循环',
    source: `
int main() {
  int i = 0;
  int sum = 0;
loop:
  sum = sum + i;
  i = i + 1;
  if (i < 10) {
    goto loop;
  }
  return sum;
}`,
  },
  {
    name: 'goto-前向跳过声明',
    source: `
int main() {
  int a = 1;
  goto skip;
  a = 99;
skip:
  return a;
}`,
  },
  {
    name: '递归-fib10',
    source: `
int fib(int n) {
  if (n < 2) {
    return n;
  }
  return fib(n - 1) + fib(n - 2);
}
int main() {
  return fib(10) % 256;
}`,
  },
  {
    name: '指针交换',
    source: `
void swap(int *p, int *q) {
  int t = *p;
  *p = *q;
  *q = t;
}
int main() {
  int a = 3;
  int b = 8;
  swap(&a, &b);
  return a * 10 + b;
}`,
  },
  {
    name: 'switch-穿透与break',
    source: `
int main() {
  int x = 2;
  int r = 0;
  switch (x) {
    case 1:
      r = r + 1;
    case 2:
      r = r + 10;
    case 3:
      r = r + 100;
      break;
    default:
      r = r + 1000;
  }
  return r;
}`,
  },
  {
    name: '数组-初始化列表与遍历',
    source: `
int g[4] = {1, 2, 3, 4};
int main() {
  int a[3] = {7, 8, 9};
  int sum = 0;
  int i = 0;
  while (i < 3) {
    sum = sum + a[i] + g[i];
    i = i + 1;
  }
  return sum;
}`,
  },
  {
    name: '运行错误-除零',
    source: `
int main() {
  int a = 10;
  int b = 0;
  return a / b;
}`,
  },
  {
    name: '运行错误-未初始化读取',
    source: `
int main() {
  int x;
  return x + 1;
}`,
  },
  {
    name: '运行错误-数组越界',
    source: `
int main() {
  int a[3];
  a[5] = 1;
  return 0;
}`,
  },
  {
    name: '深度超限-无限递归',
    source: `
int f(int n) {
  return f(n + 1);
}
int main() {
  return f(0);
}`,
  },
  {
    name: 'step-limit-保护',
    source: `
int main() {
  int i = 0;
  while (1) {
    i = i + 1;
  }
  return 0;
}`,
    runOpts: { maxSteps: 137 },
  },
  {
    name: 'printf-与do-while',
    source: `
int main() {
  printf("%d %d\\n", 42, 7);
  int i = 0;
  do {
    printf("i=%d ", i);
    i = i + 1;
  } while (i < 3);
  return 0;
}`,
  },
  {
    name: '嵌套循环-break-continue',
    source: `
int main() {
  int total = 0;
  for (int i = 0; i < 5; i++) {
    if (i == 3) {
      continue;
    }
    for (int j = 0; j < 5; j++) {
      if (j == 4) {
        break;
      }
      total = total + 1;
    }
  }
  return total;
}`,
  },
  {
    name: '短路求值-带副作用',
    source: `
int side(int *c, int v) {
  *c = *c + 1;
  return v;
}
int main() {
  int calls = 0;
  int r = 0 && side(&calls, 1);
  r = r + (1 || side(&calls, 2));
  r = r + (1 && side(&calls, 3));
  return r + calls;
}`,
  },
];

// ============ 金标：全量对拍 ============

describe('金标等价：内置示例（全量逐字对拍）', () => {
  for (const ex of EXAMPLES) {
    it(`示例「${ex.title}」：store 重建与全量 trace 逐步相等`, async () => {
      const { store, ref } = await runViaStore(ex.code);
      expectEquivalent(store, ref);
    });
  }
});

describe('金标等价：边缘语料（goto/递归/指针/错误/保护）', () => {
  for (const p of EDGE_PROGRAMS) {
    it(`${p.name}：store 重建与全量 trace 逐步相等`, async () => {
      const { store, ref } = await runViaStore(p.source, { runOpts: p.runOpts });
      expectEquivalent(store, ref);
    });
  }
});

describe('checkpoint 间隔扫描（K=1/2/97/100000，批=7）', () => {
  const prog = EDGE_PROGRAMS[2]; // 递归
  for (const K of [1, 2, 97, 100000]) {
    it(`K=${K}：重建结果与全量 trace 一致`, async () => {
      const { store, ref } = await runViaStore(prog.source, { batchSize: 7, checkpointInterval: K });
      expectEquivalent(store, ref);
      if (K === 1) {
        expect(store.getStats().deltaSteps).toBe(0); // 每步都是锚点（等价全量）
      }
    });
  }
});

// ============ 随机 seek（固定种子，核心验收） ============

function makeRng(seed: number): () => number {
  let s = seed & 0x7fffffff;
  return () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
}

describe('随机 seek 1000 次/程序（与全量快照逐字段 deepEqual）', () => {
  it('递归程序：随机跳转全部正确（含 LRU 反复驱逐）', async () => {
    const { store, ref } = await runViaStore(EDGE_PROGRAMS[2].source);
    expect(store.length).toBeGreaterThan(32); // 确保 LRU 会被驱逐
    const rng = makeRng(20260923);
    for (let k = 0; k < 1000; k++) {
      const i = Math.floor(rng() * store.length);
      expect(store.getSnapshot(i)).toEqual(ref.steps[i].snapshot);
      expect(store.getStepView(i)).toEqual(ref.steps[i]);
    }
  });

  it('goto 程序：0→末尾→0→任意 的拖动序列全部正确', async () => {
    const { store, ref } = await runViaStore(EDGE_PROGRAMS[0].source);
    const seq = [0, store.length - 1, 0, Math.floor(store.length / 2), 3, store.length - 2];
    const rng = makeRng(42);
    for (let k = 0; k < 1000; k++) seq.push(Math.floor(rng() * store.length));
    for (const i of seq) {
      expect(store.getSnapshot(i)).toEqual(ref.steps[i].snapshot);
    }
  });

  it('step-limit 程序（137 步）：随机跳转全部正确', async () => {
    const { store, ref } = await runViaStore(EDGE_PROGRAMS[10].source, { runOpts: EDGE_PROGRAMS[10].runOpts });
    expect(ref.status).toBe('step-limit');
    const rng = makeRng(7);
    for (let k = 0; k < 1000; k++) {
      const i = Math.floor(rng() * store.length);
      expect(store.getSnapshot(i)).toEqual(ref.steps[i].snapshot);
    }
  });
});

// ============ 缓存确定性 ============

describe('重建缓存不改变结果', () => {
  it('热缓存 store 与冷 store：同下标重建内容一致', async () => {
    const { store, ref } = await runViaStore(EDGE_PROGRAMS[2].source);
    for (let i = 0; i < store.length; i++) store.getSnapshot(i); // 预热缓存
    const { store: cold } = await runViaStore(EDGE_PROGRAMS[2].source);
    for (let i = 0; i < store.length; i++) {
      expect(store.getSnapshot(i)).toEqual(cold.getSnapshot(i));
      expect(store.getSnapshot(i)).toEqual(ref.steps[i].snapshot);
    }
  });
});
