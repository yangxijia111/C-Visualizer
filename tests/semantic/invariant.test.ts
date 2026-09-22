// 不变量测试（SEMANTIC_MODEL §7）：
// 1. compile().ok === true 的程序集执行后不得出现任何 E_INTERNAL 步骤
//    （E_INTERNAL 只应表示解释器自身缺陷）
// 2. Checker 与 Interpreter 的转换规则一致（赋值/初始化/参数/返回/数组元素同规则）
import { describe, expect, it } from 'vitest';
import { compile, runProgram } from '../../src/core/run';
import { EXAMPLES } from '../../src/examples/index';
import { CORPUS } from '../differential/corpus';
import { runSrc } from '../helpers';
import { setCstSourcesLoader } from '../../src/core/cst';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
setCstSourcesLoader(async () => ({ grammar: require.resolve('tree-sitter-c/tree-sitter-c.wasm') }));

/** 编译并执行，断言无 E_INTERNAL 步骤；返回运行结果 */
async function runAndAssertNoInternal(src: string, label: string) {
  const compiled = await compile(src);
  if (!compiled.ok) {
    throw new Error(`不变量扫描的程序必须能编译（${label}）: ${compiled.errors[0]?.message}`);
  }
  const result = runProgram(compiled.program, src);
  for (const step of result.steps) {
    expect(
      step.errorCode,
      `${label} 出现 E_INTERNAL（第 ${step.line} 行，说明 = ${step.description}）`,
    ).not.toBe('E_INTERNAL');
  }
  return result;
}

describe('E_INTERNAL 不变量：有效程序执行不出现内部错误', () => {
  it('内置示例库 21 个程序全部无 E_INTERNAL', async () => {
    for (const ex of EXAMPLES) {
      await runAndAssertNoInternal(ex.code, `示例 ${ex.id}`);
    }
  });

  it('差分语料 26 个程序全部无 E_INTERNAL', async () => {
    for (const c of CORPUS) {
      await runAndAssertNoInternal(c.code, `语料 ${c.id}`);
    }
  });

  it('边界场景程序（作用域/循环/递归/指针/switch/goto 组合）无 E_INTERNAL', async () => {
    const programs = [
      // 深层块嵌套 + 遮蔽
      `int main() {
          int x = 1;
          { int x = 2; { int x = 3; { double x = 4.5; x = x + 1; } x++; } x--; }
          return x;
      }`,
      // 嵌套循环 + switch + break/continue
      `int main() {
          for (int i = 0; i < 4; i++) {
              switch (i % 3) {
                  case 0: continue;
                  case 1: break;
                  default: ;
              }
          }
          return 0;
      }`,
      // 指针写入数组元素 + 数组遍历（子集内：& 与 *，无指针算术）
      `int a[5];
      void setAt(int *dst, int v) { *dst = v; }
      int main() {
          for (int i = 0; i < 5; i++) setAt(&a[i], i * i);
          int s = 0;
          for (int i = 0; i < 5; i++) s += a[i];
          return s;
      }`,
      // goto 前向跳过声明 + 后向回跳重新初始化
      `int main() {
          int i = 0;
          int sum = 0;
      LOOP:
          int inc = 2;
          sum += inc;
          i++;
          if (i < 3) goto LOOP;
          return sum;
      }`,
      // do-while + 复合赋值 + 短路
      `int main() {
          int i = 0;
          do { i += 1; } while (i < 5 && i != 3);
          return i;
      }`,
      // char 混合运算与转换
      `int main() {
          char c = 'a';
          int x = c + 2;
          char d = x;
          double f = d;
          return x;
      }`,
      // 全局数组 + 局部遮蔽 + 函数修改全局
      `int g[3];
      int acc;
      void add(int i, int v) { g[i] = v; acc += v; }
      int main() {
          int acc = 0;
          add(0, 5); add(1, 6); add(2, 7);
          { int acc = 99; acc--; }
          return acc + g[0] + g[1] + g[2];
      }`,
    ];
    // 全部为真实合法程序（子集内）
    const valid = programs;
    for (let k = 0; k < valid.length; k++) {
      await runAndAssertNoInternal(valid[k], `边界程序 #${k}`);
    }
  });

  it('运行时错误场景使用明确错误码而非 E_INTERNAL', async () => {
    const errorPrograms = [
      { src: 'int main() { int x; return x; }', code: 'E_UNINIT_READ' },
      { src: 'int main() { int a[3] = {1,2,3}; return a[5]; }', code: 'E_ARRAY_BOUND' },
      { src: 'int main() { return 1 / 0; }', code: 'E_DIV_ZERO' },
      { src: 'int main() { return 5 % 0; }', code: 'E_DIV_ZERO' },
      { src: 'int f() { int x = 1; } int main() { return f(); }', code: 'E_NO_RETURN' },
      { src: 'int main() { int *p = 0; return *p; }', code: 'E_NULL_DEREF' },
    ];
    for (const p of errorPrograms) {
      const compiled = await compile(p.src);
      if (!compiled.ok) throw new Error(`应能编译: ${p.src}`);
      const result = runProgram(compiled.program, p.src);
      const last = result.steps[result.steps.length - 1];
      expect(last.errorCode, `${p.src} 应报 ${p.code}`).toBe(p.code);
    }
  });
});

describe('Checker 与 Interpreter 转换一致性', () => {
  it('同一条 double→int 转换在五个边界上结果一致', async () => {
    const r = await runSrc(`
      int viaParam;
      int viaReturn;
      int passThrough(int v) { return v; }
      void setParam(int v) { viaParam = v; }
      int main() {
          double src = 7.9;
          int viaInit = src;
          int viaAssign;
          int arr[1];
          viaAssign = src;
          arr[0] = src;
          setParam(src);
          viaReturn = passThrough(src);
          printf("%d %d %d %d %d", viaInit, viaAssign, arr[0], viaParam, viaReturn);
          return 0;
      }
    `);
    expect(r.ok).toBe(true);
    expect(r.output).toBe('7 7 7 7 7');
  });

  it('int→double 转换在各边界类型一致（运行时类型为 double）', async () => {
    const r = await runSrc(`
      double viaReturn;
      double widen(int v) { return v; }
      int main() {
          double viaInit = 3;
          viaReturn = widen(3);
          printf("%f %f", viaInit, viaReturn);
          return 0;
      }
    `);
    expect(r.ok).toBe(true);
    expect(r.output).toBe('3.000000 3.000000');
  });

  it('int→char 转换（低 8 位）在各边界一致', async () => {
    const r = await runSrc(`
      char viaReturn;
      char shrink(int v) { return v; }
      int main() {
          char viaInit = 321;
          char viaAssign;
          char arr[1];
          viaAssign = 321;
          arr[0] = 321;
          viaReturn = shrink(321);
          printf("%d %d %d %d", viaInit, viaAssign, arr[0], viaReturn);
          return 0;
      }
    `);
    expect(r.ok).toBe(true);
    // 321 & 0xff = 65
    expect(r.output).toBe('65 65 65 65');
  });
});
