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
    return { elapsedPercent, expectedPercent: elapsedPercent, delta, hold };
  },
};
