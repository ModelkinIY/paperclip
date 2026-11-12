/**
 * inferdyne fork: agent inference slots.
 *
 * Storage: the agent's own adapterType/adapterConfig/runtimeConfig.aiConnection
 * is slot "primary" (priority 0, edited by the regular agent form with all its
 * checks). agent_inference_slots holds the fallback slots (priority 1..n).
 * Reordering swaps configs between rows, so nothing has to be kept in sync.
 */
import { and, asc, eq, inArray, notInArray, sql } from "drizzle-orm";
import {
  agentInferenceSlots, agentInferenceSlotTaskState, agentTaskSessions, agents, heartbeatRuns, inferenceExhaustions, type Db,
} from "@paperclipai/db";
import { readAiLimitRunWait, readInferenceSlotSelection, type AgentInferenceSlot, type AiLimitRunWait, type InferenceSlotSelection, type InferenceSlotStatus } from "@paperclipai/shared";
import { logger } from "../../middleware/logger.js";
import { resolveBindingAccountCandidates } from "../account-capacity/gate.js";
import { accountCapacity } from "../account-capacity/runtime.js";
import type { AccountCapacityStore, LimitSettingsStore } from "../account-capacity/store.js";
import { selectInferenceSlot, waitAtSoftLimit, type SoftLimitPolicy, type TaskAffinity } from "./select.js";

export const PRIMARY_SLOT_ID = "primary";

type AgentRow = typeof agents.$inferSelect;
type SlotRow = typeof agentInferenceSlots.$inferSelect;

/** A slot as the run uses it: the primary is the agent's own fields. */
export interface ResolvedSlot {
  id: string;
  priority: number;
  enabled: boolean;
  label: string | null;
  adapterType: string;
  adapterConfig: Record<string, unknown>;
  aiConnection: Record<string, unknown> | null;
}

export function primarySlotOf(agent: Pick<AgentRow, "adapterType" | "adapterConfig" | "runtimeConfig">): ResolvedSlot {
  const ai = (agent.runtimeConfig as Record<string, unknown> | null)?.aiConnection;
  return {
    id: PRIMARY_SLOT_ID, priority: 0, enabled: true, label: null,
    adapterType: agent.adapterType, adapterConfig: (agent.adapterConfig ?? {}) as Record<string, unknown>,
    aiConnection: ai && typeof ai === "object" ? ai as Record<string, unknown> : null,
  };
}

function fromRow(row: SlotRow): ResolvedSlot {
  return {
    id: row.id, priority: row.priority, enabled: row.enabled, label: row.label,
    adapterType: row.adapterType, adapterConfig: row.adapterConfig ?? {}, aiConnection: row.aiConnection ?? null,
  };
}

export function slotRowToApi(row: SlotRow): AgentInferenceSlot {
  return { ...fromRow(row), agentId: row.agentId, createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString() };
}

/**
 * Keys of adapterConfig that belong to the agent, not to the inference adapter:
 * instructions, prompts, working directory, skills sync, timeouts. A slot run
 * always takes them from the agent.
 */
export const AGENT_LEVEL_ADAPTER_KEYS = [
  "instructionsBundleMode", "instructionsRootPath", "instructionsEntryFile", "instructionsFilePath", "agentsMdPath",
  "promptTemplate", "bootstrapPromptTemplate", "cwd", "paperclipSkillSync", "timeoutSec", "graceSec",
] as const;
/** Env keys that pick the provider/endpoint/credentials: only the slot sets them. */
const PROVIDER_ENV_RE = /^(ANTHROPIC_|CLAUDE_|OPENAI_|CODEX_|OPENROUTER_|XAI_|GEMINI_|GOOGLE_API)/;

function recordOf(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {};
}

/** adapterConfig a run on `slot` uses: the slot's, plus the agent-level keys and non-provider env of the agent. */
export function slotRunAdapterConfig(agentConfig: Record<string, unknown>, slotConfig: Record<string, unknown>, sameAdapter = false) {
  // Same adapter: the agent's own settings (permissions, args, turn limits...) stay, the slot overrides.
  const base = sameAdapter ? Object.fromEntries(Object.entries(agentConfig).filter(([k]) => k !== "env" && k !== "model")) : {};
  const out: Record<string, unknown> = { ...base, ...slotConfig };
  for (const key of AGENT_LEVEL_ADAPTER_KEYS) {
    if (agentConfig[key] !== undefined) out[key] = agentConfig[key];
    else delete out[key];
  }
  // One instructions file, whichever key this adapter reads it from.
  const file = agentConfig.instructionsFilePath ?? agentConfig.agentsMdPath;
  if (file !== undefined) { out.instructionsFilePath = file; out.agentsMdPath = file; }
  const agentEnv = recordOf(agentConfig.env);
  const env: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(agentEnv)) if (!PROVIDER_ENV_RE.test(k)) env[k] = v;
  Object.assign(env, recordOf(slotConfig.env));
  if (Object.keys(env).length) out.env = env; else delete out.env;
  return out;
}

