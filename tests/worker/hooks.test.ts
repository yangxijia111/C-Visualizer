// 解释器 v1.2 钩子测试：onStep 观测流（prevState 链）与 shouldCancel 协作取消
import { describe, expect, it } from 'vitest';
import { compile, runProgram } from '../../src/core/run';
import { emptyInitialSnapshot } from '../../src/core/interpreter';
import '../helpers';

const PROGRAM = `
int main() {
  int sum = 0;
  int i = 0;
  while (i < 5) {
    sum = sum + i;
    i = i + 1;
  }
  return sum;
}
`;

describe('onStep 观测回调', () => {
  it('每步触发一次，id 连续；prevState 链 = initialSnapshot → steps[0..n-2].snapshot', async () => {
    const compiled = await compile(PROGRAM);
    if (!compiled.ok) throw new Error('编译失败');
    const seen: { id: number; prevState: unknown }[] = [];
    const result = runProgram(compiled.program, PROGRAM, {
      onStep: (step, prevState) => seen.push({ id: step.id, prevState }),
    });
    expect(seen.map((s) => s.id)).toEqual(result.steps.map((s) => s.id));
    // 第 0 步的 prevState = 空初始快照
    expect(seen[0].prevState).toEqual(emptyInitialSnapshot());
    // 第 k 步的 prevState 与 steps[k-1].snapshot 同一对象（零拷贝观测）
    for (let k = 1; k < result.steps.length; k++) {
      expect(seen[k].prevState).toBe(result.steps[k - 1].snapshot);
    }
  });

  it('终止步骤（step-limit）也触发 onStep（必须流入传输层）', async () => {
    const src = `
int main() {
  int i = 0;
  while (1) {
    i = i + 1;
  }
  return 0;
}
`;
    const compiled = await compile(src);
    if (!compiled.ok) throw new Error('编译失败');
    const statuses: string[] = [];
    const result = runProgram(compiled.program, src, {
      maxSteps: 20,
      onStep: (step) => statuses.push(step.status),
    });
    expect(result.status).toBe('step-limit');
    expect(statuses[statuses.length - 1]).toBe('step-limit');
    expect(statuses.length).toBe(result.steps.length);
  });

  it('onStep 为纯观测：注册与否不改变任何可见结果', async () => {
    const compiled = await compile(PROGRAM);
    if (!compiled.ok) throw new Error('编译失败');
    const plain = runProgram(compiled.program, PROGRAM);
    const observed: unknown[] = [];
    const hooked = runProgram(compiled.program, PROGRAM, {
      onStep: (step, prev) => observed.push([step.id, prev]),
    });
    expect(hooked).toEqual(plain);
    expect(observed.length).toBe(plain.steps.length);
  });
});

describe('shouldCancel 协作取消', () => {
  it('显式 undefined 选项不覆盖默认保护（压测回归：step-limit 必须始终生效）', async () => {
    const { Interpreter } = await import('../../src/core/interpreter');
    const compiled = await compile(PROGRAM);
    if (!compiled.ok) throw new Error('编译失败');
    const interp = new Interpreter(compiled.program, PROGRAM, {
      maxSteps: undefined,
      timeLimitMs: undefined,
      maxCallDepth: undefined,
    });
    expect(interp.opts.maxSteps).toBe(10000);
    expect(interp.opts.timeLimitMs).toBe(10000);
    expect(interp.opts.maxCallDepth).toBe(100);
  });

  it('置位后追加 status=cancelled 终止步骤，RunResult.status=cancelled', async () => {
    const compiled = await compile(PROGRAM);
    if (!compiled.ok) throw new Error('编译失败');
    let steps = 0;
    const result = runProgram(compiled.program, PROGRAM, {
      onStep: () => { steps++; },
      shouldCancel: () => steps >= 4, // 第 4 步后取消
    });
    expect(result.status).toBe('cancelled');
    const last = result.steps[result.steps.length - 1];
    expect(last.status).toBe('cancelled');
    expect(last.statementType).toBe('cancelled');
    expect(result.steps[result.steps.length - 2].status).toBe('ok'); // 取消前最后一步正常
    expect(result.steps.length).toBeLessThan(/** 未取消时约 25 步 */ 25);
  });

  it('取消优先于 step-limit（同一步触发时按取消处理）', async () => {
    const src = `
int main() {
  int i = 0;
  while (1) {
    i = i + 1;
  }
  return 0;
}
`;
    const compiled = await compile(src);
    if (!compiled.ok) throw new Error('编译失败');
    let seen = 0;
    const result = runProgram(compiled.program, src, {
      maxSteps: 10,
      onStep: () => { seen++; },
      shouldCancel: () => seen >= 3,
    });
    expect(result.status).toBe('cancelled');
    expect(result.steps[result.steps.length - 1].status).toBe('cancelled');
  });

  it('永不置位时与无钩子完全一致（cancelled 路径不干扰正常执行）', async () => {
    const compiled = await compile(PROGRAM);
    if (!compiled.ok) throw new Error('编译失败');
    const plain = runProgram(compiled.program, PROGRAM);
    const watched = runProgram(compiled.program, PROGRAM, { shouldCancel: () => false });
    expect(watched).toEqual(plain);
    expect(watched.status).toBe('completed');
  });
});
