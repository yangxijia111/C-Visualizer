// 语义检查：词法作用域类型检查、main 校验、标签校验、printf 格式校验
// 详见 docs/AST_SPEC.md §6 与 docs/ERROR_SPEC.md；作用域模型见 docs/SEMANTIC_MODEL.md §2
// 作用域栈（TypeEnvironment）与运行时 Scope 栈层级一一对应：声明只进当前层，
// 查找由内向外，退出块即弹出——静态可见性必须与运行时块作用域一致。

import type { Program, FunctionDef, Stmt, Expr } from './ast';
import { makeError } from './errors';
import { evalConstInt, evalConstNumber } from './convert';
import type { CompileError } from './errors';
import type { CType } from './types';
import { isScalar, isNumeric, isInteger, isPointer, isArray, typeToString } from './types';
import { TypeEnvironment } from './scope-env';

/** 检查器内部的扩展类型（字符串字面量仅限 printf/puts 参数） */
type CKind = CType | 'string';

const MAX_ERRORS = 20;

export function checkProgram(program: Program): CompileError[] {
  const errors: CompileError[] = [];

  // 函数表
  const fnTable = new Map<string, FunctionDef>();
  for (const fn of program.functions) {
    if (fnTable.has(fn.name)) {
      errors.push(makeError('E_DECL', 'check', fn.body, `函数「${fn.name}」重复定义`));
      continue;
    }
    fnTable.set(fn.name, fn);
  }

  // 全局变量环境（词法作用域栈的最底层，各函数共享只读）
  const globalEnv = new TypeEnvironment();
  for (const g of program.globals) {
    for (const v of g.vars) {
      if (globalEnv.hasInCurrentScope(v.name)) {
        errors.push(makeError('E_DECL', 'check', g, `全局变量「${v.name}」重复定义`));
        continue;
      }
      // 全局初始化必须是常量表达式（C 标准 + 教学约束）
      if (v.init) {
        const folded = evalConstNumber(v.init);
        if (folded === null) {
          errors.push(makeError('E_CONST', 'check', g, `全局变量「${v.name}」的初始化必须是常量表达式`, '全局初始化只能使用字面量与常量运算'));
        } else if ((v.varType === 'int' || v.varType === 'char') && !Number.isInteger(folded)) {
          errors.push(makeError('E_TYPE', 'check', g, `整型全局变量「${v.name}」的初始化不能是浮点常量`));
        }
      }
      if (v.initList) {
        for (const el of v.initList) {
          if (evalConstInt(el) === null) {
            errors.push(makeError('E_CONST', 'check', g, '全局数组的初始化列表必须是常量'));
            break;
          }
        }
      }
      globalEnv.declare(v.name, v.varType);
    }
  }

  // main 校验
  const main = fnTable.get('main');
  if (!main) {
    errors.push(makeError('E_NO_MAIN', 'check', { line: 1, column: 1 }, '缺少 main 函数', '程序入口必须是 int main() { ... }'));
  } else {
    if (main.returnType !== 'int') {
      errors.push(makeError('E_NO_MAIN', 'check', main.body, 'main 的返回类型应为 int', '请写作 int main()'));
    }
    if (main.params.length > 0) {
      errors.push(makeError('E_NO_MAIN', 'check', main.body, '教学版 main 不接受参数', '请写作 int main() 或 int main(void)'));
    }
  }

  for (const fn of program.functions) {
    checkFunction(fn, fnTable, globalEnv, errors);
  }
  return errors.slice(0, MAX_ERRORS);
}

