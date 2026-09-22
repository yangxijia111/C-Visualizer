// 轻量 property 测试：随机生成无副作用、无除零、值域安全的 int 表达式，
// 与独立实现的 int32 参考模型（BigInt 精确模拟）对比（SEMANTIC_MODEL §9）
import { describe, expect, it } from 'vitest';
import { runSrc } from '../helpers';

/** 确定性 PRNG（mulberry32）：种子固定保证可复现 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 表达式生成器输出 */
interface Generated {
  /** C 源码表达式（引用变量 v0/v1/v2） */
  text: string;
  /** 参考模型求值（变量绑定后） */
  eval: (v: number[]) => number;
}

type Op = '+' | '-' | '*' | '/' | '%';

/** int32 参考运算（BigInt 精确环绕） */
function refOp(op: Op, a: number, b: number): number {
  const wrap = (n: number): number => {
    const big = BigInt(Math.trunc(n));
    const mod = ((big % 4294967296n) + 4294967296n) % 4294967296n;
    const as32 = mod >= 2147483648n ? mod - 4294967296n : mod;
    return Number(as32);
  };
  switch (op) {
    case '+': return wrap(a + b);
    case '-': return wrap(a - b);
    case '*': return wrap(a * b);
    case '/': return b === 0 ? 0 : wrap(Math.trunc(a / b)); // C 截断除
    case '%': return b === 0 ? 0 : wrap(a - Math.trunc(a / b) * b); // 符号随被除数
  }
}

/** 生成随机表达式（深度受限，字面量 [-40,40]，除数/模数为非零常量） */
function genExpr(rand: () => number, depth: number): Generated {
  if (depth <= 0 || rand() < 0.3) {
    if (rand() < 0.4) {
      const idx = Math.floor(rand() * 3);
      return { text: `v${idx}`, eval: (v) => v[idx] };
    }
    const lit = Math.floor(rand() * 81) - 40;
    return { text: `${lit}`, eval: () => lit };
  }
  const op: Op = (['+', '-', '*', '/', '%'] as Op[])[Math.floor(rand() * 5)];
  const left = genExpr(rand, depth - 1);
  if (op === '/' || op === '%') {
    // 除数用非零常量（避免除零；常量保证参考模型与解释器同语义）
    let d = Math.floor(rand() * 9) - 4;
    if (d === 0) d = 3;
    return {
      text: `(${left.text} ${op} ${Math.abs(d)})`,
      eval: (v) => refOp(op, left.eval(v), Math.abs(d)),
    };
  }
  const right = genExpr(rand, depth - 1);
  return {
    text: `(${left.text} ${op} ${right.text})`,
    eval: (v) => refOp(op, left.eval(v), right.eval(v)),
  };
}

describe('随机 int 表达式 property 测试（vs 独立 int32 参考模型）', () => {
  it('300 个随机表达式结果一致（种子固定可复现）', async () => {
    const rand = mulberry32(20260922);
    const cases: { text: string; vars: number[]; expected: number }[] = [];
    for (let chunkStart = 0; chunkStart < 300; chunkStart += 10) {
      // 每个 chunk 一组变量绑定，chunk 内全部表达式共用（期望值也按它计算）
      const vars = [0, 1, 2].map(() => Math.floor(rand() * 61) - 30);
      for (let k = 0; k < 10; k++) {
        const expr = genExpr(rand, 3 + Math.floor(rand() * 2));
        cases.push({ text: expr.text, vars, expected: expr.eval(vars) });
      }
    }

    // 每 10 个表达式合成一个程序（减少 wasm 编译/执行次数）
    for (let group = 0; group < cases.length; group += 10) {
      const chunk = cases.slice(group, group + 10);
      const prog = `
        int main() {
            int v0 = ${chunk[0].vars[0]};
            int v1 = ${chunk[0].vars[1]};
            int v2 = ${chunk[0].vars[2]};
            ${chunk.map((c) => `printf("%d\\n", ${c.text});`).join('\n            ')}
            return 0;
        }
      `;
      const r = await runSrc(prog);
      expect(r.ok, `第 ${group} 组应正常结束`).toBe(true);
      const gotLines = r.output.split('\n').filter((x) => x !== '');
      expect(gotLines.length).toBe(chunk.length);
      chunk.forEach((c, i) => {
        expect(Number(gotLines[i]), `表达式 ${c.text}（v=${c.vars}）`).toBe(c.expected);
      });
    }
  }, 30000);

  it('样本覆盖环绕与截断除法（参考模型自身正确性抽查）', () => {
    // 2147483647 + 1 → -2147483648（环绕）
    expect(refOp('+', 2147483647, 1)).toBe(-2147483648);
    // -2147483648 - 1 → 2147483647
    expect(refOp('-', -2147483648, 1)).toBe(2147483647);
    // 截断除与取模符号
    expect(refOp('/', -7, 2)).toBe(-3);
    expect(refOp('%', -7, 2)).toBe(-1);
    expect(refOp('/', 7, -2)).toBe(-3);
    expect(refOp('%', 7, -2)).toBe(1);
  });
});
