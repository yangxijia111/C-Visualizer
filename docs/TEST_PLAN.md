# 测试计划（TEST_PLAN）

> 核心原则：Parser + Interpreter 是项目生命线，每个特性、每类错误都必须有自动化测试；**每次修改解释器/转换器后必须全量重跑测试**（`npm run test`）。

## 1. 测试栈与组织

- 框架：vitest（Node 环境，直接测 `src/core`，无 DOM 依赖）。
- 目录：`tests/`，按特性分文件：

```
tests/
├── helpers.ts              # runSrc(src) 等测试工具
├── convert.test.ts         # CST→AST：声明、优先级、不支持特性
├── check.test.ts           # 语义检查：类型、标签、main、常量
├── expr.test.ts            # 表达式求值：算术/比较/逻辑/优先级/短路/++/复合赋值
├── loops.test.ts           # for / while / do-while / break / continue
├── switch.test.ts          # 匹配 / default / 穿透 / break
├── goto.test.ts            # 前向 / 后向 / 循环式 goto / 跳出
├── function.test.ts        # 参数 / 返回值 / 局部作用域 / printf
├── recursion.test.ts       # factorial / fibonacci
├── array.test.ts           # 声明 / 初始化 / 读写 / 遍历 / 越界
├── pointer.test.ts         # & / * 读写 / 指针赋值 / 指向数组元素
├── protection.test.ts      # 死循环保护 / 深度上限
├── audit.test.ts           # 审计回归（快照一致性 / 确定性）
├── examples.test.ts        # 示例库完整性
├── release.test.ts         # 发布回归（文档一致性 / Pages base / 导出稳定）
├── run-state.test.ts       # UI 纯逻辑（stale/播放）
├── scope-env.test.ts       # TypeEnvironment 作用域栈单元测试（v1.1.0）
├── semantic/               # v1.1.0 语义加固套件
│   ├── scope.test.ts           # 词法作用域回归（任务书案例 1-6 + for/switch/形参）
│   ├── return-coerce.test.ts   # 统一收敛：return/参数/数组元素 + Return Checker
│   ├── control-flow.test.ts    # break/continue 静态合法性 + 归属展示
│   ├── initialization.test.ts  # 存储期初始化矩阵（global 零 / local 未初始化）
│   ├── goto-scope.test.ts      # goto 支持矩阵（跳入拒绝 / 跳出合法 / 跳过声明）
│   ├── ub.test.ts              # E_UB 判定表（双写/读写竞争/赋值豁免/序列点分区）
│   ├── invariant.test.ts       # E_INTERNAL 不变量 + Checker/Interpreter 转换一致性
│   └── property.test.ts        # 随机 int 表达式 vs 独立 int32 参考模型（300 样本）
└── differential/           # 差分测试（v1.1.0）
    ├── corpus.ts               # 26 个 defined-behavior 程序语料
    ├── corpus-expected.test.ts # 本地基准：预期输出按 C 语义手工推演（始终运行）
    └── diff-gcc.test.ts        # gcc/clang 可用时真实编译比对（无编译器优雅跳过）
```

## 2. 测试工具（helpers.ts）

```ts
interface RunOutcome {
  ok: boolean;
  errors?: CompileError[];
  result?: RunResult;
  finalVar(name: string): RuntimeValue | undefined;   // 最终快照中的变量
  varAtStep(i: number, name: string): ...;
  stepKinds(): string[];                              // 逐步 statementType/phase 序列
  descriptions(): string[];
  output(): string;
}
function runProgram(src: string, opts?): RunOutcome
```

## 3. 必测行为矩阵（每格 ≥1 测试）

### 3.1 表达式
- 优先级：`1 + 2 * 3 == 7`；`(1+2)*3`；`2 < 3 == 1`（C 优先级陷阱不测 UB，仅子集内）；`a = b = 5` 连续赋值。
- 整数除法：`7/2==3`、`-7/2==-3`、`7%3==1`、`-7%2==-1`；浮点除法 `5.0/2==2.5`。
- `++i` / `i++` 前后置差异；`--`；复合赋值 `+=` 等。
- 比较结果为 0/1；`!` 语义。
- 短路：`0 && f()`（f 未执行，轨迹含 skip 项）；`1 || f()`；`1 && f()`（执行）；`0 || f()`（执行）。
- char 参与算术：`'A'+1==66`。
- 除零 → E_DIV_ZERO 且行号正确。

### 3.2 变量与作用域
- 全局/局部/块级声明；内层遮蔽外层（结束后外层恢复原值）。
- 未初始化读取 → E_UNINIT_READ（局部标量与局部数组元素）；全局未初始化 → 零初始化。
- for-init 变量循环外不可见 → **编译错误 E_UNDEF_VAR**（v1.1.0：静态与运行时一致）。
- 块内声明块外使用 → 编译错误；同作用域重复声明 → E_DECL；形参与顶层声明同层。

