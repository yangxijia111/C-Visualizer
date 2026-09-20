// 解释器核心：状态管理 + 步骤构建 + 执行主流程
// 详见 docs/EXECUTION_ENGINE.md
import type { Program, NodeBase, FunctionDef, Stmt } from '../ast';
import { collectLabels } from '../ast';
import type { Scope, Snapshot, MemoryCell, Variable, RuntimeValue, Address, CellType, StackFrame } from '../values';
import type { ScalarKind } from '../types';
import { isPointer, isArray } from '../types';
import type { ExecutionStep, RunResult, EvalItem, FlowEvent } from '../steps';
import type { RunErrorCode } from '../errors';
import {
  descStepLimit, descTimeLimit, descRuntimeError, descProgramEnd,
} from '../explain';
import { execStmt } from './stmt';
import { valueToDisplay } from '../values';

/** 运行时错误信号（由外层转为终止步骤） */
export class RuntimeFailure extends Error {
  constructor(public code: RunErrorCode, message: string, public line: number) {
    super(message);
  }
}

/** 执行终止信号（步数/时间超限等，非错误） */
export class HaltSignal extends Error {
  constructor(public haltStatus: 'step-limit' | 'time-limit') {
    super(haltStatus);
  }
}

/** 当前步骤草稿：语句执行过程中收集轨迹与变更 */
export interface StepDraft {
  node: NodeBase;
  statementType: string;
  phase?: string;
  evalTrace: EvalItem[];
  flowEvents: FlowEvent[];
  changedAddresses: Set<number>;
  changedScopes: Set<number>;
  outputDelta: string;
}

export interface RunOptions {
  /** 步数上限（默认 10000） */
  maxSteps?: number;
  /** 墙钟上限毫秒（默认 10000） */
  timeLimitMs?: number;
  /** 调用深度上限（默认 100） */
  maxCallDepth?: number;
}

export const DEFAULT_RUN_OPTIONS: Required<RunOptions> = {
  maxSteps: 10000,
  timeLimitMs: 10000,
  maxCallDepth: 100,
};

export class Interpreter {
  /** 活动作用域栈（索引 0 = 全局） */
  scopes: Scope[] = [];
  cells = new Map<Address, MemoryCell>();
  callStack: StackFrame[] = [];
  nextAddress: Address = 1;
  output = '';
  private scopeSeq = 0;
  steps: ExecutionStep[] = [];
  /** 步骤草稿栈：函数调用嵌套在表达式求值内时，外层语句的草稿保持在栈底 */
  drafts: StepDraft[] = [];
  get draft(): StepDraft | null {
    return this.drafts.length > 0 ? this.drafts[this.drafts.length - 1] : null;
  }
  /** 当前执行的函数与标签表（goto 用） */
  currentFn: FunctionDef | null = null;
  currentLabels: Map<string, import('../ast').LabelStmt> = new Map();
  /** 函数表（调用解析用） */
  fnTable: Map<string, FunctionDef> = new Map();
  status: ExecutionStep['status'] = 'ok';
  private startTime = 0;
  readonly opts: Required<RunOptions>;

  constructor(
    private program: Program,
    private source: string,
    options?: RunOptions,
  ) {
    this.opts = { ...DEFAULT_RUN_OPTIONS, ...options };
    for (const f of program.functions) this.fnTable.set(f.name, f);
  }

  // ============ 环境管理 ============

  pushScope(kind: Scope['kind'], label: string): Scope {
    const scope: Scope = { id: ++this.scopeSeq, kind, label, parent: this.scopes.length ? this.scopes[this.scopes.length - 1].id : null, vars: [] };
    this.scopes.push(scope);
    if (this.draft) this.draft.changedScopes.add(scope.id);
    return scope;
  }

  popScope(): Scope | undefined {
    const s = this.scopes.pop();
    if (s && this.draft) this.draft.changedScopes.add(s.id);
    return s;
  }

