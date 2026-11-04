import { beforeEach, describe, expect, it } from "vitest";
import {
  WEEK_SECONDS,
  createRateLimitEventScanner,
  evaluateWeeklyPace,
  observationFromRateLimitEvent,
  recordWeeklyPaceObservation,
  resetWeeklyPaceStateForTests,
  shouldHoldNewRunForWeeklyPace,
  weeklyPaceDelta,
} from "./weekly-pace.js";

const C = "company-1";
const now = new Date("2026-11-04T12:00:00Z");
/** resetsAt such that `elapsedPercent` of the week has passed at `now`. */
const resetsFor = (elapsedPercent: number) =>
  new Date(now.getTime() + (1 - elapsedPercent / 100) * WEEK_SECONDS * 1000);
const held = { companyId: C, runtimeConfig: { weeklyPace: { hold: true } } };
const free = { companyId: C, runtimeConfig: {} };
const observe = (usedPercent: number, elapsedPercent: number, at = now) =>
  recordWeeklyPaceObservation(C, { usedPercent, resetsAt: resetsFor(elapsedPercent), observedAt: at, source: "run_output" });

beforeEach(() => resetWeeklyPaceStateForTests());

describe("weekly pace", () => {
  it("computes delta as used minus elapsed share of the week", () => {
    expect(weeklyPaceDelta({ usedPercent: 35, resetsAt: resetsFor(40), observedAt: now, source: "run_output" }, now))
      .toBeCloseTo(-5, 5);
  });

  it("does not hold without an observation", () => {
    expect(shouldHoldNewRunForWeeklyPace(held, now)).toBe(false);
  });

  it("holds only agents that opted in, and only when ahead of pace", () => {
    observe(45, 40);
    expect(shouldHoldNewRunForWeeklyPace(held, now)).toBe(true);
    expect(shouldHoldNewRunForWeeklyPace(free, now)).toBe(false);
  });

  it("releases with hysteresis", () => {
    observe(41, 40);
    expect(evaluateWeeklyPace(C, now).held).toBe(true);
    observe(39, 40, new Date(now.getTime() + 1));
    expect(evaluateWeeklyPace(C, now).held).toBe(true); // -1: inside the band, still held
    observe(37, 40, new Date(now.getTime() + 2));
    const r = evaluateWeeklyPace(C, now);
    expect(r.held).toBe(false);
    expect(r.changed).toBe(true);
  });

  it("time passing releases a stale hold", () => {
    observe(41, 40);
    expect(evaluateWeeklyPace(C, now).held).toBe(true);
    const later = new Date(now.getTime() + 0.05 * WEEK_SECONDS * 1000); // +5% of the week
    expect(evaluateWeeklyPace(C, later).held).toBe(false);
  });

  it("keeps the newest observation", () => {
    observe(10, 40, new Date(now.getTime() + 1000));
    observe(90, 40, now);
    expect(evaluateWeeklyPace(C, now).held).toBe(false);
  });

  it("parses Claude Code rate_limit_event (utilization is a fraction)", () => {
    const o = observationFromRateLimitEvent({
      type: "rate_limit_event",
      rate_limit_info: { status: "allowed", unifiedWindows: {
        five_hour: { utilization: 0.08, resetsAt: 1793813400 },
        seven_day: { utilization: 0.11, resetsAt: 1794286800, status: "allowed" },
      } },
    }, now);
    expect(o?.usedPercent).toBeCloseTo(11, 5);
    expect(o?.resetsAt.getTime()).toBe(1794286800 * 1000);
    expect(observationFromRateLimitEvent({ type: "assistant" }, now)).toBeNull();
    expect(observationFromRateLimitEvent({ type: "rate_limit_event", rate_limit_info: {} }, now)).toBeNull();
  });

  it("scanner records events split across chunks and ignores other lines", () => {
    const reset = Math.floor(resetsFor(40).getTime() / 1000);
    const line = JSON.stringify({ type: "rate_limit_event", rate_limit_info: { unifiedWindows: {
      seven_day: { utilization: 0.5, resetsAt: reset } } } });
    const scanner = createRateLimitEventScanner(C, () => now);
    scanner.push('{"type":"assistant"}\n' + line.slice(0, 30));
    expect(evaluateWeeklyPace(C, now).held).toBe(false);
    scanner.push(line.slice(30) + "\nnot json rate_limit_event\n");
    expect(evaluateWeeklyPace(C, now).held).toBe(true); // 50 used vs 40 elapsed
  });
});
