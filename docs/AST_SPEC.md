# 教学 AST 规范（AST_SPEC）

> CST→AST 转换（`convert.ts`）与语义检查（`check.ts`）、解释器（`interpreter/`）共同遵守本规范。
> 所有节点均为普通可序列化对象；每个节点携带源码位置与原文切片。

## 0. 公共结构

```ts
/** 源码位置（1 基） */
interface Pos { line: number; column: number; endLine: number; endColumn: number }

/** 所有 AST 节点的基础字段 */
interface NodeBase extends Pos { text: string }  // text = 源码原文切片，用于展示
```

## 1. 类型表达式

```ts
type CType =
  | { kind: 'int' } | { kind: 'char' }
  | { kind: 'float' } | { kind: 'double' }
  | { kind: 'void' }                              // 仅函数返回类型
  | { kind: 'pointer'; pointee: ScalarCType }     // 仅一层指针
  | { kind: 'array'; elem: ScalarCType; length: number }  // 仅一维
type ScalarCType = int | char | float | double | pointer
```

## 2. 表达式节点

```ts
type Expr = NodeBase & (字面量 | 标识符 | 运算 | 调用)

// 字面量
| { kind: 'IntLiteral';   value: number; raw: string }        // 含 0x/八进制/后缀解析结果
| { kind: 'FloatLiteral'; value: number; raw: string }        // 1e3、.5、后缀 f 忽略
| { kind: 'CharLiteral';  code: number;  raw: string }        // 'A' → 65
| { kind: 'StringLiteral'; value: string; raw: string }       // 仅限 printf/puts 参数

// 标识符
| { kind: 'Identifier'; name: string }

// 一元
| { kind: 'Unary'; op: '-' | '+' | '!'; operand: Expr }
| { kind: 'PreIncDec';  op: '++' | '--'; target: Expr }       // target 必须为左值
| { kind: 'PostIncDec'; op: '++' | '--'; target: Expr }

// 二元（逻辑与短路在解释器处理）
| { kind: 'Binary'; op: '+'|'-'|'*'|'/'|'%'|'=='|'!='|'>'|'<'|'>='|'<='|'&&'|'||'; left: Expr; right: Expr }

// 赋值（右结合；op 为复合赋值时 target 读改写）
| { kind: 'Assign'; op: '='|'+='|'-='|'*='|'/='|'%='; target: Expr; value: Expr }

// 指针与数组
| { kind: 'AddrOf'; target: Expr }            // &var / &arr[i]
| { kind: 'Deref';  target: Expr }            // *p
| { kind: 'ArrayAccess'; array: Identifier; index: Expr }   // 一维，array 必须是数组名标识符

// 调用
| { kind: 'Call'; name: string; args: Expr[] }
```

**左值定义（v1.0）**：`Identifier`、`Deref`、`ArrayAccess`。其余出现在赋值/++/--/取址目标位 → 类型错误。

## 3. 语句节点

```ts
type Stmt = NodeBase & (...)

| { kind: 'VarDecl'; declType: CType; vars: VarDeclarator[] }
    // VarDeclarator = { name, varType: CType(数组/指针修饰后), init?: Expr, initList?: Expr[](数组初始化列表) }
| { kind: 'ExprStmt'; expr: Expr }
| { kind: 'If'; condition: Expr; then: Stmt; else?: Stmt }
| { kind: 'While'; condition: Expr; body: Stmt }
| { kind: 'DoWhile'; body: Stmt; condition: Expr }
| { kind: 'For'; init: VarDecl|ExprStmt|null; condition: Expr|null; update: Expr|null; body: Stmt }
| { kind: 'Switch'; discriminant: Expr; cases: CaseSection[] }
| { kind: 'Break' } | { kind: 'Continue' }
| { kind: 'Goto'; label: string }
| { kind: 'Label'; name: string; stmt: Stmt }        // 转换时绑定到后随语句
| { kind: 'Return'; value?: Expr }
| { kind: 'Block'; body: Stmt[] }
| { kind: 'Empty' }

// switch 体被规整为有序的 case 区段（保持源码顺序，决定穿透行为）
interface CaseSection {
  labels: { value?: Expr; isDefault: boolean }[];  // case 2: case 3: 合并为一个区段；default 标记
  body: Stmt[];
}
```

