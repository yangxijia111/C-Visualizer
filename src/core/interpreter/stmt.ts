// 语句执行：声明 / 表达式语句 / if / 块 / return
// 循环、switch、goto 在 Phase 4；函数调用与 printf 在 Phase 5
import type { Stmt, VarDeclStmt, VarDeclarator, Expr } from '../ast';
import type { NodeBase } from '../ast';
import type { RuntimeValue, Address, Scope } from '../values';
import { isArray } from '../types';
import type { Interpreter, StepDraft } from './index';
import { RuntimeFailure, ReturnSignal, BreakSignal, ContinueSignal, GotoSignal } from './index';
import { evalExpr } from './expr';
import { coerceRuntimeValue } from '../coercion';
import {
  descVarDecl, descAssign, descExprStmt, descIfCondition, descIfBranch,
  descLoopCheck, descForUpdate, descBreak, descContinue,
  descSwitchDisc, descCaseMatch, descFallThrough, descGoto,
} from '../explain';
import type { ArrayInitStatus } from '../explain';

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
      // 返回值在离开函数前强制收敛到函数返回类型（SEMANTIC_MODEL §3.3）
      const coerced = value && i.currentFn ? coerceRuntimeValue(value, i.currentFn.returnType) : value;
      throw new ReturnSignal(coerced);
    }
    case 'empty':
      break;
    case 'label':
      // 标签本身不产生步骤，直接执行后随语句
      execStmt(i, s.stmt);
      break;
    case 'while':
      execWhile(i, s);
      break;
    case 'do-while':
      execDoWhile(i, s);
      break;
    case 'for':
      execFor(i, s);
      break;
    case 'switch':
      execSwitch(i, s);
      break;
    case 'break':
      execBreak(i, s);
      break;
    case 'continue':
      execContinue(i, s);
      break;
    case 'goto':
      execGoto(i, s);
      break;
  }
}

// ============ 循环 ============

/** while：每次条件判断为独立步骤 */
function execWhile(i: Interpreter, s: Extract<Stmt, { kind: 'while' }>): void {
  i.breakableStack.push({ kind: 'loop', loopType: 'while' });
  try {
    for (;;) {
      i.beginStep(s, 'while-condition', 'condition');
      const v = evalExpr(i, s.condition);
      const entered = v.value !== 0;
      i.draft?.flowEvents.push({ kind: 'loop-check', loopType: 'while', conditionText: s.condition.text, value: v.value, entered });
      i.finishStep(descLoopCheck('while', s.condition.text, v, entered));
      if (!entered) break;

      try {
        execStmt(i, s.body);
      } catch (e) {
        if (e instanceof BreakSignal) break;
        if (e instanceof ContinueSignal) continue;
        throw e;
      }
    }
  } finally {
    i.breakableStack.pop();
  }
}

/** do-while：先执行后判断 */
function execDoWhile(i: Interpreter, s: Extract<Stmt, { kind: 'do-while' }>): void {
  i.breakableStack.push({ kind: 'loop', loopType: 'do-while' });
  try {
    for (;;) {
      try {
        execStmt(i, s.body);
      } catch (e) {
        if (e instanceof BreakSignal) break;
        if (!(e instanceof ContinueSignal)) throw e;
      }
      i.beginStep(s, 'do-while-condition', 'condition');
      const v = evalExpr(i, s.condition);
      const entered = v.value !== 0;
      i.draft?.flowEvents.push({ kind: 'loop-check', loopType: 'do-while', conditionText: s.condition.text, value: v.value, entered });
      i.finishStep(descLoopCheck('do-while', s.condition.text, v, entered));
      if (!entered) break;
    }
  } finally {
    i.breakableStack.pop();
  }
}

/** for：init / 每次条件判断 / update 各自独立步骤；init 变量作用域限于循环 */
function execFor(i: Interpreter, s: Extract<Stmt, { kind: 'for' }>): void {
  i.pushScope('for', `for(第${s.line}行)`);
  i.breakableStack.push({ kind: 'loop', loopType: 'for' });
  try {
    if (s.init) {
      if (s.init.kind === 'var-decl') {
        execVarDecl(i, s.init);
      } else {
        execExprStmt(i, s.init.expr);
      }
    }
    for (;;) {
      if (s.condition) {
        i.beginStep(s, 'for-condition', 'condition');
        const v = evalExpr(i, s.condition);
        const entered = v.value !== 0;
        i.draft?.flowEvents.push({ kind: 'loop-check', loopType: 'for', conditionText: s.condition.text, value: v.value, entered });
        i.finishStep(descLoopCheck('for', s.condition.text, v, entered));
        if (!entered) break;
      }
      try {
        execStmt(i, s.body);
      } catch (e) {
        if (e instanceof BreakSignal) break;
        if (!(e instanceof ContinueSignal)) throw e;
      }
      if (s.update) {
        i.beginStep(s, 'for-update', 'update');
        const v = evalExpr(i, s.update);
        i.draft?.flowEvents.push({ kind: 'loop-update', text: s.update.text, newValue: v.value });
        i.finishStep(descForUpdate(s.update.text, v));
      }
    }
  } finally {
    i.breakableStack.pop();
    i.popScope();
  }
}

