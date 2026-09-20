# C Visualizer v1.0 最终报告（FINAL_REPORT）

> 日期：2026-09-20　|　commit：`332956064a3c0850b8594556abfa9d50fae3b8ab`（tag `v1.0.0`）　|　GitHub：https://github.com/yangxijia111/C-Visualizer

## 一、支持的 C 子集（v1.0 实现清单）

权威清单见 [SUPPORTED_C.md](SUPPORTED_C.md)，以下为**实际实现并有测试覆盖**的范围：

- **类型**：`int`（32 位环绕）、`char`（ASCII，低 8 位存储）、`float`/`double`（双精度）、一层指针 `T *`、一维数组 `T[n]`、`void`（仅返回类型）
- **变量**：声明 / 初始化 / 赋值 / 复合赋值（`+= -= *= /= %=`）/ 连续赋值 / 多声明符 / 全局变量（常量初始化）/ 块作用域与遮蔽 / for-init 循环作用域
- **运算符**：`+ - * / %`（整数除法向零截断）、`++ --`（前置/后置）、`! - +`、`== != > < >= <=`、`&& ||`（短路求值）、赋值系列；完整 C 优先级与结合性
- **控制流**：`if / else / 嵌套`、`switch（case/default/break/fall-through 穿透逐步展示）`、`while`、`for`（三段独立步骤）、`do-while`、`break`、`continue`、`goto + 标签`（同函数内前向/后向）
- **函数**：定义、按值传参、指针参数（swap）、返回值、void、递归（深度 100 上限）、先定义后使用不要求
- **数组**：声明即全零、初始化列表（剩余补零）、下标读写（越界报错）、与循环/函数配合
- **指针**：`&变量`、`&a[i]`、`*p` 读写、指针重指向、空指针（`0` / `NULL`）、解引用错误检查
- **内置函数**：`printf`（`%d %i %f %c %s %%` + 常用转义）、`puts`
- **教学简化**（与标准 C 的有意差异，文档 §3 已声明）：未初始化读取报运行时错误、不要求先声明后使用、main 可省略 return（隐式 0）等

## 二、不支持的 C 特性（遇到即给出中文提示 + 替代建议）

`#include` 及预处理指令、`struct / union / enum / typedef`、二维及多维数组、二级指针与指针数组、
指针算术（`p+1`、`p++`）、返回指针的函数、`malloc/free` 等动态内存、`sizeof`、强制类型转换、
位运算（`& | ^ ~ << >>`）、三目 `?:`、逗号运算符、函数指针、`scanf` 等输入函数、
除 printf/puts 外的库函数、`const/static` 等存储类、VLA、K&R 函数、`stdbool`、main 带参数。

## 三、架构

```
源代码 → ① cst.ts：web-tree-sitter 0.27 + tree-sitter-c 0.24（wasm，浏览器/Node 双端）
       → ② convert.ts：CST → 教学 AST（自研转换，保留行列位置与源码切片）
       → ③ check.ts：语义检查（类型 / 标签 / printf 格式 / 常量 / 重定义）
       → ④ interpreter：同步解释执行（信号式控制流 + 草稿栈 + 三重保护）
       → ⑤ RunResult：ExecutionStep[]（每步完整快照 + 求值轨迹 + 控制流事件 + 中文说明）
       → ⑥ React UI：纯索引播放（Next/Prev/Jump/Restart 基于快照，绝不重新推演）
```

- 步骤预计算 + 每步深拷贝快照 → 时间轴任意跳转 O(1) 且绝对精确（ Previous 不猜状态）
- 抽象内存地址（#1、#2…）模拟指针，不模拟物理地址
- 确定性：同一程序两次运行的步骤序列逐位一致（有测试断言）

## 四、Parser

- **选型**：web-tree-sitter 0.27.0 + tree-sitter-c 0.24.1（均 MIT；spike 验证后选定，见 PARSER_DESIGN.md）
- 自研 CST→AST 转换层处理全部声明符形态（`int *p`、`int a[5]`、多声明符、`int* p`）、
  switch 体规整（平铺 case 合并）、`null` 节点折叠、注释跳过、子集外特性拒绝（E_UNSUPPORTED + 建议）
- 语法错误：深度优先收集最早 ERROR/MISSING 节点 → 行:列 + 中文消息（含 missing token 翻译）
- 浏览器加载：wasm 经 Vite `?url` 打包（gzip 后约 160KB）

## 五、Interpreter

- 求值：完整 C 优先级、短路求值（右侧 skip 轨迹 + 说明文案）、复合赋值、前后置自增自减
- 内存：标量/数组元素统一抽象地址编址；重复声明（后向 goto）复用单元并重置
- 控制流：Break/Continue/Return/Goto 信号机制；goto 沿语句序列冒泡定位标签；
  switch 穿透在区段边界生成独立步骤
- 函数：完整调用约定（调用步骤 → 压帧/形参绑定 → 函数体 → 返回步骤/弹帧）；
  递归天然支持；深度/步数/墙钟三重保护
- 文案：explain.ts 确定性模板（短路、穿透、循环判断、goto 来源目标、递归调用等）

## 六、测试结果

```
npm run test → 237 passed (237)
```

