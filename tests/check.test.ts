// 语义检查测试：main 校验、类型错误、标签、printf 格式、重定义
import { describe, expect, it } from 'vitest';
import { compileOk, expectError } from './helpers';

describe('main 校验', () => {
  it('缺少 main', async () => {
    await expectError('int add(int a, int b) { return a + b; }', 'E_NO_MAIN', '缺少 main');
  });

  it('main 返回类型必须 int', async () => {
    await expectError('void main() { }', 'E_NO_MAIN', 'int');
  });

  it('main 不接受参数', async () => {
    await expectError('int main(int argc) { return 0; }', 'E_NO_MAIN');
  });

  it('函数重复定义', async () => {
    await expectError('int f() { return 1; }\nint f() { return 2; }\nint main() { return 0; }', 'E_DECL', '重复定义');
  });
});

describe('标签与 goto', () => {
  it('goto 目标不存在', async () => {
    await expectError('int main() { goto NOWHERE; return 0; }', 'E_LABEL', 'NOWHERE');
  });

  it('标签重复', async () => {
    await expectError('int main() { L: L: return 0; }', 'E_LABEL', '重复');
  });
});

describe('return 与函数类型', () => {
  it('void 函数不能返回值', async () => {
    await expectError('void f() { return 1; }\nint main() { f(); return 0; }', 'E_TYPE', '不能返回值');
  });

  it('非 void 函数 return 必须带值', async () => {
    await expectError('int f() { return; }\nint main() { return f(); }', 'E_TYPE', '必须带返回值');
  });
});

describe('类型检查', () => {
  it('% 只能用于整型', async () => {
    await expectError('int main() { double a = 1.5 % 2; return 0; }', 'E_TYPE', '%');
  });

  it('数组不能整体赋值', async () => {
    await expectError('int main() { int a[3]; int b[3]; a = b; return 0; }', 'E_TYPE', '数组不能整体赋值');
  });

  it('指针类型不匹配', async () => {
    await expectError('int main() { int a; double *p = &a; return 0; }', 'E_TYPE', '指针类型不匹配');
  });

  it('指针只能接收同类型指针或 0', async () => {
    await expectError('int main() { int a; int *p = a + 1; return 0; }', 'E_TYPE', '指针');
  });

  it('解引用非指针', async () => {
    await expectError('int main() { int a = 1; int b = *a; return 0; }', 'E_TYPE', '解引用');
  });

  it('数组下标必须整型', async () => {
    await expectError('int main() { int a[3]; int x = a[1.5]; return 0; }', 'E_TYPE', '下标');
  });

  it('switch 判别式必须整型', async () => {
    await expectError('int main() { double d = 1.5; switch (d) { case 1: break; } return 0; }', 'E_TYPE', '判别式');
  });

  it('使用未声明变量（编译期）', async () => {
    await expectError('int main() { x = 1; return 0; }', 'E_UNDEF_VAR', '未声明');
  });

  it('变量重复声明', async () => {
    await expectError('int main() { int a; int a; return 0; }', 'E_DECL', '重复声明');
  });

  it('& 指针的地址（二级指针）被拒绝', async () => {
    await expectError('int main() { int a; int *p = &a; int **pp = &p; return 0; }', 'E_UNSUPPORTED', '二级指针');
  });

  it('数组名不能参与算术', async () => {
    await expectError('int main() { int a[3]; int x = a + 1; return 0; }', 'E_TYPE', '只能作用于数值类型');
  });

  it('合法的指针用法应通过', async () => {
    await compileOk(`
      int main() {
        int a = 1;
        int *p = &a;
        *p = 5;
        int b = *p + a;
        return b;
      }
    `);
  });
});

describe('printf 检查', () => {
  it('第一个参数必须是字符串字面量', async () => {
    await expectError('int main() { int a = 1; printf(a); return 0; }', 'E_TYPE', 'printf');
  });

  it('不支持的宽度格式 %5d', async () => {
    await expectError('int main() { printf("%5d", 1); return 0; }', 'E_UNSUPPORTED', '宽度');
  });

  it('不支持 %u', async () => {
    await expectError('int main() { printf("%u", 1); return 0; }', 'E_UNSUPPORTED', '%u');
  });

  it('格式符与参数数量不一致', async () => {
    await expectError('int main() { printf("%d %d", 1); return 0; }', 'E_TYPE', '数量');
  });

  it('合法格式通过', async () => {
    await compileOk('int main() { printf("a=%d b=%f c=%c s=%s %%\\n", 1, 2.5, \'x\', "hi"); return 0; }');
  });

  it('调用未定义函数', async () => {
    await expectError('int main() { foo(); return 0; }', 'E_TYPE', '未定义');
  });

  it('参数个数不匹配', async () => {
    await expectError('int add(int a, int b) { return a + b; }\nint main() { return add(1); }', 'E_TYPE', '参数');
  });
});

describe('常量表达式', () => {
  it('数组长度必须常量', async () => {
    await expectError('int main() { int n = 3; int a[n]; return 0; }', 'E_CONST', '常量');
  });

  it('数组长度合法性', async () => {
    await expectError('int main() { int a[0]; return 0; }', 'E_CONST', '长度');
  });

  it('case 标签必须常量', async () => {
    await expectError('int main() { int x = 1; switch (x) { case x: break; } return 0; }', 'E_CONST', '常量表达式');
  });

  it('初始化列表个数超长', async () => {
    await expectError('int main() { int a[2] = {1, 2, 3}; return 0; }', 'E_TYPE', '超过数组长度');
  });

  it('case 常量表达式折叠（1+1）', async () => {
    await compileOk('int main() { int x = 2; switch (x) { case 1 + 1: x = 9; break; } return 0; }');
  });
});

describe('全局变量', () => {
  it('全局声明与常量初始化', async () => {
    const p = await compileOk('int g = 10;\nint h = 2 * 3 + 1;\nint main() { return g + h; }');
    expect(p.globals).toHaveLength(2);
  });

  it('全局初始化必须常量', async () => {
    await expectError('int a = 1;\nint b = a + 1;\nint main() { return 0; }', 'E_CONST', '常量表达式');
  });
});
