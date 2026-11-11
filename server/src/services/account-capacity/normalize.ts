import type { AiConnectionUsageLimit } from "@paperclipai/shared";
import type { LimitWindow, Observation, ObservationSource } from "./types.js";

const FIVE_HOUR_SECONDS = 18_000;
const SEVEN_DAY_SECONDS = 604_800;

/** `usedPercent`, or derived from used/limit when the provider omits it. */
function usedPercentOf(l: AiConnectionUsageLimit): number | null {
  if (l.usedPercent != null) return l.usedPercent;
  if (l.used != null && l.limit != null && l.limit > 0) return (l.used / l.limit) * 100;
  return null;
}

/** Usage probe result (`AiConnectionUsage.limits`, already in percent). */
export function observationFromUsageLimits(
  limits: AiConnectionUsageLimit[],
  observedAt: Date,
  source: ObservationSource = "usage_probe",
): Observation {
  const windows: LimitWindow[] = limits.map((l) => {
    const resets = l.resetsAt ? new Date(l.resetsAt) : null;
    return {
      id: l.id, label: l.label, scope: l.scope,
      usedPercent: usedPercentOf(l),
      resetsAt: resets && Number.isFinite(resets.getTime()) ? resets : null,
      durationSeconds: l.windowDurationSeconds,
      limitReached: l.limitReached,
    };
  });
  return { windows, observedAt, source };
}

/**
 * Claude Code `rate_limit_event` from run output. Utilization there is a
 * fraction (0.11 = 11 %), unlike the probe which reports percent.
 */
export function observationFromRateLimitEvent(event: unknown, observedAt: Date): Observation | null {
  if (!event || typeof event !== "object") return null;
  const e = event as Record<string, unknown>;
  if (e.type !== "rate_limit_event") return null;
  const info = e.rate_limit_info;
  const raw = info && typeof info === "object" ? (info as Record<string, unknown>).unifiedWindows : null;
  if (!raw || typeof raw !== "object") return null;
  const windows: LimitWindow[] = [];
  for (const [key, label, duration] of [
    ["five_hour", "5-hour", FIVE_HOUR_SECONDS],
    ["seven_day", "7-day", SEVEN_DAY_SECONDS],
  ] as const) {
    const w = (raw as Record<string, unknown>)[key];
    if (!w || typeof w !== "object") continue;
    const { utilization, resetsAt } = w as Record<string, unknown>;
    if (typeof utilization !== "number" || !Number.isFinite(utilization) || utilization < 0) continue;
    const reset = typeof resetsAt === "number" && Number.isFinite(resetsAt) && resetsAt > 0 ? new Date(resetsAt * 1000) : null;
    windows.push({ id: key, label, scope: null, usedPercent: utilization * 100, resetsAt: reset, durationSeconds: duration, limitReached: null });
  }
  return windows.length > 0 ? { windows, observedAt, source: "run_output" } : null;
}