// ============ break / continue ============

function execBreak(i: Interpreter, s: Extract<Stmt, { kind: 'break' }>): void {
  // 就近原则：跳出栈顶最近的可中断构造（循环或 switch）
  const target = i.breakableStack[i.breakableStack.length - 1];
  const from = target?.kind ?? 'loop';
  i.beginStep(s, 'break');
  i.draft?.flowEvents.push({ kind: 'break', from, loopType: target?.loopType });
  i.finishStep(descBreak(from, target?.loopType));
  throw new BreakSignal();
}

function execContinue(i: Interpreter, s: Extract<Stmt, { kind: 'continue' }>): void {
  // continue 只作用于循环：自栈顶向下找最近的循环（跳过 switch）
  const loop = [...i.breakableStack].reverse().find((b) => b.kind === 'loop');
  const loopType = loop?.loopType ?? 'while';
  i.beginStep(s, 'continue');
  i.draft?.flowEvents.push({ kind: 'continue', loopType });
  i.finishStep(descContinue(loopType, loopType === 'for'));
  throw new ContinueSignal();
}

// ============ switch ============

/**
 * switch：判别式求值 → 匹配区段 → 顺序执行（fall-through 穿透逐步展示）。
 * break（BreakSignal）跳出；穿透边界生成独立步骤。
 */
function execSwitch(i: Interpreter, s: Extract<Stmt, { kind: 'switch' }>): void {
  i.breakableStack.push({ kind: 'switch' });
  try {
    // 步骤 1：判别式求值
    i.beginStep(s, 'switch-discriminant', 'discriminant');
    const dv = evalExpr(i, s.discriminant);
    i.draft?.flowEvents.push({ kind: 'switch-discriminant', text: s.discriminant.text, value: dv.value });
    i.finishStep(descSwitchDisc(s.discriminant.text, dv));

    // 步骤 2：匹配区段
    let matchIdx = -1;
    let matchedLabel: string | null = null;
    let defaultIdx = -1;
    for (let k = 0; k < s.cases.length; k++) {
      const sec = s.cases[k];
      for (const label of sec.labels) {
        if (label.isDefault) {
          if (defaultIdx < 0) defaultIdx = k;
          continue;
        }
        if (label.value && evalExprConst(i, label.value) === dv.value) {
          matchIdx = k;
          matchedLabel = `case ${label.value.text}`;
          break;
        }
      }
      if (matchIdx >= 0) break;
    }
    if (matchIdx < 0 && defaultIdx >= 0) {
      matchIdx = defaultIdx;
      matchedLabel = 'default';
    }

    i.beginStep(s, 'case-check', 'match');
    i.draft?.flowEvents.push({ kind: 'case-match', caseText: matchedLabel ?? '无匹配', matched: matchIdx >= 0 });
    i.finishStep(descCaseMatch(matchedLabel, dv, matchIdx >= 0));

    if (matchIdx < 0) return;

    // 顺序执行各区段（穿透）：每个区段执行完后若无 break，生成穿透步骤
    try {
      for (let k = matchIdx; k < s.cases.length; k++) {
        const sec = s.cases[k];
        for (const st of sec.body) {
          execStmt(i, st);
        }
        if (k < s.cases.length - 1) {
          // 未 break → 穿透
          const fromCase = sectionLabelName(s, k);
          const toCase = sectionLabelName(s, k + 1);
          i.beginStep(s, 'case-fallthrough', 'fallthrough');
          i.draft?.flowEvents.push({ kind: 'case-fallthrough', fromCase, toCase });
          i.finishStep(descFallThrough(fromCase, toCase));
        }
      }
    } catch (e) {
      if (e instanceof BreakSignal) {
        // break 跳出 switch 的步骤由 break 语句自身生成
        return;
      }
      throw e;
    }
  } finally {
    i.breakableStack.pop();
  }
}

/** 区段展示名（穿透文案用） */
function sectionLabelName(s: Extract<Stmt, { kind: 'switch' }>, idx: number): string {
  const sec = s.cases[idx];
  const def = sec.labels.find((l) => l.isDefault);
  if (def) return 'default';
  return `case ${sec.labels.map((l) => l.value?.text ?? '?').join(' / ')}`;
}

