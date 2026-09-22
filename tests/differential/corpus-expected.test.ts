// 差分语料的本地基准：每个语料程序在本引擎中的输出必须等于手工推演的
// 预期值（与 C 语义一致）。该套件不依赖 gcc，始终运行；
// gcc/clang 存在时另有 diff-gcc.test.ts 做真实编译对比。
import { describe, expect, it } from 'vitest';
import { CORPUS } from './corpus';
import { compileOk, runSrc } from '../helpers';

/** 手工推演的预期输出（按 C 语义逐步计算） */
const EXPECTED: Record<string, string> = {
  'int-arithmetic': '22\n12\n85\n3\n2\n39\n',
  'int-division-negative': '-3\n-1\n-3\n1\n',
  'char-arithmetic': '65\nB\n25\n',
  'float-exact': '1.750000\n1.250000\n0.375000\n6.000000\n',
  comparisons: '1 0 0 1 1 0\n',
  'logical-short-circuit': '0\n1\n1\n1\n1\n',
  'nested-expr': '-18\n8\n8\n',
  incdec: '5\n6\n7\n7\n5\n',
  'while-loop': '55\n',
  'for-loop': '720\n',
  'do-while': '8 4\n',
  'nested-loops-break-continue': '9\n',
  'switch-fallthrough': '10 10 8 8 -1\n',
  'array-sum-max': '30 9\n',
  'array-partial-init': '17\n',
  'array-reverse-write': '16 9 4 1 0 \n',
  globals: '0\n101 102\n0 0 0 0\n',
  'function-args': '234\n2\n',
  'recursion-factorial': '3628800\n',
  'recursion-fib': '610\n',
  'pointer-swap': '8 3\n',
  'pointer-through-array': '10 99 30 41\n',
  'scope-shadowing': '2\n12\n1\n',
  'implicit-conversions': '2\n3.000000\nB\n7\n4.500000\n',
  'goto-constructs': '10\n10\n',
  'compound-assign-chain': '5\n5 5\n',
};

describe('差分语料本地基准（预期输出按 C 语义手工推演）', () => {
  it('每个语料都有预期输出条目', () => {
    for (const c of CORPUS) {
      expect(EXPECTED[c.id], `语料 ${c.id} 缺少预期输出`).toBeDefined();
    }
    expect(Object.keys(EXPECTED).length).toBe(CORPUS.length);
  });

  for (const c of CORPUS) {
    it(`${c.id}（${c.focus}）输出符合 C 语义`, async () => {
      await compileOk(c.code);
      const r = await runSrc(c.code);
      expect(r.ok, `${c.id} 应正常结束`).toBe(true);
      expect(r.output).toBe(EXPECTED[c.id]);
    });
  }
});
