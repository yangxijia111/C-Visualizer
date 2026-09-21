// 控制流面板的事件分离逻辑：按 step 边界严格划分「过去」与「当前」
// 提取为纯函数以便直接单测（tests/release.test.ts）
import type { ExecutionStep, FlowEvent } from '../core/steps';

/** 历史窗口：展示当前步之前的最近 N 步的事件 */
export const FLOW_HISTORY_STEPS = 8;

/**
 * 分离控制流事件。
 * past = [currentStep - FLOW_HISTORY_STEPS, currentStep - 1] 各步事件按序拼接；
 * now  = steps[currentStep] 的全部事件。
 * 两者按 step 边界划分：同一事件不会同时出现在 past 与 now（修复旧实现
 * `history.slice(0, -1)` 在当前步含 0 个事件时丢事件、含多个事件时重复的问题）。
 */
export function splitFlowEvents(steps: ExecutionStep[], currentStep: number): { past: FlowEvent[]; now: FlowEvent[] } {
  const past: FlowEvent[] = [];
  const from = Math.max(0, currentStep - FLOW_HISTORY_STEPS);
  for (let i = from; i < currentStep && i < steps.length; i++) {
    past.push(...steps[i].flowEvents);
  }
  const cur = steps[currentStep];
  const now = cur ? [...cur.flowEvents] : [];
  return { past, now };
}
