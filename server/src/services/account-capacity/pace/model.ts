import type { PaceParams } from "../types.js";

export interface PaceInput {
  usedPercent: number;
  resetsAt: Date | null;
  durationSeconds: number | null;
  previouslyHeld: boolean;
  params: PaceParams;
}

export interface PaceResult {
  elapsedPercent: number | null;
  expectedPercent: number | null;
  delta: number | null;
  hold: boolean;
  /** When a hold is expected to lift if nothing more is spent; null when not held or unknown. */
  releaseAt?: Date | null;
}

/** A replaceable way to judge whether spending is ahead of an acceptable pace. */
export interface PaceModel {
  readonly id: string;
  evaluate(input: PaceInput, now: Date): PaceResult;
}
