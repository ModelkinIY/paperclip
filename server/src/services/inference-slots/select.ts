/**
 * inferdyne fork: which inference slot a run starts on. Pure; the service
 * feeds it slot statuses (limits) and the task's affinity.
 *
 * Rules:
 * - Hard limit (provider says the allowance is gone): the slot is skipped and
 *   the task moves to the next slot by priority, starting a new session there.
 * - Soft limit (pace gate): a task that already runs on the slot stays and
 *   waits, so its session and prompt cache are kept. What to do at a soft
 *   limit is a separate policy (softLimitDecision), so a cache-aware policy
 *   can replace it later without touching the selector.
 * - A task without affinity takes the first available slot by priority.
 * - Nothing available: wait until the earliest slot is expected back.
 */
import type { InferenceSlotStatus } from "@paperclipai/shared";

export interface SelectableSlot { id: string; priority: number; enabled: boolean }

export interface TaskAffinity { slotId: string; lastRunFinishedAt: Date | null }

export interface SoftLimitContext {
  slot: SelectableSlot;
  status: InferenceSlotStatus;
  affinity: TaskAffinity;
  /** Grant setting placeholder ("off" today). */
  cacheKeepaliveMode: string;
  now: Date;
}

/**
 * "wait": keep the task on its slot until the soft limit releases.
 * "switch": treat the slot like unavailable and move on (e.g. cache is cold).
 * "run": start anyway (e.g. warm the cache before it expires).
 * Today: always wait. The cache-aware variant is a separate task.
 */
export type SoftLimitDecision = "wait" | "switch" | "run";
export type SoftLimitPolicy = (ctx: SoftLimitContext) => SoftLimitDecision;
export const waitAtSoftLimit: SoftLimitPolicy = () => "wait";

export type SlotChoice =
  | { kind: "run"; slotId: string; reason: "affinity" | "priority" | "switched_hard_limit" | "switched_soft_limit" | "soft_limit_override"; previousSlotId: string | null }
  | { kind: "wait"; slotId: string; until: string | null; reason: string };

export function selectInferenceSlot(input: {
  slots: SelectableSlot[];
  statuses: Map<string, InferenceSlotStatus>;
  affinity: TaskAffinity | null;
  policy?: SoftLimitPolicy;
  cacheKeepaliveMode?: (slotId: string) => string;
  now?: Date;
}): SlotChoice | null {
  const now = input.now ?? new Date();
  const policy = input.policy ?? waitAtSoftLimit;
  const ordered = input.slots.filter((s) => s.enabled).sort((a, b) => a.priority - b.priority);
  if (ordered.length === 0) return null;
  const statusOf = (s: SelectableSlot): InferenceSlotStatus =>
    input.statuses.get(s.id) ?? { slotId: s.id, state: "available", reason: "unknown", until: null, accountName: null };

  let skipped: { slotId: string; why: "hard" | "soft" } | null = null;
  const aff = input.affinity ? ordered.find((s) => s.id === input.affinity!.slotId) : undefined;
  if (aff && input.affinity) {
    const st = statusOf(aff);
    if (st.state === "available") return { kind: "run", slotId: aff.id, reason: "affinity", previousSlotId: null };
    if (st.state === "soft_limit") {
      const decision = policy({ slot: aff, status: st, affinity: input.affinity, cacheKeepaliveMode: input.cacheKeepaliveMode?.(aff.id) ?? "off", now });
      if (decision === "wait") return { kind: "wait", slotId: aff.id, until: st.until, reason: st.reason };
      if (decision === "run") return { kind: "run", slotId: aff.id, reason: "soft_limit_override", previousSlotId: null };
      skipped = { slotId: aff.id, why: "soft" };
    } else {
      skipped = { slotId: aff.id, why: "hard" };
    }
  }
  const previousSlotId = input.affinity?.slotId ?? null;
  for (const s of ordered) {
    if (skipped && s.id === skipped.slotId) continue;
    if (statusOf(s).state !== "available") continue;
    const moved = previousSlotId !== null && previousSlotId !== s.id;
    return {
      kind: "run", slotId: s.id,
      reason: !moved ? "priority" : skipped?.why === "soft" ? "switched_soft_limit" : skipped ? "switched_hard_limit" : "priority",
      previousSlotId: moved ? previousSlotId : null,
    };
  }
  // Nothing open: wait for the earliest slot expected back (unknown last).
  let best: InferenceSlotStatus | null = null;
  for (const s of ordered) {
    const st = statusOf(s);
    if (!best || (st.until && (!best.until || st.until < best.until))) best = st;
  }
  return { kind: "wait", slotId: best!.slotId, until: best!.until, reason: best!.reason };
}
