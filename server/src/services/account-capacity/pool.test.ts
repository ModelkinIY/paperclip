import { describe, expect, it } from "vitest";
import { AccountCapacityStore, DEFAULT_LIMIT_SETTINGS, InMemoryLimitSettingsStore, filterByAccountLimit, type Observation } from "./index.js";

const now = new Date("2026-11-04T12:00:00Z");
const WEEK = 604_800;
const obs = (used: number): Observation => ({
  observedAt: now, source: "usage_probe",
  windows: [{ id: "seven_day", label: "7-day", scope: null, usedPercent: used, durationSeconds: WEEK, limitReached: null,
    resetsAt: new Date(now.getTime() + 0.6 * WEEK * 1000) }],
});
const member = (grantId: string, provider: "anthropic" | "openai" = "anthropic") => ({ grantId, provider, method: "subscription" as const });

function store(over: Record<string, number>) {
  const settings = new InMemoryLimitSettingsStore();
  const s = new AccountCapacityStore(settings);
  for (const [g, used] of Object.entries(over)) {
    settings.set(g, { ...DEFAULT_LIMIT_SETTINGS, enabled: true });
    s.record(g, obs(used));
  }
  return s;
}

describe("pool filtering by account limit", () => {
  it("drops held accounts and keeps the rest in order", () => {
    const s = store({ a: 80, b: 10, c: 10 });
    const { open } = filterByAccountLimit([member("a"), member("b"), member("c")], (m) => m, s, now);
    expect(open.map((m) => m.grantId)).toEqual(["b", "c"]);
  });

  it("keeps accounts that have no accounting or no data", () => {
    const s = store({ a: 80 });
    const { open } = filterByAccountLimit([member("a"), member("unknown"), member("x", "openai")], (m) => m, s, now);
    expect(open.map((m) => m.grantId)).toEqual(["unknown", "x"]);
  });

  it("returns nothing and the earliest return time when every account is held", () => {
    const s = store({ a: 80, b: 90 });
    const { open, retryAt } = filterByAccountLimit([member("a"), member("b")], (m) => m, s, now);
    expect(open).toEqual([]);
    expect(retryAt?.getTime()).toBe(now.getTime() + 0.6 * WEEK * 1000);
  });
});
