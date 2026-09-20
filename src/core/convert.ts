// CST → 教学 AST 转换器
// 详见 docs/PARSER_DESIGN.md 与 docs/AST_SPEC.md §5
// 设计要点：
//  - tree-sitter 位置为 0 基，本层统一转 1 基并附原文切片 text
//  - 遇到教学子集之外的合法 C 节点 → 抛 ConvertError(E_UNSUPPORTED)
//  - 声明符链（pointer/array/函数）按 C 规则由内向外组合类型

import type { Node as N } from 'web-tree-sitter';
import { ConvertError, makeError } from './errors';
import type {
  Expr, Stmt, Program, FunctionDef, Param, VarDeclarator, CaseSection, Pos,
  VarDeclStmt, ExprStmt,
} from './ast';
import type { CType, ScalarCType } from './types';

// ---------- 基础工具 ----------

function posOf(n: N): Pos {
  const s = n.startPosition;
  const e = n.endPosition;
  return { line: s.row + 1, column: s.column + 1, endLine: e.row + 1, endColumn: e.column + 1 };
}

/** 取字段节点；fields: {x} 中字段名可能为 null（匿名子节点） */
function fld(n: N, name: string): N | null {
  return n.childForFieldName(name);
}

/** tree-sitter 节点同一性判断：namedChildren 每次返回新包装对象，必须用 equals */
function sameNode(a: N, b: N): boolean {
  return a.equals(b);
}

function convError(code: 'E_UNSUPPORTED' | 'E_SYNTAX' | 'E_DECL' | 'E_TYPE' | 'E_CONST' | 'E_LABEL', n: N, message: string, hint?: string): ConvertError {
  return new ConvertError(makeError(code, 'check', posOf(n), message, hint));
}

// ---------- 字面量解析 ----------

const CHAR_ESCAPES: Record<string, number> = {
  n: 10, t: 9, r: 13, '0': 0, '\\': 92, "'": 39, '"': 34,
  a: 7, b: 8, f: 12, v: 11, '?': 63,
};

/** 解析字符字面量文本（形如 'A'、'\\n'）为字符码 */
function parseCharLiteral(raw: string, n: N): number {
  const inner = raw.slice(1, -1);
  if (inner.startsWith('\\')) {
    const e = inner.slice(1);
    if (e in CHAR_ESCAPES) return CHAR_ESCAPES[e];
    if (e.startsWith('x')) {
      const v = parseInt(e.slice(1), 16);
      if (Number.isNaN(v)) throw convError('E_UNSUPPORTED', n, `不支持的字符转义：${raw}`);
      return v;
    }
    if (/^[0-7]+$/.test(e)) return parseInt(e, 8);
    throw convError('E_UNSUPPORTED', n, `不支持的字符转义：${raw}`);
  }
  if (inner.length !== 1) {
    throw convError('E_UNSUPPORTED', n, `不支持多字符字面量：${raw}`, '请使用单引号括住单个字符，例如 \'A\'');
  }
  return inner.codePointAt(0)!;
}

/** 解析数字字面量（十/十六/八进制、浮点、忽略 u/U/l/L/f/F 后缀） */
function parseNumberLiteral(raw: string): { isFloat: boolean; value: number } {
  // 十六进制只允许 u/U/l/L 后缀（f/F 是数字本身的一部分）
  if (/^0[xX]/.test(raw)) {
    const hex = raw.replace(/[uUlL]+$/u, '');
    return { isFloat: false, value: parseInt(hex.slice(2), 16) };
  }
  const s = raw.replace(/[uUlLfF]+$/u, '');
  if (/^0[0-7]+$/.test(s)) return { isFloat: false, value: parseInt(s.slice(1), 8) };
  if (/[.eE]/.test(s)) return { isFloat: true, value: parseFloat(s) };
  return { isFloat: false, value: parseInt(s, 10) };
}

