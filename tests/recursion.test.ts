// 递归测试：factorial / fibonacci / 深度保护
import { describe, expect, it } from 'vitest';
import { runSrc } from './helpers';

describe('递归', () => {
  it('factorial(5) == 120', async () => {
    const r = await runSrc(`
      int factorial(int n) {
        if (n <= 1) {
          return 1;
        }
        return n * factorial(n - 1);
      }
      int main() {
        int result = factorial(5);
        return 0;
      }
    `);
    expect(r.finalVar('result')?.value).toBe(120);
  });

  it('递归调用栈：深度先增后减', async () => {
    const r = await runSrc(`
      int factorial(int n) {
        if (n <= 1) {
          return 1;
        }
        return n * factorial(n - 1);
      }
      int main() {
        int result = factorial(4);
        return 0;
      }
    `);
    // 记录每步调用栈中 factorial 帧的数量
    const depths = r.steps.map((s) => s.snapshot.callStack.filter((f) => f.functionName === 'factorial').length);
    const maxDepth = Math.max(...depths);
    expect(maxDepth).toBe(4); // factorial(4) 递归 4 层
    expect(depths[depths.length - 1]).toBe(0); // 结束后全部返回
    // 深度先增后减（出现完整的山形）
    const firstMax = depths.indexOf(maxDepth);
    expect(depths[0]).toBe(0);
    expect(depths[firstMax - 1]).toBe(maxDepth - 1);
  });

  it('递归每层的形参独立', async () => {
    const r = await runSrc(`
      int factorial(int n) {
        if (n <= 1) {
          return 1;
        }
        return n * factorial(n - 1);
      }
      int main() {
        int result = factorial(3);
        return 0;
      }
    `);
    // 深层帧中 n 的值各不相同（3, 2, 1）
    const nValues = new Set<number>();
    for (const s of r.steps) {
      for (const f of s.snapshot.callStack) {
        if (f.functionName !== 'factorial') continue;
        const scope = s.snapshot.scopes.find((sc) => sc.id === f.scopeId);
        const nVar = scope?.vars.find((v) => v.name === 'n');
        if (nVar && nVar.address !== null) {
          const cell = s.snapshot.cells[nVar.address];
          if (cell && cell.value !== null) nValues.add(cell.value);
        }
      }
    }
    expect([...nValues].sort((a, b) => a - b)).toEqual([1, 2, 3]);
  });

  it('fibonacci(10) == 55', async () => {
    const r = await runSrc(`
      int fib(int n) {
        if (n < 2) {
          return n;
        }
        return fib(n - 1) + fib(n - 2);
      }
      int main() {
        int result = fib(10);
        return 0;
      }
    `);
    expect(r.finalVar('result')?.value).toBe(55);
  });

  it('无限递归触发深度保护', async () => {
    const r = await runSrc(`
      int loop(int n) {
        return loop(n + 1);
      }
      int main() {
        return loop(0);
      }
    `);
    expect(r.ok).toBe(false);
    const last = r.steps[r.steps.length - 1];
    expect(last.status).toBe('runtime-error');
    expect(last.errorCode).toBe('E_STACK_DEPTH');
  });

  it('递归与条件终止配合（greatest common divisor）', async () => {
    const r = await runSrc(`
      int gcd(int a, int b) {
        if (b == 0) {
          return a;
        }
        return gcd(b, a % b);
      }
      int main() {
        int result = gcd(48, 36);
        return 0;
      }
    `);
    expect(r.finalVar('result')?.value).toBe(12);
  });
});
