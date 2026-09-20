// 教学 AST 节点定义
// 详见 docs/AST_SPEC.md；每个节点携带 1 基源码位置与原文切片 text

import type { CType, ScalarCType } from './types';

/** 源码位置（1 基，含结束位置） */
export interface Pos {
  line: number;
  column: number;
  endLine: number;
  endColumn: number;
}

/** 所有 AST 节点的基础字段 */
export interface NodeBase extends Pos {
  /** 源码原文切片（供 UI 展示与说明文案） */
  text: string;
}

// ============ 表达式 ============

export interface IntLiteral extends NodeBase { kind: 'int-literal'; value: number }
export interface FloatLiteral extends NodeBase { kind: 'float-literal'; value: number }
export interface CharLiteral extends NodeBase { kind: 'char-literal'; code: number }
export interface StringLiteral extends NodeBase { kind: 'string-literal'; value: string }
export interface Identifier extends NodeBase { kind: 'identifier'; name: string }

export interface UnaryExpr extends NodeBase { kind: 'unary'; op: '-' | '+' | '!'; operand: Expr }
export interface PreIncDec extends NodeBase { kind: 'pre-incdec'; op: '++' | '--'; target: Expr }
export interface PostIncDec extends NodeBase { kind: 'post-incdec'; op: '++' | '--'; target: Expr }

export type BinaryOp = '+' | '-' | '*' | '/' | '%' | '==' | '!=' | '>' | '<' | '>=' | '<=' | '&&' | '||';
export interface BinaryExpr extends NodeBase { kind: 'binary'; op: BinaryOp; left: Expr; right: Expr }

export type AssignOp = '=' | '+=' | '-=' | '*=' | '/=' | '%=';
export interface AssignExpr extends NodeBase { kind: 'assign'; op: AssignOp; target: Expr; value: Expr }

export interface AddrOfExpr extends NodeBase { kind: 'addr-of'; target: Expr }
export interface DerefExpr extends NodeBase { kind: 'deref'; target: Expr }
export interface ArrayAccessExpr extends NodeBase { kind: 'array-access'; array: Identifier; index: Expr }
export interface CallExpr extends NodeBase { kind: 'call'; name: string; args: Expr[] }

export type Expr =
  | IntLiteral | FloatLiteral | CharLiteral | StringLiteral | Identifier
  | UnaryExpr | PreIncDec | PostIncDec | BinaryExpr | AssignExpr
  | AddrOfExpr | DerefExpr | ArrayAccessExpr | CallExpr;

/** 左值：可出现在赋值目标 / ++/-- / 取址位置的表达式 */
export function isLValue(e: Expr): boolean {
  return e.kind === 'identifier' || e.kind === 'deref' || e.kind === 'array-access';
}

// ============ 语句 ============

/** 变量声明中的一个声明符（int a = 1 中的 a = 1） */
export interface VarDeclarator {
  name: string;
  /** 应用数组/指针修饰后的最终类型 */
  varType: CType;
  /** 标量/指针初始化表达式 */
  init?: Expr;
  /** 数组初始化列表 {1,2,3}（长度可为 0，如 {} / {0}） */
  initList?: Expr[];
}

export interface VarDeclStmt extends NodeBase { kind: 'var-decl'; declType: CType; vars: VarDeclarator[] }
export interface ExprStmt extends NodeBase { kind: 'expr-stmt'; expr: Expr }
export interface IfStmt extends NodeBase { kind: 'if'; condition: Expr; then: Stmt; else?: Stmt }
export interface WhileStmt extends NodeBase { kind: 'while'; condition: Expr; body: Stmt }
export interface DoWhileStmt extends NodeBase { kind: 'do-while'; body: Stmt; condition: Expr }
export interface ForStmt extends NodeBase {
  kind: 'for';
  init: VarDeclStmt | ExprStmt | null;
  condition: Expr | null;
  update: Expr | null;
  body: Stmt;
}
/** switch 体规整后的区段：连续 case/default 标签 + 其后语句（决定穿透行为） */
export interface CaseSection {
  /** 区段的标签（case 2: case 3: 合并为一区段；isDefault 标记 default） */
  labels: { value?: Expr; isDefault: boolean }[];
  body: Stmt[];
}
export interface SwitchStmt extends NodeBase { kind: 'switch'; discriminant: Expr; cases: CaseSection[] }
export interface BreakStmt extends NodeBase { kind: 'break' }
export interface ContinueStmt extends NodeBase { kind: 'continue' }
export interface GotoStmt extends NodeBase { kind: 'goto'; label: string }
export interface LabelStmt extends NodeBase { kind: 'label'; name: string; stmt: Stmt }
export interface ReturnStmt extends NodeBase { kind: 'return'; value?: Expr }
export interface BlockStmt extends NodeBase { kind: 'block'; body: Stmt[] }
export interface EmptyStmt extends NodeBase { kind: 'empty' }

export type Stmt =
  | VarDeclStmt | ExprStmt | IfStmt | WhileStmt | DoWhileStmt | ForStmt | SwitchStmt
  | BreakStmt | ContinueStmt | GotoStmt | LabelStmt | ReturnStmt | BlockStmt | EmptyStmt;

// ============ 程序 ============

export interface Param { name: string; type: ScalarCType }

export interface FunctionDef {
  name: string;
  returnType: CType;
  params: Param[];
  body: BlockStmt;
  /** 本函数内全部标签名（供检查层校验 goto 目标） */
  labels: string[];
}

export interface Program {
  functions: FunctionDef[];
  globals: VarDeclStmt[];
}

/** 递归收集语句树中的所有标签节点 */
export function collectLabels(stmts: Stmt[], out: Map<string, LabelStmt> = new Map()): Map<string, LabelStmt> {
  for (const s of stmts) collectLabelsInStmt(s, out);
  return out;
}

function collectLabelsInStmt(s: Stmt, out: Map<string, LabelStmt>): void {
  switch (s.kind) {
    case 'label':
      if (!out.has(s.name)) out.set(s.name, s);
      collectLabelsInStmt(s.stmt, out);
      break;
    case 'block':
      collectLabels(s.body, out);
      break;
    case 'if':
      collectLabelsInStmt(s.then, out);
      if (s.else) collectLabelsInStmt(s.else, out);
      break;
    case 'while':
      collectLabelsInStmt(s.body, out);
      break;
    case 'do-while':
      collectLabelsInStmt(s.body, out);
      break;
    case 'for':
      collectLabelsInStmt(s.body, out);
      break;
    case 'switch':
      for (const sec of s.cases) collectLabels(sec.body, out);
      break;
    default:
      break;
  }
}