  /** 由内向外查找变量（同名遮蔽取最内层） */
  findVariable(name: string): { scope: Scope; variable: Variable } | null {
    for (let i = this.scopes.length - 1; i >= 0; i--) {
      const scope = this.scopes[i];
      const variable = scope.vars.find((v) => v.name === name);
      if (variable) return { scope, variable };
    }
    return null;
  }

  requireVariable(name: string, node: NodeBase): { scope: Scope; variable: Variable } {
    const found = this.findVariable(name);
    if (!found) {
      throw new RuntimeFailure('E_UNDEF_VAR', `使用了未声明的变量「${name}」`, node.line);
    }
    return found;
  }

  // ============ 内存管理 ============

  allocCell(type: CellType, pointee?: ScalarKind): Address {
    const addr = this.nextAddress++;
    this.cells.set(addr, { type, value: null, pointee });
    return addr;
  }

  /** 声明标量/指针变量并返回其地址 */
  declareScalar(scope: Scope, name: string, type: import('../types').CType, node: NodeBase): Address {
    let cellType: CellType;
    let pointee: ScalarKind | undefined;
    if (typeof type === 'string') {
      if (type === 'void') throw new RuntimeFailure('E_INTERNAL', 'void 变量', node.line);
      cellType = type;
    } else if (isPointer(type)) {
      cellType = 'pointer';
      pointee = type.pointee;
    } else if (isArray(type)) {
      throw new RuntimeFailure('E_INTERNAL', '数组声明应在 execVarDecl 处理', node.line);
    } else {
      throw new RuntimeFailure('E_INTERNAL', '未知类型', node.line);
    }
    const addr = this.allocCell(cellType, pointee);
    scope.vars.push({ name, type, address: addr });
    if (this.draft) {
      this.draft.changedAddresses.add(addr);
      this.draft.changedScopes.add(scope.id);
    }
    return addr;
  }

  readCell(addr: Address, node: NodeBase): MemoryCell {
    const cell = this.cells.get(addr);
    if (!cell) throw new RuntimeFailure('E_INTERNAL', `读取了不存在的内存单元 #${addr}`, node.line);
    if (cell.value === null) {
      throw new RuntimeFailure('E_UNINIT_READ', `读取了未初始化的内存单元（#${addr}）`, node.line);
    }
    return cell;
  }

  /** 读单元为运行时值（未初始化 → 错误） */
  readValue(addr: Address, node: NodeBase): RuntimeValue {
    const cell = this.readCell(addr, node);
    return cellToValue(cell);
  }

  /** 写单元（做 C 类型收敛）；返回写入后的值 */
  writeCell(addr: Address, v: RuntimeValue, node: NodeBase): RuntimeValue {
    const cell = this.cells.get(addr);
    if (!cell) throw new RuntimeFailure('E_INTERNAL', `写入了不存在的内存单元 #${addr}`, node.line);
    const coerced = coerceToCell(cell, v);
    cell.value = coerced;
    if (this.draft) this.draft.changedAddresses.add(addr);
    return cellToValue(cell);
  }

  // ============ 步骤构建 ============

  beginStep(node: NodeBase, statementType: string, phase?: string): StepDraft {
    const draft: StepDraft = {
      node,
      statementType,
      phase,
      evalTrace: [],
      flowEvents: [],
      changedAddresses: new Set(),
      changedScopes: new Set(),
      outputDelta: '',
    };
    this.drafts.push(draft);
    return draft;
  }

  finishStep(description: string, extra?: { status?: ExecutionStep['status']; errorCode?: RunErrorCode; line?: number; endLine?: number }): void {
    const draft = this.drafts.pop();
    if (!draft) throw new RuntimeFailure('E_INTERNAL', 'finishStep 没有匹配的 draft（草稿栈为空）', 1);
    const step: ExecutionStep = {
      id: this.steps.length,
      line: extra?.line ?? draft.node.line,
      endLine: extra?.endLine ?? draft.node.endLine,
      statementType: draft.statementType,
      phase: draft.phase,
      snapshot: this.captureSnapshot(),
      changed: {
        addresses: [...draft.changedAddresses],
        scopeIds: [...draft.changedScopes],
      },
      evalTrace: draft.evalTrace.length > 0 ? draft.evalTrace : undefined,
      flowEvents: draft.flowEvents,
      description,
      status: extra?.status ?? 'ok',
      errorCode: extra?.errorCode,
      outputDelta: draft.outputDelta || undefined,
    };
    this.steps.push(step);

    // 保护检查
    if (step.status === 'ok') {
      if (this.steps.length >= this.opts.maxSteps) {
        throw new HaltSignal('step-limit');
      }
      if (Date.now() - this.startTime > this.opts.timeLimitMs) {
        throw new HaltSignal('time-limit');
      }
    }
  }