| 套件 | 数量 | 覆盖 |
| --- | --- | --- |
| convert.test.ts | 33 | 声明形态、优先级结构、控制流规整、转义/进制、不支持特性、语法错误 |
| check.test.ts | 34 | main 校验、类型规则、标签、printf 格式、常量、重定义 |
| expr.test.ts | 40 | 算术/比较/逻辑/短路轨迹/自增自减/赋值/作用域/if/快照确定性 |
| loops.test.ts | 17 | while/for/do-while 步骤序列、break/continue、嵌套、死循环保护 |
| switch.test.ts | 13 | 匹配/default 位置/穿透步骤/合并标签/char 与常量表达式标签 |
| goto.test.ts | 13 | 前向/后向/跨循环/重复声明回归/嵌套循环跳出 |
| function.test.ts | 16 | 按值传参/遮蔽/调用栈快照/printf 全格式/输出增量 |
| recursion.test.ts | 6 | factorial/fib/帧独立性/无限递归深度保护/gcd |
| array.test.ts | 14 | 全零/初始化列表/遍历/越界/反转 |
| pointer.test.ts | 13 | &/*读写/重指向/swap/指向数组元素/空指针 |
| protection.test.ts | 14 | 空程序/注释/大循环/步数上限/深递归/错误码回归/文档承诺核对 |
| examples.test.ts | 23 | 21 个内置示例全部编译并正常执行 |
| audit.test.ts | 12 | switch+continue、短路副作用、溢出环绕、递归数组独立性、指针状态 |

## 七、构建结果

```
npm run lint       PASS（0 error）
npm run typecheck  PASS（strict 模式 0 error）
npm run test       PASS（237/237）
npm run build      PASS（JS gzip ~290KB + wasm gzip ~160KB）
```

浏览器实测（应用内浏览器 + 截图复核）：
- 「if 判断」验收代码逐步执行，步骤序列与最终变量逐项正确
- 递归阶乘 5 层调用栈（含每帧独立形参与调用点行号）
- 数组格子渲染、变化高亮、作用域分组、控制流轨迹、求值轨迹
- 播放/暂停/步进/时间轴跳转/键盘快捷键
- 语法错误横幅 + 错误行标记，页面不崩溃
- 短路示例显示「check(1)（未执行：&& 左侧为 0（假），短路）」

## 八、审计与修复记录

六项审计（Architecture / Interpreter / Parser / UI / Error Handling / Test Coverage）执行中
发现并修复的问题：

| 问题 | 严重度 | 修复 |
| --- | --- | --- |
| 后向 goto 重复执行声明 → 同名变量重复入作用域 | **高** | declareScalar/declareArray 复用已有单元并重置为未初始化 |
| 块级作用域遮蔽被宽松收集误判为重复声明 | 中 | 检查器按真实作用域链检查（仅同块冲突） |
| 函数调用嵌套在表达式求值内时草稿单槽被覆盖 | **高** | 草稿改为栈结构（外层语句草稿保持在栈底） |
| main 终止步骤丢失局部变量现场 | 中 | main 的返回步骤在弹帧前生成；Halt 信号不弹帧 |
| %s 字符串参数被送入通用表达式求值 | 中 | execPrintf 对 %s 直接取字符串字面量 |
| 调用步骤快照不含新栈帧 | 低 | 先压帧再生成调用步骤 |
| 二维数组声明被错误折叠为一维 | 中 | 声明符类型改为自内向外组装 |
| 注释节点出现在语句位置导致 E_UNSUPPORTED | 低 | 转换层跳过 comment 节点 |
| for init 裸赋值表达式（`i = 10`）解析失败 | 低 | 转换层处理裸表达式形态 |
| NULL 是独立 `null` 节点而非 identifier | 低 | 新增节点映射 |

## 九、已知限制

1. 教学子集之外的一切 C 特性不支持（详见 SUPPORTED_C.md §2），但全部有明确报错。
2. goto 跳过声明后使用该变量 → 运行时「未声明变量」错误（行为已定义，教学示例应避免）。
3. 地址不复用：指向已销毁块内变量的指针在块外解引用读到旧值（真实 C 为未定义行为；
   引擎行为已定义且不崩溃，文档 §3 声明）。
4. 步数上限 10000 / 递归深度 100：超出即保护性终止。
5. UI 未做移动端适配（桌面 Chrome/Edge 为目标环境）。
6. 测试为 Node 环境 vitest；UI 层以浏览器实测代替组件级单测。

## 十、GitHub

- 仓库：https://github.com/yangxijia111/C-Visualizer
- 版本：tag `v1.0.0`（commit `332956064a3c0850b8594556abfa9d50fae3b8ab`）
- 全部 15 个 commit 按阶段提交，无 force push

## 十一、v1.1 可增加内容

1. 三目运算符 `?:`、位运算、printf 宽度/精度（`%5d`、`%.2f`）
2. 二维数组、字符串（char 数组）与常用字符串操作
3. scanf 模拟输入（预设输入队列）
4. 控制流图（CFG）面板、单步表达式树展示
5. 英文界面 / 深色模式 / 移动端布局
6. 分享链接（代码编码进 URL hash）
