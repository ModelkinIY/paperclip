import { describe, expect, it } from "vitest";
import {
  AccountCapacityStore,
  DEFAULT_LIMIT_SETTINGS,
  InMemoryLimitSettingsStore,
  observationFromRateLimitEvent,
  observationFromUsageLimits,
  registerPaceModel,
  type LimitSettings,
  type Observation,
} from "./index.js";

const now = new Date("2026-11-04T12:00:00Z");
const WEEK = 604_800;
const FIVE_H = 18_000;
const resetsFor = (elapsedPercent: number, duration: number) =>
  new Date(now.getTime() + (1 - elapsedPercent / 100) * duration * 1000);
const on: LimitSettings = { ...DEFAULT_LIMIT_SETTINGS, enabled: true };

function claude(weekUsed: number, weekElapsed: number, fiveUsed: number, fiveElapsed: number, at = now): Observation {
  return {
    observedAt: at, source: "usage_probe",
    windows: [
      { id: "five_hour", label: "5-hour", scope: null, usedPercent: fiveUsed, resetsAt: resetsFor(fiveElapsed, FIVE_H), durationSeconds: FIVE_H, limitReached: null },
      { id: "seven_day", label: "7-day", scope: null, usedPercent: weekUsed, resetsAt: resetsFor(weekElapsed, WEEK), durationSeconds: WEEK, limitReached: null },
    ],
  };
}
function setup(settings: LimitSettings = on) {
  const settingsStore = new InMemoryLimitSettingsStore();
  settingsStore.set("g1", settings);
  settingsStore.set("g2", settings);
  return { store: new AccountCapacityStore(settingsStore), settingsStore };
}
const cap = (s: AccountCapacityStore, g = "g1") => s.getCapacity(g, "anthropic", "subscription", now);

describe("linear pace, weekly window", () => {
  it("holds when ahead of pace and reports the reason and reset", () => {
    const { store } = setup();
    store.record("g1", claude(45, 40, 10, 50));
    const c = cap(store);
    expect(c.available).toBe(false);
    expect(c.reason).toBe("weekly_ahead_of_pace");
    expect(c.heldUntil?.getTime()).toBeCloseTo(resetsFor(40, WEEK).getTime() - WEEK * 1000 * (1 - 0.47), -2);
    expect(c.windows.find((w) => w.id === "seven_day")?.delta).toBeCloseTo(5, 5);
  });

  it("releases only at or below the release threshold (hysteresis)", () => {
    const { store } = setup();
    store.record("g1", claude(45, 40, 10, 50));
    expect(cap(store).available).toBe(false);
    store.record("g1", claude(40, 40, 10, 50, new Date(now.getTime() + 1)));
    expect(cap(store).available).toBe(false); // delta 0, still held
    store.record("g1", claude(38, 40, 10, 50, new Date(now.getTime() + 2)));
    expect(cap(store).available).toBe(true); // delta -2
  });

  it("does not hold when under pace", () => {
    const { store } = setup();
    store.record("g1", claude(30, 40, 10, 50));
    const c = cap(store);
    expect(c.available).toBe(true);
    expect(c.reason).toBe("ok");
    expect(c.headroom).toBe(70); // week 30 % used leaves 70, 5-hour leaves 90
  });
});

describe("short (5-hour) window", () => {
  it("holds on its own pace independent of the weekly window", () => {
    const { store } = setup();
    store.record("g1", claude(10, 50, 60, 20));
    const c = cap(store);
    expect(c.available).toBe(false);
    expect(c.reason).toBe("short_window_ahead_of_pace");
  });

  it("uses its own parameters", () => {
    const { store } = setup({ ...on, fiveHour: { holdAbove: 50, releaseAtOrBelow: 40 } });
    store.record("g1", claude(10, 50, 60, 20)); // delta 40, under holdAbove 50
    expect(cap(store).available).toBe(true);
  });
});

