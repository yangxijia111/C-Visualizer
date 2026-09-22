// 副作用求值顺序静态检测（SEMANTIC_MODEL §6.2 判定表逐行验证）
import { describe, expect, it } from 'vitest';
import { compileOk, compileErr, runSrc } from '../helpers';

/** 便捷：包裹为 main 内语句并期望 E_UB（含变量名） */
async function expectUB(stmt: string, name: string) {
  const errors = await compileErr(`int main() {\n  int i = 0;\n  int x = 1;\n  int a[5] = {0, 1, 2, 3, 4};\n  ${stmt}\n  return 0;\n}`);
  expect(errors.some((e) => e.code === 'E_UB' && e.message.includes(name))).toBe(true);
}

async function expectOK(stmt: string) {
  await compileOk(`int main() {\n  int i = 0;\n  int x = 1;\n  int a[5] = {0, 1, 2, 3, 4};\n  ${stmt}\n  return 0;\n}`);
}

describe('最小 UB 检测范围（任务书二十四）', () => {
  it('i++ + i++ → E_UB（双写）', async () => {
    await expectUB('int y = i++ + i++;', 'i');
  });
  it('i = i++ → E_UB（双写）', async () => {
    await expectUB('i = i++;', 'i');
  });
  it('i++ + i → E_UB（读写竞争）', async () => {
    await expectUB('int y = i++ + i;', 'i');
  });
  it('i + i++ → E_UB（读写竞争）', async () => {
    await expectUB('int y = i + i++;', 'i');
  });
  it('f(i++, i++) → E_UB（双写）', async () => {
    const errors = await compileErr(`
      int f(int p, int q) { return p + q; }
      int main() {
          int i = 0;
          int y = f(i++, i++);
          return 0;
      }
    `);
    expect(errors.some((e) => e.code === 'E_UB' && e.message.includes('i'))).toBe(true);
  });
  it('f(i++, i) → E_UB（保守：实参顺序 unspecified）', async () => {
    const errors = await compileErr(`
      int f(int p, int q) { return p + q; }
      int main() {
          int i = 0;
          int y = f(i++, i);
          return 0;
      }
    `);
    expect(errors.some((e) => e.code === 'E_UB' && e.message.includes('i'))).toBe(true);
  });
  it('a[i] = i++ → E_UB（下标读与右值写竞争）', async () => {
    await expectUB('a[i] = i++;', 'i');
  });
  it('a[i++] = i → E_UB', async () => {
    await expectUB('a[i++] = i;', 'i');
  });
  it('printf("%d %d", i, i++) → E_UB（printf 参数间同样无序列点）', async () => {
    const errors = await compileErr(`
      int main() {
          int i = 0;
          printf("%d %d", i, i++);
          return 0;
      }
    `);
    expect(errors.some((e) => e.code === 'E_UB' && e.message.includes('i'))).toBe(true);
  });
});

describe('合法表达式不误杀', () => {
  it('a[i++] = 1 → 合法（单一副作用）', async () => {
    await expectOK('a[i++] = 1;');
  });
  it('x = x + 1 → 合法（赋值豁免）', async () => {
    await expectOK('x = x + 1;');
  });
  it('x += x → 合法（复合赋值豁免）', async () => {
    await expectOK('x += x;');
  });
  it('a[i] = a[i] + 1 → 合法（数组元素自身豁免）', async () => {
    await expectOK('a[i] = a[i] + 1;');
  });
  it('i++ && i++ → 合法（&& 序列点分区）', async () => {
    await expectOK('int y = i++ && i++;');
  });
  it('i++ || i → 合法（|| 序列点分区）', async () => {
    await expectOK('int y = i++ || i;');
  });
  it('不同变量互不冲突：i++ + x → 合法', async () => {
    await expectOK('int y = i++ + x;');
  });
  it('独立语句间的副作用有序（完整表达式边界）', async () => {
    await expectOK('i++; int y = i + 1;');
  });
  it('x = x++ 的近亲 x = (x = 2) 仍拒绝（双写不豁免）', async () => {
    await expectUB('x = (x = 2);', 'x');
  });
  it('x++ 单独作为语句 → 合法', async () => {
    await expectOK('i++;');
  });
  it('f(i, i) 无副作用 → 合法', async () => {
    await compileOk(`
      int f(int p, int q) { return p + q; }
      int main() {
          int i = 3;
          int y = f(i, i);
          return y;
      }
    `);
  });
});

describe('UB 代码不再产生确定结果（编译期拒绝）', () => {
  it('i++ + i++ 在编译期被拒绝而非给出确定值', async () => {
    const errors = await compileErr(`
      int main() {
          int i = 0;
          int x = i++ + i++;
          printf("%d", x);
          return 0;
      }
    `);
    expect(errors.some((e) => e.code === 'E_UB')).toBe(true);
    expect(errors[0].hint).toContain('未定义行为');
  });

  it('普通教学代码（for 循环 i++）不受影响', async () => {
    const r = await runSrc(`
      int main() {
          int sum = 0;
          for (int i = 0; i < 5; i++) {
              sum = sum + i;
          }
          printf("%d", sum);
          return 0;
      }
    `);
    expect(r.ok).toBe(true);
    expect(r.output).toBe('10');
  });

  it('复合赋值与自减组合的合法用例', async () => {
    const r = await runSrc(`
      int main() {
          int i = 10;
          i -= 2;
          i /= 2;
          printf("%d", i);
          return 0;
      }
    `);
    expect(r.ok).toBe(true);
    expect(r.output).toBe('4');
  });
});

describe('检测入口覆盖全部完整表达式位置', () => {
  it('条件中：while (i++ < 3 && i++ < 4) 合法（序列点），while (i++ + i < 5) 拒绝', async () => {
    await compileOk(`
      int main() {
          int i = 0;
          while (i++ < 3 && i < 4) { }
          return 0;
      }
    `);
    const errors = await compileErr(`
      int main() {
          int i = 0;
          while (i++ + i < 5) { }
          return 0;
      }
    `);
    expect(errors.some((e) => e.code === 'E_UB')).toBe(true);
  });
  it('return 值中检测', async () => {
    const errors = await compileErr(`
      int f(int p) { return p; }
      int main() {
          int i = 0;
          int y = f(i++ + i);
          return 0;
      }
    `);
    expect(errors.some((e) => e.code === 'E_UB')).toBe(true);
  });
  it('switch 判别式中检测', async () => {
    const errors = await compileErr(`
      int main() {
          int i = 0;
          switch (i++ + i) {
              case 1:
                  break;
          }
          return 0;
      }
    `);
    expect(errors.some((e) => e.code === 'E_UB')).toBe(true);
  });
  it('for update 中检测', async () => {
    const errors = await compileErr(`
      int main() {
          int i = 0;
          int j = 0;
          for (int k = 0; k < 3; j = i++ + i) {
              i++;
          }
          return 0;
      }
    `);
    expect(errors.some((e) => e.code === 'E_UB')).toBe(true);
  });
  it('数组初始化列表中检测', async () => {
    const errors = await compileErr(`
      int main() {
          int i = 0;
          int a[3] = {1, i++, i};
          return 0;
      }
    `);
    expect(errors.some((e) => e.code === 'E_UB')).toBe(true);
  });
  it('指针场景：*p = *p + 1 合法', async () => {
    await compileOk(`
      int main() {
          int x = 5;
          int *p = &x;
          *p = *p + 1;
          return 0;
      }
    `);
  });
});
