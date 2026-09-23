// TraceStore：主线程侧执行轨迹的唯一存储入口（P13 §9 / TRACE_STORE.md）
// UI 通过本类访问步骤与快照，不直接持有 ExecutionStep[]。
// Phase E：全量快照格式（每步 full）；Phase F 引入 Checkpoint + Delta 存储。
import type { ExecutionStep, RunResult, RunStatus, StepRecord } from '../steps';
import type { Snapshot } from '../values';
import type { TraceEntry } from '../../worker/protocol';

export class TraceStore {
  private records: StepRecord[] = [];
  private snapshots: Snapshot[] = [];
  private initial: Snapshot | null = null;
  private finalState: { status: RunStatus; output: string } | null = null;
  private source = '';

  /** 追加初始快照（RUN_STARTED 的锚点；每次运行开始时调用，隐式清空旧 trace） */
  appendInitial(snapshot: Snapshot, source: string): void {
    this.clear();
    this.initial = snapshot;
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
    for (const entry of entries) {
      this.records.push(entry.record);
      if (entry.state.format === 'full') {
        this.snapshots.push(entry.state.snapshot);
      } else {
        throw new Error('TraceStore(Phase E) 仅支持 full 格式；delta 存储于 Phase F 引入');
      }
    }
  }

  /** 记录终态（RUN_FINISHED）。此后 trace 不可变（只读播放）。 */
  finalize(status: RunStatus, output: string): void {
    this.finalState = { status, output };
  }

  clear(): void {
    this.records = [];
    this.snapshots = [];
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

  /**
   * 取第 index 步之后的快照（-1 = 初始快照）。
   * 返回共享只读实例（缓存契约）：调用方不得修改；需要独立副本用 getSnapshotCopy。
   */
  getSnapshot(index: number): Snapshot | null {
    if (index === -1) return this.initial;
    return index >= 0 && index < this.snapshots.length ? this.snapshots[index] : null;
  }

  /** 快照的独立深拷贝（需要改写的调用方使用） */
  getSnapshotCopy(index: number): Snapshot | null {
    const snap = this.getSnapshot(index);
    if (!snap) return null;
    const cells: Snapshot['cells'] = {};
    for (const key in snap.cells) cells[key] = { ...snap.cells[key] };
    return {
      scopes: snap.scopes.map((s) => ({ ...s, vars: s.vars.map((v) => ({ ...v })) })),
      cells,
      callStack: snap.callStack.map((f) => ({ ...f })),
      nextAddress: snap.nextAddress,
      output: snap.output,
    };
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
      steps: this.records.map((record, i) => ({ ...record, snapshot: this.snapshots[i] })),
      status: this.finalState.status,
      output: this.finalState.output,
    };
  }
}
