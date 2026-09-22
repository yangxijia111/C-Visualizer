# 执行引擎设计（EXECUTION_ENGINE）

> 解释器一次同步执行整个程序，产出 `RunResult`；UI 对步骤数组做纯索引播放。

## 1. 顶层 API

```ts
// 编译：源码 → Program 或错误列表
compile(source: string): Promise<{ ok: true; program: Program } | { ok: false; errors: CompileError[] }>

// 执行：Program → 全部步骤
run(program: Program, opts?: { maxSteps?: number }): RunResult

interface RunResult {
  source: string;               // 原文（供 UI 切片）
  initialSnapshot: Snapshot;    // 第 0 步之前的状态（全局初始化前）
  steps: ExecutionStep[];       // steps[i].snapshot = 第 i 步执行后的状态
  status: 'completed' | 'step-limit' | 'time-limit';
  output: string;               // 最终 printf 输出
}
```

运行时错误**不抛异常**：作为带 `status: 'runtime-error'` 的终止步骤存入 steps（见 §6）。

## 2. 执行步骤（ExecutionStep）

```ts
interface ExecutionStep {
  id: number;                          // 0 基步号
  line: number; endLine: number;       // 当前语句源码行（1 基）
  statementType: string;               // 'var-decl' | 'assign' | 'if-condition' | ...
  phase?: string;                      // 'init' | 'condition' | 'body' | 'update' 等
  snapshot: Snapshot;                  // 本步执行后的完整状态
  changed: {                           // 与上一步的差异定位（UI 高亮）
    addresses: number[];               // 变化的内存单元
    scopeIds: number[];                // 新增/移除的作用域（如进/出块）
  };
  evalTrace?: EvalItem[];              // 表达式求值轨迹（按求值顺序）
  flowEvents: FlowEvent[];             // 控制流事件（见 VISUALIZATION_SPEC §5）
  description: string;                 // 中文教学说明（确定性模板生成）
  status: 'ok' | 'runtime-error' | 'program-end';
  errorCode?: RunErrorCode;            // status = runtime-error 时
  outputDelta?: string;                // 本步新增的 printf 输出
}

interface EvalItem =
  | { kind: 'eval';  text: string; value: RuntimeValue }           // 求值：源码片段 → 值
  | { kind: 'assign'; text: string; target: string; value: RuntimeValue }
  | { kind: 'skip';  text: string; reason: string }                // 短路未求值的右侧
```

## 3. 运行时状态模型

```ts
// 抽象地址：全局递增编号（0 保留给「空指针」）
type Address = number;

// 内存单元（每个标量占一个单元；数组分配 length 个连续抽象地址）
interface MemoryCell {
  type: 'int'|'char'|'float'|'double'|'pointer';
  value: number | null;        // pointer 存目标 Address；未初始化时 null（读取即报错）
}

// 变量
interface Variable {
  name: string; type: CType;
  address: Address | null;     // 数组 = 首元素地址；标量 = 自身单元
  length?: number;             // 数组专用
}

// 作用域
interface Scope {
  id: number; kind: 'global'|'function'|'block'|'for';
  label: string;               // 展示名：'全局' / 'main(参数+局部)' / '块(第12行)' / 'for(第15行)'
  parent: number | null;
  vars: Variable[];
}

// 快照（完全可序列化；UI 只读）
interface Snapshot {
  scopes: Scope[];                 // 当前存活的作用域链（0=全局，按创建序）
  cells: Record<Address, MemoryCell>;
  callStack: StackFrame[];         // 空帧 = main 即将执行
  nextAddress: Address;            // 地址分配计数（保证跳转/回放一致）
  output: string;                  // 累计输出
}

interface StackFrame {
  functionName: string;
  scopeId: number;                 // 该帧的函数作用域
  returnValue?: RuntimeValue;      // 返回后标记
  callLine: number;                // 调用点行号
}
```

**快照策略**：每步把当前状态深拷贝（`structuredClone` 等价的手写克隆）存入该步。教学规模（<100 单元 × ≤10000 步）下内存与耗时完全可控； Previous / Jump 直接读快照，**绝不重新推演**。

**指针可视化**：地址只是抽象编号（#1、#2…），变量表提供 `address → 变量名` 反查，UI 把 `p` 渲染为 `p → #3 (x)`。

## 4. 控制流实现：信号机制

解释器用内部信号对象（异常）传递跳转，各层级捕获：

| 信号 | 抛出点 | 捕获点 |
| --- | --- | --- |
| `BreakSignal` | break 语句 | 最近的循环执行器或 switch 执行器 |
| `ContinueSignal` | continue | 最近的循环执行器（for 先跑 update） |
| `ReturnSignal(value)` | return | 函数调用边界 |
| `GotoSignal(label)` | goto | **函数体边界**：沿语句块向外冒泡，每层块检查本块是否含目标标签；命中则从该标签语句继续执行（进入块时正常建作用域，跳过的块不建作用域）；冒泡中逐层恢复作用域深度 |

