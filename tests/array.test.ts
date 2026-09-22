// 数组测试：声明 / 初始化 / 读写 / 遍历 / 越界 / 与循环配合
import { describe, expect, it } from 'vitest';
import { runSrc } from './helpers';

describe('数组声明与初始化', () => {
  it('局部无初始化数组保持未初始化（v1.1.0 行为修正）', async () => {
    const r = await runSrc(`
      int main() {
        int a[5];
        return 0;
      }
    `);
    const snap = r.steps[r.steps.length - 1].snapshot;
    const arrVar = snap.scopes.flatMap((s) => s.vars).find((v) => v.name === 'a');
    expect(arrVar?.length).toBe(5);
    // 自动存储期：元素未初始化，读取报 E_UNINIT_READ（全局数组才是全 0，见 semantic/initialization）
    const r2 = await runSrc(`
      int main() {
        int a[5];
        int x = a[3];
        return 0;
      }
    `);
    expect(r2.errorCode()).toBe('E_UNINIT_READ');
  });

  it('初始化列表 {1,2,3}：剩余补 0', async () => {
    const r = await runSrc(`
      int main() {
        int a[5] = {1, 2, 3};
        return 0;
      }
    `);
    const snap = r.steps[r.steps.length - 1].snapshot;
    const arrVar = snap.scopes.flatMap((s) => s.vars).find((v) => v.name === 'a')!;
    expect([...Array(5)].map((_, i) => snap.cells[arrVar.address! + i].value)).toEqual([1, 2, 3, 0, 0]);
  });

  it('完整初始化与 {} 全零', async () => {
    const r = await runSrc(`
      int main() {
        int a[3] = {7, 8, 9};
        int b[3] = {};
        return 0;
      }
    `);
    const snap = r.steps[r.steps.length - 1].snapshot;
    const vars = snap.scopes.flatMap((s) => s.vars);
    const a = vars.find((v) => v.name === 'a')!;
    const b = vars.find((v) => v.name === 'b')!;
    expect([...Array(3)].map((_, i) => snap.cells[a.address! + i].value)).toEqual([7, 8, 9]);
    expect([...Array(3)].map((_, i) => snap.cells[b.address! + i].value)).toEqual([0, 0, 0]);
  });

  it('float / char 数组', async () => {
    const r = await runSrc(`
      int main() {
        float f[2] = {1.5, 2.5};
        char c[3] = {'x', 'y'};
        return 0;
      }
    `);
    const snap = r.steps[r.steps.length - 1].snapshot;
    const vars = snap.scopes.flatMap((s) => s.vars);
    const f = vars.find((v) => v.name === 'f')!;
    const c = vars.find((v) => v.name === 'c')!;
    expect(snap.cells[f.address!].value).toBeCloseTo(1.5);
    expect(snap.cells[f.address! + 1].value).toBeCloseTo(2.5);
    expect(snap.cells[c.address!].type).toBe('char');
    expect(snap.cells[c.address!].value).toBe('x'.charCodeAt(0));
    expect(snap.cells[c.address! + 2].value).toBe(0);
  });
});

describe('数组读写与遍历', () => {
  it('下标读写', async () => {
    const r = await runSrc(`
      int main() {
        int a[3];
        a[0] = 10;
        a[1] = 20;
        a[2] = a[0] + a[1];
        return 0;
      }
    `);
    expect(r.finalVar('a')).toBeUndefined(); // 数组名本身不是标量
    const snap = r.steps[r.steps.length - 1].snapshot;
    const a = snap.scopes.flatMap((s) => s.vars).find((v) => v.name === 'a')!;
    expect(snap.cells[a.address! + 2].value).toBe(30);
  });

  it('循环遍历求和', async () => {
    const r = await runSrc(`
      int main() {
        int a[5] = {2, 4, 6, 8, 10};
        int sum = 0;
        for (int i = 0; i < 5; i++) {
          sum = sum + a[i];
        }
        return 0;
      }
    `);
    expect(r.finalVar('sum')?.value).toBe(30);
  });

  it('循环写入（平方表）', async () => {
    const r = await runSrc(`
      int main() {
        int sq[6];
        for (int i = 0; i < 6; i++) {
          sq[i] = i * i;
        }
        int total = 0;
        for (int i = 0; i < 6; i++) {
          total = total + sq[i];
        }
        return 0;
      }
    `);
    expect(r.finalVar('total')?.value).toBe(55); // 0+1+4+9+16+25
  });

  it('数组元素作为变化高亮的地址', async () => {
    const r = await runSrc(`
      int main() {
        int a[3] = {1, 2, 3};
        a[1] = 99;
        return 0;
      }
    `);
    const assignStep = r.steps.find((s) => s.statementType === 'expr-stmt');
    expect(assignStep?.changed.addresses.length).toBe(1);
  });
});

describe('数组越界与错误', () => {
  it('下标越界报 E_ARRAY_BOUND 且行号正确', async () => {
    const r = await runSrc('int main() {\n  int a[3];\n  int x = a[5];\n  return 0;\n}');
    expect(r.errorCode()).toBe('E_ARRAY_BOUND');
    const last = r.steps[r.steps.length - 1];
    expect(last.line).toBe(3);
    expect(last.description).toContain('越界');
  });

  it('负下标越界', async () => {
    const r = await runSrc(`
      int main() {
        int a[3];
        int i = -1;
        int x = a[i];
        return 0;
      }
    `);
    expect(r.errorCode()).toBe('E_ARRAY_BOUND');
  });

  it('数组元素与函数配合（传元素值）', async () => {
    const r = await runSrc(`
      int double_it(int n) {
        return n * 2;
      }
      int main() {
        int a[3] = {1, 2, 3};
        int x = double_it(a[1]);
        return 0;
      }
    `);
    expect(r.finalVar('x')?.value).toBe(4);
  });

  it('反转数组（经典教学案例）', async () => {
    const r = await runSrc(`
      int main() {
        int a[5] = {1, 2, 3, 4, 5};
        for (int i = 0; i < 5 / 2; i++) {
          int t = a[i];
          a[i] = a[4 - i];
          a[4 - i] = t;
        }
        return 0;
      }
    `);
    const snap = r.steps[r.steps.length - 1].snapshot;
    const a = snap.scopes.flatMap((s) => s.vars).find((v) => v.name === 'a')!;
    expect([...Array(5)].map((_, i) => snap.cells[a.address! + i].value)).toEqual([5, 4, 3, 2, 1]);
  });
});
