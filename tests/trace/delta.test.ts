// Snapshot Delta 单元测试：定点场景 + 固定种子 property（diff → apply 必得逐字段相等）
import { describe, expect, it } from 'vitest';
import { applyDelta, cloneSnapshotFull, diffSnapshot } from '../../src/core/trace/delta';
import type { Snapshot, Snapshot as S } from '../../src/core/values';

const emptySnap = (): Snapshot => ({ scopes: [], cells: {}, callStack: [], nextAddress: 1, output: '' });

function roundtrip(prev: Snapshot, next: Snapshot): Snapshot {
  const ops = diffSnapshot(prev, next);
  const copy = cloneSnapshotFull(prev);
  applyDelta(copy, ops);
  return copy;
}

describe('delta 定点场景', () => {
  it('单元写入 / 新增 / 删除', () => {
    const prev = emptySnap();
    const next = emptySnap();
    prev.cells[1] = { type: 'int', value: 5 };
    prev.cells[2] = { type: 'int', value: null };
    next.cells[1] = { type: 'int', value: 7 };
    next.cells[3] = { type: 'pointer', value: 0, pointee: 'int' };

    const ops = diffSnapshot(prev, next);
    expect(ops).toContainEqual({ op: 'cell-set', addr: 1, cell: { type: 'int', value: 7 } });
    expect(ops).toContainEqual({ op: 'cell-del', addr: 2 });
    expect(ops).toContainEqual({ op: 'cell-set', addr: 3, cell: { type: 'pointer', value: 0, pointee: 'int' } });
    expect(roundtrip(prev, next)).toEqual(next);
  });

  it('作用域压入 / 弹出 / 共享作用域内追加变量', () => {
    const prev = emptySnap();
    const next = emptySnap();
    const g = { id: 1, kind: 'global' as const, label: '全局', parent: null, vars: [] };
    prev.scopes.push({ ...g, vars: [] });
    prev.scopes.push({ id: 2, kind: 'function', label: 'main', parent: 1, vars: [{ name: 'a', type: 'int', address: 1 }] });
    next.scopes.push({ ...g, vars: [] });
    next.scopes.push({
      id: 2, kind: 'function', label: 'main', parent: 1,
      vars: [{ name: 'a', type: 'int', address: 1 }, { name: 'b', type: 'int', address: 2 }],
    });
    next.scopes.push({ id: 3, kind: 'block', label: '块(第3行)', parent: 2, vars: [] });

    const ops = diffSnapshot(prev, next);
    expect(ops).toContainEqual({ op: 'var-add', scopeId: 2, variable: { name: 'b', type: 'int', address: 2 } });
    expect(ops).toContainEqual({ op: 'scope-push', scope: expect.objectContaining({ id: 3 }) });
    expect(roundtrip(prev, next)).toEqual(next);

    // 反向（变量 b 被移除）：前向 delta 不支持删除变量 → snap-set 兜底，结果仍正确
    const back = diffSnapshot(next, prev);
    expect(back.length).toBe(1);
    expect(back[0].op).toBe('snap-set');
    expect(roundtrip(next, prev)).toEqual(prev);

    // 纯作用域弹出（无变量差异）：scope-pop
    const popped = emptySnap();
    popped.scopes.push({ ...g, vars: [] });
    popped.scopes.push({
      id: 2, kind: 'function', label: 'main', parent: 1,
      vars: [{ name: 'a', type: 'int', address: 1 }, { name: 'b', type: 'int', address: 2 }],
    });
    const pops = diffSnapshot(next, popped);
    expect(pops.filter((o) => o.op === 'scope-pop').length).toBe(1);
    expect(roundtrip(next, popped)).toEqual(popped);
  });

  it('调用栈压入 / 弹出', () => {
    const prev = emptySnap();
    const next = emptySnap();
    prev.callStack.push({ functionName: 'main', scopeId: 1, callLine: 1 });
    next.callStack.push({ functionName: 'main', scopeId: 1, callLine: 1 });
    next.callStack.push({ functionName: 'fib', scopeId: 2, callLine: 5 });
    expect(roundtrip(prev, next)).toEqual(next);

    const mid = emptySnap();
    mid.callStack.push({ functionName: 'X', scopeId: 9, callLine: 9 }); // 前缀不一致 → frame-set 兜底
    const ops = diffSnapshot(prev, mid);
    expect(ops.some((o) => o.op === 'frame-set')).toBe(true);
    expect(roundtrip(prev, mid)).toEqual(mid);
  });

  it('output 追加 / 非前缀替换 / nextAddress', () => {
    const prev = emptySnap();
    const next = emptySnap();
    prev.output = 'a';
    next.output = 'abc';
    prev.nextAddress = 3;
    next.nextAddress = 9;
    const ops = diffSnapshot(prev, next);
    expect(ops).toContainEqual({ op: 'output-append', text: 'bc' });
    expect(ops).toContainEqual({ op: 'next-address', value: 9 });
    expect(roundtrip(prev, next)).toEqual(next);

    const alt = emptySnap();
    alt.output = 'xyz'; // 非前缀
    expect(diffSnapshot(prev, alt).some((o) => o.op === 'output-set')).toBe(true);
    expect(roundtrip(prev, alt)).toEqual(alt);
  });

  it('中间作用域 id 漂移 → snap-set 兜底且结果正确', () => {
    const prev = emptySnap();
    const next = emptySnap();
    prev.scopes.push({ id: 1, kind: 'global', label: '全局', parent: null, vars: [] });
    prev.scopes.push({ id: 2, kind: 'function', label: 'main', parent: 1, vars: [] });
    next.scopes.push({ id: 1, kind: 'global', label: '全局', parent: null, vars: [] });
    next.scopes.push({ id: 99, kind: 'function', label: 'main', parent: 1, vars: [] }); // id 漂移
    const ops = diffSnapshot(prev, next);
    expect(ops[0].op).toBe('snap-set');
    expect(roundtrip(prev, next)).toEqual(next);
  });

  it('相同快照 → 空 delta', () => {
    const s = emptySnap();
    expect(diffSnapshot(s, cloneSnapshotFull(s))).toEqual([]);
  });
});

