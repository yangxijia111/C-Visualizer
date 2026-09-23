// RuntimeClient：主线程侧的 Worker 封装（生命周期 / runId 防竞态 / READY 看门狗 / 故障恢复）
// 详见 docs/WORKER_PROTOCOL.md 与 docs/P13_V1.2_RUNTIME_ARCHITECTURE.md §5、§10
import type { CompileError } from '../core/errors';
import type { RunStatus } from '../core/steps';
import type { Snapshot } from '../core/values';
import type { MainToWorkerMessage, RunOptionsWire, TraceEntry, WorkerToMainMessage } from './protocol';

/** 最小 Worker 接口（DOM Worker 结构兼容；测试注入内存实现） */
export interface WorkerLike {
  postMessage(msg: MainToWorkerMessage): void;
  terminate(): void;
  onmessage: ((ev: { data: WorkerToMainMessage }) => void) | null;
  onerror: ((ev: { message?: string; error?: unknown }) => void) | null;
  onmessageerror: ((ev: unknown) => void) | null;
}

export type WorkerFactory = () => WorkerLike;

/** 浏览器默认工厂：Vite 原生 module worker（Pages base 对 worker chunk 自动生效）。
 *  DOM Worker 事件按协议类型桥接到 WorkerLike 回调（数据在运行时由 Worker 协议保证） */
export const defaultWorkerFactory: WorkerFactory = () => {
  const dom = new Worker(new URL('./runtime.worker.ts', import.meta.url), { type: 'module' });
  const like: WorkerLike = {
    postMessage: (msg) => { dom.postMessage(msg); },
    terminate: () => { dom.terminate(); },
    onmessage: null,
    onerror: null,
    onmessageerror: null,
  };
  dom.onmessage = (ev) => like.onmessage?.({ data: ev.data as WorkerToMainMessage });
  dom.onerror = (ev) => like.onerror?.({ message: ev.message, error: ev.error });
  dom.onmessageerror = (ev) => like.onmessageerror?.(ev);
  return like;
};

/** 单次 Run 的回调组（每个回调至多对应一次终态；过期 run 的消息已被客户端丢弃） */
export interface RunCallbacks {
  onStarted?: (initialSnapshot: Snapshot) => void;
  onBatch?: (startIndex: number, entries: TraceEntry[]) => void;
  /** 终态（含 cancelled）；到达后本 run 的生命周期结束 */
  onFinished?: (status: RunStatus, output: string, totalSteps: number) => void;
  onCompileError?: (errors: CompileError[]) => void;
  /** 该 run 的意外失败（Worker 异常/消息错误等；也是终态，UI 不得停留在加载中） */
  onRunError?: (message: string) => void;
  /** Worker 级故障（wasm 初始化失败等；无活跃 run 时也会发生） */
  onFatalError?: (message: string) => void;
}

export interface RuntimeClientOptions {
  workerFactory?: WorkerFactory;
  /** READY 看门狗（毫秒）：超时视为 Worker 初始化失败；默认 15000 */
  readyTimeoutMs?: number;
}

interface ActiveRun {
  runId: number;
  cb: RunCallbacks;
}

export class RuntimeClient {
  private worker: WorkerLike | null = null;
  private workerDead = true;
  private seq = 0;
  private active: ActiveRun | null = null;
  private ready: Promise<void> | null = null;
  private readonly factory: WorkerFactory;
  private readonly readyTimeoutMs: number;

  constructor(options: RuntimeClientOptions = {}) {
    this.factory = options.workerFactory ?? defaultWorkerFactory;
    this.readyTimeoutMs = options.readyTimeoutMs ?? 15000;
  }

  get activeRunId(): number | null {
    return this.active?.runId ?? null;
  }

  /** 预热：确保 Worker 存在且解析器就绪。幂等；失败时 Promise 以异常结束（幂等失败） */
  ensureReady(): Promise<void> {
    if (this.workerDead || !this.ready) {
      this.spawn();
    }
    return this.ready as Promise<void>;
  }

  /**
   * 发起一次编译 + 运行。若已有活跃 run，其后续消息将因 runId 过期被静默丢弃
   * （v1.2 Phase B：旧 run 仍会在 Worker 内跑完；Phase D 引入 terminate 硬取消）。
   * 返回本次 runId。
   */
  run(source: string, options: RunOptionsWire | undefined, cb: RunCallbacks): number {
    if (this.workerDead || !this.worker) {
      this.spawn();
    }
    const runId = ++this.seq;
    this.active = { runId, cb };
    this.worker!.postMessage({ type: 'COMPILE_RUN', runId, source, options });
    return runId;
  }

  /** 请求取消指定 run（默认当前活跃 run）。详见 P13 §7.2 */
  cancel(runId?: number): void {
    const target = runId ?? this.active?.runId;
    if (target === undefined || !this.worker || this.workerDead) return;
    this.worker.postMessage({ type: 'CANCEL', runId: target });
  }

