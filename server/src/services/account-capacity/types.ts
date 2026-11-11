/**
 * Account capacity (inferdyne fork).
 *
 * One answer per subscription key (grant): may new work start on it, and how
 * much room is left. How that is computed is a property of the provider type
 * (policies/) and of a replaceable pace model (pace/); callers see only
 * `Capacity`.
 */
import type { AiAuthMethod, AiProvider } from "@paperclipai/shared";

export type ObservationSource = "run_output" | "usage_probe" | "active_ping";

/** Which allowance a window belongs to. */
export type WindowRole = "short" | "weekly" | "other";

/** A provider window normalised to percentages (0–100+) and real dates. */
export interface LimitWindow {
  id: string;
  label: string;
  /** Null is the account-wide allowance; named models/features have a scope. */
  scope: string | null;
  usedPercent: number | null;
  resetsAt: Date | null;
  durationSeconds: number | null;
  limitReached: boolean | null;
}

export interface Observation {
  windows: LimitWindow[];
  observedAt: Date;
  source: ObservationSource;
}

export interface PaceParams {
  /** Hold new work when delta (used% − expected%) is above this. */
  holdAbove: number;
  /** Release the hold when delta is at or below this. */
  releaseAtOrBelow: number;
}

export interface LimitSettings {
  /** Accounting for this grant is on. Off means the grant is never held. */
  enabled: boolean;
  paceModel: string;
  weekly: PaceParams;
  fiveHour: PaceParams;
  /** Observations older than this are treated as unknown (fail-open). */
  maxStaleMinutes: number;
}

export const DEFAULT_LIMIT_SETTINGS: LimitSettings = {
  enabled: false,
  paceModel: "linear",
  weekly: { holdAbove: 0, releaseAtOrBelow: -2 },
  fiveHour: { holdAbove: 0, releaseAtOrBelow: -2 },
  maxStaleMinutes: 180,
};

export type CapacityReason =
  | "ok"
  | "no_limit"
  | "gate_disabled"
  | "weekly_ahead_of_pace"
  | "short_window_ahead_of_pace"
  | "window_exhausted"
  | "stale_unknown";

export interface WindowVerdict extends LimitWindow {
  role: WindowRole;
  expectedPercent: number | null;
  elapsedPercent: number | null;
  delta: number | null;
  hold: boolean;
}

export interface Capacity {
  grantId: string;
  provider: AiProvider;
  method: AiAuthMethod;
  available: boolean;
  /** 0–100 room in the tightest tracked window; null when unknown or no limit. */
  headroom: number | null;
  reason: CapacityReason;
  windows: WindowVerdict[];
  observedAt: Date | null;
  source: ObservationSource | null;
  /** Reset of the window that holds, when known. */
  heldUntil: Date | null;
}
