// 质量审计回归测试：控制流/作用域/短路副作用/递归/指针状态组合场景
import { describe, expect, it } from 'vitest';
import { runSrc } from './helpers';

describe('控制流组合', () => {
  it('switch 内 continue 正确作用于外层循环', async () => {
    const r = await runSrc(`
      int main() {
        int sum = 0;
        for (int i = 0; i < 6; i++) {
          switch (i % 3) {
            case 0:
              continue;
            case 1:
              sum = sum + i;
              break;
            case 2:
              sum = sum + i * 10;
              break;
          }
          sum = sum + 100;
        }
        return 0;
      }
    `);
    // i=0: continue → +0；i=1: +1+100=101；i=2: +20+100=221；i=3: continue；i=4: +4+100=325；i=5: +50+100=475
    expect(r.finalVar('sum')?.value).toBe(475);
  });

  it('短路右侧的副作用不执行', async () => {
    const r = await runSrc(`
      int main() {
        int a = 0;
        int b = 0;
        int r1 = 0 && (a = 5);
        int r2 = 1 || (b = 5);
        return 0;
      }
    `);
    expect(r.finalVar('a')?.value).toBe(0);
    expect(r.finalVar('b')?.value).toBe(0);
  });

  it('除零防护惯用法：b != 0 && a / b > 0', async () => {
    const r = await runSrc(`
      int main() {
        int a = 10;
        int b = 0;
        int safe = b != 0 && a / b > 0;
        b = 2;
        int val = b != 0 && a / b > 0;
        return 0;
      }
    `);
    expect(r.finalVar('safe')?.value).toBe(0);
    expect(r.finalVar('val')?.value).toBe(1);
  });
});

describe('作用域与状态', () => {
  it('递归与 goto 混合：各帧标签独立', async () => {
    const r = await runSrc(`
      int countdown(int n) {
      TOP:
        if (n <= 0) return 0;
        n = n - 1;
        goto TOP;
      }
      int main() {
        int a = countdown(3);
        int b = countdown(5);
        return 0;
      }
    `);
    expect(r.finalVar('a')?.value).toBe(0);
    expect(r.finalVar('b')?.value).toBe(0);
  });

  it('递归函数内的局部数组每帧独立', async () => {
    const r = await runSrc(`
      int fill(int depth) {
        int arr[4];
        for (int i = 0; i < 4; i++) {
          arr[i] = depth * 10 + i;
        }
        if (depth > 0) {
          int below = fill(depth - 1);
          arr[0] = arr[0] + below;
        }
        return arr[0];
      }
      int main() {
        int result = fill(2);
        return 0;
      }
    `);
    // fill(2): arr[0]=20 → below=fill(1): arr[0]=10 → below=fill(0): arr[0]=0, return 0 → fill(1) arr[0]=10 → fill(2) arr[0]=20+10=30
    expect(r.finalVar('result')?.value).toBe(30);
  });

  it('循环内声明的变量每轮重新初始化', async () => {
    const r = await runSrc(`
      int main() {
        int last = -1;
        for (int i = 0; i < 3; i++) {
          int fresh = i * 5;
          last = fresh;
        }
        return 0;
      }
    `);
    expect(r.finalVar('last')?.value).toBe(10);
  });
});

describe('数值语义', () => {
  it('复合赋值浮点目标', async () => {
    const r = await runSrc(`
      int main() {
        double d = 1.5;
        d += 0.25;
        d *= 2;
        d -= 1;
        d /= 4;
        return 0;
      }
    `);
    // (1.5+0.25)*2-1 = 2.5; /4 = 0.625
    expect(r.finalVar('d')?.value).toBeCloseTo(0.625);
  });

  it('int 溢出环绕（32 位）', async () => {
    const r = await runSrc(`
      int main() {
        int big = 2000000000;
        int doubled = big + big;
        return 0;
      }
    `);
    // 4000000000 环绕 32 位有符号：4000000000 - 4294967296 = -294967296
    expect(r.finalVar('doubled')?.value).toBe(-294967296);
  });

  it('char 溢出取低 8 位', async () => {
    const r = await runSrc(`
      int main() {
        char c = 200;
        c = c + 100;
        return 0;
      }
    `);
    // 300 & 0xff = 44
    expect(r.finalVar('c')?.value).toBe(44);
  });
});

describe('指针状态一致性', () => {
  it('swap 后指针仍指向原变量', async () => {
    const r = await runSrc(`
      int main() {
        int a = 1;
        int b = 2;
        int *pa = &a;
        int *pb = &b;
        int t = *pa;
        *pa = *pb;
        *pb = t;
        int va = *pa;
        int vb = *pb;
        return 0;
      }
    `);
    expect(r.finalVar('va')?.value).toBe(2);
    expect(r.finalVar('vb')?.value).toBe(1);
    expect(r.finalVar('a')?.value).toBe(2);
    expect(r.finalVar('b')?.value).toBe(1);
  });

  it('printf 中多个参数求值不影响输出顺序', async () => {
    const r = await runSrc(`
      int main() {
        int x = 1;
        printf("%d %d %d", x, x + 1, x * 10);
        return 0;
      }
    `);
    expect(r.output).toBe('1 2 10');
  });
});