/** 解析字符串字面量文本（含转义） */
function parseStringLiteral(raw: string, n: N): string {
  const inner = raw.slice(1, -1);
  let out = '';
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i];
    if (c !== '\\') {
      out += c;
      continue;
    }
    const e = inner[++i];
    if (e === undefined) throw convError('E_UNSUPPORTED', n, '字符串转义不完整');
    if (e === 'x') {
      const m = /^[0-9a-fA-F]+/.exec(inner.slice(i + 1));
      if (!m) throw convError('E_UNSUPPORTED', n, '字符串转义不完整');
      out += String.fromCharCode(parseInt(m[0], 16));
      i += m[0].length;
      continue;
    }
    const known: Record<string, string> = {
      n: '\n', t: '\t', r: '\r', '0': '\0', '\\': '\\', "'": "'", '"': '"',
      a: '\x07', b: '\b', f: '\f', v: '\v', '?': '?',
    };
    if (e in known) out += known[e];
    else throw convError('E_UNSUPPORTED', n, `不支持的字符串转义：\\${e}`);
  }
  return out;
}

// ---------- 常量表达式折叠（case 标签 / 数组长度 / 全局初始化） ----------

/** 常量数值折叠：支持整型/浮点字面量与四则运算（全局初始化用） */
export function evalConstNumber(e: Expr): number | null {
  switch (e.kind) {
    case 'int-literal': return e.value;
    case 'float-literal': return e.value;
    case 'char-literal': return e.code;
    case 'unary':
      if (e.op === '-' ) {
        const v = evalConstNumber(e.operand);
        return v === null ? null : -v;
      }
      if (e.op === '+') return evalConstNumber(e.operand);
      return null;
    case 'binary': {
      const l = evalConstNumber(e.left);
      const r = evalConstNumber(e.right);
      if (l === null || r === null) return null;
      switch (e.op) {
        case '+': return l + r;
        case '-': return l - r;
        case '*': return l * r;
        case '/': return r === 0 ? null : l / r;
        case '%': return r === 0 || !Number.isInteger(l) || !Number.isInteger(r) ? null : l - Math.trunc(l / r) * r;
        default: return null;
      }
    }
    default: return null;
  }
}

/** 常量整型折叠（case 标签 / 数组长度用）：结果必须为整数 */
export function evalConstInt(e: Expr): number | null {
  const n = evalConstNumber(e);
  return n !== null && Number.isInteger(n) ? n : null;
}

// ---------- 类型解析 ----------

/** 解析基础类型节点（primitive_type / struct 等） */
function parseBaseType(n: N): CType {
  if (n.type === 'primitive_type') {
    const t = n.text;
    if (t === 'int' || t === 'char' || t === 'float' || t === 'double' || t === 'void') return t;
    // unsigned/long 等多词基础类型：primitive_type text 形如 "unsigned int"
    throw convError('E_UNSUPPORTED', n, `v1.0 仅支持 int / char / float / double，不支持「${n.text}」`, '请使用 int 或 double 替代');
  }
  if (n.type === 'struct_specifier') {
    throw convError('E_UNSUPPORTED', n, 'v1.0 不支持 struct（自定义类型）', '请使用独立变量或数组替代');
  }
  if (n.type === 'enum_specifier') {
    throw convError('E_UNSUPPORTED', n, 'v1.0 不支持 enum（枚举）', '请使用 int 常量替代');
  }
  if (n.type === 'union_specifier') {
    throw convError('E_UNSUPPORTED', n, 'v1.0 不支持 union（联合）');
  }
  if (n.type === 'type_identifier') {
    throw convError('E_UNSUPPORTED', n, `v1.0 不支持自定义类型（typedef）：${n.text}`);
  }
  if (n.type === 'sized_type_specifier') {
    throw convError('E_UNSUPPORTED', n, `v1.0 不支持「${n.text}」`, '请使用 int 或 double 替代');
  }
  throw convError('E_UNSUPPORTED', n, `v1.0 不支持该类型写法：${n.text}`);
}

/**
 * 声明符类型组装（自内向外）：
 *  - pointer_declarator：先把 base 包成指针再递归内层（int *p → p: int*）
 *  - array_declarator：先递归内层得到元素类型，再包数组（int *a[3] → 元素是 int*）
 *  - 限制：一层指针、一维数组
 */
