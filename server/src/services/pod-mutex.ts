/**
 * Pod mutex (inferdyne fork).
 *
 * A label configured in `pod_mutex_labels` names a shared resource (a GPU pod,
 * e.g. `pod:igor-3090`). The label is put on a root issue; every descendant
 * (parentId chain, any depth) belongs to that tree implicitly. The effective
 * mutex of an issue is the enabled mutex label on the issue itself or on its
 * NEAREST ancestor (v1: one mutex per tree; if a chain carries several, the
 * nearest wins and the tree root for that mutex is the issue carrying it).
 *
 * - Acquire: checkout of an issue, or the start of a queued run for it, takes
 *   the lease when the mutex is free (`pod_mutex_leases`, unique per label).
 * - Hold: while any issue in the holder tree (holder root + descendants) has a
 *   status in the label's holding statuses. A cancelled/hidden holder root
 *   holds nothing.
 * - Release is LAZY: every gate check verifies the holder still holds and
 *   drops a stale lease; the periodic sweep does the same and wakes the next
 *   waiting tree (highest priority, then oldest).
 * - Inside the holder tree there is no contention. Runs of other trees stay
 *   queued (never skipped/cancelled), checkout returns 409.
 * - No enabled mutex labels for a company → every function is a no-op.
 */
import { and, eq, sql } from "drizzle-orm";
import { issues, labels, podMutexLabels, podMutexLeases, type Db } from "@paperclipai/db";
import { ISSUE_STATUSES } from "@paperclipai/shared";
import { logger } from "../middleware/logger.js";

export const POD_MUTEX_MAX_DEPTH = 64;
export const DEFAULT_HOLDING_STATUSES = ["todo", "in_progress"] as const;

type Executor = Pick<Db, "execute" | "select" | "insert" | "delete" | "update">;

export interface PodMutexConfigRow {
  labelId: string;
  holdingStatuses: string[];
  enabled: boolean;
}

export interface AncestorLabelRow {
  issueId: string;
  depth: number;
  labelId: string;
}

export interface EffectiveMutex {
  labelId: string;
  rootIssueId: string;
  holdingStatuses: string[];
}

export type PodMutexGate =
  | { ok: true; mutex: EffectiveMutex | null }
  | {
    ok: false;
    mutex: EffectiveMutex;
    labelName: string;
    holderRootIssueId: string;
    holderIdentifier: string | null;
  };

export interface WaiterCandidate {
  issueId: string;
  identifier: string | null;
  title: string;
  priority: string;
  status: string;
  rootIssueId: string;
  assigneeAgentId: string | null;
  queuedAgentId: string | null;
  createdAt: Date;
}

const PRIORITY_RANK: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };

/** Pure: nearest enabled mutex label along the ancestor chain (depth 0 = self). */
export function pickEffectiveMutex(
  rows: AncestorLabelRow[],
  configs: Map<string, PodMutexConfigRow>,
): EffectiveMutex | null {
  let best: AncestorLabelRow | null = null;
  for (const row of rows) {
    const config = configs.get(row.labelId);
    if (!config?.enabled) continue;
    if (!best || row.depth < best.depth) best = row;
  }
  if (!best) return null;
  return {
    labelId: best.labelId,
    rootIssueId: best.issueId,
    holdingStatuses: configs.get(best.labelId)!.holdingStatuses,
  };
}

/** Pure: who goes next — highest priority, then oldest. Holder tree excluded. */
export function pickNextWaiter(
  candidates: WaiterCandidate[],
  holderRootIssueId: string | null = null,
): WaiterCandidate | null {
  const eligible = candidates.filter((c) => c.rootIssueId !== holderRootIssueId);
  eligible.sort((a, b) => {
    const pa = PRIORITY_RANK[a.priority] ?? 4;
    const pb = PRIORITY_RANK[b.priority] ?? 4;
    if (pa !== pb) return pa - pb;
    return a.createdAt.getTime() - b.createdAt.getTime();
  });
  return eligible[0] ?? null;
}

export function normalizeHoldingStatuses(input: unknown): string[] {
  if (!Array.isArray(input)) return [...DEFAULT_HOLDING_STATUSES];
  const allowed = new Set<string>(ISSUE_STATUSES);
  return [...new Set(input.filter((s): s is string => typeof s === "string" && allowed.has(s)))];
}

