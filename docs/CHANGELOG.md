# 更新日志（CHANGELOG）

所有对外可见的变化记录于此。格式参考 Keep a Changelog；版本号遵循语义化版本。

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