## 4. 程序

```ts
interface FunctionDef {
  name: string; returnType: CType; params: { name: string; type: ScalarCType }[];
  body: Block; labels: string[];   // labels 供检查层校验 goto 目标
}
interface Program {
  functions: FunctionDef[];        // 必须恰好有一个 main
  globals: VarDecl[];
}
```

## 5. 转换规则要点（CST → AST）

| CST 节点 | 规则 |
| --- | --- |
| `update_expression`（`i++` / `--i`） | 依据前缀/后缀拆为 PreIncDec / PostIncDec |
| `assignment_expression`（含 `+=` 等） | op 直接映射；`=` 拆 target/value |
| `pointer_expression`（`&x` / `*p`） | field `operator` 区分 AddrOf / Deref |
| `binary_expression` | op 直接映射；`&&`/`||` 标记逻辑运算 |
| `call_expression` | 函数名必须是标识符（函数指针 → E_UNSUPPORTED）；参数列表展开 |
| `case_statement`（switch 体内） | 连续的 `case`/`default` 前导合并为一个 CaseSection，其后语句入 body |
| `labeled_statement` | 标签名绑定后随语句为 Label 节点；标签收集到所在函数 |
| `init_declarator` | 处理 `a = 1`；数组初始化列表 `{1,2,3}` 展开为 initList |
| `ERROR` / `isMissing` | 转 E_SYNTAX |
| 子集外节点（struct_specifier、enum、sizeof、cast、位运算 op、`?:`、逗号、`#include`…） | 带位置抛 E_UNSUPPORTED |

## 6. 语义检查（check.ts）职责

1. **不支持特性最终拦截**：AST 层面再次扫描（防御转换层遗漏），如 case 标签常量、数组长度常量、全局初始化常量。
2. **类型检查**：
   - 二元运算类型规则（`%` 仅整型；指针不参与算术；数组名不可整体赋值/传参）。
   - 赋值兼容性：int↔char↔float/double 可互赋（隐式截断/提升，步骤说明中注明）；指针只能同类型指针或 `0`；数组不可赋值。
   - 条件上下文任意标量皆可（0=假）。
   - **return 表达式类型与函数返回类型赋值兼容（v1.1.0）**；数值互转允许，数组/字符串拒绝。
3. **名称解析（静态部分）**：调用的函数必须已定义或是内置函数；goto 的标签必须存在于同一函数；main 存在且唯一。
4. **结构约束**：case 标签必须是整型常量表达式（常量折叠：字面量 + 一元负号 + 四则/取模）；数组长度 1..1024。
5. **词法作用域（v1.1.0）**：使用 `TypeEnvironment`（scope-env.ts）作用域栈遍历——
   声明只进当前层、查找由内向外、退出块即弹出；与运行时 Scope 栈层级一一对应
   （块外使用块内声明 → E_UNDEF_VAR；同层重复 → E_DECL；形参与函数体顶层同层；
   `for(int i…)` 仅循环内可见；switch 体单层作用域；声明点语义 `int x = x;` 合法）。
6. **控制流合法性（v1.1.0）**：loopDepth / switchDepth 上下文——break 需循环或
   switch、continue 仅循环；函数边界重置。
7. **goto 支持矩阵（v1.1.0）**：语句序列祖先链校验——目标标签链必须是 goto 链的
   前缀（允许跳出，拒绝跳入嵌套块/兄弟块）；if 单语句分支与 case 体内标签不可跳转。
8. **副作用求值顺序（v1.1.0，side-effects.ts）**：完整表达式区域内 R1 双写 / R2 读写
   竞争 → E_UB；赋值豁免（C11 6.5.16p3）；&& / || 序列点分区；函数实参与初始化
   列表各为单一无序区域。

检查通过 → `Program`；失败 → `CompileError[]`（见 ERROR_SPEC.md）。