  captureSnapshot(): Snapshot {
    return {
      scopes: this.scopes.map((s) => ({ ...s, vars: s.vars.map((v) => ({ ...v })) })),
      cells: Object.fromEntries([...this.cells.entries()].map(([k, c]) => [k, { ...c }])),
      callStack: this.callStack.map((f) => ({ ...f })),
      nextAddress: this.nextAddress,
      output: this.output,
    };
  }

  // ============ 主流程 ============

  run(): RunResult {
    this.startTime = Date.now();
    const initialSnapshot = this.captureSnapshot();
    try {
      this.pushScope('global', '全局');
      // 全局变量声明（每条一个步骤）
      for (const g of this.program.globals) {
        execStmt(this, g);
      }
      // 进入 main
      const main = this.program.functions.find((f) => f.name === 'main');
      if (!main) {
        throw new RuntimeFailure('E_INTERNAL', '缺少 main 函数（检查器应已拦截）', 1);
      }
      this.callFunction(main, [], main.body.line, { isMain: true, callText: 'main' });
    } catch (e) {
      if (e instanceof ReturnSignal) {
        // main 的 return 已由 callFunction 捕获；此处仅防御信号泄漏
        const lastLine = this.steps.length > 0 ? this.steps[this.steps.length - 1].line : 1;
        this.beginStep({ line: lastLine, endLine: lastLine, column: 1, endColumn: 1, text: '' }, 'program-end');
        this.finishStep(descProgramEnd(e.value ?? intValue0()), { status: 'program-end' });
      } else if (e instanceof HaltSignal) {
        this.finishHalt(e.haltStatus);
      } else if (e instanceof RuntimeFailure) {
        this.finishRuntimeError(e);
      } else {
        const msg = e instanceof Error ? e.message : String(e);
        this.finishRuntimeError(new RuntimeFailure('E_INTERNAL', msg, 1));
      }
    }

    return {
      source: this.source,
      initialSnapshot,
      steps: this.steps,
      status: this.lastStepStatus(),
      output: this.output,
    };
  }

  private lastStepStatus(): RunResult['status'] {
    const last = this.steps[this.steps.length - 1];
    if (!last) return 'empty';
    switch (last.status) {
      case 'program-end': return 'completed';
      case 'runtime-error': return 'runtime-error';
      case 'step-limit': return 'step-limit';
      case 'time-limit': return 'time-limit';
      default: return 'completed';
    }
  }

  /**
   * 执行函数体（Phase 5 扩展为完整调用约定）。
   * 注意：函数作用域在执行结束后保留（不在此弹出），
   * 以便终止步骤（程序结束/运行错误）的快照保留局部变量现场；
   * Phase 5 的函数返回在 return 步骤之后自行弹帧。
   */
  execFunction(fn: FunctionDef): void {
    this.currentFn = fn;
    this.currentLabels = collectLabels(fn.body.body);
    this.pushScope('function', fn.name);
    // 形参在 Phase 5 处理
    this.execBlockBody(fn.body.body);
  }

  /** 查找当前函数内标签的位置（goto 目标行号） */
  labelLine(name: string): number | undefined {
    return this.currentLabels.get(name)?.line;
  }

