// 初始化语义：存储期策略矩阵（SEMANTIC_MODEL §5）
// 全局（静态存储期）= 零初始化；局部（自动存储期）= 未初始化；
// 带初始化列表的数组 = 前缀收敛写入 + 剩余零初始化
import { describe, expect, it } from 'vitest';
import { runSrc } from '../helpers';

describe('全局变量：静态存储期零初始化', () => {
  it('int g; → 0', async () => {
    const r = await runSrc(`
      int g;
      int main() {
          int x = g;
          return 0;
      }
    `);
    expect(r.ok).toBe(true);
    expect(r.finalVar('x')?.value).toBe(0);
  });

  it('double g; → 0.0', async () => {
    const r = await runSrc(`
      double g;
      int main() {
          double d = g + 1.5;
          return 0;
      }
    `);
    expect(r.ok).toBe(true);
    expect(r.finalVar('d')?.value).toBe(1.5);
  });

  it('int a[5]; → 全部元素为 0', async () => {
    const r = await runSrc(`
      int a[5];
      int main() {
          int s = 0;
          for (int i = 0; i < 5; i++) s = s + a[i];
          return 0;
      }
    `);
    expect(r.ok).toBe(true);
    expect(r.finalVar('s')?.value).toBe(0);
  });

  it('char c[3]; → 全部为 0（NUL）', async () => {
    const r = await runSrc(`
      char c[3];
      int main() {
          int s = c[0] + c[1] + c[2];
          return 0;
      }
    `);
    expect(r.finalVar('s')?.value).toBe(0);
  });

  it('全局指针默认 NULL（0）', async () => {
    const r = await runSrc(`
      int *p;
      int x = 5;
      int main() {
          p = &x;
          return 0;
      }
    `);
    // 第一步是 p 的全局声明：其单元值应为 0（NULL），而非未初始化
    const snap = r.steps[0].snapshot;
    const g = snap.scopes.find((s) => s.kind === 'global')?.vars.find((v) => v.name === 'p');
    expect(g).toBeDefined();
    expect(snap.cells[g?.address ?? -1]?.value).toBe(0);
  });

  it('全局标量带初始化式正常求值', async () => {
    const r = await runSrc(`
      int g = 2 + 3;
      int main() { return 0; }
    `);
    expect(r.ok).toBe(true);
  });
});

describe('局部标量：自动存储期未初始化', () => {
  it('int x; 读取 → E_UNINIT_READ（保持教学策略）', async () => {
    const r = await runSrc(`
      int main() {
          int x;
          int y = x;
          return 0;
      }
    `);
    expect(r.errorCode()).toBe('E_UNINIT_READ');
  });

  it('double d; 读取 → E_UNINIT_READ', async () => {
    const r = await runSrc(`
      int main() {
          double d;
          double e = d + 1;
          return 0;
      }
    `);
    expect(r.errorCode()).toBe('E_UNINIT_READ');
  });

  it('声明后未读取不报错', async () => {
    const r = await runSrc(`
      int main() {
          int x;
          x = 3;
          int y = x;
          return 0;
      }
    `);
    expect(r.ok).toBe(true);
    expect(r.finalVar('y')?.value).toBe(3);
  });
});

describe('局部数组：自动存储期未初始化（行为修正）', () => {
  it('int a[5]; 元素保持未初始化：读 a[0] → E_UNINIT_READ', async () => {
    const r = await runSrc(`
      int main() {
          int a[5];
          int x = a[0];
          return 0;
      }
    `);
    expect(r.errorCode()).toBe('E_UNINIT_READ');
  });

  it('读取任一未初始化元素都报错（a[3]）', async () => {
    const r = await runSrc(`
      int main() {
          int a[5];
          int x = a[3];
          return 0;
      }
    `);
    expect(r.errorCode()).toBe('E_UNINIT_READ');
  });

  it('局部数组声明后逐元素赋值可正常使用', async () => {
    const r = await runSrc(`
      int main() {
          int a[3];
          a[0] = 10;
          a[1] = 20;
          a[2] = a[0] + a[1];
          return 0;
      }
    `);
    expect(r.ok).toBe(true);
    const snap = r.steps[r.steps.length - 1].snapshot;
    const a = snap.scopes.flatMap((s) => s.vars).find((v) => v.name === 'a')!;
    expect(snap.cells[a.address! + 2].value).toBe(30);
  });

  it('数组元素未初始化不阻碍其他元素赋值（元素级未初始化）', async () => {
    const r = await runSrc(`
      int main() {
          int a[4];
          a[2] = 9;
          int x = a[2];
          return 0;
      }
    `);
    expect(r.ok).toBe(true);
    expect(r.finalVar('x')?.value).toBe(9);
  });
});

