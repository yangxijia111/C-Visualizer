// TraceStore：主线程侧执行轨迹的唯一存储入口（P13 §9 / TRACE_STORE.md）
// UI 通过本类访问步骤与快照，不直接持有 ExecutionStep[]。
// 存储格式：Checkpoint（每 K 步一个完整快照）+ 逐步 Delta；任意步快照可确定性重建。
import type { ExecutionStep, RunResult, RunStatus, StepRecord } from '../steps';
import type { Snapshot } from '../values';
import { applyDelta, cloneSnapshotFull } from './delta';
import type { SnapshotDelta } from './delta';
import type { TraceEntry } from '../../worker/protocol';

/** 重建结果 LRU 缓存容量（纯记忆化，不影响任何可见结果） */
const SNAPSHOT_CACHE_CAPACITY = 32;

export class TraceStore {
  private records: StepRecord[] = [];
  /** 状态下标 → 完整快照锚点（-1 = initial；其余为 checkpoint 步） */
  private checkpoints = new Map<number, Snapshot>();
  /** 锚点下标严格递增数组（二分「≤ i 的最近锚点」用） */
  private anchorIndices: number[] = [];
  /** 每步的增量（null = 该步本身是 checkpoint） */
  private deltas: (SnapshotDelta[] | null)[] = [];
  /** 重建缓存（插入序 LRU） */
  private cache = new Map<number, Snapshot>();
  private initial: Snapshot | null = null;
  private finalState: { status: RunStatus; output: string } | null = null;
  private source = '';

  /** 追加初始快照（RUN_STARTED 的锚点；每次运行开始时调用，隐式清空旧 trace） */
  appendInitial(snapshot: Snapshot, source: string): void {
    this.clear();
    this.initial = snapshot;
    this.checkpoints.set(-1, snapshot);
    this.anchorIndices.push(-1);
    this.source = source;
  }

  /**
   * 追加一个批次。startIndex 必须等于当前已追加步数（严格单调、无洞）；
   * entries 内部顺序保持不变。违反时抛错（协议被破坏属于实现 bug，静默容忍会损坏 trace）。
   */
  appendBatch(startIndex: number, entries: TraceEntry[]): void {
    if (startIndex !== this.records.length) {
      throw new Error(`批次不连续：期望 startIndex=${this.records.length}，收到 ${startIndex}`);
    }
    if (!this.initial) {
      throw new Error('必须先 appendInitial 再追加批次');
    }
    for (const entry of entries) {
      const index = this.records.length;
      this.records.push(entry.record);
      if (entry.state.format === 'full') {
        // 锚点步：完整快照，无 delta
        this.checkpoints.set(index, entry.state.snapshot);
        this.anchorIndices.push(index);
        this.deltas.push(null);
      } else {
        this.deltas.push(entry.state.delta.map((d) => d));
      }
    }
  }

  /** 记录终态（RUN_FINISHED）。此后 trace 不可变（只读播放）。 */
  finalize(status: RunStatus, output: string): void {
    this.finalState = { status, output };
  }

  clear(): void {
    this.records = [];
    this.checkpoints = new Map();
    this.anchorIndices = [];
    this.deltas = [];
    this.cache = new Map();
    this.initial = null;
    this.finalState = null;
    this.source = '';
  }

  get isFinalized(): boolean {
    return this.finalState !== null;
  }

  get length(): number {
    return this.records.length;
  }

  /** 存储统计（内存审计用）：锚点数 / delta 步数 */
  getStats(): { steps: number; checkpoints: number; deltaSteps: number } {
    const checkpointCount = this.anchorIndices.length - (this.initial ? 1 : 0);
    return { steps: this.records.length, checkpoints: checkpointCount, deltaSteps: this.deltas.filter((d) => d !== null).length };
  }

  getInitialSnapshot(): Snapshot | null {
    return this.initial;
  }

  getFinalStatus(): RunStatus | null {
    return this.finalState?.status ?? null;
  }

  getOutput(): string {
    return this.finalState?.output ?? '';
  }

  getRecord(index: number): StepRecord | null {
    return index >= 0 && index < this.records.length ? this.records[index] : null;
  }

  /** 全部步骤元数据（控制流窗口等按序扫描的场景；只读约定） */
  getRecords(): readonly StepRecord[] {
    return this.records;
  }

  /**
   * 取第 index 步之后的快照（-1 = 初始快照）。
   * 重建算法：≤ index 的最近锚点深拷贝 → 顺序应用其后的 delta（纯确定性；
   * 绝不修改锚点本身）。返回共享只读实例（缓存契约）：调用方不得修改；
   * 需要独立副本用 getSnapshotCopy。
   */
  getSnapshot(index: number): Snapshot | null {
    if (index === -1) return this.initial;
    if (index < 0 || index >= this.records.length) return null;

    const cached = this.cache.get(index);
    if (cached) {
      // LRU 触碰：删后重插，保持插入序 = 访问序
      this.cache.delete(index);
      this.cache.set(index, cached);
      return cached;
    }

    const anchor = this.nearestAnchor(index);
    const base = this.checkpoints.get(anchor);
    if (!base) throw new Error(`锚点缺失：#${anchor}（trace 内部状态损坏）`);
    const snap = cloneSnapshotFull(base);
    for (let d = anchor + 1; d <= index; d++) {
      const delta = this.deltas[d];
      if (!delta) throw new Error(`delta 缺失：#${d}（trace 内部状态损坏）`);
      applyDelta(snap, delta);
    }

    this.cache.set(index, snap);
    while (this.cache.size > SNAPSHOT_CACHE_CAPACITY) {
      const oldest = this.cache.keys().next().value as number;
      this.cache.delete(oldest);
    }
    return snap;
  }

  /** 快照的独立深拷贝（需要改写的调用方使用） */
  getSnapshotCopy(index: number): Snapshot | null {
    const snap = this.getSnapshot(index);
    return snap ? cloneSnapshotFull(snap) : null;
  }

  /** 装配第 index 步的 ExecutionStep 视图（元数据 + 快照），index 越界返回 null */
  getStepView(index: number): ExecutionStep | null {
    const record = this.getRecord(index);
    if (!record) return null;
    const snapshot = this.getSnapshot(index);
    if (!snapshot) return null;
    return { ...record, snapshot };
  }

  /** 组装完整 RunResult（与进程内 runProgram 结果同构；等价性对拍用） */
  toRunResult(): RunResult | null {
    if (!this.initial || !this.finalState) return null;
    return {
      source: this.source,
      initialSnapshot: this.initial,
      steps: this.records.map((record, i) => ({ ...record, snapshot: this.getSnapshot(i) as Snapshot })),
      status: this.finalState.status,
      output: this.finalState.output,
    };
  }

  /** ≤ index 的最近锚点（anchorIndices 升序，二分） */
  private nearestAnchor(index: number): number {
    const arr = this.anchorIndices;
    let lo = 0;
    let hi = arr.length - 1;
    let best = -1; // -1 锚点恒存在
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (arr[mid] <= index) {
        best = arr[mid];
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return best;
  }
}