  /**
   * 硬取消当前活跃 run（v1.2 停止按钮 / 编辑源码自动取消）：
   * 同步解释器无法在执行中处理消息，唯一可靠的立即终止手段是 terminate。
   * 本地合成 cancelled 终态（丢弃已接收的部分批次），Worker 标记死亡，
   * 下次 run 自动重建（wasm 重初始化成本见 benchmark）。无活跃 run 时为空操作。
   */
  cancelActive(): void {
    const active = this.active;
    if (!active) return;
    this.active = null;
    if (this.worker && !this.workerDead) {
      this.worker.terminate();
    }
    this.worker = null;
    this.workerDead = true;
    this.ready = null;
    active.cb.onFinished?.('cancelled', '', 0);
  }

  /** 释放 Worker（应用卸载时调用；此后客户端不可再用） */
  dispose(): void {
    if (this.worker) {
      this.worker.postMessage({ type: 'DISPOSE' });
      this.worker.terminate();
    }
    this.worker = null;
    this.workerDead = true;
    this.active = null;
    this.ready = null;
  }

  // ============ 内部 ============

  private spawn(): void {
    // 旧 Worker 残留清理（dead 状态下可能是被 terminate 的实例）
    if (this.worker) this.worker.terminate();

    const worker = this.factory();
    this.worker = worker;
    this.workerDead = false;

    // READY 门闩：executor 同步执行，事件（消息/超时）只可能在其后到达
    const gate: { resolve: () => void; reject: (e: Error) => void } = {
      resolve: () => undefined,
      reject: () => undefined,
    };
    let settled = false;
    let watchdog: ReturnType<typeof setTimeout> | null = setTimeout(() => {
      if (settled) return;
      settled = true;
      this.workerDead = true;
      gate.reject(new Error('Worker 初始化超时'));
    }, this.readyTimeoutMs);

    const settle = (ok: boolean, e?: Error): void => {
      if (settled) return;
      settled = true;
      if (watchdog) { clearTimeout(watchdog); watchdog = null; }
      if (ok) gate.resolve();
      else gate.reject(e ?? new Error('Worker 初始化失败'));
    };

    this.ready = new Promise<void>((resolve, reject) => {
      gate.resolve = resolve;
      gate.reject = reject;
    });

    worker.onmessage = (ev) => this.onWorkerMessage(ev.data, (ok, err) => settle(ok, err));
    worker.onerror = (ev) => {
      // 脚本级异常 / Worker crash：标记死亡并给活跃 run 一个终态（UI 不得停在加载中）
      this.workerDead = true;
      settle(false, new Error(ev?.message || 'Worker 发生未捕获异常'));
      this.failActive(ev?.message || 'Worker 发生未捕获异常');
    };
    worker.onmessageerror = () => {
      this.workerDead = true;
      settle(false, new Error('Worker 消息序列化失败'));
      this.failActive('Worker 消息序列化失败');
    };
  }

  private onWorkerMessage(msg: WorkerToMainMessage, ready: (ok: boolean, e?: Error) => void): void {
    switch (msg.type) {
      case 'READY':
        ready(true);
        return;
      case 'WORKER_ERROR': {
        if (msg.runId === null) {
          // Worker 级故障：标记死亡，等待中的 ensureReady 与活跃 run 都必须得到终态
          this.workerDead = true;
          ready(false, new Error(msg.message));
          this.failActive(msg.message);
          return;
        }
        if (this.active && msg.runId === this.active.runId) {
          this.active.cb.onRunError?.(msg.message);
          this.active = null;
        }
        return;
      }
      case 'RUN_STARTED':
      case 'STEP_BATCH':
      case 'RUN_FINISHED':
      case 'COMPILE_ERROR':
      case 'CANCELLED':
        this.onRunMessage(msg);
        return;
    }
  }

  /** runId 过滤：只有当前活跃 run 的消息被放行，其余一律静默丢弃（防旧任务污染） */
  private onRunMessage(msg: WorkerToMainMessage): void {
    const active = this.active;
    if (!active) return;
    if ((msg as { runId?: number }).runId !== active.runId) return;
    const cb = active.cb;
    switch (msg.type) {
      case 'RUN_STARTED':
        cb.onStarted?.(msg.initialSnapshot);
        return;
      case 'STEP_BATCH':
        cb.onBatch?.(msg.startIndex, msg.entries);
        return;
      case 'RUN_FINISHED':
        this.active = null;
        cb.onFinished?.(msg.status, msg.output, msg.totalSteps);
        return;
      case 'COMPILE_ERROR':
        this.active = null;
        cb.onCompileError?.(msg.errors);
        return;
      case 'CANCELLED':
        // Worker 侧优雅取消回执（空闲期竞态窗口）；对 UI 等价于一个 cancelled 终态
        this.active = null;
        cb.onFinished?.('cancelled', '', 0);
        return;
    }
  }

  private failActive(message: string): void {
    if (!this.active) return;
    const cb = this.active.cb;
    this.active = null;
    cb.onRunError?.(message);
  }
}