function checkFunction(
  fn: FunctionDef,
  fnTable: Map<string, FunctionDef>,
  globalEnv: TypeEnvironment,
  errors: CompileError[],
): void {
  // 标签检查：重复 + goto 目标存在
  const seen = new Set<string>();
  for (const name of fn.labels) {
    if (seen.has(name)) {
      errors.push(makeError('E_LABEL', 'check', fn.body, `标签「${name}」重复定义`));
    }
    seen.add(name);
  }
  const goTos: { name: string; at: { line: number; column: number } }[] = [];
  collectGotos(fn.body.body, goTos);
  for (const g of goTos) {
    if (!seen.has(g.name)) {
      errors.push(makeError('E_LABEL', 'check', g.at, `goto 目标标签「${g.name}」在本函数内不存在`));
    }
  }

  // return 与函数返回类型的匹配（有无值；类型兼容在 checkStmt 的 return 分支按作用域检查）
  const returns: { hasValue: boolean; at: { line: number; column: number } }[] = [];
  collectReturns(fn.body.body, returns);
  for (const r of returns) {
    if (fn.returnType === 'void' && r.hasValue) {
      errors.push(makeError('E_TYPE', 'check', r.at, `void 函数「${fn.name}」不能返回值`, '请写作 return;'));
    }
    if (fn.returnType !== 'void' && !r.hasValue) {
      errors.push(makeError('E_TYPE', 'check', r.at, `非 void 函数「${fn.name}」的 return 必须带返回值`, '请写作 return 表达式;'));
    }
  }

  // 词法作用域遍历：函数作用域 = 形参 + 函数体顶层声明（同一层，与 C 一致）
  globalEnv.pushScope('function');
  for (const p of fn.params) {
    if (!globalEnv.declare(p.name, p.type)) {
      errors.push(makeError('E_DECL', 'check', fn.body, `形参「${p.name}」重复声明`));
    }
  }
  const ctx: Ctx = { fn, fnTable, env: globalEnv, errors, atGlobalScope: false, loopDepth: 0, switchDepth: 0 };
  for (const s of fn.body.body) checkStmt(s, ctx);
  globalEnv.popScope();
}

