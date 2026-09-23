# 开发路线图（ROADMAP）

> 每个阶段的出口条件：实现 → 单元/集成测试 → lint → typecheck → build → 修 Bug → 更新文档 → git commit。**不等待用户确认。**

## Phase 0 — 技术可行性验证 ✅

- [x] 环境检查（Node 24 / npm / git / gh）
- [x] tree-sitter-c spike：解析教学子集 + 错误恢复 + 字段 API 验证（`scripts/parser-spike.mjs`）
- 结论：采用「tree-sitter-c CST → 自研转换 → 自研教学解释器」路线（见 PARSER_DESIGN.md §1）

## Phase 1 — 项目脚手架

- Vite + React 19 + TypeScript(strict) + vitest + ESLint(flat) + CodeMirror 依赖
- 目录骨架、styles 基础、npm scripts（dev/build/test/lint/typecheck）
- git init、首个 commit
- 出口：四项质量命令全绿

## Phase 2 — 解析与检查层（core）

- cst.ts（双端加载）、ast.ts、convert.ts（CST→AST 全量转换）、check.ts、errors.ts
- 覆盖 SUPPORTED_C 全部支持项的转换测试 + 不支持特性拒绝测试
- 出口：tests/convert + tests/check 全绿

## Phase 3 — 解释器核心

- values.ts（值/快照模型）、interpreter（表达式求值/求值轨迹/短路、赋值、变量声明、块作用域）、explain.ts（文案）、run.ts
- 步骤/快照机制 + if 语句 + 步数保护骨架
- 出口：tests/expr、tests/var-scope、tests/if、tests/snapshot 全绿

## Phase 4 — 控制流

- while / for / do-while / break / continue / switch（穿透）/ goto（信号机制）
- 出口：tests/loops、tests/switch、tests/goto 全绿

## Phase 5 — 函数与递归 + 内置 printf

- 调用栈、参数传递、返回值、递归深度保护、builtin printf/puts
- 出口：tests/function、tests/recursion 全绿；示例级集成测试过半

## Phase 6 — 数组与指针

- 内存模型（抽象地址/连续分配）、一维数组声明/初始化/读写、& 与 *、指针重指向、越界/空指针错误
- 出口：tests/array、tests/pointer 全绿；示例库全部 19 例集成测试通过

## Phase 7 — UI

- App 布局、播放器状态机、CodeMirror 行高亮、变量/内存/调用栈/控制流/输出面板、时间轴与控制按钮、示例库、错误横幅
- 出口：build 通过；手工走查核心交互

## Phase 8 — 集成打磨与浏览器实测

- 错误呈现、保护机制 UI、键盘快捷键、边界情况（空程序、仅 main、错误代码连续编辑）
- 浏览器自动化实测（browser-use）：完整教学流程走查 + 截图复核
- 出口：完成标准（任务书 §十六）逐条核对通过

## Phase 9 — 最终质量审计与发布

- 六项审计：Architecture / Interpreter / Parser / UI / Error Handling / Test Coverage（重点：控制流、作用域、优先级、状态回退、switch 穿透、break/continue、goto、递归栈、指针状态）
- 审计发现的问题修复 + 测试补齐
- FINAL_REPORT.md；`npm run lint && typecheck && test && build` 全绿
- git tag v1.0.0；推送 GitHub 仓库 C-Visualizer（禁止 force push）

## v1.0.1 — Public Release Hardening（2026-09）

- [x] 仓库审计（P10_PUBLIC_RELEASE_HARDENING.md §1）；修复 ControlFlowPanel 历史事件重复、CodeEditor 重复 Effect
- [x] LICENSE（标准 MIT）+ CI（push/PR 质量门禁）+ GitHub Pages 自动部署（/C-Visualizer/ base）
- [x] wasm 加载失败 UI 明确提示；可访问性基础检查；窄窗口基本可用
- [x] README Public Release 化；文档一致性回归测试；发布回归测试套件
- [x] v1.0.1 tag + GitHub Release

## v1.1.0 — Semantic Conformance Hardening（2026-09）

