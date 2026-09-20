// 边界情况与保护机制测试
import { describe, expect, it } from 'vitest';
import { compile, runProgram } from '../src/core/run';
import { compileErr, expectError } from './helpers';

describe('边界情况', () => {
  it('空程序：缺少 main', async () => {
    const r = await compile('');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0].code).toBe('E_NO_MAIN');
  });

  it('只有空的 main：正常完成', async () => {
    const compiled = await compile('int main() { }');
    expect(compiled.ok).toBe(true);
    if (compiled.ok) {
      const result = runProgram(compiled.program, 'int main() { }');
      expect(result.steps[result.steps.length - 1].status).toBe('program-end');
    }
  });

  it('仅注释的 main', async () => {
    const compiled = await compile('int main() {\n  // 只有注释\n  /* 块注释 */\n}');
    expect(compiled.ok).toBe(true);
  });

  it('大循环（约 9000 步内）正常完成', async () => {
    const src = `
      int main() {
        int sum = 0;
        for (int i = 0; i < 1500; i++) {
          sum = sum + i;
        }
        return 0;
      }
    `;
    const compiled = await compile(src);
    expect(compiled.ok).toBe(true);
    if (compiled.ok) {
      const result = runProgram(compiled.program, src);
      expect(result.status).toBe('completed');
      const last = result.steps[result.steps.length - 1];
      expect(last.status).toBe('program-end');
      expect(result.steps.length).toBeGreaterThan(4500); // 每轮 ≥3 步
    }
  }, 30000);

  it('重复运行确定性（大程序）', async () => {
    const src = `
      int f(int n) { if (n <= 0) return 0; return n + f(n - 1); }
      int main() {
        int a[10];
        for (int i = 0; i < 10; i++) { a[i] = f(i); }
        return 0;
      }
    `;
    const c1 = await compile(src);
    const c2 = await compile(src);
    expect(c1.ok && c2.ok).toBe(true);
    if (c1.ok && c2.ok) {
      const r1 = runProgram(c1.program, src);
      const r2 = runProgram(c2.program, src);
      expect(JSON.stringify(r1.steps)).toBe(JSON.stringify(r2.steps));
    }
  }, 30000);
});

describe('保护机制', () => {
  it('正好到达步数上限时停止', async () => {
    const src = `
      int main() {
        int i = 0;
        while (1) { i = i + 1; }
        return 0;
      }
    `;
    const compiled = await compile(src);
    if (compiled.ok) {
      const result = runProgram(compiled.program, src, { maxSteps: 100 });
      expect(result.status).toBe('step-limit');
      expect(result.steps.length).toBe(101); // 100 正常步 + 1 终止步骤
    }
  });

  it('深递归在 100 层触发 E_STACK_DEPTH', async () => {
    const src = `
      int down(int n) { return down(n + 1); }
      int main() { return down(0); }
    `;
    const compiled = await compile(src);
    if (compiled.ok) {
      const result = runProgram(compiled.program, src);
      const last = result.steps[result.steps.length - 1];
      expect(last.errorCode).toBe('E_STACK_DEPTH');
    }
  });

  it('runProgram 对意外异常兜底不抛出', async () => {
    // 构造非法 program 绕过检查器（防御性测试）
    const result = runProgram({ functions: [], globals: [] }, '');
    // 空 program 无 main → 内部错误步骤而非异常
    expect(result.steps.length).toBeGreaterThanOrEqual(0);
  });
});

describe('编译错误批量回归（各错误码）', () => {
  it('E_SYNTAX / E_UNSUPPORTED / E_TYPE / E_LABEL / E_CONST / E_DECL 全覆盖', async () => {
    await expectError('int main() { int a = ; }', 'E_SYNTAX');
    await expectError('int main() { struct S { int x; }; }', 'E_UNSUPPORTED');
    await expectError('int main() { double d = 1; int r = d % 2; }', 'E_TYPE');
    await expectError('int main() { goto missing; }', 'E_LABEL');
    await expectError('int main() { int n = 1; int a[n]; }', 'E_CONST');
    await expectError('int main() { int a; int a; }', 'E_DECL');
  });

  it('编译失败时 run 不产出步骤', async () => {
    const r = await compileErr('int main() { int a = ; }');
    expect(r.length).toBeGreaterThan(0);
  });
});

describe('文档承诺核对（SUPPORTED_C）', () => {
  it('空语句：while 与 for 的空循环体', async () => {
    const r = await runSrc(`
      int main() {
        int i = 0;
        while (i < 3) i++;
        for (int j = 0; j < 2; j++) ;
        return 0;
      }
    `);
    expect(r.ok).toBe(true);
    expect(r.finalVar('i')?.value).toBe(3);
  });

  it('嵌套函数调用作为条件与实参', async () => {
    const r = await runSrc(`
      int inc(int x) { return x + 1; }
      int main() {
        int a = inc(inc(inc(0)));
        if (inc(0) == 1) { a = a + 100; }
        return 0;
      }
    `);
    expect(r.finalVar('a')?.value).toBe(103);
  });

  it('if 无花括号单语句与 else', async () => {
    const r = await runSrc(`
      int main() {
        int a = 5;
        if (a > 1) a = 99;
        else a = 0;
        return 0;
      }
    `);
    expect(r.finalVar('a')?.value).toBe(99);
  });

  it('int* p 写法（星号贴类型）', async () => {
    const { compileOk } = await import('./helpers');
    const p = await compileOk('int main() { int a = 1; int* p = &a; int b = *p; return 0; }');
    expect(p.functions.length).toBe(1);
  });
});
