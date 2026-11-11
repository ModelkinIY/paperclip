import type { LimitWindow, WindowRole } from "../types.js";

/**
 * What a provider type knows about its own limits: which of the windows it
 * reports count as the short and the weekly allowance. Everything else shown,
 * never gated.
 */
export interface LimitPolicy {
  readonly id: string;
  roleOf(window: LimitWindow): WindowRole;
}

export const SHORT_WINDOW_MAX_SECONDS = 6 * 3600;
export const WEEKLY_WINDOW_MIN_SECONDS = 6 * 86_400;

/** Role by real duration, never by the window's name (providers rename them). */
export function roleByDuration(window: LimitWindow): WindowRole {
  const d = window.durationSeconds;
  if (d == null) return "other";
  if (d <= SHORT_WINDOW_MAX_SECONDS) return "short";
  if (d >= WEEKLY_WINDOW_MIN_SECONDS) return "weekly";
  return "other";
}
