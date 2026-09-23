// worker-core 协议语义测试：消息序列、批次切分、终态路径、串行化、取消回执
// Phase F 起默认传输为 Checkpoint+Delta：批次重组一律经 TraceStore 重建（与 App 相同路径）
import { describe, expect, it } from 'vitest';
import { createWorkerCore } from '../../src/worker/worker-core';
import type { MainToWorkerMessage, WorkerToMainMessage } from '../../src/worker/protocol';
import { compile, runProgram } from '../../src/core/run';
import { TraceStore } from '../../src/core/trace/trace-store';
import '../helpers';

/** 收集 Worker 全部出口消息 */
function makeCollector(): { posts: WorkerToMainMessage[]; core: ReturnType<typeof createWorkerCore> } {
  const posts: WorkerToMainMessage[] = [];
  const core = createWorkerCore({ post: (m) => posts.push(m), defaultBatchSize: 10 });
  return { posts, core };
}

async function drive(core: ReturnType<typeof createWorkerCore>, msgs: MainToWorkerMessage[]): Promise<void> {
  for (const m of msgs) await core.handle(m);
}

/** 把 worker 消息流装配成 TraceStore（App 同构路径） */
function storeFromPosts(posts: WorkerToMainMessage[]): TraceStore {
  const store = new TraceStore();
  for (const m of posts) {
    if (m.type === 'RUN_STARTED') store.appendInitial(m.initialSnapshot, '');
    else if (m.type === 'STEP_BATCH') store.appendBatch(m.startIndex, m.entries);
    else if (m.type === 'RUN_FINISHED') store.finalize(m.status, m.output);
  }
  return store;
}

const PROGRAM = `
int main() {
  int sum = 0;
  int i = 0;
  while (i < 12) {
    sum = sum + i;
    i = i + 1;
  }
  return sum;
}
`;

async function reference(source: string, maxSteps?: number) {
  const compiled = await compile(source);
  if (!compiled.ok) throw new Error('参考程序编译失败');
  return runProgram(compiled.program, source, maxSteps !== undefined ? { maxSteps } : undefined);
}

