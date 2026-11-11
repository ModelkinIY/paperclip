import type { PaceModel, PaceInput, PaceResult } from "./model.js";

/**
 * Even spending over the window: expected = share of the window elapsed,
 * delta = used − expected. Hold above `holdAbove`, release at or below
 * `releaseAtOrBelow` (hysteresis).
 */
export const linearPaceModel: PaceModel = {
  id: "linear",
  evaluate(input: PaceInput, now: Date): PaceResult {
    const { usedPercent, resetsAt, durationSeconds, previouslyHeld, params } = input;
    if (!resetsAt || !durationSeconds || durationSeconds <= 0) {
      // Without the window bounds there is no pace; only a full window holds.
      return { elapsedPercent: null, expectedPercent: null, delta: null, hold: usedPercent >= 100 };
    }
    const remaining = (resetsAt.getTime() - now.getTime()) / 1000;
    const elapsed = Math.min(durationSeconds, Math.max(0, durationSeconds - remaining));
    const elapsedPercent = (elapsed / durationSeconds) * 100;
    const delta = usedPercent - elapsedPercent;
    let hold = previouslyHeld;
    if (delta > params.holdAbove) hold = true;
    else if (delta <= params.releaseAtOrBelow) hold = false;
    let releaseAt: Date | null = null;
    if (hold) {
      // delta <= release once elapsed% >= used% - release; never later than the window's own reset.
      const needElapsed = Math.min(100, Math.max(0, usedPercent - params.releaseAtOrBelow));
      const at = resetsAt.getTime() - durationSeconds * 1000 * (1 - needElapsed / 100);
      releaseAt = new Date(Math.min(resetsAt.getTime(), Math.max(now.getTime(), at)));
    }
    return { elapsedPercent, expectedPercent: elapsedPercent, delta, hold, releaseAt };
  },
};