/** The agent as a run on `slot` sees it: adapter fields come from the slot, everything else stays. */
export function overlayAgentWithSlot<T extends Pick<AgentRow, "adapterType" | "adapterConfig" | "runtimeConfig">>(agent: T, slot: ResolvedSlot): T {
  if (slot.id === PRIMARY_SLOT_ID) return agent;
  const runtimeConfig = { ...((agent.runtimeConfig ?? {}) as Record<string, unknown>) };
  if (slot.aiConnection) runtimeConfig.aiConnection = slot.aiConnection;
  else delete runtimeConfig.aiConnection;
  const adapterConfig = slotRunAdapterConfig(recordOf(agent.adapterConfig), slot.adapterConfig, slot.adapterType === agent.adapterType);
  return { ...agent, adapterType: slot.adapterType, adapterConfig, runtimeConfig };
}

/** Exhaustion key: the account when the slot has one, else the slot itself. */
export function exhaustionKey(agentId: string, slotId: string, grantId: string | null) {
  return grantId ? `grant:${grantId}` : `slot:${agentId}:${slotId}`;
}

function slotModel(slot: ResolvedSlot): string | null {
  const m = slot.adapterConfig.model;
  return typeof m === "string" && m ? m : null;
}

export function inferenceSlotService(db: Db) {
  async function listFallbacks(agentId: string): Promise<SlotRow[]> {
    return db.select().from(agentInferenceSlots).where(eq(agentInferenceSlots.agentId, agentId))
      .orderBy(asc(agentInferenceSlots.priority), asc(agentInferenceSlots.createdAt));
  }

  async function hasFallbacks(agentId: string): Promise<boolean> {
    const [row] = await db.select({ id: agentInferenceSlots.id }).from(agentInferenceSlots)
      .where(eq(agentInferenceSlots.agentId, agentId)).limit(1);
    return !!row;
  }

  async function resolveSlot(agent: AgentRow, slotId: string): Promise<ResolvedSlot | null> {
    if (slotId === PRIMARY_SLOT_ID) return primarySlotOf(agent);
    const [row] = await db.select().from(agentInferenceSlots)
      .where(and(eq(agentInferenceSlots.id, slotId), eq(agentInferenceSlots.agentId, agent.id))).limit(1);
    return row ? fromRow(row) : null;
  }

  /**
   * Replace the fallback list; array order is the priority (1..n). Inputs are
   * already validated and normalized by the route. Rows with an id are updated
   * in place (keeps task affinity), others are created, missing ones removed.
   */
  async function replaceFallbacks(companyId: string, agentId: string, slots: Array<Omit<ResolvedSlot, "priority" | "id"> & { id?: string }>) {
    return db.transaction(async (tx) => {
      const keepIds = slots.map((s) => s.id).filter((id): id is string => !!id);
      const removed = await tx.delete(agentInferenceSlots).where(and(
        eq(agentInferenceSlots.agentId, agentId),
        ...(keepIds.length ? [notInArray(agentInferenceSlots.id, keepIds)] : []),
      )).returning({ id: agentInferenceSlots.id });
      if (removed.length) {
        await tx.delete(agentInferenceSlotTaskState).where(and(
          eq(agentInferenceSlotTaskState.agentId, agentId), inArray(agentInferenceSlotTaskState.slotId, removed.map((r) => r.id))));
      }
      const now = new Date();
      for (const [i, s] of slots.entries()) {
        const values = {
          priority: i + 1, enabled: s.enabled, label: s.label ?? null, adapterType: s.adapterType,
          adapterConfig: s.adapterConfig, aiConnection: s.aiConnection ?? null, updatedAt: now,
        };
        if (s.id) {
          const [updated] = await tx.update(agentInferenceSlots).set(values)
            .where(and(eq(agentInferenceSlots.id, s.id), eq(agentInferenceSlots.agentId, agentId))).returning({ id: agentInferenceSlots.id });
          if (updated) continue;
        }
        await tx.insert(agentInferenceSlots).values({ companyId, agentId, ...values });
      }
      return tx.select().from(agentInferenceSlots).where(eq(agentInferenceSlots.agentId, agentId))
        .orderBy(asc(agentInferenceSlots.priority));
    });
  }

  /** Task affinity: the slot the task ran on; a task with a session but no row ran on the primary. */
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

  /**
   * After a promote the configs moved between "primary" and `slotId`: move task
   * affinity and slot-keyed hard limits with them, and drop the slot choice of
   * runs that are still queued (they pick again at claim).
   */
  async function followPromotedConfigs(agentId: string, slotId: string) {
    await db.transaction(async (tx) => {
      await tx.execute(sql`
        UPDATE agent_inference_slot_task_state
        SET slot_id = CASE WHEN slot_id = ${PRIMARY_SLOT_ID} THEN ${slotId} ELSE ${PRIMARY_SLOT_ID} END, updated_at = now()
        WHERE agent_id = ${agentId} AND slot_id IN (${PRIMARY_SLOT_ID}, ${slotId})`);
      const a = `slot:${agentId}:${PRIMARY_SLOT_ID}`, b = `slot:${agentId}:${slotId}`, tmp = `slot:${agentId}:swap`;
      await tx.execute(sql`UPDATE inference_exhaustions SET key = ${tmp} WHERE key = ${a}`);
      await tx.execute(sql`UPDATE inference_exhaustions SET key = ${a} WHERE key = ${b}`);
      await tx.execute(sql`UPDATE inference_exhaustions SET key = ${b} WHERE key = ${tmp}`);
      await tx.execute(sql`
        UPDATE heartbeat_runs SET context_snapshot = context_snapshot - 'inferenceSlot'
        WHERE agent_id = ${agentId} AND status = 'queued' AND started_at IS NULL
          AND jsonb_typeof(context_snapshot) = 'object' AND jsonb_exists(context_snapshot, 'inferenceSlot')`);
    });
  }

  async function allSlots(agent: AgentRow): Promise<ResolvedSlot[]> {
    return [primarySlotOf(agent), ...(await listFallbacks(agent.id)).map(fromRow)];
  }

  return {
    listFallbacks, hasFallbacks, resolveSlot, replaceFallbacks, getAffinity, setAffinity, resetTaskSessions,
    recordExhaustion, slotStatuses, allSlots, followPromotedConfigs,
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
        return (await svc.resolveSlot(agent, prior.slotId)) ?? "legacy";
      }
      let slots: ResolvedSlot[];
      try {
        if (!(await svc.hasFallbacks(agent.id))) return legacyOutcome(run, (await deps.legacy(run)) ? "legacy" : null);
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
        if (!choice) return legacyOutcome(run, "legacy");
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
  if (!(await svc.hasFallbacks(input.agentId))) return false;
  const [agent] = await db.select().from(agents).where(eq(agents.id, input.agentId)).limit(1);
  if (!agent) return false;
  const failedSlot = readInferenceSlotSelection(input.failedRunContext)?.slotId ?? PRIMARY_SLOT_ID;
  const slots = await svc.allSlots(agent);
  const { statuses } = await svc.slotStatuses({ companyId: input.companyId, agentId: input.agentId, responsibleUserId: input.responsibleUserId, slots, store: accountCapacity, now: new Date() });
  return slots.some((s) => s.id !== failedSlot && statuses.get(s.id)?.state === "available");
}

/** The primary's adapterConfig as a fallback slot keeps it: without agent-level keys, env reduced to provider keys. */
export function slotConfigFromAgentConfig(agentConfig: Record<string, unknown>) {
  const out: Record<string, unknown> = { ...agentConfig };
  for (const key of AGENT_LEVEL_ADAPTER_KEYS) delete out[key];
  const env: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(recordOf(agentConfig.env))) if (PROVIDER_ENV_RE.test(k)) env[k] = v;
  if (Object.keys(env).length) out.env = env; else delete out.env;
  return out;
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
    const slot = await svc.resolveSlot(input.agent, selection.slotId);
    if (!slot) throw new Error("The inference slot this run was claimed on was removed; start a new turn.");
    agent = overlayAgentWithSlot(input.agent, slot);
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
