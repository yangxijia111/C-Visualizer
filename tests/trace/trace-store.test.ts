// TraceStore 测试：追加/读取/清空/终态/批次连续性校验/RunResult 组装
import { describe, expect, it } from 'vitest';
import { TraceStore } from '../../src/core/trace/trace-store';
import { diffSnapshot } from '../../src/core/trace/delta';
import { compile, runProgram } from '../../src/core/run';
import '../helpers';

const PROGRAM = `
int main() {
  int sum = 0;
  for (int i = 0; i < 30; i++) {
    sum = sum + i;
  }
  return sum % 256;
}
`;

/** 用进程内 runProgram 的结果填充 store（模拟 Worker 全量批次流） */
async function fillStore(src = PROGRAM, batchSize = 10): Promise<{ store: TraceStore; ref: ReturnType<typeof runProgram> }> {
  const compiled = await compile(src);
  if (!compiled.ok) throw new Error('编译失败');
  const ref = runProgram(compiled.program, src);
  const store = new TraceStore();
  store.appendInitial(ref.initialSnapshot, src);
  for (let i = 0; i < ref.steps.length; i += batchSize) {
    store.appendBatch(i, ref.steps.slice(i, i + batchSize).map((step) => ({
      record: (() => {
        const r = { ...step } as Partial<typeof step>;
        delete r.snapshot;
        return r as Parameters<TraceStore['appendBatch']>[1][number]['record'];
      })(),
      state: { format: 'full' as const, snapshot: step.snapshot },
    })));
  }
  store.finalize(ref.status, ref.output);
  return { store, ref };
}

describe('TraceStore：追加与读取', () => {
  it('appendInitial + appendBatch + finalize 后，length / getStepView / getSnapshot 与原 trace 一致', async () => {
    const { store, ref } = await fillStore();
    expect(store.length).toBe(ref.steps.length);
    expect(store.isFinalized).toBe(true);
    expect(store.getInitialSnapshot()).toEqual(ref.initialSnapshot);
    expect(store.getSnapshot(-1)).toEqual(ref.initialSnapshot);
    for (let i = 0; i < ref.steps.length; i++) {
      expect(store.getStepView(i)).toEqual(ref.steps[i]);
      expect(store.getSnapshot(i)).toEqual(ref.steps[i].snapshot);
      expect(store.getRecord(i)!.statementType).toBe(ref.steps[i].statementType);
    }
    expect(store.getStepView(ref.steps.length)).toBeNull();
    expect(store.getSnapshot(ref.steps.length)).toBeNull();
  });

  it('批次切分不影响内容（各种 batch 尺寸结果一致）', async () => {
    for (const size of [1, 7, 100, 10000]) {
      const { store, ref } = await fillStore(PROGRAM, size);
      expect(store.toRunResult()).toEqual(ref);
    }
  });

  it('getSnapshot 返回共享实例，getSnapshotCopy 返回独立副本', async () => {
    const { store } = await fillStore();
    // 取一个 cells 非空的步骤（否则副本互斥无从验证）
    let idx = -1;
    for (let i = 0; i < store.length; i++) {
      if (Object.keys(store.getSnapshot(i)!.cells).length > 0) { idx = i; break; }
    }
    expect(idx).toBeGreaterThanOrEqual(0);
    const a = store.getSnapshot(idx);
    expect(store.getSnapshot(idx)).toBe(a); // 同一实例（缓存契约）
    const copy = store.getSnapshotCopy(idx);
    expect(copy).toEqual(a);
    expect(copy).not.toBe(a);
    copy!.cells = {};
    expect(a!.cells).not.toEqual({}); // 副本修改不影响原快照
  });

  it('空 store / 未 finalize 的边界行为', async () => {
    const store = new TraceStore();
    expect(store.length).toBe(0);
    expect(store.isFinalized).toBe(false);
    expect(store.getInitialSnapshot()).toBeNull();
    expect(store.getStepView(0)).toBeNull();
    expect(store.getFinalStatus()).toBeNull();
    expect(store.toRunResult()).toBeNull();
  });

  it('clear() 后全部状态归零', async () => {
    const { store } = await fillStore();
    store.clear();
    expect(store.length).toBe(0);
    expect(store.isFinalized).toBe(false);
    expect(store.getInitialSnapshot()).toBeNull();
    expect(store.getOutput()).toBe('');
  });

  it('appendInitial 隐式清空旧 trace（新运行开始）', async () => {
    const { store } = await fillStore();
    expect(store.length).toBeGreaterThan(0);
    store.appendInitial({ scopes: [], cells: {}, callStack: [], nextAddress: 1, output: '' }, 'x');
    expect(store.length).toBe(0);
    expect(store.isFinalized).toBe(false);
  });
});

