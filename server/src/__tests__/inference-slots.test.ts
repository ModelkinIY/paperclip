import { randomUUID } from "node:crypto";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import {
  agentInferenceSlots, agentInferenceSlotTaskState, agentTaskSessions, agents, agentWakeupRequests, companies, companyAdapters, companyMemberships, createDb,
  heartbeatRuns, inferenceExhaustions, toolConnections,
} from "@paperclipai/db";
import { readAiLimitRunWait, readInferenceSlotSelection } from "@paperclipai/shared";
import { aiConnectionService } from "../services/ai-connections.js";
import { DEFAULT_LIMIT_SETTINGS, accountCapacity, limitSettingsStore, type Observation } from "../services/account-capacity/index.js";
import { inferenceSlotService, overlayAgentWithSlot, recordInferenceHardLimit, slotRunAdapterConfig } from "../services/inference-slots/service.js";
import { AdapterInUseError, companyAdapterService } from "../services/inference-slots/adapters.js";
import { heartbeatService } from "../services/heartbeat.ts";
import { runningProcesses } from "../adapters/index.ts";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const executed = vi.hoisted(() => [] as Array<{ adapterType: string; model: unknown }>);
const mockAdapterExecute = vi.hoisted(() => vi.fn());
vi.mock("../adapters/index.ts", async () => {
  const actual = await vi.importActual<typeof import("../adapters/index.ts")>("../adapters/index.ts");
  return {
    ...actual,
    getServerAdapter: vi.fn((adapterType: string) => ({
      supportsLocalAgentJwt: false,
      execute: async (ctx: { config?: Record<string, unknown> }) => {
        executed.push({ adapterType, model: ctx.config?.model });
        return mockAdapterExecute(ctx) ?? { exitCode: 0, signal: null, timedOut: false, errorMessage: null, summary: "slot test run.", provider: "test", model: "m" };
      },
    })),
  };
});

const support = await getEmbeddedPostgresTestSupport();
const describeDb = support.supported ? describe : describe.skip;
const WEEK = 604_800;
const weekly = (used: number, elapsed: number, now = new Date()): Observation => ({
  observedAt: now, source: "usage_probe",
  windows: [{
    id: "seven_day", label: "7-day", scope: null, usedPercent: used,
    resetsAt: new Date(now.getTime() + (1 - elapsed / 100) * WEEK * 1000), durationSeconds: WEEK, limitReached: null,
  }],
});

