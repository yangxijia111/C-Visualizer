// Trace 装配器：把解释器的逐步 onStep 观测流转成批量传输单元（纯逻辑，Node 可单测）
// 存储格式：每 checkpointInterval 步一个完整快照锚点（Checkpoint），其余步为
// 相对上一步的 Delta（相邻快照 diff，构造性完整）。batchSize 与锚点间隔解耦。
// 详见 docs/P13_V1.2_RUNTIME_ARCHITECTURE.md §7.1、§8 与 docs/TRACE_STORE.md
import type { ExecutionStep, StepRecord } from '../core/steps';
import type { Snapshot } from '../core/values';
import { diffSnapshot } from '../core/trace/delta';
import type { TraceEntry } from './protocol';

/** 从 ExecutionStep 剥离快照得到元数据记录 */
export function toRecord(step: ExecutionStep): StepRecord {
  const record = { ...step } as Partial<ExecutionStep>;
  delete record.snapshot;
  return record as StepRecord;
}

/** full 格式条目装配回 ExecutionStep 视图（delta 格式须走 TraceStore 重建） */
export function entryToStep(entry: TraceEntry): ExecutionStep {
  if (entry.state.format !== 'full') {
    throw new Error('entryToStep 仅支持 full 格式（delta 格式请使用 TraceStore 重建）');
  }
  return { ...entry.record, snapshot: entry.state.snapshot };
}

export interface TraceAssemblerOptions {
  /** 批大小（步/批；传输参数） */
  batchSize: number;
  /** Checkpoint 间隔（每 K 步保存一个完整快照锚点；存储参数，默认 100） */
  checkpointInterval: number;
  /** 批冲刷回调（Worker 内为 postMessage；测试内为收集器） */
  flush: (startIndex: number, entries: TraceEntry[]) => void;
}

/**
 * 批量装配：每攒满 batchSize 步冲刷一次；finish() 冲刷残余。
 * 输入为解释器 onStep 的观测流（含终止步骤），输出保证 startIndex 严格连续。
 * feed 的 prevState 是 delta 计算的基（第 0 步传 initialSnapshot）。
 */
export class TraceAssembler {
  private buffer: TraceEntry[] = [];
  private nextIndex = 0;
  private sinceCheckpoint = 0;

  constructor(private readonly opts: TraceAssemblerOptions) {
    if (!Number.isInteger(opts.batchSize) || opts.batchSize < 1) {
      throw new Error(`batchSize 必须为正整数，收到 ${opts.batchSize}`);
    }
    if (!Number.isInteger(opts.checkpointInterval) || opts.checkpointInterval < 1) {
      throw new Error(`checkpointInterval 必须为正整数，收到 ${opts.checkpointInterval}`);
    }
  }

  feed(step: ExecutionStep, prevState: Snapshot | null): void {
    // 锚点判定：距上个锚点（含本步）满 K 步即存完整快照。
    // K=1 → 每步都是锚点（等价全量）；K=100 → 状态下标 99/199/… 为锚点
    if (this.sinceCheckpoint + 1 >= this.opts.checkpointInterval) {
      this.buffer.push({ record: toRecord(step), state: { format: 'full', snapshot: step.snapshot } });
      this.sinceCheckpoint = 0;
    } else {
      if (!prevState) throw new Error('delta 步缺少 prevState（第 0 步必须传 initialSnapshot）');
      this.buffer.push({
        record: toRecord(step),
        state: { format: 'delta', delta: diffSnapshot(prevState, step.snapshot) },
      });
      this.sinceCheckpoint++;
    }
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
