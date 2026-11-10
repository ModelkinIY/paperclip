/**
 * Pod mutex (inferdyne fork).
 *
 * A label configured in `pod_mutex_labels` names a shared resource (a GPU pod,
 * e.g. `pod:igor-3090`). The label is put on a root issue; every descendant
 * (parentId chain, any depth) belongs to that tree implicitly.
 *
 * Effective mutex of an issue: the NEAREST enabled mutex label on the issue or
 * an ancestor picks the label L. The tree root for L is the FARTHEST ancestor
 * carrying L reachable without crossing an issue that carries a different
 * enabled mutex label (so a sub-task re-tagged with the same label stays in its
 * holder's tree instead of deadlocking against it; a different label nested
 * inside a tree still starts its own tree).
 *
 * - Acquire: checkout of an issue, or the claim of a queued run for it
 *   (claimQueuedRun, every claim path), takes the lease when the mutex is free
 *   (`pod_mutex_leases`, unique per label). Acquire is serialized per label
 *   with a transaction-scoped advisory lock.
 * - Hold: while the holder root still carries the label and any issue in the
 *   holder tree has a status in the label's holding statuses (edited live on
 *   the Resources page; at least one). A cancelled/hidden holder root, a root
 *   that lost the label, a disabled or deleted mutex holds nothing.
 * - Release is LAZY: every gate verifies the holder still holds and drops a
 *   stale lease; the 30s sweep (and every admin action) does the same and wakes
 *   the next waiting tree (highest priority, then oldest). There is no timeout.
 * - Inside the holder tree there is no contention. Runs of other trees stay
 *   queued (never skipped/cancelled; the wait is recorded on the run's
 *   contextSnapshot.podMutex), checkout and agent status moves into a holding
 *   status return 409.
 * - No enabled mutex labels for a company → every function is a no-op.
 */
import { and, eq, inArray, sql } from "drizzle-orm";
import { issues, labels, podMutexLabels, podMutexLeases, type Db } from "@paperclipai/db";
import {
  ISSUE_STATUSES,
  POD_MUTEX_DEFAULT_HOLDING_STATUSES,
  type IssuePodMutexState,
  type PodMutexConflictDetails,
  type PodMutexRunWait,
} from "@paperclipai/shared";
import { logger } from "../middleware/logger.js";
import { logActivity } from "./activity-log.js";

export const POD_MUTEX_MAX_DEPTH = 64;
export const DEFAULT_HOLDING_STATUSES = POD_MUTEX_DEFAULT_HOLDING_STATUSES;

type Executor = Pick<Db, "execute" | "select" | "insert" | "delete" | "update" | "transaction">;

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

export type PodMutexBlocked = {
  ok: false;
  mutex: EffectiveMutex;
  labelName: string;
  holderRootIssueId: string;
  holderIdentifier: string | null;
};

export type PodMutexGate =
  | {
    ok: true;
    mutex: EffectiveMutex | null;
    /** Set only when THIS call inserted the lease (the caller may undo it). */
    acquiredLeaseId?: string;
    acquiredAt?: Date;
  }
  | PodMutexBlocked;

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

/** Per claim pass cache: configs loaded once, resolve + gate results reused. */
export interface PodMutexPass {
  companyId: string;
  configs: Map<string, PodMutexConfigRow>;
  resolved: Map<string, EffectiveMutex | null>;
  gates: Map<string, PodMutexGate>;
}

export interface PodMutexActivityActor {
  actorType: "agent" | "user" | "system";
  actorId: string;
  agentId?: string | null;
  runId?: string | null;
}

const SYSTEM_ACTOR: PodMutexActivityActor = { actorType: "system", actorId: "pod_mutex" };
const PRIORITY_RANK: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };

/**
 * Pure: effective mutex along the ancestor chain (depth 0 = self). Nearest
 * enabled label picks the label; its root is the farthest issue carrying the
 * same label before an issue carrying only a different enabled label.
 */
export function pickEffectiveMutex(
  rows: AncestorLabelRow[],
  configs: Map<string, PodMutexConfigRow>,
): EffectiveMutex | null {
  const enabled = rows
    .filter((row) => configs.get(row.labelId)?.enabled)
    .sort((a, b) => a.depth - b.depth || a.labelId.localeCompare(b.labelId));
  const first = enabled[0];
  if (!first) return null;
  const labelId = first.labelId;
  let root = first.issueId;
  const byDepth = new Map<number, AncestorLabelRow[]>();
  for (const row of enabled) {
    if (row.depth <= first.depth) continue;
    byDepth.set(row.depth, [...(byDepth.get(row.depth) ?? []), row]);
  }
  for (const depth of [...byDepth.keys()].sort((a, b) => a - b)) {
    const same = byDepth.get(depth)!.find((row) => row.labelId === labelId);
    if (same) root = same.issueId;
    else break;
  }
  return { labelId, rootIssueId: root, holdingStatuses: configs.get(labelId)!.holdingStatuses };
}

