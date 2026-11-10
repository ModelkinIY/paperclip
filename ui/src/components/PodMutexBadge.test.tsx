// @vitest-environment jsdom
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { IssueBlockerAttention, IssuePodMutexState } from "@paperclipai/shared";
import { PodMutexBadge, podMutexBadgeText } from "./PodMutexBadge";
import { getStatusIconLabel } from "./StatusIcon";
import { runPodMutexWaitText } from "../pages/AgentDetail.production";

const base: IssuePodMutexState = {
  labelId: "l1", labelName: "pod:igor-3090", labelColor: "#000", rootIssueId: "r1",
  role: "waiting", holderRootIssueId: "h1", holderIdentifier: "INF-123",
};

describe("pod mutex UI", () => {
  it("badge text for holder / waiting", () => {
    expect(podMutexBadgeText({ ...base, role: "holder", holderIdentifier: null })).toBe("pod:igor-3090 · holding");
    expect(podMutexBadgeText(base)).toBe("pod:igor-3090 · waiting for INF-123");
  });

  it("badge renders for holder/waiting, not for free unless asked", () => {
    expect(renderToStaticMarkup(<PodMutexBadge state={base} />)).toContain("waiting for INF-123");
    expect(renderToStaticMarkup(<PodMutexBadge state={{ ...base, role: "free" }} />)).toBe("");
    expect(renderToStaticMarkup(<PodMutexBadge state={null} />)).toBe("");
    expect(renderToStaticMarkup(<PodMutexBadge state={{ ...base, role: "free" }} showFree />)).toContain("free");
  });

  it("StatusIcon label for waiting_on_resource", () => {
    const attention: IssueBlockerAttention = {
      state: "covered", reason: "waiting_on_resource", unresolvedBlockerCount: 0, coveredBlockerCount: 0,
      stalledBlockerCount: 0, attentionBlockerCount: 0, sampleBlockerIdentifier: null, sampleStalledBlockerIdentifier: null,
      resource: { labelId: "l1", labelName: "pod:igor-3090", holderRootIssueId: "h1", holderIdentifier: "INF-123" },
    };
    expect(getStatusIconLabel("blocked", null, attention)).toBe("Waiting · pod:igor-3090 held by INF-123");
  });

  it("queued run row text from contextSnapshot.podMutex", () => {
    const contextSnapshot = { issueId: "i1", podMutex: { labelId: "l1", label: "pod:x", holderRootIssueId: "h1", holderIdentifier: "INF-123", since: "" } };
    expect(runPodMutexWaitText({ status: "queued", contextSnapshot } as never)).toBe("queued — waiting for pod:x held by INF-123");
    expect(runPodMutexWaitText({ status: "running", contextSnapshot } as never)).toBeNull();
    expect(runPodMutexWaitText({ status: "queued", contextSnapshot: { issueId: "i1" } } as never)).toBeNull();
  });
});
