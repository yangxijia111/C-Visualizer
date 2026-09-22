// 作用域语义回归：静态检查器必须与运行时块作用域一致（SEMANTIC_MODEL §2）
// 任务书案例 1–6 + for/switch/形参扩展
import { describe, expect, it } from 'vitest';
import { compileOk, compileErr, runSrc } from '../helpers';

describe('作用域可见性（静态检查 = 运行时块作用域）', () => {
  it('案例1：块内声明的变量在块外使用 → 编译期 E_UNDEF_VAR', async () => {
    const errors = await compileErr(`
      int main() {
          {
              int x = 10;
          }
          x = 20;
          return 0;
      }
    `);
    expect(errors.some((e) => e.code === 'E_UNDEF_VAR' && e.message.includes('x'))).toBe(true);
  });

  it('案例2：内层 double x 遮蔽外层 int x，外层 x %= 2 合法', async () => {
    await compileOk(`
      int main() {
          int x = 1;
          {
              double x = 2.5;
          }
          x %= 2;
          return 0;
      }
    `);
  });

  it('案例3：两个同名 x 独立（内层修改不影响外层）', async () => {
    const r = await runSrc(`
      int main() {
          int x = 1;
          {
              int x = 2;
              x++;
          }
          x++;
          return 0;
      }
    `);
    expect(r.ok).toBe(true);
    expect(r.finalVar('x')?.value).toBe(2);
  });

  it('案例4：for 的 init 声明在循环外不可见 → 编译错误', async () => {
    const errors = await compileErr(`
      int main() {
          for (int i = 0; i < 3; i++) {
          }
          i = 10;
          return 0;
      }
    `);
    expect(errors.some((e) => e.code === 'E_UNDEF_VAR' && e.message.includes('i'))).toBe(true);
  });

  it('案例5：同作用域重复声明 → E_DECL', async () => {
    const errors = await compileErr(`
      int main() {
          int x;
          int x;
          return 0;
      }
    `);
    expect(errors.some((e) => e.code === 'E_DECL' && e.message.includes('x'))).toBe(true);
  });

  it('案例6：外层 x + 内层同名 shadowing 合法', async () => {
    await compileOk(`
      int main() {
          int x = 1;
          {
              int x = 2;
          }
          return 0;
      }
    `);
  });
});

describe('for / switch / 形参作用域', () => {
  it('for init 变量在条件、update、body 内可见', async () => {
    const r = await runSrc(`
      int main() {
          int sum = 0;
          for (int i = 0; i < 5; i = i + 1) {
              sum = sum + i;
          }
          return 0;
      }
    `);
    expect(r.ok).toBe(true);
    expect(r.finalVar('sum')?.value).toBe(10);
  });

  it('两个并列 for 各自声明 i 互不冲突', async () => {
    await compileOk(`
      int main() {
          for (int i = 0; i < 3; i++) { }
          for (int i = 5; i < 8; i++) { }
          return 0;
      }
    `);
  });

  it('switch body 是单一作用域：case 内声明跨 case 可见（C 语义）', async () => {
    const r = await runSrc(`
      int main() {
          switch (1) {
              case 1: {
                  int t = 7;
                  t = t + 1;
                  break;
              }
              case 2:
                  break;
          }
          return 0;
      }
    `);
    expect(r.ok).toBe(true);
  });

  it('形参与函数体顶层声明同名 → E_DECL（同一 Function Scope）', async () => {
    const errors = await compileErr(`
      int f(int x) {
          int x = 1;
          return x;
      }
      int main() { return 0; }
    `);
    expect(errors.some((e) => e.code === 'E_DECL' && e.message.includes('x'))).toBe(true);
  });

  it('switch 内声明的变量在 switch 外不可见', async () => {
    const errors = await compileErr(`
      int main() {
          switch (1) {
              case 1: {
                  int t = 7;
                  break;
              }
          }
          t = 1;
          return 0;
      }
    `);
    expect(errors.some((e) => e.code === 'E_UNDEF_VAR' && e.message.includes('t'))).toBe(true);
  });

  it('while body 块内声明在循环外不可见', async () => {
    const errors = await compileErr(`
      int main() {
          int i = 0;
          while (i < 3) {
              int inner = i;
              i++;
          }
          inner = 5;
          return 0;
      }
    `);
    expect(errors.some((e) => e.code === 'E_UNDEF_VAR' && e.message.includes('inner'))).toBe(true);
  });
});

describe('遮蔽与全局作用域', () => {
  it('局部变量遮蔽全局变量，函数内取局部', async () => {
    const r = await runSrc(`
      int g = 100;
      int main() {
          int g = 1;
          g = g + 1;
          return 0;
      }
    `);
    expect(r.ok).toBe(true);
    // main 作用域内的 g 是局部变量（=2）；全局 g 保持 100
    const snap = r.steps[r.steps.length - 1].snapshot;
    const mainG = snap.scopes.find((s) => s.label === 'main')?.vars.find((v) => v.name === 'g');
    const globalG = snap.scopes.find((s) => s.kind === 'global')?.vars.find((v) => v.name === 'g');
    expect(snap.cells[mainG?.address ?? -1]?.value).toBe(2);
    expect(snap.cells[globalG?.address ?? -1]?.value).toBe(100);
  });

  it('全局变量在函数内直接可见', async () => {
    const r = await runSrc(`
      int g = 5;
      int main() {
          g = g * 2;
          return 0;
      }
    `);
    expect(r.ok).toBe(true);
    expect(r.finalVar('g')?.value).toBe(10);
  });

  it('声明点语义：int x = x; 编译通过（引用自身），运行读取报 E_UNINIT_READ', async () => {
    await compileOk(`
      int main() {
          int x = x;
          return 0;
      }
    `);
    const r = await runSrc(`
      int main() {
          int x = x;
          return 0;
      }
    `);
    expect(r.errorCode()).toBe('E_UNINIT_READ');
  });

  it('多声明符顺序可见：int a = 1, b = a; 合法', async () => {
    const r = await runSrc(`
      int main() {
          int a = 1, b = a + 1;
          return 0;
      }
    `);
    expect(r.ok).toBe(true);
    expect(r.finalVar('b')?.value).toBe(2);
  });

  it('块内遮蔽后读取的是内层值（运行时独立单元）', async () => {
    const r = await runSrc(`
      int main() {
          int x = 10;
          {
              double x = 2.5;
              x = x + 0.5;
          }
          return 0;
      }
    `);
    expect(r.ok).toBe(true);
    expect(r.finalVar('x')?.type).toBe('int');
    expect(r.finalVar('x')?.value).toBe(10);
  });
});
