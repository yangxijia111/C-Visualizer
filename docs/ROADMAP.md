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

## v1.1 候选（仅记录，不在 v1.0 实施）

- 三目运算符、位运算、printf 宽度/精度（`%5d`、`%.2f`）、二维数组
- 字符串（char 数组）基础操作、scanf 模拟输入
- 控制流图可视化（CFG 面板）、单步表达式树展示
- 国际化（英文 UI）、深色模式、移动端布局