function applyDeclaratorToType(base: CType, declarator: N): { name: string; type: CType } {
  const kind = declarator.type;
  if (kind === 'identifier') {
    if (base === 'void') throw convError('E_TYPE', declarator, '变量类型不能是 void');
    return { name: declarator.text, type: base };
  }
  if (kind === 'pointer_declarator') {
    if (typeof base === 'object' && base.kind === 'pointer') {
      throw convError('E_UNSUPPORTED', declarator, 'v1.0 仅支持一层指针，不支持二级指针（int **）');
    }
    if (typeof base === 'object' && base.kind === 'array') {
      throw convError('E_UNSUPPORTED', declarator, 'v1.0 不支持指针数组（int *a[3]）');
    }
    if (base === 'void') {
      throw convError('E_UNSUPPORTED', declarator, 'v1.0 不支持 void* 指针', '请使用具体类型，如 int *p');
    }
    const inner = fld(declarator, 'declarator');
    if (!inner) throw convError('E_SYNTAX', declarator, '无法解析的指针声明');
    return applyDeclaratorToType({ kind: 'pointer', pointee: base }, inner);
  }
  if (kind === 'array_declarator') {
    const inner = fld(declarator, 'declarator');
    const sizeNode = fld(declarator, 'size');
    if (!inner) throw convError('E_SYNTAX', declarator, '无法解析的数组声明');
    if (!sizeNode) throw convError('E_UNSUPPORTED', declarator, 'v1.0 不支持不定长数组或数组参数', '数组长度必须是常量，例如 int a[5]');
    const len = evalConstInt(convertExpr(sizeNode));
    if (len === null) throw convError('E_CONST', declarator, '数组长度必须是常量表达式', '例如 int a[5]');
    if (!Number.isInteger(len) || len < 1 || len > 1024) {
      throw convError('E_CONST', declarator, `数组长度不合法：${len}（应为 1～1024）`);
    }
    const innerResult = applyDeclaratorToType(base, inner);
    const elem = innerResult.type;
    if (typeof elem === 'object' && elem.kind === 'pointer') {
      throw convError('E_UNSUPPORTED', declarator, 'v1.0 不支持指针数组（int *a[3]）', '指针只能单独声明');
    }
    if (typeof elem === 'object' && elem.kind === 'array') {
      throw convError('E_UNSUPPORTED', declarator, 'v1.0 仅支持一维数组，不支持二维/多维数组');
    }
    if (elem === 'void') throw convError('E_TYPE', declarator, '数组元素类型不能是 void');
    return { name: innerResult.name, type: { kind: 'array', elem, length: len } };
  }
  if (kind === 'function_declarator') {
    throw convError('E_UNSUPPORTED', declarator, 'v1.0 不支持函数指针');
  }
  if (kind === 'parenthesized_declarator') {
    // int (*p)[3] 等复杂声明
    throw convError('E_UNSUPPORTED', declarator, 'v1.0 不支持带括号的复杂声明（函数指针/数组指针）');
  }
  throw convError('E_UNSUPPORTED', declarator, `v1.0 不支持的声明符写法：${declarator.type}`);
}

// ---------- 表达式 ----------

const BINARY_OPS = new Set(['+', '-', '*', '/', '%', '==', '!=', '>', '<', '>=', '<=', '&&', '||', '&', '|', '^', '<<', '>>']);
const ASSIGN_OPS = new Set(['=', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '<<=', '>>=']);

