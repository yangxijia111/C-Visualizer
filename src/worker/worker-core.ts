// Worker 核心逻辑：处理 Main→Worker 消息，产出 Worker→Main 消息流。
// 与真实 Worker 解耦（post 为注入回调），Node 测试可直接驱动（tests/worker/）。
// 详见 docs/WORKER_PROTOCOL.md 与 docs/P13_V1.2_RUNTIME_ARCHITECTURE.md §5–7
import { compile, runProgram } from '../core/run';
import { getParser } from '../core/cst';
import { emptyInitialSnapshot } from '../core/interpreter';
import type { MainToWorkerMessage, RunOptionsWire, WorkerToMainMessage } from './protocol';
import { TraceAssembler } from './trace-assembler';

export interface WorkerCoreDeps {
  /** Worker→Main 消息出口（真实 Worker 为 postMessage；测试为收集器） */
  post: (msg: WorkerToMainMessage) => void;
  /** 默认批大小（消息未指定时使用；默认 100） */
  defaultBatchSize?: number;
  /** 默认 Checkpoint 间隔（消息未指定时使用；默认 100） */
  defaultCheckpointInterval?: number;
}

export interface WorkerCore {
  /** 处理一条主线程消息（真实 Worker 中由 onmessage 调用；实现内部自行串行化） */
  handle(msg: MainToWorkerMessage): Promise<void>;
  /** Worker 启动初始化（wasm 预热），完成或失败后 post READY / WORKER_ERROR */
  init(): Promise<void>;
  /** 释放（此后忽略一切消息） */
  dispose(): void;
}

/** Worker 级故障消息（runId = null） */
function workerError(message: string): WorkerToMainMessage {
  return { type: 'WORKER_ERROR', runId: null, message };
}

export function createWorkerCore(deps: WorkerCoreDeps): WorkerCore {
  const post = deps.post;
  let disposed = false;
  let readyPromise: Promise<void> | null = null;
  /** 非空 = 正在编译/执行；同步执行段无法处理新消息（浏览器事件循环被占用） */
  let activeRunId: number | null = null;
  /** 协作式取消标志：同步执行期间外部无法置位（消息被阻塞），
   *  保留给未来分块执行/进程内嵌入；见 P13 §7.2 的诚实说明 */
  let cancelRequested = false;
  /** 消息串行化队列：handle 内部有 await（wasm/编译），必须保证消息严格按序处理、
   *  await 间隙不被下一条消息交叉（与单线程解释器语义一致） */
  let queue: Promise<void> = Promise.resolve();

  function ensureReady(): Promise<void> {
    if (!readyPromise) {
      readyPromise = getParser().then(() => undefined);
    }
    return readyPromise;
  }

  async function init(): Promise<void> {
    try {
      await ensureReady();
      post({ type: 'READY' });
    } catch (e) {
      post(workerError(`解析器（tree-sitter wasm）初始化失败：${e instanceof Error ? e.message : String(e)}`));
    }
  }

  function dispose(): void {
    disposed = true;
  }

  function handleCancel(runId: number): void {
    if (disposed) return;
    // 置位协作式取消标志：若此刻在编译 await 间隙（事件循环空闲），可被后续执行看到；
    // 同步执行段中本消息不可能被处理（真实取消由主线程 terminate 完成）
    cancelRequested = true;
    if (activeRunId === null) {
      // 空闲时的取消请求（通常是竞态窗口里的迟到请求）：回执供客户端对账
      post({ type: 'CANCELLED', runId });
    }
  }

  async function handleRun(runId: number, source: string, options: RunOptionsWire | undefined): Promise<void> {
    try {
      await ensureReady();
      if (disposed) return;
      activeRunId = runId;
      cancelRequested = false;

      const compiled = await compile(source);
      if (disposed) return;
      if (!compiled.ok) {
        activeRunId = null;
        post({ type: 'COMPILE_ERROR', runId, errors: compiled.errors });
        return;
      }

      const assembler = new TraceAssembler({
        batchSize: options?.batchSize ?? deps.defaultBatchSize ?? 100,
        checkpointInterval: options?.checkpointInterval ?? deps.defaultCheckpointInterval ?? 100,
        flush: (startIndex, entries) => {
          post({ type: 'STEP_BATCH', runId, startIndex, entries });
        },
      });

      // RUN_STARTED 必须先于任何批次（initialSnapshot 是重建链的锚点 -1）
      post({ type: 'RUN_STARTED', runId, initialSnapshot: emptyInitialSnapshot() });

      const result = runProgram(compiled.program, source, {
        maxSteps: options?.maxSteps,
        timeLimitMs: options?.timeLimitMs,
        maxCallDepth: options?.maxCallDepth,
        onStep: (step, prevState) => assembler.feed(step, prevState),
        shouldCancel: () => cancelRequested,
      });
      assembler.finish();
      activeRunId = null;
      // 结果中的 steps 留给 GC；trace 已经流式送达主线程
      post({
        type: 'RUN_FINISHED',
        runId,
        status: result.status,
        output: result.output,
        totalSteps: result.steps.length,
      });
    } catch (e) {
      activeRunId = null;
      post({ type: 'WORKER_ERROR', runId, message: e instanceof Error ? e.message : String(e) });
    }
  }

  function handle(msg: MainToWorkerMessage): Promise<void> {
    const task = queue.then(() => runOne(msg));
    // 队列吞掉单条消息的处理失败（失败已转成 WORKER_ERROR 消息），保持后续消息可处理；
    // 返回吞错后的链尾，调用方无需 catch（真实入口处是 void core.handle(...)）
    queue = task.catch(() => undefined);
    return queue;
  }

  async function runOne(msg: MainToWorkerMessage): Promise<void> {
    if (disposed) return;
    switch (msg.type) {
      case 'COMPILE_RUN':
        await handleRun(msg.runId, msg.source, msg.options);
        return;
      case 'CANCEL':
        handleCancel(msg.runId);
        return;
      case 'DISPOSE':
        dispose();
        return;
    }
  }

  return { handle, init, dispose };
}
