// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { aiLimitWaitLabel, readAiLimitRunWait } from "@paperclipai/shared";
import { isRunLive, runAiLimitWaitText } from "../pages/AgentDetail.production";
import { collectLiveIssueIds, isLiveIssueRun, isWaitingForAiLimit } from "../lib/liveIssueIds";

const snapshot = { aiLimitWait: { grantId: "g1", provider: "anthropic", accountName: "Claude main", reason: "weekly_ahead_of_pace", heldUntil: "2026-11-14T09:00:00.000Z", since: "2026-11-11T10:00:00.000Z" } };

describe("AI limit wait labels", () => {
  it("reads the wait from a run snapshot and labels it", () => {
    const wait = readAiLimitRunWait(snapshot)!;
    expect(wait.accountName).toBe("Claude main");
    expect(aiLimitWaitLabel(wait)).toBe("waiting for Claude main limit (expected back 2026-11-14 09:00 UTC)");
    expect(readAiLimitRunWait({})).toBeNull();
    expect(readAiLimitRunWait({ aiLimitWait: { reason: "x" } })).toBeNull();
  });

  it("shows the wait only for queued runs", () => {
    expect(runAiLimitWaitText({ status: "queued", contextSnapshot: snapshot })).toBe(
      "queued — waiting for Claude main limit (expected back 2026-11-14 09:00 UTC)");
    expect(runAiLimitWaitText({ status: "running", contextSnapshot: snapshot })).toBeNull();
    expect(runAiLimitWaitText({ status: "queued", contextSnapshot: null })).toBeNull();
  });

  it("does not count a run held by an account limit as live", () => {
    expect(isRunLive({ status: "queued", contextSnapshot: snapshot })).toBe(false);
    expect(isRunLive({ status: "queued", contextSnapshot: {} })).toBe(true);
    expect(isRunLive({ status: "running", contextSnapshot: snapshot })).toBe(true);
    const held = { status: "queued", aiLimitWait: readAiLimitRunWait(snapshot) };
    expect(isWaitingForAiLimit(held)).toBe(true);
    expect(isLiveIssueRun(held)).toBe(false);
    expect(isLiveIssueRun({ status: "queued", aiLimitWait: null })).toBe(true);
  });

  it("leaves held runs out of the live issue set", () => {
    const wait = readAiLimitRunWait(snapshot);
    const runs = [
      { id: "r1", issueId: "i1", status: "queued", aiLimitWait: wait },
      { id: "r2", issueId: "i2", status: "queued", aiLimitWait: null },
      { id: "r3", issueId: "i3", status: "running", aiLimitWait: null },
    ] as never;
    expect([...collectLiveIssueIds(runs)].sort()).toEqual(["i2", "i3"]);
  });
});
