import { randomUUID } from "node:crypto";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import express from "express";
import request from "supertest";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { activityLog, agents, aiGrantLimitSettings, companies, companyMemberships, createDb, toolConnections } from "@paperclipai/db";
import { errorHandler } from "../middleware/index.js";
import { accountLimitsRoutes } from "../routes/account-limits.js";
import { aiConnectionService } from "../services/ai-connections.js";
import {
  DEFAULT_LIMIT_SETTINGS, accountCapacity, limitSettingsStore, resetAccountCapacityForTests, type Observation,
} from "../services/account-capacity/index.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
const describeDb = support.supported ? describe : describe.skip;
const WEEK = 604_800;
const weekly = (used: number, elapsed: number): Observation => {
  const now = new Date();
  return {
    observedAt: now, source: "usage_probe",
    windows: [{ id: "seven_day", label: "7-day", scope: null, usedPercent: used, durationSeconds: WEEK, limitReached: null,
      resetsAt: new Date(now.getTime() + (1 - elapsed / 100) * WEEK * 1000) }],
  };
};

describeDb("account limit routes", () => {
  let db!: ReturnType<typeof createDb>;
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let home: string;
  let n = 0;
  const probeUsage = vi.fn();
  const resume = vi.fn(async () => undefined);

  beforeAll(async () => {
    home = await realpath(await mkdtemp(path.join(os.tmpdir(), "paperclip-account-limits-routes-")));
    vi.stubEnv("PAPERCLIP_HOME", home);
    vi.stubEnv("PAPERCLIP_INSTANCE_ID", "account-limits-routes");
    database = await startEmbeddedPostgresTestDatabase("paperclip-account-limits-routes-db-");
    db = createDb(database.connectionString);
  }, 120_000);
  afterEach(async () => {
    probeUsage.mockReset();
    resume.mockClear();
    resetAccountCapacityForTests();
    limitSettingsStore.clear();
    await db.execute(sql`truncate table ${companies} cascade`);
  });
  afterAll(async () => {
    await database?.cleanup();
    vi.unstubAllEnvs();
    if (home) await rm(home, { recursive: true, force: true });
  });

  function app(actor: Record<string, unknown>) {
    const a = express();
    a.use(express.json());
    a.use((req, _res, next) => { (req as any).actor = actor; next(); });
    a.use("/api", accountLimitsRoutes(db, { usage: { list: async () => [], probeUsage } as any, resumeQueuedRuns: resume }));
    a.use(errorHandler);
    return a;
  }
  const board = (companyIds: string[]) => app({ type: "board", userId: "user-1", companyIds, source: "session", isInstanceAdmin: false });

  async function seed(provider: "anthropic" | "openrouter" = "anthropic") {
    const companyId = randomUUID();
    const userId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Co", issuePrefix: `AL${++n}`, defaultResponsibleUserId: userId });
    await db.insert(companyMemberships).values({ companyId, principalId: userId, principalType: "user", status: "active", membershipRole: "owner" });
    const account = await aiConnectionService(db).save(companyId, userId, {
      provider: "openrouter", method: "api_key", ownership: "personal", name: `Claude ${n}`, apiKey: "fixture-key",
      allAgents: true, agentIds: [],
    }, "fixture-key");
    if (provider === "anthropic") {
      await db.update(toolConnections).set({ config: sql`jsonb_set(config, '{ai}', '{"provider":"anthropic","method":"subscription"}'::jsonb)` })
        .where(eq(toolConnections.id, account.connectionId));
    }
    const [agent] = await db.insert(agents).values({
      companyId, name: "Pinned", role: "engineer", status: "idle", adapterType: "codex_local", adapterConfig: {},
      runtimeConfig: { aiConnection: { provider: "anthropic", method: "subscription", mode: "shared", connectionId: account.connectionId, grantId: account.grantId } },
      permissions: {},
    }).returning();
    return { companyId, grantId: account.grantId, connectionId: account.connectionId, agent: agent! };
  }

  it("lists the company's AI accounts with capacity, settings and pinned agents", async () => {
    const s = await seed();
    accountCapacity.record(s.grantId, weekly(45, 40));
    const res = await request(board([s.companyId])).get(`/api/companies/${s.companyId}/account-limits`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0]).toMatchObject({
      grantId: s.grantId, provider: "anthropic", limitsSupported: true,
      settings: { enabled: false, paceModel: "linear" },
      capacity: { available: true, reason: "gate_disabled" },
    });
    expect(res.body[0].capacity.windows[0]).toMatchObject({ id: "seven_day", role: "weekly", hold: true });
    expect(res.body[0].agents).toEqual([{ id: s.agent.id, name: "Pinned", via: "grant" }]);
    expect(res.body[0].paceModels).toContain("linear");
  });

  it("turns accounting on, persists it, logs it, and shows the hold", async () => {
    const s = await seed();
    accountCapacity.record(s.grantId, weekly(45, 40));
    const a = board([s.companyId]);
    const patched = await request(a).patch(`/api/companies/${s.companyId}/account-limits/${s.grantId}`).send({ enabled: true });
    expect(patched.status).toBe(200);
    expect(patched.body.settings.enabled).toBe(true);
    const [row] = await db.select().from(aiGrantLimitSettings).where(eq(aiGrantLimitSettings.grantId, s.grantId));
    expect(row).toMatchObject({ enabled: true, paceModel: "linear" });
    expect((await db.select().from(activityLog).where(eq(activityLog.companyId, s.companyId))).map((r) => r.action)).toContain("account_limit.updated");
    const list = await request(a).get(`/api/companies/${s.companyId}/account-limits`);
    expect(list.body[0].capacity).toMatchObject({ available: false, reason: "weekly_ahead_of_pace" });
  });

  it("resumes the queue when accounting is switched off", async () => {
    const s = await seed();
    limitSettingsStore.set(s.grantId, { ...DEFAULT_LIMIT_SETTINGS, enabled: true });
    const res = await request(board([s.companyId])).patch(`/api/companies/${s.companyId}/account-limits/${s.grantId}`).send({ enabled: false });
    expect(res.status).toBe(200);
    expect(resume).toHaveBeenCalledTimes(1);
  });

  it("validates settings", async () => {
    const s = await seed();
    const url = `/api/companies/${s.companyId}/account-limits/${s.grantId}`;
    const a = board([s.companyId]);
    expect((await request(a).patch(url).send({ weekly: { holdAbove: 0, releaseAtOrBelow: 5 } })).status).toBe(400);
    expect((await request(a).patch(url).send({ unknown: 1 })).status).toBe(400);
    expect((await request(a).patch(`/api/companies/${s.companyId}/account-limits/not-a-uuid`).send({ enabled: true })).status).toBe(400);
  });

  it("refreshes through the usage probe and reports the verdict", async () => {
    const s = await seed();
    probeUsage.mockResolvedValue({ status: "ok", limits: [{
      id: "seven_day", label: "7-day", scope: null, windowDurationSeconds: WEEK, resetsAt: new Date(Date.now() + 0.6 * WEEK * 1000).toISOString(),
      usedPercent: 10, remainingPercent: 90, used: null, limit: null, remaining: null, unit: null, limitReached: false, allowed: null }] });
    const res = await request(board([s.companyId])).post(`/api/companies/${s.companyId}/account-limits/${s.grantId}/refresh`);
    expect(res.status).toBe(200);
    expect(res.body.probed).toBe(true);
    expect(res.body.capacity.windows[0].usedPercent).toBe(10);
    expect(probeUsage).toHaveBeenCalledWith(s.companyId, "user-1", s.connectionId, s.grantId);
  });

  it("is board only and company scoped, and 404s for other companies' grants", async () => {
    const s = await seed();
    const other = await seed();
    const url = `/api/companies/${s.companyId}/account-limits`;
    expect((await request(app({ type: "agent", agentId: s.agent.id, companyId: s.companyId })).get(url)).status).toBe(403);
    expect((await request(board([other.companyId])).get(url)).status).toBe(403);
    expect((await request(board([s.companyId])).patch(`${url}/${other.grantId}`).send({ enabled: true })).status).toBe(404);
  });
});