describe("when a hold lifts", () => {
  it("reports the moment the pace catches up, not the window's reset", () => {
    const { store } = setup();
    store.record("g1", claude(45, 40, 10, 50));
    const c = cap(store);
    // 45 % used, release at delta <= -2 -> elapsed must reach 47 %.
    const expected = resetsFor(40, WEEK).getTime() - WEEK * 1000 * (1 - 0.47);
    expect(c.heldUntil?.getTime()).toBeCloseTo(expected, -2);
    expect(c.heldUntil!.getTime()).toBeLessThan(resetsFor(40, WEEK).getTime());
  });

  it("uses the reset for an exhausted window", () => {
    const { store } = setup();
    store.record("g1", claude(100, 50, 5, 50));
    expect(cap(store).heldUntil?.getTime()).toBe(resetsFor(50, WEEK).getTime());
  });

  it("does not keep holding on a window that has already reset", () => {
    const { store } = setup();
    const o = claude(100, 99.9, 5, 50);
    o.windows[1]!.resetsAt = new Date(now.getTime() - 1000);
    store.record("g1", o);
    expect(cap(store).available).toBe(true);
  });
});

describe("partial observations", () => {
  it("keeps windows an event does not mention", () => {
    const { store } = setup();
    store.record("g1", claude(45, 40, 10, 50));
    const later = new Date(now.getTime() + 60_000);
    store.record("g1", { observedAt: later, source: "run_output", windows: [claude(0, 0, 11, 50).windows[0]!] });
    const c = store.getCapacity("g1", "anthropic", "subscription", later);
    expect(c.windows.map((w) => w.id).sort()).toEqual(["five_hour", "seven_day"]);
    expect(c.available).toBe(false); // the weekly hold survives
  });

  it("records history at most every few minutes", () => {
    const { store } = setup();
    for (let i = 0; i < 20; i += 1) store.record("g1", claude(10, 40, 10, 50, new Date(now.getTime() + i * 1000)));
    expect(store.historyOf("g1")).toHaveLength(1);
    store.record("g1", claude(10, 40, 10, 50, new Date(now.getTime() + 6 * 60_000)));
    expect(store.historyOf("g1")).toHaveLength(2);
  });

  it("reports whether any account has accounting on", () => {
    const { store, settingsStore } = setup({ ...on, enabled: false });
    expect(store.anyEnabled()).toBe(false);
    settingsStore.set("g2", on);
    expect(store.anyEnabled()).toBe(true);
  });
});

describe("exhaustion", () => {
  it("holds a full window even at the very end of it", () => {
    const { store } = setup();
    store.record("g1", claude(100, 99, 5, 50));
    const c = cap(store);
    expect(c.available).toBe(false);
    expect(c.reason).toBe("window_exhausted");
  });
});

describe("independence and switches", () => {
  it("keeps accounts independent", () => {
    const { store } = setup();
    store.record("g1", claude(80, 40, 10, 50));
    store.record("g2", claude(20, 40, 10, 50));
    expect(cap(store, "g1").available).toBe(false);
    expect(cap(store, "g2").available).toBe(true);
  });

  it("is never held while accounting is off, but still shows windows", () => {
    const { store } = setup({ ...on, enabled: false });
    store.record("g1", claude(80, 40, 10, 50));
    const c = cap(store);
    expect(c.available).toBe(true);
    expect(c.reason).toBe("gate_disabled");
    expect(c.windows.some((w) => w.hold)).toBe(true);
  });

  it("is available and unknown without data or when data is stale", () => {
    const { store } = setup();
    expect(cap(store).reason).toBe("stale_unknown");
    store.record("g1", claude(90, 10, 10, 50, new Date(now.getTime() - 4 * 3600_000)));
    const c = cap(store);
    expect(c.available).toBe(true);
    expect(c.reason).toBe("stale_unknown");
  });

  it("keeps the newest observation", () => {
    const { store } = setup();
    store.record("g1", claude(80, 40, 10, 50));
    store.record("g1", claude(10, 40, 10, 50, new Date(now.getTime() - 1000)));
    expect(cap(store).available).toBe(false);
  });
});