export function convertExpr(n: N): Expr {
  const p = posOf(n);
  const base = { ...p, text: n.text };
  switch (n.type) {
    case 'number_literal': {
      const { isFloat, value } = parseNumberLiteral(n.text);
      return isFloat ? { ...base, kind: 'float-literal', value } : { ...base, kind: 'int-literal', value };
    }
    case 'char_literal':
      return { ...base, kind: 'char-literal', code: parseCharLiteral(n.text, n) };
    case 'string_literal':
      return { ...base, kind: 'string-literal', value: parseStringLiteral(n.text, n) };
    case 'identifier': {
      if (n.text === 'true' || n.text === 'false') {
        throw convError('E_UNSUPPORTED', n, 'v1.0 不支持 stdbool（true/false）', '请使用 1 和 0 表示真假');
      }
      return { ...base, kind: 'identifier', name: n.text };
    }
    case 'null':
      // NULL 常量在 tree-sitter-c 中是独立的 null 节点，折叠为空指针（int 0 语义）
      return { ...base, kind: 'int-literal', value: 0 };
    case 'parenthesized_expression': {
      const inner = n.namedChildren[0];
      if (!inner) throw convError('E_SYNTAX', n, '括号内缺少表达式');
      return convertExpr(inner);
    }
    case 'binary_expression': {
      const opText = fld(n, 'operator')?.text ?? '';
      if (!BINARY_OPS.has(opText)) {
        throw convError('E_UNSUPPORTED', n, `v1.0 不支持运算符「${opText}」`, opText === ',' ? '不支持逗号表达式' : undefined);
      }
      if (['&', '|', '^', '<<', '>>'].includes(opText)) {
        throw convError('E_UNSUPPORTED', n, `v1.0 不支持位运算「${opText}」`, '建议：使用算术运算替代演示');
      }
      const left = fld(n, 'left');
      const right = fld(n, 'right');
      if (!left || !right) throw convError('E_SYNTAX', n, '无法解析的二元表达式');
      return {
        ...base, kind: 'binary', op: opText as '+' | '-' | '*' | '/' | '%' | '==' | '!=' | '>' | '<' | '>=' | '<=' | '&&' | '||',
        left: convertExpr(left), right: convertExpr(right),
      };
    }
    case 'unary_expression': {
      const opText = fld(n, 'operator')?.text ?? '';
      const arg = fld(n, 'argument');
      if (!arg) throw convError('E_SYNTAX', n, '无法解析的一元表达式');
      const operand = convertExpr(arg);
      if (opText === '-' || opText === '+') return { ...base, kind: 'unary', op: opText, operand };
      if (opText === '!') return { ...base, kind: 'unary', op: '!', operand };
      throw convError('E_UNSUPPORTED', n, `v1.0 不支持运算符「${opText}」`);
    }
    case 'update_expression': {
      const opText = fld(n, 'operator')?.text as '++' | '--' | undefined;
      const arg = fld(n, 'argument');
      if (!opText || !arg) throw convError('E_SYNTAX', n, '无法解析的自增/自减表达式');
      const target = convertExpr(arg);
      // 前缀还是后缀：operator 是否为第一个孩子
      const isPrefix = n.child(0)?.text === opText;
      return isPrefix
        ? { ...base, kind: 'pre-incdec', op: opText, target }
        : { ...base, kind: 'post-incdec', op: opText, target };
    }
    case 'assignment_expression': {
      const opText = fld(n, 'operator')?.text ?? '';
      if (!ASSIGN_OPS.has(opText)) {
        throw convError('E_UNSUPPORTED', n, `v1.0 不支持赋值运算符「${opText}」`);
      }
      if (['&=', '|=', '^=', '<<=', '>>='].includes(opText)) {
        throw convError('E_UNSUPPORTED', n, `v1.0 不支持位运算赋值「${opText}」`);
      }
      const left = fld(n, 'left');
      const right = fld(n, 'right');
      if (!left || !right) throw convError('E_SYNTAX', n, '无法解析的赋值表达式');
      return {
        ...base, kind: 'assign', op: opText as '=' | '+=' | '-=' | '*=' | '/=' | '%=',
        target: convertExpr(left), value: convertExpr(right),
      };
    }
    case 'pointer_expression': {
      const opText = fld(n, 'operator')?.text ?? '';
      const arg = fld(n, 'argument');
      if (!arg) throw convError('E_SYNTAX', n, '无法解析的指针表达式');
      const target = convertExpr(arg);
      if (opText === '&') return { ...base, kind: 'addr-of', target };
      if (opText === '*') return { ...base, kind: 'deref', target };
      throw convError('E_UNSUPPORTED', n, `v1.0 不支持指针运算符「${opText}」`);
    }
    case 'subscript_expression': {
      const arr = fld(n, 'argument');
      const idx = fld(n, 'index');
      if (!arr || !idx) throw convError('E_SYNTAX', n, '无法解析的下标表达式');
      if (arr.type !== 'identifier') {
        throw convError('E_UNSUPPORTED', n, 'v1.0 仅支持「数组名[下标]」形式的一维数组访问');
      }
      return { ...base, kind: 'array-access', array: { ...posOf(arr), text: arr.text, kind: 'identifier', name: arr.text }, index: convertExpr(idx) };
    }
    case 'call_expression': {
      const fn = fld(n, 'function');
      const argsNode = fld(n, 'arguments');
      if (!fn || !argsNode) throw convError('E_SYNTAX', n, '无法解析的函数调用');
      if (fn.type !== 'identifier') {
        throw convError('E_UNSUPPORTED', n, 'v1.0 仅支持按名称直接调用函数', '不支持函数指针或成员函数调用');
      }
      const args = argsNode.namedChildren.map(convertExpr);
      return { ...base, kind: 'call', name: fn.text, args };
    }
    case 'comma_expression':
      throw convError('E_UNSUPPORTED', n, 'v1.0 不支持逗号表达式', '请拆分为多条语句');
    case 'conditional_expression':
      throw convError('E_UNSUPPORTED', n, 'v1.0 不支持三目运算符 ?:', '建议：使用 if/else 语句');
    case 'cast_expression':
      throw convError('E_UNSUPPORTED', n, 'v1.0 不支持强制类型转换');
    case 'sizeof_expression':
      throw convError('E_UNSUPPORTED', n, 'v1.0 不支持 sizeof');
    case 'compound_statement_expression':
      throw convError('E_UNSUPPORTED', n, 'v1.0 不支持语句表达式');
    default:
      throw convError('E_UNSUPPORTED', n, `v1.0 不支持该表达式写法：${n.type}`);
  }
}

