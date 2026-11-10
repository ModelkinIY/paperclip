import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  companies,
  createDb,
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

  function app(actor: Record<string, unknown>) {
    const a = express();
    a.use(express.json());
    a.use((req, _res, next) => {
      (req as any).actor = actor;
      next();
    });
    a.use("/api", podMutexRoutes(db));
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
    expect(rel.body).toEqual({ ok: true, released: false });

    const del = await request(a).delete(`${base}/${c.label.id}`);
    expect(del.status).toBe(200);
    expect((await request(a).delete(`${base}/${c.label.id}`)).status).toBe(404);

    const acts = await actions(c.companyId);
    expect(acts).toEqual(expect.arrayContaining([
      "pod_mutex.upserted", "pod_mutex.updated", "pod_mutex.force_released", "pod_mutex.deleted",
    ]));
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
    expect(rel.body).toEqual({ ok: true, released: true });
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

  // BUG: empty holdingStatuses passes validation (z.array without .min(1)) and
  // turns the mutex into a no-op (see pod-mutex-extended.test.ts).
  it.fails("rejects an empty holdingStatuses list", async () => {
    const c = await seedCompany();
    const a = board([c.companyId]);
    const res = await request(a).post(`/api/companies/${c.companyId}/pod-mutexes`).send({ labelId: c.label.id, holdingStatuses: [] });
    expect(res.status).toBe(400);
  });

  // BUG: :labelId path param is not validated as a UUID; a malformed id reaches
  // Postgres and the uuid cast error surfaces as 500 instead of 400/404.
  it.fails("a malformed :labelId yields 4xx, not 500", async () => {
    const c = await seedCompany();
    const a = board([c.companyId]);
    const base = `/api/companies/${c.companyId}/pod-mutexes`;
    const statuses = [
      (await request(a).patch(`${base}/nope`).send({ enabled: false })).status,
      (await request(a).delete(`${base}/nope`)).status,
      (await request(a).post(`${base}/nope/release`)).status,
    ];
    expect(statuses.every((s) => s >= 400 && s < 500)).toBe(true);
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
});
