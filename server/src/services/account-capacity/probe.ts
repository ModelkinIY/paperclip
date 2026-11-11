import { and, eq, sql } from "drizzle-orm";
import { companyMemberships, type Db } from "@paperclipai/db";
import type { AiAuthMethod, AiProvider, AiConnectionUsageLimit } from "@paperclipai/shared";
import { logger } from "../../middleware/logger.js";
import { observationFromUsageLimits } from "./normalize.js";
import { policyFor } from "./policies/index.js";
import type { AccountCapacityStore } from "./store.js";

export const PROBE_FRESH_MS = 30 * 60_000;
export const PROBE_MIN_INTERVAL_MS = 60_000;

interface GrantSummary {
  id: string; grantId?: string; provider: AiProvider; method: AiAuthMethod; status?: string;
}
export interface AccountProbeUsage {
  list(companyId: string, userId: string): Promise<GrantSummary[]>;
  probeUsage(companyId: string, userId: string, connectionId: string, grantId?: string): Promise<{
    status?: string; limits?: AiConnectionUsageLimit[];
  }>;
}
export interface Membership { companyId: string; userId: string }

export async function listActiveUserMemberships(db: Db): Promise<Membership[]> {
  const rows = await db.select({ companyId: companyMemberships.companyId, userId: companyMemberships.principalId })
    .from(companyMemberships)
    .where(and(eq(companyMemberships.principalType, "user"), eq(companyMemberships.status, "active")));
  return rows;
}

export interface TrackedGrant { companyId: string; grantId: string; connectionId: string; provider: AiProvider; method: AiAuthMethod; userId: string }

/** Every account that has limits to watch, with a user who may open its credential. */
export async function discoverTrackedGrants(memberships: Membership[], usage: AccountProbeUsage): Promise<TrackedGrant[]> {
  const found = new Map<string, TrackedGrant>();
  for (const { companyId, userId } of memberships) {
    const summaries = await usage.list(companyId, userId).catch(() => [] as GrantSummary[]);
    for (const s of summaries) {
      if (!s.grantId || s.status !== "connected" || found.has(s.grantId)) continue;
      if (policyFor(s.provider, s.method).id === "no-limit") continue;
      found.set(s.grantId, { companyId, grantId: s.grantId, connectionId: s.id, provider: s.provider, method: s.method, userId });
    }
  }
  return [...found.values()];
}

const lastProbeAt = new Map<string, number>();
const failures = new Map<string, number>();
const lastAvailable = new Map<string, boolean>();

export function resetAccountProbeStateForTests() {
  lastProbeAt.clear();
  failures.clear();
  lastAvailable.clear();
}

export type ProbeOutcome = "skipped" | "ok" | "failed";

/**
 * Probe one account now. Skipped while the previous attempt is recent; a
 * failing account backs off (1, 2, 4 … 30 minutes) so a broken endpoint is not
 * hit every tick. A forced attempt (the Refresh button) ignores freshness and
 * backoff, and never delays the background probe when it fails.
 */
export async function probeGrant(
  store: AccountCapacityStore, usage: AccountProbeUsage, grant: TrackedGrant, now: Date, force = false,
): Promise<ProbeOutcome> {
  const last = lastProbeAt.get(grant.grantId) ?? 0;
  const backoff = Math.min(PROBE_FRESH_MS, PROBE_MIN_INTERVAL_MS * 2 ** Math.max(0, (failures.get(grant.grantId) ?? 0) - 1));
  const wait = force ? PROBE_MIN_INTERVAL_MS : Math.max(PROBE_MIN_INTERVAL_MS, failures.has(grant.grantId) ? backoff : 0);
  if (now.getTime() - last < wait) return "skipped";
  if (!force && store.isFresh(grant.grantId, PROBE_FRESH_MS, now)) return "skipped";
  lastProbeAt.set(grant.grantId, now.getTime());
  try {
    const result = await usage.probeUsage(grant.companyId, grant.userId, grant.connectionId, grant.grantId);
    if (result.limits && result.limits.length > 0) {
      store.record(grant.grantId, observationFromUsageLimits(result.limits, now));
      failures.delete(grant.grantId);
      return "ok";
    }
    logger.warn({ grantId: grant.grantId, status: result.status }, "account limits: usage probe returned no windows");
  } catch (err) {
    logger.warn({ err, grantId: grant.grantId }, "account limits: usage probe failed");
  }
  if (force) lastProbeAt.set(grant.grantId, last);
  else failures.set(grant.grantId, (failures.get(grant.grantId) ?? 0) + 1);
  return "failed";
}

/**
 * Periodic work: probe accounts without a fresh observation, re-evaluate every
 * tracked account, and resume the queue when a run is waiting on an account
 * that is available again (or no longer tracked at all, which never holds).
 */
export async function tickAccountLimits(store: AccountCapacityStore, deps: {
  memberships: () => Promise<Membership[]>;
  usage: AccountProbeUsage;
  resumeQueuedRuns: () => Promise<unknown>;
  /** Accounts that queued runs are currently waiting for. */
  waitingGrantIds?: () => Promise<Set<string>>;
  now?: () => Date;
}) {
  const now = deps.now?.() ?? new Date();
  const grants = await discoverTrackedGrants(await deps.memberships(), deps.usage);
  const open = new Map<string, boolean>();
  let released = false;
  for (const grant of grants) {
    await probeGrant(store, deps.usage, grant, now);
    const capacity = store.getCapacity(grant.grantId, grant.provider, grant.method, now);
    open.set(grant.grantId, capacity.available);
    const before = lastAvailable.get(grant.grantId);
    lastAvailable.set(grant.grantId, capacity.available);
    if (capacity.available && before === false) {
      released = true;
      logger.info({ grantId: grant.grantId, provider: grant.provider, reason: capacity.reason },
        "account limits: account is available again, resuming queued runs");
    } else if (!capacity.available && before !== false) {
      logger.info({ grantId: grant.grantId, provider: grant.provider, reason: capacity.reason,
        heldUntil: capacity.heldUntil?.toISOString() ?? null }, "account limits: holding new runs on this account");
    }
  }
  if (!released && deps.waitingGrantIds) {
    for (const grantId of await deps.waitingGrantIds()) {
      // A waiting run whose account is open, or no longer watched, must not sit in the queue.
      if (open.get(grantId) !== false) { released = true; break; }
    }
  }
  if (released) await deps.resumeQueuedRuns();
  return grants;
}

/** Grants that queued runs wait for, read from the runs themselves (survives restarts). */
export async function listWaitingGrantIds(db: Db): Promise<Set<string>> {
  const rows = await db.execute(sql`
    SELECT DISTINCT context_snapshot -> 'aiLimitWait' ->> 'grantId' AS grant_id
    FROM heartbeat_runs
    WHERE status = 'queued' AND jsonb_typeof(context_snapshot) = 'object' AND jsonb_exists(context_snapshot, 'aiLimitWait')
  `);
  const list = (Array.isArray(rows) ? rows : (rows as { rows?: unknown[] }).rows ?? []) as Array<{ grant_id: string | null }>;
  return new Set(list.map((r) => r.grant_id).filter((v): v is string => !!v));
}