// ============ property 测试（固定 seed，CI 可复现） ============

/** 线性同余随机源（与基准脚本同构，保证跨平台可复现） */
function makeRng(seed: number): () => number {
  let s = seed & 0x7fffffff;
  return () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
}

/** 随机变异快照（模拟解释器一步的可能状态变化） */
function mutate(rng: () => number, snap: Snapshot): Snapshot {
  const next = cloneSnapshotFull(snap);
  const kind = Math.floor(rng() * 10);
  switch (kind) {
    case 0:
    case 1:
    case 2: {
      const addr = 1 + Math.floor(rng() * 20);
      next.cells[addr] = { type: 'int', value: Math.floor(rng() * 100) };
      break;
    }
    case 3: {
      const keys = Object.keys(next.cells);
      if (keys.length > 1) delete next.cells[Number(keys[Math.floor(rng() * keys.length)])];
      break;
    }
    case 4: {
      const parent = next.scopes.length ? next.scopes[next.scopes.length - 1].id : null;
      const id = (next.scopes[next.scopes.length - 1]?.id ?? 0) + 1 + Math.floor(rng() * 1000);
      next.scopes.push({ id, kind: 'block', label: `块#${id}`, parent, vars: [] });
      break;
    }
    case 5: {
      if (next.scopes.length > 1) next.scopes.pop();
      break;
    }
    case 6:
    case 7: {
      if (next.scopes.length > 0) {
        const scope = next.scopes[Math.floor(rng() * next.scopes.length)];
        const name = `v${Math.floor(rng() * 8)}`;
        const existing = scope.vars.findIndex((v) => v.name === name);
        const variable = { name, type: 'int' as const, address: 1 + Math.floor(rng() * 30) };
        if (existing >= 0) scope.vars[existing] = variable;
        else scope.vars.push(variable);
      }
      break;
    }
    case 8: {
      if (rng() < 0.5) next.callStack.push({ functionName: `f${next.callStack.length}`, scopeId: 900 + next.callStack.length, callLine: 1 + Math.floor(rng() * 50) });
      else if (next.callStack.length > 0) next.callStack.pop();
      break;
    }
    case 9: {
      next.output += String(Math.floor(rng() * 10));
      next.nextAddress += 1 + Math.floor(rng() * 3);
      break;
    }
  }
  return next;
}

describe('delta property 测试（固定 seed）', () => {
  it('随机状态链：从 initial 逐步 diff+apply，与目标逐字段相等', () => {
    for (const seed of [1, 42, 20260923]) {
      const rng = makeRng(seed);
      let state = emptySnap();
      const chain = [state];
      for (let i = 0; i < 60; i++) {
        state = mutate(rng, state);
        chain.push(state);
      }
      // 逐链重建（模拟 TraceStore 的锚点重建路径）
      const reconstructed = emptySnap();
      for (let i = 1; i < chain.length; i++) {
        const ops = diffSnapshot(reconstructed, chain[i]);
        applyDelta(reconstructed, ops);
        expect(reconstructed).toEqual(chain[i]);
      }
      // 深拷贝基线重建（模拟「锚点不可变」契约）
      const fromClone = cloneSnapshotFull(chain[0]);
      for (let i = 1; i < chain.length; i++) {
        applyDelta(fromClone, diffSnapshot(chain[i - 1], chain[i]));
      }
      expect(fromClone).toEqual(chain[chain.length - 1]);
    }
  });

  it('随机对：任意 prev/next 的 diff+apply 往返一致', () => {
    const rng = makeRng(7);
    const pool: S[] = [emptySnap()];
    for (let i = 0; i < 40; i++) pool.push(mutate(rng, pool[pool.length - 1]));
    for (let k = 0; k < 200; k++) {
      const i = Math.floor(rng() * pool.length);
      const j = Math.floor(rng() * pool.length);
      expect(roundtrip(pool[i], pool[j])).toEqual(pool[j]);
    }
  });
});
