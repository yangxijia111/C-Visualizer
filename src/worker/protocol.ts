// Worker 消息协议（discriminated union，主线程 / Worker 共享，零重依赖）
// 详见 docs/WORKER_PROTOCOL.md；所有消息携带 runId 防竞态（WORKER_ERROR 允许 null）
import type { CompileError } from '../core/errors';
import type { RunStatus, StepRecord } from '../core/steps';
import type { Snapshot } from '../core/values';
import type { SnapshotDelta } from '../core/trace/delta';

/** 跨线程可传输的运行参数（函数参数不可结构化克隆，batch/cancel 由 Worker 内部装配） */
export interface RunOptionsWire {
  maxSteps?: number;
  timeLimitMs?: number;
  maxCallDepth?: number;
  /** 流式批量大小（步/批；传输参数，默认 100） */
  batchSize?: number;
  /** Checkpoint 间隔（每 K 步一个完整快照锚点；存储参数，默认 100） */
  checkpointInterval?: number;
}

/** 单步的存储状态：full = 完整快照（兼作 Checkpoint 锚点）；delta = 相对上一步的增量操作序列 */
export type TraceEntryState =
  | { format: 'full'; snapshot: Snapshot }
  | { format: 'delta'; delta: SnapshotDelta[] };

/** 单步的传输单元：元数据 + 存储状态（快照本身不由 record 携带） */
export interface TraceEntry {
  record: StepRecord;
  state: TraceEntryState;
}

/** Main → Worker */
export type MainToWorkerMessage =
  | { type: 'COMPILE_RUN'; runId: number; source: string; options?: RunOptionsWire }
  /** 优雅取消请求：Worker 空闲时回 CANCELLED；解释器同步执行中无法处理消息，
   *  运行中的真实取消由主线程 terminate 硬取消（P13 §7.2） */
  | { type: 'CANCEL'; runId: number }
  | { type: 'DISPOSE' };

/** Worker → Main */
export type WorkerToMainMessage =
  | { type: 'READY' }
  | { type: 'RUN_STARTED'; runId: number; initialSnapshot: Snapshot }
  | { type: 'STEP_BATCH'; runId: number; startIndex: number; entries: TraceEntry[] }
  | { type: 'RUN_FINISHED'; runId: number; status: RunStatus; output: string; totalSteps: number }
  | { type: 'COMPILE_ERROR'; runId: number; errors: CompileError[] }
  | { type: 'CANCELLED'; runId: number }
  /** runId = null 表示 Worker 级故障（wasm 初始化失败等），与单个 run 无关 */
  | { type: 'WORKER_ERROR'; runId: number | null; message: string };