作用域栈以「深度记录」保证信号冒泡时正确弹出（`env.push/pop` 与 try/finally 配对）。

**goto 与作用域**（v1.1.0 语义，见 SEMANTIC_MODEL §2.4）：静态检查器只允许
「同一语句序列内跳转」与「跳出到外层序列」——跳入嵌套块 / 兄弟块 / case 体 /
if 单语句分支在编译期拒绝（E_LABEL）。前向 goto 跳过的顶层声明在跳转时
**补创建为未初始化**（对齐 C 块作用域：跳过初始化 = indeterminate，读取报
E_UNINIT_READ）；后向 goto 重新经过声明时复用存储单元并重新初始化。

## 4.1 运行时收敛与初始化策略（v1.1.0）

所有「值进入对象」的边界共用 `src/core/coercion.ts` 的 `coerceRuntimeValue(value, target)`：

| 边界 | 收敛目标 |
| --- | --- |
| 变量初始化 / 赋值写回（writeCell） | 声明 / 左值类型 |
| 形参绑定（callFunction） | 形参类型（调用步骤展示转换后的值） |
| return（execStmt 离开函数前） | 函数返回类型 |
| 数组初始化列表元素 / 数组元素赋值 | 数组元素类型 |

规则：int → `Math.trunc | 0`；char → 低 8 位（0～255）；float/double → 数值不变；
pointer → 值不变（类型由检查器保证）。

**存储期初始化策略**（`Interpreter.currentStorage`）：执行全局声明期间为 `'static'`
（无初始化式 → 零初始化，含数组全元素与指针 NULL），进入任意函数体后为 `'auto'`
（无初始化式 → 未初始化，读取报 E_UNINIT_READ）。带初始化列表的数组无论存储期
都是「前缀收敛写入 + 剩余零初始化」。

## 4.2 控制流归属展示（v1.1.0）

`Interpreter.breakableStack` 记录进入顺序上的可中断构造（loop 携带循环类型 / switch），
循环与 switch 执行器 try/finally 维护：`break` 的控制流事件 `from` 取栈顶
（switch 内 break 显示「跳出 switch」）；`continue` 自栈顶向下找最近循环并标注
真实类型（for 的 continue 说明指向更新表达式）。合法性由检查器的
loopDepth / switchDepth 保证。

## 5. 步骤粒度规范（教学可读性优先）

| 程序事件 | 步骤数 | 步骤内容 |
| --- | --- | --- |
| 变量声明/初始化 | 1 | 声明 + 初始化求值轨迹 |
| 赋值/表达式语句 | 1 | 完整求值轨迹（子表达式按序展示，短路含 skip 项） |
| `if` | 2 | ①求值条件 ②判定走向（真→进入第 N 行 / 假→跳到第 N 行） |
| `while` / `do-while` 每次判断 | 1 | 条件求值 + 成立与否 + 去向 |
| `for` init / 每次判断 / update | 各 1 | 三段独立展示 |
| `switch` | 2 | ①判别式求值 ②匹配区段（case N / default / 无匹配） |
| fall-through 穿透 | 1 | 「case N 结束且无 break，穿透到 case M」 |
| `break` / `continue` | 1 | 跳出/继续目标 |
| `goto` | 1 | 来源行 → 目标行 |
| 函数调用 | 1 | 参数求值 + 压栈（显示实参→形参） |
| `return` | 1 | 返回值 + 出栈回到调用点 |
| `printf` | 1 | 输出增量显示 |
| 程序结束 | 1 | `main` 返回，status=program-end |

## 6. 运行时错误（终止步骤）

发生即记录一个 `status: 'runtime-error'` 的步骤（含错误码、行号、中文说明），执行终止：
除零（`/`、`%`）、空指针/未初始化指针解引用、读取未初始化标量、未声明变量、数组越界、非 void 函数无返回值、调用深度超 100、printf 参数/格式符错误。

## 7. 保护机制（三重）

1. **步数上限**：`maxSteps` 默认 10000；达到后追加 `status: 'step-limit'` 终止步骤，说明「可能存在无限循环」。
2. **调用深度上限**：100 层。
3. **墙钟**：解释器每 1000 步检查一次耗时，超过 10 秒强制以 `time-limit` 终止（防御快照克隆被恶意构造放大的极端情况）。

## 8. 确定性

- 地址分配、作用域 id、步骤序列完全由程序决定 → 同一程序两次运行步骤序列逐位相同（可测试断言）。
- 禁止任何随机性 / 时间依赖 / 迭代顺序不确定的遍历（Map 一律用数组或排序键）。
