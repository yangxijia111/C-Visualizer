# 错误规范（ERROR_SPEC）

> 原则：用户代码的任何错误都不允许导致页面崩溃；错误必须可定位（行:列）、可分类、中文可读。

## 1. 错误分类总览

```
CompileError（编译期，run 之前）
 ├─ phase: 'parse'    → E_SYNTAX        语法错误（tree-sitter ERROR/MISSING）
 └─ phase: 'check'
     ├─ E_UNSUPPORTED  不支持的 C 特性（合法 C 但超出教学子集）
     ├─ E_TYPE         类型错误（%作用非整型、数组赋值、指针类型不匹配…）
     ├─ E_LABEL        标签重复 / goto 目标不存在 / 标签后无语句
     ├─ E_CONST        非常量表达式用于 case 标签 / 数组长度 / 全局初始化
     ├─ E_NO_MAIN      缺少 main / 多个 main
     └─ E_DECL         声明错误（重定义、数组初始化个数超长…）

RuntimeError（执行期，作为终止步骤）
 ├─ E_DIV_ZERO        除数为 0（/ 或 %）
 ├─ E_UNINIT_READ     读取未初始化标量
 ├─ E_UNDEF_VAR       使用未声明变量（含 goto 跳过声明）
 ├─ E_NULL_DEREF      解引用空指针 / 未初始化指针
 ├─ E_BAD_DEREF       解引用非指针
 ├─ E_ARRAY_BOUND     数组下标越界
 ├─ E_STACK_DEPTH     调用深度超过 100
 ├─ E_NO_RETURN       非 void 函数执行完毕没有 return
 ├─ E_PRINTF          printf 格式符/参数错误、不支持的格式符
 └─ E_INTERNAL        引擎内部错误（防御性，正常不应出现）
```

## 2. 错误对象结构

```ts
interface CompileError {
  phase: 'parse' | 'check';
  code: ErrorCode;          // 上表中的 E_*
  line: number; column: number;       // 1 基
  endLine?: number; endColumn?: number;
  message: string;          // 中文主消息
  hint?: string;            // 替代建议（E_UNSUPPORTED 必填）
}

interface RuntimeStepError {
  code: RunErrorCode;
  line: number;
  message: string;          // 例：「第 12 行：除数为 0，整数除法的结果未定义。」
}
```

## 3. 消息文案规范

- 格式：`第{line}行第{column}列：{问题}。`，hint 单独一行：`建议：{替代写法}。`
- E_UNSUPPORTED 必须点名特性并给建议，例如：
  - `第4行第5列：v1.0 不支持 struct（自定义类型）。建议：使用独立变量或数组替代。`
  - `第7行第12列：v1.0 不支持位运算 <<。建议：使用乘除法演示。`
  - `第2行第1列：教学版无需 #include。printf/puts 已内置。`
- 运行时错误必须含行号与原因，例：
  - `第 8 行：读取了未初始化的变量 a。C 语言中未初始化的局部变量值不确定，请先赋值。`
  - `第 15 行：数组下标越界：a[5]，数组 a 长度为 5（有效下标 0～4）。`
  - `第 6 行：短路保护触发前的第 10000 步执行完毕，程序可能存在无限循环，已自动停止。`（step-limit 用说明区提示而非 error 徽标）

## 4. 呈现位置

| 错误类型 | 呈现 |
| --- | --- |
| CompileError | 顶栏下红色横幅逐条列出；编辑器对应行标记；不产生任何步骤 |
| RuntimeError | 终止步骤：状态徽标 ❌ + 说明区红色文字；各面板冻结在错误时刻快照 |
| step-limit | 终止步骤：状态徽标 ⚠ + 提示语（黄色，不算错误） |
| 引擎内部异常 | UI 层 try/catch + React ErrorBoundary 兜底，显示通用「发生内部错误」并保留界面可用 |

## 5. 防崩溃机制

1. `compile()` / `run()` 内部全量 try/catch：任何意外异常转为 `E_INTERNAL` 结构化结果。
2. 解释器墙钟保护（10s）防死循环卡死主线程（见 EXECUTION_ENGINE §7）。
3. UI 事件处理器逐个 try/catch；顶层 ErrorBoundary 防渲染异常白屏。

## 6. 测试要求

每类错误码至少 1 条正/反测试（见 TEST_PLAN.md §5）；错误行号必须与源码实际位置一致（断言 line/column）。
