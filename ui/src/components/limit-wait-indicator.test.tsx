// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { aiLimitWaitLabel, readAiLimitRunWait } from "@paperclipai/shared";
import { runAiLimitWaitText } from "../pages/AgentDetail.production";

const snapshot = { aiLimitWait: { grantId: "g1", provider: "anthropic", accountName: "Claude main", reason: "weekly_ahead_of_pace", heldUntil: "2026-11-14T09:00:00.000Z", since: "2026-11-11T10:00:00.000Z" } };

describe("AI limit wait labels", () => {
  it("reads the wait from a run snapshot and labels it", () => {
    const wait = readAiLimitRunWait(snapshot)!;
    expect(wait.accountName).toBe("Claude main");
    expect(aiLimitWaitLabel(wait)).toBe("waiting for Claude main limit (window resets 2026-11-14 09:00 UTC)");
    expect(readAiLimitRunWait({})).toBeNull();
    expect(readAiLimitRunWait({ aiLimitWait: { reason: "x" } })).toBeNull();
  });

  it("shows the wait only for queued runs", () => {
    expect(runAiLimitWaitText({ status: "queued", contextSnapshot: snapshot })).toBe(
      "queued — waiting for Claude main limit (window resets 2026-11-14 09:00 UTC)");
    expect(runAiLimitWaitText({ status: "running", contextSnapshot: snapshot })).toBeNull();
    expect(runAiLimitWaitText({ status: "queued", contextSnapshot: null })).toBeNull();
  });
});