/** 常量表达式求值（case 标签已由检查器保证为常量） */
function evalExprConst(i: Interpreter, e: Expr): number {
  const v = evalExpr(i, e);
  return v.value;
}

// ============ goto ============

function execGoto(i: Interpreter, s: Extract<Stmt, { kind: 'goto' }>): void {
  const toLine = i.labelLine(s.label) ?? 0;
  i.beginStep(s, 'goto');
  i.draft?.flowEvents.push({ kind: 'goto', label: s.label, fromLine: s.line, toLine });
  i.finishStep(descGoto(s.label, s.line, toLine));
  throw new GotoSignal(s.label);
}

/** 变量声明（标量、指针、一维数组）；初始化行为由存储期决定（SEMANTIC_MODEL §5） */
function execVarDecl(i: Interpreter, s: VarDeclStmt): void {
  const scope = i.scopes[i.scopes.length - 1];
  if (!scope) throw new RuntimeFailure('E_INTERNAL', '没有活动作用域', 1);
  const draft = i.beginStep(s, 'var-decl');
  const values: (RuntimeValue | null)[] = [];
  const arrayStatus: ArrayInitStatus[] = [];

  for (const v of s.vars) {
    if (isArray(v.varType)) {
      arrayStatus.push(v.initList ? 'list' : (i.currentStorage === 'static' ? 'zero' : 'uninit'));
      declareArray(i, scope, draft, v as ArrayDeclarator);
      values.push(null); // 数组展示由 arrayStatus 决定
      continue;
    }
    const addr = i.declareScalar(scope, v.name, v.varType, s);
    if (v.init) {
      const val = evalExpr(i, v.init);
      values.push(i.writeCell(addr, val, v.init));
    } else if (i.currentStorage === 'static') {
      // 静态存储期：无初始化式 → 零初始化（int 0 / double 0.0 / char 0 / 指针 NULL）
      values.push(i.writeCell(addr, { type: 'int', value: 0 }, s));
    } else {
      values.push(null);
    }
  }

  i.finishStep(descVarDecl(s.vars, values, arrayStatus));
}

/** 数组声明符的收窄类型 */
type ArrayDeclarator = VarDeclarator & { varType: { kind: 'array'; elem: 'int' | 'char' | 'float' | 'double'; length: number } };

/**
 * 一维数组：分配连续地址区间。初始化策略（SEMANTIC_MODEL §5）：
 * - 带初始化列表（含 {}）：前缀逐元素收敛写入，其余元素零初始化；
 * - 无初始化列表：静态存储期（全局）全元素零；自动存储期（局部）全元素未初始化。
 */
function declareArray(
  i: Interpreter,
  scope: Scope,
  draft: StepDraft,
  v: ArrayDeclarator,
): void {
  const fill: number | null = v.initList || i.currentStorage === 'static' ? 0 : null;

  // 重复执行同一声明（后向 goto 回跳）时复用已有区间，按同一策略重置
  const existing = scope.vars.find((x) => x.name === v.name);
  if (existing && existing.address !== null && existing.length === v.varType.length) {
    const base0 = existing.address;
    for (let k = 0; k < v.varType.length; k++) {
      const cell = i.cells.get(base0 + k);
      if (cell) cell.value = fill;
      draft.changedAddresses.add(base0 + k);
    }
    if (v.initList) {
      let addr = base0;
      for (const el of v.initList) {
        const val = evalExpr(i, el);
        const cell = i.cells.get(addr);
        if (cell) {
          // 元素写入统一走 coercion（SEMANTIC_MODEL §3.2）
          cell.value = coerceRuntimeValue(val, v.varType.elem).value;
          draft.changedAddresses.add(addr);
        }
        addr++;
      }
    }
    return;
  }
  const base: Address = i.nextAddress;
  for (let k = 0; k < v.varType.length; k++) {
    const addr = i.allocCell(v.varType.elem);
    const cell = i.cells.get(addr);
    if (cell) cell.value = fill;
    draft.changedAddresses.add(addr);
  }
  scope.vars.push({ name: v.name, type: v.varType, address: base, length: v.varType.length });
  draft.changedScopes.add(scope.id);

  if (v.initList) {
    let addr = base;
    for (const el of v.initList) {
      const val = evalExpr(i, el);
      // 元素写入统一走 coercion（SEMANTIC_MODEL §3.2）
      const cell = i.cells.get(addr);
      if (cell) {
        cell.value = coerceRuntimeValue(val, v.varType.elem).value;
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