// ---------- 声明 ----------

/** 解析一条 declaration 语句，返回变量声明语句；纯函数原型声明返回 null */
function convertDeclaration(n: N): Stmt | null {
  const typeNode = fld(n, 'type');
  if (!typeNode) {
    // 可能带存储类说明符（static/const 等）
    const first = n.namedChildren[0];
    if (first?.type === 'storage_class_specifier' || first?.type === 'type_qualifier') {
      throw convError('E_UNSUPPORTED', n, `v1.0 不支持存储类/限定符「${first.text}」`, '请直接使用基础类型声明');
    }
    throw convError('E_SYNTAX', n, '声明缺少类型');
  }
  // 检查是否有 const/static 等限定符（出现在 namedChildren 前部）
  for (const kid of n.namedChildren) {
    if (kid.type === 'type_qualifier') {
      throw convError('E_UNSUPPORTED', kid, `v1.0 不支持类型限定符「${kid.text}」`, '请去掉 const/volatile 等修饰');
    }
    if (kid.type === 'storage_class_specifier') {
      throw convError('E_UNSUPPORTED', kid, `v1.0 不支持存储类说明符「${kid.text}」`);
    }
  }
  const baseType = parseBaseType(typeNode);

  const vars: VarDeclarator[] = [];
  for (const kid of n.namedChildren) {
    if (sameNode(kid, typeNode) || kid.type === 'type_qualifier' || kid.type === 'storage_class_specifier') continue;
    if (kid.type === ';') continue;
    if (kid.type === 'init_declarator') {
      const inner = fld(kid, 'declarator');
      const value = fld(kid, 'value');
      if (!inner) throw convError('E_SYNTAX', kid, '无法解析的声明');
      const { name, type } = applyDeclaratorToType(baseType, inner);
      if (value) {
        if (value.type === 'initializer_list') {
          if (typeof type !== 'object' || type.kind !== 'array') {
            throw convError('E_DECL', kid, '只有数组才能使用初始化列表 {}');
          }
          vars.push({ name, varType: type, initList: value.namedChildren.map(convertExpr) });
        } else if (typeof type === 'object' && type.kind === 'array') {
          throw convError('E_DECL', kid, '数组不能用标量初始化', '请使用初始化列表，如 int a[3] = {1,2,3}');
        } else {
          vars.push({ name, varType: type, init: convertExpr(value) });
        }
      } else {
        vars.push({ name, varType: type });
      }
      continue;
    }
    if (kid.type === 'identifier' || kid.type === 'pointer_declarator' || kid.type === 'array_declarator') {
      const { name, type } = applyDeclaratorToType(baseType, kid);
      vars.push({ name, varType: type });
      continue;
    }
    if (kid.type === 'function_declarator') {
      // 函数原型声明：忽略（教学版不要求先声明后使用）
      continue;
    }
    throw convError('E_UNSUPPORTED', kid, `v1.0 不支持的声明写法：${kid.type}`);
  }
  if (vars.length === 0) return null; // 纯原型声明

  const p = posOf(n);
  return { ...p, text: n.text, kind: 'var-decl', declType: baseType, vars };
}

