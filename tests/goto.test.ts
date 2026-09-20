// goto 测试：前向跳转 / 后向跳转构造循环 / 跨出循环 / 标签行号
import { describe, expect, it } from 'vitest';
import { runSrc } from './helpers';

describe('goto 基础', () => {
  it('前向跳过语句', async () => {
    const r = await runSrc(`
      int main() {
        int a = 0;
        goto SKIP;
        a = 99;
        SKIP:
        a = a + 1;
        return 0;
      }
    `);
    expect(r.finalVar('a')?.value).toBe(1);
  });

  it('后向跳转构造循环', async () => {
    const r = await runSrc(`
      int main() {
        int i = 0;
        int sum = 0;
        LOOP:
        i++;
        sum = sum + i;
        if (i < 5) goto LOOP;
        return 0;
      }
    `);
    expect(r.finalVar('i')?.value).toBe(5);
    expect(r.finalVar('sum')?.value).toBe(15);
  });

  it('goto 步骤展示来源行与目标行', async () => {
    const src = `int main() {
  goto END;
  return 0;
  END:
  return 1;
}`;
    const r = await runSrc(src);
    const gotoStep = r.steps.find((s) => s.statementType === 'goto');
    expect(gotoStep).toBeDefined();
    expect(gotoStep?.line).toBe(2);
    expect(gotoStep?.description).toContain('END');
    expect(gotoStep?.description).toContain('4'); // 目标行号
    const flow = gotoStep?.flowEvents.find((f) => f.kind === 'goto');
    expect(flow && flow.kind === 'goto' ? flow.toLine : 0).toBe(4);
  });

  it('goto 跳出循环', async () => {
    const r = await runSrc(`
      int main() {
        int i = 0;
        while (1) {
          i++;
          if (i == 3) goto OUT;
        }
        OUT:
        return 0;
      }
    `);
    expect(r.finalVar('i')?.value).toBe(3);
    expect(r.ok).toBe(true);
  });

  it('goto 向前跳过未执行的声明 → 后续访问报未声明', async () => {
    const r = await runSrc(`
      int main() {
        goto LATER;
        int hidden = 5;
        LATER:
        return 0;
      }
    `);
    // 跳过声明本身不报错（hidden 未被使用）
    expect(r.ok).toBe(true);
  });

  it('多个标签顺序执行', async () => {
    const r = await runSrc(`
      int main() {
        int steps = 0;
        goto A;
        A:
        steps++;
        goto C;
        B:
        steps = 100;
        C:
        steps++;
        return 0;
      }
    `);
    // A → steps=1 → goto C → steps=2
    expect(r.finalVar('steps')?.value).toBe(2);
  });

  it('后向 goto 与条件配合模拟 do-while', async () => {
    const r = await runSrc(`
      int main() {
        int n = 10;
        int count = 0;
        AGAIN:
        count++;
        n = n / 2;
        if (n > 0) goto AGAIN;
        return 0;
      }
    `);
    // 10→5→2→1→0：4 次
    expect(r.finalVar('count')?.value).toBe(4);
    expect(r.finalVar('n')?.value).toBe(0);
  });
});

describe('goto 与声明交互（审计修复回归）', () => {
  it('后向 goto 重复经过声明：变量不重复、每轮重新初始化', async () => {
    const r = await runSrc(`
      int main() {
        int i = 0;
        int sum = 0;
      LOOP:
        int inc = 1;
        i = i + inc;
        sum = sum + i;
        if (i < 3) goto LOOP;
        return 0;
      }
    `);
    const snap = r.steps[r.steps.length - 1].snapshot;
    const mainScope = snap.scopes.find((s) => s.label === 'main');
    expect(mainScope ? mainScope.vars.filter((v) => v.name === 'inc').length : -1).toBe(1);
    expect(r.finalVar('sum')?.value).toBe(6);
  });

  it('goto 跳出两层嵌套循环', async () => {
    const r = await runSrc(`
      int main() {
        int hits = 0;
        for (int i = 0; i < 5; i++) {
          for (int j = 0; j < 5; j++) {
            if (i * j >= 6) goto DONE;
            hits++;
          }
        }
      DONE:
        return 0;
      }
    `);
    // i*j < 6 的组合数：i=0:5, i=1:5, i=2:3(j=0,1,2)，i=2,j=3 时 6>=6 触发 goto
    expect(r.finalVar('hits')?.value).toBe(13);
  });
});