function collectGotos(stmts: Stmt[], out: { name: string; at: { line: number; column: number } }[]): void {
  const walk = (s: Stmt): void => {
    switch (s.kind) {
      case 'goto': out.push({ name: s.label, at: s }); break;
      case 'block': s.body.forEach(walk); break;
      case 'label': walk(s.stmt); break;
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
}

function collectReturns(stmts: Stmt[], out: { hasValue: boolean; at: { line: number; column: number } }[]): void {
  const walk = (s: Stmt): void => {
    switch (s.kind) {
      case 'return': out.push({ hasValue: s.value !== undefined, at: s }); break;
      case 'block': s.body.forEach(walk); break;
      case 'label': walk(s.stmt); break;
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
}

interface Ctx {
  fn: FunctionDef;
  fnTable: Map<string, FunctionDef>;
  env: TypeEnvironment;
  errors: CompileError[];
  atGlobalScope: boolean;
  /** 循环嵌套深度（break/continue 合法性；switch 不计入） */
  loopDepth: number;
  /** switch 嵌套深度（仅 break 合法性） */
  switchDepth: number;
}

function addError(ctx: Ctx, at: { line: number; column: number }, message: string, hint?: string): void {
  ctx.errors.push(makeError('E_TYPE', 'check', at, message, hint));
}

function addErrorCode(ctx: Ctx, code: CompileError['code'], at: { line: number; column: number }, message: string, hint?: string): void {
  ctx.errors.push(makeError(code, 'check', at, message, hint));
}

function checkStmt(s: Stmt, ctx: Ctx): void {
  switch (s.kind) {
    case 'var-decl':
      for (const v of s.vars) {
        // 声明点语义：先入当前作用域，再检查初始化式（int x = x; 引用自身 → 编译过，运行时报 E_UNINIT_READ）
        if (!ctx.env.declare(v.name, v.varType)) {
          addErrorCode(ctx, 'E_DECL', s, `变量「${v.name}」在同一作用域重复声明`);
        }
        if (v.init) {
          const t = exprType(v.init, ctx);
          if (t) checkAssignCompat(v.varType, t, v.init, ctx, v.init);
        }
        if (v.initList) {
          // 数组初始化列表：元素类型必须与元素类型兼容；个数不能超（个数超在转换层查不了，这里查）
          if (!isArray(v.varType)) {
            addError(ctx, s, '只有数组才能使用初始化列表 {}');
            continue;
          }
          if (v.initList.length > v.varType.length) {
            addError(ctx, s, `初始化个数（${v.initList.length}）超过数组长度（${v.varType.length}）`);
            continue;
          }
          for (const el of v.initList) {
            const t = exprType(el, ctx);
            if (t) checkAssignCompat(v.varType.elem, t, el, ctx);
          }
        }
      }
      break;
    case 'expr-stmt':
      exprType(s.expr, ctx);
      break;
    case 'if': {
      checkCondition(s.condition, ctx);
      ctx.env.pushScope('block');
      checkStmt(s.then, ctx);
      ctx.env.popScope();
      if (s.else) {
        ctx.env.pushScope('block');
        checkStmt(s.else, ctx);
        ctx.env.popScope();
      }
      break;
    }
    case 'while':
      checkCondition(s.condition, ctx);
      ctx.env.pushScope('block');
      ctx.loopDepth++;
      checkStmt(s.body, ctx);
      ctx.loopDepth--;
      ctx.env.popScope();
      break;
    case 'do-while':
      ctx.env.pushScope('block');
      ctx.loopDepth++;
      checkStmt(s.body, ctx);
      ctx.loopDepth--;
      ctx.env.popScope();
      checkCondition(s.condition, ctx);
      break;
    case 'for':
      // for 专属作用域：init 声明仅在 for 语句内（条件/update/body）可见
      ctx.env.pushScope('for');
      if (s.init) checkStmt(s.init, ctx);
      if (s.condition) checkCondition(s.condition, ctx);
      if (s.update) exprType(s.update, ctx);
      ctx.env.pushScope('block');
      ctx.loopDepth++;
      checkStmt(s.body, ctx);
      ctx.loopDepth--;
      ctx.env.popScope();
      ctx.env.popScope();
      break;
    case 'switch': {
      const dt = exprType(s.discriminant, ctx);
      if (dt && !isInteger(dt)) {
        addError(ctx, s, 'switch 的判别式必须是整型（int / char）', `当前类型：${typeToString(dt)}`);
      }
      // switch 体整体是一个块作用域（C：case 标签不引入新作用域，各区段声明共享同一层）
      ctx.env.pushScope('switch');
      ctx.switchDepth++;
      for (const sec of s.cases) {
        for (const label of sec.labels) {
          if (label.value) {
            const lt = exprType(label.value, ctx);
            if (lt && !isInteger(lt)) {
              addError(ctx, s, 'case 标签必须是整型常量');
            } else if (evalConstInt(label.value) === null) {
              addErrorCode(ctx, 'E_CONST', s, 'case 标签必须是常量表达式', 'case 后只能使用字面量或常量运算');
            }
          }
        }
        sec.body.forEach((st) => checkStmt(st, ctx));
      }
      ctx.switchDepth--;
      ctx.env.popScope();
      break;
    }
    case 'break':
      // break 合法 ⇔ 处于循环或 switch 中（SEMANTIC_MODEL §4）
      if (ctx.loopDepth === 0 && ctx.switchDepth === 0) {
        addError(ctx, s, 'break 只能出现在循环或 switch 语句内部', 'break 会跳出最近的一层循环或 switch');
      }
      break;
    case 'continue':
      // continue 合法 ⇔ 处于循环中（switch 不提供 continue 上下文）
      if (ctx.loopDepth === 0) {
        addError(ctx, s, 'continue 只能出现在循环语句内部', 'continue 会跳到最近一层循环的下一轮（for 先执行更新表达式）');
      }
      break;
    case 'goto':
    case 'empty':
      break;
    case 'label':
      checkStmt(s.stmt, ctx);
      break;
    case 'return':
      if (s.value) {
        const t = exprType(s.value, ctx);
        // return 表达式类型必须与函数返回类型赋值兼容（数值互转允许，数组/字符串拒绝）
        if (t && ctx.fn.returnType !== 'void') {
          checkAssignCompat(ctx.fn.returnType, t, s.value, ctx);
        }
      }
      break;
    case 'block':
      ctx.env.pushScope('block');
      s.body.forEach((st) => checkStmt(st, ctx));
      ctx.env.popScope();
      break;
  }
}

function checkCondition(e: Expr, ctx: Ctx): void {
  const t = exprType(e, ctx);
  if (!t) return;
  if (t === 'string') {
    addError(ctx, e, '字符串不能作为条件');
    return;
  }
  if (!isScalar(t)) {
    addError(ctx, e, `条件必须是标量（数值或指针），不能是 ${typeToString(t)}`);
  }
}

// ---------- 表达式类型推断 ----------

/** 数值提升：char → int；有浮点 → double（调用前已确保两侧为数值） */
function arithResult(l: CKind, r: CKind): CType {
  if (l === 'double' || r === 'double' || l === 'float' || r === 'float') return 'double';
  return 'int';
}

function exprType(e: Expr, ctx: Ctx): CKind | null {
  switch (e.kind) {
    case 'int-literal': return 'int';
    case 'float-literal': return 'double';
    case 'char-literal': return 'char';
    case 'string-literal': return 'string';
    case 'identifier': {
      const t = ctx.env.lookup(e.name);
      if (!t) {
        addErrorCode(ctx, 'E_UNDEF_VAR', e, `使用了未声明的变量「${e.name}」`, '请先声明，例如 int x;');
        return null;
      }
      return t;
    }
    case 'unary': {
      const t = exprType(e.operand, ctx);
      if (!t) return null;
      if (e.op === '!') {
        if (t === 'string' || !isScalar(t)) {
          addError(ctx, e, '! 的操作数必须是标量');
          return null;
        }
        return 'int';
      }
      if (t === 'string' || !isNumeric(t)) {
        addError(ctx, e, `一元 ${e.op} 的操作数必须是数值`);
        return null;
      }
      return t === 'char' ? 'int' : t;
    }
    case 'pre-incdec':
    case 'post-incdec': {
      const t = exprType(e.target, ctx);
      if (!t) return null;
      if (!isLValueKind(e.target)) {
        addError(ctx, e, '++ / -- 的操作数必须是变量（可赋值的左值）');
        return null;
      }
      if (t === 'string' || !isNumeric(t)) {
        addError(ctx, e, `++ / -- 只能作用于数值类型，当前是 ${typeToString(t)}`);
        return null;
      }
      return t;
    }
    case 'binary': {
      const lt = exprType(e.left, ctx);
      const rt = exprType(e.right, ctx);
      if (!lt || !rt) return null;
      if (e.op === '&&' || e.op === '||') {
        for (const t of [lt, rt]) {
          if (t === 'string' || !isScalar(t)) {
            addError(ctx, e, `&& / || 的操作数必须是标量，当前是 ${t === 'string' ? '字符串' : typeToString(t)}`);
            return null;
          }
        }
        return 'int';
      }
      if (isComparisonOp(e.op)) {
        for (const t of [lt, rt]) {
          if (t === 'string' || !isNumeric(t)) {
            addError(ctx, e, `比较运算符「${e.op}」只能比较数值`, 'v1.0 不支持指针比较');
            return null;
          }
        }
        return 'int';
      }
      // 算术运算
      if (e.op === '%') {
        if (!isInteger(lt) || !isInteger(rt)) {
          addError(ctx, e, '% 取模只能用于整型（int / char）');
          return null;
        }
        return 'int';
      }
      for (const t of [lt, rt]) {
        if (t === 'string' || !isNumeric(t)) {
          addError(ctx, e, `算术运算符「${e.op}」只能作用于数值类型，当前是 ${t === 'string' ? '字符串' : typeToString(t)}`,
            '注意：v1.0 不支持指针算术');
          return null;
        }
      }
      return arithResult(lt, rt);
    }
    case 'assign': {
      const tt = exprType(e.target, ctx);
      const vt = exprType(e.value, ctx);
      if (!tt || !vt) return null;
      if (!isLValueKind(e.target)) {
        addError(ctx, e, '赋值号左边必须是变量（可赋值的左值）');
        return null;
      }
      checkAssignCompat(tt, vt, e, ctx, e.value);
      return tt;
    }
    case 'addr-of': {
      if (!isLValueKind(e.target)) {
        addError(ctx, e, '& 取地址的对象必须是变量或数组元素');
        return null;
      }
      const t = exprType(e.target, ctx);
      if (!t) return null;
      if (isArray(t)) {
        addError(ctx, e, 'v1.0 不支持取数组整体地址', '可以取某个元素：&arr[i]');
        return null;
      }
      if (t === 'string' || !isScalar(t)) {
        addError(ctx, e, '& 取地址的对象必须是标量变量');
        return null;
      }
      if (typeof t === 'object') {
        // t 是指针：&p 将产生二级指针
        addError(ctx, e, 'v1.0 不支持取指针的地址（二级指针）');
        return null;
      }
      return { kind: 'pointer', pointee: t };
    }
    case 'deref': {
      const t = exprType(e.target, ctx);
      if (!t) return null;
      if (!isPointer(t)) {
        addError(ctx, e, `解引用 * 只能作用于指针，当前是 ${typeToString(t)}`, '先用 int *p = &x; 声明指针');
        return null;
      }
      return t.pointee;
    }
    case 'array-access': {
      const at = ctx.env.lookup(e.array.name);
      if (!at) {
        addError(ctx, e, `使用了未声明的数组「${e.array.name}」`);
        return null;
      }
      if (!isArray(at)) {
        addError(ctx, e, `「${e.array.name}」不是数组，不能使用下标访问`);
        return null;
      }
      const it = exprType(e.index, ctx);
      if (it && !isInteger(it)) {
        addError(ctx, e, '数组下标必须是整型（int / char）');
      }
      return at.elem;
    }
    case 'call':
      return callType(e, ctx);
  }
}

/** 赋值 / 参数传递 / 初始化的类型兼容性（教学宽松规则） */
function checkAssignCompat(
  target: CKind,
  value: CKind,
  at: Expr | { line: number; column: number },
  ctx: Ctx,
  valueExpr?: Expr,
): void {
  if (target === 'string' || value === 'string') {
    addError(ctx, at, '字符串字面量只能作为 printf / puts 的参数', 'v1.0 不支持字符串变量');
    return;
  }
  if (isArray(target)) {
    addError(ctx, at, '数组不能整体赋值', '请逐个元素赋值：a[i] = x;');
    return;
  }
  if (isNumeric(target) && isNumeric(value)) return; // 数值互赋（隐式截断在运行时说明）
  if (isPointer(target)) {
    if (isPointer(value)) {
      if (value.pointee !== target.pointee) {
        addError(ctx, at, `指针类型不匹配：${typeToString(target)} 不能接收 ${typeToString(value)}`);
      }
      return;
    }
    if (value === 'int' || value === 'char') {
      // 仅允许字面量 0 / NULL（空指针）；非常量 int 一律拒绝
      const folded = valueExpr ? evalConstInt(valueExpr) : null;
      if (folded === 0) return;
      addError(ctx, at, `指针只能接收同类型指针或空指针 0，不能接收表达式`, '空指针写作 int *p = 0; 或 int *p = NULL;');
      return;
    }
    addError(ctx, at, `指针只能接收同类型指针或 0，不能接收 ${typeToString(value)}`);
    return;
  }
  addError(ctx, at, `类型不兼容：不能把 ${typeToString(value)} 赋给 ${typeToString(target)}`);
}

function isComparisonOp(op: string): boolean {
  return op === '==' || op === '!=' || op === '>' || op === '<' || op === '>=' || op === '<=';
}

function isLValueKind(e: Expr): boolean {
  return e.kind === 'identifier' || e.kind === 'deref' || e.kind === 'array-access';
}

function callType(e: Extract<Expr, { kind: 'call' }>, ctx: Ctx): CKind | null {
  // 内置函数
  if (e.name === 'printf') {
    if (e.args.length < 1 || e.args[0].kind !== 'string-literal') {
      addError(ctx, e, 'printf 的第一个参数必须是字符串字面量', '例如 printf("hello\\n")');
      return 'int';
    }
    checkPrintfFormat(e.args[0].value, e.args[0], ctx, e.args.length - 1);
    checkPrintfArgs(e.args[0].value, e.args.slice(1), ctx);
    return 'int';
  }
  if (e.name === 'puts') {
    if (e.args.length !== 1 || e.args[0].kind !== 'string-literal') {
      addError(ctx, e, 'puts 需要恰好一个字符串字面量参数');
      return 'int';
    }
    return 'int';
  }

  const fn = ctx.fnTable.get(e.name);
  if (!fn) {
    addError(ctx, e, `调用了未定义的函数「${e.name}」`,
      ['printf', 'puts'].includes(e.name) ? undefined : '教学版仅支持用户定义的函数与内置 printf/puts');
    return null;
  }
  if (e.args.length !== fn.params.length) {
    addError(ctx, e, `函数「${e.name}」需要 ${fn.params.length} 个参数，实际 ${e.args.length} 个`);
    return fn.returnType;
  }
  for (let i = 0; i < e.args.length; i++) {
    const at = exprType(e.args[i], ctx);
    if (!at) continue;
    checkAssignCompat(fn.params[i].type, at, e.args[i], ctx);
  }
  return fn.returnType;
}

/** printf 格式串检查：支持的转换符 %d %i %f %c %s %%，不支持宽度/精度/长度修饰 */
function checkPrintfFormat(fmt: string, at: { line: number; column: number }, ctx: Ctx, argCount: number): void {
  let specCount = 0;
  for (let i = 0; i < fmt.length; i++) {
    const c = fmt[i];
    if (c !== '%') continue;
    const next = fmt[i + 1];
    if (next === '%') { i++; continue; }
    if (next === undefined) {
      addError(ctx, at, 'printf 格式串末尾有孤立的 %');
      return;
    }
    // 跳过宽度/精度标记，若存在则不支持
    let j = i + 1;
    while (j < fmt.length && /[-+ #0-9.]/.test(fmt[j])) j++;
    if (j > i + 1) {
      addErrorCode(ctx, 'E_UNSUPPORTED', at, `printf 暂不支持宽度/精度（%${fmt.slice(i, j + 1)}）`, '请直接使用 %d / %f / %c / %s');
      return;
    }
    if (j < fmt.length && /[hlLzjt]/.test(fmt[j])) {
      addErrorCode(ctx, 'E_UNSUPPORTED', at, `printf 不支持长度修饰符 %${fmt.slice(i, j + 1)}`, '请使用 %d / %f / %c / %s');
      return;
    }
    const conv = fmt[j];
    if (conv === undefined || !'difcs'.includes(conv)) {
      addErrorCode(ctx, 'E_UNSUPPORTED', at, `printf 不支持的格式符：%${conv ?? ''}`, '支持：%d %i %f %c %s %%');
      return;
    }
    specCount++;
    i = j;
  }
  if (specCount !== argCount) {
    addError(ctx, at, `printf 格式符数量（${specCount}）与参数数量（${argCount}）不一致`);
  }
}

/** printf 参数与格式符的对应类型检查（类型宽松：数值即可匹配 %d/%f/%c） */
function checkPrintfArgs(fmt: string, argExprs: Expr[], ctx: Ctx): void {
  let argIdx = 0;
  const checkOne = (conv: string, expr: Expr): void => {
    const t = exprType(expr, ctx);
    if (!t) return;
    if (conv === 's') {
      if (t !== 'string') {
        addError(ctx, expr, '%s 需要字符串字面量参数');
      }
      return;
    }
    if (t === 'string') {
      addError(ctx, expr, `%${conv} 不能接收字符串参数`);
      return;
    }
    if (conv === 'f') {
      if (!isNumeric(t)) addError(ctx, expr, `%f 需要数值参数`);
    } else {
      // d / i / c
      if (!isInteger(t)) addError(ctx, expr, `%${conv} 需要整型参数（int / char）`);
    }
  };
  for (let i = 0; i < fmt.length; i++) {
    if (fmt[i] !== '%') continue;
    if (fmt[i + 1] === '%') { i++; continue; }
    let j = i + 1;
    while (j < fmt.length && /[-+ #0-9.]/.test(fmt[j])) j++;
    const conv = fmt[j];
    if (conv && 'difcs'.includes(conv)) {
      const expr = argExprs[argIdx];
      if (expr) checkOne(conv, expr);
      argIdx++;
      i = j;
    }
  }
}
