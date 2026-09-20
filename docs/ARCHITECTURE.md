# 总体架构（ARCHITECTURE）

## 数据流

```
源代码 (source)
   ↓  ① cst.ts：web-tree-sitter + tree-sitter-c.wasm（浏览器/Node 双端加载）
CST（具体语法树，tree-sitter 节点）
   ↓  ② convert.ts：CST → 教学 AST（自研转换器，保留 line/column/源码文本）
AST（教学 AST，见 AST_SPEC.md）
   ↓  ③ check.ts：语义检查（不支持特性拒绝、类型检查、标签校验、main 校验）
Program（检查通过的完整程序）
   ↓  ④ interpreter/：同步解释执行，产出 ExecutionStep[]（每步含快照与中文说明）
RunResult { initialSnapshot, steps[], output, status }
   ↓  ⑤ UI（React）：播放器状态机索引步骤，渲染各面板
用户看到：行高亮 / 变量 / 内存 / 调用栈 / 控制流 / 说明 / 输出
```

**关键决策：步骤是预计算的。** 解释器一次性同步跑完整个程序（受 10000 步 / 100 层深度 / 10 秒墙钟保护），把每一步执行后的完整状态快照存入数组。此后 UI 的 Next / Previous / Jump / Restart 都是对该数组的**纯索引操作**——回退与跳转绝对精确，与重新推演无关。

## 目录结构

```
C-Visualizer/
├── docs/                    # 全套开发文档
├── scripts/
│   └── parser-spike.mjs     # Parser 可行性验证脚本（保留作回归）
├── src/
│   ├── core/                # 纯逻辑层（不依赖 React / DOM，可在 Node 中测试）
│   │   ├── cst.ts           #   tree-sitter 加载（单例，异步初始化）
│   │   ├── ast.ts           #   教学 AST 类型
│   │   ├── convert.ts       #   CST → AST 转换
│   │   ├── types.ts         #   C 类型系统（int/char/float/double/指针/数组）
│   │   ├── check.ts         #   语义检查
│   │   ├── errors.ts        #   错误类型体系
│   │   ├── values.ts        #   运行时值 / 快照模型
│   │   ├── explain.ts       #   中文说明文案模板（确定性）
│   │   ├── interpreter/
│   │   │   ├── index.ts     #   解释器主流程（产出 RunResult）
│   │   │   ├── expr.ts      #   表达式求值（含求值轨迹与短路）
│   │   │   ├── stmt.ts      #   语句执行（控制流信号机制）
│   │   │   └── builtin.ts   #   printf / puts
│   │   └── run.ts           #   顶层 API：compile(source) / run(program)
│   ├── examples/index.ts    # 示例库
│   ├── ui/                  # React 组件与播放器状态机
│   ├── App.tsx / main.tsx
│   └── styles.css
├── tests/                   # vitest 单元/集成测试（针对 src/core）
└── package.json
```

## 分层规则

1. `src/core` 不允许 import React、DOM API；全部可在 vitest（Node 环境）中直接测试。
2. UI 只消费 `run.ts` 的产物（`CompileResult` / `RunResult` / 快照），不直接接触 tree-sitter 与解释器内部。
3. 快照（`Snapshot`）是纯 JSON 可序列化对象（结构化克隆兼容），UI 渲染函数对它纯只读。

## 关键横切设计

- **抽象地址**：每个标量内存单元分配全局递增的抽象地址（#1、#2…），数组占用连续区间。指针值 = 目标地址；不模拟真实物理地址（见 `EXECUTION_ENGINE.md`）。
- **控制流信号**：解释器内部用异常对象传递 `break / continue / goto / return` 信号，由对应层级捕获（见 `EXECUTION_ENGINE.md` §4）。
- **错误边界**：`compile()` / `run()` 对外保证「要么给结果，要么给结构化错误」，UI 侧再加一层 React ErrorBoundary 兜底。
- **确定性说明文案**：所有用户可见文案集中在 `explain.ts` 与各组件常量中，纯模板拼接，无随机、无 AI。

## 双端加载（浏览器 / Node）

tree-sitter 的 wasm 初始化是异步单例：`await loadCstParser()` 返回缓存的 Parser 实例。
- Node（vitest）：从 `node_modules/tree-sitter-c/tree-sitter-c.wasm` 直接读取。
- 浏览器（Vite）：wasm 文件经 `?url` 导入打包资源，`Parser.init({ locateFile })` 定位运行时 wasm。

## 构建与质量门槛

- `npm run lint`（ESLint flat config + typescript-eslint）
- `npm run typecheck`（tsc --noEmit，strict）
- `npm run test`（vitest run，覆盖 core 全部特性与错误路径）
- `npm run build`（tsc + vite build）
- 每个 Phase 结束时四项必须全绿并 git commit（见 `ROADMAP.md`）。
