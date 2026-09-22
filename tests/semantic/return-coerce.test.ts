// 函数返回与参数的运行时收敛 + Return Checker 类型校验（SEMANTIC_MODEL §3）
import { describe, expect, it } from 'vitest';
import { compileOk, compileErr, runSrc } from '../helpers';
import { coerceRuntimeValue } from '../../src/core/coercion';
import { intValue, floatValue, charValue } from '../../src/core/values';

describe('coerceRuntimeValue 统一收敛规则', () => {
  it('double → int 截断', () => {
    expect(coerceRuntimeValue(floatValue(1.9), 'int')).toEqual(intValue(1));
    expect(coerceRuntimeValue(floatValue(-1.9), 'int')).toEqual(intValue(-1));
    expect(coerceRuntimeValue(floatValue(1.5), 'int')).toEqual(intValue(1));
  });
  it('int → char 取低 8 位', () => {
    expect(coerceRuntimeValue(intValue(300), 'char')).toEqual(charValue(44));
    expect(coerceRuntimeValue(intValue(65), 'char')).toEqual(charValue(65));
    expect(coerceRuntimeValue(floatValue(321.7), 'char')).toEqual(charValue(65));
  });
  it('int → double 保持数值且类型为 double', () => {
    const r = coerceRuntimeValue(intValue(3), 'double');
    expect(r.type).toBe('double');
    expect(r.value).toBe(3);
  });
  it('char → int 符号值即整数', () => {
    expect(coerceRuntimeValue(charValue(65), 'int')).toEqual(intValue(65));
  });
  it('int → float 与 float → float 保持数值', () => {
    expect(coerceRuntimeValue(intValue(2), 'float')?.type).toBe('float');
    expect(coerceRuntimeValue(floatValue(2.5), 'float')?.value).toBe(2.5);
  });
});

describe('Return Checker：return 表达式类型与返回类型兼容', () => {
  it('int f() { return 1.5; } 允许（隐式 double → int）', async () => {
    await compileOk(`
      int f() { return 1.5; }
      int main() { return 0; }
    `);
  });
  it('double f() { return 1; } 允许（int → double）', async () => {
    await compileOk(`
      double f() { return 1; }
      int main() { return 0; }
    `);
  });
  it('char f() { return 300; } 允许（int → char 截断在运行时）', async () => {
    await compileOk(`
      char f() { return 300; }
      int main() { return 0; }
    `);
  });
  it('void f() { return 1; } 报错', async () => {
    const errors = await compileErr(`
      void f() { return 1; }
      int main() { return 0; }
    `);
    expect(errors.some((e) => e.code === 'E_TYPE' && e.message.includes('void'))).toBe(true);
  });
  it('int f() { return; } 报错', async () => {
    const errors = await compileErr(`
      int f() { return; }
      int main() { return 0; }
    `);
    expect(errors.some((e) => e.code === 'E_TYPE' && e.message.includes('return'))).toBe(true);
  });
  it('int f() { return 数组; } 报错', async () => {
    const errors = await compileErr(`
      int f() {
          int a[3] = {1, 2, 3};
          return a;
      }
      int main() { return 0; }
    `);
    expect(errors.some((e) => e.code === 'E_TYPE')).toBe(true);
  });
});

