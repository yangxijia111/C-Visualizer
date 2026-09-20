// 表达式求值：算术/比较/逻辑（含短路）、赋值、自增自减
// 求值轨迹写入当前步骤草稿（docs/EXECUTION_ENGINE.md §2 EvalItem）
import type { Expr, BinaryOp, AssignOp } from '../ast';
import type { RuntimeValue } from '../values';
import { intValue, charValue, floatValue, truthy, wrap32, cDiv, cMod, valueToDisplay } from '../values';
import type { Interpreter } from './index';
import { RuntimeFailure, cellToValue } from './index';
import { descShortCircuit } from '../explain';
import { execPrintf, execPuts } from './builtin';

/** 求值表达式（含副作用）；轨迹写入 interp.draft */
export function evalExpr(i: Interpreter, e: Expr): RuntimeValue {
  switch (e.kind) {
    case 'int-literal':
      return intValue(e.value);
    case 'float-literal':
      return floatValue(e.value);
    case 'char-literal':
      return charValue(e.code);
    case 'identifier': {
      const { variable } = i.requireVariable(e.name, e);
      if (variable.address === null) {
        throw new RuntimeFailure('E_INTERNAL', `变量 ${e.name} 没有存储地址`, e.line);
      }
      return i.readValue(variable.address, e);
    }
    case 'unary': {
      const v = evalExpr(i, e.operand);
      if (e.op === '!') {
        const r = intValue(truthy(v) ? 0 : 1);
        pushEval(i, e, r);
        return r;
      }
      if (!isNumericKind(v.type)) {
        throw new RuntimeFailure('E_INTERNAL', `一元 ${e.op} 作用于非数值`, e.line);
      }
      if (e.op === '-') {
        const r = v.type === 'float' || v.type === 'double' ? floatValue(-v.value) : intValue(wrap32(-v.value));
        pushEval(i, e, r);
        return r;
      }
      // 一元 +
      return v.type === 'char' ? intValue(v.value) : v;
    }
    case 'pre-incdec':
    case 'post-incdec': {
      const ref = resolveScalarLValue(i, e.target);
      const oldCell = i.readCell(ref.address, e);
      const oldV = cellToValue(oldCell);
      const delta = e.op === '++' ? 1 : -1;
      const newV = i.writeCell(ref.address, incDecValue(oldV, delta), e);
      i.draft?.evalTrace.push({ kind: 'eval', text: e.text, value: newV });
      return e.kind === 'pre-incdec' ? newV : oldV;
    }
    case 'binary':
      return evalBinary(i, e.op, e);
    case 'assign':
      return evalAssign(i, e.op, e);
    case 'addr-of':
    case 'deref':
    case 'array-access':
      // Phase 6 实现数组与指针
      throw new RuntimeFailure('E_INTERNAL', '数组/指针求值将在后续阶段实现', e.line);
    case 'call':
      return evalCall(i, e);
    default:
      throw new RuntimeFailure('E_INTERNAL', `未知表达式 ${e.kind}`, 1);
  }
}

/** 解析标量左值（赋值/自增目标） */
export interface ScalarLValueRef {
  address: number;
  name: string;
}

export function resolveScalarLValue(i: Interpreter, e: Expr): ScalarLValueRef {
  if (e.kind === 'identifier') {
    const { variable } = i.requireVariable(e.name, e);
    if (variable.address === null) {
      throw new RuntimeFailure('E_INTERNAL', `变量 ${e.name} 没有地址`, e.line);
    }
    return { address: variable.address, name: e.name };
  }
  // *p / a[i] 在 Phase 6 实现
  throw new RuntimeFailure('E_INTERNAL', '间接左值将在后续阶段实现', e.line);
}

function incDecValue(v: RuntimeValue, delta: number): RuntimeValue {
  if (v.type === 'float' || v.type === 'double') return floatValue(v.value + delta);
  if (v.type === 'char') return charValue((v.value + delta) & 0xff);
  return intValue(wrap32(v.value + delta));
}