// ---------- 语句 ----------

export function convertStmt(n: N): Stmt[] {
  const p = posOf(n);
  const base = { ...p, text: n.text };
  switch (n.type) {
    case 'expression_statement': {
      const kids = n.namedChildren;
      if (kids.length === 0) return [{ ...base, kind: 'empty' }];
      if (kids.length > 1) throw convError('E_SYNTAX', n, '一条语句中出现多个表达式', '请拆分为多条语句');
      return [{ ...base, kind: 'expr-stmt', expr: convertExpr(kids[0]) }];
    }
    case 'declaration': {
      const s = convertDeclaration(n);
      return s ? [s] : [];
    }
    case 'compound_statement':
      return [{ ...base, kind: 'block', body: convertBlock(n) }];
    case 'if_statement': {
      const cond = fld(n, 'condition');
      const thenN = fld(n, 'consequence');
      if (!cond || !thenN) throw convError('E_SYNTAX', n, '无法解析的 if 语句');
      const elseClause = fld(n, 'alternative');
      let elseStmt: Stmt | undefined;
      if (elseClause) {
        // alternative 字段是 else_clause，内含真正的语句
        const inner = elseClause.namedChildren[0];
        if (!inner) throw convError('E_SYNTAX', n, 'else 后缺少语句');
        elseStmt = convertStmt(inner)[0];
      }
      const thenStmts = convertStmt(thenN);
      return [{
        ...base, kind: 'if',
        condition: convertExpr(cond),
        then: thenStmts[0],
        else: elseStmt,
      }];
    }
    case 'while_statement': {
      const cond = fld(n, 'condition');
      const body = fld(n, 'body');
      if (!cond || !body) throw convError('E_SYNTAX', n, '无法解析的 while 语句');
      return [{ ...base, kind: 'while', condition: convertExpr(cond), body: convertStmt(body)[0] }];
    }
    case 'do_statement': {
      const body = fld(n, 'body');
      const cond = fld(n, 'condition');
      if (!body || !cond) throw convError('E_SYNTAX', n, '无法解析的 do-while 语句');
      return [{ ...base, kind: 'do-while', body: convertStmt(body)[0], condition: convertExpr(cond) }];
    }
    case 'for_statement': {
      const initN = fld(n, 'initializer');
      const condN = fld(n, 'condition');
      const updN = fld(n, 'update');
      const bodyN = fld(n, 'body');
      let init: Stmt | null = null;
      if (initN) {
        // initializer 形态：declaration / expression_statement / 裸表达式（如 i = 10）
        if (initN.type === 'declaration') {
          const converted = convertDeclaration(initN);
          if (converted) init = converted;
        } else if (initN.type === 'expression_statement') {
          const converted = convertStmt(initN)[0];
          if (converted) init = converted;
        } else {
          const np = posOf(initN);
          init = { ...np, text: initN.text, kind: 'expr-stmt', expr: convertExpr(initN) };
        }
      }
      const condition = condN ? convertExpr(condN) : null;
      const update = updN ? convertExpr(updN) : null;
      if (!bodyN) throw convError('E_SYNTAX', n, 'for 循环缺少循环体');
      return [{
        ...base, kind: 'for',
        init: init as VarDeclStmt | ExprStmt | null,
        condition, update, body: convertStmt(bodyN)[0],
      }];
    }
    case 'switch_statement': {
      const cond = fld(n, 'condition');
      const body = fld(n, 'body');
      if (!cond || !body) throw convError('E_SYNTAX', n, '无法解析的 switch 语句');
      return [{
        ...base, kind: 'switch',
        discriminant: convertExpr(cond),
        cases: convertSwitchBody(body),
      }];
    }
    case 'break_statement':
      return [{ ...base, kind: 'break' }];
    case 'continue_statement':
      return [{ ...base, kind: 'continue' }];
    case 'goto_statement': {
      const label = fld(n, 'label');
      if (!label) throw convError('E_SYNTAX', n, 'goto 缺少标签名');
      return [{ ...base, kind: 'goto', label: label.text }];
    }
    case 'labeled_statement': {
      const labelNode = fld(n, 'label');
      if (!labelNode) throw convError('E_SYNTAX', n, '无法解析的标签');
      const stmtNodes = n.namedChildren.filter((c) => !sameNode(c, labelNode));
      if (stmtNodes.length === 0) {
        throw convError('E_LABEL', n, `标签 ${labelNode.text} 后必须有语句`, '可以使用空语句：label: ;');
      }
      return [{ ...base, kind: 'label', name: labelNode.text, stmt: convertStmt(stmtNodes[0])[0] }];
    }
    case 'return_statement': {
      // tree-sitter-c 的 return_statement 无 value 字段，值表达式是第一个 named child
      const value = n.namedChildren[0];
      return [{ ...base, kind: 'return', value: value ? convertExpr(value) : undefined }];
    }
    case 'case_statement':
      throw convError('E_UNSUPPORTED', n, 'case 只能出现在 switch 体内');
    case 'struct_specifier':
      parseBaseType(n); // 抛出带建议的 E_UNSUPPORTED
      throw convError('E_UNSUPPORTED', n, 'v1.0 不支持 struct');
    case 'enum_specifier':
    case 'union_specifier':
      parseBaseType(n);
      throw convError('E_UNSUPPORTED', n, 'v1.0 不支持该类型');
    case ';':
      return [{ ...base, kind: 'empty' }];
    default:
      throw convError('E_UNSUPPORTED', n, `v1.0 不支持该语句：${n.type}`);
  }
}

