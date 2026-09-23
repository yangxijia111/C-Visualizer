// 快照增量（Delta）：相邻快照 diff 生成 / 应用（纯确定性算法）
// 生成方式构造性完整：遍历快照全部五个字段；任何结构异常回退 `snap-set` 整体兜底，
// 正确性不依赖「解释器恰好没写某处」的假设。详见 docs/TRACE_STORE.md。
import type { MemoryCell, Scope, Snapshot, StackFrame, Variable } from '../values';

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

// ============ diff：prevState → next 的操作序列 ============

function sameCell(a: MemoryCell | undefined, b: MemoryCell | undefined): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.type === b.type && a.value === b.value && a.pointee === b.pointee;
}

function sameVariable(a: Variable | undefined, b: Variable | undefined): boolean {
  if (!a || !b) return false;
  if (a.name !== b.name || a.address !== b.address || a.length !== b.length) return false;
  return JSON.stringify(a.type) === JSON.stringify(b.type);
}

function sameScope(a: Scope | undefined, b: Scope | undefined): boolean {
  if (!a || !b) return false;
  return a.id === b.id && a.kind === b.kind && a.label === b.label && a.parent === b.parent;
}

function sameFrame(a: StackFrame | undefined, b: StackFrame | undefined): boolean {
  if (!a || !b) return false;
  return a.functionName === b.functionName && a.scopeId === b.scopeId && a.callLine === b.callLine;
}

/** 变量序列的增量：约定只能尾部追加（declareScalar 追加）；其余视为结构异常 */
function diffVars(scopeId: number, prevVars: Variable[], nextVars: Variable[], ops: SnapshotDelta[]): boolean {
  if (nextVars.length < prevVars.length) return false; // 变量被移除：异常
  for (let i = 0; i < prevVars.length; i++) {
    if (prevVars[i].name !== nextVars[i].name) return false; // 顺序漂移：异常
    if (!sameVariable(prevVars[i], nextVars[i])) {
      ops.push({ op: 'var-update', scopeId, name: nextVars[i].name, variable: { ...nextVars[i] } });
    }
  }
  for (let i = prevVars.length; i < nextVars.length; i++) {
    ops.push({ op: 'var-add', scopeId, variable: { ...nextVars[i] } });
  }
  return true;
}

/**
 * 计算从 prev 到 next 的增量操作序列（确定性：cells 按 addr 升序，结构按位置对齐）。
 * 返回的 ops 应用到 prev 的深拷贝上必得与 next 逐字段相等的状态（property 测试保证）。
 */
export function diffSnapshot(prev: Snapshot, next: Snapshot): SnapshotDelta[] {
  const fallback = (): SnapshotDelta[] => [{ op: 'snap-set', snapshot: cloneSnapshotFull(next) }];
  try {
    const ops: SnapshotDelta[] = [];

    // —— cells（按 addr 升序，确定性）——
    const addrSet = new Set<number>();
    for (const key in prev.cells) addrSet.add(Number(key));
    for (const key in next.cells) addrSet.add(Number(key));
    const addrs = [...addrSet].sort((a, b) => a - b);
    for (const addr of addrs) {
      const p = prev.cells[addr];
      const n = next.cells[addr];
      if (p && n) {
        if (!sameCell(p, n)) ops.push({ op: 'cell-set', addr, cell: { ...n } });
      } else if (n) {
        ops.push({ op: 'cell-set', addr, cell: { ...n } });
      } else if (p) {
        ops.push({ op: 'cell-del', addr });
      }
    }

    // —— scopes：按位置对齐（id 唯一且栈式尾操作）；共享段内 diff 变量 ——
    const commonScopeLen = Math.min(prev.scopes.length, next.scopes.length);
    let scopeAlign = 0;
    while (scopeAlign < commonScopeLen && sameScope(prev.scopes[scopeAlign], next.scopes[scopeAlign])) {
      scopeAlign++;
    }
    if (scopeAlign < commonScopeLen) return fallback(); // 中间位置 id 漂移：异常
    for (let i = 0; i < scopeAlign; i++) {
      if (!diffVars(prev.scopes[i].id, prev.scopes[i].vars, next.scopes[i].vars, ops)) return fallback();
    }
    const pops = prev.scopes.length - scopeAlign;
    for (let i = 0; i < pops; i++) {
      ops.push({ op: 'scope-pop' });
    }
    for (let i = scopeAlign; i < next.scopes.length; i++) {
      const s = next.scopes[i];
      ops.push({ op: 'scope-push', scope: { ...s, vars: s.vars.map((v) => ({ ...v })) } });
    }

    // —— callStack：帧结构对比（中间变化 → frame-set 防御）——
    const commonFrameLen = Math.min(prev.callStack.length, next.callStack.length);
    let frameAlign = 0;
    while (frameAlign < commonFrameLen && sameFrame(prev.callStack[frameAlign], next.callStack[frameAlign])) {
      frameAlign++;
    }
    if (frameAlign === commonFrameLen) {
      // 前缀完全一致：纯尾部 push/pop（弹出数按 prev 与对齐点之差）
      const framePops = prev.callStack.length - frameAlign;
      for (let i = 0; i < framePops; i++) {
        ops.push({ op: 'frame-pop' });
      }
      for (let i = frameAlign; i < next.callStack.length; i++) {
        ops.push({ op: 'frame-push', frame: { ...next.callStack[i] } });
      }
    } else {
      ops.push({ op: 'frame-set', frames: next.callStack.map((f) => ({ ...f })) });
    }

    // —— output（前缀追加 / 整体替换）——
    if (next.output !== prev.output) {
      if (next.output.startsWith(prev.output)) {
        ops.push({ op: 'output-append', text: next.output.slice(prev.output.length) });
      } else {
        ops.push({ op: 'output-set', text: next.output });
      }
    }

    // —— nextAddress ——
    if (next.nextAddress !== prev.nextAddress) {
      ops.push({ op: 'next-address', value: next.nextAddress });
    }

    return ops;
  } catch {
    return fallback();
  }
}

