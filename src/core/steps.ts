// 执行步骤与控制流事件的类型定义
// 详见 docs/EXECUTION_ENGINE.md §2 与 docs/VISUALIZATION_SPEC.md §5
import type { Snapshot, RuntimeValue } from './values';
import type { RunErrorCode } from './errors';

/** 表达式求值轨迹项（按求值顺序） */
export type EvalItem =
  | { kind: 'eval'; text: string; value: RuntimeValue }
  | { kind: 'skip'; text: string; reason: string };

/** 控制流事件（控制流面板渲染） */
export type FlowEvent =
  | { kind: 'if-branch'; conditionText: string; conditionValue: number; taken: boolean }
  | { kind: 'loop-check'; loopType: 'while' | 'do-while' | 'for'; conditionText: string; value: number; entered: boolean }
  | { kind: 'loop-update'; text: string; newValue: number }
  | { kind: 'break'; from: 'loop' | 'switch'; loopType?: string }
  | { kind: 'continue'; loopType: string }
  | { kind: 'switch-discriminant'; text: string; value: number }
  | { kind: 'case-match'; caseText: string; matched: boolean }
  | { kind: 'case-fallthrough'; fromCase: string; toCase: string }
  | { kind: 'goto'; label: string; fromLine: number; toLine: number }
  | { kind: 'short-circuit'; op: '&&' | '||'; leftValue: number; rightSkipped: boolean }
  | { kind: 'call'; functionName: string; args: string[] }
  | { kind: 'return'; functionName: string; value?: string }
  | { kind: 'enter-block'; label: string }
  | { kind: 'exit-block'; label: string };

/** 单个执行步骤 */
export interface ExecutionStep {
  id: number;
  /** 当前语句行号（1 基） */
  line: number;
  endLine: number;
  /** 语句类型：'var-decl' | 'expr-stmt' | 'if-condition' | 'if-branch' | ... */
  statementType: string;
  /** 语句阶段：'init' | 'condition' | 'body' | 'update' 等 */
  phase?: string;
  /** 本步执行后的完整状态 */
  snapshot: Snapshot;
  /** 与上一步的差异（UI 高亮） */
  changed: {
    addresses: number[];
    scopeIds: number[];
  };
  evalTrace?: EvalItem[];
  flowEvents: FlowEvent[];
  /** 中文教学说明（确定性生成） */
  description: string;
  status: 'ok' | 'runtime-error' | 'program-end' | 'step-limit' | 'time-limit' | 'cancelled';
  errorCode?: RunErrorCode;
  /** 本步新增的 printf 输出 */
  outputDelta?: string;
}

export interface RunResult {
  source: string;
  /** 第 0 步之前的状态（全局初始化前） */
  initialSnapshot: Snapshot;
  steps: ExecutionStep[];
  /** 汇总状态：completed = 正常结束；cancelled = 用户主动取消（v1.2） */
  status: 'completed' | 'runtime-error' | 'step-limit' | 'time-limit' | 'cancelled' | 'empty';
  output: string;
}

/** 运行终态（协议层复用） */
export type RunStatus = RunResult['status'];

/** 执行步骤的元数据部分（快照由 TraceStore 单独管理，见 TRACE_STORE.md） */
export type StepRecord = Omit<ExecutionStep, 'snapshot'>;
