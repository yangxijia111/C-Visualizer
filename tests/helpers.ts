// 测试工具：Node 环境下的 wasm 加载 + 常用断言辅助
import { createRequire } from 'node:module';
import { setCstSourcesLoader } from '../src/core/cst';
import { compile } from '../src/core/run';
import type { Program } from '../src/core/ast';
import type { CompileError } from '../src/core/errors';

const require = createRequire(import.meta.url);
setCstSourcesLoader(async () => ({ grammar: require.resolve('tree-sitter-c/tree-sitter-c.wasm') }));

/** 编译并期望成功，失败时输出错误详情 */
export async function compileOk(src: string): Promise<Program> {
  const r = await compile(src);
  if (!r.ok) {
    const detail = r.errors.map((e) => `  [${e.code}] 第${e.line}行第${e.column}列：${e.message}${e.hint ? `（${e.hint}）` : ''}`).join('\n');
    throw new Error(`编译应当成功但失败：\n${detail}\n源码：\n${src}`);
  }
  return r.program;
}

/** 编译并期望失败，返回错误列表 */
export async function compileErr(src: string): Promise<CompileError[]> {
  const r = await compile(src);
  if (r.ok) throw new Error(`编译应当失败但成功。\n源码：\n${src}`);
  return r.errors;
}

/** 编译并期望恰好一条指定错误码的错误 */
export async function expectError(src: string, code: CompileError['code'], messagePart?: string): Promise<CompileError> {
  const errors = await compileErr(src);
  const found = errors.find((e) => e.code === code && (!messagePart || e.message.includes(messagePart)));
  if (!found) {
    throw new Error(`期望错误 ${code}${messagePart ? `（含「${messagePart}」）` : ''}，实际：${JSON.stringify(errors, null, 2)}\n源码：\n${src}`);
  }
  return found;
}
