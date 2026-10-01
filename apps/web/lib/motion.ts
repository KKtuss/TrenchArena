/** Shared timing. Keep in step with the CSS tokens in globals.css. */
export const MOTION_MS = {
  micro: 120,
  short: 180,
  medium: 280,
  impact: 420,
} as const;

export function clamp01(value: number): number {
  if (value <= 0) return 0;
  if (value >= 1) return 1;
  return value;
}

export function easeOutCubic(t: number): number {
  const x = clamp01(t);
  return 1 - (1 - x) ** 3;
}

/** Interpolate toward an authoritative number. The caller snaps to `to` at t = 1. */
export function lerp(from: number, to: number, t: number): number {
  return from + (to - from) * easeOutCubic(t);
}

/** Visual HP bar scale. Does not change the reported percent. */
export function hpScale(percent: number): number {
  if (!Number.isFinite(percent)) return 0;
  return Math.max(0, Math.min(1, percent / 100));
}
