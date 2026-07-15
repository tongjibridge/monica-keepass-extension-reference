// 阶梯式锁定时长计算，参考小米手机策略，缩放适配浏览器场景。
// 纯函数模块，供 background 路由层和测试共享。

// 第 LOCKDOWN_THRESHOLD 次错误起开始锁定。
export const LOCKDOWN_THRESHOLD = 5;

// 阶梯式锁定时长（毫秒）。索引 = failedAttempts - LOCKDOWN_THRESHOLD。
// 缩放适配浏览器场景：30s / 1min / 5min / 15min / 30min（上限）
export const LOCKDOWN_SCHEDULE_MS = [
  30_000, // 5th: 30s
  60_000, // 6th: 1min
  300_000, // 7th: 5min
  900_000, // 8th: 15min
  1_800_000, // 9th+: 30min (cap)
] as const;

/** 给定累计失败次数，返回应锁定的毫秒数（0 = 不锁定）。 */
export function lockdownDurationFor(attempts: number): number {
  if (attempts < LOCKDOWN_THRESHOLD) return 0;
  const idx = Math.min(attempts - LOCKDOWN_THRESHOLD, LOCKDOWN_SCHEDULE_MS.length - 1);
  return LOCKDOWN_SCHEDULE_MS[idx]!;
}

/** 格式化锁定剩余时间为人类可读的中文字符串。 */
export function formatLockdownRemaining(lockedUntil: number, now: number = Date.now()): string {
  const ms = Math.max(0, lockedUntil - now);
  const s = Math.ceil(ms / 1000);
  if (s < 60) return `${s} 秒`;
  const m = Math.ceil(s / 60);
  return `${m} 分钟`;
}
