import { getPaceModel } from "./pace/index.js";
import type { LimitPolicy } from "./policies/index.js";
import type { Capacity, LimitSettings, Observation, WindowRole, WindowVerdict } from "./types.js";

export type HeldState = Partial<Record<WindowRole, boolean>>;

/**
 * Judge every window of an observation with the grant's pace model. Pure:
 * hysteresis comes in as `held` and goes out as `nextHeld`.
 */
export function evaluateObservation(
  observation: Observation,
  policy: LimitPolicy,
  settings: LimitSettings,
  held: HeldState,
  now: Date,
): Pick<Capacity, "available" | "headroom" | "reason" | "windows" | "heldUntil"> & { nextHeld: HeldState } {
  const model = getPaceModel(settings.paceModel);
  const nextHeld: HeldState = {};
  const windows: WindowVerdict[] = observation.windows.map((w) => {
    const role = policy.roleOf(w);
    const base = { ...w, role, expectedPercent: null, elapsedPercent: null, delta: null, hold: false, releaseAt: null as Date | null };
    if (role === "other") return base;
    // A window past its reset has started over: the old reading says nothing about it.
    if (w.resetsAt && w.resetsAt.getTime() <= now.getTime()) return base;
    const exhausted = w.limitReached === true || (w.usedPercent != null && w.usedPercent >= 100);
    if (w.usedPercent == null) return { ...base, hold: exhausted };
    const params = role === "short" ? settings.fiveHour : settings.weekly;
    const r = model.evaluate(
      { usedPercent: w.usedPercent, resetsAt: w.resetsAt, durationSeconds: w.durationSeconds,
        previouslyHeld: held[role] === true, params },
      now,
    );
    return { ...base, elapsedPercent: r.elapsedPercent, expectedPercent: r.expectedPercent, delta: r.delta,
      hold: r.hold || exhausted, releaseAt: exhausted ? w.resetsAt : (r.releaseAt ?? null) };
  });

  const tracked = windows.filter((w) => w.role !== "other");
  for (const w of tracked) nextHeld[w.role] = (nextHeld[w.role] ?? false) || w.hold;

  if (tracked.length === 0) {
    return { available: true, headroom: null, reason: "no_limit", windows, heldUntil: null, nextHeld };
  }
  const holding = tracked.filter((w) => w.hold);
  const known = tracked.filter((w) => w.usedPercent != null).map((w) => Math.max(0, 100 - w.usedPercent!));
  const headroom = known.length > 0 ? Math.min(...known) : null;
  if (!settings.enabled) {
    return { available: true, headroom, reason: "gate_disabled", windows, heldUntil: null, nextHeld: {} };
  }
  if (holding.length === 0) {
    return { available: true, headroom, reason: "ok", windows, heldUntil: null, nextHeld };
  }
  const first = holding[0]!;
  const exhausted = first.limitReached === true || (first.usedPercent != null && first.usedPercent >= 100);
  const reason = exhausted ? "window_exhausted" : first.role === "short" ? "short_window_ahead_of_pace" : "weekly_ahead_of_pace";
  // The account is free again when its last holding window lifts.
  const lifts = holding.map((w) => w.releaseAt).filter((d): d is Date => d != null);
  const heldUntil = lifts.length > 0 ? new Date(Math.max(...lifts.map((d) => d.getTime()))) : null;
  return { available: false, headroom, reason, windows, heldUntil, nextHeld };
}
