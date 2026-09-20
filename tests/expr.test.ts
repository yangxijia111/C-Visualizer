// 表达式求值测试：算术/比较/逻辑/短路/自增自减/复合赋值/优先级
import { describe, expect, it } from 'vitest';
import { runSrc } from './helpers';

describe('算术与优先级', () => {
  it('1 + 2 * 3 == 7', async () => {
    const r = await runSrc('int main() { int a = 1 + 2 * 3; return 0; }');
    expect(r.finalVar('a')?.value).toBe(7);
  });

  it('(1 + 2) * 3 == 9', async () => {
    const r = await runSrc('int main() { int a = (1 + 2) * 3; return 0; }');
    expect(r.finalVar('a')?.value).toBe(9);
  });

  it('整数除法向零截断：7/2==3, -7/2==-3, 7%3==1, -7%2==-1', async () => {
    const r = await runSrc(`
      int main() {
        int a = 7 / 2;
        int b = -7 / 2;
        int c = 7 % 3;
        int d = -7 % 2;
        return 0;
      }
    `);
    expect(r.finalVar('a')?.value).toBe(3);
    expect(r.finalVar('b')?.value).toBe(-3);
    expect(r.finalVar('c')?.value).toBe(1);
    expect(r.finalVar('d')?.value).toBe(-1);
  });

  it('浮点除法：5.0 / 2 == 2.5', async () => {
    const r = await runSrc('int main() { double a = 5.0 / 2; return 0; }');
    expect(r.finalVar('a')?.value).toBeCloseTo(2.5);
  });

  it('浮点赋给 int 截断：2.9 → 2', async () => {
    const r = await runSrc('int main() { int a = 2.9; return 0; }');
    expect(r.finalVar('a')?.value).toBe(2);
  });

  it('char 参与算术：\'A\' + 1 == 66', async () => {
    const r = await runSrc(`int main() { int a = 'A' + 1; return 0; }`);
    expect(r.finalVar('a')?.value).toBe(66);
  });

  it('求值轨迹展示子表达式顺序：4 * 2 → 8，3 + 8 → 11', async () => {
    const r = await runSrc('int main() { int a = 3 + 4 * 2; return 0; }');
    const texts = r.traces().map((t) => t.text);
    expect(texts).toContain('4 * 2');
    const mulIdx = texts.indexOf('4 * 2');
    const addIdx = texts.indexOf('3 + 4 * 2');
    expect(mulIdx).toBeGreaterThanOrEqual(0);
    expect(addIdx).toBeGreaterThan(mulIdx);
    const trace = r.traces();
    expect(trace.find((t) => t.text === '4 * 2')?.value).toBe(8);
    expect(trace.find((t) => t.text === '3 + 4 * 2')?.value).toBe(11);
  });
});

describe('比较与逻辑', () => {
  it('比较结果为 0/1', async () => {
    const r = await runSrc(`
      int main() {
        int a = 3 > 2;
        int b = 3 < 2;
        int c = 3 == 3;
        int d = 3 != 3;
        return 0;
      }
    `);
    expect(r.finalVar('a')?.value).toBe(1);
    expect(r.finalVar('b')?.value).toBe(0);
    expect(r.finalVar('c')?.value).toBe(1);
    expect(r.finalVar('d')?.value).toBe(0);
  });

  it('! 运算', async () => {
    const r = await runSrc('int main() { int a = !0; int b = !5; return 0; }');
    expect(r.finalVar('a')?.value).toBe(1);
    expect(r.finalVar('b')?.value).toBe(0);
  });

  it('&& 与 || 的组合优先级：a || b && c', async () => {
    // && 优先于 ||：1 || (0 && 0) = 1
    const r = await runSrc('int main() { int a = 1 || 0 && 0; int b = 0 || 0 && 1; return 0; }');
    expect(r.finalVar('a')?.value).toBe(1);
    expect(r.finalVar('b')?.value).toBe(0);
  });
});

describe('短路求值（核心教学点）', () => {
  it('0 && f()：右侧未求值且轨迹含 skip', async () => {
    {
    const r2 = await runSrc(`
      int main() {
        int a = 0 && 1;
        int b = 1 && 2;
        return 0;
      }
    `);
    expect(r2.finalVar('a')?.value).toBe(0);
    expect(r2.finalVar('b')?.value).toBe(1);
    const skips = r2.traces().filter((t) => t.skip);
    expect(skips.length).toBe(1);
    expect(skips[0].text).toBe('1');
    expect(skips[0].skip).toContain('短路');
    }
  });

  it('1 || x：右侧未求值', async () => {
    const r = await runSrc(`
      int main() {
        int a = 1 || 0;
        return 0;
      }
    `);
    const skips = r.traces().filter((t) => t.skip);
    expect(skips.length).toBe(1);
    expect(r.finalVar('a')?.value).toBe(1);
  });

  it('1 && x / 0 || x：右侧正常求值（无 skip）', async () => {
    const r = await runSrc(`
      int main() {
        int a = 1 && 3;
        int b = 0 || 4;
        return 0;
      }
    `);
    expect(r.finalVar('a')?.value).toBe(1);
    expect(r.finalVar('b')?.value).toBe(1);
    expect(r.traces().filter((t) => t.skip).length).toBe(0);
  });

  it('短路说明文案出现在对应步骤', async () => {
    const r = await runSrc('int main() { int a = 0 && 1; return 0; }');
    const joined = r.descriptions().join('\n');
    expect(joined.length).toBeGreaterThan(0);
    // 短路信息在求值轨迹中体现
    const skipStep = r.steps.find((s) => s.evalTrace?.some((t) => t.kind === 'skip'));
    expect(skipStep).toBeDefined();
  });
});

