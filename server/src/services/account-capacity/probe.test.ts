import { beforeEach, describe, expect, it, vi } from "vitest";
import { AccountCapacityStore, DEFAULT_LIMIT_SETTINGS, InMemoryLimitSettingsStore } from "./index.js";
import { resetAccountProbeStateForTests, tickAccountLimits, type AccountProbeUsage } from "./probe.js";

const WEEK = 604_800;
const t0 = new Date("2026-11-04T12:00:00Z");
const resetsFor = (elapsedPercent: number, now: Date) => new Date(now.getTime() + (1 - elapsedPercent / 100) * WEEK * 1000).toISOString();
const limit = (usedPercent: number, now: Date) => [{
  id: "seven_day", label: "7-day", scope: null, windowDurationSeconds: WEEK, resetsAt: resetsFor(40, now),
  usedPercent, remainingPercent: 100 - usedPercent, used: null, limit: null, remaining: null, unit: null, limitReached: false, allowed: null,
}];

function setup(used: { current: number }) {
  const settings = new InMemoryLimitSettingsStore();
  settings.set("gA", { ...DEFAULT_LIMIT_SETTINGS, enabled: true });
  settings.set("gB", { ...DEFAULT_LIMIT_SETTINGS, enabled: true });
  const store = new AccountCapacityStore(settings);
  const probeUsage = vi.fn(async (_c: string, _u: string, _id: string, grantId?: string) => ({
    status: "ok", limits: limit(grantId === "gA" ? used.current : 10, clock.now),
  }));
  const usage: AccountProbeUsage = {
    list: async () => [
      { id: "cA", grantId: "gA", provider: "anthropic", method: "subscription", status: "connected" },
      { id: "cB", grantId: "gB", provider: "openai", method: "subscription", status: "connected" },
      { id: "cK", grantId: "gK", provider: "anthropic", method: "api_key", status: "connected" },
      { id: "cX", grantId: "gX", provider: "anthropic", method: "subscription", status: "needs_attention" },
    ],
    probeUsage,
  };
  const resume = vi.fn(async () => undefined);
  const clock = { now: t0 };
  const tick = () => tickAccountLimits(store, {
    memberships: async () => [{ companyId: "c1", userId: "u1" }, { companyId: "c1", userId: "u2" }],
    usage, resumeQueuedRuns: resume, now: () => clock.now,
  });
  return { store, probeUsage, resume, tick, clock };
}

beforeEach(() => resetAccountProbeStateForTests());

describe("account limit tick", () => {
  it("probes each limited, connected account once and ignores the rest", async () => {
    const { tick, probeUsage } = setup({ current: 45 });
    const grants = await tick();
    expect(grants.map((g) => g.grantId).sort()).toEqual(["gA", "gB"]);
    expect(probeUsage).toHaveBeenCalledTimes(2);
  });

  it("holds one account without touching the other", async () => {
    const { tick, store } = setup({ current: 45 });
    await tick();
    expect(store.getCapacity("gA", "anthropic", "subscription", t0).available).toBe(false);
    expect(store.getCapacity("gB", "openai", "subscription", t0).available).toBe(true);
  });

  it("does not probe again while the observation is fresh", async () => {
    const { tick, probeUsage, clock } = setup({ current: 45 });
    await tick();
    clock.now = new Date(t0.getTime() + 5 * 60_000);
    await tick();
    expect(probeUsage).toHaveBeenCalledTimes(2);
  });

  it("resumes queued runs once an account is released", async () => {
    const used = { current: 45 };
    const { tick, resume, clock } = setup(used);
    await tick();
    expect(resume).not.toHaveBeenCalled();
    used.current = 30;
    clock.now = new Date(t0.getTime() + 40 * 60_000);
    await tick();
    expect(resume).toHaveBeenCalledTimes(1);
  });

  it("survives a failing probe", async () => {
    const { tick, probeUsage, store } = setup({ current: 45 });
    probeUsage.mockRejectedValue(new Error("boom"));
    await expect(tick()).resolves.toBeDefined();
    expect(store.getCapacity("gA", "anthropic", "subscription", t0).available).toBe(true);
  });
});
