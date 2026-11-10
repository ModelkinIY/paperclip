/**
 * inferdyne fork: pod mutex checks on issue writes (routes/issues.ts).
 *
 * Policy (owner decision, documented here):
 * - An AGENT moving an issue INTO a holding status (or creating one in a
 *   holding status) under a pod held by another tree gets 409 with the same
 *   payload as checkout (reason "pod_mutex_held").
 * - A BOARD user (human) may override: the write goes through and a
 *   "pod_mutex.conflict_override" activity is logged on the issue.
 * - A label/parent change that moves an issue already in a holding status
 *   under a held pod (re-parenting, adding the label to a running issue) is
 *   never refused and never kills runs: "pod_mutex.conflict_warning" activity.
 */
import { eq } from "drizzle-orm";
import { issueLabels, type Db } from "@paperclipai/db";
import type { IssueBlockerAttention, IssuePodMutexState } from "@paperclipai/shared";
import { conflict } from "../errors.js";
import { logger } from "../middleware/logger.js";
import { logActivity } from "./activity-log.js";
import { podMutexConflictDetails, podMutexConflictMessage, podMutexService, type PodMutexIssueWriteInput } from "./pod-mutex.js";

export interface PodMutexWriteActor {
  /** "board" = human board user; anything else is enforced. */
  kind: "board" | "agent" | "other";
  actorType: "agent" | "user" | "system";
  actorId: string;
  agentId?: string | null;
  runId?: string | null;
}

export async function issueLabelIds(db: Db, issueId: string): Promise<string[]> {
  try {
    const rows = await db.select({ labelId: issueLabels.labelId }).from(issueLabels).where(eq(issueLabels.issueId, issueId));
    return rows.map((r) => r.labelId);
  } catch (err) {
    logger.warn({ err, issueId }, "pod mutex: issue label lookup failed");
    return [];
  }
}

type PodMutexIssueWriteRequest = {
  companyId: string;
  issueId: string | null;
  before: { status: string; parentId: string | null; labelIds: string[] } | null;
  after: { status: string; parentId: string | null; labelIds: string[] };
} | {
  companyId: string;
  issueId: string | null;
  /** Called only when a mutex label is configured (keeps unconfigured companies to one config lookup). */
  load: () => Promise<Omit<PodMutexIssueWriteInput, "issueId">>;
};

export interface PodMutexWriteOutcome {
  companyId: string;
  issueId: string | null;
  action: "pod_mutex.conflict_override" | "pod_mutex.conflict_warning";
  details: ReturnType<typeof podMutexConflictDetails> & { cause: "status" | "tree" };
}

/**
 * The check alone: throws 409 for an enforced conflict, returns what must be
 * logged otherwise (board override / tree warning), logs nothing. Callers log
 * with logPodMutexWriteOutcome once the write has gone through.
 */
export async function checkPodMutexOnIssueWrite(
  db: Db,
  actor: PodMutexWriteActor,
  input: PodMutexIssueWriteRequest,
): Promise<PodMutexWriteOutcome | null> {
  let result: Awaited<ReturnType<ReturnType<typeof podMutexService>["checkIssueWrite"]>>;
  try {
    result = await podMutexService(db).checkIssueWrite(
      input.companyId,
      "load" in input ? async () => ({ issueId: input.issueId, ...(await input.load()) }) : input,
    );
  } catch (err) {
    // Fail open: the lease itself is still enforced at checkout and run claim.
    logger.warn({ err, companyId: input.companyId, issueId: input.issueId }, "pod mutex: issue write check failed");
    return null;
  }
  if (!result) return null;
  const details = { ...podMutexConflictDetails(result.gate, input.issueId), cause: result.cause };
  if (result.cause === "status" && actor.kind !== "board") {
    throw conflict(podMutexConflictMessage(result.gate), details);
  }
  return {
    companyId: input.companyId,
    issueId: input.issueId,
    action: result.cause === "status" ? "pod_mutex.conflict_override" : "pod_mutex.conflict_warning",
    details,
  };
}

export async function logPodMutexWriteOutcome(db: Db, actor: PodMutexWriteActor, outcome: PodMutexWriteOutcome) {
  await logActivity(db, {
    companyId: outcome.companyId,
    actorType: actor.actorType,
    actorId: actor.actorId,
    agentId: actor.agentId ?? null,
    runId: actor.runId ?? null,
    action: outcome.action,
    entityType: outcome.issueId ? "issue" : "label",
    entityId: outcome.issueId ?? outcome.details.labelId,
    issueId: outcome.issueId,
    details: { ...outcome.details },
  });
}

/** Check + log in one step (issue update). */
export async function enforcePodMutexOnIssueWrite(
  db: Db,
  actor: PodMutexWriteActor,
  input: PodMutexIssueWriteRequest,
) {
  const outcome = await checkPodMutexOnIssueWrite(db, actor, input);
  if (!outcome) return null;
  await logPodMutexWriteOutcome(db, actor, outcome);
  return outcome.details;
}

/**
 * Attach `podMutex` (holder / waiting / free) to issue rows. A BLOCKED issue
 * whose tree waits on a pod held by another tree and has no edge-driven
 * blocker attention gets blockerAttention reason "waiting_on_resource"
 * (separate pass: blockerAttention itself is computed from blocker edges).
 * Todo issues keep their status; the UI shows the badge from `podMutex`.
 */
export async function attachPodMutexStates<T extends { id: string; status: string; blockerAttention?: IssueBlockerAttention }>(
  db: Db,
  companyId: string,
  rows: T[],
): Promise<T[]> {
  if (!Array.isArray(rows) || rows.length === 0) return rows;
  let states: Map<string, IssuePodMutexState>;
  try {
    states = await podMutexService(db).issueStates(companyId, rows.map((row) => row.id));
  } catch (err) {
    logger.warn({ err, companyId }, "pod mutex: issue state lookup failed");
    return rows;
  }
  if (states.size === 0) return rows;
  return rows.map((row) => {
    const state = states.get(row.id);
    if (!state) return row;
    const next: T & { podMutex: IssuePodMutexState } = { ...row, podMutex: state };
    if (
      state.role === "waiting" &&
      row.status === "blocked" &&
      (!row.blockerAttention || row.blockerAttention.state === "none")
    ) {
      next.blockerAttention = {
        state: "covered",
        reason: "waiting_on_resource",
        unresolvedBlockerCount: row.blockerAttention?.unresolvedBlockerCount ?? 0,
        coveredBlockerCount: 0,
        stalledBlockerCount: 0,
        attentionBlockerCount: 0,
        sampleBlockerIdentifier: state.holderIdentifier,
        sampleStalledBlockerIdentifier: null,
        resource: {
          labelId: state.labelId,
          labelName: state.labelName,
          holderRootIssueId: state.holderRootIssueId!,
          holderIdentifier: state.holderIdentifier,
        },
      };
    }
    return next;
  });
}