describe('TraceStore：批次协议校验', () => {
  it('startIndex 不连续时抛错（防协议破坏静默损坏 trace）', async () => {
    const compiled = await compile(PROGRAM);
    if (!compiled.ok) throw new Error('编译失败');
    const ref = runProgram(compiled.program, PROGRAM);
    const store = new TraceStore();
    store.appendInitial(ref.initialSnapshot, PROGRAM);
    const entry = {
      record: (() => {
        const r = { ...ref.steps[0] } as Partial<typeof ref.steps[0]>;
        delete r.snapshot;
        return r as Parameters<TraceStore['appendBatch']>[1][number]['record'];
      })(),
      state: { format: 'full' as const, snapshot: ref.steps[0].snapshot },
    };
    expect(() => store.appendBatch(3, [entry])).toThrow(/批次不连续/);
    store.appendBatch(0, [entry]);
    expect(() => store.appendBatch(0, [entry])).toThrow(/批次不连续/);
  });

  it('delta 格式条目被接受：var-add 增量可重建', async () => {
    const compiled = await compile(PROGRAM);
    if (!compiled.ok) throw new Error('编译失败');
    const ref = runProgram(compiled.program, PROGRAM);
    const store = new TraceStore();
    store.appendInitial(ref.initialSnapshot, PROGRAM);
    const record = (() => {
      const r = { ...ref.steps[0] } as Partial<typeof ref.steps[0]>;
      delete r.snapshot;
      return r as Parameters<TraceStore['appendBatch']>[1][number]['record'];
    })();
    // 第 0 步的 delta：initial → steps[0].snapshot
    const delta = diffSnapshot(ref.initialSnapshot, ref.steps[0].snapshot);
    store.appendBatch(0, [{ record, state: { format: 'delta', delta } }]);
    expect(store.getSnapshot(0)).toEqual(ref.steps[0].snapshot);
    expect(store.getStats().deltaSteps).toBe(1);
  });
});

describe('TraceStore：运行终态', () => {
  it('运行时错误程序：终态与终止步骤完整保留', async () => {
    const src = `
int main() {
  int a = 5;
  int b = 0;
  return a / b;
}
`;
    const { store, ref } = await fillStore(src, 100);
    expect(store.getFinalStatus()).toBe('runtime-error');
    expect(store.getOutput()).toBe(ref.output);
    const last = store.getStepView(store.length - 1);
    expect(last!.status).toBe('runtime-error');
    expect(last!.errorCode).toBe('E_DIV_ZERO');
  });

  it('printf 输出：outputDelta 累计与整体 output 一致', async () => {
    const src = `
int main() {
  int i = 0;
  while (i < 5) {
    printf("%d ", i);
    i = i + 1;
  }
  return 0;
}
`;
    const { store, ref } = await fillStore(src, 4);
    let acc = '';
    for (let i = 0; i < store.length; i++) {
      acc += store.getRecord(i)!.outputDelta ?? '';
      expect(store.getSnapshot(i)!.output).toBe(acc);
    }
    expect(store.getOutput()).toBe(ref.output);
  });
});
