/**
 * inferdyne fork: company adapters (CRUD), agent adapter lists, the mirror of
 * an agent's first adapter onto its own fields, and the one-time backfill that
 * turns every agent's own adapter settings into company adapters.
 */
import { and, asc, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { agentInferenceSlots, agents, companyAdapters, toolConnections, type Db } from "@paperclipai/db";
import { logger } from "../../middleware/logger.js";
import { adapterConfigForAgent, adapterLevelConfig, overlayAgentWithSlot, sharedAdapterConfig, slotConfigFor, slotOverrides, type ResolvedSlot } from "./service.js";

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

/** Auto-generated adapter names: "<Harness> · <model> · <connection>" (old style, with a model) or "<Harness> · <connection>". */
function autoName(adapterType: string, conn: string) {
  return `${ADAPTER_LABELS[adapterType] ?? adapterType} · ${conn}`;
}

function asSlot(row: AdapterRow, slotConfig: Record<string, unknown> | null | undefined): ResolvedSlot {
  return {
    id: row.id, priority: 0, enabled: true, label: row.name, adapterType: row.adapterType,
    adapterConfig: adapterConfigForAgent(row.adapterConfig, slotConfig), aiConnection: row.aiConnection ?? null, defaultEnvironmentId: row.defaultEnvironmentId ?? undefined,
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
    const [row] = await db.insert(companyAdapters).values({ companyId, ...input, adapterConfig: sharedAdapterConfig(input.adapterConfig) }).returning();
    return row!;
  }

  /** Saves the adapter and re-mirrors every agent that has it first. */
  async function update(companyId: string, id: string, input: AdapterInput) {
    const [row] = await db.update(companyAdapters).set({ ...input, adapterConfig: sharedAdapterConfig(input.adapterConfig), updatedAt: new Date() })
      .where(and(eq(companyAdapters.companyId, companyId), eq(companyAdapters.id, id))).returning();
    if (!row) return null;
    const users = await db.selectDistinct({ agentId: agentInferenceSlots.agentId }).from(agentInferenceSlots).where(eq(agentInferenceSlots.adapterId, id));
    for (const u of users) await mirrorAgent(u.agentId);
    return row;
  }

  async function remove(companyId: string, id: string) {
    return db.transaction(async (tx) => {
    // Lock the adapter: a concurrent agent list save (FOR SHARE on it) waits or wins before we check usage.
    const [locked] = await tx.select({ id: companyAdapters.id }).from(companyAdapters)
      .where(and(eq(companyAdapters.companyId, companyId), eq(companyAdapters.id, id))).for("update").limit(1);
    if (!locked) return false;
    const users = await tx.select({ name: agents.name, status: agents.status }).from(agentInferenceSlots).innerJoin(agents, eq(agents.id, agentInferenceSlots.agentId))
      .where(eq(agentInferenceSlots.adapterId, id));
    const live = users.filter((u) => u.status !== "terminated");
    if (live.length) throw new AdapterInUseError([...new Set(live.map((u) => u.name))]);
    // Terminated agents do not hold an adapter (FK cascades their rows).
    const [row] = await tx.delete(companyAdapters).where(and(eq(companyAdapters.companyId, companyId), eq(companyAdapters.id, id))).returning({ id: companyAdapters.id });
    return !!row;
    });
  }

  /** The agent's ordered adapter list. */
  async function agentList(agentId: string) {
    return db.select({ adapterId: agentInferenceSlots.adapterId, enabled: agentInferenceSlots.enabled, priority: agentInferenceSlots.priority, slotConfig: agentInferenceSlots.adapterConfig, adapter: companyAdapters })
      .from(agentInferenceSlots).innerJoin(companyAdapters, eq(companyAdapters.id, agentInferenceSlots.adapterId))
      .where(eq(agentInferenceSlots.agentId, agentId)).orderBy(asc(agentInferenceSlots.priority), asc(agentInferenceSlots.createdAt));
  }

  /** Replace the agent's list (order = priority) and mirror its first enabled adapter. */
  async function setAgentList(companyId: string, agentId: string, items: Array<{ adapterId: string; enabled: boolean; model?: string | null; effort?: string | null }>) {
    await db.transaction(async (tx) => {
      const ids = items.map((i) => i.adapterId);
      const present = ids.length ? await tx.select().from(companyAdapters)
        .where(and(eq(companyAdapters.companyId, companyId), inArray(companyAdapters.id, ids))).for("share") : [];
      if (present.length !== new Set(ids).size) throw new Error("Adapter no longer exists");
      await tx.delete(agentInferenceSlots).where(eq(agentInferenceSlots.agentId, agentId));
      for (const [i, item] of items.entries()) {
        const adapter = present.find((a) => a.id === item.adapterId)!;
        await tx.insert(agentInferenceSlots).values({ companyId, agentId, priority: i, enabled: item.enabled, adapterId: item.adapterId,
          adapterConfig: slotConfigFor(adapter.adapterType, adapter.adapterConfig ?? {}, item.model, item.effort) });
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
      const [first] = await tx.select({ adapter: companyAdapters, slotConfig: agentInferenceSlots.adapterConfig }).from(agentInferenceSlots)
        .innerJoin(companyAdapters, eq(companyAdapters.id, agentInferenceSlots.adapterId))
        .where(and(eq(agentInferenceSlots.agentId, agentId), eq(agentInferenceSlots.enabled, true)))
        .orderBy(asc(agentInferenceSlots.priority), asc(agentInferenceSlots.createdAt)).limit(1);
      if (!first) return;
      const view = overlayAgentWithSlot(agent, asSlot(first.adapter, first.slotConfig));
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
    const own = adapterLevelConfig((agent.adapterConfig ?? {}) as Record<string, unknown>);
    const candidates: Array<AdapterInput & { enabled: boolean; label: string | null; slotConfig: Record<string, unknown> }> = [{
      name: "", adapterType: agent.adapterType, adapterConfig: sharedAdapterConfig(own), slotConfig: slotOverrides(own),
      aiConnection: runtimeAi && typeof runtimeAi === "object" ? runtimeAi as Record<string, unknown> : null,
      defaultEnvironmentId: null, enabled: true, label: null,
    }];
    for (const r of rows) {
      if (!r.adapterType) continue;
      const cfg = { ...(r.adapterConfig ?? {}) } as Record<string, unknown>;
      delete cfg.env; // legacy slot env: provider keys now come from the connection
      candidates.push({ name: "", adapterType: r.adapterType, adapterConfig: sharedAdapterConfig(cfg), slotConfig: slotOverrides(cfg), aiConnection: r.aiConnection ?? null,
        defaultEnvironmentId: null, enabled: r.enabled, label: r.label });
    }
    const connIds = candidates.map((c) => c.aiConnection?.connectionId).filter((x): x is string => typeof x === "string");
    const conns = connIds.length ? await tx.select({ id: toolConnections.id, name: toolConnections.name }).from(toolConnections).where(inArray(toolConnections.id, connIds)) : [];
    const items: Array<{ adapterId: string; enabled: boolean; slotConfig: Record<string, unknown> }> = [];
    for (const c of candidates) {
      const key = adapterKey(c);
      let adapter = byKey.get(key);
      if (!adapter) {
        const conn = conns.find((x) => x.id === c.aiConnection?.connectionId)?.name ?? (c.aiConnection ? String(c.aiConnection.mode ?? "connection") : "own auth");
        const base = c.label ?? autoName(c.adapterType, conn);
        let name = base;
        for (let i = 2; names.has(name); i++) name = `${base} (${i})`;
        names.add(name);
        [adapter] = await tx.insert(companyAdapters).values({ companyId: agent.companyId, name, adapterType: c.adapterType, adapterConfig: c.adapterConfig, aiConnection: c.aiConnection, defaultEnvironmentId: c.defaultEnvironmentId }).returning();
        byKey.set(key, adapter!);
      }
      if (!items.some((i) => i.adapterId === adapter!.id)) items.push({ adapterId: adapter!.id, enabled: c.enabled, slotConfig: c.slotConfig });
    }
    await tx.delete(agentInferenceSlots).where(and(eq(agentInferenceSlots.agentId, agent.id), isNull(agentInferenceSlots.adapterId)));
    for (const [i, item] of items.entries()) {
      await tx.insert(agentInferenceSlots).values({ companyId: agent.companyId, agentId: agent.id, priority: i, enabled: item.enabled, adapterId: item.adapterId, adapterConfig: item.slotConfig });
    }
    // Task affinity of legacy slots pointed at inline slot ids / "primary": drop it, the next run picks fresh.
    await tx.execute(sql`DELETE FROM agent_inference_slot_task_state WHERE agent_id = ${agent.id}`);
    return true;
    });
  }

  /**
   * Adapters of the first release held model, effort, working directory and
   * max turns, so one subscription became an adapter per model. Moves model
   * and effort onto each agent's list row, drops the agent-level keys (the
   * agent row keeps its own), merges adapters that are now identical and
   * renames auto-named ones to "<Harness> · <connection>". Idempotent.
   */
  async function consolidateCompany(companyId: string) {
    const touched = new Set<string>();
    await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${"company-adapters-names:" + companyId}))`);
      const adapters = await tx.select().from(companyAdapters).where(eq(companyAdapters.companyId, companyId)).orderBy(asc(companyAdapters.createdAt), asc(companyAdapters.id)).for("update");
      if (!adapters.length) return;
      const slots = await tx.select().from(agentInferenceSlots).where(and(eq(agentInferenceSlots.companyId, companyId), isNotNull(agentInferenceSlots.adapterId)));
      const conns = await tx.select({ id: toolConnections.id, name: toolConnections.name }).from(toolConnections).where(eq(toolConnections.companyId, companyId));
      const agentRows = await tx.select({ id: agents.id, adapterType: agents.adapterType, adapterConfig: agents.adapterConfig }).from(agents).where(eq(agents.companyId, companyId));
      // 1. Model/effort move onto the agent's row; the adapter keeps shared settings only.
      for (const a of adapters) {
        const cfg = (a.adapterConfig ?? {}) as Record<string, unknown>;
        const shared = sharedAdapterConfig(cfg);
        if (Object.keys(shared).length === Object.keys(cfg).length) continue;
        const fromAdapter = slotOverrides(cfg);
        for (const s of slots.filter((x) => x.adapterId === a.id)) {
          if (Object.keys(slotOverrides(s.adapterConfig)).length) continue;
          // The agent row is authoritative for its first adapter (it may have been edited directly).
          const owner = agentRows.find((x) => x.id === s.agentId);
          const first = slots.filter((x) => x.agentId === s.agentId && x.enabled).sort((x, y) => x.priority - y.priority)[0];
          const moved = owner && first?.id === s.id && owner.adapterType === a.adapterType ? slotOverrides(owner.adapterConfig as Record<string, unknown>) : fromAdapter;
          await tx.update(agentInferenceSlots).set({ adapterConfig: moved, updatedAt: new Date() }).where(eq(agentInferenceSlots.id, s.id));
          s.adapterConfig = moved;
        }
        await tx.update(companyAdapters).set({ adapterConfig: shared, updatedAt: new Date() }).where(eq(companyAdapters.id, a.id));
        a.adapterConfig = shared;
      }
      // 2. Identical adapters merge into the oldest one.
      const keeperByKey = new Map<string, AdapterRow>();
      const removed = new Set<string>();
      for (const a of adapters) {
        const key = adapterKey({ adapterType: a.adapterType, adapterConfig: a.adapterConfig ?? {}, aiConnection: a.aiConnection ?? null, defaultEnvironmentId: a.defaultEnvironmentId ?? null });
        const keeper = keeperByKey.get(key);
        if (!keeper) { keeperByKey.set(key, a); continue; }
        for (const s of slots.filter((x) => x.adapterId === a.id)) {
          touched.add(s.agentId);
          const clash = slots.find((x) => x.agentId === s.agentId && x.adapterId === keeper.id);
          if (clash) {
            // The agent lists both: keep the higher-priority row (its model), drop the other.
            const [keep, drop] = clash.priority <= s.priority ? [clash, s] : [s, clash];
            await tx.delete(agentInferenceSlots).where(eq(agentInferenceSlots.id, drop.id));
            slots.splice(slots.indexOf(drop), 1);
            if (keep === s) { await tx.update(agentInferenceSlots).set({ adapterId: keeper.id }).where(eq(agentInferenceSlots.id, s.id)); s.adapterId = keeper.id; }
          } else {
            await tx.update(agentInferenceSlots).set({ adapterId: keeper.id }).where(eq(agentInferenceSlots.id, s.id));
            s.adapterId = keeper.id;
          }
        }
        await tx.execute(sql`UPDATE agent_inference_slot_task_state SET slot_id = ${keeper.id} WHERE company_id = ${companyId} AND slot_id = ${a.id}`);
        await tx.delete(companyAdapters).where(eq(companyAdapters.id, a.id));
        removed.add(a.id);
      }
      // 3. Auto names lose the model part.
      const kept = adapters.filter((a) => !removed.has(a.id));
      const names = new Set(kept.map((a) => a.name));
      for (const a of kept) {
        const label = ADAPTER_LABELS[a.adapterType] ?? a.adapterType;
        const m = a.name.match(/^(.+?) · (.+?) · (.+?)(?: \(\d+\))?$/);
        if (!m || m[1] !== label) continue;
        const conn = conns.find((x) => x.id === a.aiConnection?.connectionId)?.name ?? m[3]!;
        const base = autoName(a.adapterType, conn);
        names.delete(a.name);
        let name = base;
        for (let i = 2; names.has(name); i++) name = `${base} (${i})`;
        names.add(name);
        await tx.update(companyAdapters).set({ name, updatedAt: new Date() }).where(eq(companyAdapters.id, a.id));
      }
    });
    for (const agentId of touched) await mirrorAgent(agentId);
    return touched.size;
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
    const companyIds = await db.selectDistinct({ id: companyAdapters.companyId }).from(companyAdapters);
    for (const { id } of companyIds) {
      try { await consolidateCompany(id); } catch (err) { logger.warn({ err, companyId: id }, "adapters: consolidation failed for company"); }
    }
    return converted;
  }

  return { list, get, getById, create, update, remove, agentList, setAgentList, mirrorAgent, ensureAgentAdapters, consolidateCompany, backfillAll };
}