### 3.3 控制流
- if 真/假/嵌套/dangling-else 归属。
- switch：命中 case、default 位置在中间/末尾、fall-through（case 2 → case 3 连穿）、break 跳出、无匹配且无 default、case 标签常量表达式（`case 1+1:`）。
- 循环：for 三段步骤序列（init→condition→body→update→condition…）；while 先判后行；do-while 至少执行一次；break 跳出（switch 内的 break 不跳出循环，展示 from='switch'）；continue 跳过本轮（for 仍执行 update；while 直接回条件）。
- **break/continue 静态合法性（v1.1.0）**：顶层 / switch 内 continue / 函数体内（调用点在循环中）→ 编译错误 E_TYPE。
- goto：前向跳过语句、后向构造循环、跨出循环块、goto 到函数末尾标签；
  **跳入嵌套块 / 兄弟块 → 编译错误 E_LABEL；跳过的声明读取报 E_UNINIT_READ（v1.1.0）**。

### 3.4 函数与递归
- 参数按值（形参修改不影响实参）；**实参收敛到形参类型（f(1.9) → int 1，v1.1.0）**；
  返回值；void 函数；局部变量与全局同名遮蔽。
- **返回值收敛到函数返回类型（int f(){return 1.9;} → 1，v1.1.0）**；return 类型兼容检查。
- factorial(5)==120：逐步调用栈深度递增后递减；调用栈快照断言帧序列。
- 非 void 无 return → E_NO_RETURN。

### 3.5 数组
- `int a[5];` 局部声明（元素未初始化，读取报 E_UNINIT_READ）；`{1,2,3}` 补 0；读写；遍历求和；越界 → E_ARRAY_BOUND；数组长度非常量 → E_CONST；全局数组 → 零初始化。

### 3.6 指针
- `int *p = &a; *p = 20;` 后 a==20；`*p` 读值；p 重新赋值改指向；`&arr[2]` 后 `*p` 即 a[2]；解引用未初始化指针 → E_NULL_DEREF。

### 3.7 错误与保护
- 语法错误：`int a = ;`、缺分号、缺右括号 → E_SYNTAX + 行列号断言。
- 不支持特性：struct、#include、二维数组、位运算、三目、`%5d`、scanf、sizeof、强转 → E_UNSUPPORTED + hint 非空。
- 类型错误：%浮点、数组赋值、指针与 int 混赋。
- **E_UB（v1.1.0）**：`i++ + i++`、`i = i++`、`i++ + i`、`f(i++, i++)`、`f(i++, i)`、
  `a[i] = i++`、`a[i++] = i`、printf 参数同名冲突 → 编译拒绝；
  合法反例（`x = x + 1`、`x += x`、`a[i++] = 1`、`i++ && i++`）不误杀。
- 死循环：`while(1){}` → 10000 步 step-limit 终止；无限递归 → E_STACK_DEPTH。

### 3.8 快照与步骤
- 步骤序列确定性：同一程序运行两次 steps 完全一致（JSON 相等）。
- `steps[i-1].snapshot` 与回退语义一致；跳转任意步后快照与一次性执行到该步的快照相同（抽查明确定性）。
- 每步 description 非空。

### 3.9 语义不变量与差分（v1.1.0）
- E_INTERNAL 不变量：示例库 + 差分语料 + 边界程序执行零 E_INTERNAL（invariant.test.ts）。
- Checker/Interpreter 转换一致性：double→int / int→double / int→char 在
  初始化/赋值/参数/返回/数组元素五个边界同规则。
- 差分语料本地基准：26 程序的输出与手工按 C 语义推演的预期一致（始终运行）。
- gcc/clang 差分：有编译器时真实编译执行比对 stdout（CI ubuntu 实跑；本地跳过并
  记录 DIFFERENTIAL_COMPILER_UNAVAILABLE）。
- Property：300 个随机 int 表达式（种子固定）与独立 BigInt int32 参考模型一致。

## 4. 集成测试

- SUPPORTED_C §4 验收代码 + 19 个内置示例逐个「可运行、正常完成、无运行时错误」。
- 完成标准中的核心样例逐步断言：`int a=1; int b=2; if(a<b){a++;} return 0;` 的步骤序列与最终 a==2。

## 5. UI 测试策略

- UI 逻辑不在 vitest 内做组件级单测（成本高收益低），以「构建通过 + 浏览器实测」保障：
  - Phase 8 使用浏览器自动化（browser-use）走查：示例载入 → Run → Next×N → Previous → Restart → 拖动时间轴 → 错误代码不崩溃。
  - 关键视觉断点截图人工复核（行高亮、变量高亮、数组格子、调用栈）。

## 6. 质量门槛（每个 Phase 出口）

```
npm run lint && npm run typecheck && npm run test && npm run build   # 全绿
```

新增/修改解释器行为的 commit 必须包含对应测试更新。