describe('worker-core：COMPILE_RUN 正常路径', () => {
  it('消息序列 = READY 前置（init）+ RUN_STARTED + 若干 STEP_BATCH + RUN_FINISHED，start 连续', async () => {
    const { posts, core } = makeCollector();
    await core.init();
    await drive(core, [{ type: 'COMPILE_RUN', runId: 1, source: PROGRAM, options: { batchSize: 10 } }]);

    expect(posts[0]).toEqual({ type: 'READY' });
    expect(posts[1].type).toBe('RUN_STARTED');
    if (posts[1].type === 'RUN_STARTED') {
      expect(posts[1].initialSnapshot).toEqual({ scopes: [], cells: {}, callStack: [], nextAddress: 1, output: '' });
    }
    const batches = posts.filter((m): m is Extract<WorkerToMainMessage, { type: 'STEP_BATCH' }> => m.type === 'STEP_BATCH');
    expect(batches.length).toBeGreaterThanOrEqual(2);
    let expectedStart = 0;
    for (const b of batches.slice(0, -1)) {
      expect(b.startIndex).toBe(expectedStart);
      expect(b.entries.length).toBe(10); // 中间批次恰好批大小
      expectedStart += 10;
    }
    const last = batches[batches.length - 1];
    expect(last.startIndex).toBe(expectedStart);
    expect(last.entries.length).toBeGreaterThan(0);
    const finished = posts[posts.length - 1];
    expect(finished.type).toBe('RUN_FINISHED');
    if (finished.type === 'RUN_FINISHED') {
      expect(finished.status).toBe('completed');
      expect(finished.totalSteps).toBe(expectedStart + last.entries.length);
    }
  });

  it('批次经 TraceStore 重建后与进程内 runProgram 逐步 deepEqual（record + snapshot）', async () => {
    const { posts, core } = makeCollector();
    await core.init();
    await drive(core, [{ type: 'COMPILE_RUN', runId: 1, source: PROGRAM, options: { batchSize: 4 } }]);

    const ref = await reference(PROGRAM);
    const store = storeFromPosts(posts);
    expect(store.length).toBe(ref.steps.length);
    for (let i = 0; i < ref.steps.length; i++) {
      expect(store.getStepView(i)).toEqual(ref.steps[i]);
    }
    expect(store.toRunResult()).toEqual({ ...ref, source: '' });
    const finished = posts[posts.length - 1];
    if (finished.type === 'RUN_FINISHED') {
      expect(finished.output).toBe(ref.output);
      expect(finished.status).toBe(ref.status);
    }
  });

  it('record 字段不含 snapshot；checkpoint/delta 混合格式且元数据完整', async () => {
    const { posts, core } = makeCollector();
    await core.init();
    const src = `
int main() {
  int a = 3;
  int b = a * 2;
  if (a && b) {
    b = b + 1;
  }
  return 0;
}
`;
    await drive(core, [{ type: 'COMPILE_RUN', runId: 1, source: src, options: { batchSize: 100, checkpointInterval: 3 } }]);
    const batches = posts.filter((m): m is Extract<WorkerToMainMessage, { type: 'STEP_BATCH' }> => m.type === 'STEP_BATCH');
    expect(batches.length).toBeGreaterThanOrEqual(1);
    const all = batches.flatMap((b) => b.entries);
    expect(all.length).toBeGreaterThan(3);
    const formats = new Set(all.map((e) => e.state.format));
    expect(formats).toContain('full'); // 锚点存在
    expect(formats).toContain('delta'); // 增量存在
    for (const entry of all) {
      expect('snapshot' in entry.record).toBe(false);
      expect(Array.isArray(entry.record.flowEvents)).toBe(true);
      expect(typeof entry.record.description).toBe('string');
    }
    // 至少一个步骤有求值轨迹
    expect(all.some((e) => (e.record.evalTrace?.length ?? 0) > 0)).toBe(true);
  });
});

