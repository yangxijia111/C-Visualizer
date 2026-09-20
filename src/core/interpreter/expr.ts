// 表达式求值：算术/比较/逻辑（含短路）、赋值、自增自减
// 求值轨迹写入当前步骤草稿（docs/EXECUTION_ENGINE.md §2 EvalItem）
import type { Expr, BinaryOp, AssignOp } from '../ast';
import type { RuntimeValue } from '../values';
import { intValue, charValue, floatValue, pointerValue, truthy, wrap32, cDiv, cMod, valueToDisplay } from '../values';
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
      return evalAddrOf(i, e);
    case 'deref':
      return evalDeref(i, e);
    case 'array-access': {
      const ref = resolveArrayAccess(i, e);
      const v = i.readValue(ref.base + ref.index, e);
      pushEval(i, e, v);
      return v;
    }
    case 'call':
      return evalCall(i, e);
    default:
      throw new RuntimeFailure('E_INTERNAL', `未知表达式 ${e.kind}`, 1);
  }
}

/** 解析标量左值（赋值/自增目标：变量、数组元素、*p） */
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
  if (e.kind === 'array-access') {
    const ref = resolveArrayAccess(i, e);
    return { address: ref.base + ref.index, name: `${e.array.text}[${ref.index}]` };
  }
  if (e.kind === 'deref') {
    return { address: derefAddress(i, e), name: `*${e.target.text}` };
  }
  throw new RuntimeFailure('E_INTERNAL', '该表达式不能作为左值（检查器应已拦截）', e.line);
}

/** 数组访问解析：变量查找 + 下标求值 + 越界检查 */
export interface ArrayAccessRef {
  base: number;
  index: number;
  elemType: 'int' | 'char' | 'float' | 'double';
  length: number;
  name: string;
}

export function resolveArrayAccess(i: Interpreter, e: Extract<Expr, { kind: 'array-access' }>): ArrayAccessRef {
  const { variable } = i.requireVariable(e.array.name, e);
  if (variable.address === null || typeof variable.type === 'string' || variable.type.kind !== 'array') {
    throw new RuntimeFailure('E_INTERNAL', `「${e.array.name}」不是数组（检查器应已拦截）`, e.line);
  }
  const idxV = evalExpr(i, e.index);
  const idx = idxV.value;
  const length = variable.type.length;
  if (idx < 0 || idx >= length) {
    throw new RuntimeFailure(
      'E_ARRAY_BOUND',
      `数组下标越界：${e.array.name}[${idx}]，数组长度为 ${length}（有效下标 0～${length - 1}）`,
      e.line,
    );
  }
  return { base: variable.address, index: idx, elemType: variable.type.elem, length, name: e.array.name };
}

/** & 取地址 */
function evalAddrOf(i: Interpreter, e: Extract<Expr, { kind: 'addr-of' }>): RuntimeValue {
  const t = e.target;
  if (t.kind === 'identifier') {
    const { variable } = i.requireVariable(t.name, e);
    if (variable.address === null) throw new RuntimeFailure('E_INTERNAL', '变量没有地址', e.line);
    const pointee = typeof variable.type === 'string' && variable.type !== 'void'
      ? variable.type
      : 'int';
    const v = pointerValue(variable.address, pointee);
    pushEval(i, e, v);
    return v;
  }
  if (t.kind === 'array-access') {
    const ref = resolveArrayAccess(i, t);
    const v = pointerValue(ref.base + ref.index, ref.elemType);
    pushEval(i, e, v);
    return v;
  }
  if (t.kind === 'deref') {
    // &*p 等价于 p
    const v = evalExpr(i, t.target);
    pushEval(i, e, v);
    return v;
  }
  throw new RuntimeFailure('E_INTERNAL', '取地址目标不合法（检查器应已拦截）', e.line);
}

/** 解引用地址计算（空指针/未初始化检查） */
function derefAddress(i: Interpreter, e: Extract<Expr, { kind: 'deref' }>): number {
  const p = evalExpr(i, e.target);
  if (p.type !== 'pointer') {
    throw new RuntimeFailure('E_BAD_DEREF', `解引用 * 只能作用于指针`, e.line);
  }
  if (p.value === 0) {
    throw new RuntimeFailure('E_NULL_DEREF', `解引用了空指针（${e.target.text} 的值为 0）`, e.line);
  }
  return p.value;
}

/** *p 求值 */
function evalDeref(i: Interpreter, e: Extract<Expr, { kind: 'deref' }>): RuntimeValue {
  const addr = derefAddress(i, e);
  const cell = i.cells.get(addr);
  if (!cell) {
    throw new RuntimeFailure('E_NULL_DEREF', `指针指向了无效的内存位置（#${addr}）`, e.line);
  }
  const v = i.readValue(addr, e);
  pushEval(i, e, v);
  return v;
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