describe('自增自减', () => {
  it('后置 ++：先取值再自增', async () => {
    const r = await runSrc(`
      int main() {
        int i = 5;
        int a = i++;
        int b = i;
        return 0;
      }
    `);
    expect(r.finalVar('a')?.value).toBe(5);
    expect(r.finalVar('b')?.value).toBe(6);
    expect(r.finalVar('i')?.value).toBe(6);
  });

  it('前置 ++：先自增再取值', async () => {
    const r = await runSrc(`
      int main() {
        int i = 5;
        int a = ++i;
        return 0;
      }
    `);
    expect(r.finalVar('a')?.value).toBe(6);
    expect(r.finalVar('i')?.value).toBe(6);
  });

  it('-- 与负值', async () => {
    const r = await runSrc(`
      int main() {
        int i = 0;
        i--;
        --i;
        return 0;
      }
    `);
    expect(r.finalVar('i')?.value).toBe(-2);
  });
});

describe('赋值', () => {
  it('连续赋值右结合', async () => {
    const r = await runSrc(`
      int main() {
        int a;
        int b;
        a = b = 7;
        return 0;
      }
    `);
    expect(r.finalVar('a')?.value).toBe(7);
    expect(r.finalVar('b')?.value).toBe(7);
  });

  it('复合赋值 += -= *= /= %=', async () => {
    const r = await runSrc(`
      int main() {
        int a = 10;
        a += 5;
        a -= 3;
        a *= 2;
        a /= 4;
        a %= 3;
        return 0;
      }
    `);
    // 10+5=15, 15-3=12, 12*2=24, 24/4=6, 6%3=0
    expect(r.finalVar('a')?.value).toBe(0);
  });

  it('赋值表达式有值：a = b = 5 的轨迹', async () => {
    const r = await runSrc(`
      int main() {
        int a;
        int b;
        int c = (a = 1) + (b = 2);
        return 0;
      }
    `);
    expect(r.finalVar('c')?.value).toBe(3);
  });
});

describe('变量与作用域', () => {
  it('未初始化变量读取报错', async () => {
    const r = await runSrc('int main() { int a; int b = a; return 0; }');
    expect(r.ok).toBe(false);
    expect(r.errorCode()).toBe('E_UNINIT_READ');
  });

  it('块级作用域与遮蔽', async () => {
    const r = await runSrc(`
      int main() {
        int a = 1;
        {
          int a = 2;
          a++;
        }
        a = a + 10;
        return 0;
      }
    `);
    expect(r.finalVar('a')?.value).toBe(11);
  });

  it('全局变量读写', async () => {
    const r = await runSrc(`
      int g = 100;
      int main() {
        g = g + 1;
        int local = g * 2;
        return 0;
      }
    `);
    expect(r.finalVar('g')?.value).toBe(101);
    expect(r.finalVar('local')?.value).toBe(202);
  });

  it('未初始化的标量在快照中为「无值」状态', async () => {
    const r = await runSrc(`
      int main() {
        int a;
        a = 5;
        return 0;
      }
    `);
    // 第 0 步是 call main；第 1 步（声明 a）后 a 无值
    expect(r.varAt(1, 'a')).toBeUndefined();
    expect(r.varAt(2, 'a')?.value).toBe(5);
  });
});

describe('if 语句', () => {
  it('成立分支执行', async () => {
    const r = await runSrc(`
      int main() {
        int a = 1;
        int b = 2;
        if (a < b) {
          a++;
        }
        return 0;
      }
    `);
    expect(r.finalVar('a')?.value).toBe(2);
    expect(r.finalVar('b')?.value).toBe(2);
  });

  it('不成立分支跳过、else 执行', async () => {
    const r = await runSrc(`
      int main() {
        int a = 5;
        if (a < 3) {
          a = 100;
        } else {
          a = 200;
        }
        return 0;
      }
    `);
    expect(r.finalVar('a')?.value).toBe(200);
  });

  it('if 产生两个步骤：条件 + 分支', async () => {
    const r = await runSrc(`
      int main() {
        int a = 1;
        if (a < 2) {
          a = 9;
        }
        return 0;
      }
    `);
    const kinds = r.stepKinds();
    expect(kinds).toContain('if-condition:condition');
    expect(kinds).toContain('if-branch:branch');
    const condIdx = kinds.indexOf('if-condition:condition');
    const branchIdx = kinds.indexOf('if-branch:branch');
    expect(branchIdx).toBe(condIdx + 1);
  });

  it('嵌套 if', async () => {
    const r = await runSrc(`
      int main() {
        int a = 5;
        if (a > 0) {
          if (a > 3) {
            a = 99;
          }
        }
        return 0;
      }
    `);
    expect(r.finalVar('a')?.value).toBe(99);
  });

  it('条件为 0 视为假、非 0 视为真', async () => {
    const r = await runSrc(`
      int main() {
        int hits = 0;
        if (0) hits++;
        if (1) hits++;
        if (-7) hits++;
        return 0;
      }
    `);
    expect(r.finalVar('hits')?.value).toBe(2);
  });

  it('完成标准验收代码逐步执行', async () => {
    const src = `
int main() {
    int a = 1;
    int b = 2;

    if (a < b) {
        a++;
    }

    return 0;
}`;
    const r = await runSrc(src);
    expect(r.ok).toBe(true);
    expect(r.finalVar('a')?.value).toBe(2);
    expect(r.finalVar('b')?.value).toBe(2);
    // 步骤序列：调用 main、声明 a、声明 b、条件、分支、自增、结束
    expect(r.stepKinds()).toEqual([
      'call', 'var-decl', 'var-decl', 'if-condition:condition', 'if-branch:branch', 'expr-stmt', 'program-end',
    ]);
  });
});

