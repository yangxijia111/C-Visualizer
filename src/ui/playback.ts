// 播放器步进/速度的纯逻辑（提取自 App.tsx，便于直接单测边界行为）

/** 播放速度档位：步/秒 */
export const PLAYBACK_SPEEDS = [0.5, 1, 2, 4, 8] as const;

/** 下一步：末尾钳制（不越界） */
export function nextStep(s: number, total: number): number {
  return Math.min(total - 1, s + 1);
}

/** 上一步：起点钳制（不低于 0） */
export function prevStep(s: number): number {
  return Math.max(0, s - 1);
}

/** 自动播放推进：到末尾返回 null（= 停止），否则返回下一步索引 */
export function advancePlaying(s: number, total: number): number | null {
  if (s >= total - 1) return null;
  return s + 1;
}

/** 点击播放/暂停按钮：处于末尾或未开始时从头播放，否则切换播放状态 */
export function playButtonAction(currentStep: number, total: number, playing: boolean): { play: boolean; step: number } {
  if (currentStep >= total - 1) return { play: true, step: 0 };
  if (currentStep < 0) return { play: true, step: 0 };
  return { play: !playing, step: currentStep };
}

/** 时间轴可取值范围（未开始时显示 0） */
export function timelineValue(currentStep: number): number {
  return Math.max(0, currentStep);
}
