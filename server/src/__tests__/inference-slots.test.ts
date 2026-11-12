import { randomUUID } from "node:crypto";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import {
  agentInferenceSlotTaskState, agentTaskSessions, agents, agentWakeupRequests, companies, companyMemberships, createDb,
  heartbeatRuns, inferenceExhaustions, toolConnections,
} from "@paperclipai/db";
import { readAiLimitRunWait, readInferenceSlotSelection } from "@paperclipai/shared";
import { aiConnectionService } from "../services/ai-connections.js";
import { DEFAULT_LIMIT_SETTINGS, accountCapacity, limitSettingsStore, type Observation } from "../services/account-capacity/index.js";
import {
  inferenceSlotService, overlayAgentWithSlot, recordInferenceHardLimit, slotConfigFromAgentConfig, PRIMARY_SLOT_ID,
} from "../services/inference-slots/service.js";
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

  /** Agent on account A (primary, model "primary-model") with a fallback slot without account (model "fallback-model"). */
  async function seed() {
    const companyId = randomUUID();
    const userId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Slots Co", issuePrefix: `SL${++n}`, defaultResponsibleUserId: userId });
    await db.insert(companyMemberships).values({ companyId, principalId: userId, principalType: "user", status: "active", membershipRole: "owner" });
    const a = await account(companyId, userId, `A${n}`);
    const [agent] = await db.insert(agents).values({
      companyId, name: "Slotted", role: "engineer", status: "idle", adapterType: "codex_local",
      adapterConfig: { model: "primary-model", instructionsFilePath: "/agent/AGENTS.md", env: { GH_TOKEN: { type: "plain", value: "gh" }, ANTHROPIC_BASE_URL: { type: "plain", value: "https://cloud" } } },
      runtimeConfig: { aiConnection: a.binding, heartbeat: { enabled: true, intervalSec: 60, wakeOnDemand: true, maxConcurrentRuns: 3 } },
      permissions: {},
    }).returning();
    const slots = await inferenceSlotService(db).replaceFallbacks(companyId, agent!.id, [{
      enabled: true, label: "local", adapterType: "claude_local",
      adapterConfig: { model: "fallback-model", env: { ANTHROPIC_BASE_URL: { type: "plain", value: "http://local" } } }, aiConnection: null,
    }]);
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
    const drain = async () => { await heartbeat.resumeQueuedRuns(); await heartbeat.drainActiveRunExecutions(); };
    return { companyId, userId, agent: agent!, a, fallback: slots[0]!, queuedRun, runRow, drain };
  }

  it("a slot run keeps the agent's instructions and non-provider env, and takes provider env from the slot", () => {
    const agent = {
      adapterType: "codex_local", runtimeConfig: { aiConnection: { mode: "shared" }, heartbeat: { enabled: true } },
      adapterConfig: { model: "x", instructionsFilePath: "/a.md", cwd: "/w", env: { GH: 1, ANTHROPIC_BASE_URL: "cloud" } },
    };
    const run = overlayAgentWithSlot(agent, {
      id: "s", priority: 1, enabled: true, label: null, adapterType: "claude_local", aiConnection: null,
      adapterConfig: { model: "y", cwd: "/elsewhere", env: { ANTHROPIC_BASE_URL: "local" } },
    });
    expect(run.adapterType).toBe("claude_local");
    expect(run.adapterConfig).toEqual({ model: "y", instructionsFilePath: "/a.md", agentsMdPath: "/a.md", cwd: "/w", env: { GH: 1, ANTHROPIC_BASE_URL: "local" } });
    expect(run.runtimeConfig).toEqual({ heartbeat: { enabled: true } });
    expect(slotConfigFromAgentConfig(agent.adapterConfig)).toEqual({ model: "x", env: { ANTHROPIC_BASE_URL: "cloud" } });
  });

  it("runs on the primary while it is available", async () => {
    const s = await seed();
    const id = await s.queuedRun("task-1");
    await s.drain();
    const run = await s.runRow(id);
    expect(run.status).not.toBe("queued");
    expect(readInferenceSlotSelection(run.contextSnapshot)).toMatchObject({ slotId: PRIMARY_SLOT_ID, reason: "priority" });
    // The fixture account cannot really serve codex; what matters is that the primary was dispatched.
    expect((run.runnerProfileJson as Record<string, any>).adapterDispatch.adapterType).toBe("codex_local");
    expect(executed.every((e) => e.adapterType === "codex_local")).toBe(true);
  });

  it("a new task skips a primary at its soft limit and runs on the fallback's adapter", async () => {
    const s = await seed();
    limitSettingsStore.set(s.a.grantId, { ...DEFAULT_LIMIT_SETTINGS, enabled: true });
    accountCapacity.record(s.a.grantId, weekly(45, 40));
    const id = await s.queuedRun("task-2");
    await s.drain();
    const run = await s.runRow(id);
    expect(readInferenceSlotSelection(run.contextSnapshot)).toMatchObject({ slotId: s.fallback.id, adapterType: "claude_local", model: "fallback-model" });
    expect((run.runnerProfileJson as Record<string, any>).adapterDispatch.adapterType).toBe("claude_local");
    expect(executed).toEqual([{ adapterType: "claude_local", model: "fallback-model" }]);
  });

  it("a task with a session on the primary waits at the soft limit instead of switching", async () => {
    const s = await seed();
    await db.insert(agentTaskSessions).values({ companyId: s.companyId, agentId: s.agent.id, adapterType: "codex_local", taskKey: "task-3", sessionParamsJson: {}, sessionDisplayId: "sess" });
    limitSettingsStore.set(s.a.grantId, { ...DEFAULT_LIMIT_SETTINGS, enabled: true });
    accountCapacity.record(s.a.grantId, weekly(45, 40));
    const id = await s.queuedRun("task-3");
    await s.drain();
    const run = await s.runRow(id);
    expect(run.status).toBe("queued");
    expect(readAiLimitRunWait(run.contextSnapshot)).toMatchObject({ grantId: s.a.grantId, reason: "weekly_ahead_of_pace" });
    expect(executed).toEqual([]);
  });

  it("a hard limit on the primary moves the task to the fallback and drops the old session", async () => {
    const s = await seed();
    await db.insert(agentTaskSessions).values({ companyId: s.companyId, agentId: s.agent.id, adapterType: "codex_local", taskKey: "task-4", sessionParamsJson: {}, sessionDisplayId: "sess" });
    await recordInferenceHardLimit(db, {
      run: { id: randomUUID(), companyId: s.companyId, agentId: s.agent.id, responsibleUserId: s.userId, contextSnapshot: {} },
      agent: s.agent, retryNotBefore: new Date(Date.now() + 3_600_000).toISOString(), message: "You've hit your 5-hour limit",
    });
    const [ex] = await db.select().from(inferenceExhaustions).where(eq(inferenceExhaustions.companyId, s.companyId));
    expect(ex!.key).toBe(`grant:${s.a.grantId}`);
    const id = await s.queuedRun("task-4");
    await s.drain();
    const run = await s.runRow(id);
    expect(readInferenceSlotSelection(run.contextSnapshot)).toMatchObject({ slotId: s.fallback.id, reason: "switched_hard_limit", previousSlotId: PRIMARY_SLOT_ID });
    expect(executed.map((e) => e.adapterType)).toEqual(["claude_local"]);
    const sessions = await db.select().from(agentTaskSessions).where(and(eq(agentTaskSessions.agentId, s.agent.id), eq(agentTaskSessions.adapterType, "codex_local")));
    expect(sessions).toEqual([]);
    const [aff] = await db.select().from(agentInferenceSlotTaskState).where(eq(agentInferenceSlotTaskState.taskKey, "task-4"));
    expect(aff!.slotId).toBe(s.fallback.id);
  });

  it("a provider_quota failure on a slot run records the slot exhausted", async () => {
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
    expect(ex!.key).toBe(`slot:${s.agent.id}:${s.fallback.id}`);
  });

  it("waits for the earliest slot when every slot is limited", async () => {
    const s = await seed();
    limitSettingsStore.set(s.a.grantId, { ...DEFAULT_LIMIT_SETTINGS, enabled: true });
    accountCapacity.record(s.a.grantId, weekly(45, 40));
    await inferenceSlotService(db).recordExhaustion({ companyId: s.companyId, key: `slot:${s.agent.id}:${s.fallback.id}`, until: new Date(Date.now() + 3_600_000), runId: null, message: null });
    const id = await s.queuedRun("task-6");
    await s.drain();
    const run = await s.runRow(id);
    expect(run.status).toBe("queued");
    expect(readAiLimitRunWait(run.contextSnapshot)).not.toBeNull();
    expect(executed).toEqual([]);
  });
});
