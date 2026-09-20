// 函数测试：参数按值 / 返回值 / 局部作用域 / 调用栈 / printf
import { describe, expect, it } from 'vitest';
import { runSrc, expectError } from './helpers';

describe('函数基础', () => {
  it('参数与返回值', async () => {
    const r = await runSrc(`
      int add(int a, int b) {
        return a + b;
      }
      int main() {
        int result = add(3, 4);
        return 0;
      }
    `);
    expect(r.finalVar('result')?.value).toBe(7);
  });

  it('参数按值传递：形参修改不影响实参', async () => {
    const r = await runSrc(`
      void modify(int x) {
        x = 999;
      }
      int main() {
        int a = 5;
        modify(a);
        return 0;
      }
    `);
    expect(r.finalVar('a')?.value).toBe(5);
  });

  it('局部变量与全局同名遮蔽', async () => {
    const r = await runSrc(`
      int v = 1;
      int shadow() {
        int v = 100;
        v = v + 1;
        return v;
      }
      int main() {
        int r1 = shadow();
        return 0;
      }
    `);
    expect(r.finalVar('r1')?.value).toBe(101);
    expect(r.finalVar('v')?.value).toBe(1); // 全局未被修改
  });

  it('函数访问全局变量', async () => {
    const r = await runSrc(`
      int counter = 0;
      void bump() {
        counter = counter + 1;
      }
      int main() {
        bump();
        bump();
        bump();
        return 0;
      }
    `);
    expect(r.finalVar('counter')?.value).toBe(3);
  });

  it('void 函数无返回值', async () => {
    const r = await runSrc(`
      void hello() {
        int x = 1;
      }
      int main() {
        hello();
        return 0;
      }
    `);
    expect(r.ok).toBe(true);
  });

  it('调用与返回步骤存在且描述正确', async () => {
    const r = await runSrc(`
      int add(int a, int b) {
        return a + b;
      }
      int main() {
        int result = add(3, 4);
        return 0;
      }
    `);
    const callStep = r.steps.find((s) => s.statementType === 'call' && s.description.includes('add'));
    const returnStep = r.steps.find((s) => s.statementType === 'return');
    expect(callStep).toBeDefined();
    expect(callStep?.description).toContain('add');
    expect(callStep?.description).toContain('3');
    expect(returnStep).toBeDefined();
    expect(returnStep?.description).toContain('7');
  });

  it('调用栈快照：函数执行中帧存在', async () => {
    const r = await runSrc(`
      int double_it(int n) {
        return n * 2;
      }
      int main() {
        int x = double_it(21);
        return 0;
      }
    `);
    // 找到 double_it 函数体执行期间的步骤
    const during = r.steps.find((s) => s.snapshot.callStack.some((f) => f.functionName === 'double_it'));
    expect(during).toBeDefined();
    expect(during!.snapshot.callStack.map((f) => f.functionName)).toEqual(['main', 'double_it']);
    // 程序结束步骤保留 main 帧（教学：最终变量现场）
    const last = r.steps[r.steps.length - 1];
    expect(last.snapshot.callStack.length).toBe(1);
    expect(last.snapshot.callStack[0].functionName).toBe('main');
  });
});

describe('多函数协作', () => {
  it('先定义后使用、先使用后定义均可', async () => {
    const r = await runSrc(`
      int main() {
        return_value_helper();
        return 0;
      }
      void return_value_helper() {
        int x = 1;
      }
    `);
    expect(r.ok).toBe(true);
  });

  it('函数间传递计算', async () => {
    const r = await runSrc(`
      int square(int n) {
        return n * n;
      }
      int sum_squares(int a, int b) {
        return square(a) + square(b);
      }
      int main() {
        int result = sum_squares(3, 4);
        return 0;
      }
    `);
    expect(r.finalVar('result')?.value).toBe(25);
  });
});

describe('printf 输出', () => {
  it('基本格式符 %d %f %c %s %%', async () => {
    const r = await runSrc(`
      int main() {
        printf("a=%d f=%f c=%c s=%s 100%%\\n", 42, 1.5, 'X', "hi");
        return 0;
      }
    `);
    expect(r.output).toBe('a=42 f=1.500000 c=X s=hi 100%\n');
  });

  it('多次 printf 累积输出', async () => {
    const r = await runSrc(`
      int main() {
        printf("Hello");
        printf(", World!\\n");
        return 0;
      }
    `);
    expect(r.output).toBe('Hello, World!\n');
  });

  it('printf 步骤带 outputDelta', async () => {
    const r = await runSrc(`
      int main() {
        printf("A\\n");
        printf("B\\n");
        return 0;
      }
    `);
    const prints = r.steps.filter((s) => s.outputDelta);
    expect(prints.length).toBe(2);
    expect(prints[0].outputDelta).toBe('A\n');
    expect(prints[1].outputDelta).toBe('B\n');
  });

  it('%f 默认 6 位小数', async () => {
    const r = await runSrc(`
      int main() {
        double d = 3.14159265;
        printf("%f", d);
        return 0;
      }
    `);
    expect(r.output).toBe('3.141593');
  });

  it('puts 输出并换行', async () => {
    const r = await runSrc(`
      int main() {
        puts("hello");
        return 0;
      }
    `);
    expect(r.output).toBe('hello\n');
  });

  it('参数不足：检查器直接拦截（格式符与参数数量不一致）', async () => {
    await expectError(`
      int main() {
        printf("%d %d", 1);
        return 0;
      }
    `, 'E_TYPE', '数量');
  });
});

describe('Hello World 验收', () => {
  it('完整 Hello World 程序', async () => {
    const r2 = await runSrc(`
      int main() {
        printf("Hello, World!\\n");
        return 0;
      }
    `);
    expect(r2.ok).toBe(true);
    expect(r2.output).toBe('Hello, World!\n');
  });
});