function sortWaiters(candidates: WaiterCandidate[]) {
  return [...candidates].sort((a, b) => {
    const pa = PRIORITY_RANK[a.priority] ?? 4;
    const pb = PRIORITY_RANK[b.priority] ?? 4;
    if (pa !== pb) return pa - pb;
    return a.createdAt.getTime() - b.createdAt.getTime();
  });
}

/** Pure: who goes next — highest priority, then oldest. Holder tree excluded. */
export function pickNextWaiter(
  candidates: WaiterCandidate[],
  holderRootIssueId: string | null = null,
): WaiterCandidate | null {
  return sortWaiters(candidates.filter((c) => c.rootIssueId !== holderRootIssueId))[0] ?? null;
}

/** Valid, de-duplicated statuses; empty/invalid input falls back to the default. */
export function normalizeHoldingStatuses(input: unknown): string[] {
  if (!Array.isArray(input)) return [...DEFAULT_HOLDING_STATUSES];
  const allowed = new Set<string>(ISSUE_STATUSES);
  const out = [...new Set(input.filter((s): s is string => typeof s === "string" && allowed.has(s)))];
  return out.length > 0 ? out : [...DEFAULT_HOLDING_STATUSES];
}

function resultRows<T>(rows: unknown): T[] {
  if (Array.isArray(rows)) return rows as T[];
  const r = rows as { rows?: unknown };
  if (r && Array.isArray(r.rows)) return r.rows as T[];
  return Array.from(rows as Iterable<T>);
}

function textList(values: string[]) {
  return sql.join(values.map((s) => sql`${s}`), sql`, `);
}