  /**
   * 完整函数调用约定：调用步骤（实参→形参、压栈）→ 执行函数体 → 返回步骤（出栈）。
   * 递归天然支持（每帧独立作用域）；调用深度受 maxCallDepth 保护。
   */
  callFunction(
    fn: FunctionDef,
    args: RuntimeValue[],
    callLine: number,
    opts?: { isMain?: boolean; callText?: string },
  ): RuntimeValue | undefined {
    if (this.callStack.length >= this.opts.maxCallDepth) {
      throw new RuntimeFailure('E_STACK_DEPTH', '函数调用深度超过 ' + this.opts.maxCallDepth + ' 层（可能是无限递归）', callLine);
    }
    const mainStart = opts?.isMain === true;

    // 先压帧（调用步骤的快照应包含新栈帧与形参绑定）
    this.currentFn = fn;
    const savedLabels = this.currentLabels;
    this.currentLabels = collectLabels(fn.body.body);
    const scope = this.pushScope('function', fn.name);
    for (let idx = 0; idx < fn.params.length; idx++) {
      const p = fn.params[idx];
      const pseudo = { line: callLine, endLine: callLine, column: 1, endColumn: 1, text: p.name };
      const addr = this.declareScalar(scope, p.name, p.type, pseudo);
      this.writeCell(addr, args[idx], pseudo);
    }
    const frame = { functionName: fn.name, scopeId: scope.id, callLine };
    this.callStack.push(frame);

    // 调用步骤
    const argsText = fn.params.map((p, idx) => p.name + ' = ' + valueToDisplay(args[idx])).join('，');
    const anchor = { line: callLine, endLine: callLine, column: 1, endColumn: 1, text: opts?.callText ?? fn.name };
    this.beginStep(anchor, 'call');
    this.draft?.flowEvents.push({
      kind: 'call',
      functionName: fn.name,
      args: fn.params.map((p, idx) => p.name + ' = ' + valueToDisplay(args[idx] ?? intValue0f())),
    });
    this.finishStep(
      mainStart
        ? '程序从 main 函数开始执行。'
        : '调用函数 ' + fn.name + '(' + argsText + ')，压入新的栈帧，进入函数体。',
    );

    let returned;
    let returnedNormally = false;
    try {
      this.execBlockBody(fn.body.body);
      returnedNormally = true;
    } catch (e) {
      if (e instanceof ReturnSignal) {
        returned = e.value;
      } else if (e instanceof GotoSignal) {
        throw new RuntimeFailure('E_INTERNAL', 'goto 目标标签解析失败（检查器应已拦截）', callLine);
      } else if (e instanceof HaltSignal) {
        // 步数/时间上限：保持现场直接冒泡（终止步骤需保留当前帧状态）
        throw e;
      } else {
        // 运行错误：弹帧后抛出（错误步骤呈现调用者视角的冻结现场）
        this.callStack.pop();
        this.popScope();
        this.currentLabels = savedLabels;
        const top = this.callStack[this.callStack.length - 1];
        this.currentFn = top ? this.fnTable.get(top.functionName) ?? null : null;
        throw e;
      }
    }

    // main 执行到末尾：教学约定隐式返回 0（C99 同）；其他非 void 函数报错
    if (returnedNormally && fn.returnType !== 'void' && !mainStart) {
      throw new RuntimeFailure('E_NO_RETURN', '函数「' + fn.name + '」应有返回值，但执行到函数末尾没有遇到 return', callLine);
    }
    if (returnedNormally && mainStart) {
      returned = intValue0f();
    }

    const retAnchor = { line: callLine, endLine: callLine, column: 1, endColumn: 1, text: 'return' };
    const returnValue = returned !== undefined ? valueToDisplay(returned) : undefined;

    if (mainStart) {
      // main：终止步骤在弹帧前生成，快照保留最终变量现场（教学需要看到最终状态）
      this.beginStep(retAnchor, 'program-end');
      this.draft?.flowEvents.push({ kind: 'return', functionName: fn.name, value: returnValue });
      this.finishStep(descProgramEnd(returned ?? intValue0f()), { status: 'program-end' });
      this.callStack.pop();
      this.popScope();
      this.currentLabels = savedLabels;
      this.currentFn = null;
      return returned;
    }

    // 普通函数：先弹帧，返回步骤的快照呈现「回到调用者」的状态
    this.callStack.pop();
    this.popScope();
    this.currentLabels = savedLabels;
    const caller = this.callStack[this.callStack.length - 1];
    this.currentFn = caller ? this.fnTable.get(caller.functionName) ?? null : null;

    this.beginStep(retAnchor, 'return');
    this.draft?.flowEvents.push({ kind: 'return', functionName: fn.name, value: returnValue });
    this.finishStep(
      returned !== undefined
        ? '函数 ' + fn.name + ' 返回 ' + valueToDisplay(returned) + '，栈帧弹出，回到调用点（第 ' + (caller ? caller.callLine : callLine) + ' 行）。'
        : '函数 ' + fn.name + ' 执行完毕（无返回值），栈帧弹出，回到调用点。',
    );
    return returned;
  }

