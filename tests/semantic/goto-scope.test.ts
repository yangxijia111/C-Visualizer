// goto 与作用域：支持矩阵 + 消除用户可触发 E_INTERNAL（SEMANTIC_MODEL §2.4）
import { describe, expect, it } from 'vitest';
import { compileErr, runSrc } from '../helpers';

describe('goto 跳入嵌套块：静态拒绝（教学限制）', () => {
  it('goto 跳入嵌套块 → 编译错误 E_LABEL', async () => {
    const errors = await compileErr(`
      int main() {
          goto L;
          {
              L:
              ;
          }
          return 0;
      }
    `);
    expect(errors.some((e) => e.code === 'E_LABEL' && e.message.includes('嵌套'))).toBe(true);
  });

  it('goto 跳到兄弟块内的标签 → 编译错误', async () => {
    const errors = await compileErr(`
      int main() {
          {
              goto L;
          }
          {
              L:
              ;
          }
          return 0;
      }
    `);
    expect(errors.some((e) => e.code === 'E_LABEL')).toBe(true);
  });

  it('goto 跳入循环体内的标签 → 编译错误（未打开的块）', async () => {
    const errors = await compileErr(`
      int main() {
          int i = 0;
          goto INSIDE;
          while (i < 3) {
              INSIDE:
              i++;
          }
          return 0;
      }
    `);
    expect(errors.some((e) => e.code === 'E_LABEL')).toBe(true);
  });

  it('循环内 goto 跳到同循环内的标签：合法', async () => {
    const r = await runSrc(`
      int main() {
          int i = 0;
          int count = 0;
          while (i < 5) {
              i++;
              if (i == 2) goto SKIP;
              count++;
              SKIP:
              ;
          }
          return 0;
      }
    `);
    expect(r.ok).toBe(true);
    expect(r.finalVar('count')?.value).toBe(4);
  });
});

describe('goto 跳出：合法（冒泡实现）', () => {
  it('从内层块跳出到函数体顶层', async () => {
    const r = await runSrc(`
      int main() {
          {
              goto OUT;
          }
          OUT:
          return 0;
      }
    `);
    expect(r.ok).toBe(true);
  });

  it('从嵌套循环跳出两层', async () => {
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
    expect(r.ok).toBe(true);
    expect(r.finalVar('hits')?.value).toBe(13);
  });

  it('从 switch 内跳出到外层', async () => {
    const r = await runSrc(`
      int main() {
          switch (1) {
              case 1:
                  goto EXIT;
          }
          EXIT:
          return 0;
      }
    `);
    expect(r.ok).toBe(true);
  });
});

describe('前向 goto 跳过声明：补声明为未初始化（对齐 C 块作用域）', () => {
  it('跳过声明后引用 → 运行时 E_UNINIT_READ（不再是未定义变量）', async () => {
    const r = await runSrc(`
      int main() {
          goto LATER;
          int hidden = 5;
          LATER:
          printf("%d", hidden);
          return 0;
      }
    `);
    expect(r.errorCode()).toBe('E_UNINIT_READ');
  });

  it('跳过的声明不出现在作用域重复声明（跳转后重新执行不炸）', async () => {
    const r = await runSrc(`
      int main() {
          goto LATER;
          int hidden = 5;
          LATER:
          ;
          return 0;
      }
    `);
    expect(r.ok).toBe(true);
  });

  it('后向 goto 重新经过声明：重新初始化（保持既有行为）', async () => {
    const r = await runSrc(`
      int main() {
          int i = 0;
          int sum = 0;
          LOOP:
          int inc = 2;
          sum = sum + inc;
          i++;
          if (i < 3) goto LOOP;
          return 0;
      }
    `);
    expect(r.ok).toBe(true);
    expect(r.finalVar('sum')?.value).toBe(6);
  });

  it('跳过数组声明：数组补声明为未初始化', async () => {
    const r = await runSrc(`
      int main() {
          goto SKIP;
          int a[3] = {1, 2, 3};
          SKIP:
          printf("%d", a[0]);
          return 0;
      }
    `);
    expect(r.errorCode()).toBe('E_UNINIT_READ');
  });
});