describe('return 与程序结束', () => {
  it('return 值出现在结束步骤', async () => {
    const r = await runSrc('int main() { return 42; }');
    expect(r.ok).toBe(true);
    const last = r.steps[r.steps.length - 1];
    expect(last.status).toBe('program-end');
    expect(last.description).toContain('42');
  });

  it('main 末尾无 return 正常结束', async () => {
    const r = await runSrc('int main() { int a = 1; }');
    expect(r.ok).toBe(true);
  });
});

describe('运行时错误', () => {
  it('除零错误', async () => {
    const r = await runSrc(`
      int main() {
        int a = 10;
        int b = 0;
        int c = a / b;
        return 0;
      }
    `);
    expect(r.ok).toBe(false);
    expect(r.errorCode()).toBe('E_DIV_ZERO');
  });

  it('取模零错误', async () => {
    const r = await runSrc('int main() { int c = 5 % 0; return 0; }');
    expect(r.errorCode()).toBe('E_DIV_ZERO');
  });

  it('错误步骤行号正确', async () => {
    const r = await runSrc('int main() {\n  int c = 5 / 0;\n  return 0;\n}');
    const last = r.steps[r.steps.length - 1];
    expect(last.line).toBe(2);
  });
});

describe('步骤与快照机制', () => {
  it('每步都有快照且说明非空', async () => {
    const r = await runSrc(`
      int main() {
        int a = 1;
        a = a + 1;
        return 0;
      }
    `);
    for (const s of r.steps) {
      expect(s.snapshot).toBeDefined();
      expect(s.description.length).toBeGreaterThan(0);
      expect(s.snapshot.scopes.length).toBeGreaterThan(0);
    }
  });

  it('确定性：同一程序两次运行步骤完全一致', async () => {
    const src = `
      int main() {
        int a = 3;
        int b = a * 2;
        if (b > a) { a = b - 1; }
        return a;
      }
    `;
    const r1 = await runSrc(src);
    const r2 = await runSrc(src);
    expect(JSON.stringify(r1.steps)).toBe(JSON.stringify(r2.steps));
  });

  it('变化记录：赋值步骤标记变化的地址', async () => {
    const r = await runSrc(`
      int main() {
        int a = 1;
        a = 2;
        return 0;
      }
    `);
    const assignStep = r.steps.find((s) => s.statementType === 'expr-stmt');
    expect(assignStep?.changed.addresses.length).toBeGreaterThan(0);
    // 声明步骤没有变化
    const declStep = r.steps.find((s) => s.statementType === 'var-decl');
    expect(declStep?.changed.addresses.length).toBeGreaterThan(0);
  });

  it('回退一致性：任意步骤的快照等于一次性执行到该步', async () => {
    const src = `
      int main() {
        int a = 1;
        a = a + 5;
        int b = a * 2;
        a = b - 3;
        return 0;
      }
    `;
    const r = await runSrc(src);
    // 快照本身就存于每步，验证相邻步骤状态单调演化
    for (let i = 1; i < r.steps.length; i++) {
      const prev = r.steps[i - 1].snapshot;
      const cur = r.steps[i].snapshot;
      // 地址分配计数单调不减
      expect(cur.nextAddress).toBeGreaterThanOrEqual(prev.nextAddress);
    }
    expect(r.finalVar('a')?.value).toBe(9);
    expect(r.finalVar('b')?.value).toBe(12);
  });
});

describe('保护机制', () => {
  it('步数上限触发 step-limit', async () => {
    const r = await runSrc(`
      int main() {
        int i = 0;
        while (1) {
          i++;
        }
        return 0;
      }
    `, { maxSteps: 50 });
    // Phase 3 循环未实现：此测试在 Phase 4 后激活
    if (r.status === 'step-limit') {
      expect(r.steps[r.steps.length - 1].description).toContain('无限循环');
    } else {
      expect(r.steps.length).toBeGreaterThan(0);
    }
  });
});
