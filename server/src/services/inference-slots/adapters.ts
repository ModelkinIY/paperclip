/**
 * inferdyne fork: company adapters (CRUD), agent adapter lists, the mirror of
 * an agent's first adapter onto its own fields, and the one-time backfill that
 * turns every agent's own adapter settings into company adapters.
 */
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { agentInferenceSlots, agents, companyAdapters, toolConnections, type Db } from "@paperclipai/db";
import { logger } from "../../middleware/logger.js";
import { adapterLevelConfig, overlayAgentWithSlot, type ResolvedSlot } from "./service.js";

type AdapterRow = typeof companyAdapters.$inferSelect;
type AgentRow = typeof agents.$inferSelect;

export interface AdapterInput {
  name: string;
  adapterType: string;
  adapterConfig: Record<string, unknown>;
  aiConnection: Record<string, unknown> | null;
  defaultEnvironmentId: string | null;
}

export class AdapterInUseError extends Error {
  constructor(readonly agentNames: string[]) { super(`Adapter is used by: ${agentNames.join(", ")}`); }
}

const ADAPTER_LABELS: Record<string, string> = {
  claude_local: "Claude Code", codex_local: "Codex", opencode_local: "OpenCode", gemini_local: "Gemini",
  grok_local: "Grok", pi_local: "Pi", hermes_local: "Hermes", paperclip_runner: "Paperclip Runner", process: "Process",
};

function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") {
    return `{${Object.keys(v as object).sort().map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(",")}}`;
  }
  return JSON.stringify(v ?? null);
}
function adapterKey(a: Pick<AdapterInput, "adapterType" | "adapterConfig" | "aiConnection" | "defaultEnvironmentId">) {
  return canonical([a.adapterType, a.adapterConfig, a.aiConnection, a.defaultEnvironmentId]);
}

function asSlot(row: AdapterRow): ResolvedSlot {
  return {
    id: row.id, priority: 0, enabled: true, label: row.name, adapterType: row.adapterType,
    adapterConfig: row.adapterConfig ?? {}, aiConnection: row.aiConnection ?? null, defaultEnvironmentId: row.defaultEnvironmentId ?? undefined,
  };
}