describe('带初始化列表的数组：前缀 + 剩余零初始化', () => {
  it('int a[5] = {1, 2}; → {1,2,0,0,0}（局部）', async () => {
    const r = await runSrc(`
      int main() {
          int a[5] = {1, 2};
          return 0;
      }
    `);
    const snap = r.steps[r.steps.length - 1].snapshot;
    const a = snap.scopes.flatMap((s) => s.vars).find((v) => v.name === 'a')!;
    expect([...Array(5)].map((_, i) => snap.cells[a.address! + i].value)).toEqual([1, 2, 0, 0, 0]);
  });

  it('int a[5] = {}; → 全 0（空列表也是初始化列表）', async () => {
    const r = await runSrc(`
      int main() {
          int a[5] = {};
          int s = 0;
          for (int i = 0; i < 5; i++) s = s + a[i];
          return 0;
      }
    `);
    expect(r.ok).toBe(true);
    expect(r.finalVar('s')?.value).toBe(0);
  });

  it('全局数组部分初始化：ga[4] = {1,2} → {1,2,0,0}', async () => {
    const r = await runSrc(`
      int ga[4] = {1, 2};
      int main() {
          int s = ga[0] + ga[1] + ga[2] + ga[3];
          return 0;
      }
    `);
    expect(r.ok).toBe(true);
    expect(r.finalVar('s')?.value).toBe(3);
  });

  it('初始化列表元素收敛到元素类型（double → int）', async () => {
    const r = await runSrc(`
      int main() {
          int a[2] = {1.9, 2.9};
          return 0;
      }
    `);
    const snap = r.steps[r.steps.length - 1].snapshot;
    const a = snap.scopes.flatMap((s) => s.vars).find((v) => v.name === 'a')!;
    expect(snap.cells[a.address!].value).toBe(1);
    expect(snap.cells[a.address! + 1].value).toBe(2);
  });

  it('float 数组部分初始化剩余为 0.0', async () => {
    const r = await runSrc(`
      int main() {
          double d[3] = {1.5};
          double s = d[0] + d[1] + d[2];
          return 0;
      }
    `);
    expect(r.ok).toBe(true);
    expect(r.finalVar('s')?.value).toBe(1.5);
  });
});

describe('初始化路径集中：声明步骤如实展示', () => {
  it('局部数组无初始化的声明描述不再声称全 0', async () => {
    const r = await runSrc(`
      int main() {
          int a[5];
          return 0;
      }
    `);
    const declStep = r.steps.find((s) => s.statementType === 'var-decl');
    expect(declStep?.description).toContain('未初始化');
    expect(declStep?.description).not.toContain('所有元素初始化为 0');
  });

  it('全局数组无初始化的声明描述为零初始化', async () => {
    const r = await runSrc(`
      int ga[3];
      int main() { return 0; }
    `);
    const declStep = r.steps.find((s) => s.statementType === 'var-decl');
    expect(declStep?.description).toContain('0');
  });

  it('带初始化列表的声明描述保持「初始化」', async () => {
    const r = await runSrc(`
      int main() {
          int a[3] = {1, 2};
          return 0;
      }
    `);
    const declStep = r.steps.find((s) => s.statementType === 'var-decl');
    expect(declStep?.description).toContain('初始化');
  });
});
