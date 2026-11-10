/**
 * inferdyne fork: pod mutex (a label configured as a lock over a shared
 * resource, e.g. a GPU pod). Request/response contract shared by the server
 * (routes/pod-mutex.ts, services/pod-mutex.ts) and the UI (pages/Resources).
 */
import { z } from "zod";
import { ISSUE_STATUSES, type IssueStatus } from "./constants.js";

export const POD_MUTEX_DEFAULT_HOLDING_STATUSES = ["todo", "in_progress"] as const satisfies readonly IssueStatus[];

/** Body of POST /companies/:companyId/pod-mutexes and PATCH .../:labelId. */
export const podMutexUpsertSchema = z.object({
  labelId: z.string().uuid().optional().nullable(),
  labelName: z.string().trim().min(1).max(100).optional().nullable(),
  /** At least one status: an empty list would make the mutex a silent no-op. */
  holdingStatuses: z.array(z.enum(ISSUE_STATUSES)).min(1).optional(),
  enabled: z.boolean().optional(),
});
export type PodMutexUpsertInput = z.infer<typeof podMutexUpsertSchema>;

export const podMutexLabelParamsSchema = z.object({
  companyId: z.string().min(1),
  labelId: z.string().uuid(),
});

export interface PodMutexHolder {
  rootIssueId: string;
  identifier: string | null;
  title: string | null;
  acquiredAt: string | Date;
  acquiredByIssueId: string | null;
  /** Some issue of the holder tree is still in a holding status. */
  stillHolding: boolean;
  /** A run (queued excluded) of the holder tree is running right now. */
  hasRunningRun: boolean;
  /** Last time a run of the holder tree was running/finished; null if never. */
  lastRunActivityAt: string | Date | null;
}

export interface PodMutexWaiter {
  issueId: string;
  identifier: string | null;
  title: string;
  priority: string;
  status: string;
  hasQueuedRun: boolean;
}

export interface PodMutexEntry {
  id: string;
  labelId: string;
  labelName: string;
  labelColor: string;
  holdingStatuses: IssueStatus[];
  enabled: boolean;
  createdAt: string | Date;
  updatedAt: string | Date;
  holder: PodMutexHolder | null;
  waiting: PodMutexWaiter[];
}

export interface PodMutexConfigRowResponse {
  id: string;
  companyId: string;
  labelId: string;
  holdingStatuses: IssueStatus[];
  enabled: boolean;
  createdAt: string | Date;
  updatedAt: string | Date;
}

/** GET /companies/:id/pod-mutexes/labels: enabled mutex label ids only (cheap; label picker). */
export interface PodMutexLabelsResponse {
  labelIds: string[];
}

export interface PodMutexReleaseResponse {
  ok: true;
  /** A lease was held and has been dropped. */
  released: boolean;
  /** Same as `released`: whether anything was held before the call. */
  held: boolean;
  holderRootIssueId: string | null;
  /** The former holder tree still has a running run (it keeps using the pod). */
  holderHasRunningRun: boolean;
}

/** 409 details for checkout / status move / create blocked by a pod mutex. */
export interface PodMutexConflictDetails {
  issueId: string | null;
  reason: "pod_mutex_held";
  labelId: string;
  labelName: string;
  holderRootIssueId: string;
  holderIdentifier: string | null;
}

/** Persisted on a queued run's contextSnapshot.podMutex while it waits. */
export interface PodMutexRunWait {
  labelId: string;
  label: string;
  holderRootIssueId: string;
  holderIdentifier: string | null;
  since: string;
}

/** Per-issue pod mutex state attached to issue list rows and issue detail. */
export interface IssuePodMutexState {
  labelId: string;
  labelName: string;
  labelColor: string | null;
  rootIssueId: string;
  /** holder: this issue's tree holds the pod; waiting: another tree holds it; free: nobody. */
  role: "holder" | "waiting" | "free";
  holderRootIssueId: string | null;
  holderIdentifier: string | null;
}

export function readPodMutexRunWait(contextSnapshot: unknown): PodMutexRunWait | null {
  if (!contextSnapshot || typeof contextSnapshot !== "object") return null;
  const raw = (contextSnapshot as Record<string, unknown>).podMutex;
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.label !== "string" || typeof r.holderRootIssueId !== "string") return null;
  return {
    labelId: typeof r.labelId === "string" ? r.labelId : "",
    label: r.label,
    holderRootIssueId: r.holderRootIssueId,
    holderIdentifier: typeof r.holderIdentifier === "string" ? r.holderIdentifier : null,
    since: typeof r.since === "string" ? r.since : "",
  };
}

export function podMutexWaitLabel(wait: { label: string; holderIdentifier: string | null; holderRootIssueId?: string | null }) {
  return `waiting for ${wait.label} held by ${wait.holderIdentifier ?? wait.holderRootIssueId ?? "another task"}`;
}