function resultRows<T>(rows: unknown): T[] {
  if (Array.isArray(rows)) return rows as T[];
  const r = rows as { rows?: unknown };
  if (r && Array.isArray(r.rows)) return r.rows as T[];
  return Array.from(rows as Iterable<T>);
}

function statusList(statuses: string[]) {
  return sql.join(statuses.map((s) => sql`${s}`), sql`, `);
}

export interface PodMutexWakeDeps {
  wakeup?: (agentId: string, opts: Record<string, unknown>) => Promise<unknown>;
  resumeQueuedRuns?: (scope: { companyId: string }) => Promise<unknown>;
}

export function podMutexService(db: Db | Executor) {
  const x = db as Db;

  async function listConfigs(companyId: string, onlyEnabled = true) {
    const rows = await x
      .select({
        labelId: podMutexLabels.labelId,
        holdingStatuses: podMutexLabels.holdingStatuses,
        enabled: podMutexLabels.enabled,
      })
      .from(podMutexLabels)
      .where(
        onlyEnabled
          ? and(eq(podMutexLabels.companyId, companyId), eq(podMutexLabels.enabled, true))
          : eq(podMutexLabels.companyId, companyId),
      );
    return new Map(rows.map((r) => [r.labelId, r]));
  }

  async function hasEnabled(companyId: string) {
    return (await listConfigs(companyId)).size > 0;
  }

  async function resolveEffectiveMutex(
    companyId: string,
    issueId: string,
    configs?: Map<string, PodMutexConfigRow>,
  ): Promise<EffectiveMutex | null> {
    const cfg = configs ?? (await listConfigs(companyId));
    if (cfg.size === 0) return null;
    const labelIds = [...cfg.keys()];
    const rows = resultRows<{ issueId: string; depth: number; labelId: string }>(
      await x.execute(sql`
        WITH RECURSIVE chain(issue_id, parent_id, depth, visited) AS (
          SELECT i.id, i.parent_id, 0, ARRAY[i.id]
          FROM issues i
          WHERE i.id = ${issueId} AND i.company_id = ${companyId}
          UNION ALL
          SELECT p.id, p.parent_id, chain.depth + 1, chain.visited || p.id
          FROM chain
          JOIN issues p ON p.id = chain.parent_id
          WHERE p.company_id = ${companyId}
            AND chain.depth < ${POD_MUTEX_MAX_DEPTH}
            AND NOT p.id = ANY(chain.visited)
        )
        SELECT chain.issue_id::text AS "issueId", chain.depth::int AS "depth", il.label_id::text AS "labelId"
        FROM chain
        JOIN issue_labels il ON il.issue_id = chain.issue_id
        WHERE il.label_id::text IN (${statusList(labelIds)})
        ORDER BY chain.depth ASC
      `),
    );
    return pickEffectiveMutex(
      rows.map((r) => ({ ...r, depth: Number(r.depth) })),
      cfg,
    );
  }

  /** Does any issue of the tree rooted at rootIssueId hold the mutex? */
  async function treeHolds(companyId: string, rootIssueId: string, holdingStatuses: string[]) {
    if (holdingStatuses.length === 0) return false;
    const rows = resultRows<{ holds: boolean }>(
      await x.execute(sql`
        WITH RECURSIVE tree(issue_id, depth, visited) AS (
          SELECT i.id, 0, ARRAY[i.id]
          FROM issues i
          WHERE i.id = ${rootIssueId} AND i.company_id = ${companyId}
            AND i.hidden_at IS NULL AND i.status <> 'cancelled'
          UNION ALL
          SELECT c.id, tree.depth + 1, tree.visited || c.id
          FROM tree
          JOIN issues c ON c.parent_id = tree.issue_id
          WHERE c.company_id = ${companyId}
            AND c.hidden_at IS NULL
            AND tree.depth < ${POD_MUTEX_MAX_DEPTH}
            AND NOT c.id = ANY(tree.visited)
        )
        SELECT EXISTS (
          SELECT 1 FROM tree JOIN issues i ON i.id = tree.issue_id
          WHERE i.status IN (${statusList(holdingStatuses)})
        ) AS holds
      `),
    );
    return rows[0]?.holds === true;
  }

  async function getLease(companyId: string, labelId: string) {
    return x
      .select()
      .from(podMutexLeases)
      .where(and(eq(podMutexLeases.companyId, companyId), eq(podMutexLeases.labelId, labelId)))
      .then((rows) => rows[0] ?? null);
  }

  async function deleteLease(leaseId: string) {
    await x.delete(podMutexLeases).where(eq(podMutexLeases.id, leaseId));
  }

  async function blockedGate(companyId: string, mutex: EffectiveMutex, holderRootIssueId: string): Promise<PodMutexGate> {
    const [label] = await x.select({ name: labels.name }).from(labels).where(eq(labels.id, mutex.labelId));
    const [holder] = await x
      .select({ identifier: issues.identifier })
      .from(issues)
      .where(and(eq(issues.id, holderRootIssueId), eq(issues.companyId, companyId)));
    return {
      ok: false,
      mutex,
      labelName: label?.name ?? mutex.labelId,
      holderRootIssueId,
      holderIdentifier: holder?.identifier ?? null,
    };
  }

  /**
   * Gate + acquire. Returns ok when the issue has no mutex, its tree already
   * holds it, or the mutex was free (now taken). A stale lease is released here.
   */
  async function tryAcquire(companyId: string, issueId: string): Promise<PodMutexGate> {
    const configs = await listConfigs(companyId);
    if (configs.size === 0) return { ok: true, mutex: null };
    const mutex = await resolveEffectiveMutex(companyId, issueId, configs);
    if (!mutex) return { ok: true, mutex: null };
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const lease = await getLease(companyId, mutex.labelId);
      if (lease) {
        if (lease.holderRootIssueId === mutex.rootIssueId) return { ok: true, mutex };
        const holderConfig = configs.get(mutex.labelId)!;
        if (await treeHolds(companyId, lease.holderRootIssueId, holderConfig.holdingStatuses)) {
          return blockedGate(companyId, mutex, lease.holderRootIssueId);
        }
        logger.info(
          { companyId, labelId: mutex.labelId, holderRootIssueId: lease.holderRootIssueId },
          "pod mutex: releasing stale lease at gate",
        );
        await deleteLease(lease.id);
      }
      const inserted = await x
        .insert(podMutexLeases)
        .values({
          companyId,
          labelId: mutex.labelId,
          holderRootIssueId: mutex.rootIssueId,
          acquiredByIssueId: issueId,
        })
        .onConflictDoNothing()
        .returning({ id: podMutexLeases.id });
      if (inserted.length > 0) {
        logger.info(
          { companyId, labelId: mutex.labelId, holderRootIssueId: mutex.rootIssueId, issueId },
          "pod mutex acquired",
        );
        return { ok: true, mutex };
      }
    }
    const lease = await getLease(companyId, mutex.labelId);
    if (lease && lease.holderRootIssueId !== mutex.rootIssueId) {
      return blockedGate(companyId, mutex, lease.holderRootIssueId);
    }
    return { ok: true, mutex };
  }

  async function listWaiters(companyId: string, labelId: string): Promise<WaiterCandidate[]> {
    const rows = resultRows<{
      issueId: string; identifier: string | null; title: string; priority: string; status: string;
      rootIssueId: string; assigneeAgentId: string | null; queuedAgentId: string | null; createdAt: string | Date;
    }>(
      await x.execute(sql`
        WITH RECURSIVE tree(root_id, issue_id, depth, visited) AS (
          SELECT il.issue_id, il.issue_id, 0, ARRAY[il.issue_id]
          FROM issue_labels il
          JOIN issues r ON r.id = il.issue_id
          WHERE il.company_id = ${companyId} AND il.label_id = ${labelId}
            AND r.hidden_at IS NULL AND r.status <> 'cancelled'
          UNION ALL
          SELECT tree.root_id, c.id, tree.depth + 1, tree.visited || c.id
          FROM tree
          JOIN issues c ON c.parent_id = tree.issue_id
          WHERE c.company_id = ${companyId}
            AND c.hidden_at IS NULL
            AND tree.depth < ${POD_MUTEX_MAX_DEPTH}
            AND NOT c.id = ANY(tree.visited)
        ),
        candidates AS (
          SELECT DISTINCT ON (i.id)
            i.id, i.identifier, i.title, i.priority, i.status, i.assignee_agent_id, i.created_at, tree.root_id,
            (
              SELECT r.agent_id FROM heartbeat_runs r
              WHERE r.company_id = ${companyId} AND r.status = 'queued'
                AND r.context_snapshot ->> 'issueId' = i.id::text
              ORDER BY r.created_at ASC LIMIT 1
            ) AS queued_agent_id
          FROM tree JOIN issues i ON i.id = tree.issue_id
          ORDER BY i.id, tree.depth ASC
        )
        SELECT id::text AS "issueId", identifier, title, priority, status,
          root_id::text AS "rootIssueId", assignee_agent_id::text AS "assigneeAgentId",
          queued_agent_id::text AS "queuedAgentId", created_at AS "createdAt"
        FROM candidates
        WHERE queued_agent_id IS NOT NULL OR (status = 'todo' AND assignee_agent_id IS NOT NULL)
      `),
    );
    return rows.map((r) => ({ ...r, createdAt: new Date(r.createdAt) }));
  }

  async function wakeWaiter(companyId: string, waiter: WaiterCandidate, deps: PodMutexWakeDeps) {
    if (waiter.queuedAgentId) {
      await deps.resumeQueuedRuns?.({ companyId });
      return;
    }
    if (waiter.assigneeAgentId && deps.wakeup) {
      await deps.wakeup(waiter.assigneeAgentId, {
        source: "automation",
        triggerDetail: "system",
        reason: "pod_mutex_released",
        payload: { issueId: waiter.issueId, mutation: "pod_mutex_released" },
        contextSnapshot: { issueId: waiter.issueId, taskKey: waiter.issueId, source: "pod_mutex_released" },
      });
    }
  }

  /**
   * Periodic sweep: drop leases whose holder tree no longer holds and wake the
   * next waiter of every free mutex label. Waiters with a queued run are
   * re-dispatched (cheap, idempotent); a todo issue without a run is only
   * woken right after a release, to avoid waking it every tick.
   */
  async function sweep(deps: PodMutexWakeDeps = {}, scope?: { companyId: string }) {
    const configRows = await x
      .select()
      .from(podMutexLabels)
      .where(scope ? and(eq(podMutexLabels.companyId, scope.companyId), eq(podMutexLabels.enabled, true)) : eq(podMutexLabels.enabled, true));
    let released = 0;
    for (const config of configRows) {
      try {
        let justReleased = false;
        const lease = await getLease(config.companyId, config.labelId);
        if (lease) {
          if (await treeHolds(config.companyId, lease.holderRootIssueId, config.holdingStatuses)) continue;
          await deleteLease(lease.id);
          justReleased = true;
          released += 1;
          logger.info(
            { companyId: config.companyId, labelId: config.labelId, holderRootIssueId: lease.holderRootIssueId },
            "pod mutex released (holder tree has no holding issues)",
          );
        }
        const next = pickNextWaiter(
          (await listWaiters(config.companyId, config.labelId)).filter((w) => justReleased || w.queuedAgentId),
        );
        if (next) await wakeWaiter(config.companyId, next, deps);
      } catch (err) {
        logger.error({ err, companyId: config.companyId, labelId: config.labelId }, "pod mutex sweep failed");
      }
    }
    return { released };
  }

  // ---- admin ----

  async function list(companyId: string) {
    const rows = await x
      .select({
        id: podMutexLabels.id,
        labelId: podMutexLabels.labelId,
        labelName: labels.name,
        labelColor: labels.color,
        holdingStatuses: podMutexLabels.holdingStatuses,
        enabled: podMutexLabels.enabled,
        createdAt: podMutexLabels.createdAt,
        updatedAt: podMutexLabels.updatedAt,
      })
      .from(podMutexLabels)
      .innerJoin(labels, eq(labels.id, podMutexLabels.labelId))
      .where(eq(podMutexLabels.companyId, companyId))
      .orderBy(labels.name);
    const result = [];
    for (const row of rows) {
      const lease = await getLease(companyId, row.labelId);
      let holder = null;
      if (lease) {
        const [issue] = await x
          .select({ id: issues.id, identifier: issues.identifier, title: issues.title, status: issues.status })
          .from(issues)
          .where(eq(issues.id, lease.holderRootIssueId));
        holder = {
          rootIssueId: lease.holderRootIssueId,
          identifier: issue?.identifier ?? null,
          title: issue?.title ?? null,
          acquiredAt: lease.acquiredAt,
          acquiredByIssueId: lease.acquiredByIssueId,
          stillHolding: await treeHolds(companyId, lease.holderRootIssueId, row.holdingStatuses),
        };
      }
      const waiters = (await listWaiters(companyId, row.labelId))
        .filter((w) => w.rootIssueId !== lease?.holderRootIssueId);
      waiters.sort((a, b) => {
        const pa = PRIORITY_RANK[a.priority] ?? 4;
        const pb = PRIORITY_RANK[b.priority] ?? 4;
        return pa !== pb ? pa - pb : a.createdAt.getTime() - b.createdAt.getTime();
      });
      result.push({
        ...row,
        holder,
        waiting: waiters.map((w) => ({
          issueId: w.issueId,
          identifier: w.identifier,
          title: w.title,
          priority: w.priority,
          status: w.status,
          hasQueuedRun: Boolean(w.queuedAgentId),
        })),
      });
    }
    return result;
  }

  async function upsert(
    companyId: string,
    input: { labelId?: string | null; labelName?: string | null; holdingStatuses?: unknown; enabled?: boolean },
  ) {
    let labelId = input.labelId ?? null;
    if (!labelId) {
      const name = input.labelName?.trim();
      if (!name) throw new Error("labelId or labelName is required");
      const [existing] = await x
        .select({ id: labels.id })
        .from(labels)
        .where(and(eq(labels.companyId, companyId), eq(labels.name, name)));
      if (existing) labelId = existing.id;
      else {
        const [created] = await x
          .insert(labels)
          .values({ companyId, name, color: "#0ea5e9" })
          .returning({ id: labels.id });
        labelId = created!.id;
      }
    } else {
      const [label] = await x
        .select({ id: labels.id })
        .from(labels)
        .where(and(eq(labels.id, labelId), eq(labels.companyId, companyId)));
      if (!label) return null;
    }
    const holdingStatuses = input.holdingStatuses === undefined ? undefined : normalizeHoldingStatuses(input.holdingStatuses);
    const now = new Date();
    const [row] = await x
      .insert(podMutexLabels)
      .values({
        companyId,
        labelId,
        holdingStatuses: holdingStatuses ?? [...DEFAULT_HOLDING_STATUSES],
        enabled: input.enabled ?? true,
      })
      .onConflictDoUpdate({
        target: [podMutexLabels.companyId, podMutexLabels.labelId],
        set: {
          ...(holdingStatuses ? { holdingStatuses } : {}),
          ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
          updatedAt: now,
        },
      })
      .returning();
    return row;
  }

  async function remove(companyId: string, labelId: string) {
    await x
      .delete(podMutexLeases)
      .where(and(eq(podMutexLeases.companyId, companyId), eq(podMutexLeases.labelId, labelId)));
    const deleted = await x
      .delete(podMutexLabels)
      .where(and(eq(podMutexLabels.companyId, companyId), eq(podMutexLabels.labelId, labelId)))
      .returning({ id: podMutexLabels.id });
    return deleted.length > 0;
  }

  async function forceRelease(companyId: string, labelId: string) {
    const deleted = await x
      .delete(podMutexLeases)
      .where(and(eq(podMutexLeases.companyId, companyId), eq(podMutexLeases.labelId, labelId)))
      .returning();
    return deleted[0] ?? null;
  }

  return {
    listConfigs,
    hasEnabled,
    resolveEffectiveMutex,
    treeHolds,
    tryAcquire,
    listWaiters,
    sweep,
    list,
    upsert,
    remove,
    forceRelease,
  };
}

export function podMutexConflictMessage(gate: Extract<PodMutexGate, { ok: false }>) {
  return `Resource "${gate.labelName}" is held by ${gate.holderIdentifier ?? gate.holderRootIssueId}; waiting until that tree has no issues in its holding statuses (pod mutex)`;
}
