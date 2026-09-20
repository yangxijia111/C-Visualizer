// 错误类型体系：编译期错误（CompileError）与运行期错误码
// 详见 docs/ERROR_SPEC.md

/** 错误码：编译期（前 7 个）与运行期 */
export type ErrorCode =
  // 编译期
  | 'E_SYNTAX'      // 语法错误（tree-sitter ERROR / MISSING）
  | 'E_UNSUPPORTED' // 不支持的 C 特性（合法 C 但超出教学子集）
  | 'E_TYPE'        // 类型错误
  | 'E_LABEL'       // 标签重复 / goto 目标不存在
  | 'E_CONST'       // case 标签 / 数组长度 / 全局初始化需要常量表达式
  | 'E_NO_MAIN'     // 缺少 main / 多个 main / main 签名不合法
  | 'E_DECL'        // 声明错误（重定义、数组初始化超长等）
  // 运行期
  | 'E_DIV_ZERO' | 'E_UNINIT_READ' | 'E_UNDEF_VAR' | 'E_NULL_DEREF' | 'E_BAD_DEREF'
  | 'E_ARRAY_BOUND' | 'E_STACK_DEPTH' | 'E_NO_RETURN' | 'E_PRINTF' | 'E_INTERNAL';

/** 编译期错误（解析 + 语义检查阶段） */
export interface CompileError {
  phase: 'parse' | 'check';
  code: ErrorCode;
  line: number;
  column: number;
  endLine?: number;
  endColumn?: number;
  message: string; // 中文主消息
  hint?: string;   // 替代建议（E_UNSUPPORTED 必填）
}

/** 转换 / 检查过程中内部抛出的错误载体 */
export class ConvertError extends Error {
  constructor(public readonly err: CompileError) {
    super(err.message);
  }
}

/** 构造编译错误的便捷函数 */
export function makeError(
  code: ErrorCode,
  phase: 'parse' | 'check',
  loc: { line: number; column: number; endLine?: number; endColumn?: number },
  message: string,
  hint?: string,
): CompileError {
  return { phase, code, line: loc.line, column: loc.column, endLine: loc.endLine, endColumn: loc.endColumn, message, hint };
}

/** 引擎内部防御性错误（正常不应出现） */
export function internalError(source: unknown, fallbackLoc = { line: 1, column: 1 }): CompileError {
  const detail = source instanceof Error ? source.message : String(source);
  return makeError('E_INTERNAL', 'check', fallbackLoc, `内部错误：${detail}`);
}

/** 运行期错误码（ExecutionStep.errorCode 用） */
export type RunErrorCode = Extract<
  ErrorCode,
  'E_DIV_ZERO' | 'E_UNINIT_READ' | 'E_UNDEF_VAR' | 'E_NULL_DEREF' | 'E_BAD_DEREF'
  | 'E_ARRAY_BOUND' | 'E_STACK_DEPTH' | 'E_NO_RETURN' | 'E_PRINTF' | 'E_INTERNAL'
>;
