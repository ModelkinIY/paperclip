import { describe, expect, it } from "vitest";
import type { InferenceSlotStatus } from "@paperclipai/shared";
import { selectInferenceSlot, type SoftLimitPolicy } from "./select.js";

const slots = [
  { id: "cloud-claude", priority: 0, enabled: true },
  { id: "cloud-codex", priority: 1, enabled: true },
  { id: "local-claude", priority: 2, enabled: true },
];
function st(map: Record<string, ["available" | "soft_limit" | "hard_limit", string?]>) {
  const m = new Map<string, InferenceSlotStatus>();
  for (const [slotId, [state, until]] of Object.entries(map)) m.set(slotId, { slotId, state, reason: state, until: until ?? null, accountName: null });
  return m;
}

describe("selectInferenceSlot", () => {
  it("takes the first slot by priority for a new task", () => {
    expect(selectInferenceSlot({ slots, statuses: st({}), affinity: null })).toMatchObject({ kind: "run", slotId: "cloud-claude", reason: "priority" });
  });
  it("skips disabled and limited slots for a new task", () => {
    const s = slots.map((x) => x.id === "cloud-codex" ? { ...x, enabled: false } : x);
    expect(selectInferenceSlot({ slots: s, statuses: st({ "cloud-claude": ["soft_limit"] }), affinity: null }))
      .toMatchObject({ kind: "run", slotId: "local-claude" });
  });
  it("keeps a task on its slot even when a higher one is open", () => {
    expect(selectInferenceSlot({ slots, statuses: st({}), affinity: { slotId: "cloud-codex", lastRunFinishedAt: null } }))
      .toMatchObject({ kind: "run", slotId: "cloud-codex", reason: "affinity" });
  });
  it("waits on its slot at a soft limit instead of switching", () => {
    expect(selectInferenceSlot({ slots, statuses: st({ "cloud-claude": ["soft_limit", "2026-11-12T18:00:00.000Z"] }), affinity: { slotId: "cloud-claude", lastRunFinishedAt: null } }))
      .toEqual({ kind: "wait", slotId: "cloud-claude", until: "2026-11-12T18:00:00.000Z", reason: "soft_limit" });
  });
  it("moves to the next slot at a hard limit", () => {
    expect(selectInferenceSlot({ slots, statuses: st({ "cloud-claude": ["hard_limit"] }), affinity: { slotId: "cloud-claude", lastRunFinishedAt: null } }))
      .toEqual({ kind: "run", slotId: "cloud-codex", reason: "switched_hard_limit", previousSlotId: "cloud-claude" });
  });
  it("lets the soft-limit policy switch or run", () => {
    const sw: SoftLimitPolicy = () => "switch";
    const run: SoftLimitPolicy = () => "run";
    const statuses = st({ "cloud-claude": ["soft_limit"] });
    const affinity = { slotId: "cloud-claude", lastRunFinishedAt: null };
    expect(selectInferenceSlot({ slots, statuses, affinity, policy: sw })).toMatchObject({ kind: "run", slotId: "cloud-codex", reason: "switched_soft_limit" });
    expect(selectInferenceSlot({ slots, statuses, affinity, policy: run })).toMatchObject({ kind: "run", slotId: "cloud-claude", reason: "soft_limit_override" });
  });
  it("waits for the earliest slot when nothing is open", () => {
    const statuses = st({ "cloud-claude": ["hard_limit", "2026-11-12T20:00:00.000Z"], "cloud-codex": ["soft_limit", "2026-11-12T19:00:00.000Z"], "local-claude": ["hard_limit"] });
    expect(selectInferenceSlot({ slots, statuses, affinity: null })).toMatchObject({ kind: "wait", slotId: "cloud-codex", until: "2026-11-12T19:00:00.000Z" });
  });
  it("returns null without enabled slots", () => {
    expect(selectInferenceSlot({ slots: [], statuses: st({}), affinity: null })).toBeNull();
  });
});