> 设计文档 P12_V1.1_SEMANTIC_HARDENING.md；语义规范 SEMANTIC_MODEL.md（新增）。
> 目标：不是支持更多 C，而是让已支持的 C 更可信。

- [x] **作用域**：TypeEnvironment 词法作用域栈（scope-env.ts + 单测）；check.ts 删除
  扁平 env——静态可见性与运行时块作用域一致（任务书案例 1-6 全部达标）
- [x] **运行时收敛**：统一 coercion.ts；return / 参数绑定 / 数组元素 / writeCell
  全部走同一实现；Return Checker 类型兼容校验
- [x] **控制流合法性**：break/continue 静态检查（loopDepth/switchDepth）；
  breakableStack 归属展示（switch 内 break 显示「跳出 switch」）
- [x] **初始化语义**：存储期策略——全局零初始化 / 局部（含数组）未初始化 /
  初始化列表前缀 + 剩余补零；行为修正记入 CHANGELOG
- [x] **goto 加固**：跳入嵌套块/兄弟块编译期拒绝（消除用户可触发 E_INTERNAL）；
  跳过的声明补声明为未初始化
- [x] **E_UB 静态检测**：副作用求值顺序分析（side-effects.ts）——i++ + i++、
  i = i++、f(i++, i++)、a[i] = i++ 等编译期拒绝；赋值豁免与序列点分区
- [x] **测试**：278 → 441+（新增 scope/coercion/control-flow/init/goto/ub/invariant/
  property/差分语料基准）；差分测试 gcc 可用即实跑（本地 skip 记录
  DIFFERENTIAL_COMPILER_UNAVAILABLE，CI ubuntu 实跑）
- [x] **性能**：示例库步骤数与快照字节与 v1.0.2 完全一致，耗时同量级（无回退）
- [x] v1.1.0 tag + GitHub Release

## v1.2.0 — Runtime Architecture Hardening（2026-09）✅

> 设计文档 P13_V1.2_RUNTIME_ARCHITECTURE.md；协议与存储规范 WORKER_PROTOCOL.md /
> TRACE_STORE.md（新增）。目标：不是支持更多 C，而是重构执行架构。

- [x] **Worker 化**：compile + Interpreter 移入 Web Worker（runtime.worker /
  worker-core / client / trace-assembler）；主线程零解释执行
- [x] **类型化流式协议**：全消息 runId 防竞态；STEP_BATCH 批量（100 步）；
  READY 看门狗 / 故障恢复 / Worker 重建
- [x] **取消**：terminate 硬取消 + shouldCancel 协作检查点 + `cancelled` 终态；
  停止按钮 / 编辑自动取消 / 切换示例终止
- [x] **TraceStore + Checkpoint/Delta**：锚点 100 步 + 逐步 diff 增量（snap-set 兜底）；
  二分重建 + LRU；内存 −93.8%（10k×500 实测）
- [x] **金标等价**：21 示例 + 14 边缘语料逐步 deepEqual；K 扫描；1000 次随机 seek
- [x] **Bundle 拆分**：main 954→774 KB，worker chunk 156 KB，tree-sitter 出主入口
- [x] **浏览器实测**：主线程最大长任务 69ms；10k 程序端到端 2.2s；取消/连跑/编辑
  竞态 10/10 通过（scripts/browser-stress.mjs）
- [x] **压测回归**：undefined 选项覆盖默认保护的 bug 修复；100 连跑无泄漏
- [x] v1.2.0 tag + GitHub Release

## v1.3 候选（仅记录）

- 边执行边播放（流式期间允许拖动已生成部分的时间轴）
- Worker 内分块执行（shouldCancel 真正接管远程取消，消除 terminate 重建成本）
- 函数体内部副作用与调用点表达式的作用（跨函数 E_UB 分析）
- 三目运算符、位运算、printf 宽度/精度（`%5d`、`%.2f`）、二维数组
- 字符串（char 数组）基础操作、scanf 模拟输入
- 控制流图可视化（CFG 面板）、单步表达式树展示
- 国际化（英文 UI）、深色模式、移动端布局
