// 顶层 API：compile（解析 + 检查）
// 执行入口 run() 在解释器完成后由 interpreter/index.ts 提供
// 详见 docs/EXECUTION_ENGINE.md §1

import type { Node as SyntaxNode } from 'web-tree-sitter';
import type { Program } from './ast';
import { getParser } from './cst';
import { convertProgram } from './convert';
import { checkProgram } from './check';
import { makeError, ConvertError, internalError } from './errors';
import type { CompileError } from './errors';

export type CompileResult =
  | { ok: true; program: Program }
  | { ok: false; errors: CompileError[] };

/** 编译入口：源码 → Program 或结构化错误列表（绝不抛异常） */
export async function compile(source: string): Promise<CompileResult> {
  try {
    const parser = await getParser();
    const tree = parser.parse(source);
    if (!tree) return { ok: false, errors: [internalError('解析器返回空结果')] };
    if (tree.rootNode.hasError) {
      const err = findSyntaxError(tree.rootNode);
      return { ok: false, errors: [err] };
    }
    let program: Program;
    try {
      program = convertProgram(tree.rootNode);
    } catch (e) {
      if (e instanceof ConvertError) return { ok: false, errors: [e.err] };
      return { ok: false, errors: [internalError(e)] };
    }
    const checkErrors = checkProgram(program);
    if (checkErrors.length > 0) return { ok: false, errors: checkErrors };
    return { ok: true, program };
  } catch (e) {
    return { ok: false, errors: [internalError(e)] };
  }
}

/** 深度优先收集最早出现的语法错误节点，转成中文提示 */
function findSyntaxError(root: SyntaxNode): CompileError {
  let best: { node: SyntaxNode } | null = null;
  const visit = (n: SyntaxNode): void => {
    if (n.type === 'ERROR' || n.isMissing || n.type === 'MISSING') {
      if (!best || n.startPosition.row < best.node.startPosition.row
        || (n.startPosition.row === best.node.startPosition.row && n.startPosition.column <= best.node.startPosition.column)) {
        best = { node: n };
      }
    }
    for (let i = 0; i < n.childCount; i++) {
      const c = n.child(i);
      if (c) visit(c);
    }
  };
  visit(root);
  if (!best) {
    return makeError('E_SYNTAX', 'parse', { line: 1, column: 1 }, '源码存在语法错误');
  }
  const { node } = best as { node: SyntaxNode };
  const s = node.startPosition;
  const loc = { line: s.row + 1, column: s.column + 1 };
  if (node.isMissing || node.type === 'MISSING') {
    const t = node.text || node.type;
    const nameMap: Record<string, string> = {
      ';': '缺少分号 ;',
      '}': '缺少右花括号 }',
      ')': '缺少右括号 )',
      '(': '缺少左括号 (',
      '{': '缺少左花括号 {',
      identifier: '这里缺少一个名称或表达式',
      number: '这里缺少一个数字',
      expression: '这里缺少一个表达式',
      'expression_statement': '这里缺少一条语句',
    };
    return makeError('E_SYNTAX', 'parse', loc, nameMap[t] ?? `这里缺少「${t}」`);
  }
  return makeError('E_SYNTAX', 'parse', loc, '这里存在无法识别的语法', `问题片段：「${node.text.slice(0, 30)}」`);
}

// ============ 执行入口 ============

import { Interpreter } from './interpreter/index';
import type { RunOptions } from './interpreter/index';
import type { RunResult } from './steps';

/** 执行已编译的程序，产出全部步骤（同步；受步数/深度/墙钟保护） */
export function runProgram(program: Program, source: string, options?: RunOptions): RunResult {
  try {
    const interp = new Interpreter(program, source, options);
    return interp.run();
  } catch (e) {
    // 兜底：解释器意外异常也绝不抛出
    const msg = e instanceof Error ? e.message : String(e);
    return {
      source,
      initialSnapshot: { scopes: [], cells: {}, callStack: [], nextAddress: 1, output: '' },
      steps: [],
      status: 'runtime-error',
      output: `内部错误：${msg}`,
    };
  }
}
