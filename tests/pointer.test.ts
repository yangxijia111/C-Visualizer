// 指针测试：& 取址 / * 解引用读 写 / 指针重指向 / 指向数组元素 / 空指针
import { describe, expect, it } from 'vitest';
import { runSrc } from './helpers';

describe('指针基础', () => {
  it('&a 后 *p 读值', async () => {
    const r = await runSrc(`
      int main() {
        int a = 5;
        int *p = &a;
        int b = *p;
        return 0;
      }
    `);
    expect(r.finalVar('b')?.value).toBe(5);
  });

  it('*p = 20 通过指针写变量', async () => {
    const r = await runSrc(`
      int main() {
        int a = 5;
        int *p = &a;
        *p = 20;
        int b = a;
        return 0;
      }
    `);
    expect(r.finalVar('b')?.value).toBe(20);
    expect(r.finalVar('a')?.value).toBe(20);
  });

  it('指针值是抽象地址，与 a 同单元', async () => {
    const r = await runSrc(`
      int main() {
        int a = 5;
        int *p = &a;
        return 0;
      }
    `);
    const snap = r.steps[r.steps.length - 1].snapshot;
    const vars = snap.scopes.flatMap((s) => s.vars);
    const a = vars.find((v) => v.name === 'a')!;
    const p = vars.find((v) => v.name === 'p')!;
    const pCell = snap.cells[p.address!];
    expect(pCell.type).toBe('pointer');
    expect(pCell.value).toBe(a.address);
  });

  it('指针重指向', async () => {
    const r = await runSrc(`
      int main() {
        int x = 1;
        int y = 2;
        int *p = &x;
        p = &y;
        *p = 30;
        int rx = x;
        int ry = y;
        return 0;
      }
    `);
    expect(r.finalVar('rx')?.value).toBe(1);
    expect(r.finalVar('ry')?.value).toBe(30);
  });

  it('通过指针交换两个变量', async () => {
    const r = await runSrc(`
      void swap(int *pa, int *pb) {
        int t = *pa;
        *pa = *pb;
        *pb = t;
      }
      int main() {
        int a = 3;
        int b = 7;
        swap(&a, &b);
        return 0;
      }
    `);
    expect(r.finalVar('a')?.value).toBe(7);
    expect(r.finalVar('b')?.value).toBe(3);
  });

  it('指针做条件（非 0 为真）', async () => {
    const r = await runSrc(`
      int main() {
        int a = 1;
        int *p = &a;
        int hits = 0;
        if (p) hits++;
        p = 0;
        if (p) hits++;
        return 0;
      }
    `);
    expect(r.finalVar('hits')?.value).toBe(1);
  });
});

describe('指针与数组', () => {
  it('&arr[2] 后 *p 即 arr[2]', async () => {
    const r = await runSrc(`
      int main() {
        int arr[5] = {10, 20, 30, 40, 50};
        int *p = &arr[2];
        int v = *p;
        *p = 99;
        int v2 = arr[2];
        return 0;
      }
    `);
    expect(r.finalVar('v')?.value).toBe(30);
    expect(r.finalVar('v2')?.value).toBe(99);
  });


  it('通过指针参数写数组元素', async () => {
    const r = await runSrc(`
      void set(int *dst, int v) {
        *dst = v;
      }
      int main() {
        int a[3] = {0, 0, 0};
        set(&a[0], 10);
        set(&a[1], 20);
        set(&a[2], 30);
        int sum = a[0] + a[1] + a[2];
        return 0;
      }
    `);
    expect(r.finalVar('sum')?.value).toBe(60);
  });
});

describe('指针错误', () => {
  it('解引用未初始化指针报错', async () => {
    const r = await runSrc(`
      int main() {
        int *p;
        int x = *p;
        return 0;
      }
    `);
    expect(r.errorCode()).toBe('E_UNINIT_READ');
  });

  it('解引用空指针报 E_NULL_DEREF', async () => {
    const r = await runSrc(`
      int main() {
        int *p = 0;
        int x = *p;
        return 0;
      }
    `);
    expect(r.errorCode()).toBe('E_NULL_DEREF');
  });

  it('NULL 解引用报错', async () => {
    const r = await runSrc(`
      int main() {
        int *p = NULL;
        *p = 1;
        return 0;
      }
    `);
    expect(r.errorCode()).toBe('E_NULL_DEREF');
  });

  it('指针指向已声明变量（作用域销毁后防御）', async () => {
    // v1.0 教学约束：指向块内变量的指针在块结束后使用是未定义行为，
    // 引擎地址不复用，因此读到的是旧值——此处验证不崩溃且值一致
    const r = await runSrc(`
      int main() {
        int *p = 0;
        {
          int inner = 42;
          p = &inner;
        }
        int v = *p;
        return 0;
      }
    `);
    expect(r.finalVar('v')?.value).toBe(42);
  });
});
