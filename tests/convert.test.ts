// CST→AST 转换测试：声明形态、表达式结构、控制流规整、不支持特性拒绝
import { describe, expect, it } from 'vitest';
import { compileOk, expectError } from './helpers';
import type { Program, FunctionDef } from '../src/core/ast';

function mainFn(p: Program): FunctionDef {
  return p.functions.find((f) => f.name === 'main')!;
}

describe('声明转换', () => {
  it('标量声明与多声明符', async () => {
    const p = await compileOk(`
      int a;
      int b = 10, c = 20;
      float f = 1.5;
      char ch = 'x';
      double d;
      int main() { return 0; }
    `);
    const decls = p.globals;
    expect(decls.map((d) => d.vars.map((v) => v.name).join(','))).toEqual([
      'a', 'b,c', 'f', 'ch', 'd',
    ]);
  });

  it('指针与数组声明', async () => {
    const p = await compileOk(`
      int main() {
        int *p;
        int a[5];
        int *q = &a[0];
        return 0;
      }
    `);
    const stmts = mainFn(p).body.body;
    const varOf = (i: number) => (stmts[i] as unknown as { vars: { name: string; varType: unknown }[] }).vars[0];
    expect(varOf(0).varType).toEqual({ kind: 'pointer', pointee: 'int' });
    expect(varOf(1).varType).toEqual({ kind: 'array', elem: 'int', length: 5 });
    expect(varOf(2).varType).toEqual({ kind: 'pointer', pointee: 'int' });
  });

  it('数组初始化列表', async () => {
    const p = await compileOk('int main() { int a[3] = {1, 2, 3}; int b[4] = {1}; int c[2] = {}; return 0; }');
    const stmts = mainFn(p).body.body;
    const list = (i: number) => (stmts[i] as unknown as { vars: { initList?: unknown[] }[] }).vars[0].initList;
    expect(list(0)).toHaveLength(3);
    expect(list(1)).toHaveLength(1);
    expect(list(2)).toHaveLength(0);
  });
});

describe('表达式结构', () => {
  it('优先级：1 + 2 * 3', async () => {
    const p = await compileOk('int main() { int a = 1 + 2 * 3; return 0; }');
    const decl = mainFn(p).body.body[0] as unknown as { vars: { init: { kind: string; op?: string; left?: { kind: string }; right?: { op: string } } }[] };
    const init = decl.vars[0].init!;
    expect(init.kind).toBe('binary');
    expect(init.op).toBe('+');
    expect(init.left!.kind).toBe('int-literal');
    expect(init.right!.op).toBe('*');
  });

  it('括号改变优先级：(1 + 2) * 3', async () => {
    const p = await compileOk('int main() { int a = (1 + 2) * 3; return 0; }');
    const decl = mainFn(p).body.body[0] as unknown as { vars: { init: { op: string; left: { op: string } } }[] };
    expect(decl.vars[0].init!.op).toBe('*');
    expect(decl.vars[0].init!.left.op).toBe('+');
  });

  it('前置与后置 ++/--', async () => {
    const p = await compileOk('int main() { int i = 0; i++; ++i; --i; i--; return 0; }');
    const kinds = mainFn(p).body.body.map((s) => {
      if (s.kind !== 'expr-stmt') return s.kind;
      return (s as unknown as { expr: { kind: string } }).expr.kind;
    });
    expect(kinds).toEqual(['var-decl', 'post-incdec', 'pre-incdec', 'pre-incdec', 'post-incdec', 'return']);
  });

  it('取址与解引用', async () => {
    const p = await compileOk('int main() { int a = 1; int *p = &a; *p = 2; a = *p; return 0; }');
    const stmts = mainFn(p).body.body;
    const decl = stmts[1] as unknown as { vars: { init: { kind: string } }[] };
    expect(decl.vars[0].init!.kind).toBe('addr-of');
    expect((stmts[2] as unknown as { expr: { target: { kind: string } } }).expr.target.kind).toBe('deref');
  });

  it('逻辑与比较运算', async () => {
    const p = await compileOk('int main() { int a = 1 < 2 && 3 > 2 || !0; return 0; }');
    const decl = mainFn(p).body.body[0] as unknown as { vars: { init: { op: string } }[] };
    expect(decl.vars[0].init!.op).toBe('||');
  });

  it('连续赋值右结合', async () => {
    const p = await compileOk('int main() { int a; int b; a = b = 5; return 0; }');
    const stmt = mainFn(p).body.body[2] as unknown as { expr: { kind: string; value: { kind: string } } };
    expect(stmt.expr.kind).toBe('assign');
    expect(stmt.expr.value.kind).toBe('assign');
  });

  it('复合赋值', async () => {
    const p = await compileOk('int main() { int a = 1; a += 2; a -= 1; a *= 3; a /= 2; a %= 2; return 0; }');
    const ops = mainFn(p).body.body.slice(1).filter((s) => s.kind === 'expr-stmt').map((s) => (s as unknown as { expr: { op: string } }).expr.op);
    expect(ops).toEqual(['+=', '-=', '*=', '/=', '%=']);
  });
});