/** 转换复合语句体（顶层语句序列；注释节点跳过） */
function convertBlock(n: N): Stmt[] {
  const out: Stmt[] = [];
  for (const kid of n.namedChildren) {
    if (kid.type === 'comment') continue;
    out.push(...convertStmt(kid));
  }
  return out;
}

/** 规整 switch 体：连续 case/default 标签合并为区段，语句归入当前区段 */
function convertSwitchBody(body: N): CaseSection[] {
  const cases: CaseSection[] = [];

  // case_statement 在 compound_statement 内平铺排列（非嵌套）；
  // 连续的 case/default 合并进同一区段（区段尚无语句时追加标签）
  const currentSection = (): CaseSection => cases[cases.length - 1];

  // 处理一个 case_statement：追加/新建区段，并把其内部语句归入当前区段
  const handleCase = (node: N): void => {
    const valueNode = fld(node, 'value');
    const last = currentSection();
    if (last && last.body.length === 0) {
      // 空区段：追加标签（case 2: case 3: 合并；default 与前一 case 合并）
      if (valueNode) last.labels.push({ value: convertExpr(valueNode), isDefault: false });
      else last.labels.push({ isDefault: true });
    } else {
      const section: CaseSection = { labels: [], body: [] };
      if (valueNode) section.labels.push({ value: convertExpr(valueNode), isDefault: false });
      else section.labels.push({ isDefault: true });
      cases.push(section);
    }
    // case_statement 内部的语句（value 之后）归入当前区段
    for (const inner of node.namedChildren) {
      if (valueNode && sameNode(inner, valueNode)) continue;
      if (inner.type === 'case_statement') {
        handleCase(inner); // 防御：某些形态下嵌套
        return;
      }
      currentSection().body.push(...convertStmt(inner));
    }
  };

  for (const kid of body.namedChildren) {
    if (kid.type === 'case_statement') {
      handleCase(kid);
    } else if (cases.length > 0) {
      currentSection().body.push(...convertStmt(kid));
    } else {
      throw convError('E_UNSUPPORTED', kid, 'switch 中第一个 case 之前不允许出现语句（不可达）', '请把语句移到某个 case 中');
    }
  }
  return cases;
}

// ---------- 程序入口 ----------

