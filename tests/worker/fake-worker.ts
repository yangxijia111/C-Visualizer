// 进程内 Fake Worker：用 worker-core 驱动，消息语义与真实 Worker 对齐
// （串行处理 + 异步派发），使协议/竞态/取消逻辑可以在 Node 下充分测试
import { createWorkerCore } from '../../src/worker/worker-core';
import type { MainToWorkerMessage, WorkerToMainMessage } from '../../src/worker/protocol';
import type { WorkerLike } from '../../src/worker/client';
import '../helpers'; // 注入 Node 端 wasm 加载器（副作用导入）

export class FakeWorker implements WorkerLike {
  onmessage: ((ev: { data: WorkerToMainMessage }) => void) | null = null;
  onerror: ((ev: { message?: string }) => void) | null = null;
  onmessageerror: ((ev: unknown) => void) | null = null;
  terminated = false;

  private queue: Promise<void> = Promise.resolve();
  private core = createWorkerCore({ post: (msg) => this.emitToMain(msg) });

  constructor(opts: { skipInit?: boolean } = {}) {
    // 与真实 worker 一致：启动即预热并回 READY / WORKER_ERROR(null)；
    // skipInit 模拟 wasm 永不就绪（READY 看门狗测试用）
    if (!opts.skipInit) void this.core.init();
  }

  postMessage(msg: MainToWorkerMessage): void {
    // 模拟 Worker 事件循环：消息排队、按序异步处理（handler 内 await 不交叉）
    this.queue = this.queue.then(() => this.core.handle(msg)).catch(() => undefined);
  }

  terminate(): void {
    this.terminated = true;
    this.core.dispose();
  }

  /** Worker→Main 消息出口：微任务异步派发，模拟 postMessage 的跨线程时序 */
  private emitToMain(msg: WorkerToMainMessage): void {
    queueMicrotask(() => {
      this.onmessage?.({ data: msg });
    });
  }

  /** 等待 Worker 侧全部排队消息处理完毕 */
  async settle(): Promise<void> {
    await this.queue;
  }

  /** 等待跨线程微任务全部派发完成（配合 settle 使用） */
  static async flush(): Promise<void> {
    await new Promise<void>((r) => setTimeout(r, 0));
  }

  /** 测试辅助：直接向主线程注入一条消息（构造过期/伪造消息用） */
  injectFromWorker(msg: WorkerToMainMessage): void {
    this.emitToMain(msg);
  }

  /** 测试辅助：模拟 Worker 崩溃 */
  crash(message = 'fake crash'): void {
    queueMicrotask(() => {
      this.onerror?.({ message });
    });
  }
}

/** 收集单次 run 的全部回调事件（测试断言用） */
export interface RunLog {
  startedWith: { initialSnapshot: unknown } | null;
  batches: { startIndex: number; entries: unknown[] }[];
  finished: { status: string; output: string; totalSteps: number } | null;
  compileErrors: unknown[] | null;
  runErrors: string[];
  fatalErrors: string[];
}

export function makeRunLog(): { log: RunLog; cb: import('../../src/worker/client').RunCallbacks } {
  const log: RunLog = {
    startedWith: null,
    batches: [],
    finished: null,
    compileErrors: null,
    runErrors: [],
    fatalErrors: [],
  };
  const cb: import('../../src/worker/client').RunCallbacks = {
    onStarted: (initialSnapshot) => { log.startedWith = { initialSnapshot }; },
    onBatch: (startIndex, entries) => { log.batches.push({ startIndex, entries }); },
    onFinished: (status, output, totalSteps) => { log.finished = { status, output, totalSteps }; },
    onCompileError: (errors) => { log.compileErrors = errors; },
    onRunError: (message) => { log.runErrors.push(message); },
    onFatalError: (message) => { log.fatalErrors.push(message); },
  };
  return { log, cb };
}
