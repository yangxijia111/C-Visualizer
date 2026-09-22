// v1.0.2 Dirty Source 状态回归测试
// 覆盖：源码修改后旧 runResult 不再被当作当前结果（stale 标记 / 行高亮取消 / 播放禁用 / 运行可用 / 状态转移）
import { describe, expect, it } from 'vitest';
import {
  nextDirtyState,
  shouldDisablePlayback,
  shouldDisableRun,
  visibleCurrentLine,
  isStaleResult,
} from '../src/ui/run-state';

// ============ sourceDirty 状态转移 ============

describe('nextDirtyState：编辑 / 运行 / 编译失败 / 加载示例的 dirty 转移', () => {
  it('运行成功后：sourceDirty = false（结果与当前源码一致）', () => {
    expect(nextDirtyState(false, { type: 'run-success' })).toBe(false);
    expect(nextDirtyState(true, { type: 'run-success' })).toBe(false);
  });

  it('编辑源码后：sourceDirty = true（旧结果立即过期）', () => {
    expect(nextDirtyState(false, { type: 'edit' })).toBe(true);
    expect(nextDirtyState(true, { type: 'edit' })).toBe(true);
  });

  it('编译失败：保持原状（dirty 仍为 true，旧结果继续标记为旧结果）', () => {
    expect(nextDirtyState(true, { type: 'run-fail' })).toBe(true);
    // 首次运行即编译失败（无旧结果）：本就不存在 stale，保持 false
    expect(nextDirtyState(false, { type: 'run-fail' })).toBe(false);
  });

  it('重新运行成功：dirty → false（脱离 stale 状态）', () => {
    // 运行成功 → 编辑（true）→ 重新运行成功（false）
    expect(nextDirtyState(nextDirtyState(false, { type: 'run-success' }), { type: 'edit' })).toBe(true);
    expect(nextDirtyState(true, { type: 'run-success' })).toBe(false);
  });

  it('加载示例：上下文整体重置，dirty = false（等待用户重新运行）', () => {
    expect(nextDirtyState(true, { type: 'load-example' })).toBe(false);
    expect(nextDirtyState(false, { type: 'load-example' })).toBe(false);
  });
});

// ============ 当前行高亮 ============

describe('visibleCurrentLine：dirty 时旧行号不得映射到已修改源码', () => {
  it('dirty = true：返回 null（即使存在当前步骤）', () => {
    expect(visibleCurrentLine(true, { line: 3 })).toBeNull();
    expect(visibleCurrentLine(true, null)).toBeNull();
  });

  it('dirty = false：返回当前步骤行号；无当前步骤返回 null', () => {
    expect(visibleCurrentLine(false, { line: 3 })).toBe(3);
    expect(visibleCurrentLine(false, null)).toBeNull();
  });
});

// ============ 播放控制 / 运行按钮禁用规则 ============

describe('shouldDisablePlayback：dirty 时播放控制（含键盘快捷键）统一禁用', () => {
  const base = { busy: false, parserError: null as string | null, sourceDirty: false, total: 12 };

  it('正常状态（运行成功未编辑）：播放可用', () => {
    expect(shouldDisablePlayback(base)).toBe(false);
  });

  it('dirty 状态：禁用', () => {
    expect(shouldDisablePlayback({ ...base, sourceDirty: true })).toBe(true);
  });

  it('busy / parserError / 空结果（total=0）各自独立锁定播放', () => {
    expect(shouldDisablePlayback({ ...base, busy: true })).toBe(true);
    expect(shouldDisablePlayback({ ...base, parserError: '解析器加载失败' })).toBe(true);
    expect(shouldDisablePlayback({ ...base, total: 0 })).toBe(true);
  });
});

describe('shouldDisableRun：运行按钮在 dirty 时保持可用（重新运行是脱离 stale 的出口）', () => {
  it('dirty 不影响运行按钮', () => {
    expect(shouldDisableRun(false, null)).toBe(false);
  });

  it('busy / parserError 时禁用', () => {
    expect(shouldDisableRun(true, null)).toBe(true);
    expect(shouldDisableRun(false, '解析器加载失败')).toBe(true);
  });
});

// ============ 旧结果标记 ============

describe('isStaleResult：旧 runResult 存在且源码已修改时必须被标记', () => {
  const result = { steps: [], initialSnapshot: null };

  it('dirty 且旧结果保留 → 标记为旧结果（横幅显示）', () => {
    expect(isStaleResult(true, result)).toBe(true);
  });

  it('未编辑或无旧结果 → 不是 stale（无横幅）', () => {
    expect(isStaleResult(false, result)).toBe(false);
    expect(isStaleResult(true, null)).toBe(false);
    expect(isStaleResult(false, null)).toBe(false);
  });
});

// ============ 组合场景（还原任务书 9 项要求的完整状态链）============

describe('dirty state 组合场景', () => {
  const gate = (over: Partial<Parameters<typeof shouldDisablePlayback>[0]>) =>
    shouldDisablePlayback({ busy: false, parserError: null, sourceDirty: false, total: 10, ...over });

  it('场景：运行成功 → 编辑 → 重新运行成功（状态链完整）', () => {
    let dirty = nextDirtyState(false, { type: 'run-success' }); // 运行完成：false
    expect(dirty).toBe(false);
    expect(gate({ sourceDirty: dirty })).toBe(false); // 播放可用
    dirty = nextDirtyState(dirty, { type: 'edit' }); // 编辑：true
    expect(dirty).toBe(true);
    expect(gate({ sourceDirty: dirty })).toBe(true); // 播放禁用
    expect(shouldDisableRun(false, null)).toBe(false); // 运行仍可用
    dirty = nextDirtyState(dirty, { type: 'run-success' }); // 重新运行成功：false
    expect(dirty).toBe(false);
    expect(gate({ sourceDirty: dirty })).toBe(false); // 播放恢复
  });

  it('场景：编辑 → 编译失败（旧结果保留为 stale，播放持续禁用）', () => {
    let dirty = nextDirtyState(false, { type: 'edit' });
    dirty = nextDirtyState(dirty, { type: 'run-fail' });
    expect(dirty).toBe(true);
    expect(isStaleResult(dirty, { steps: [] })).toBe(true); // 旧结果继续被标记
    expect(gate({ sourceDirty: dirty })).toBe(true); // 不允许播放旧结果
    expect(shouldDisableRun(false, null)).toBe(false); // 但运行按钮可用（修复后可重新运行）
  });

  it('场景：加载新示例（旧 runResult 清空 → 无 stale 标记，dirty 归零）', () => {
    const dirty = nextDirtyState(true, { type: 'load-example' });
    expect(dirty).toBe(false);
    expect(isStaleResult(dirty, null)).toBe(false); // runResult 已清空，横幅消失
    expect(gate({ sourceDirty: dirty, total: 0 })).toBe(true); // 时间轴重置（无步骤）
  });
});
