// C 类型系统（教学子集）：标量 / void / 一层指针 / 一维数组
// 详见 docs/AST_SPEC.md §1

/** 标量类型名 */
export type ScalarKind = 'int' | 'char' | 'float' | 'double';

/** 标量类型（可作数组元素、指针目标） */
export type ScalarCType = ScalarKind | { kind: 'pointer'; pointee: ScalarKind };

/** 全部类型：标量用字符串表示，复合类型用对象 */
export type CType =
  | ScalarKind
  | 'void'
  | { kind: 'pointer'; pointee: ScalarKind }
  | { kind: 'array'; elem: ScalarKind; length: number };

export function isScalar(t: CType | 'string'): t is ScalarKind | { kind: 'pointer'; pointee: ScalarKind } {
  return t === 'int' || t === 'char' || t === 'float' || t === 'double' || (typeof t === 'object' && t.kind === 'pointer');
}

export function isNumeric(t: CType | 'string'): t is ScalarKind {
  return t === 'int' || t === 'char' || t === 'float' || t === 'double';
}

export function isInteger(t: CType | 'string'): t is 'int' | 'char' {
  return t === 'int' || t === 'char';
}

export function isPointer(t: CType | 'string'): t is { kind: 'pointer'; pointee: ScalarKind } {
  return typeof t === 'object' && t !== null && t.kind === 'pointer';
}

export function isArray(t: CType | 'string'): t is { kind: 'array'; elem: ScalarKind; length: number } {
  return typeof t === 'object' && t !== null && t.kind === 'array';
}

/** 类型的中文展示名（UI 用）；接受检查器的扩展 'string' 类型 */
export function typeToString(t: CType | 'string'): string {
  if (t === 'string') return '字符串';
  if (typeof t === 'string') return t;
  if (t.kind === 'pointer') return `${t.pointee} *`;
  return `${t.elem}[${t.length}]`;
}
