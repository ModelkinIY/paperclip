import { randomUUID } from "node:crypto";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import {
  agents, agentWakeupRequests, aiProviderDefaults, companies, companyMemberships, createDb, heartbeatRuns, toolConnections,
} from "@paperclipai/db";
import { readAiLimitRunWait } from "@paperclipai/shared";
import { aiConnectionService } from "../services/ai-connections.js";
import {
  AccountCapacityStore, DEFAULT_LIMIT_SETTINGS, InMemoryLimitSettingsStore, accountCapacity, limitSettingsStore,
  createAccountLimitGate, resolveRunAccountCandidates, type Observation,
} from "../services/account-capacity/index.js";
import { heartbeatService } from "../services/heartbeat.ts";
import { runningProcesses } from "../adapters/index.ts";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const mockAdapterExecute = vi.hoisted(() =>
  vi.fn(async () => ({
    exitCode: 0, signal: null, timedOut: false, errorMessage: null,
    summary: "account limit gate test run.", provider: "test", model: "test-model",
  })),
);
vi.mock("../adapters/index.ts", async () => {
  const actual = await vi.importActual<typeof import("../adapters/index.ts")>("../adapters/index.ts");
  return { ...actual, getServerAdapter: vi.fn(() => ({ supportsLocalAgentJwt: false, execute: mockAdapterExecute })) };
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

describeDb("account limit gate", () => {
  let db!: ReturnType<typeof createDb>;
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let home: string;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let n = 0;

  beforeAll(async () => {
    home = await realpath(await mkdtemp(path.join(os.tmpdir(), "paperclip-account-limit-")));
    vi.stubEnv("PAPERCLIP_HOME", home);
    vi.stubEnv("PAPERCLIP_INSTANCE_ID", "account-limit-fixture");
    database = await startEmbeddedPostgresTestDatabase("paperclip-account-limit-db-");
    db = createDb(database.connectionString);
    heartbeat = heartbeatService(db);
  }, 120_000);

  afterEach(async () => {
    await heartbeat.drainActiveRunExecutions();
    mockAdapterExecute.mockClear();
    runningProcesses.clear();
    await db.execute(sql`truncate table ${companies} cascade`);
  });
  afterAll(async () => {
    await database?.cleanup();
    vi.unstubAllEnvs();
    if (home) await rm(home, { recursive: true, force: true });
  });

  /** An agent bound to an account that the board sees as an Anthropic subscription. */
  async function seed(mode: "shared" | "responsible_user") {
    const companyId = randomUUID();
    const userId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Limit Co", issuePrefix: `LG${++n}`, defaultResponsibleUserId: userId });
    await db.insert(companyMemberships).values({ companyId, principalId: userId, principalType: "user", status: "active", membershipRole: "owner" });
    const account = await aiConnectionService(db).save(companyId, userId, {
      provider: "openrouter", method: "api_key", ownership: "personal", name: `Account ${n}`,
      apiKey: "fixture-key", allAgents: true, agentIds: [],
    }, "fixture-key");
    // The fixture credential kind is irrelevant to the gate; present the account as a Claude subscription.
    await db.update(toolConnections).set({ config: sql`jsonb_set(config, '{ai}', '{"provider":"anthropic","method":"subscription"}'::jsonb)` })
      .where(eq(toolConnections.id, account.connectionId));
    await db.insert(aiProviderDefaults).values({ companyId, userId, provider: "anthropic", grantId: account.grantId }).onConflictDoNothing();
    const binding = mode === "shared"
      ? { provider: "anthropic", method: "subscription", mode, connectionId: account.connectionId, grantId: account.grantId }
      : { provider: "anthropic", method: "subscription", mode };
    const [agent] = await db.insert(agents).values({
      companyId, name: "Limited", role: "engineer", status: "idle", adapterType: "codex_local", adapterConfig: {},
      runtimeConfig: { aiConnection: binding, heartbeat: { enabled: true, intervalSec: 60, wakeOnDemand: true, maxConcurrentRuns: 3 } },
      permissions: {},
    }).returning();
    const queuedRun = async () => {
      const runId = randomUUID();
      const wakeupRequestId = randomUUID();
      await db.insert(agentWakeupRequests).values({
        id: wakeupRequestId, companyId, agentId: agent!.id, source: "on_demand", triggerDetail: "manual", status: "queued", runId,
        requestedByActorType: "user", requestedByActorId: userId, payload: { manualUserWake: true },
      });
      await db.insert(heartbeatRuns).values({
        id: runId, companyId, agentId: agent!.id, invocationSource: "on_demand", triggerDetail: "manual", status: "queued",
        wakeupRequestId, contextSnapshot: {}, responsibleUserId: userId, createdAt: new Date(Date.now() - 60_000),
      });
      const [row] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
      return row!;
    };
    return { companyId, userId, agent: agent!, grantId: account.grantId, queuedRun };
  }

  it("finds the account of an explicit binding and of the responsible user's default", async () => {
    for (const mode of ["shared", "responsible_user"] as const) {
      const s = await seed(mode);
      const run = await s.queuedRun();
      const [c] = await resolveRunAccountCandidates(db, run);
      expect(c).toMatchObject({ grantId: s.grantId, provider: "anthropic", method: "subscription" });
    }
  });

  it("returns no candidates when the user is unknown or there is no AI binding", async () => {
    const s = await seed("responsible_user");
    const run = await s.queuedRun();
    expect(await resolveRunAccountCandidates(db, { ...run, responsibleUserId: null })).toEqual([]);
    await db.update(agents).set({ runtimeConfig: {} }).where(eq(agents.id, s.agent.id));
    expect(await resolveRunAccountCandidates(db, run)).toEqual([]);
  });

  it("holds a run on an account over its pace, records why, and lets it through after release", async () => {
    const s = await seed("shared");
    const store = new AccountCapacityStore(new InMemoryLimitSettingsStore());
    (store as unknown as { settings: InMemoryLimitSettingsStore }).settings.set(s.grantId, { ...DEFAULT_LIMIT_SETTINGS, enabled: true });
    const gate = createAccountLimitGate(db, store);
    const run = await s.queuedRun();

    store.record(s.grantId, weekly(45, 40));
    expect(await gate.pass(run)).toBe(false);
    const [held] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run.id));
    expect(held!.status).toBe("queued");
    const wait = readAiLimitRunWait(held!.contextSnapshot);
    expect(wait).toMatchObject({ grantId: s.grantId, provider: "anthropic", reason: "weekly_ahead_of_pace" });
    expect(wait!.heldUntil).not.toBeNull();

    store.record(s.grantId, weekly(30, 40, new Date(Date.now() + 1000)));
    expect(await gate.pass(held!)).toBe(true);
    const [after] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run.id));
    expect(readAiLimitRunWait(after!.contextSnapshot)).toBeNull();
  });

  it("does not hold a run that already started, nor an account without accounting", async () => {
    const s = await seed("shared");
    const store = new AccountCapacityStore(new InMemoryLimitSettingsStore());
    const gate = createAccountLimitGate(db, store);
    const run = await s.queuedRun();
    store.record(s.grantId, weekly(90, 10));
    expect(await gate.pass(run)).toBe(true); // accounting off by default
    (store as unknown as { settings: InMemoryLimitSettingsStore }).settings.set(s.grantId, { ...DEFAULT_LIMIT_SETTINGS, enabled: true });
    expect(await gate.pass(run)).toBe(false);
    expect(await gate.pass({ ...run, startedAt: new Date() })).toBe(true);
  });

  it("keeps a queued run waiting through the real queue, and starts it once the account is released", async () => {
    const s = await seed("shared");
    limitSettingsStore.set(s.grantId, { ...DEFAULT_LIMIT_SETTINGS, enabled: true });
    accountCapacity.record(s.grantId, weekly(45, 40));
    const run = await s.queuedRun();

    await heartbeat.resumeQueuedRuns();
    await heartbeat.drainActiveRunExecutions();
    const [held] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run.id));
    expect(held!.status).toBe("queued");
    expect(readAiLimitRunWait(held!.contextSnapshot)?.grantId).toBe(s.grantId);

    accountCapacity.record(s.grantId, weekly(30, 40, new Date(Date.now() + 1000)));
    await heartbeat.resumeQueuedRuns();
    await heartbeat.drainActiveRunExecutions();
    const [after] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run.id));
    expect(readAiLimitRunWait(after!.contextSnapshot)).toBeNull();
    expect(after!.status).not.toBe("queued");
  });
});
