# Worker 协议（WORKER_PROTOCOL）

> v1.2.0 起，compile 与解释执行运行在 Web Worker 中；主线程只做编辑、播放与渲染。
> 协议类型定义：`src/worker/protocol.ts`（discriminated union，零重依赖）。
> 设计文档：docs/P13_V1.2_RUNTIME_ARCHITECTURE.md §4–§7、§10。

## 1. 消息总览

所有消息携带 `runId` 防竞态（`WORKER_ERROR` 允许 `null` 表示 Worker 级故障）。

### Main → Worker

| type | 字段 | 语义 |
| --- | --- | --- |
| `COMPILE_RUN` | `runId, source, options?` | 编译并执行。`options: { maxSteps?, timeLimitMs?, maxCallDepth?, batchSize?=100, checkpointInterval?=100 }` |
| `CANCEL` | `runId` | 优雅取消请求：Worker 空闲时回 `CANCELLED`；执行中的真实取消由主线程 terminate（§3） |
| `DISPOSE` | — | 释放（应用卸载） |

### Worker → Main

| type | 字段 | 语义 |
| --- | --- | --- |
| `READY` | — | wasm 解析器初始化完成 |
| `RUN_STARTED` | `runId, initialSnapshot` | 编译成功、开始执行；initialSnapshot 是重建链锚点（状态 -1） |
| `STEP_BATCH` | `runId, startIndex, entries` | 批量步骤（默认 100 步/批）；`TraceEntry = { record: StepRecord, state: full \| delta }` |
| `RUN_FINISHED` | `runId, status, output, totalSteps` | 终态：`completed \| runtime-error \| step-limit \| time-limit \| cancelled \| empty` |
| `COMPILE_ERROR` | `runId, errors` | 编译失败（终态，不产生步骤） |
| `CANCELLED` | `runId` | Worker 侧优雅取消回执（空闲期竞态窗口） |
| `WORKER_ERROR` | `runId\|null, message` | 意外异常；`null` = Worker 级（如 wasm 初始化失败） |

与任务书示例清单的差异：`RUN_PROGRESS` 并入 `STEP_BATCH`（`startIndex + entries.length`
即进度）；`RUNTIME_ERROR` 并入 `RUN_FINISHED.status`（运行错误本就是 trace 内终止步骤 +
RunResult.status，语义不变）。

## 2. 执行生命周期

```
idle → COMPILE_RUN → [compile(async)] → RUN_STARTED → running（STEP_BATCH×k）
     → RUN_FINISHED → idle
编译失败：COMPILE_ERROR（终态）；异常：WORKER_ERROR{runId}（终态）。
主线程 RuntimeClient 状态机：idle → starting → running(累计进度) → finished/cancelled/error。
Worker 内消息严格串行（promise 队列）：同一时刻只处理一条消息，await 间隙不交叉。
```

消息顺序保证：`RUN_STARTED` 先于任何批次；批次 `startIndex` 严格连续；`RUN_FINISHED` 最后。

## 3. 取消（关键设计）

解释器是同步递归下降——**执行中的 Worker 无法处理任何入站消息**（事件循环被占用）。
因此：

- **硬取消 = 主线程 `worker.terminate()`**（`RuntimeClient.cancelActive()`）：
  立即杀死执行、本地合成 `cancelled` 终态、丢弃已接收的部分批次；
  Worker 标记死亡，下次 Run 惰性重建（wasm 重初始化成本实测见 benchmark）。
- 解释器提供 `shouldCancel?()` 协作检查点（每步检查，`RunResult.status='cancelled'`），
  服务于单元测试、进程内嵌入与未来分块执行；对远程 CANCEL 不承担语义。
- `CANCEL` 消息仅覆盖空闲期竞态窗口（回 `CANCELLED` 供客户端对账）。

`cancelled` 与 `step-limit` 严格区分：后者是教学保护（完整说明文案），前者是用户行为。

## 4. 流式批量

- `RunOptions.onStep(step, prevState)`：解释器每步生成后的**纯观测**回调（不影响
  执行与确定性）；Worker 内 `TraceAssembler` 据此装配批次并 `postMessage`。
- postMessage 不让出 Worker 事件循环 → 批次在解释器继续执行的同时异步送达主线程，
  UI 显示「已生成 N 步」。
- **禁止每步一条 postMessage**：批 100 倍降低消息与克隆开销。批大小（传输参数）与
  checkpoint 间隔（存储参数）解耦。
- Backpressure：v1.2 无确认推送（单生产者、批次有界、消费远快于生产）；
  协议预留 `STEP_BATCH_ACK` 扩展位，实测出现瓶颈再启用。

## 5. runId 防竞态

- 每次新 Run 分配单调递增 `runId`；客户端只接受与活跃 run 匹配的消息，
  过期消息**静默丢弃**（防止旧任务结果污染新任务）。
- Run A 运行中用户再次 Run：Run B 立即成为活跃 run；A 的后续消息全部丢弃
  （A 仍会在 Worker 内跑完——Phase B 语义；用户编辑/停止则触发 terminate 硬取消）。
- 连续快速 Run / 运行中编辑源码 / 切换示例均有自动测试覆盖（tests/worker/）。

## 6. 故障恢复（任何路径不得停留在「加载中」）

| 故障 | 检测 | 恢复 |
| --- | --- | --- |
| Worker 构造失败 | `new Worker` 异常 | `worker-error` 终态，Run 按钮恢复 |
| wasm 初始化失败 | READY 看门狗（15s）/ `WORKER_ERROR{null}` | 横幅提示；下次 Run 重建 |
| Worker crash | `onerror` | 活跃 run 得到终态；下次 Run 重建 |
| 消息序列化失败 | `onmessageerror` | 同上 |
| runProgram 意外异常 | Worker try/catch → `WORKER_ERROR{runId}` | 该 run 终态 |

## 7. 传输格式与体积

`TraceEntry.state`：`{ format:'full', snapshot }`（锚点步，每 K 步一个）或
`{ format:'delta', delta: SnapshotDelta[] }`（其余步）。entry 的精确 JSON 体积
即 Worker→主线程传输体积；实测见 docs/runtime-v1.2-benchmark.json
（10k 步 × 500 单元：全量 166MB → 5.7MB）。
