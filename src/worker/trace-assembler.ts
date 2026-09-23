// Trace 装配器：把解释器的逐步 onStep 观测流转成批量传输单元（纯逻辑，Node 可单测）
// Phase B：全量快照格式（每步 full）；Phase F 切换 Checkpoint + Delta
// 详见 docs/P13_V1.2_RUNTIME_ARCHITECTURE.md §7.1
import type { ExecutionStep, StepRecord } from '../core/steps';
import type { Snapshot } from '../core/values';
import type { TraceEntry } from './protocol';

/** 从 ExecutionStep 剥离快照得到元数据记录 */
export function toRecord(step: ExecutionStep): StepRecord {
  const record = { ...step } as Partial<ExecutionStep>;
  delete record.snapshot;
  return record as StepRecord;
}

/** Phase B/E 共用：把传输单元装配回 ExecutionStep 视图（full 格式） */
export function entryToStep(entry: TraceEntry): ExecutionStep {
  if (entry.state.format !== 'full') {
    throw new Error('entryToStep 仅支持 full 格式（delta 格式请使用 TraceStore 重建）');
  }
  return { ...entry.record, snapshot: entry.state.snapshot };
}

export interface TraceAssemblerOptions {
  /** 批大小（步/批） */
  batchSize: number;
  /** 批冲刷回调（Worker 内为 postMessage；测试内为收集器） */
  flush: (startIndex: number, entries: TraceEntry[]) => void;
}

/**
 * 批量装配：每攒满 batchSize 步冲刷一次；finish() 冲刷残余。
 * 输入为解释器 onStep 的观测流（含终止步骤），输出保证 startIndex 严格连续。
 */
export class TraceAssembler {
  private buffer: TraceEntry[] = [];
  private nextIndex = 0;

  constructor(private readonly opts: TraceAssemblerOptions) {
    if (!Number.isInteger(opts.batchSize) || opts.batchSize < 1) {
      throw new Error(`batchSize 必须为正整数，收到 ${opts.batchSize}`);
    }
  }

  /** 每步喂入（prevState 仅 Phase F 的 delta 计算需要，此处忽略） */
  feed(step: ExecutionStep, _prevState: Snapshot | null): void {
    this.buffer.push({ record: toRecord(step), state: { format: 'full', snapshot: step.snapshot } });
    if (this.buffer.length >= this.opts.batchSize) this.flushBuffer();
  }

  /** 运行结束：冲刷残余批次（必须在 RUN_FINISHED 之前调用，保证顺序） */
  finish(): void {
    this.flushBuffer();
  }

  private flushBuffer(): void {
    if (this.buffer.length === 0) return;
    const start = this.nextIndex;
    this.nextIndex += this.buffer.length;
    const entries = this.buffer;
    this.buffer = [];
    this.opts.flush(start, entries);
  }
}