export function companyAdapterService(db: Db) {
  async function list(companyId: string) {
    const rows = await db.select().from(companyAdapters).where(eq(companyAdapters.companyId, companyId)).orderBy(asc(companyAdapters.name));
    const usage = await db.select({ adapterId: agentInferenceSlots.adapterId, agentId: agents.id, agentName: agents.name, priority: agentInferenceSlots.priority })
      .from(agentInferenceSlots).innerJoin(agents, eq(agents.id, agentInferenceSlots.agentId))
      .where(and(eq(agentInferenceSlots.companyId, companyId), sql`${agents.status} <> 'terminated'`));
    return rows.map((row) => ({ ...row, agents: usage.filter((u) => u.adapterId === row.id).map((u) => ({ id: u.agentId, name: u.agentName, priority: u.priority })) }));
  }

  async function get(companyId: string, id: string) {
    const [row] = await db.select().from(companyAdapters).where(and(eq(companyAdapters.companyId, companyId), eq(companyAdapters.id, id))).limit(1);
    return row ?? null;
  }

  async function getById(id: string) {
    const [row] = await db.select().from(companyAdapters).where(eq(companyAdapters.id, id)).limit(1);
    return row ?? null;
  }

  async function create(companyId: string, input: AdapterInput) {
    const [row] = await db.insert(companyAdapters).values({ companyId, ...input, adapterConfig: adapterLevelConfig(input.adapterConfig) }).returning();
    return row!;
  }

  /** Saves the adapter and re-mirrors every agent that has it first. */
  async function update(companyId: string, id: string, input: AdapterInput) {
    const [row] = await db.update(companyAdapters).set({ ...input, adapterConfig: adapterLevelConfig(input.adapterConfig), updatedAt: new Date() })
      .where(and(eq(companyAdapters.companyId, companyId), eq(companyAdapters.id, id))).returning();
    if (!row) return null;
    const users = await db.selectDistinct({ agentId: agentInferenceSlots.agentId }).from(agentInferenceSlots).where(eq(agentInferenceSlots.adapterId, id));
    for (const u of users) await mirrorAgent(u.agentId);
    return row;
  }

  async function remove(companyId: string, id: string) {
    const users = await db.select({ name: agents.name, status: agents.status }).from(agentInferenceSlots).innerJoin(agents, eq(agents.id, agentInferenceSlots.agentId))
      .where(eq(agentInferenceSlots.adapterId, id));
    const live = users.filter((u) => u.status !== "terminated");
    if (live.length) throw new AdapterInUseError([...new Set(live.map((u) => u.name))]);
    // Terminated agents do not hold an adapter (FK cascades their rows).
    const [row] = await db.delete(companyAdapters).where(and(eq(companyAdapters.companyId, companyId), eq(companyAdapters.id, id))).returning({ id: companyAdapters.id });
    return !!row;
  }

  /** The agent's ordered adapter list. */
  async function agentList(agentId: string) {
    return db.select({ adapterId: agentInferenceSlots.adapterId, enabled: agentInferenceSlots.enabled, priority: agentInferenceSlots.priority, adapter: companyAdapters })
      .from(agentInferenceSlots).innerJoin(companyAdapters, eq(companyAdapters.id, agentInferenceSlots.adapterId))
      .where(eq(agentInferenceSlots.agentId, agentId)).orderBy(asc(agentInferenceSlots.priority), asc(agentInferenceSlots.createdAt));
  }

  /** Replace the agent's list (order = priority) and mirror its first enabled adapter. */
  async function setAgentList(companyId: string, agentId: string, items: Array<{ adapterId: string; enabled: boolean }>) {
    await db.transaction(async (tx) => {
      await tx.delete(agentInferenceSlots).where(eq(agentInferenceSlots.agentId, agentId));
      for (const [i, item] of items.entries()) {
        await tx.insert(agentInferenceSlots).values({ companyId, agentId, priority: i, enabled: item.enabled, adapterId: item.adapterId });
      }
    });
    await mirrorAgent(agentId);
  }

  /**
   * The agent's own adapter fields follow its first enabled adapter, so every
   * code path that reads the agent row sees the adapter that runs by default.
   * Agent-level keys (instructions, prompts, env, skills, timeouts) are kept.
   */
  async function mirrorAgent(agentId: string) {
    await db.transaction(async (tx) => {
      // Lock the agent row: a concurrent agent PATCH (env, prompts) is not overwritten with a stale read.
      const [agent] = await tx.select().from(agents).where(eq(agents.id, agentId)).for("update").limit(1);
      if (!agent) return;
      const [first] = await tx.select({ adapter: companyAdapters }).from(agentInferenceSlots)
        .innerJoin(companyAdapters, eq(companyAdapters.id, agentInferenceSlots.adapterId))
        .where(and(eq(agentInferenceSlots.agentId, agentId), eq(agentInferenceSlots.enabled, true)))
        .orderBy(asc(agentInferenceSlots.priority), asc(agentInferenceSlots.createdAt)).limit(1);
      if (!first) return;
      const view = overlayAgentWithSlot(agent, asSlot(first.adapter));
      const own = (agent.adapterConfig ?? {}) as Record<string, unknown>;
      // Keep the agent's env as stored (provider keys are only dropped per run).
      const adapterConfig = { ...view.adapterConfig, ...(own.env !== undefined ? { env: own.env } : {}) };
      await tx.update(agents).set({
        adapterType: view.adapterType, adapterConfig, runtimeConfig: view.runtimeConfig as AgentRow["runtimeConfig"],
        defaultEnvironmentId: view.defaultEnvironmentId, updatedAt: new Date(),
      }).where(eq(agents.id, agentId));
    });
  }

  /**
   * Agents without an adapter list get one: their own settings (and legacy
   * inline fallback slots) become company adapters, identical ones shared.
   */
  async function ensureAgentAdapters(agent: Pick<AgentRow, "id" | "companyId" | "adapterType" | "adapterConfig" | "runtimeConfig" | "defaultEnvironmentId">) {
    return db.transaction(async (tx) => {
    // One conversion per agent at a time (startup backfill vs. first claim vs. GET).
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${"company-adapters:" + agent.id}))`);
    const rows = await tx.select().from(agentInferenceSlots).where(eq(agentInferenceSlots.agentId, agent.id)).orderBy(asc(agentInferenceSlots.priority));
    if (rows.some((r) => r.adapterId)) return false;
    // Adapter names are company-unique: serialize conversions within a company.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${"company-adapters-names:" + agent.companyId}))`);
    const existing = await tx.select().from(companyAdapters).where(eq(companyAdapters.companyId, agent.companyId));
    const byKey = new Map(existing.map((a) => [adapterKey({ ...a, adapterConfig: a.adapterConfig ?? {}, aiConnection: a.aiConnection ?? null, defaultEnvironmentId: a.defaultEnvironmentId ?? null }), a]));
    const names = new Set(existing.map((a) => a.name));
    const runtimeAi = (agent.runtimeConfig as Record<string, unknown> | null)?.aiConnection;
    const candidates: Array<AdapterInput & { enabled: boolean; label: string | null }> = [{
      name: "", adapterType: agent.adapterType, adapterConfig: adapterLevelConfig((agent.adapterConfig ?? {}) as Record<string, unknown>),
      aiConnection: runtimeAi && typeof runtimeAi === "object" ? runtimeAi as Record<string, unknown> : null,
      defaultEnvironmentId: agent.defaultEnvironmentId ?? null, enabled: true, label: null,
    }];
    for (const r of rows) {
      if (!r.adapterType) continue;
      const cfg = { ...(r.adapterConfig ?? {}) } as Record<string, unknown>;
      delete cfg.env; // legacy slot env: provider keys now come from the connection
      candidates.push({ name: "", adapterType: r.adapterType, adapterConfig: adapterLevelConfig(cfg), aiConnection: r.aiConnection ?? null,
        defaultEnvironmentId: agent.defaultEnvironmentId ?? null, enabled: r.enabled, label: r.label });
    }
    const connIds = candidates.map((c) => c.aiConnection?.connectionId).filter((x): x is string => typeof x === "string");
    const conns = connIds.length ? await tx.select({ id: toolConnections.id, name: toolConnections.name }).from(toolConnections).where(inArray(toolConnections.id, connIds)) : [];
    const items: Array<{ adapterId: string; enabled: boolean }> = [];
    for (const c of candidates) {
      const key = adapterKey(c);
      let adapter = byKey.get(key);
      if (!adapter) {
        const model = typeof c.adapterConfig.model === "string" && c.adapterConfig.model ? c.adapterConfig.model : "default model";
        const conn = conns.find((x) => x.id === c.aiConnection?.connectionId)?.name ?? (c.aiConnection ? String(c.aiConnection.mode ?? "connection") : "own auth");
        const base = c.label ?? `${ADAPTER_LABELS[c.adapterType] ?? c.adapterType} · ${model} · ${conn}`;
        let name = base;
        for (let i = 2; names.has(name); i++) name = `${base} (${i})`;
        names.add(name);
        [adapter] = await tx.insert(companyAdapters).values({ companyId: agent.companyId, name, adapterType: c.adapterType, adapterConfig: c.adapterConfig, aiConnection: c.aiConnection, defaultEnvironmentId: c.defaultEnvironmentId }).returning();
        byKey.set(key, adapter!);
      }
      if (!items.some((i) => i.adapterId === adapter!.id)) items.push({ adapterId: adapter!.id, enabled: c.enabled });
    }
    await tx.delete(agentInferenceSlots).where(and(eq(agentInferenceSlots.agentId, agent.id), isNull(agentInferenceSlots.adapterId)));
    for (const [i, item] of items.entries()) {
      await tx.insert(agentInferenceSlots).values({ companyId: agent.companyId, agentId: agent.id, priority: i, enabled: item.enabled, adapterId: item.adapterId });
    }
    // Task affinity of legacy slots pointed at inline slot ids / "primary": drop it, the next run picks fresh.
    await tx.execute(sql`DELETE FROM agent_inference_slot_task_state WHERE agent_id = ${agent.id}`);
    return true;
    });
  }

  /** Startup backfill for all agents of all companies; failures are logged per agent. */
  async function backfillAll() {
    const all = await db.select().from(agents).where(sql`${agents.status} <> 'terminated'`);
    let converted = 0;
    for (const agent of all) {
      if ((agent.lifecycleHolds ?? []).includes("setup")) continue; // drafts are converted once set up (first claim)
      try { if (await ensureAgentAdapters(agent)) converted++; } catch (err) { logger.warn({ err, agentId: agent.id }, "adapters backfill failed for agent"); }
    }
    if (converted) logger.info({ converted }, "adapters: agents converted to company adapters");
    return converted;
  }

  return { list, get, getById, create, update, remove, agentList, setAgentList, mirrorAgent, ensureAgentAdapters, backfillAll };
}