describe('控制流规整', () => {
  it('if / else 结构', async () => {
    const p = await compileOk(`
      int main() {
        int a = 1;
        if (a > 0) { a = 2; } else { a = 3; }
        return 0;
      }
    `);
    const ifStmt = mainFn(p).body.body[1];
    expect(ifStmt.kind).toBe('if');
  });

  it('switch 的 case/default 规整与合并标签', async () => {
    const p = await compileOk(`
      int main() {
        int x = 2;
        switch (x) {
          case 1:
            x = 10;
            break;
          case 2:
          case 3:
            x = 20;
            break;
          default:
            x = 0;
        }
        return 0;
      }
    `);
    const sw = mainFn(p).body.body[1] as { kind: string; cases: { labels: { isDefault: boolean }[]; body: unknown[] }[] };
    expect(sw.kind).toBe('switch');
    expect(sw.cases).toHaveLength(3);
    expect(sw.cases[1].labels).toHaveLength(2); // case 2: case 3: 合并
    expect(sw.cases[2].labels[0].isDefault).toBe(true);
  });

  it('for 三段与 while / do-while', async () => {
    const p = await compileOk(`
      int main() {
        for (int i = 0; i < 3; i++) { }
        int j = 0;
        while (j < 3) { j++; }
        do { j--; } while (j > 0);
        return 0;
      }
    `);
    const kinds = mainFn(p).body.body.map((s) => s.kind);
    expect(kinds).toEqual(['for', 'var-decl', 'while', 'do-while', 'return']);
    const forStmt = mainFn(p).body.body[0] as { init: { kind: string }; condition: object; update: object };
    expect(forStmt.init.kind).toBe('var-decl');
    expect(forStmt.condition).toBeDefined();
    expect(forStmt.update).toBeDefined();
  });

  it('goto 与标签', async () => {
    const p = await compileOk(`
      int main() {
        int a = 0;
        goto SKIP;
        a = 99;
        SKIP:
        return a;
      }
    `);
    const kinds = mainFn(p).body.body.map((s) => s.kind);
    expect(kinds).toContain('goto');
    expect(kinds).toContain('label');
  });

  it('break / continue / return', async () => {
    const p = await compileOk(`
      int main() {
        while (1) { break; }
        for (;;) { continue; }
        return 0;
      }
    `);
    const kinds = mainFn(p).body.body.map((s) => s.kind);
    expect(kinds).toEqual(['while', 'for', 'return']);
  });
});

describe('函数与参数', () => {
  it('函数定义与参数', async () => {
    const p = await compileOk(`
      int add(int a, int b) { return a + b; }
      void hello() { return; }
      int main() { return add(1, 2); }
    `);
    expect(p.functions.map((f) => f.name)).toEqual(['add', 'hello', 'main']);
    expect(p.functions[0].params).toEqual([
      { name: 'a', type: 'int' },
      { name: 'b', type: 'int' },
    ]);
    expect(p.functions[1].returnType).toBe('void');
  });

  it('指针参数', async () => {
    const p = await compileOk(`
      void set(int *p, int v) { *p = v; }
      int main() { int x = 0; set(&x, 5); return x; }
    `);
    expect(p.functions[0].params[0].type).toEqual({ kind: 'pointer', pointee: 'int' });
  });

  it('递归函数与调用先后无关', async () => {
    const p = await compileOk(`
      int main() { return fact(3); }
      int fact(int n) { if (n <= 1) return 1; return n * fact(n - 1); }
    `);
    expect(p.functions.map((f) => f.name)).toEqual(['main', 'fact']);
  });
});