describe("providers", () => {
  it("never limits providers without limits", () => {
    const { store } = setup();
    expect(store.getCapacity("g1", "google", "subscription", now).reason).toBe("no_limit");
    expect(store.getCapacity("g1", "anthropic", "api_key", now).reason).toBe("no_limit");
  });

  it("picks codex windows by duration, not by name", () => {
    const { store } = setup();
    const obs = observationFromUsageLimits(
      [
        { id: "codex.primary_window", label: "p", scope: null, windowDurationSeconds: 14_400, resetsAt: resetsFor(20, 14_400).toISOString(), usedPercent: 70, remainingPercent: 30, used: null, limit: null, remaining: null, unit: null, limitReached: false, allowed: true },
        { id: "codex.secondary_window", label: "s", scope: null, windowDurationSeconds: WEEK, resetsAt: resetsFor(50, WEEK).toISOString(), usedPercent: 10, remainingPercent: 90, used: null, limit: null, remaining: null, unit: null, limitReached: false, allowed: true },
        { id: "code_review.primary_window", label: "cr", scope: "code_review", windowDurationSeconds: 14_400, resetsAt: null, usedPercent: 99, remainingPercent: 1, used: null, limit: null, remaining: null, unit: null, limitReached: false, allowed: true },
      ],
      now,
    );
    store.record("g1", obs);
    const c = store.getCapacity("g1", "openai", "subscription", now);
    expect(c.available).toBe(false);
    expect(c.reason).toBe("short_window_ahead_of_pace");
    expect(c.windows.find((w) => w.id === "code_review.primary_window")?.role).toBe("other");
  });

  it("derives grok percent from used/limit and stays open when nothing is known", () => {
    const { store } = setup();
    const limit = (usedPercent: number | null, used: number | null, lim: number | null) =>
      [{ id: "grok_credits", label: "g", scope: null, windowDurationSeconds: WEEK, resetsAt: resetsFor(40, WEEK).toISOString(), usedPercent, remainingPercent: null, used, limit: lim, remaining: null, unit: "cents", limitReached: null, allowed: null }];
    store.record("g1", observationFromUsageLimits(limit(null, 450, 1000), now));
    expect(store.getCapacity("g1", "xai", "subscription", now).available).toBe(false); // 45 % vs 40 %
    store.record("g2", observationFromUsageLimits(limit(null, null, null), now));
    const c = store.getCapacity("g2", "xai", "subscription", now);
    expect(c.available).toBe(true);
    expect(c.headroom).toBeNull();
  });
});

describe("normalisation", () => {
  it("turns run-output fractions into percent", () => {
    const o = observationFromRateLimitEvent(
      { type: "rate_limit_event", rate_limit_info: { unifiedWindows: {
        five_hour: { utilization: 0.08, resetsAt: 1793813400 },
        seven_day: { utilization: 0.11, resetsAt: 1794286800 } } } },
      now,
    )!;
    expect(o.source).toBe("run_output");
    expect(o.windows.map((w) => [w.id, w.usedPercent])).toEqual([["five_hour", 8], ["seven_day", 11]]);
    expect(o.windows[0]!.durationSeconds).toBe(FIVE_H);
  });

  it("ignores malformed events", () => {
    expect(observationFromRateLimitEvent({ type: "other" }, now)).toBeNull();
    expect(observationFromRateLimitEvent({ type: "rate_limit_event", rate_limit_info: {} }, now)).toBeNull();
  });

  it("gives the same verdict from an event and from a probe", () => {
    const fromEvent = observationFromRateLimitEvent(
      { type: "rate_limit_event", rate_limit_info: { unifiedWindows: {
        seven_day: { utilization: 0.45, resetsAt: Math.floor(resetsFor(40, WEEK).getTime() / 1000) } } } },
      now,
    )!;
    const { store } = setup();
    store.record("g1", fromEvent);
    expect(cap(store).available).toBe(false);
  });
});

describe("pace models", () => {
  it("can be replaced without touching callers", () => {
    registerPaceModel({
      id: "never",
      evaluate: () => ({ elapsedPercent: null, expectedPercent: null, delta: null, hold: false }),
    });
    const { store } = setup({ ...on, paceModel: "never" });
    store.record("g1", claude(45, 40, 10, 50));
    expect(cap(store).available).toBe(true);
  });

  it("falls back to linear for an unknown model id", () => {
    const { store } = setup({ ...on, paceModel: "missing" });
    store.record("g1", claude(45, 40, 10, 50));
    expect(cap(store).available).toBe(false);
  });
});
