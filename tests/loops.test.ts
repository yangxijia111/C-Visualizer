// 循环测试：for / while / do-while / break / continue
import { describe, expect, it } from 'vitest';
import { runSrc } from './helpers';

describe('while', () => {
  it('基本求和：1..5', async () => {
    const r = await runSrc(`
      int main() {
        int i = 1;
        int sum = 0;
        while (i <= 5) {
          sum = sum + i;
          i++;
        }
        return 0;
      }
    `);
    expect(r.finalVar('sum')?.value).toBe(15);
    expect(r.finalVar('i')?.value).toBe(6);
  });

  it('每次条件判断是独立步骤', async () => {
    const r = await runSrc(`
      int main() {
        int j = 0;
        while (j < 3) {
          j = j + 1;
        }
        return 0;
      }
    `);
    const checks = r.stepKinds().filter((k) => k === 'while-condition:condition');
    expect(checks.length).toBe(4); // 3 次进入 + 1 次退出
    const last = r.steps.filter((s) => s.statementType === 'while-condition').pop();
    expect(last?.description).toContain('不成立');
  });

  it('条件初始为假：循环体一次都不执行', async () => {
    const r = await runSrc(`
      int main() {
        int x = 100;
        while (x < 10) {
          x = 0;
        }
        return 0;
      }
    `);
    expect(r.finalVar('x')?.value).toBe(100);
    const kinds = r.stepKinds().filter((k) => k === 'while-condition:condition');
    expect(kinds.length).toBe(1);
  });
});

describe('for', () => {
  it('标准三段：init → condition → body → update 循环', async () => {
    const r = await runSrc(`
      int main() {
        int sum = 0;
        for (int i = 0; i < 4; i++) {
          sum = sum + i;
        }
        return 0;
      }
    `);
    expect(r.finalVar('sum')?.value).toBe(6);
    // i 在循环外不可见（finalVar 查不到）
    expect(r.finalVar('i')).toBeUndefined();
  });

  it('步骤序列：init 1 次、condition/update 各 N+1/N 次', async () => {
    const r = await runSrc(`
      int main() {
        for (int i = 0; i < 3; i++) {
          int t = i;
        }
        return 0;
      }
    `);
    const kinds = r.stepKinds();
    expect(kinds.filter((k) => k === 'var-decl').length).toBe(4); // for-init 的 i 1 次 + body 的 t 每轮 1 次
    expect(kinds[0]).toBe('call'); // main 调用
    expect(kinds[1]).toBe('var-decl'); // for 的 init
    const conds = kinds.filter((k) => k === 'for-condition:condition').length;
    const updates = kinds.filter((k) => k === 'for-update:update').length;
    expect(conds).toBe(4); // 3 次真 + 1 次假
    expect(updates).toBe(3);
  });

  it('init 为赋值（已有变量）', async () => {
    const r = await runSrc(`
      int main() {
        int i;
        int sum = 0;
        for (i = 10; i < 13; i++) {
          sum = sum + i;
        }
        return 0;
      }
    `);
    expect(r.finalVar('sum')?.value).toBe(33);
    expect(r.finalVar('i')?.value).toBe(13);
  });

  it('缺条件段：for (;;) 配 break 退出', async () => {
    const r = await runSrc(`
      int main() {
        int n = 0;
        for (;;) {
          n++;
          if (n >= 5) break;
        }
        return 0;
      }
    `);
    expect(r.finalVar('n')?.value).toBe(5);
  });
});

describe('do-while', () => {
  it('至少执行一次', async () => {
    const r = await runSrc(`
      int main() {
        int x = 100;
        do {
          x = x + 1;
        } while (x < 10);
        return 0;
      }
    `);
    expect(r.finalVar('x')?.value).toBe(101);
  });

  it('正常迭代', async () => {
    const r = await runSrc(`
      int main() {
        int j = 3;
        do {
          j = j - 1;
        } while (j > 0);
        return 0;
      }
    `);
    expect(r.finalVar('j')?.value).toBe(0);
  });
});

describe('break / continue', () => {
  it('break 跳出 while', async () => {
    const r = await runSrc(`
      int main() {
        int i = 0;
        while (1) {
          i++;
          if (i == 4) break;
        }
        return 0;
      }
    `);
    expect(r.finalVar('i')?.value).toBe(4);
  });

  it('continue 跳过本轮（while 回到条件）', async () => {
    const r = await runSrc(`
      int main() {
        int i = 0;
        int sum = 0;
        while (i < 10) {
          i++;
          if (i % 2 == 0) continue;
          sum = sum + i;
        }
        return 0;
      }
    `);
    expect(r.finalVar('sum')?.value).toBe(25); // 1+3+5+7+9
  });

  it('continue 在 for 中仍执行 update', async () => {
    const r = await runSrc(`
      int main() {
        int sum = 0;
        for (int i = 0; i < 10; i++) {
          if (i % 2 == 0) continue;
          sum = sum + i;
        }
        return 0;
      }
    `);
    expect(r.finalVar('sum')?.value).toBe(25);
    // update 步骤次数 = 10（每轮都有）
    const updates = r.stepKinds().filter((k) => k === 'for-update:update').length;
    expect(updates).toBe(10);
  });

  it('嵌套循环：break 只跳出内层', async () => {
    const r = await runSrc(`
      int main() {
        int total = 0;
        for (int i = 0; i < 3; i++) {
          for (int j = 0; j < 10; j++) {
            if (j == 2) break;
            total++;
          }
        }
        return 0;
      }
    `);
    expect(r.finalVar('total')?.value).toBe(6); // 每轮内层跑 2 次
  });

  it('switch 里的 break 不影响外层循环（Phase 4+switch 联合）', async () => {
    const r = await runSrc(`
      int main() {
        int total = 0;
        for (int i = 0; i < 4; i++) {
          switch (i) {
            case 1:
              total = total + 10;
              break;
            case 2:
              total = total + 20;
              break;
            default:
              total = total + 1;
              break;
          }
          total = total + 100;
        }
        return 0;
      }
    `);
    // i=0: +1+100=101; i=1: +10+100=211; i=2: +20+100=331; i=3: +1+100=432
    expect(r.finalVar('total')?.value).toBe(432);
  });
});

describe('死循环保护', () => {
  it('while(1) 触发步数上限', async () => {
    const r = await runSrc(`
      int main() {
        int i = 0;
        while (1) {
          i++;
        }
        return 0;
      }
    `, { maxSteps: 100 });
    expect(r.status).toBe('step-limit');
    const last = r.steps[r.steps.length - 1];
    expect(last.status).toBe('step-limit');
    expect(last.description).toContain('无限循环');
  });

  it('死循环的变量状态被保留', async () => {
    const r = await runSrc(`
      int main() {
        int i = 0;
        while (1) {
          i++;
        }
        return 0;
      }
    `, { maxSteps: 60 });
    const finalI = r.finalVar('i');
    expect(finalI).toBeDefined();
    expect((finalI?.value ?? 0)).toBeGreaterThan(0);
  });
});
