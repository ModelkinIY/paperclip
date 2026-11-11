import { and, eq, sql } from "drizzle-orm";
import { agents, connectionGrants, heartbeatRuns, toolConnections, type Db } from "@paperclipai/db";
import {
  aiConnectionMetadataSchema, aiRuntimeConnectionBindingSchema, supportsAiConnectionUsage,
  type AccountLimitView,
} from "@paperclipai/shared";
import { paceModelIds } from "./pace/index.js";
import { policyFor } from "./policies/index.js";
import type { AccountCapacityStore } from "./store.js";
import type { LimitSettingsStore } from "./store.js";

const iso = (d: Date | null) => (d ? d.toISOString() : null);

/** Everything the Subscription limit page shows, for every AI account of the company. */
export async function listAccountLimitViews(
  db: Db, store: AccountCapacityStore, settingsStore: LimitSettingsStore, companyId: string, now = new Date(),
): Promise<AccountLimitView[]> {
  const accounts = await db
    .select({ grant: connectionGrants, connection: toolConnections })
    .from(connectionGrants)
    .innerJoin(toolConnections, eq(toolConnections.id, connectionGrants.connectionId))
    .where(and(eq(connectionGrants.companyId, companyId), eq(toolConnections.connectionPurpose, "ai"), eq(connectionGrants.status, "active")));
  const agentRows = await db.select({ id: agents.id, name: agents.name, runtimeConfig: agents.runtimeConfig })
    .from(agents).where(eq(agents.companyId, companyId));
  const queued = await db.select({
    id: heartbeatRuns.id, agentId: heartbeatRuns.agentId, issueId: heartbeatRuns.issueId, ctx: heartbeatRuns.contextSnapshot,
  }).from(heartbeatRuns).where(and(
    eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.status, "queued"),
    sql`jsonb_typeof(${heartbeatRuns.contextSnapshot}) = 'object' AND jsonb_exists(${heartbeatRuns.contextSnapshot}, 'aiLimitWait')`,
  ));

  const bindings = agentRows.flatMap((a) => {
    const b = aiRuntimeConnectionBindingSchema.safeParse((a.runtimeConfig as Record<string, unknown> | null)?.aiConnection);
    return b.success ? [{ agent: a, binding: b.data }] : [];
  });

  const views: AccountLimitView[] = [];
  for (const { grant, connection } of accounts) {
    const meta = aiConnectionMetadataSchema.safeParse((connection.config as Record<string, unknown>).ai);
    if (!meta.success) continue;
    const { provider, method } = meta.data;
    const settings = settingsStore.get(grant.id);
    const cap = store.getCapacity(grant.id, provider, method, now);
    const waits = queued.filter((r) => (r.ctx as { aiLimitWait?: { grantId?: string } }).aiLimitWait?.grantId === grant.id);
    views.push({
      grantId: grant.id, connectionId: connection.id, provider, method,
      accountName: connection.name, accountLabel: grant.providerTenant?.name ?? null,
      limitsSupported: policyFor(provider, method).id !== "no-limit" && supportsAiConnectionUsage(provider, method),
      settings: {
        enabled: settings.enabled, paceModel: settings.paceModel, weekly: settings.weekly,
        fiveHour: settings.fiveHour, maxStaleMinutes: settings.maxStaleMinutes,
      },
      capacity: {
        available: cap.available, headroom: cap.headroom, reason: cap.reason, observedAt: iso(cap.observedAt),
        source: cap.source, heldUntil: iso(cap.heldUntil),
        windows: cap.windows.map((w) => ({
          id: w.id, label: w.label, scope: w.scope, role: w.role, usedPercent: w.usedPercent,
          expectedPercent: w.expectedPercent, elapsedPercent: w.elapsedPercent, delta: w.delta,
          resetsAt: iso(w.resetsAt), durationSeconds: w.durationSeconds, hold: w.hold,
        })),
      },
      history: store.historyOf(grant.id).map((h) => ({ at: h.at.toISOString(), windows: h.windows })),
      agents: bindings.flatMap(({ agent, binding }): AccountLimitView["agents"] => {
        if ((binding.mode === "shared" || binding.mode === "delegated") && binding.grantId === grant.id) {
          return [{ id: agent.id, name: agent.name, via: "grant" as const }];
        }
        if (binding.mode === "responsible_user" && binding.provider === provider) {
          return [{ id: agent.id, name: agent.name, via: "responsible_user" as const }];
        }
        return [];
      }),
      queuedRuns: waits.map((r) => ({
        id: r.id, agentId: r.agentId, issueId: r.issueId,
        since: (r.ctx as { aiLimitWait?: { since?: string } }).aiLimitWait?.since ?? null,
      })),
      paceModels: paceModelIds(),
    });
  }
  return views;
}
