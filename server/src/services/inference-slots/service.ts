/**
 * inferdyne fork: agent inference slots.
 *
 * Adapters are company rows (company_adapters: harness, connection, adapter
 * settings, environment override). An agent lists adapters by priority in
 * agent_inference_slots (adapter_id) and picks its model and thinking effort
 * for each one there (adapter_config of the slot row). For compatibility the
 * agent's own adapterType/adapterConfig/runtimeConfig.aiConnection mirror its
 * first enabled adapter (adapters.ts), and every run is claimed on one adapter.
 */
import { and, asc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import {
  agentInferenceSlots, agentInferenceSlotTaskState, agentTaskSessions, agents, companyAdapters, heartbeatRuns, inferenceExhaustions, type Db,
} from "@paperclipai/db";
import { SLOT_ADAPTER_KEYS, slotEffortKey, readAiLimitRunWait, readInferenceSlotSelection, type AiLimitRunWait, type InferenceSlotSelection, type InferenceSlotStatus } from "@paperclipai/shared";
import { logger } from "../../middleware/logger.js";
import { resolveBindingAccountCandidates } from "../account-capacity/gate.js";
import { accountCapacity } from "../account-capacity/runtime.js";
import type { AccountCapacityStore, LimitSettingsStore } from "../account-capacity/store.js";
import { selectInferenceSlot, waitAtSoftLimit, type SoftLimitPolicy, type TaskAffinity } from "./select.js";

export const PRIMARY_SLOT_ID = "primary";

type AgentRow = typeof agents.$inferSelect;
type AdapterRow = typeof companyAdapters.$inferSelect;

/**
 * A slot as the run uses it. With company adapters the slot id is the adapter
 * id (stable across reordering). "primary" is an agent without an adapter list
 * (not yet backfilled): its own fields.
 */
export interface ResolvedSlot {
  id: string;
  priority: number;
  enabled: boolean;
  label: string | null;
  adapterType: string;
  adapterConfig: Record<string, unknown>;
  aiConnection: Record<string, unknown> | null;
  /** Environment override of the adapter; undefined keeps the agent's. */
  defaultEnvironmentId?: string | null;
}

export function primarySlotOf(agent: Pick<AgentRow, "adapterType" | "adapterConfig" | "runtimeConfig">): ResolvedSlot {
  const ai = (agent.runtimeConfig as Record<string, unknown> | null)?.aiConnection;
  return {
    id: PRIMARY_SLOT_ID, priority: 0, enabled: true, label: null,
    adapterType: agent.adapterType, adapterConfig: (agent.adapterConfig ?? {}) as Record<string, unknown>,
    aiConnection: ai && typeof ai === "object" ? ai as Record<string, unknown> : null,
  };
}

/**
 * Keys of adapterConfig that belong to the agent, not to the adapter:
 * instructions, prompts, skills sync, timeouts, working directory, max turns
 * and the agent's environment variables. Model and effort are the agent's
 * choice per adapter (SLOT_ADAPTER_KEYS, on agent_inference_slots). Everything
 * else (engine, permissions, command, args...) is the adapter's.
 */
export const AGENT_LEVEL_ADAPTER_KEYS = [
  "instructionsBundleMode", "instructionsRootPath", "instructionsEntryFile", "instructionsFilePath", "agentsMdPath",
  "promptTemplate", "bootstrapPromptTemplate", "paperclipSkillSync", "timeoutSec", "graceSec", "env", "cwd", "maxTurnsPerRun",
] as const;
/** Env keys that pick provider/endpoint/credentials. A managed connection supplies them, so the agent's are dropped then. */
const PROVIDER_ENV_RE = /^(ANTHROPIC_|OPENAI_|CODEX_|OPENROUTER_|XAI_|GEMINI_|GOOGLE_API|CLAUDE_CODE_USE_)/;

function recordOf(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {};
}

export function adapterLevelConfig(config: Record<string, unknown>) {
  const out = { ...config };
  for (const key of AGENT_LEVEL_ADAPTER_KEYS) delete out[key];
  return out;
}

/** What a company adapter stores: no agent-level keys, no per-agent model/effort. */
export function sharedAdapterConfig(config: Record<string, unknown>) {
  const out = adapterLevelConfig(config);
  for (const key of SLOT_ADAPTER_KEYS) delete out[key];
  return out;
}

/** The agent's model/effort for one adapter, as adapterConfig keys (empty values dropped). */
export function slotOverrides(slotConfig: Record<string, unknown> | null | undefined) {
  const out: Record<string, unknown> = {};
  for (const key of SLOT_ADAPTER_KEYS) {
    const v = slotConfig?.[key];
    if (v !== undefined && v !== null && v !== "") out[key] = v;
  }
  return out;
}

/** Stored slot config from the list editor's model/effort. */
export function slotConfigFor(adapterType: string, adapterConfig: Record<string, unknown>, model: string | null | undefined, effort: string | null | undefined) {
  const out: Record<string, unknown> = {};
  if (model) out.model = model;
  if (effort) out[slotEffortKey(adapterType, adapterConfig)] = effort;
  return out;
}

/** A company adapter as one agent runs it: shared settings plus the agent's model/effort. */
export function adapterConfigForAgent(adapterConfig: Record<string, unknown> | null | undefined, slotConfig: Record<string, unknown> | null | undefined) {
  return { ...sharedAdapterConfig(adapterConfig ?? {}), ...slotOverrides(slotConfig) };
}

/**
 * adapterConfig of a run on an adapter: the adapter's keys plus the agent's
 * own keys. With a managed AI connection the agent's provider env is dropped,
 * so e.g. a local ANTHROPIC_BASE_URL never reaches a cloud subscription.
 */
export function slotRunAdapterConfig(agentConfig: Record<string, unknown>, adapterConfig: Record<string, unknown>, managedConnection: boolean) {
  const out: Record<string, unknown> = adapterLevelConfig(adapterConfig);
  for (const key of AGENT_LEVEL_ADAPTER_KEYS) if (agentConfig[key] !== undefined) out[key] = agentConfig[key];
  // One instructions file, whichever key this adapter reads it from.
  const file = agentConfig.instructionsFilePath ?? agentConfig.agentsMdPath;
  if (file !== undefined) { out.instructionsFilePath = file; out.agentsMdPath = file; }
  if (managedConnection) {
    const env = Object.fromEntries(Object.entries(recordOf(agentConfig.env)).filter(([k]) => !PROVIDER_ENV_RE.test(k)));
    if (Object.keys(env).length) out.env = env; else delete out.env;
  }
  return out;
}

/** With a managed AI connection the agent's own provider env (e.g. a local ANTHROPIC_BASE_URL) is not passed on. */
export function withManagedProviderEnvDropped<T extends Pick<AgentRow, "adapterConfig" | "runtimeConfig">>(agent: T): T {
  if (!(agent.runtimeConfig as Record<string, unknown> | null)?.aiConnection) return agent;
  const cfg = recordOf(agent.adapterConfig);
  const env = recordOf(cfg.env);
  if (!Object.keys(env).some((k) => PROVIDER_ENV_RE.test(k))) return agent;
  const kept = Object.fromEntries(Object.entries(env).filter(([k]) => !PROVIDER_ENV_RE.test(k)));
  return { ...agent, adapterConfig: { ...cfg, env: kept } };
}

/** The agent as a run on `slot` sees it: adapter fields come from the adapter, everything else stays. */
export function overlayAgentWithSlot<T extends Pick<AgentRow, "adapterType" | "adapterConfig" | "runtimeConfig" | "defaultEnvironmentId">>(agent: T, slot: ResolvedSlot): T {
  if (slot.id === PRIMARY_SLOT_ID) return agent;
  const runtimeConfig = { ...((agent.runtimeConfig ?? {}) as Record<string, unknown>) };
  if (slot.aiConnection) runtimeConfig.aiConnection = slot.aiConnection;
  else delete runtimeConfig.aiConnection;
  const adapterConfig = slotRunAdapterConfig(recordOf(agent.adapterConfig), slot.adapterConfig, !!slot.aiConnection);
  return {
    ...agent, adapterType: slot.adapterType, adapterConfig, runtimeConfig,
    ...(slot.defaultEnvironmentId !== undefined ? { defaultEnvironmentId: slot.defaultEnvironmentId } : {}),
  };
}

/** Exhaustion key: the account when the slot has one, else the slot itself. */
export function exhaustionKey(agentId: string, slotId: string, grantId: string | null) {
  if (grantId) return `grant:${grantId}`;
  // A company adapter is shared by agents: its limit is too. Only the legacy primary is per agent.
  return slotId === PRIMARY_SLOT_ID ? `slot:${agentId}:${slotId}` : `adapter:${slotId}`;
}

function slotModel(slot: ResolvedSlot): string | null {
  const m = slot.adapterConfig.model;
  return typeof m === "string" && m ? m : null;
}

function adapterSlot(row: AdapterRow, priority: number, enabled: boolean, slotConfig: Record<string, unknown> | null | undefined): ResolvedSlot {
  return {
    id: row.id, priority, enabled, label: row.name, adapterType: row.adapterType,
    adapterConfig: adapterConfigForAgent(row.adapterConfig, slotConfig), aiConnection: row.aiConnection ?? null, defaultEnvironmentId: row.defaultEnvironmentId ?? undefined,
  };
}

export function inferenceSlotService(db: Db) {
  /** The agent's adapters by priority (new-style rows only). */
  async function listAgentAdapters(agentId: string) {
    return db.select({ slot: agentInferenceSlots, adapter: companyAdapters }).from(agentInferenceSlots)
      .innerJoin(companyAdapters, eq(companyAdapters.id, agentInferenceSlots.adapterId))
      .where(eq(agentInferenceSlots.agentId, agentId))
      .orderBy(asc(agentInferenceSlots.priority), asc(agentInferenceSlots.createdAt));
  }

  /** True when the agent runs from its adapter list (the gate picks a slot). */
  async function usesAdapters(agentId: string): Promise<boolean> {
    const [row] = await db.select({ id: agentInferenceSlots.id }).from(agentInferenceSlots)
      .where(and(eq(agentInferenceSlots.agentId, agentId), isNotNull(agentInferenceSlots.adapterId))).limit(1);
    return !!row;
  }

  async function allSlots(agent: AgentRow): Promise<ResolvedSlot[]> {
    const rows = await listAgentAdapters(agent.id);
    if (!rows.length) return [primarySlotOf(agent)];
    return rows.map((r, i) => adapterSlot(r.adapter, i, r.slot.enabled, r.slot.adapterConfig));
  }

  async function resolveSlot(agent: AgentRow, slotId: string): Promise<ResolvedSlot | null> {
    if (slotId === PRIMARY_SLOT_ID) return primarySlotOf(agent);
    return (await allSlots(agent)).find((s) => s.id === slotId) ?? null;
  }

  async function getAffinity(agentId: string, taskKey: string, primaryAdapterType?: string): Promise<TaskAffinity | null> {
    const [row] = await db.select().from(agentInferenceSlotTaskState).where(and(
      eq(agentInferenceSlotTaskState.agentId, agentId), eq(agentInferenceSlotTaskState.taskKey, taskKey))).limit(1);
    if (row) {
      let finished = row.lastRunFinishedAt;
      if (!finished && row.lastRunId) {
        const [run] = await db.select({ finishedAt: heartbeatRuns.finishedAt }).from(heartbeatRuns).where(eq(heartbeatRuns.id, row.lastRunId)).limit(1);
        finished = run?.finishedAt ?? null;
      }
      return { slotId: row.slotId, lastRunFinishedAt: finished };
    }
    const [session] = await db.select({ id: agentTaskSessions.id, updatedAt: agentTaskSessions.updatedAt }).from(agentTaskSessions).where(and(
      eq(agentTaskSessions.agentId, agentId), eq(agentTaskSessions.taskKey, taskKey),
      ...(primaryAdapterType ? [eq(agentTaskSessions.adapterType, primaryAdapterType)] : []))).limit(1);
    return session ? { slotId: PRIMARY_SLOT_ID, lastRunFinishedAt: session.updatedAt } : null;
  }

  async function setAffinity(companyId: string, agentId: string, taskKey: string, slotId: string, runId: string) {
    const now = new Date();
    await db.insert(agentInferenceSlotTaskState).values({ companyId, agentId, taskKey, slotId, lastRunId: runId, lastRunFinishedAt: null, updatedAt: now })
      .onConflictDoUpdate({
        target: [agentInferenceSlotTaskState.agentId, agentInferenceSlotTaskState.taskKey],
        set: { slotId, lastRunId: runId, lastRunFinishedAt: null, updatedAt: now },
      });
  }

  /** A task moves to another slot: its provider session belongs to the old one. */
  async function resetTaskSessions(agentId: string, taskKey: string) {
    await db.delete(agentTaskSessions).where(and(eq(agentTaskSessions.agentId, agentId), eq(agentTaskSessions.taskKey, taskKey)));
  }

  async function activeExhaustions(companyId: string, keys: string[], now: Date) {
    if (!keys.length) return new Map<string, Date>();
    const rows = await db.select({ key: inferenceExhaustions.key, until: inferenceExhaustions.until }).from(inferenceExhaustions)
      .where(and(eq(inferenceExhaustions.companyId, companyId), inArray(inferenceExhaustions.key, keys)));
    return new Map(rows.filter((r) => r.until > now).map((r) => [r.key, r.until]));
  }

  async function recordExhaustion(input: { companyId: string; key: string; until: Date; runId: string | null; message: string | null }) {
    const now = new Date();
    await db.insert(inferenceExhaustions).values({ ...input, observedAt: now })
      .onConflictDoUpdate({
        target: [inferenceExhaustions.companyId, inferenceExhaustions.key],
        set: { until: input.until, observedAt: now, runId: input.runId, message: input.message },
      });
  }

  /** Live status of each slot: hard limit (provider said so, or a window is spent), soft limit (pace), or available. */
  async function slotStatuses(input: {
    companyId: string; agentId: string; responsibleUserId: string | null; slots: ResolvedSlot[];
    store: AccountCapacityStore; now: Date;
  }) {
    const accounts = new Map<string, { grantId: string | null; provider: string | null; method: string | null; accountName: string | null }>();
    for (const slot of input.slots) {
      const [c] = await resolveBindingAccountCandidates(db, input.companyId, input.responsibleUserId, slot.aiConnection);
      accounts.set(slot.id, c ? { grantId: c.grantId, provider: c.provider, method: c.method, accountName: c.accountName } : { grantId: null, provider: null, method: null, accountName: slot.label });
    }
    const keyOf = (slot: ResolvedSlot) => exhaustionKey(input.agentId, slot.id, accounts.get(slot.id)!.grantId);
    const exhausted = await activeExhaustions(input.companyId, input.slots.map(keyOf), input.now);
    const statuses = new Map<string, InferenceSlotStatus>();
    for (const slot of input.slots) {
      const acct = accounts.get(slot.id)!;
      const hardUntil = exhausted.get(keyOf(slot));
      if (!slot.enabled) {
        statuses.set(slot.id, { slotId: slot.id, state: "disabled", reason: "disabled", until: null, accountName: acct.accountName });
      } else if (hardUntil) {
        statuses.set(slot.id, { slotId: slot.id, state: "hard_limit", reason: "provider_quota", until: hardUntil.toISOString(), accountName: acct.accountName });
      } else if (acct.grantId && acct.provider && acct.method && input.store.anyEnabled()) {
        const cap = input.store.getCapacity(acct.grantId, acct.provider as never, acct.method as never, input.now);
        const state = cap.available ? "available" : cap.reason === "window_exhausted" ? "hard_limit" : "soft_limit";
        statuses.set(slot.id, { slotId: slot.id, state, reason: cap.reason, until: cap.heldUntil?.toISOString() ?? null, accountName: acct.accountName });
      } else {
        statuses.set(slot.id, { slotId: slot.id, state: "available", reason: "untracked", until: null, accountName: acct.accountName });
      }
    }
    return { statuses, accounts };
  }

  return {
    listAgentAdapters, usesAdapters, allSlots, resolveSlot, getAffinity, setAffinity, resetTaskSessions,
    recordExhaustion, slotStatuses,
  };
}

type RunRow = {
  id: string; companyId: string; agentId: string; startedAt: Date | null;
  responsibleUserId: string | null; contextSnapshot: unknown;
};

/**
 * Claim-time gate for agents with fallback slots. Picks the slot, records it on
 * contextSnapshot.inferenceSlot, and holds the run (contextSnapshot.aiLimitWait)
 * when no slot may start. Agents without fallbacks are left to `legacy`.
 */
export function createInferenceSlotGate(db: Db, deps: {
  store: AccountCapacityStore;
  settings: LimitSettingsStore;
  legacy: (run: RunRow) => Promise<boolean>;
  taskKeyOf: (run: RunRow) => string | null;
  /** Converts an agent without an adapter list (adapters.ts ensureAgentAdapters). */
  ensureAdapters?: (agent: AgentRow) => Promise<unknown>;
  policy?: SoftLimitPolicy;
  now?: () => Date;
}) {
  const svc = inferenceSlotService(db);
  const now = deps.now ?? (() => new Date());

  async function writeContext(runId: string, patch: Record<string, unknown>, remove: string[]) {
    await db.execute(sql`
      UPDATE heartbeat_runs
      SET context_snapshot = ((CASE WHEN jsonb_typeof(context_snapshot) = 'object' THEN context_snapshot ELSE '{}'::jsonb END)
        - ${sql.raw(remove.length ? `ARRAY[${remove.map((k) => `'${k}'`).join(",")}]::text[]` : "ARRAY[]::text[]")})
        || ${JSON.stringify(patch)}::jsonb
      WHERE id = ${runId} AND status = 'queued'
    `);
  }

  /** A run going the agent's own way must not carry a slot choice from an earlier attempt (retries copy the context). */
  async function legacyOutcome(run: RunRow, outcome: "legacy" | null): Promise<"legacy" | null> {
    if (outcome === "legacy" && readInferenceSlotSelection(run.contextSnapshot)) {
      await writeContext(run.id, {}, ["inferenceSlot"]).catch((err) => logger.warn({ err, runId: run.id }, "inference slots: failed to clear a stale slot choice"));
    }
    return outcome;
  }

  return {
    /** Selected slot when the run may start, null when it stays queued. Agents without fallbacks: "legacy". */
    async pass(run: RunRow, agent: AgentRow): Promise<ResolvedSlot | "legacy" | null> {
      if (run.startedAt) {
        const prior = readInferenceSlotSelection(run.contextSnapshot);
        if (!prior) return "legacy";
        // A choice the agent no longer has (e.g. a pre-adapters slot id) is dropped, not executed.
        return (await svc.resolveSlot(agent, prior.slotId)) ?? legacyOutcome(run, "legacy");
      }
      let slots: ResolvedSlot[];
      try {
        // Agents created after the startup backfill get their adapter list on first claim.
        if (!(await svc.usesAdapters(agent.id)) && deps.ensureAdapters && !(agent.lifecycleHolds ?? []).includes("setup")) await deps.ensureAdapters(agent).catch((err) => logger.warn({ err, agentId: agent.id }, "adapters: on-claim conversion failed"));
        if (!(await svc.usesAdapters(agent.id))) return legacyOutcome(run, (await deps.legacy(run)) ? "legacy" : null);
        slots = await svc.allSlots(agent);
      } catch (err) {
        logger.warn({ err, runId: run.id }, "inference slots: lookup failed; using the agent's own adapter");
        return legacyOutcome(run, "legacy");
      }
      const t = now();
      const taskKey = deps.taskKeyOf(run);
      try {
        const affinity = taskKey ? await svc.getAffinity(agent.id, taskKey, agent.adapterType) : null;
        const { statuses, accounts } = await svc.slotStatuses({ companyId: run.companyId, agentId: agent.id, responsibleUserId: run.responsibleUserId, slots, store: deps.store, now: t });
        const choice = selectInferenceSlot({
          slots, statuses, affinity, policy: deps.policy ?? waitAtSoftLimit, now: t,
          cacheKeepaliveMode: (slotId) => {
            const grantId = accounts.get(slotId)?.grantId;
            return grantId ? deps.settings.get(grantId).cacheKeepaliveMode : "off";
          },
        });
        if (!choice) {
          // Every adapter of the agent is off: hold instead of running the disabled one the row still mirrors.
          logger.warn({ runId: run.id, agentId: agent.id }, "inference slots: agent has no enabled adapter; run stays queued");
          return null;
        }
        if (choice.kind === "wait") {
          const st = statuses.get(choice.slotId)!;
          const acct = accounts.get(choice.slotId);
          const prior = readAiLimitRunWait(run.contextSnapshot);
          const wait: AiLimitRunWait = {
            grantId: acct?.grantId ?? exhaustionKey(agent.id, choice.slotId, null), provider: acct?.provider ?? "",
            accountName: st.accountName, reason: choice.reason, heldUntil: choice.until, since: prior?.since || t.toISOString(),
          };
          if (prior?.reason !== wait.reason || prior?.heldUntil !== wait.heldUntil) await writeContext(run.id, { aiLimitWait: wait }, []);
          logger.debug({ runId: run.id, slotId: choice.slotId, reason: choice.reason }, "inference slots: run stays queued");
          return null;
        }
        const slot = slots.find((s) => s.id === choice.slotId)!;
        const selection: InferenceSlotSelection = {
          slotId: slot.id, priority: slot.priority, adapterType: slot.adapterType, label: slot.label,
          model: slotModel(slot), reason: choice.reason, previousSlotId: choice.previousSlotId,
        };
        // Affinity and the session reset of a switch happen when the run really
        // starts (applySlotSelectionAtStart), not here: the claim may still fail.
        await writeContext(run.id, { inferenceSlot: selection }, ["aiLimitWait"]);
        return slot;
      } catch (err) {
        // The gate must never stop work because of its own failure.
        logger.warn({ err, runId: run.id }, "inference slot gate failed; using the agent's own adapter");
        return legacyOutcome(run, (await deps.legacy(run).catch(() => true)) ? "legacy" : null);
      }
    },
  };
}

/** Provider gave no reset time: assume the shortest window (5h limits) is back within an hour, then re-check. */
const UNKNOWN_RESET_MS = 60 * 60 * 1000;

export async function recordInferenceHardLimit(db: Db, input: {
  run: { id: string; companyId: string; agentId: string; responsibleUserId: string | null; contextSnapshot: unknown };
  /** The agent as the run saw it (slot overlay applied). */
  agent: { runtimeConfig: unknown };
  retryNotBefore: string | null;
  message: string | null;
}) {
  const slotId = readInferenceSlotSelection(input.run.contextSnapshot)?.slotId ?? PRIMARY_SLOT_ID;
  const ai = (input.agent.runtimeConfig as Record<string, unknown> | null)?.aiConnection;
  const [account] = await resolveBindingAccountCandidates(db, input.run.companyId, input.run.responsibleUserId, ai);
  const parsed = input.retryNotBefore ? new Date(input.retryNotBefore) : null;
  const until = parsed && !Number.isNaN(parsed.getTime()) && parsed.getTime() > Date.now() ? parsed : new Date(Date.now() + UNKNOWN_RESET_MS);
  await inferenceSlotService(db).recordExhaustion({
    companyId: input.run.companyId, key: exhaustionKey(input.run.agentId, slotId, account?.grantId ?? null),
    until, runId: input.run.id, message: input.message?.slice(0, 500) ?? null,
  });
}

/** True when another enabled slot of the agent is not exhausted right now (retry need not wait for the reset). */
export async function hasOpenFallbackSlot(db: Db, failedRunId: string) {
  const [run] = await db.select({ companyId: heartbeatRuns.companyId, agentId: heartbeatRuns.agentId, responsibleUserId: heartbeatRuns.responsibleUserId, contextSnapshot: heartbeatRuns.contextSnapshot })
    .from(heartbeatRuns).where(eq(heartbeatRuns.id, failedRunId)).limit(1);
  if (!run) return false;
  const input = { ...run, failedRunContext: run.contextSnapshot };
  const svc = inferenceSlotService(db);
  if (!(await svc.usesAdapters(input.agentId))) return false;
  const [agent] = await db.select().from(agents).where(eq(agents.id, input.agentId)).limit(1);
  if (!agent) return false;
  const failedSlot = readInferenceSlotSelection(input.failedRunContext)?.slotId ?? PRIMARY_SLOT_ID;
  const slots = await svc.allSlots(agent);
  const { statuses } = await svc.slotStatuses({ companyId: input.companyId, agentId: input.agentId, responsibleUserId: input.responsibleUserId, slots, store: accountCapacity, now: new Date() });
  return slots.some((s) => s.id !== failedSlot && statuses.get(s.id)?.state === "available");
}

/**
 * Run start (claimed, about to execute): the slot the run really uses. Trusts
 * the recorded choice only when it matches the adapter the claim dispatched;
 * records task affinity and drops the old slot's sessions on a switch.
 */
export async function applySlotSelectionAtStart<T extends AgentRow>(db: Db, input: {
  run: { id: string; companyId: string; contextSnapshot: unknown };
  agent: T;
  claimedAdapterType: string | null;
  taskKey: string | null;
}): Promise<T> {
  const selection = readInferenceSlotSelection(input.run.contextSnapshot);
  if (!selection) return input.agent;
  if (input.claimedAdapterType && selection.adapterType !== input.claimedAdapterType) return input.agent;
  const svc = inferenceSlotService(db);
  let agent = input.agent;
  if (selection.slotId !== PRIMARY_SLOT_ID) {
    const slots = await svc.allSlots(input.agent);
    const slot = slots.find((x) => x.id === selection.slotId);
    if (!slot) throw new Error("The adapter this run was claimed on was removed from the agent; start a new turn.");
    // The agent's own fields mirror its first enabled adapter and stay authoritative for it
    // (lifecycle/setup flows edit them); only a fallback adapter is overlaid.
    const first = slots.find((x) => x.enabled);
    agent = first?.id === slot.id ? withManagedProviderEnvDropped(input.agent) : overlayAgentWithSlot(input.agent, slot);
  }
  if (input.taskKey) {
    try {
      const prior = await svc.getAffinity(input.agent.id, input.taskKey, input.agent.adapterType);
      if (prior && prior.slotId !== selection.slotId) await svc.resetTaskSessions(input.agent.id, input.taskKey);
      await svc.setAffinity(input.run.companyId, input.agent.id, input.taskKey, selection.slotId, input.run.id);
    } catch (err) {
      logger.warn({ err, runId: input.run.id }, "inference slots: failed to record task affinity");
    }
  }
  return agent;
}