// ============ apply：把操作序列应用到可变快照（调用方传入深拷贝） ============

/** 把 delta 应用到 snap 上（原地修改；snap 必须是调用方私有的可变副本） */
export function applyDelta(snap: Snapshot, deltas: SnapshotDelta[]): void {
  for (const d of deltas) {
    switch (d.op) {
      case 'cell-set':
        snap.cells[d.addr] = { ...d.cell };
        break;
      case 'cell-del':
        delete snap.cells[d.addr];
        break;
      case 'scope-push':
        snap.scopes.push({ ...d.scope, vars: d.scope.vars.map((v) => ({ ...v })) });
        break;
      case 'scope-pop':
        snap.scopes.pop();
        break;
      case 'var-add': {
        const scope = snap.scopes.find((s) => s.id === d.scopeId);
        if (!scope) throw new Error(`var-add：找不到作用域 #${d.scopeId}`);
        scope.vars.push({ ...d.variable });
        break;
      }
      case 'var-update': {
        const scope = snap.scopes.find((s) => s.id === d.scopeId);
        const variable = scope?.vars.find((v) => v.name === d.name);
        if (!scope || !variable) throw new Error(`var-update：找不到作用域 #${d.scopeId} 的变量「${d.name}」`);
        const idx = scope.vars.indexOf(variable);
        scope.vars[idx] = { ...d.variable };
        break;
      }
      case 'frame-push':
        snap.callStack.push({ ...d.frame });
        break;
      case 'frame-pop':
        snap.callStack.pop();
        break;
      case 'frame-set':
        snap.callStack = d.frames.map((f) => ({ ...f }));
        break;
      case 'output-append':
        snap.output += d.text;
        break;
      case 'output-set':
        snap.output = d.text;
        break;
      case 'next-address':
        snap.nextAddress = d.value;
        break;
      case 'snap-set': {
        const full = d.snapshot;
        snap.scopes = full.scopes.map((s) => ({ ...s, vars: s.vars.map((v) => ({ ...v })) }));
        const cells: Snapshot['cells'] = {};
        for (const key in full.cells) cells[key] = { ...full.cells[key] };
        snap.cells = cells;
        snap.callStack = full.callStack.map((f) => ({ ...f }));
        snap.nextAddress = full.nextAddress;
        snap.output = full.output;
        break;
      }
    }
  }
}

/** 深拷贝快照（重建链起点用；与 values.cloneSnapshot 等价，此处避免反向依赖 UI 契约） */
export function cloneSnapshotFull(s: Snapshot): Snapshot {
  const cells: Snapshot['cells'] = {};
  for (const key in s.cells) cells[key] = { ...s.cells[key] };
  return {
    scopes: s.scopes.map((sc) => ({ ...sc, vars: sc.vars.map((v) => ({ ...v })) })),
    cells,
    callStack: s.callStack.map((f) => ({ ...f })),
    nextAddress: s.nextAddress,
    output: s.output,
  };
}
