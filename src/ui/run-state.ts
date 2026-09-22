// 源码与运行结果一致性（Dirty State）的纯逻辑（提取自 App.tsx，便于直接单测）
// 语义：sourceDirty = 编辑器源码相对上一次成功运行已被修改，
// 此时旧 runResult 只能作为「上一次运行」参考，不得当作当前源码的结果展示。

/** 驱动 sourceDirty 变化的事件 */
export type RunSourceEvent =
  | { type: 'edit' } // 编辑器输入：旧结果立即过期
  | { type: 'run-success' } // 编译 + 运行成功：结果与当前源码一致
  | { type: 'run-fail' } // 编译失败：保持原状（旧结果继续标记为旧结果）
  | { type: 'load-example' }; // 示例切换：上下文整体重置，等待重新运行

/** 编辑 / 运行 / 加载示例后的 dirty 状态转移 */
export function nextDirtyState(prev: boolean, event: RunSourceEvent): boolean {
  switch (event.type) {
    case 'edit':
      return true;
    case 'run-success':
      return false;
    case 'run-fail':
      return prev;
    case 'load-example':
      return false;
  }
}

/** 播放控制（上一步/下一步/播放/重新开始/时间轴 + ←/→/空格快捷键）的统一禁用判定 */
export interface PlaybackGateState {
  busy: boolean;
  parserError: string | null;
  sourceDirty: boolean;
  total: number;
}

export function shouldDisablePlayback({ busy, parserError, sourceDirty, total }: PlaybackGateState): boolean {
  return busy || parserError !== null || sourceDirty || total === 0;
}

/** 运行按钮禁用判定：dirty 不影响（重新运行正是脱离 stale 状态的出口） */
export function shouldDisableRun(busy: boolean, parserError: string | null): boolean {
  return busy || parserError !== null;
}

/** 编辑器当前执行行：dirty 时旧行号不可映射到已修改源码，必须返回 null */
export function visibleCurrentLine(sourceDirty: boolean, cur: { line: number } | null): number | null {
  if (sourceDirty) return null;
  return cur ? cur.line : null;
}

/** 是否存在需要标记的旧结果（决定 stale 横幅显隐）：dirty 且上一次运行结果仍保留 */
export function isStaleResult(sourceDirty: boolean, runResult: unknown): boolean {
  return sourceDirty && runResult !== null;
}