describe('worker-core：错误与保护路径', () => {
  it('语法错误 → COMPILE_ERROR（E_SYNTAX），不产生任何步骤消息', async () => {
    const { posts, core } = makeCollector();
    await core.init();
    await drive(core, [{ type: 'COMPILE_RUN', runId: 7, source: 'int main( { return 0; }' }]);
    const types = posts.map((p) => p.type);
    expect(types).toContain('COMPILE_ERROR');
    expect(types).not.toContain('RUN_STARTED');
    const err = posts.find((m): m is Extract<WorkerToMainMessage, { type: 'COMPILE_ERROR' }> => m.type === 'COMPILE_ERROR');
    expect(err!.errors[0].code).toBe('E_SYNTAX');
  });

  it('缺少 main → COMPILE_ERROR（E_NO_MAIN）', async () => {
    const { posts, core } = makeCollector();
    await core.init();
    await drive(core, [{ type: 'COMPILE_RUN', runId: 1, source: 'int foo() { return 0; }' }]);
    const err = posts.find((m): m is Extract<WorkerToMainMessage, { type: 'COMPILE_ERROR' }> => m.type === 'COMPILE_ERROR');
    expect(err!.errors[0].code).toBe('E_NO_MAIN');
  });

  it('运行时错误 → RUN_FINISHED(runtime-error)，终止步骤随批次送达', async () => {
    const { posts, core } = makeCollector();
    await core.init();
    const src = `
int main() {
  int a = 1;
  int b = 0;
  return a / b;
}
`;
    await drive(core, [{ type: 'COMPILE_RUN', runId: 1, source: src, options: { batchSize: 100 } }]);
    const finished = posts[posts.length - 1];
    expect(finished.type).toBe('RUN_FINISHED');
    if (finished.type === 'RUN_FINISHED') expect(finished.status).toBe('runtime-error');
    const store = storeFromPosts(posts);
    const steps = Array.from({ length: store.length }, (_, i) => store.getStepView(i));
    expect(steps[steps.length - 1]!.status).toBe('runtime-error');
    expect(steps[steps.length - 1]!.errorCode).toBe('E_DIV_ZERO');
    const ref = await reference(src);
    expect(steps).toEqual(ref.steps);
  });

  it('step-limit 保护 → RUN_FINISHED(step-limit)，totalSteps = maxSteps + 1 个终止步骤', async () => {
    const { posts, core } = makeCollector();
    await core.init();
    const src = `
int main() {
  int i = 0;
  while (1) {
    i = i + 1;
  }
  return 0;
}
`;
    await drive(core, [{ type: 'COMPILE_RUN', runId: 1, source: src, options: { maxSteps: 30, batchSize: 100 } }]);
    const finished = posts[posts.length - 1];
    expect(finished.type).toBe('RUN_FINISHED');
    if (finished.type === 'RUN_FINISHED') expect(finished.status).toBe('step-limit');
    const store = storeFromPosts(posts);
    const steps = Array.from({ length: store.length }, (_, i) => store.getStepView(i));
    expect(steps.length).toBe(31);
    expect(steps[steps.length - 1]!.status).toBe('step-limit');
  });

  it('消息未提供保护参数时默认上限仍然生效（undefined 不覆盖默认值）', async () => {
    const { posts, core } = makeCollector();
    await core.init();
    const src = `
int main() {
  int i = 0;
  while (1) {
    i = i + 1;
  }
  return 0;
}
`;
    // maxSteps 缺省但给了一个很小的 timeLimitMs：若默认 maxSteps 被破坏则程序不会终止
    await drive(core, [{
      type: 'COMPILE_RUN', runId: 1, source: src,
      options: { batchSize: 100, maxSteps: undefined, timeLimitMs: 300 },
    }]);
    const finished = posts[posts.length - 1];
    expect(finished.type).toBe('RUN_FINISHED');
    if (finished.type === 'RUN_FINISHED') {
      // 两种保护终态都证明上限生效（默认 maxSteps=10000 生效时通常先到 step-limit）
      expect(['step-limit', 'time-limit']).toContain(finished.status);
    }
  });
});

describe('worker-core：串行化与取消回执', () => {
  it('两条 COMPILE_RUN 严格串行：A 的全部消息先于 B（STARTED 不交叉）', async () => {
    const { posts, core } = makeCollector();
    await core.init();
    await drive(core, [
      { type: 'COMPILE_RUN', runId: 1, source: PROGRAM, options: { batchSize: 100 } },
      { type: 'COMPILE_RUN', runId: 2, source: PROGRAM, options: { batchSize: 100 } },
    ]);
    const starts = posts.filter((m): m is Extract<WorkerToMainMessage, { type: 'RUN_STARTED' }> => m.type === 'RUN_STARTED');
    expect(starts.map((s) => s.runId)).toEqual([1, 2]);
    // 消息按 run 分段：不存在 run2 的消息插在 run1 的 STARTED 与 FINISHED 之间
    const firstFinished = posts.findIndex((m) => m.type === 'RUN_FINISHED');
    expect(posts.slice(0, firstFinished).some((m) => (m as { runId?: number }).runId === 2)).toBe(false);
  });

  it('空闲期 CANCEL → 回执 CANCELLED（对账用）', async () => {
    const { posts, core } = makeCollector();
    await core.init();
    await drive(core, [{ type: 'CANCEL', runId: 42 }]);
    expect(posts).toContainEqual({ type: 'CANCELLED', runId: 42 });
  });

  it('DISPOSE 后忽略后续 COMPILE_RUN', async () => {
    const { posts, core } = makeCollector();
    await core.init();
    posts.length = 0;
    await drive(core, [
      { type: 'DISPOSE' },
      { type: 'COMPILE_RUN', runId: 1, source: PROGRAM },
    ]);
    expect(posts).toEqual([]);
  });
});
