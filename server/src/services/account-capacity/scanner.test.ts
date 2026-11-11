import { describe, expect, it } from "vitest";
import { createAccountRateLimitScanner } from "./scanner.js";
import type { Observation } from "./types.js";

const event = (u: number) =>
  `{"type":"rate_limit_event","rate_limit_info":{"unifiedWindows":{"seven_day":{"utilization":${u},"resetsAt":1794286800}}}}\n`;
const now = () => new Date("2026-11-04T12:00:00Z");

describe("account rate limit scanner", () => {
  it("records observations under the run's grant, across split chunks", () => {
    const seen: Array<[string, Observation]> = [];
    const s = createAccountRateLimitScanner(() => "g1", (g, o) => seen.push([g, o]), now);
    const line = event(0.11);
    s.push(line.slice(0, 40));
    s.push(line.slice(40));
    expect(seen).toHaveLength(1);
    expect(seen[0]![0]).toBe("g1");
    expect(seen[0]![1].windows[0]!.usedPercent).toBeCloseTo(11, 5);
  });

  it("resolves the grant lazily and skips events while it is unknown", () => {
    const seen: string[] = [];
    let grant: string | null = null;
    const s = createAccountRateLimitScanner(() => grant, (g) => seen.push(g), now);
    s.push(event(0.1));
    grant = "g2";
    s.push(event(0.2));
    expect(seen).toEqual(["g2"]);
  });

  it("ignores unrelated and malformed lines and bounds its buffer", () => {
    const seen: string[] = [];
    const s = createAccountRateLimitScanner(() => "g1", (g) => seen.push(g), now);
    s.push("plain line\n{not json rate_limit_event\n");
    s.push("x".repeat(300 * 1024));
    s.push(event(0.3));
    expect(seen).toEqual(["g1"]);
  });
});
