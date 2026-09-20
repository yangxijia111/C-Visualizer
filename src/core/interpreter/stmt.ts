// 语句执行：声明 / 表达式语句 / if / 块 / return
// 循环、switch、goto 在 Phase 4；函数调用与 printf 在 Phase 5
import type { Stmt, VarDeclStmt, VarDeclarator, Expr } from '../ast';
import type { NodeBase } from '../ast';
import type { RuntimeValue, Address, Scope } from '../values';
import { isArray } from '../types';
import type { Interpreter, StepDraft } from './index';
import { RuntimeFailure, ReturnSignal } from './index';
import { evalExpr } from './expr';
import {
  descVarDecl, descAssign, descExprStmt, descIfCondition, descIfBranch,
} from '../explain';

export function execStmt(i: Interpreter, s: Stmt): void {
  switch (s.kind) {
    case 'var-decl':
      execVarDecl(i, s);
      break;
    case 'expr-stmt':
      execExprStmt(i, s.expr);
      break;
    case 'if':
      execIf(i, s.condition, s.then, s.else);
      break;
    case 'block': {
      i.pushScope('block', `块(第${s.line}行)`);
      try {
        i.execBlockBody(s.body);
      } finally {
        i.popScope();
      }
      break;
    }
    case 'return': {
      const value = s.value ? evalExpr(i, s.value) : undefined;
      throw new ReturnSignal(value);
    }
    case 'empty':
      break;
    case 'label':
      // 标签本身不产生步骤，直接执行后随语句
      execStmt(i, s.stmt);
      break;
    case 'while':
    case 'do-while':
    case 'for':
    case 'switch':
    case 'break':
    case 'continue':
    case 'goto':
      // Phase 4 实现
      throw new RuntimeFailure('E_INTERNAL', `语句 ${s.kind} 将在 Phase 4 实现`, s.line);
  }
}

/** 变量声明（标量、指针、一维数组） */
function execVarDecl(i: Interpreter, s: VarDeclStmt): void {
  const scope = i.scopes[i.scopes.length - 1];
  if (!scope) throw new RuntimeFailure('E_INTERNAL', '没有活动作用域', 1);
  const draft = i.beginStep(s, 'var-decl');
  const values: (RuntimeValue | null)[] = [];

  for (const v of s.vars) {
    if (isArray(v.varType)) {
      declareArray(i, scope, draft, v as ArrayDeclarator);
      values.push({ type: (v.varType as { elem: 'int' | 'char' | 'float' | 'double' }).elem, value: 0 });
      continue;
    }
    const addr = i.declareScalar(scope, v.name, v.varType, s);
    if (v.init) {
      const val = evalExpr(i, v.init);
      values.push(i.writeCell(addr, val, v.init));
    } else {
      values.push(null);
    }
  }

  i.finishStep(descVarDecl(s.vars, values));
}

/** 数组声明符的收窄类型 */
type ArrayDeclarator = VarDeclarator & { varType: { kind: 'array'; elem: 'int' | 'char' | 'float' | 'double'; length: number } };

/** 一维数组：分配连续地址区间；声明即全 0（C 语义），初始化列表覆盖前缀 */
function declareArray(
  i: Interpreter,
  scope: Scope,
  draft: StepDraft,
  v: ArrayDeclarator,
): void {
  const base: Address = i.nextAddress;
  for (let k = 0; k < v.varType.length; k++) {
    const addr = i.allocCell(v.varType.elem);
    const cell = i.cells.get(addr);
    if (cell) cell.value = 0;
    draft.changedAddresses.add(addr);
  }
  scope.vars.push({ name: v.name, type: v.varType, address: base, length: v.varType.length });
  draft.changedScopes.add(scope.id);

  if (v.initList) {
    let addr = base;
    for (const el of v.initList) {
      const val = evalExpr(i, el);
      // 元素写入（直接收敛到元素类型）
      const cell = i.cells.get(addr);
      if (cell) {
        if (cell.type === 'int') cell.value = Math.trunc(val.value) | 0;
        else if (cell.type === 'char') cell.value = val.value & 0xff;
        else cell.value = val.value;
        draft.changedAddresses.add(addr);
      }
      addr++;
    }
  }
}

/** 表达式语句 */
function execExprStmt(i: Interpreter, expr: Expr): void {
  i.beginStep(expr, 'expr-stmt');
  const v = evalExpr(i, expr);
  const description = expr.kind === 'assign' ? descAssign(expr.target.text, v) : descExprStmt(expr.text, v);
  i.finishStep(description);
}

/** if 语句：两步（条件求值 → 分支判定），然后执行命中分支 */
function execIf(i: Interpreter, condition: Expr, then: Stmt, elseStmt?: Stmt): void {
  // 第一步：求值条件
  i.beginStep(condition, 'if-condition', 'condition');
  const v = evalExpr(i, condition);
  const taken = v.value !== 0;
  i.finishStep(descIfCondition(condition.text, v, taken));

  // 第二步：分支判定
  const target: NodeBase = taken ? then : (elseStmt ?? condition);
  i.beginStep(target, 'if-branch', 'branch');
  i.draft?.flowEvents.push({
    kind: 'if-branch',
    conditionText: condition.text,
    conditionValue: v.value,
    taken,
  });
  i.finishStep(descIfBranch(taken, target.line));

  // 执行命中分支
  if (taken) {
    execStmt(i, then);
  } else if (elseStmt) {
    execStmt(i, elseStmt);
  }
}