  /**
   * 执行语句序列（不建块作用域；块作用域由 Block 语句自己管理）。
   * goto 信号在本层捕获：目标标签若在本序列中，直接从该标签继续执行
   * （被跳过的语句不执行、其块作用域不创建）；否则向外冒泡。
   */
  execBlockBody(stmts: Stmt[]): void {
    let idx = 0;
    while (idx < stmts.length) {
      const s = stmts[idx];
      try {
        execStmt(this, s);
      } catch (e) {
        if (e instanceof GotoSignal) {
          const targetIdx = stmts.findIndex((st) => st.kind === 'label' && st.name === e.label);
          if (targetIdx >= 0) {
            idx = targetIdx;
            continue;
          }
        }
        throw e;
      }
      idx++;
    }
  }

  private finishHalt(halt: 'step-limit' | 'time-limit'): void {
    const lastLine = this.steps.length > 0 ? this.steps[this.steps.length - 1].line : 1;
    const node: NodeBase = { line: lastLine, endLine: lastLine, column: 1, endColumn: 1, text: '' };
    this.beginStep(node, halt === 'step-limit' ? 'step-limit' : 'time-limit');
    this.finishStep(
      halt === 'step-limit' ? descStepLimit(this.opts.maxSteps) : descTimeLimit(),
      { status: halt },
    );
  }

  private finishRuntimeError(f: RuntimeFailure): void {
    // 丢弃执行了一半的草稿（错误步骤从错误发生时的干净状态呈现）
    this.drafts.length = 0;
    const node: NodeBase = { line: f.line, endLine: f.line, column: 1, endColumn: 1, text: '' };
    this.beginStep(node, 'runtime-error');
    this.finishStep(descRuntimeError(f.code, f.message), { status: 'runtime-error', errorCode: f.code });
  }
}

// ============ 信号类 ============

/** return 信号 */
export class ReturnSignal extends Error {
  constructor(public value?: RuntimeValue) {
    super('return');
  }
}

/** break 信号（Phase 4） */
export class BreakSignal extends Error {
  constructor() {
    super('break');
  }
}

/** continue 信号（Phase 4） */
export class ContinueSignal extends Error {
  constructor() {
    super('continue');
  }
}

/** goto 信号（Phase 4） */
export class GotoSignal extends Error {
  constructor(public label: string) {
    super('goto');
  }
}

// ============ 工具 ============

function intValue0(): RuntimeValue {
  return { type: 'int', value: 0 };
}

function intValue0f(): RuntimeValue {
  return { type: 'int', value: 0 };
}

export function cellToValue(cell: MemoryCell): RuntimeValue {
  return { type: cell.type, value: cell.value as number, pointee: cell.pointee };
}

/** 把运行时值收敛到目标单元的存储表示 */
export function coerceToCell(cell: MemoryCell, v: RuntimeValue): number {
  switch (cell.type) {
    case 'int':
      return Math.trunc(v.value) | 0;
    case 'char':
      return v.value & 0xff;
    case 'float':
    case 'double':
      return v.value;
    case 'pointer':
      return v.value;
  }
}
