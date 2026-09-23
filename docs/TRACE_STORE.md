# Trace Store（TRACE_STORE）

> v1.2.0 起主线程不再持有逐步全量快照；trace 以 **Checkpoint + Delta** 形式存储于
> `src/core/trace/trace-store.ts`，任意步骤快照确定性重建。
> 设计文档：docs/P13_V1.2_RUNTIME_ARCHITECTURE.md §8–§9。

## 1. 存储模型

```
state(-1) = initialSnapshot          ← RUN_STARTED 锚点
state(i)  = 第 i 步执行后的快照
锚点：state(-1) 与每 K 步一个（K = checkpointInterval，默认 100；K=1 等价全量）
其余每步存 Delta（相对上一步状态的增量操作序列）
```

内存：`锚点数 × S + N × Δ`（对比 v1.1 全量的 `N × S`）。实测（Node，gc 保留堆）：

| 程序 | v1.1 全量 | v1.2 store | 降幅 |
| --- | --- | --- | --- |
| 10000 步 × 500 单元（step-limit） | 288.3 MB | 17.9 MB | **−93.8%** |
| fib(12) 递归 1863 步 | 30.0 MB | 3.2 MB | **−89.4%** |
| 100 单元数组 1562 步 | 11.5 MB | 2.9 MB | −75% |
| 2 单元 goto 循环 1003 步 | 1.5 MB | 1.5 MB | ≈0（元数据占比高） |

序列化/传输体积：同规模 10k 程序 166 MB → 5.7 MB（−96.6%）。完整数据：
docs/runtime-v1.2-benchmark.json（与 docs/runtime-baseline.json 同机同方法对比）。

## 2. Delta 格式（src/core/trace/delta.ts）

```ts
type SnapshotDelta =
  | { op: 'cell-set'; addr; cell }            // 新增或整体覆写
  | { op: 'cell-del'; addr }                  // 防御（当前引擎不删单元）
  | { op: 'scope-push'; scope }               // 尾部压入
  | { op: 'scope-pop' }
  | { op: 'var-add'; scopeId; variable }      // 既有作用域追加变量
  | { op: 'var-update'; scopeId; name; variable } // 防御
  | { op: 'frame-push'; frame } | { op: 'frame-pop' }
  | { op: 'frame-set'; frames }               // 防御：非纯尾部变化
  | { op: 'output-append'; text } | { op: 'output-set'; text } // 后者为防御
  | { op: 'next-address'; value }
  | { op: 'snap-set'; snapshot }              // 终极兜底：整体替换
```

**构造性完整**：Delta 由相邻快照 diff 生成（遍历快照全部五个字段：cells 升序、
scopes/frames 位置对齐、output 前缀判定、nextAddress），任何结构异常回退
`snap-set`——正确性不依赖「解释器恰好没写某处」的假设。只存 after（前向重建），
不为 O(1) Previous 引入双向 Patch；Previous 由重建 + LRU 缓存承担。

## 3. 快照重建

```
getSnapshot(i):
  anchor = ≤ i 的最近锚点（anchorIndices 二分）
  snap   = deepClone(anchor.snapshot)      // 绝不修改锚点本身
  for d in anchor+1 .. i: applyDelta(snap, deltas[d])
  return snap                              // 进入 LRU 缓存（容量 32）
```

- 纯确定性：同输入必同输出；金标测试保证与全量快照逐字段 deepEqual
  （21 内置示例 + goto/递归/指针/switch 穿透/运行错误/step-limit/深度超限语料，
  含 K=1/2/97/100000 扫描与每程序 1000 次固定种子随机 seek）。
- **LRU 缓存是纯记忆化**，不得影响任何可见结果（有专项测试）。

## 4. API 与契约

```ts
store.appendInitial(snapshot, source)   // 每次运行开始（隐式清空）
store.appendBatch(startIndex, entries)  // 批次必须严格连续（违反即抛错）
store.finalize(status, output)          // 终态；此后只读
store.getStepView(i): ExecutionStep     // 元数据 + 重建快照（视图装配）
store.getSnapshot(i): Snapshot          // 共享只读实例（缓存契约）；-1 = 初始
store.getSnapshotCopy(i): Snapshot      // 独立深拷贝（需要改写时用）
store.getRecords(): readonly StepRecord[]  // 元数据扫描（控制流窗口等）
store.getStats() / getLength / clear / toRunResult
```

- **共享只读契约**：`getSnapshot` 返回缓存实例，调用方不得修改（UI 面板已核实只读；
  需要改写用 `getSnapshotCopy`）。
- `toRunResult()` 与进程内 `runProgram` 结果同构（等价性对拍用）；
  App 播放不调用它（避免重新物化全量快照）。

## 5. App 集成（双 store）

```
building store：接收流式批次（RUN_STARTED / STEP_BATCH）
      │ RUN_FINISHED（任意终态）→ finalize
      ▼
display store：成为展示 trace（可播放）
编译失败 / 用户取消 → building 丢弃，display 保留上一次完整运行（v1.0.2 stale 语义）
切换示例 → display 清空
```

流式中的部分 trace 不可播放（播放数据面仅终态后开放，任务书 §23 采纳斯派）。
