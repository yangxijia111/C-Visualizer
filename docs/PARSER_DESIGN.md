# 解析器设计（PARSER_DESIGN）

## 1. 技术选型结论

**选定方案 A：成熟开源解析器（tree-sitter-c）生成 CST，自研转换层产出教学 AST，自研解释器执行教学子集。**

### 1.1 候选方案评估

| 方案 | 说明 | 评估结论 |
| --- | --- | --- |
| A. tree-sitter-c + 自研转换/解释 | web-tree-sitter(wasm) 浏览器友好；C 语法树久经生产检验（Neovim 等编辑器生态）；错误恢复带行列位置 | ✅ 采用 |
| B. 成熟 Parser + Instrumentation | 无可用的、可维护的 C 解释器级 JS 库；插桩路线无从谈起 | ❌ 不存在成熟选项 |
| C. 完全自研 C 解析器 | 需要 C 全部词法/声明语法（声明符、类型名、预处理兼容），错误面大；仅为避免依赖而自研不可取 | ❌ 备而不用（仅在 tree-sitter 集成失败时启用，见 §5） |
| D. clang/完整 C 编译器 wasm | 体积巨大、产物面向编译而非教学解释 | ❌ |

### 1.2 选型依据（2026-09 实测 spike，脚本保留在 `scripts/parser-spike.mjs`）

- `web-tree-sitter@0.27.0`：MIT；ESM 导出 `{ Parser, Language }`；运行时自带 `web-tree-sitter.wasm`。
- `tree-sitter-c@0.24.1`：MIT；npm 包内直接附带 `tree-sitter-c.wasm`（无需本地编译）；与 0.27 运行时 ABI 兼容。
- 教学子集全部语句形态实测解析正确：`declaration`（含 `init_declarator` / `pointer_declarator` / `array_declarator` 多声明符）、`if_statement`（condition/consequence/alternative=else_clause）、`switch_statement`、`for_statement`（initializer/condition/update）、`while_statement`、`do_statement`、`goto_statement`、`labeled_statement`、`function_definition`（type/declarator/body 字段齐全）。
- 错误恢复：`int a = ;` 产出带行列的 ERROR 节点；`return 0`（缺分号）产出 MISSING 节点。
- 合法但超范围的 C（如 `struct`）不报语法错误 → 由语义检查层（`check.ts`）拒绝，给出「不支持特性」错误。
- 体积：web-tree-sitter 运行时 wasm 约 300KB + tree-sitter-c 语法 wasm 约 1.3MB（gzip 后约 0.4MB），教学工具可接受。

### 1.3 API 兼容性备忘（0.27）

- 导入：`import { Parser, Language } from 'web-tree-sitter'`（无默认导出）。
- 初始化：`await Parser.init()`；语法加载：`await Language.load(wasmPathOrBuffer)`。
- 字段访问：`node.childForFieldName(name)`、`node.fieldNameForChild(index)`（**没有** `node.fields` 属性）。
- 位置：`node.startPosition` / `node.endPosition` 为 `{ row, column }`（0 基），转 1 基后写入 AST。
- 判错：`node.hasError`、`node.type === 'ERROR'`、`node.isMissing`。

## 2. 解析管线

```
source ──(tree-sitter)──► CST ──(convert.ts 递归下降遍历)──► 教学 AST
                              │
                              └─ hasError → 收集 ERROR/MISSING 节点 → E_SYNTAX 错误（行:列+中文提示），终止
```

- **单文件程序**：仅接受一个 `.c` 翻译单元；不支持 `#include`/宏（见 `SUPPORTED_C.md`）。
- **转换原则**：CST 节点 → 教学节点一一映射；无法映射的合法 C 节点（struct/enum/位运算等）原样带位置抛出 `E_UNSUPPORTED`。
- **每个 AST 节点必带**：`line, column, endLine, endColumn`（1 基）与 `text`（源码切片，供 UI 展示）。

## 3. 声明符（declarator）处理

C 声明语法是解析最难的部分，映射规则：

| CST 形态 | 含义 | 教学 AST |
| --- | --- | --- |
| `primitive_type` + `init_declarator(declarator: identifier, value)` | `int a = 1` | VarDecl（标量） |
| `pointer_declarator(declarator: identifier)` | `int *p` | VarDecl（指针类型 `int*`） |
| `array_declarator(declarator: identifier, size: expr)` | `int a[5]` | VarDecl（数组，长度必须为 ≥1 的整型常量表达式） |
| 声明符链嵌套 | `int **pp`、`int *a[3]` | v1.0 仅支持一层指针；`**` / 指针数组 → E_UNSUPPORTED |
| `function_declarator` 出现在声明中 | 函数原型 | v1.0 忽略原型（调用不要求先声明） |

## 4. 错误恢复与定位

- 解析后若 `rootNode.hasError`：深度优先收集第一个（优先最靠前的）ERROR/MISSING 节点，转换为 `E_SYNTAX { line, column, message }`。
- message 生成规则：优先用 tree-sitter 节点上下文生成中文提示（如「这里缺少分号」「无法识别的表达式」），无法归类时回退为通用消息 + 原文片段。
- 一次最多报告 1 条语法错误（错误恢复的中后段质量不可靠，宁可让用户先修第一条）。

## 5. 回退预案（仅在集成失败时启用）

若 web-tree-sitter 在浏览器构建/运行中出现不可修复的问题（wasm 加载失败且无法解决），回退为**自研教学子集递归下降解析器**（ Pratt 表达式 + 声明符解析），并同步更新本文件、`ARCHITECTURE.md`、`CHANGELOG.md`。判定标准：浏览器端加载失败且 2 个工作日内无法修复。

## 6. 已知限制

- 不解析预处理指令（`#include` 等遇到即报 E_UNSUPPORTED，提示「教学版无需 include」）。
- 不支持三移符 `??`（C 的 `?:` 在 v1.0 属不支持特性，见 SUPPORTED_C.md）。
- 解析器为全量 C 语法，因此子集外的合法 C 不会报「语法错误」，而是统一由语义检查报「不支持特性」——这是有意设计，错误分类更准确。
