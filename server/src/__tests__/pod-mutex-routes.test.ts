import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issueLabels,
  issues,
  labels,
  podMutexLabels,
  podMutexLeases,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { podMutexRoutes } from "../routes/pod-mutex.js";
import { podMutexService } from "../services/pod-mutex.js";

const support = await getEmbeddedPostgresTestSupport();
const describeDb = support.supported ? describe : describe.skip;

describeDb("pod mutex routes", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-pod-mutex-routes-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  function app(actor: Record<string, unknown>, deps: Parameters<typeof podMutexRoutes>[1] = {}) {
    const a = express();
    a.use(express.json());
    a.use((req, _res, next) => {
      (req as any).actor = actor;
      next();
    });
    a.use("/api", podMutexRoutes(db, deps));
    a.use(errorHandler);
    return a;
  }
  const board = (companyIds: string[]) => app({ type: "board", userId: "user-1", companyIds, source: "session", isInstanceAdmin: false });

  async function seedCompany() {
    const companyId = randomUUID();
    const prefix = `R${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    await db.insert(companies).values({ id: companyId, name: "Co", issuePrefix: prefix, requireBoardApprovalForNewAgents: false });
    const [label] = await db.insert(labels).values({ companyId, name: "pod:igor-3090", color: "#000" }).returning();
    return { companyId, prefix, label: label! };
  }

  async function actions(companyId: string) {
    return (await db.select().from(activityLog).where(eq(activityLog.companyId, companyId))).map((r) => r.action);
  }

  it("board CRUD round trip with activity log entries", async () => {
    const c = await seedCompany();
    const a = board([c.companyId]);
    const base = `/api/companies/${c.companyId}/pod-mutexes`;

    const created = await request(a).post(base).send({ labelId: c.label.id });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ labelId: c.label.id, enabled: true, holdingStatuses: ["todo", "in_progress"] });

    const patched = await request(a).patch(`${base}/${c.label.id}`).send({ holdingStatuses: ["in_progress", "blocked"], enabled: false });
    expect(patched.status).toBe(200);
    expect(patched.body).toMatchObject({ enabled: false, holdingStatuses: ["in_progress", "blocked"] });

    const listed = await request(a).get(base);
    expect(listed.status).toBe(200);
    expect(listed.body).toHaveLength(1);
    expect(listed.body[0]).toMatchObject({ labelName: "pod:igor-3090", holder: null, waiting: [] });

    const byName = await request(a).post(base).send({ labelName: "pod:new-box" });
    expect(byName.status).toBe(201);

    const rel = await request(a).post(`${base}/${c.label.id}/release`);
    expect(rel.body).toEqual({ ok: true, released: false, held: false, holderRootIssueId: null, holderHasRunningRun: false });

    const del = await request(a).delete(`${base}/${c.label.id}`);
    expect(del.status).toBe(200);
    expect((await request(a).delete(`${base}/${c.label.id}`)).status).toBe(404);

    const acts = await actions(c.companyId);
    expect(acts).toEqual(expect.arrayContaining([
      "pod_mutex.upserted", "pod_mutex.updated", "pod_mutex.deleted",
    ]));
    // releasing while nothing is held leaves no audit entry
    expect(acts).not.toContain("pod_mutex.force_released");
    const [entry] = await db.select().from(activityLog)
      .where(and(eq(activityLog.companyId, c.companyId), eq(activityLog.action, "pod_mutex.updated")));
    expect(entry).toMatchObject({ entityType: "label", entityId: c.label.id, actorType: "user" });
  });

  it("list shows holder and queue; force-release frees and is logged with the holder", async () => {
    const c = await seedCompany();
    const svc = podMutexService(db);
    await svc.upsert(c.companyId, { labelId: c.label.id });
    const [rootA] = await db.insert(issues).values({ companyId: c.companyId, identifier: `${c.prefix}-1`, title: "A", status: "todo" }).returning();
    const [rootB] = await db.insert(issues).values({ companyId: c.companyId, identifier: `${c.prefix}-2`, title: "B", status: "todo", priority: "high" }).returning();
    // B needs an assignee to count as a waiter; use none for A (holder)
    await db.insert(issueLabels).values([
      { issueId: rootA!.id, labelId: c.label.id, companyId: c.companyId },
      { issueId: rootB!.id, labelId: c.label.id, companyId: c.companyId },
    ]);
    expect((await svc.tryAcquire(c.companyId, rootA!.id)).ok).toBe(true);
    const a = board([c.companyId]);
    const base = `/api/companies/${c.companyId}/pod-mutexes`;
    const listed = await request(a).get(base);
    expect(listed.body[0].holder).toMatchObject({ rootIssueId: rootA!.id, identifier: `${c.prefix}-1`, stillHolding: true });

    const rel = await request(a).post(`${base}/${c.label.id}/release`);
    expect(rel.body).toEqual({ ok: true, released: true, held: true, holderRootIssueId: rootA!.id, holderHasRunningRun: false });
    expect(await db.select().from(podMutexLeases).where(eq(podMutexLeases.companyId, c.companyId))).toHaveLength(0);
    const [entry] = await db.select().from(activityLog)
      .where(and(eq(activityLog.companyId, c.companyId), eq(activityLog.action, "pod_mutex.force_released")));
    expect(entry!.details).toMatchObject({ holderRootIssueId: rootA!.id });
  });

  it("rejects agent keys and unauthenticated callers", async () => {
    const c = await seedCompany();
    const agent = app({ type: "agent", agentId: randomUUID(), companyId: c.companyId, source: "agent_key" });
    const base = `/api/companies/${c.companyId}/pod-mutexes`;
    expect((await request(agent).get(base)).status).toBe(403);
    expect((await request(agent).post(base).send({ labelId: c.label.id })).status).toBe(403);
    expect((await request(agent).post(`${base}/${c.label.id}/release`)).status).toBe(403);
    expect((await request(agent).delete(`${base}/${c.label.id}`)).status).toBe(403);
    const none = app({ type: "none" });
    expect([401, 403]).toContain((await request(none).get(base)).status);
    expect(await db.select().from(podMutexLabels).where(eq(podMutexLabels.companyId, c.companyId))).toHaveLength(0);
  });

  it("validates input", async () => {
    const c = await seedCompany();
    const a = board([c.companyId]);
    const base = `/api/companies/${c.companyId}/pod-mutexes`;
    expect((await request(a).post(base).send({})).status).toBe(400);
    expect((await request(a).post(base).send({ labelId: "not-a-uuid" })).status).toBe(400);
    expect((await request(a).post(base).send({ labelId: c.label.id, holdingStatuses: ["bogus"] })).status).toBe(400);
    expect((await request(a).post(base).send({ labelId: c.label.id, enabled: "yes" })).status).toBe(400);
    expect((await request(a).post(base).send({ labelName: "   " })).status).toBe(400);
    expect((await request(a).post(base).send({ labelId: randomUUID() })).status).toBe(404);
  });

  it("rejects an empty holdingStatuses list", async () => {
    const c = await seedCompany();
    const a = board([c.companyId]);
    const res = await request(a).post(`/api/companies/${c.companyId}/pod-mutexes`).send({ labelId: c.label.id, holdingStatuses: [] });
    expect(res.status).toBe(400);
    await podMutexService(db).upsert(c.companyId, { labelId: c.label.id });
    const patched = await request(a).patch(`/api/companies/${c.companyId}/pod-mutexes/${c.label.id}`).send({ holdingStatuses: [] });
    expect(patched.status).toBe(400);
  });

  it("a malformed :labelId yields 400, not 500", async () => {
    const c = await seedCompany();
    const a = board([c.companyId]);
    const base = `/api/companies/${c.companyId}/pod-mutexes`;
    const statuses = [
      (await request(a).patch(`${base}/nope`).send({ enabled: false })).status,
      (await request(a).delete(`${base}/nope`)).status,
      (await request(a).post(`${base}/nope/release`)).status,
    ];
    expect(statuses).toEqual([400, 400, 400]);
  });

  it("company scoping: another company's board user cannot see or modify", async () => {
    const c = await seedCompany();
    const other = await seedCompany();
    await podMutexService(db).upsert(c.companyId, { labelId: c.label.id });
    const outsider = board([other.companyId]);
    const base = `/api/companies/${c.companyId}/pod-mutexes`;
    expect((await request(outsider).get(base)).status).toBe(403);
    expect((await request(outsider).patch(`${base}/${c.label.id}`).send({ enabled: false })).status).toBe(403);
    expect((await request(outsider).delete(`${base}/${c.label.id}`)).status).toBe(403);
    expect((await request(outsider).post(`${base}/${c.label.id}/release`)).status).toBe(403);

    // own company route but foreign label id -> 404, foreign config untouched
    const own = board([other.companyId]);
    const otherBase = `/api/companies/${other.companyId}/pod-mutexes`;
    expect((await request(own).post(otherBase).send({ labelId: c.label.id })).status).toBe(404);
    expect((await request(own).patch(`${otherBase}/${c.label.id}`).send({ enabled: false })).status).toBe(404);
    expect((await request(own).delete(`${otherBase}/${c.label.id}`)).status).toBe(404);
    const [cfg] = await db.select().from(podMutexLabels).where(eq(podMutexLabels.companyId, c.companyId));
    expect(cfg!.enabled).toBe(true);
    expect((await request(own).get(otherBase)).body).toEqual([]);
  });
  it("admin actions sweep right away: narrowing holding statuses releases and wakes the waiter", async () => {
    const c = await seedCompany();
    const svc = podMutexService(db);
    await svc.upsert(c.companyId, { labelId: c.label.id });
    const [agent] = await db.insert(agents).values({
      companyId: c.companyId, name: "Coder", role: "engineer", status: "active",
      adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {},
    }).returning();
    const [rootA] = await db.insert(issues).values({ companyId: c.companyId, identifier: `${c.prefix}-1`, title: "A", status: "todo" }).returning();
    const [rootB] = await db.insert(issues).values({ companyId: c.companyId, identifier: `${c.prefix}-2`, title: "B", status: "todo", assigneeAgentId: agent!.id }).returning();
    await db.insert(issueLabels).values([
      { issueId: rootA!.id, labelId: c.label.id, companyId: c.companyId },
      { issueId: rootB!.id, labelId: c.label.id, companyId: c.companyId },
    ]);
    expect((await svc.tryAcquire(c.companyId, rootA!.id)).ok).toBe(true);
    const wakeup = vi.fn(async () => null);
    const withDeps = app({ type: "board", userId: "user-1", companyIds: [c.companyId], source: "session", isInstanceAdmin: false }, { wakeup });
    const res = await request(withDeps).patch(`/api/companies/${c.companyId}/pod-mutexes/${c.label.id}`).send({ holdingStatuses: ["in_progress"] });
    expect(res.status).toBe(200);
    expect(await db.select().from(podMutexLeases).where(eq(podMutexLeases.companyId, c.companyId))).toHaveLength(0);
    expect(wakeup).toHaveBeenCalledWith(agent!.id, expect.objectContaining({ reason: "pod_mutex_released", payload: expect.objectContaining({ issueId: rootB!.id }) }));
    const released = await db.select().from(activityLog)
      .where(and(eq(activityLog.companyId, c.companyId), eq(activityLog.action, "pod_mutex.released")));
    expect(released).toHaveLength(1);
  });

  it("force-release reports a holder that still has a running run", async () => {
    const c = await seedCompany();
    const svc = podMutexService(db);
    await svc.upsert(c.companyId, { labelId: c.label.id });
    const [agent] = await db.insert(agents).values({
      companyId: c.companyId, name: "Coder", role: "engineer", status: "active",
      adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {},
    }).returning();
    const [rootA] = await db.insert(issues).values({ companyId: c.companyId, identifier: `${c.prefix}-1`, title: "A", status: "in_progress" }).returning();
    const [child] = await db.insert(issues).values({ companyId: c.companyId, identifier: `${c.prefix}-2`, title: "A1", status: "in_progress", parentId: rootA!.id }).returning();
    await db.insert(issueLabels).values({ issueId: rootA!.id, labelId: c.label.id, companyId: c.companyId });
    expect((await svc.tryAcquire(c.companyId, child!.id)).ok).toBe(true);
    await db.insert(heartbeatRuns).values({
      companyId: c.companyId, agentId: agent!.id, status: "running", invocationSource: "automation",
      startedAt: new Date(), contextSnapshot: { issueId: child!.id },
    });
    const listed = await request(board([c.companyId])).get(`/api/companies/${c.companyId}/pod-mutexes`);
    expect(listed.body[0].holder).toMatchObject({ hasRunningRun: true });
    expect(listed.body[0].holder.lastRunActivityAt).toBeTruthy();
    const rel = await request(board([c.companyId])).post(`/api/companies/${c.companyId}/pod-mutexes/${c.label.id}/release`);
    expect(rel.body).toMatchObject({ released: true, held: true, holderHasRunningRun: true });
  });
});