describeDb("inference slots", () => {
  let db!: ReturnType<typeof createDb>;
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let home: string;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let n = 0;

  beforeAll(async () => {
    home = await realpath(await mkdtemp(path.join(os.tmpdir(), "paperclip-inference-slots-")));
    vi.stubEnv("PAPERCLIP_HOME", home);
    vi.stubEnv("PAPERCLIP_INSTANCE_ID", "inference-slots-fixture");
    database = await startEmbeddedPostgresTestDatabase("paperclip-inference-slots-db-");
    db = createDb(database.connectionString);
    heartbeat = heartbeatService(db);
  }, 120_000);
  afterEach(async () => {
    await heartbeat.drainActiveRunExecutions();
    executed.length = 0;
    mockAdapterExecute.mockReset();
    runningProcesses.clear();
    limitSettingsStore.clear();
    await db.execute(sql`truncate table ${companies} cascade`);
  });
  afterAll(async () => {
    await database?.cleanup();
    vi.unstubAllEnvs();
    if (home) await rm(home, { recursive: true, force: true });
  });

  async function account(companyId: string, userId: string, name: string) {
    const acct = await aiConnectionService(db).save(companyId, userId, {
      provider: "openrouter", method: "api_key", ownership: "personal", name, apiKey: "fixture-key", allAgents: true, agentIds: [],
    }, "fixture-key");
    await db.update(toolConnections).set({ config: sql`jsonb_set(config, '{ai}', '{"provider":"anthropic","method":"subscription"}'::jsonb)` })
      .where(eq(toolConnections.id, acct.connectionId));
    return { ...acct, binding: { provider: "anthropic", method: "subscription", mode: "shared", connectionId: acct.connectionId, grantId: acct.grantId } };
  }

  /**
   * Agent with two company adapters: "cloud" (codex_local on account A, model
   * primary-model) first and "local" (claude_local, no account, model
   * fallback-model) second.
   */
  async function seed() {
    const companyId = randomUUID();
    const userId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Slots Co", issuePrefix: `SL${++n}`, defaultResponsibleUserId: userId });
    await db.insert(companyMemberships).values({ companyId, principalId: userId, principalType: "user", status: "active", membershipRole: "owner" });
    const a = await account(companyId, userId, `A${n}`);
    const [agent] = await db.insert(agents).values({
      companyId, name: "Slotted", role: "engineer", status: "idle", adapterType: "codex_local",
      adapterConfig: { model: "primary-model", instructionsFilePath: "/agent/AGENTS.md", env: { GH_TOKEN: { type: "plain", value: "gh" } } },
      runtimeConfig: { aiConnection: a.binding, heartbeat: { enabled: true, intervalSec: 60, wakeOnDemand: true, maxConcurrentRuns: 3 } },
      permissions: {},
    }).returning();
    const adapters = companyAdapterService(db);
    const cloud = await adapters.create(companyId, { name: "cloud", adapterType: "codex_local", adapterConfig: {}, aiConnection: a.binding, defaultEnvironmentId: null });
    const local = await adapters.create(companyId, { name: "local", adapterType: "claude_local", adapterConfig: {}, aiConnection: null, defaultEnvironmentId: null });
    await adapters.setAgentList(companyId, agent!.id, [{ adapterId: cloud.id, enabled: true, model: "primary-model" }, { adapterId: local.id, enabled: true, model: "fallback-model" }]);
    const queuedRun = async (taskKey: string | null = null) => {
      const runId = randomUUID();
      const wakeupRequestId = randomUUID();
      await db.insert(agentWakeupRequests).values({
        id: wakeupRequestId, companyId, agentId: agent!.id, source: "on_demand", triggerDetail: "manual", status: "queued", runId,
        requestedByActorType: "user", requestedByActorId: userId, payload: { manualUserWake: true },
      });
      await db.insert(heartbeatRuns).values({
        id: runId, companyId, agentId: agent!.id, invocationSource: "on_demand", triggerDetail: "manual", status: "queued",
        wakeupRequestId, contextSnapshot: taskKey ? { taskKey } : {}, responsibleUserId: userId, createdAt: new Date(Date.now() - 60_000),
      });
      return runId;
    };
    const runRow = async (id: string) => (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, id)))[0]!;
    const agentRow = async () => (await db.select().from(agents).where(eq(agents.id, agent!.id)))[0]!;
    const drain = async () => { await heartbeat.resumeQueuedRuns(); await heartbeat.drainActiveRunExecutions(); };
    return { companyId, userId, agent: agent!, a, cloud, local, adapters, queuedRun, runRow, agentRow, drain };
  }

  it("a run on an adapter keeps the agent's instructions and env; a managed connection drops the agent's provider env", () => {
    const agent = {
      adapterType: "codex_local", defaultEnvironmentId: "env-agent", runtimeConfig: { aiConnection: { mode: "shared" }, heartbeat: { enabled: true } },
      adapterConfig: { model: "x", cwd: "/w", instructionsFilePath: "/a.md", env: { GH: 1, ANTHROPIC_BASE_URL: "local", ANTHROPIC_MODEL: "qwen", CLAUDE_CONFIG_DIR: "/c" } },
    };
    const managed = overlayAgentWithSlot(agent, {
      id: "s", priority: 1, enabled: true, label: null, adapterType: "claude_local", aiConnection: { mode: "shared", grantId: "g" },
      adapterConfig: { model: "y", cwd: "/elsewhere", dangerouslySkipPermissions: true, env: { IGNORED: 1 } }, defaultEnvironmentId: "env-adapter",
    });
    expect(managed.adapterType).toBe("claude_local");
    expect(managed.defaultEnvironmentId).toBe("env-adapter");
    // The working directory is the agent's, not the adapter's.
    expect(managed.adapterConfig).toEqual({ model: "y", cwd: "/w", dangerouslySkipPermissions: true, instructionsFilePath: "/a.md", agentsMdPath: "/a.md", env: { GH: 1, CLAUDE_CONFIG_DIR: "/c" } });
    expect(managed.runtimeConfig).toEqual({ aiConnection: { mode: "shared", grantId: "g" }, heartbeat: { enabled: true } });
    // Self-managed adapter (no connection): the agent's env stays whole.
    expect(slotRunAdapterConfig(agent.adapterConfig, { model: "z" }, false).env).toEqual(agent.adapterConfig.env);
  });

  it("backfill turns agents' own settings into shared company adapters and converts legacy inline slots", async () => {
    const companyId = randomUUID();
    const userId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Backfill Co", issuePrefix: `BF${++n}`, defaultResponsibleUserId: userId });
    const cfg = { model: "sonnet", cwd: "/w", dangerouslySkipPermissions: true, instructionsFilePath: "/x.md", env: { A: { type: "plain", value: "1" } } };
    const [one] = await db.insert(agents).values({ companyId, name: "One", role: "engineer", status: "idle", adapterType: "claude_local", adapterConfig: cfg, runtimeConfig: {}, permissions: {} }).returning();
    const [two] = await db.insert(agents).values({ companyId, name: "Two", role: "engineer", status: "idle", adapterType: "claude_local", adapterConfig: { ...cfg, instructionsFilePath: "/y.md" }, runtimeConfig: {}, permissions: {} }).returning();
    await db.insert(agentInferenceSlots).values({ companyId, agentId: two!.id, priority: 1, enabled: false, label: "qwen", adapterType: "claude_local", adapterConfig: { model: "qwen" }, aiConnection: null });
    const svc = companyAdapterService(db);
    expect(await svc.backfillAll()).toBeGreaterThanOrEqual(2);
    const rows = await db.select().from(companyAdapters).where(eq(companyAdapters.companyId, companyId));
    expect(rows.map((r) => r.name).sort()).toEqual(["Claude Code · own auth", "qwen"]);
    const shared = rows.find((r) => r.name.startsWith("Claude Code"))!;
    // Model and working directory are not the adapter's: the model is on the agent's list row.
    expect(shared.adapterConfig).toEqual({ dangerouslySkipPermissions: true });
    expect((await svc.agentList(one!.id)).map((r) => [r.adapter.name, r.enabled, r.slotConfig])).toEqual([[shared.name, true, { model: "sonnet" }]]);
    expect((await svc.agentList(two!.id)).map((r) => [r.adapter.name, r.enabled, r.slotConfig])).toEqual([[shared.name, true, { model: "sonnet" }], ["qwen", false, { model: "qwen" }]]);
    expect(await svc.backfillAll()).toBe(0); // idempotent
  });

  it("the agent's own fields mirror its first enabled adapter; editing the adapter updates them", async () => {
    const s = await seed();
    expect((await s.agentRow()).adapterType).toBe("codex_local");
    await s.adapters.setAgentList(s.companyId, s.agent.id, [{ adapterId: s.cloud.id, enabled: false, model: "primary-model" }, { adapterId: s.local.id, enabled: true, model: "fallback-model", effort: "high" }]);
    let row = await s.agentRow();
    expect(row.adapterType).toBe("claude_local");
    expect(row.adapterConfig).toMatchObject({ model: "fallback-model", effort: "high", instructionsFilePath: "/agent/AGENTS.md", env: { GH_TOKEN: { type: "plain", value: "gh" } } });
    expect((row.runtimeConfig as Record<string, unknown>).aiConnection).toBeUndefined();
    await s.adapters.update(s.companyId, s.local.id, { name: "local", adapterType: "claude_local", adapterConfig: { model: "ignored", dangerouslySkipPermissions: true }, aiConnection: null, defaultEnvironmentId: null });
    row = await s.agentRow();
    // A model sent to the adapter is not stored there; the agent's pick stays.
    expect(row.adapterConfig).toMatchObject({ model: "fallback-model", dangerouslySkipPermissions: true });
  });

  it("consolidation moves model and effort onto agents' rows and merges adapters that differed only by them", async () => {
    const companyId = randomUUID();
    const userId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Merge Co", issuePrefix: `MG${++n}`, defaultResponsibleUserId: userId });
    const mk = async (name: string, model: string, effort?: string) => {
      const [agent] = await db.insert(agents).values({ companyId, name, role: "engineer", status: "idle", adapterType: "claude_local",
        adapterConfig: { model, ...(effort ? { effort } : {}), cwd: `/w/${name}` }, runtimeConfig: {}, permissions: {} }).returning();
      return agent!;
    };
    const one = await mk("One", "sonnet");
    const two = await mk("Two", "opus", "high");
    // Rows as the first release stored them: model/effort/cwd on the adapter.
    const [sonnet] = await db.insert(companyAdapters).values({ companyId, name: "Claude Code · sonnet · own auth", adapterType: "claude_local", adapterConfig: { model: "sonnet", cwd: "/w/One", maxTurnsPerRun: 5 } }).returning();
    const [opus] = await db.insert(companyAdapters).values({ companyId, name: "Claude Code · opus · own auth", adapterType: "claude_local", adapterConfig: { model: "opus", effort: "high", cwd: "/w/Two" } }).returning();
    await db.insert(agentInferenceSlots).values([
      { companyId, agentId: one.id, priority: 0, adapterId: sonnet!.id },
      { companyId, agentId: two.id, priority: 0, adapterId: opus!.id },
      { companyId, agentId: two.id, priority: 1, adapterId: sonnet!.id },
    ]);
    const svc = companyAdapterService(db);
    await svc.consolidateCompany(companyId);
    const rows = await db.select().from(companyAdapters).where(eq(companyAdapters.companyId, companyId));
    expect(rows.map((r) => [r.name, r.adapterConfig])).toEqual([["Claude Code · own auth", {}]]);
    expect((await svc.agentList(one.id)).map((r) => r.slotConfig)).toEqual([{ model: "sonnet" }]);
    // Two listed both: the first (opus, high) stays.
    expect((await svc.agentList(two.id)).map((r) => r.slotConfig)).toEqual([{ model: "opus", effort: "high" }]);
    const [twoRow] = await db.select().from(agents).where(eq(agents.id, two.id));
    expect(twoRow!.adapterConfig).toMatchObject({ model: "opus", effort: "high", cwd: "/w/Two" });
    await svc.consolidateCompany(companyId); // idempotent
    expect((await db.select().from(companyAdapters).where(eq(companyAdapters.companyId, companyId))).length).toBe(1);
  });

  it("the mirror restores adapter fields that drifted on the agent row", async () => {
    const s = await seed();
    // Adapter fields drifted on the agent row (e.g. an old API client) are restored by the mirror.
    await db.update(agents).set({ adapterConfig: { model: "drifted", instructionsFilePath: "/agent/AGENTS.md" } }).where(eq(agents.id, s.agent.id));
    await s.adapters.mirrorAgent(s.agent.id);
    expect(((await s.agentRow()).adapterConfig as Record<string, unknown>).model).toBe("primary-model");
  });

  it("an adapter without an environment override keeps the agent's environment", async () => {
    const s = await seed();
    const envId = randomUUID();
    await db.execute(sql`UPDATE agents SET default_environment_id = NULL WHERE id = ${s.agent.id}`);
    const view = overlayAgentWithSlot({ ...(await s.agentRow()), defaultEnvironmentId: envId }, { id: s.local.id, priority: 1, enabled: true, label: null, adapterType: "claude_local", adapterConfig: {}, aiConnection: null, defaultEnvironmentId: undefined });
    expect(view.defaultEnvironmentId).toBe(envId);
  });

  it("an adapter in use cannot be deleted", async () => {
    const s = await seed();
    await expect(s.adapters.remove(s.companyId, s.local.id)).rejects.toBeInstanceOf(AdapterInUseError);
    await s.adapters.setAgentList(s.companyId, s.agent.id, [{ adapterId: s.cloud.id, enabled: true }]);
    expect(await s.adapters.remove(s.companyId, s.local.id)).toBe(true);
  });

  it("runs on the first adapter while it is available", async () => {
    const s = await seed();
    const id = await s.queuedRun("task-1");
    await s.drain();
    const run = await s.runRow(id);
    expect(readInferenceSlotSelection(run.contextSnapshot)).toMatchObject({ slotId: s.cloud.id, label: "cloud", reason: "priority" });
    expect((run.runnerProfileJson as Record<string, any>).adapterDispatch.adapterType).toBe("codex_local");
  });

  it("a new task skips an adapter at its soft limit and runs on the next one", async () => {
    const s = await seed();
    limitSettingsStore.set(s.a.grantId, { ...DEFAULT_LIMIT_SETTINGS, enabled: true });
    accountCapacity.record(s.a.grantId, weekly(45, 40));
    const id = await s.queuedRun("task-2");
    await s.drain();
    const run = await s.runRow(id);
    expect(readInferenceSlotSelection(run.contextSnapshot)).toMatchObject({ slotId: s.local.id, adapterType: "claude_local", model: "fallback-model" });
    expect((run.runnerProfileJson as Record<string, any>).adapterDispatch.adapterType).toBe("claude_local");
    expect(executed).toEqual([{ adapterType: "claude_local", model: "fallback-model" }]);
    const [aff] = await db.select().from(agentInferenceSlotTaskState).where(eq(agentInferenceSlotTaskState.taskKey, "task-2"));
    expect(aff!.slotId).toBe(s.local.id);
  });

  it("a task that ran on an adapter waits at its soft limit instead of switching", async () => {
    const s = await seed();
    await inferenceSlotService(db).setAffinity(s.companyId, s.agent.id, "task-3", s.cloud.id, randomUUID());
    limitSettingsStore.set(s.a.grantId, { ...DEFAULT_LIMIT_SETTINGS, enabled: true });
    accountCapacity.record(s.a.grantId, weekly(45, 40));
    const id = await s.queuedRun("task-3");
    await s.drain();
    const run = await s.runRow(id);
    expect(run.status).toBe("queued");
    expect(readAiLimitRunWait(run.contextSnapshot)).toMatchObject({ grantId: s.a.grantId, reason: "weekly_ahead_of_pace" });
    expect(executed).toEqual([]);
  });

  it("a hard limit moves the task to the next adapter and drops the old session", async () => {
    const s = await seed();
    await inferenceSlotService(db).setAffinity(s.companyId, s.agent.id, "task-4", s.cloud.id, randomUUID());
    await db.insert(agentTaskSessions).values({ companyId: s.companyId, agentId: s.agent.id, adapterType: "codex_local", taskKey: "task-4", sessionParamsJson: {}, sessionDisplayId: "sess" });
    await recordInferenceHardLimit(db, {
      run: { id: randomUUID(), companyId: s.companyId, agentId: s.agent.id, responsibleUserId: s.userId, contextSnapshot: { inferenceSlot: { slotId: s.cloud.id, adapterType: "codex_local" } } },
      agent: s.agent, retryNotBefore: new Date(Date.now() + 3_600_000).toISOString(), message: "You've hit your 5-hour limit",
    });
    const [ex] = await db.select().from(inferenceExhaustions).where(eq(inferenceExhaustions.companyId, s.companyId));
    expect(ex!.key).toBe(`grant:${s.a.grantId}`);
    const id = await s.queuedRun("task-4");
    await s.drain();
    const run = await s.runRow(id);
    expect(readInferenceSlotSelection(run.contextSnapshot)).toMatchObject({ slotId: s.local.id, reason: "switched_hard_limit", previousSlotId: s.cloud.id });
    expect(await db.select().from(agentTaskSessions).where(and(eq(agentTaskSessions.agentId, s.agent.id), eq(agentTaskSessions.adapterType, "codex_local")))).toEqual([]);
  });

  it("a provider_quota failure on an adapter without an account marks that adapter exhausted", async () => {
    const s = await seed();
    limitSettingsStore.set(s.a.grantId, { ...DEFAULT_LIMIT_SETTINGS, enabled: true });
    accountCapacity.record(s.a.grantId, weekly(45, 40));
    mockAdapterExecute.mockReturnValue({
      exitCode: 1, signal: null, timedOut: false, errorMessage: "You've hit your 5-hour limit", errorCode: "provider_quota",
      errorFamily: "provider_quota", retryNotBefore: new Date(Date.now() + 7_200_000).toISOString(), provider: "test", model: "m",
    });
    await s.queuedRun("task-5");
    await s.drain();
    const [ex] = await db.select().from(inferenceExhaustions).where(eq(inferenceExhaustions.companyId, s.companyId));
    expect(ex!.key).toBe(`adapter:${s.local.id}`);
  });

  it("a retry that carries the choice of an adapter no longer on the agent goes the agent's way", async () => {
    const s = await seed();
    await s.adapters.setAgentList(s.companyId, s.agent.id, [{ adapterId: s.cloud.id, enabled: true }]);
    const id = await s.queuedRun("task-7");
    await db.update(heartbeatRuns).set({ contextSnapshot: { taskKey: "task-7", inferenceSlot: { slotId: s.local.id, adapterType: "claude_local", priority: 1, label: null, model: null, reason: "priority", previousSlotId: null } } })
      .where(eq(heartbeatRuns.id, id));
    await s.drain();
    const run = await s.runRow(id);
    expect(readInferenceSlotSelection(run.contextSnapshot)).toMatchObject({ slotId: s.cloud.id });
    expect((run.runnerProfileJson as Record<string, any>).adapterDispatch.adapterType).toBe("codex_local");
    expect(run.error ?? "").not.toContain("adapter this run was claimed on");
  });

  it("waits for the earliest adapter when every adapter is limited", async () => {
    const s = await seed();
    limitSettingsStore.set(s.a.grantId, { ...DEFAULT_LIMIT_SETTINGS, enabled: true });
    accountCapacity.record(s.a.grantId, weekly(45, 40));
    await inferenceSlotService(db).recordExhaustion({ companyId: s.companyId, key: `adapter:${s.local.id}`, until: new Date(Date.now() + 3_600_000), runId: null, message: null });
    const id = await s.queuedRun("task-6");
    await s.drain();
    const run = await s.runRow(id);
    expect(run.status).toBe("queued");
    expect(readAiLimitRunWait(run.contextSnapshot)).not.toBeNull();
    expect(executed).toEqual([]);
  });
});