function evalBinary(i: Interpreter, op: BinaryOp, e: Extract<Expr, { kind: 'binary' }>): RuntimeValue {
  // 逻辑运算（短路）
  if (op === '&&' || op === '||') {
    const left = evalExpr(i, e.left);
    const leftTrue = truthy(left);
    if (op === '&&' && !leftTrue) {
      i.draft?.evalTrace.push({ kind: 'skip', text: e.right.text, reason: `&& 左侧为 ${valueToDisplay(left)}（假），短路` });
      i.draft?.flowEvents.push({ kind: 'short-circuit', op, leftValue: left.value, rightSkipped: true });
      const r = intValue(0);
      pushEval(i, e, r);
      return r;
    }
    if (op === '||' && leftTrue) {
      i.draft?.evalTrace.push({ kind: 'skip', text: e.right.text, reason: `|| 左侧为 ${valueToDisplay(left)}（真），短路` });
      i.draft?.flowEvents.push({ kind: 'short-circuit', op, leftValue: left.value, rightSkipped: true });
      const r = intValue(1);
      pushEval(i, e, r);
      return r;
    }
    i.draft?.flowEvents.push({ kind: 'short-circuit', op, leftValue: left.value, rightSkipped: false });
    const right = evalExpr(i, e.right);
    const r = intValue(truthy(right) ? 1 : 0);
    pushEval(i, e, r);
    return r;
  }

  const l = evalExpr(i, e.left);
  const r = evalExpr(i, e.right);
  let result: RuntimeValue;

  if (op === '==' || op === '!=' || op === '>' || op === '<' || op === '>=' || op === '<=') {
    const lv = l.value;
    const rv = r.value;
    const b = op === '==' ? lv === rv : op === '!=' ? lv !== rv : op === '>' ? lv > rv : op === '<' ? lv < rv : op === '>=' ? lv >= rv : lv <= rv;
    result = intValue(b ? 1 : 0);
  } else if (op === '%') {
    if (r.value === 0) {
      throw new RuntimeFailure('E_DIV_ZERO', '取模运算的除数为 0', e.line);
    }
    result = intValue(wrap32(cMod(l.value, r.value)));
  } else {
    const isFloat = l.type === 'float' || l.type === 'double' || r.type === 'float' || r.type === 'double';
    switch (op) {
      case '+': result = isFloat ? floatValue(l.value + r.value) : intValue(wrap32(l.value + r.value)); break;
      case '-': result = isFloat ? floatValue(l.value - r.value) : intValue(wrap32(l.value - r.value)); break;
      case '*': result = isFloat ? floatValue(l.value * r.value) : intValue(wrap32(l.value * r.value)); break;
      case '/': {
        if (r.value === 0) {
          throw new RuntimeFailure('E_DIV_ZERO', isFloat ? '浮点除法的除数为 0' : '整数除法的除数为 0', e.line);
        }
        result = isFloat ? floatValue(l.value / r.value) : intValue(wrap32(cDiv(l.value, r.value)));
        break;
      }
      default:
        throw new RuntimeFailure('E_INTERNAL', `未知运算符 ${op}`, e.line);
    }
  }
  pushEval(i, e, result);
  return result;
}

function evalAssign(i: Interpreter, op: AssignOp, e: Extract<Expr, { kind: 'assign' }>): RuntimeValue {
  const ref = resolveScalarLValue(i, e.target);
  const value = evalExpr(i, e.value);
  let final: RuntimeValue;

  if (op === '=') {
    final = i.writeCell(ref.address, value, e);
  } else {
    // 复合赋值：读取旧值后做对应运算
    const oldCell = i.readCell(ref.address, e);
    const oldV = cellToValue(oldCell);
    const binOp = op[0] as '+' | '-' | '*' | '/' | '%';
    const combined = combineForCompound(oldV, value, binOp, e.line);
    final = i.writeCell(ref.address, combined, e);
    i.draft?.evalTrace.push({
      kind: 'eval',
      text: `${e.target.text} ${op} ${e.value.text}`,
      value: final,
    });
    return final;
  }
  i.draft?.evalTrace.push({ kind: 'eval', text: e.text, value: final });
  return final;
}

/** 复合赋值的运算（保持目标类型语义：int 截断、float 保留；% 仅整型） */
function combineForCompound(l: RuntimeValue, r: RuntimeValue, op: '+' | '-' | '*' | '/' | '%', line: number): RuntimeValue {
  const isFloat = l.type === 'float' || l.type === 'double' || r.type === 'float' || r.type === 'double';
  if (op === '%' || !isFloat) {
    if (op === '/' && r.value === 0) throw new RuntimeFailure('E_DIV_ZERO', '整数除法的除数为 0', line);
    if (op === '%' && r.value === 0) throw new RuntimeFailure('E_DIV_ZERO', '取模运算的除数为 0', line);
    const lv = l.value;
    const rv = r.value;
    switch (op) {
      case '+': return intValue(wrap32(lv + rv));
      case '-': return intValue(wrap32(lv - rv));
      case '*': return intValue(wrap32(lv * rv));
      case '/': return intValue(wrap32(cDiv(lv, rv)));
      case '%': return intValue(wrap32(cMod(lv, rv)));
    }
  }
  if (op === '/' && r.value === 0) throw new RuntimeFailure('E_DIV_ZERO', '浮点除法的除数为 0', line);
  switch (op) {
    case '+': return floatValue(l.value + r.value);
    case '-': return floatValue(l.value - r.value);
    case '*': return floatValue(l.value * r.value);
    default: return floatValue(l.value / r.value);
  }
}

function isNumericKind(t: string): boolean {
  return t === 'int' || t === 'char' || t === 'float' || t === 'double';
}

/** 记录一个求值轨迹条目 */
export function pushEval(i: Interpreter, e: Expr, value: RuntimeValue): void {
  i.draft?.evalTrace.push({ kind: 'eval', text: e.text, value });
}

/** 函数调用表达式：内置 printf/puts 或用户函数 */
function evalCall(i: Interpreter, e: Extract<Expr, { kind: 'call' }>): RuntimeValue {
  if (e.name === 'printf') return execPrintf(i, e);
  if (e.name === 'puts') return execPuts(i, e);
  const fn = i.fnTable.get(e.name);
  if (!fn) {
    throw new RuntimeFailure('E_INTERNAL', `调用了未定义的函数「${e.name}」（检查器应已拦截）`, e.line);
  }
  const args = e.args.map((a) => evalExpr(i, a));
  const result = i.callFunction(fn, args, e.line, { callText: e.text });
  if (result !== undefined) pushEval(i, e, result);
  return result ?? intValue(0);
}

export { descShortCircuit };
