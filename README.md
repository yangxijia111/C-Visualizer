# C Visualizer

面向 C 语言初学者的**代码执行可视化教学工具**。在浏览器中输入 C 代码，逐语句执行，直观观察变量、表达式、条件、循环、数组、函数调用栈、switch、goto、指针等状态如何一步一步变化。

## 特性

- **逐步执行**：Run / Pause / Next / Previous / Restart / 时间轴跳转，回退基于快照，绝对精确
- **中文教学说明**：每一步自动生成简短说明（确定性规则，无 AI 依赖）
- **表达式求值轨迹**：子表达式按求值顺序展示「源码 → 值」，短路未执行的右侧明确标注
- **可视化面板**：变量监视器（按作用域分组、变化高亮）、内存/数组格子、指针指向、调用栈、控制流轨迹、printf 输出
- **纯浏览器运行**：tree-sitter-c（wasm）解析 + 自研教学解释器，无后端、无本机编译器依赖
- **错误友好**：语法错误 / 不支持的特性 / 运行时错误 / 死循环保护（10000 步上限）全部有行列级中文提示，绝不崩溃

## 快速开始

```bash
npm install
npm run dev        # 开发服务器
```

```bash
npm test           # 全部测试（233+）
npm run lint       # ESLint
npm run typecheck  # TypeScript strict
npm run build      # 生产构建
```

## 支持的 C 子集

支持 int/char/float/double、变量、运算符（含短路）、if/else、switch（含穿透）、for/while/do-while、break/continue、goto、一维数组、函数与递归、基础指针（& 与 *）、内置 printf/puts。

不支持 struct/enum/typedef、二维数组、指针算术、动态内存、位运算、三目运算符等（遇到会给出明确的不支持提示与替代建议）。

完整清单见 [docs/SUPPORTED_C.md](docs/SUPPORTED_C.md)。

## 架构

```
源代码 → tree-sitter-c 解析（wasm）→ CST → 教学 AST（自研转换）
      → 语义检查（类型/标签/printf 格式）→ 解释器（同步执行）
      → ExecutionStep[]（每步含完整快照 + 中文说明）→ React 可视化
```

详细设计文档见 [docs/](docs/) 目录：

| 文档 | 内容 |
| --- | --- |
| PRODUCT.md | 产品定位与成功标准 |
| REQUIREMENTS.md | 功能与非功能需求 |
| SUPPORTED_C.md | **支持的 C 子集权威清单** |
| PARSER_DESIGN.md | 解析器选型（tree-sitter-c）与转换管线 |
| AST_SPEC.md | 教学 AST 节点定义 |
| EXECUTION_ENGINE.md | 解释器/快照/步骤模型 |
| VISUALIZATION_SPEC.md | UI 布局与可视化规范 |
| ERROR_SPEC.md | 错误分类与文案规范 |
| TEST_PLAN.md | 测试策略 |
| ROADMAP.md | 开发路线 |
| ARCHITECTURE.md | 总体架构 |
| CHANGELOG.md | 变更日志 |
| FINAL_REPORT.md | v1.0 最终报告 |

## 技术栈

React 19 · TypeScript（strict）· Vite · vitest · ESLint · CodeMirror 6 · web-tree-sitter + tree-sitter-c（MIT）

## License

MIT
