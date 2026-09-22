// break / continue 静态合法性 + 运行时上下文展示（SEMANTIC_MODEL §4）
import { describe, expect, it } from 'vitest';
import { compileOk, compileErr, runSrc } from '../helpers';

describe('break / continue 静态合法性', () => {
  it('顶层 break → 编译错误', async () => {
    const errors = await compileErr('int main() {\n  break;\n  return 0;\n}');
    expect(errors.some((e) => e.code === 'E_TYPE' && e.message.includes('break'))).toBe(true);
  });

  it('顶层 continue → 编译错误', async () => {
    const errors = await compileErr('int main() {\n  continue;\n  return 0;\n}');
    expect(errors.some((e) => e.code === 'E_TYPE' && e.message.includes('continue'))).toBe(true);
  });

  it('switch 内 continue（无外层循环）→ 编译错误', async () => {
    const errors = await compileErr(`
      int main() {
          switch (1) {
              case 1:
                  continue;
          }
          return 0;
      }
    `);
    expect(errors.some((e) => e.code === 'E_TYPE' && e.message.includes('continue'))).toBe(true);
  });

  it('循环内 switch 内 break + 循环内 continue → 合法', async () => {
    await compileOk(`
      int main() {
          while (1) {
              switch (1) {
                  case 1:
                      break;
              }
              continue;
          }
          return 0;
      }
    `);
  });

  it('块内的顶层 break（块本身不在循环内）→ 编译错误', async () => {
    const errors = await compileErr(`
      int main() {
          {
              break;
          }
          return 0;
      }
    `);
    expect(errors.some((e) => e.code === 'E_TYPE' && e.message.includes('break'))).toBe(true);
  });

  it('函数体内 break（调用点在循环内）→ 编译错误（函数边界重置上下文）', async () => {
    const errors = await compileErr(`
      void f() {
          break;
      }
      int main() {
          while (1) {
              f();
          }
          return 0;
      }
    `);
    expect(errors.some((e) => e.code === 'E_TYPE' && e.message.includes('break'))).toBe(true);
  });

  it('if 分支在循环内 break → 合法', async () => {
    await compileOk(`
      int main() {
          for (int i = 0; i < 10; i++) {
              if (i == 5) break;
          }
          return 0;
      }
    `);
  });

  it('循环内嵌套块中 continue → 合法（作用于最近循环）', async () => {
    const r = await runSrc(`
      int main() {
          int count = 0;
          for (int i = 0; i < 5; i++) {
              {
                  if (i % 2 == 0) continue;
                  count++;
              }
          }
          return 0;
      }
    `);
    expect(r.ok).toBe(true);
    expect(r.finalVar('count')?.value).toBe(2);
  });

  it('循环内的 switch 中 break 只跳出 switch，循环继续', async () => {
    const r = await runSrc(`
      int main() {
          int rounds = 0;
          for (int i = 0; i < 3; i++) {
              switch (i) {
                  case 0:
                      break;
                  default:
                      rounds++;
                      break;
              }
              rounds = rounds + 10;
          }
          return 0;
      }
    `);
    // 每轮 switch 都被 break 跳出，rounds 每轮 +10，i=1,2 时额外 +1 → 30+2=32
    expect(r.ok).toBe(true);
    expect(r.finalVar('rounds')?.value).toBe(32);
  });

  it('continue 在 for 中先执行 update', async () => {
    const r = await runSrc(`
      int main() {
          int sum = 0;
          for (int i = 0; i < 5; i++) {
              if (i == 2) continue;
              sum = sum + i;
          }
          return 0;
      }
    `);
    expect(r.finalVar('sum')?.value).toBe(8); // 0+1+3+4
  });
});

describe('break / continue 的运行时归属展示', () => {
  it('switch 内 break 的控制流事件 from=switch，描述为跳出 switch', async () => {
    const r = await runSrc(`
      int main() {
          switch (1) {
              case 1:
                  break;
          }
          return 0;
      }
    `);
    const breakStep = r.steps.find((s) => s.statementType === 'break');
    expect(breakStep).toBeDefined();
    expect(breakStep?.description).toContain('switch');
    const ev = breakStep?.flowEvents.find((f) => f.kind === 'break');
    expect(ev && ev.kind === 'break' ? ev.from : undefined).toBe('switch');
  });

  it('循环内 break 的控制流事件 from=loop（保持既有行为）', async () => {
    const r = await runSrc(`
      int main() {
          while (1) {
              break;
          }
          return 0;
      }
    `);
    const breakStep = r.steps.find((s) => s.statementType === 'break');
    expect(breakStep?.description).toContain('循环');
    const ev = breakStep?.flowEvents.find((f) => f.kind === 'break');
    expect(ev && ev.kind === 'break' ? ev.from : undefined).toBe('loop');
  });

  it('循环内 switch 内 break → from=switch（就近可中断构造）', async () => {
    const r = await runSrc(`
      int main() {
          while (1) {
              switch (1) {
                  case 1:
                      break;
              }
              break;
          }
          return 0;
      }
    `);
    const breaks = r.steps.filter((s) => s.statementType === 'break');
    expect(breaks.length).toBe(2);
    const first = breaks[0].flowEvents.find((f) => f.kind === 'break');
    const second = breaks[1].flowEvents.find((f) => f.kind === 'break');
    expect(first && first.kind === 'break' ? first.from : '').toBe('switch');
    expect(second && second.kind === 'break' ? second.from : '').toBe('loop');
  });

  it('continue 事件标注真实循环类型', async () => {
    const r = await runSrc(`
      int main() {
          for (int i = 0; i < 2; i++) {
              continue;
          }
          return 0;
      }
    `);
    const contStep = r.steps.find((s) => s.statementType === 'continue');
    const ev = contStep?.flowEvents.find((f) => f.kind === 'continue');
    expect(ev && ev.kind === 'continue' ? ev.loopType : '').toBe('for');
  });

  it('do-while 中 continue 事件标注 do-while', async () => {
    const r = await runSrc(`
      int main() {
          int i = 0;
          do {
              i++;
              continue;
          } while (i < 3);
          return 0;
      }
    `);
    const contStep = r.steps.find((s) => s.statementType === 'continue');
    const ev = contStep?.flowEvents.find((f) => f.kind === 'continue');
    expect(ev && ev.kind === 'continue' ? ev.loopType : '').toBe('do-while');
  });
});