describe('数字与转义', () => {
  it('十六进制 / 八进制 / 浮点 / 后缀', async () => {
    const p = await compileOk('int main() { int a = 0x1F; int b = 010; int c = 42u; double d = 1.5e2; float f = .5f; return 0; }');
    const decls = mainFn(p).body.body;
    expect((decls[0] as unknown as { vars: { init: { value: number } }[] }).vars[0].init!.value).toBe(31);
    expect((decls[1] as unknown as { vars: { init: { value: number } }[] }).vars[0].init!.value).toBe(8);
    expect((decls[2] as unknown as { vars: { init: { value: number } }[] }).vars[0].init!.value).toBe(42);
    expect((decls[3] as unknown as { vars: { init: { value: number } }[] }).vars[0].init!.value).toBe(150);
    expect((decls[4] as unknown as { vars: { init: { value: number } }[] }).vars[0].init!.value).toBe(0.5);
  });

  it('字符转义', async () => {
    const p = await compileOk(`int main() { char a = '\\n'; char b = '\\\\'; char c = '\\0'; return 0; }`);
    const decls = mainFn(p).body.body;
    expect((decls[0] as unknown as { vars: { init: { code: number } }[] }).vars[0].init!.code).toBe(10);
    expect((decls[1] as unknown as { vars: { init: { code: number } }[] }).vars[0].init!.code).toBe(92);
    expect((decls[2] as unknown as { vars: { init: { code: number } }[] }).vars[0].init!.code).toBe(0);
  });
});

describe('不支持特性拒绝（E_UNSUPPORTED）', () => {
  it('struct', async () => {
    const e = await expectError('int main() { struct P { int x; }; return 0; }', 'E_UNSUPPORTED', 'struct');
    expect(e.hint).toBeTruthy();
  });

  it('#include', async () => {
    await expectError('#include <stdio.h>\nint main() { return 0; }', 'E_UNSUPPORTED', '#include');
  });

  it('二维数组', async () => {
    await expectError('int main() { int a[2][3]; return 0; }', 'E_UNSUPPORTED');
  });

  it('二级指针', async () => {
    await expectError('int main() { int a; int *p = &a; int **pp = &p; return 0; }', 'E_UNSUPPORTED', '二级指针');
  });

  it('位运算', async () => {
    await expectError('int main() { int a = 1 << 2; return 0; }', 'E_UNSUPPORTED', '位运算');
    await expectError('int main() { int a = 3 & 1; return 0; }', 'E_UNSUPPORTED', '位运算');
  });

  it('三目运算符', async () => {
    const e = await expectError('int main() { int a = 1 ? 2 : 3; return 0; }', 'E_UNSUPPORTED');
    expect(e.hint).toContain('if/else');
  });

  it('sizeof 与强转', async () => {
    await expectError('int main() { int a = sizeof(int); return 0; }', 'E_UNSUPPORTED');
    await expectError('int main() { double d = 1.5; int a = (int)d; return 0; }', 'E_UNSUPPORTED');
  });

  it('typedef 与 const', async () => {
    await expectError('typedef int myint;\nint main() { return 0; }', 'E_UNSUPPORTED');
    await expectError('int main() { const int a = 1; return 0; }', 'E_UNSUPPORTED');
  });

  it('enum / union', async () => {
    await expectError('int main() { enum E { A }; return 0; }', 'E_UNSUPPORTED');
  });

  it('逗号表达式', async () => {
    await expectError('int main() { int a; int b; a = (1, 2); return 0; }', 'E_UNSUPPORTED', '逗号');
  });
});

describe('语法错误（E_SYNTAX）', () => {
  it('缺少分号', async () => {
    const e = await expectError('int main() { int a = 1 return 0; }', 'E_SYNTAX');
    expect(e.line).toBe(1);
  });

  it('缺少右花括号', async () => {
    const e = await expectError('int main() { int a = 1;', 'E_SYNTAX');
    expect(e.line).toBe(1);
  });

  it('声明缺初始化表达式', async () => {
    await expectError('int main() { int a = ; return 0; }', 'E_SYNTAX');
  });
});
