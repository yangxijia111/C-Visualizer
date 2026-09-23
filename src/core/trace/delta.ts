// 快照增量（Delta）类型定义：Checkpoint + Delta 存储格式的最小单元
// 详见 docs/TRACE_STORE.md 与 docs/P13_V1.2_RUNTIME_ARCHITECTURE.md §8
// Phase B 仅定义线上类型；diffSnapshot / applyDelta 于 Phase F 实现
import type { MemoryCell, Scope, Snapshot, StackFrame, Variable } from '../values';

/**
 * 单步快照增量操作序列。语义：按序应用到 prevState 即得本步之后的完整快照。
 * 生成方式为相邻快照 diff（构造性完整：遍历快照全部五个字段）；
 * 结构异常时回退 `snap-set` 整体兜底，正确性不依赖任何结构假设。
 */
export type SnapshotDelta =
  | { op: 'cell-set'; addr: number; cell: MemoryCell } // 新增或整体覆写
  | { op: 'cell-del'; addr: number } // 防御（当前引擎从不删除单元）
  | { op: 'scope-push'; scope: Scope } // 尾部压入（含当时已有 vars）
  | { op: 'scope-pop' } // 尾部弹出
  | { op: 'var-add'; scopeId: number; variable: Variable } // 向既有作用域追加变量
  | { op: 'var-update'; scopeId: number; name: string; variable: Variable } // 防御
  | { op: 'frame-push'; frame: StackFrame }
  | { op: 'frame-pop' }
  | { op: 'frame-set'; frames: StackFrame[] } // 防御：非纯尾部变化
  | { op: 'output-append'; text: string }
  | { op: 'output-set'; text: string } // 防御：非追加变化
  | { op: 'next-address'; value: number }
  | { op: 'snap-set'; snapshot: Snapshot }; // 终极兜底：整体替换
