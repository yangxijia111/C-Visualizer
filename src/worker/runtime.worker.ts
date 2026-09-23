// Web Worker 入口：安装 wasm 加载器 → 初始化解析器 → 消息循环
// 真正耗时的 compile + Interpreter 全部在本线程执行（P13 §4）
import { installWebCstLoader } from '../ui/cst-web';
import { createWorkerCore } from './worker-core';
import type { MainToWorkerMessage } from './protocol';

installWebCstLoader();

const core = createWorkerCore({
  post: (msg) => self.postMessage(msg),
});

// 启动即预热解析器；完成/失败通过 READY / WORKER_ERROR(runId:null) 通知主线程
void core.init();

self.onmessage = (ev: MessageEvent<MainToWorkerMessage>): void => {
  // handle 内部自带串行化队列（同一时刻只处理一条消息，await 间隙不交叉）
  void core.handle(ev.data);
};
