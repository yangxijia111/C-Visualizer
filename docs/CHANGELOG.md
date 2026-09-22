# 更新日志（CHANGELOG）

所有对外可见的变化记录于此。格式参考 Keep a Changelog；版本号遵循语义化版本。

## [1.0.2] - 2026-09-22

### Maintenance Fix

- **修复（核心）**：编辑源码后旧的可视化结果不再被当作当前源码的结果——新增「源码已修改」
  （sourceDirty）状态：右侧变量 / 内存 / 调用栈 / 控制流 / 输出继续显示上一次运行的数据供参考，
  但顶部显示明确横幅「⚠ 源码已修改，当前可视化结果来自上一次运行，请重新运行」并提供
  「重新运行」按钮（`role=status`，不依赖颜色传达信息）
- **修复**：stale 状态下当前执行行高亮取消（旧行号不再错误映射到已修改源码）
- **修复**：stale 状态下播放控制统一禁用（上一步 / 下一步 / 播放 / 重新开始 / 时间轴，
  以及 ←/→/空格键盘快捷键），「▶ 运行」保持可用
- **修复**：编译失败后的状态语义明确化——显示编译错误，旧结果保留但继续标记为旧结果，
  不允许播放；重新运行成功后自动脱离 stale 状态
- **修复**：加载内置示例为完整上下文切换——旧运行结果 / 步骤 / 时间轴 / 错误全部清空，等待重新运行
- **清理**：CallStackPanel 移除冗余三元表达式（`frames[idx + 1] ? f.callLine : f.callLine`，行为不变）
- **维护**：修正 v1.0.1 GitHub Release Notes 中最终报告的链接为 main 分支绝对路径
  （该文档在 v1.0.1 tag 快照中不存在）
- **维护**：设置 Repository homepage 为在线 Demo（https://yangxijia111.github.io/C-Visualizer/）
- **工程**：Dirty State 判定提取为 `src/ui/run-state.ts` 纯函数（播放禁用 / 当前行可见性 /
  stale 标记 / 状态转移），新增 `tests/run-state.test.ts` 回归（261 → 278 项）

## [1.0.1] - 2026-09-22

### Public Release Hardening

- **License**：新增标准 MIT LICENSE 文件，package.json 声明 `license: MIT`，与 README 保持一致
- **CI**：新增 GitHub Actions（`.github/workflows/ci.yml`），push(main) 与全部 PR 触发
  lint / typecheck / test / build 质量门禁（Node 22 + 24 矩阵，npm cache）
- **在线 Demo**：新增 GitHub Pages 自动部署（`.github/workflows/deploy-pages.yml`），
  `--mode pages` 构建使用 `/C-Visualizer/` base，本地 dev / preview 行为不变
- **修复**：控制流面板历史事件与当前事件严格按 step 边界分离——修复当前步含 0 个或
  多个 FlowEvent 时的事件丢失 / 重复显示（此前 `history.slice(0, -1)` 隐含「当前步恰 1 个事件」假设）
- **修复**：CodeEditor 合并重复的高亮 dispatch effect（currentLine / errorLines / value 任一变化只派发一次）
- **修复**：tree-sitter wasm 加载失败时显示明确错误横幅并禁用「运行」，不再只写 console
- **UI**：窄窗口基本可用（纵向堆叠断点）；控件补充无障碍标注（title / aria-label）
- **README**：Public Release 化（在线 Demo、截图、项目结构、已知限制、贡献方式等）
- **测试**：237 → 261 项（新增发布回归：FlowEvent 分离、播放边界纯逻辑、Pages base 构建产物、
  文档与实现一致性、示例库完整性、核心导出稳定）

## [1.0.0] - 2026-09-20

### 新增
- C 教学子集解释器：int/char/float/double、变量与作用域、全部基础运算符（含短路求值）、
  if/else、switch（含穿透）、for/while/do-while、break/continue、goto/标签、
  一维数组、函数与递归、基础指针（& 与 *）、内置 printf/puts
- 步骤化执行引擎：每步含完整快照、变化定位、求值轨迹、控制流事件、中文教学说明
- 播放器：Run / Pause / Next / Previous / Restart / 时间轴跳转 / 0.5～8 步每秒变速
- 可视化 UI：CodeMirror 编辑器（当前行高亮/错误行标记）、变量监视器（变化高亮、
  指针指向）、内存/数组格子、调用栈、控制流轨迹、输出面板
- 示例库 21 个（覆盖任务书全部验收场景）
- 三重保护：10000 步上限 / 100 层调用深度 / 10 秒墙钟
- 错误体系：语法（行列定位）/ 不支持特性（含替代建议）/ 类型 / 运行时 / 死循环
- 测试：233 项（解析 33 + 检查 34 + 表达式 40 + 循环 17 + switch 13 + goto 11 +
  函数 16 + 递归 6 + 数组 14 + 指针 13 + 保护边界 14 + 示例 23 + 审计 12）

### 技术
- 解析：web-tree-sitter 0.27 + tree-sitter-c 0.24（均为 MIT，浏览器/Node 双端）
- 自研：CST→教学 AST 转换、语义检查、解释器、快照模型、说明文案生成
- 栈：React 19 + TypeScript strict + Vite + vitest + ESLint + CodeMirror 6

### 修复（开发过程中发现并修复的关键问题）
- tree-sitter 节点同一性需用 equals（namedChildren 每次返回新包装对象）
- return_statement / case_statement 的字段访问方式（0.24 grammar 无 value 字段的问题）
- 声明符类型组装顺序（二维数组曾被错误折叠为一维）
- Declarator.varType 字段名不一致导致的检查器静默失效
- 后向 goto 重复执行声明导致同名变量重复入作用域（复用已有单元）
- 块级作用域遮蔽被误判为重复声明
- 函数调用嵌套在表达式求值内时草稿单槽被覆盖（改为草稿栈）
- main 终止步骤保留最终变量现场；Halt 信号不弹帧
