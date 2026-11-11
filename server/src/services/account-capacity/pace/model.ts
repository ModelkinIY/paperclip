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
}

/** A replaceable way to judge whether spending is ahead of an acceptable pace. */
export interface PaceModel {
  readonly id: string;
  evaluate(input: PaceInput, now: Date): PaceResult;
}