describe('运行时 return 强制收敛到函数返回类型', () => {
  it('int f() { return 1.9; } → 调用方得到 int 1', async () => {
    const r = await runSrc(`
      int f() { return 1.9; }
      int main() {
          int x = f();
          return 0;
      }
    `);
    expect(r.ok).toBe(true);
    expect(r.finalVar('x')?.value).toBe(1);
    expect(r.finalVar('x')?.type).toBe('int');
  });

  it('char f() { return 300; } → 300 & 0xff = 44', async () => {
    const r = await runSrc(`
      char f() { return 300; }
      int main() {
          int x = f();
          return 0;
      }
    `);
    expect(r.ok).toBe(true);
    expect(r.finalVar('x')?.value).toBe(44);
  });

  it('double f() { return 3; } → 运行时类型为 double', async () => {
    const r = await runSrc(`
      double f() { return 3; }
      int main() {
          double d = f();
          return 0;
      }
    `);
    expect(r.ok).toBe(true);
    expect(r.finalVar('d')?.type).toBe('double');
    expect(r.finalVar('d')?.value).toBe(3);
  });

  it('return 表达式参与运算时以转换后的类型参与（int f()+1.5 → 2.5）', async () => {
    const r = await runSrc(`
      int f() { return 1; }
      int main() {
          double d = f() + 1.5;
          return 0;
      }
    `);
    expect(r.finalVar('d')?.value).toBe(2.5);
  });

  it('int f() { return 1.5; } 直接用于算术（不再以 1.5 参与）', async () => {
    const r = await runSrc(`
      int f() { return 1.5; }
      int main() {
          int y = f() * 2;
          return 0;
      }
    `);
    expect(r.finalVar('y')?.value).toBe(2);
  });

  it('递归函数返回值同样收敛', async () => {
    const r = await runSrc(`
      double half(int n) {
          if (n <= 0) return 0;
          return half(n - 1) + 0.5;
      }
      int main() {
          double d = half(4);
          return 0;
      }
    `);
    expect(r.finalVar('d')?.value).toBe(2);
  });
});

describe('参数传递收敛到形参类型', () => {
  it('void f(int x) 调 f(1.9) → 形参 x 为 int 1', async () => {
    const r = await runSrc(`
      int f(int x) {
          return x * 2;
      }
      int main() {
          int y = f(1.9);
          return 0;
      }
    `);
    expect(r.ok).toBe(true);
    expect(r.finalVar('y')?.value).toBe(2);
  });

  it('char 形参收敛：f(char c) 调 f(300) → 44', async () => {
    const r = await runSrc(`
      int f(char c) {
          return c;
      }
      int main() {
          int y = f(300);
          return 0;
      }
    `);
    expect(r.finalVar('y')?.value).toBe(44);
  });

  it('double 形参收敛：f(double d) 调 f(3) → d 为 double 3', async () => {
    const r = await runSrc(`
      double d2;
      void f(double d) {
          d2 = d + 0.5;
      }
      int main() {
          f(3);
          return 0;
      }
    `);
    expect(r.finalVar('d2')?.type).toBe('double');
    expect(r.finalVar('d2')?.value).toBe(3.5);
  });

  it('调用步骤描述中的形参显示转换后的值', async () => {
    const r = await runSrc(`
      int f(int x) { return x; }
      int main() {
          int y = f(1.9);
          return 0;
      }
    `);
    const callStep = r.steps.find((s) => s.statementType === 'call' && s.description.includes('f('));
    expect(callStep?.description).toContain('x = 1');
  });
});

describe('数组初始化列表元素收敛', () => {
  it('int a[2] = {1.9, 3.7} → {1, 3}', async () => {
    const r = await runSrc(`
      int main() {
          int a[2] = {1.9, 3.7};
          return 0;
      }
    `);
    const snap = r.steps[r.steps.length - 1].snapshot;
    const a = snap.scopes.flatMap((s) => s.vars).find((v) => v.name === 'a')!;
    expect(snap.cells[a.address!].value).toBe(1);
    expect(snap.cells[a.address! + 1].value).toBe(3);
  });

  it('char 数组初始化收敛到 0-255', async () => {
    const r = await runSrc(`
      int main() {
          char c[2] = {300, 65};
          return 0;
      }
    `);
    const snap = r.steps[r.steps.length - 1].snapshot;
    const c = snap.scopes.flatMap((s) => s.vars).find((v) => v.name === 'c')!;
    expect(snap.cells[c.address!].value).toBe(44);
    expect(snap.cells[c.address! + 1].value).toBe(65);
  });

  it('double 数组初始化列表接收 int 值', async () => {
    const r = await runSrc(`
      int main() {
          double d[2] = {1, 2};
          return 0;
      }
    `);
    const snap = r.steps[r.steps.length - 1].snapshot;
    const d = snap.scopes.flatMap((s) => s.vars).find((v) => v.name === 'd')!;
    expect(snap.cells[d.address!].value).toBe(1);
    expect(snap.cells[d.address!].type).toBe('double');
  });
});
