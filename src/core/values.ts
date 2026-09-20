// 运行时值与快照模型
// 详见 docs/EXECUTION_ENGINE.md §3；快照完全可序列化，UI 只读
import type { CType, ScalarKind } from './types';

/** 抽象内存地址：全局递增编号；0 保留为空指针 */
export type Address = number;

/** 内存单元类型（标量） */
export type CellType = 'int' | 'char' | 'float' | 'double' | 'pointer';

/** 内存单元：每个标量占一个单元；数组的元素占用连续地址区间 */
export interface MemoryCell {
  type: CellType;
  /** pointer 存目标地址（0 = 空）；null = 未初始化（读取即报错） */
  value: number | null;
  /** pointer 专用：目标的基础类型 */
  pointee?: ScalarKind;
}

/** 变量（快照内） */
export interface Variable {
  name: string;
  type: CType;
  /** 标量 = 自身单元地址；数组 = 首元素地址 */
  address: Address | null;
  /** 数组长度 */
  length?: number;
}

/** 作用域（快照内） */
export interface Scope {
  id: number;
  kind: 'global' | 'function' | 'block' | 'for';
  /** 展示名：'全局' / 'main' / '块(第12行)' / 'for(第15行)' */
  label: string;
  parent: number | null;
  vars: Variable[];
}

/** 调用栈帧（快照内） */
export interface StackFrame {
  functionName: string;
  /** 该帧的函数作用域 id */
  scopeId: number;
  /** 调用点行号 */
  callLine: number;
}

/** 完整状态快照（结构化克隆兼容） */
export interface Snapshot {
  scopes: Scope[];
  cells: Record<number, MemoryCell>;
  callStack: StackFrame[];
  /** 下一个可分配地址（保证执行确定性） */
  nextAddress: Address;
  /** 累计 printf 输出 */
  output: string;
}

/** 运行时值（表达式求值结果） */
export interface RuntimeValue {
  type: CellType;
  /** 数值或指针地址（指针 0 = 空） */
  value: number;
  /** pointer 专用：目标基础类型 */
  pointee?: ScalarKind;
}

export function intValue(v: number): RuntimeValue {
  return { type: 'int', value: v | 0 };
}

export function charValue(code: number): RuntimeValue {
  return { type: 'char', value: code & 0xff };
}

export function floatValue(v: number, kind: 'float' | 'double' = 'double'): RuntimeValue {
  return { type: kind, value: v };
}

export function pointerValue(address: number, pointee: ScalarKind): RuntimeValue {
  return { type: 'pointer', value: address, pointee };
}

/** 真值判定：0 = 假，非 0 = 真（指针 0 = 空 = 假） */
export function truthy(v: RuntimeValue): boolean {
  return v.value !== 0;
}

/** 数值（非指针）判定 */
export function isNumericValue(v: RuntimeValue): boolean {
  return v.type !== 'pointer';
}

/** 运行时值的展示文本（说明文案用） */
export function valueToDisplay(v: RuntimeValue): string {
  if (v.type === 'char') return `'${String.fromCharCode(v.value)}'`;
  if (v.type === 'pointer') return v.value === 0 ? 'NULL' : `#${v.value}`;
  if (v.type === 'float' || v.type === 'double') return formatFloat(v.value);
  return String(v.value);
}

export function formatFloat(n: number): string {
  if (Number.isInteger(n)) return String(n);
  return String(parseFloat(n.toPrecision(6)));
}

/** C 语义：整型除法向零截断 */
export function cDiv(a: number, b: number): number {
  return Math.trunc(a / b);
}

/** C 语义：取模（符号跟随被除数） */
export function cMod(a: number, b: number): number {
  return a - Math.trunc(a / b) * b;
}

/** 32 位有符号环绕 */
export function wrap32(n: number): number {
  return (n | 0);
}

/** 深拷贝快照（每步一次；教学规模下开销可控） */
export function cloneSnapshot(s: Snapshot): Snapshot {
  const cells: Record<number, MemoryCell> = {};
  for (const key in s.cells) {
    const c = s.cells[key];
    cells[key] = { ...c };
  }
  return {
    scopes: s.scopes.map((sc) => ({ ...sc, vars: sc.vars.map((v) => ({ ...v })) })),
    cells,
    callStack: s.callStack.map((f) => ({ ...f })),
    nextAddress: s.nextAddress,
    output: s.output,
  };
}
