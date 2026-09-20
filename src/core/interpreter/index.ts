// 解释器核心：状态管理 + 步骤构建 + 执行主流程
// 详见 docs/EXECUTION_ENGINE.md
import type { Program, NodeBase, FunctionDef, Stmt } from '../ast';
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
  /** 当前步骤草稿（表达式求值向其写轨迹） */
  draft: StepDraft | null = null;
  status: ExecutionStep['status'] = 'ok';
  private startTime = 0;
  readonly opts: Required<RunOptions>;

  constructor(
    private program: Program,
    private source: string,
    options?: RunOptions,
  ) {
    this.opts = { ...DEFAULT_RUN_OPTIONS, ...options };
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
    this.draft = draft;
    return draft;
  }

  finishStep(description: string, extra?: { status?: ExecutionStep['status']; errorCode?: RunErrorCode; line?: number; endLine?: number }): void {
    const draft = this.draft;
    if (!draft) throw new RuntimeFailure('E_INTERNAL', 'finishStep 没有 draft', 1);
    this.draft = null;
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
      this.execFunction(main);
      // main 执行到末尾且没有 return：正常结束（教学约定，返回 0）
      this.finishMainEnd({ type: 'int', value: 0 });
    } catch (e) {
      if (e instanceof ReturnSignal) {
        // main 返回
        this.finishMainEnd(e.value !== undefined ? e.value : intValue0());
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

  private lastStepStatus(): ExecutionStep['status'] {
    const last = this.steps[this.steps.length - 1];
    return last ? last.status : 'ok';
  }

  /**
   * 执行函数体（Phase 5 扩展为完整调用约定）。
   * 注意：函数作用域在执行结束后保留（不在此弹出），
   * 以便终止步骤（程序结束/运行错误）的快照保留局部变量现场；
   * Phase 5 的函数返回在 return 步骤之后自行弹帧。
   */
  execFunction(fn: FunctionDef): void {
    this.pushScope('function', fn.name);
    // 形参在 Phase 5 处理
    this.execBlockBody(fn.body.body);
  }

  /** 执行语句序列（不建块作用域；块作用域由 Block 语句自己管理） */
  execBlockBody(stmts: Stmt[]): void {
    for (const s of stmts) {
      execStmt(this, s);
    }
  }

  private finishMainEnd(returnValue: RuntimeValue): void {
    const node: NodeBase = { line: this.sourceLineCount(), endLine: this.sourceLineCount(), column: 1, endColumn: 1, text: '' };
    this.beginStep(node, 'program-end');
    this.finishStep(descProgramEnd(returnValue), { status: 'program-end' });
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
    this.draft = null;
    const node: NodeBase = { line: f.line, endLine: f.line, column: 1, endColumn: 1, text: '' };
    this.beginStep(node, 'runtime-error');
    this.finishStep(descRuntimeError(f.code, f.message), { status: 'runtime-error', errorCode: f.code });
  }

  private sourceLineCount(): number {
    return this.source.split('\n').length;
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

/** 值展示（本模块内使用） */
export function display(v: RuntimeValue): string {
  return valueToDisplay(v);
}