export function podMutexConflictDetails(gate: PodMutexBlocked, issueId: string | null): PodMutexConflictDetails {
  return {
    issueId,
    reason: "pod_mutex_held",
    labelId: gate.mutex.labelId,
    labelName: gate.labelName,
    holderRootIssueId: gate.holderRootIssueId,
    holderIdentifier: gate.holderIdentifier,
  };
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

  async function createPass(companyId: string): Promise<PodMutexPass> {
    return { companyId, configs: await listConfigs(companyId), resolved: new Map(), gates: new Map() };
  }

  /** Mutex-labelled ancestors (incl. self) for many issues in one query. */
  async function ancestorLabels(exec: Db, companyId: string, issueIds: string[], labelIds: string[]) {
    const out = new Map<string, AncestorLabelRow[]>();
    if (issueIds.length === 0 || labelIds.length === 0) return out;
    const rows = resultRows<{ origin: string; issueId: string; depth: number; labelId: string }>(
      await exec.execute(sql`
        WITH RECURSIVE chain(origin, issue_id, parent_id, depth, visited) AS (
          SELECT i.id, i.id, i.parent_id, 0, ARRAY[i.id]
          FROM issues i
          WHERE i.company_id = ${companyId} AND i.id::text IN (${textList(issueIds)})
          UNION ALL
          SELECT chain.origin, p.id, p.parent_id, chain.depth + 1, chain.visited || p.id
          FROM chain
          JOIN issues p ON p.id = chain.parent_id
          WHERE p.company_id = ${companyId}
            AND chain.depth < ${POD_MUTEX_MAX_DEPTH}
            AND NOT p.id = ANY(chain.visited)
        )
        SELECT chain.origin::text AS "origin", chain.issue_id::text AS "issueId",
          chain.depth::int AS "depth", il.label_id::text AS "labelId"
        FROM chain
        JOIN issue_labels il ON il.issue_id = chain.issue_id
        WHERE il.label_id::text IN (${textList(labelIds)})
      `),
    );
    for (const r of rows) {
      out.set(r.origin, [...(out.get(r.origin) ?? []), { issueId: r.issueId, depth: Number(r.depth), labelId: r.labelId }]);
    }
    return out;
  }

  async function resolveMany(
    companyId: string,
    issueIds: string[],
    configs: Map<string, PodMutexConfigRow>,
    exec: Db = x,
  ): Promise<Map<string, EffectiveMutex | null>> {
    const out = new Map<string, EffectiveMutex | null>();
    if (configs.size === 0) return out;
    const byOrigin = await ancestorLabels(exec, companyId, [...new Set(issueIds)], [...configs.keys()]);
    for (const id of issueIds) out.set(id, pickEffectiveMutex(byOrigin.get(id) ?? [], configs));
    return out;
  }

  async function resolveEffectiveMutex(
    companyId: string,
    issueId: string,
    configs?: Map<string, PodMutexConfigRow>,
  ): Promise<EffectiveMutex | null> {
    const cfg = configs ?? (await listConfigs(companyId));
    if (cfg.size === 0) return null;
    return (await resolveMany(companyId, [issueId], cfg)).get(issueId) ?? null;
  }

  /**
   * Effective mutex of an issue as it WOULD be with the given own labels and
   * parent (create / update before the write). `selfIssueId` null = new issue.
   */
  async function resolveHypothetical(
    companyId: string,
    input: { selfIssueId: string | null; selfLabelIds: string[]; parentId: string | null },
    configs: Map<string, PodMutexConfigRow>,
  ): Promise<EffectiveMutex | null> {
    if (configs.size === 0) return null;
    const self = input.selfIssueId ?? "00000000-0000-0000-0000-000000000000";
    const rows: AncestorLabelRow[] = input.selfLabelIds.map((labelId) => ({ issueId: self, depth: 0, labelId }));
    if (input.parentId) {
      const parentRows = (await ancestorLabels(x, companyId, [input.parentId], [...configs.keys()])).get(input.parentId) ?? [];
      // a parent chain that loops back to the issue itself is cut there
      for (const row of parentRows) if (row.issueId !== self) rows.push({ ...row, depth: row.depth + 1 });
    }
    return pickEffectiveMutex(rows, configs);
  }

  /**
   * Does the tree rooted at rootIssueId hold the mutex? With labelId the root
   * must still carry that label (removing it from the root = release).
   */
  async function treeHolds(
    companyId: string,
    rootIssueId: string,
    holdingStatuses: string[],
    labelId?: string,
    exec: Db = x,
  ) {
    if (holdingStatuses.length === 0) return false;
    const rows = resultRows<{ holds: boolean }>(
      await exec.execute(sql`
        WITH RECURSIVE tree(issue_id, depth, visited) AS (
          SELECT i.id, 0, ARRAY[i.id]
          FROM issues i
          WHERE i.id = ${rootIssueId} AND i.company_id = ${companyId}
            AND i.hidden_at IS NULL AND i.status <> 'cancelled'
            ${labelId ? sql`AND EXISTS (SELECT 1 FROM issue_labels il WHERE il.issue_id = i.id AND il.label_id = ${labelId})` : sql``}
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
          WHERE i.status IN (${textList(holdingStatuses)})
        ) AS holds
      `),
    );
    return rows[0]?.holds === true;
  }

  async function getLease(companyId: string, labelId: string, exec: Db = x) {
    return exec
      .select()
      .from(podMutexLeases)
      .where(and(eq(podMutexLeases.companyId, companyId), eq(podMutexLeases.labelId, labelId)))
      .then((rows) => rows[0] ?? null);
  }

  /**
   * Conditional delete: only the exact lease observed. Lease ids are random
   * UUIDs, never reused, so (id, holder) rules out ABA with a newer lease;
   * acquired_at is not compared (Postgres keeps microseconds, a JS Date not).
   */
  async function deleteLeaseIf(
    exec: Db,
    lease: { id: string; holderRootIssueId: string },
  ) {
    const deleted = await exec
      .delete(podMutexLeases)
      .where(and(
        eq(podMutexLeases.id, lease.id),
        eq(podMutexLeases.holderRootIssueId, lease.holderRootIssueId),
      ))
      .returning({ id: podMutexLeases.id });
    return deleted.length > 0;
  }

  async function lockLabel(exec: Db, companyId: string, labelId: string) {
    await exec.execute(sql`SELECT pg_advisory_xact_lock(hashtext('pod_mutex'), hashtext(${`${companyId}:${labelId}`}))`);
  }

  async function logLease(
    exec: Db,
    companyId: string,
    action: "pod_mutex.acquired" | "pod_mutex.released",
    labelId: string,
    details: Record<string, unknown>,
    actor: PodMutexActivityActor = SYSTEM_ACTOR,
  ) {
    await logActivity(exec, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId ?? null,
      runId: actor.runId ?? null,
      action,
      entityType: "label",
      entityId: labelId,
      details,
    });
  }

  async function blockedGate(companyId: string, mutex: EffectiveMutex, holderRootIssueId: string): Promise<PodMutexBlocked> {
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
   * holds it, or the mutex was free (now taken; `acquiredLeaseId` set). A
   * stale lease is released here. Serialized per label (advisory xact lock);
   * inside a caller's transaction the lease commits/rolls back with it.
   */
  async function tryAcquire(
    companyId: string,
    issueId: string,
    opts: { pass?: PodMutexPass; actor?: PodMutexActivityActor } = {},
  ): Promise<PodMutexGate> {
    const pass = opts.pass;
    const configs = pass?.configs ?? (await listConfigs(companyId));
    if (configs.size === 0) return { ok: true, mutex: null };
    let mutex: EffectiveMutex | null;
    if (pass?.resolved.has(issueId)) mutex = pass.resolved.get(issueId)!;
    else {
      mutex = await resolveEffectiveMutex(companyId, issueId, configs);
      pass?.resolved.set(issueId, mutex);
    }
    if (!mutex) return { ok: true, mutex: null };
    const cacheKey = `${mutex.labelId}:${mutex.rootIssueId}`;
    const cached = pass?.gates.get(cacheKey);
    if (cached) return cached;
    const m = mutex;
    const holdingStatuses = configs.get(m.labelId)!.holdingStatuses;
    const outcome = await x.transaction(async (txRaw) => {
      const tx = txRaw as unknown as Db;
      await lockLabel(tx, companyId, m.labelId);
      const lease = await getLease(companyId, m.labelId, tx);
      if (lease) {
        if (lease.holderRootIssueId === m.rootIssueId) return { kind: "held" as const };
        if (await treeHolds(companyId, lease.holderRootIssueId, holdingStatuses, m.labelId, tx)) {
          return { kind: "blocked" as const, holder: lease.holderRootIssueId };
        }
        if (await deleteLeaseIf(tx, lease)) {
          logger.info({ companyId, labelId: m.labelId, holderRootIssueId: lease.holderRootIssueId }, "pod mutex: releasing stale lease at gate");
          await logLease(tx, companyId, "pod_mutex.released", m.labelId, {
            holderRootIssueId: lease.holderRootIssueId, reason: "stale_at_gate", manual: false,
          });
        }
      }
      const [inserted] = await tx
        .insert(podMutexLeases)
        .values({ companyId, labelId: m.labelId, holderRootIssueId: m.rootIssueId, acquiredByIssueId: issueId })
        .onConflictDoNothing()
        .returning({ id: podMutexLeases.id, acquiredAt: podMutexLeases.acquiredAt });
      if (inserted) {
        logger.info({ companyId, labelId: m.labelId, holderRootIssueId: m.rootIssueId, issueId }, "pod mutex acquired");
        await logLease(tx, companyId, "pod_mutex.acquired", m.labelId, {
          holderRootIssueId: m.rootIssueId, acquiredByIssueId: issueId,
        }, opts.actor);
        return { kind: "acquired" as const, id: inserted.id, acquiredAt: inserted.acquiredAt };
      }
      const current = await getLease(companyId, m.labelId, tx);
      if (current && current.holderRootIssueId !== m.rootIssueId) return { kind: "blocked" as const, holder: current.holderRootIssueId };
      return { kind: "held" as const };
    });
    let gate: PodMutexGate;
    if (outcome.kind === "blocked") gate = await blockedGate(companyId, m, outcome.holder);
    else if (outcome.kind === "acquired") gate = { ok: true, mutex: m, acquiredLeaseId: outcome.id, acquiredAt: outcome.acquiredAt };
    else gate = { ok: true, mutex: m };
    // cached results never carry acquiredLeaseId: only the acquiring call owns it
    pass?.gates.set(cacheKey, gate.ok ? { ok: true, mutex: m } : gate);
    return gate;
  }

  /** Undo an acquire whose claim failed (only the lease this call inserted). */
  async function releaseAcquired(companyId: string, gate: PodMutexGate, reason: string) {
    if (!gate.ok || !gate.acquiredLeaseId || !gate.mutex) return false;
    const mutex = gate.mutex;
    return x.transaction(async (txRaw) => {
      const tx = txRaw as unknown as Db;
      await lockLabel(tx, companyId, mutex.labelId);
      const dropped = await deleteLeaseIf(tx, {
        id: gate.acquiredLeaseId!, holderRootIssueId: mutex.rootIssueId,
      });
      if (dropped) {
        await logLease(tx, companyId, "pod_mutex.released", mutex.labelId, {
          holderRootIssueId: mutex.rootIssueId, reason, manual: false,
        });
      }
      return dropped;
    });
  }

  /** Non-acquiring check: is the mutex held by ANOTHER tree that still holds? */
  async function heldByOther(companyId: string, mutex: EffectiveMutex): Promise<PodMutexBlocked | null> {
    const lease = await getLease(companyId, mutex.labelId);
    if (!lease || lease.holderRootIssueId === mutex.rootIssueId) return null;
    if (!(await treeHolds(companyId, lease.holderRootIssueId, mutex.holdingStatuses, mutex.labelId))) return null;
    return blockedGate(companyId, mutex, lease.holderRootIssueId);
  }

  /**
   * Issue write check (create / update, before the write). Returns the
   * blocking gate when the resulting issue lands in a holding status of a
   * mutex held by another tree and the write CAUSES it: `status` = the status
   * moves into a holding status (or a new issue is created in one); `tree` =
   * the issue already holds a holding status and a label/parent change moves
   * it under a held mutex.
   */
  async function checkIssueWrite(
    companyId: string,
    input: {
      issueId: string | null;
      before: { status: string; parentId: string | null; labelIds: string[] } | null;
      after: { status: string; parentId: string | null; labelIds: string[] };
    },
  ): Promise<{ gate: PodMutexBlocked; cause: "status" | "tree" } | null> {
    const configs = await listConfigs(companyId);
    if (configs.size === 0) return null;
    const mutexAfter = await resolveHypothetical(
      companyId, { selfIssueId: input.issueId, selfLabelIds: input.after.labelIds, parentId: input.after.parentId }, configs,
    );
    if (!mutexAfter || !mutexAfter.holdingStatuses.includes(input.after.status)) return null;
    const before = input.before;
    let cause: "status" | "tree" | null = null;
    if (!before || !mutexAfter.holdingStatuses.includes(before.status)) cause = "status";
    else {
      const mutexBefore = input.issueId ? await resolveEffectiveMutex(companyId, input.issueId, configs) : null;
      if (mutexBefore?.labelId !== mutexAfter.labelId || mutexBefore?.rootIssueId !== mutexAfter.rootIssueId) cause = "tree";
    }
    if (!cause) return null;
    const gate = await heldByOther(companyId, mutexAfter);
    return gate ? { gate, cause } : null;
  }

  /** Waiting run: persist why on contextSnapshot.podMutex (written only on change). */
  async function recordRunWait(runId: string, gate: PodMutexBlocked) {
    const wait: PodMutexRunWait = {
      labelId: gate.mutex.labelId,
      label: gate.labelName,
      holderRootIssueId: gate.holderRootIssueId,
      holderIdentifier: gate.holderIdentifier,
      since: new Date().toISOString(),
    };
    await x.execute(sql`
      UPDATE heartbeat_runs
      SET context_snapshot = (CASE WHEN jsonb_typeof(context_snapshot) = 'object' THEN context_snapshot ELSE '{}'::jsonb END)
        || jsonb_build_object('podMutex', ${JSON.stringify(wait)}::jsonb)
      WHERE id = ${runId} AND status = 'queued'
        AND (context_snapshot -> 'podMutex' ->> 'holderRootIssueId') IS DISTINCT FROM ${gate.holderRootIssueId}
    `);
  }

  async function clearRunWait(runId: string) {
    await x.execute(sql`
      UPDATE heartbeat_runs SET context_snapshot = context_snapshot - 'podMutex'
      WHERE id = ${runId} AND jsonb_typeof(context_snapshot) = 'object' AND jsonb_exists(context_snapshot, 'podMutex')
    `);
  }

  /** Issues whose effective mutex is the label and that want it (queued run or assigned todo). */
  async function listWaiters(
    companyId: string,
    labelId: string,
    configs?: Map<string, PodMutexConfigRow>,
  ): Promise<WaiterCandidate[]> {
    const rows = resultRows<{
      issueId: string; identifier: string | null; title: string; priority: string; status: string;
      assigneeAgentId: string | null; queuedAgentId: string | null; createdAt: string | Date;
    }>(
      await x.execute(sql`
        WITH RECURSIVE tree(issue_id, depth, visited) AS (
          SELECT il.issue_id, 0, ARRAY[il.issue_id]
          FROM issue_labels il
          JOIN issues r ON r.id = il.issue_id
          WHERE il.company_id = ${companyId} AND il.label_id = ${labelId}
            AND r.hidden_at IS NULL AND r.status <> 'cancelled'
          UNION ALL
          SELECT c.id, tree.depth + 1, tree.visited || c.id
          FROM tree
          JOIN issues c ON c.parent_id = tree.issue_id
          WHERE c.company_id = ${companyId}
            AND c.hidden_at IS NULL
            AND tree.depth < ${POD_MUTEX_MAX_DEPTH}
            AND NOT c.id = ANY(tree.visited)
        ),
        queued AS (
          SELECT DISTINCT ON (q.issue_key) q.issue_key, q.agent_id
          FROM (
            SELECT COALESCE(r.issue_id::text, r.native_issue_id::text, NULLIF(r.context_snapshot ->> 'issueId', '')) AS issue_key,
              r.agent_id, r.created_at
            FROM heartbeat_runs r
            WHERE r.company_id = ${companyId} AND r.status = 'queued'
          ) q
          WHERE q.issue_key IS NOT NULL
          ORDER BY q.issue_key, q.created_at ASC
        ),
        candidates AS (
          SELECT DISTINCT i.id, i.identifier, i.title, i.priority, i.status, i.assignee_agent_id, i.created_at,
            queued.agent_id AS queued_agent_id
          FROM tree
          JOIN issues i ON i.id = tree.issue_id
          LEFT JOIN queued ON queued.issue_key = i.id::text
        )
        SELECT id::text AS "issueId", identifier, title, priority, status,
          assignee_agent_id::text AS "assigneeAgentId",
          queued_agent_id::text AS "queuedAgentId", created_at AS "createdAt"
        FROM candidates
        WHERE queued_agent_id IS NOT NULL OR (status = 'todo' AND assignee_agent_id IS NOT NULL)
      `),
    );
    if (rows.length === 0) return [];
    const cfg = configs ?? (await listConfigs(companyId));
    const resolved = await resolveMany(companyId, rows.map((r) => r.issueId), cfg);
    const out: WaiterCandidate[] = [];
    for (const r of rows) {
      const m = resolved.get(r.issueId);
      if (!m || m.labelId !== labelId) continue;
      out.push({ ...r, rootIssueId: m.rootIssueId, createdAt: new Date(r.createdAt) });
    }
    return out;
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
   * Sweep: drop leases whose holder no longer holds (statuses, root label,
   * disabled mutex) and wake the next waiter of every free mutex label.
   * Waiters with a queued run are re-dispatched (cheap, idempotent; one
   * resume per company); a todo issue without a run is only woken right after
   * a release.
   */
  async function sweep(deps: PodMutexWakeDeps = {}, scope?: { companyId: string }) {
    const configRows = await x
      .select()
      .from(podMutexLabels)
      .where(scope ? eq(podMutexLabels.companyId, scope.companyId) : undefined);
    if (configRows.length === 0) return { released: 0 };
    const leaseRows = await x
      .select()
      .from(podMutexLeases)
      .where(scope ? eq(podMutexLeases.companyId, scope.companyId) : undefined);
    const leaseByKey = new Map(leaseRows.map((l) => [`${l.companyId}:${l.labelId}`, l]));
    const configsByCompany = new Map<string, Map<string, PodMutexConfigRow>>();
    for (const c of configRows) {
      if (!c.enabled) continue;
      const m = configsByCompany.get(c.companyId) ?? new Map<string, PodMutexConfigRow>();
      m.set(c.labelId, c);
      configsByCompany.set(c.companyId, m);
    }
    let released = 0;
    const resumeCompanies = new Set<string>();
    for (const config of configRows) {
      try {
        const lease = leaseByKey.get(`${config.companyId}:${config.labelId}`) ?? null;
        let justReleased = false;
        if (lease) {
          const dropped = await x.transaction(async (txRaw) => {
            const tx = txRaw as unknown as Db;
            await lockLabel(tx, config.companyId, config.labelId);
            const holds = config.enabled &&
              (await treeHolds(config.companyId, lease.holderRootIssueId, config.holdingStatuses, config.labelId, tx));
            if (holds) return false;
            const ok = await deleteLeaseIf(tx, lease);
            if (ok) {
              await logLease(tx, config.companyId, "pod_mutex.released", config.labelId, {
                holderRootIssueId: lease.holderRootIssueId,
                reason: config.enabled ? "holder_tree_idle" : "mutex_disabled",
                manual: false,
              });
            }
            return ok;
          });
          if (!dropped) continue;
          justReleased = true;
          released += 1;
          logger.info(
            { companyId: config.companyId, labelId: config.labelId, holderRootIssueId: lease.holderRootIssueId },
            "pod mutex released (holder tree no longer holds)",
          );
        }
        if (!config.enabled) continue;
        const waiters = (await listWaiters(config.companyId, config.labelId, configsByCompany.get(config.companyId)))
          .filter((w) => justReleased || w.queuedAgentId);
        const next = pickNextWaiter(waiters);
        if (!next) continue;
        if (next.queuedAgentId) resumeCompanies.add(config.companyId);
        else await wakeWaiter(config.companyId, next, deps);
      } catch (err) {
        logger.error({ err, companyId: config.companyId, labelId: config.labelId }, "pod mutex sweep failed");
      }
    }
    for (const companyId of resumeCompanies) {
      try {
        await deps.resumeQueuedRuns?.({ companyId });
      } catch (err) {
        logger.error({ err, companyId }, "pod mutex sweep: resume queued runs failed");
      }
    }
    return { released };
  }

  /** Running run + last run activity per holder root (one query for all roots). */
  async function holderRunInfo(companyId: string, rootIssueIds: string[]) {
    const out = new Map<string, { hasRunningRun: boolean; lastRunActivityAt: Date | null }>();
    if (rootIssueIds.length === 0) return out;
    const rows = resultRows<{ rootId: string; running: boolean; last: string | Date | null }>(
      await x.execute(sql`
        WITH RECURSIVE tree(root_id, issue_id, depth, visited) AS (
          SELECT i.id, i.id, 0, ARRAY[i.id]
          FROM issues i
          WHERE i.company_id = ${companyId} AND i.id::text IN (${textList(rootIssueIds)})
          UNION ALL
          SELECT tree.root_id, c.id, tree.depth + 1, tree.visited || c.id
          FROM tree
          JOIN issues c ON c.parent_id = tree.issue_id
          WHERE c.company_id = ${companyId}
            AND tree.depth < ${POD_MUTEX_MAX_DEPTH}
            AND NOT c.id = ANY(tree.visited)
        )
        SELECT tree.root_id::text AS "rootId",
          COALESCE(bool_or(r.status = 'running'), false) AS "running",
          max(CASE WHEN r.status = 'running' THEN now() ELSE COALESCE(r.finished_at, r.started_at) END) AS "last"
        FROM tree
        JOIN heartbeat_runs r ON r.company_id = ${companyId}
          AND r.status <> 'queued'
          AND (r.issue_id = tree.issue_id OR r.native_issue_id = tree.issue_id
            OR (r.context_snapshot ->> 'issueId') = tree.issue_id::text)
        GROUP BY tree.root_id
      `),
    );
    for (const r of rows) {
      out.set(r.rootId, { hasRunningRun: r.running === true, lastRunActivityAt: r.last ? new Date(r.last) : null });
    }
    return out;
  }

  // ---- issue presentation ----

  /** Pod mutex state for issues (list rows, detail). Empty when inert. */
  async function issueStates(companyId: string, issueIds: string[]): Promise<Map<string, IssuePodMutexState>> {
    const out = new Map<string, IssuePodMutexState>();
    if (issueIds.length === 0) return out;
    const configs = await listConfigs(companyId);
    if (configs.size === 0) return out;
    const resolved = await resolveMany(companyId, issueIds, configs);
    const usedLabels = [...new Set([...resolved.values()].flatMap((m) => (m ? [m.labelId] : [])))];
    if (usedLabels.length === 0) return out;
    const [leaseRows, labelRows] = await Promise.all([
      x.select().from(podMutexLeases).where(and(eq(podMutexLeases.companyId, companyId), inArray(podMutexLeases.labelId, usedLabels))),
      x.select({ id: labels.id, name: labels.name, color: labels.color }).from(labels).where(inArray(labels.id, usedLabels)),
    ]);
    const leaseByLabel = new Map(leaseRows.map((l) => [l.labelId, l]));
    const labelById = new Map(labelRows.map((l) => [l.id, l]));
    const holderIds = [...new Set(leaseRows.map((l) => l.holderRootIssueId))];
    const holderRows = holderIds.length
      ? await x.select({ id: issues.id, identifier: issues.identifier }).from(issues).where(inArray(issues.id, holderIds))
      : [];
    const holderIdentifier = new Map(holderRows.map((h) => [h.id, h.identifier]));
    const stillHolds = new Map<string, boolean>();
    for (const lease of leaseRows) {
      stillHolds.set(
        lease.labelId,
        await treeHolds(companyId, lease.holderRootIssueId, configs.get(lease.labelId)!.holdingStatuses, lease.labelId),
      );
    }
    for (const [issueId, m] of resolved) {
      if (!m) continue;
      const lease = leaseByLabel.get(m.labelId);
      const active = lease && stillHolds.get(m.labelId) ? lease : null;
      const role: IssuePodMutexState["role"] = !active ? "free" : active.holderRootIssueId === m.rootIssueId ? "holder" : "waiting";
      out.set(issueId, {
        labelId: m.labelId,
        labelName: labelById.get(m.labelId)?.name ?? m.labelId,
        labelColor: labelById.get(m.labelId)?.color ?? null,
        rootIssueId: m.rootIssueId,
        role,
        holderRootIssueId: active?.holderRootIssueId ?? null,
        holderIdentifier: active ? holderIdentifier.get(active.holderRootIssueId) ?? null : null,
      });
    }
    return out;
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
    if (rows.length === 0) return [];
    const leaseRows = await x.select().from(podMutexLeases).where(eq(podMutexLeases.companyId, companyId));
    const leaseByLabel = new Map(leaseRows.map((l) => [l.labelId, l]));
    const holderIds = [...new Set(leaseRows.map((l) => l.holderRootIssueId))];
    const holderIssues = holderIds.length
      ? await x
        .select({ id: issues.id, identifier: issues.identifier, title: issues.title, status: issues.status })
        .from(issues)
        .where(inArray(issues.id, holderIds))
      : [];
    const holderById = new Map(holderIssues.map((i) => [i.id, i]));
    const runInfo = await holderRunInfo(companyId, holderIds);
    const configs = new Map(rows.filter((r) => r.enabled).map((r) => [r.labelId, r]));
    const result = [];
    for (const row of rows) {
      const lease = leaseByLabel.get(row.labelId) ?? null;
      let holder = null;
      if (lease) {
        const issue = holderById.get(lease.holderRootIssueId);
        const info = runInfo.get(lease.holderRootIssueId);
        holder = {
          rootIssueId: lease.holderRootIssueId,
          identifier: issue?.identifier ?? null,
          title: issue?.title ?? null,
          acquiredAt: lease.acquiredAt,
          acquiredByIssueId: lease.acquiredByIssueId,
          stillHolding: row.enabled && (await treeHolds(companyId, lease.holderRootIssueId, row.holdingStatuses, row.labelId)),
          hasRunningRun: info?.hasRunningRun ?? false,
          lastRunActivityAt: info?.lastRunActivityAt ?? null,
        };
      }
      const waiters = row.enabled
        ? sortWaiters((await listWaiters(companyId, row.labelId, configs)).filter((w) => w.rootIssueId !== lease?.holderRootIssueId))
        : [];
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
    const leases = await x
      .delete(podMutexLeases)
      .where(and(eq(podMutexLeases.companyId, companyId), eq(podMutexLeases.labelId, labelId)))
      .returning();
    const deleted = await x
      .delete(podMutexLabels)
      .where(and(eq(podMutexLabels.companyId, companyId), eq(podMutexLabels.labelId, labelId)))
      .returning({ id: podMutexLabels.id });
    for (const lease of leases) {
      await logLease(x, companyId, "pod_mutex.released", labelId, {
        holderRootIssueId: lease.holderRootIssueId, reason: "mutex_deleted", manual: true,
      });
    }
    return deleted.length > 0;
  }

  /** Drop the lease (admin). Returns the dropped lease or null if nothing was held. */
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
    createPass,
    resolveEffectiveMutex,
    resolveMany,
    resolveHypothetical,
    treeHolds,
    tryAcquire,
    releaseAcquired,
    heldByOther,
    checkIssueWrite,
    recordRunWait,
    clearRunWait,
    listWaiters,
    sweep,
    holderRunInfo,
    issueStates,
    list,
    upsert,
    remove,
    forceRelease,
  };
}

export function podMutexConflictMessage(gate: PodMutexBlocked) {
  return `Resource "${gate.labelName}" is held by ${gate.holderIdentifier ?? gate.holderRootIssueId}; waiting until that tree has no issues in its holding statuses (pod mutex)`;
}