export function convertProgram(root: N): Program {
  const functions: FunctionDef[] = [];
  const globals: import('./ast').VarDeclStmt[] = [];

  for (const kid of root.namedChildren) {
    if (kid.type === 'comment') continue;
    if (kid.type === 'function_definition') {
      functions.push(convertFunctionDef(kid));
      continue;
    }
    if (kid.type === 'declaration') {
      const s = convertDeclaration(kid);
      if (s) globals.push(s as import('./ast').VarDeclStmt);
      continue;
    }
    if (kid.type.startsWith('preproc_')) {
      if (kid.type === 'preproc_include') {
        throw convError('E_UNSUPPORTED', kid, '教学版无需 #include', 'printf / puts 已内置，直接使用即可');
      }
      throw convError('E_UNSUPPORTED', kid, 'v1.0 不支持预处理指令（#define 等）', '请直接书写常量');
    }
    if (kid.type === 'struct_specifier' || kid.type === 'enum_specifier' || kid.type === 'union_specifier') {
      parseBaseType(kid); // 复用报错信息
      continue;
    }
    if (kid.type === 'type_definition') {
      throw convError('E_UNSUPPORTED', kid, 'v1.0 不支持 typedef');
    }
    if (kid.type === ';') continue;
    throw convError('E_UNSUPPORTED', kid, `v1.0 不支持的顶层结构：${kid.type}`);
  }

  return { functions, globals };
}

function convertFunctionDef(n: N): FunctionDef {
  const retTypeNode = fld(n, 'type');
  const declarator = fld(n, 'declarator');
  const bodyNode = fld(n, 'body');
  if (!retTypeNode || !declarator || !bodyNode) throw convError('E_SYNTAX', n, '无法解析的函数定义');
  if (declarator.type !== 'function_declarator') {
    throw convError('E_SYNTAX', n, '无法解析的函数声明符');
  }
  const returnType = parseBaseType(retTypeNode);

  const nameNode = fld(declarator, 'declarator');
  if (!nameNode) throw convError('E_SYNTAX', declarator, '函数缺少名称');
  let name: string;
  if (nameNode.type === 'identifier') {
    name = nameNode.text;
  } else if (nameNode.type === 'pointer_declarator') {
    // 指针返回类型（int *f()）：内层是标识符
    if (returnType === 'void' || typeof returnType === 'object') {
      throw convError('E_UNSUPPORTED', nameNode, 'v1.0 不支持该返回类型');
    }
    throw convError('E_UNSUPPORTED', nameNode, 'v1.0 不支持返回指针的函数', '建议：通过参数（指针）传出结果');
  } else {
    throw convError('E_UNSUPPORTED', nameNode, `v1.0 不支持的函数声明写法：${nameNode.type}`);
  }

  // 参数
  const params: Param[] = [];
  const paramListNode = fld(declarator, 'parameters');
  if (paramListNode) {
    for (const pn of paramListNode.namedChildren) {
      if (pn.type !== 'parameter_declaration') {
        throw convError('E_UNSUPPORTED', pn, `v1.0 不支持的参数写法：${pn.type}`);
      }
      const pTypeNode = fld(pn, 'type');
      const pDeclNode = fld(pn, 'declarator');
      if (!pTypeNode) throw convError('E_SYNTAX', pn, '参数缺少类型');
      const base = parseBaseType(pTypeNode);
      if (!pDeclNode) {
        // (void) 形式
        if (base === 'void') continue;
        throw convError('E_SYNTAX', pn, '参数缺少名称');
      }
      const { name: pname, type: ptype } = applyDeclaratorToType(base, pDeclNode);
      if (ptype === 'void') {
        throw convError('E_TYPE', pn, '参数类型不能是 void');
      }
      params.push({ name: pname, type: ptype as ScalarCType });
    }
  }

  const bodyStmts = convertBlock(bodyNode);
  const bp = posOf(bodyNode);
  const body = { ...bp, text: bodyNode.text, kind: 'block' as const, body: bodyStmts };

  return {
    name, returnType,
    params,
    body,
    labels: collectLabelNames(bodyStmts),
  };
}

function collectLabelNames(stmts: Stmt[]): string[] {
  const names: string[] = [];
  const walk = (s: Stmt): void => {
    switch (s.kind) {
      case 'label':
        names.push(s.name);
        walk(s.stmt);
        break;
      case 'block': s.body.forEach(walk); break;
      case 'if':
        walk(s.then);
        if (s.else) walk(s.else);
        break;
      case 'while': case 'do-while': walk(s.body); break;
      case 'for': walk(s.body); break;
      case 'switch': s.cases.forEach((c) => c.body.forEach(walk)); break;
      default: break;
    }
  };
  stmts.forEach(walk);
  return names;
}
