import { and, eq, sql } from "drizzle-orm";
import { agents, aiProviderDefaults, companies, connectionGrants, toolConnections, type Db } from "@paperclipai/db";
import {
  aiConnectionMetadataSchema,
  aiRuntimeConnectionBindingSchema,
  readAiLimitRunWait,
  type AiAuthMethod,
  type AiLimitRunWait,
  type AiProvider,
} from "@paperclipai/shared";
import { logger } from "../../middleware/logger.js";
import type { AccountCapacityStore } from "./store.js";

type RunRow = {
  id: string; companyId: string; agentId: string; startedAt: Date | null;
  responsibleUserId: string | null; contextSnapshot: unknown;
};

export interface AccountCandidate { grantId: string; provider: AiProvider; method: AiAuthMethod; accountName: string | null }

/**
 * Accounts a queued run may end up on, read-only and without opening any
 * credential. Today that is one account (explicit binding or the responsible
 * user's default); a pool of accounts returns several (router mode: next step).
 * Anything unknown yields no candidates, which never holds a run.
 */
export async function resolveRunAccountCandidates(db: Db, run: RunRow): Promise<AccountCandidate[]> {
  const [agent] = await db.select({ runtimeConfig: agents.runtimeConfig }).from(agents).where(eq(agents.id, run.agentId)).limit(1);
  return resolveBindingAccountCandidates(db, run.companyId, run.responsibleUserId, (agent?.runtimeConfig as Record<string, unknown> | null)?.aiConnection);
}

/** Same as resolveRunAccountCandidates for an explicit runtimeConfig.aiConnection (inference slots). */
export async function resolveBindingAccountCandidates(db: Db, companyId: string, responsibleUserId: string | null, aiConnection: unknown): Promise<AccountCandidate[]> {
  const binding = aiRuntimeConnectionBindingSchema.safeParse(aiConnection);
  if (!binding.success) return [];
  const b = binding.data;
  let grantId: string | null = null;
  if (b.mode === "shared" || b.mode === "delegated") grantId = b.grantId;
  else if (b.mode === "responsible_user") {
    // The run's own user, else the company default the start would fall back to.
    let userId = responsibleUserId;
    if (!userId) {
      const [company] = await db.select({ userId: companies.defaultResponsibleUserId }).from(companies).where(eq(companies.id, companyId)).limit(1);
      userId = company?.userId ?? null;
    }
    if (!userId) return [];
    const [row] = await db.select({ grantId: aiProviderDefaults.grantId }).from(aiProviderDefaults).where(and(
      eq(aiProviderDefaults.companyId, companyId), eq(aiProviderDefaults.userId, userId),
      eq(aiProviderDefaults.provider, b.provider))).limit(1);
    grantId = row?.grantId ?? null;
  }
  if (!grantId) return [];
  const [acct] = await db.select({ name: toolConnections.name, config: toolConnections.config }).from(connectionGrants)
    .innerJoin(toolConnections, eq(toolConnections.id, connectionGrants.connectionId))
    .where(and(eq(connectionGrants.id, grantId), eq(connectionGrants.companyId, companyId))).limit(1);
  const meta = aiConnectionMetadataSchema.safeParse((acct?.config as Record<string, unknown> | undefined)?.ai);
  if (!acct || !meta.success) return [];
  return [{ grantId, provider: meta.data.provider, method: meta.data.method, accountName: acct.name ?? null }];
}

/**
 * Gate for starting a queued run: false keeps it queued and records why on
 * contextSnapshot.aiLimitWait. A run that already started is never held.
 */
export function createAccountLimitGate(db: Db, store: AccountCapacityStore, now: () => Date = () => new Date()) {
  async function recordWait(runId: string, wait: AiLimitRunWait) {
    await db.execute(sql`
      UPDATE heartbeat_runs
      SET context_snapshot = (CASE WHEN jsonb_typeof(context_snapshot) = 'object' THEN context_snapshot ELSE '{}'::jsonb END)
        || jsonb_build_object('aiLimitWait', ${JSON.stringify(wait)}::jsonb)
      WHERE id = ${runId} AND status = 'queued'
        AND ((context_snapshot -> 'aiLimitWait' ->> 'reason') IS DISTINCT FROM ${wait.reason}
          OR (context_snapshot -> 'aiLimitWait' ->> 'heldUntil') IS DISTINCT FROM ${wait.heldUntil})
    `);
  }
  async function clearWait(runId: string) {
    await db.execute(sql`
      UPDATE heartbeat_runs SET context_snapshot = context_snapshot - 'aiLimitWait'
      WHERE id = ${runId} AND jsonb_typeof(context_snapshot) = 'object' AND jsonb_exists(context_snapshot, 'aiLimitWait')
    `);
  }
  return {
    /** true: the run may start. */
    async pass(run: RunRow): Promise<boolean> {
      if (run.startedAt) return true;
      // Nothing is tracked anywhere: skip every query on the hot claim path.
      if (!store.anyEnabled()) {
        if (readAiLimitRunWait(run.contextSnapshot)) await clearWait(run.id).catch(() => undefined);
        return true;
      }
      try {
        const candidates = await resolveRunAccountCandidates(db, run);
        const capacities = candidates.map((c) => ({ c, cap: store.getCapacity(c.grantId, c.provider, c.method, now()) }));
        const blocked = capacities.length > 0 && capacities.every((x) => !x.cap.available);
        if (!blocked) {
          if (readAiLimitRunWait(run.contextSnapshot)) await clearWait(run.id);
          return true;
        }
        const first = capacities[0]!;
        const prior = readAiLimitRunWait(run.contextSnapshot);
        await recordWait(run.id, {
          grantId: first.c.grantId, provider: first.c.provider, accountName: first.c.accountName,
          reason: first.cap.reason, heldUntil: first.cap.heldUntil?.toISOString() ?? null,
          since: prior?.since || now().toISOString(),
        });
        logger.debug({ runId: run.id, grantId: first.c.grantId, reason: first.cap.reason }, "account limit: run stays queued");
        return false;
      } catch (err) {
        // The gate must never stop work because of its own failure.
        logger.warn({ err, runId: run.id }, "account limit gate failed; letting the run start");
        return true;
      }
    },
  };
}
