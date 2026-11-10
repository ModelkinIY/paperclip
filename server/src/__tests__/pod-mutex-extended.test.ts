import { randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
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
import { normalizeHoldingStatuses, podMutexService } from "../services/pod-mutex.js";
import { issueService } from "../services/issues.ts";
import { attachPodMutexStates, enforcePodMutexOnIssueWrite } from "../services/pod-mutex-issue-guard.js";

const sqlToQuery = PgDialect.prototype.sqlToQuery;
const support = await getEmbeddedPostgresTestSupport();
const describeDb = support.supported ? describe : describe.skip;

describeDb("pod mutex service (extended)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-pod-mutex-ext-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seed(opts: { holdingStatuses?: string[]; configure?: boolean } = {}) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const prefix = `X${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    await db.insert(companies).values({ id: companyId, name: "Co", issuePrefix: prefix, requireBoardApprovalForNewAgents: false });
    await db.insert(agents).values({
      id: agentId, companyId, name: "Coder", role: "engineer", status: "active",
      adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {},
    });
    const [label] = await db.insert(labels).values({ companyId, name: "pod:igor-3090", color: "#000" }).returning();
    let n = 0;
    const issue = async (o: { parentId?: string; status?: string; priority?: string; createdAt?: Date; assignee?: string | null } = {}) => {
      n += 1;
      const [row] = await db.insert(issues).values({
        companyId, identifier: `${prefix}-${n}`, title: `Issue ${n}`,
        status: o.status ?? "todo", priority: o.priority ?? "medium",
        parentId: o.parentId ?? null, assigneeAgentId: o.assignee === undefined ? agentId : o.assignee,
        ...(o.createdAt ? { createdAt: o.createdAt } : {}),
      }).returning();
      return row!;
    };
    const tag = async (issueId: string, labelId = label!.id) => {
      await db.insert(issueLabels).values({ issueId, labelId, companyId });
    };
    const svc = podMutexService(db);
    if (opts.configure !== false) {
      await svc.upsert(companyId, { labelId: label!.id, ...(opts.holdingStatuses ? { holdingStatuses: opts.holdingStatuses } : {}) });
    }
    const leases = () => db.select().from(podMutexLeases).where(eq(podMutexLeases.companyId, companyId));
    const deps = () => ({ wakeup: vi.fn(async () => null), resumeQueuedRuns: vi.fn(async () => null) });
    return { companyId, agentId, label: label!, issue, tag, svc, leases, deps };
  }

  // ---- inheritance ----

  it("deep descendants (4 levels) inherit the root's mutex", async () => {
    const s = await seed();
    const root = await s.issue();
    await s.tag(root.id);
    let cur = root;
    for (let i = 0; i < 4; i += 1) cur = await s.issue({ parentId: cur.id });
    expect((await s.svc.resolveEffectiveMutex(s.companyId, cur.id))?.rootIssueId).toBe(root.id);
    const other = await s.issue();
    await s.tag(other.id);
    expect((await s.svc.tryAcquire(s.companyId, other.id)).ok).toBe(true);
    const gate = await s.svc.tryAcquire(s.companyId, cur.id);
    expect(gate.ok).toBe(false);
  });

  it("parallel siblings in the holder tree both pass and share one lease", async () => {
    const s = await seed();
    const root = await s.issue();
    await s.tag(root.id);
    const a = await s.issue({ parentId: root.id });
    const b = await s.issue({ parentId: root.id });
    const b1 = await s.issue({ parentId: b.id });
    const results = await Promise.all([a, b, b1].map((i) => s.svc.tryAcquire(s.companyId, i.id)));
    expect(results.every((r) => r.ok)).toBe(true);
    const ls = await s.leases();
    expect(ls).toHaveLength(1);
    expect(ls[0]!.holderRootIssueId).toBe(root.id);
  });

  it("nearest label wins when two mutex labels are in the chain", async () => {
    const s = await seed();
    const [label2] = await db.insert(labels).values({ companyId: s.companyId, name: "pod:other", color: "#111" }).returning();
    await s.svc.upsert(s.companyId, { labelId: label2!.id });
    const root = await s.issue();
    await s.tag(root.id);
    const mid = await s.issue({ parentId: root.id });
    await s.tag(mid.id, label2!.id);
    const leaf = await s.issue({ parentId: mid.id });
    const m = await s.svc.resolveEffectiveMutex(s.companyId, leaf.id);
    expect(m).toMatchObject({ labelId: label2!.id, rootIssueId: mid.id });
    expect((await s.svc.resolveEffectiveMutex(s.companyId, root.id))?.labelId).toBe(s.label.id);
  });

  it("a three-node parent cycle terminates for resolve, treeHolds, tryAcquire and listWaiters", async () => {
    const s = await seed();
    const a = await s.issue();
    const b = await s.issue({ parentId: a.id });
    const c = await s.issue({ parentId: b.id });
    await db.update(issues).set({ parentId: c.id }).where(eq(issues.id, a.id));
    await s.tag(a.id);
    expect((await s.svc.resolveEffectiveMutex(s.companyId, c.id))?.rootIssueId).toBe(a.id);
    expect(await s.svc.treeHolds(s.companyId, a.id, ["todo"])).toBe(true);
    expect((await s.svc.tryAcquire(s.companyId, b.id)).ok).toBe(true);
    const waiters = await s.svc.listWaiters(s.companyId, s.label.id);
    expect(new Set(waiters.map((w) => w.issueId))).toEqual(new Set([a.id, b.id, c.id]));
    await s.svc.sweep(s.deps(), { companyId: s.companyId });
  }, 20_000);

  // ---- holding statuses ----

  it("default holding statuses are todo + in_progress", async () => {
    const s = await seed();
    const [cfg] = await db.select().from(podMutexLabels).where(eq(podMutexLabels.companyId, s.companyId));
    expect(cfg!.holdingStatuses).toEqual(["todo", "in_progress"]);
    const root = await s.issue({ status: "blocked" });
    expect(await s.svc.treeHolds(s.companyId, root.id, cfg!.holdingStatuses)).toBe(false);
    await db.update(issues).set({ status: "in_progress" }).where(eq(issues.id, root.id));
    expect(await s.svc.treeHolds(s.companyId, root.id, cfg!.holdingStatuses)).toBe(true);
  });

  it("custom holding statuses (blocked) keep the lease while the holder is blocked", async () => {
    const s = await seed({ holdingStatuses: ["todo", "in_progress", "blocked"] });
    const rootA = await s.issue();
    await s.tag(rootA.id);
    const rootB = await s.issue();
    await s.tag(rootB.id);
    expect((await s.svc.tryAcquire(s.companyId, rootA.id)).ok).toBe(true);
    await db.update(issues).set({ status: "blocked" }).where(eq(issues.id, rootA.id));
    expect((await s.svc.tryAcquire(s.companyId, rootB.id)).ok).toBe(false);
    expect((await s.svc.sweep(s.deps(), { companyId: s.companyId })).released).toBe(0);
    await db.update(issues).set({ status: "in_review" }).where(eq(issues.id, rootA.id));
    expect((await s.svc.sweep(s.deps(), { companyId: s.companyId })).released).toBe(1);
  });

  it("empty holding statuses fall back to the default (never a silent no-op)", async () => {
    const s = await seed();
    expect(normalizeHoldingStatuses([])).toEqual(["todo", "in_progress"]);
    const row = await s.svc.upsert(s.companyId, { labelId: s.label.id, holdingStatuses: [] });
    expect(row!.holdingStatuses).toEqual(["todo", "in_progress"]);
  });

  it("a mutex seeded with [] still excludes the other tree", async () => {
    const s = await seed({ holdingStatuses: [] });
    const rootA = await s.issue({ status: "in_progress" });
    await s.tag(rootA.id);
    const rootB = await s.issue({ status: "in_progress" });
    await s.tag(rootB.id);
    expect((await s.svc.tryAcquire(s.companyId, rootA.id)).ok).toBe(true);
    expect((await s.svc.tryAcquire(s.companyId, rootB.id)).ok).toBe(false);
    expect((await s.leases())[0]!.holderRootIssueId).toBe(rootA.id);
  });

  // ---- release paths ----

  it("holder tree all done / in_review is released by the sweep", async () => {
    const s = await seed();
    const root = await s.issue({ status: "in_progress" });
    await s.tag(root.id);
    const c1 = await s.issue({ parentId: root.id, status: "in_progress" });
    const c2 = await s.issue({ parentId: c1.id, status: "todo" });
    expect((await s.svc.tryAcquire(s.companyId, c2.id)).ok).toBe(true);
    await db.update(issues).set({ status: "done" }).where(inArray(issues.id, [root.id, c1.id]));
    expect((await s.svc.sweep(s.deps(), { companyId: s.companyId })).released).toBe(0); // grandchild still todo
    await db.update(issues).set({ status: "in_review" }).where(eq(issues.id, c2.id));
    expect((await s.svc.sweep(s.deps(), { companyId: s.companyId })).released).toBe(1);
    expect(await s.leases()).toHaveLength(0);
  });

  it("a cancelled holder root holds nothing even with active children", async () => {
    const s = await seed();
    const root = await s.issue();
    await s.tag(root.id);
    await s.issue({ parentId: root.id, status: "in_progress" });
    expect((await s.svc.tryAcquire(s.companyId, root.id)).ok).toBe(true);
    await db.update(issues).set({ status: "cancelled" }).where(eq(issues.id, root.id));
    expect((await s.svc.sweep(s.deps(), { companyId: s.companyId })).released).toBe(1);
  });

  it("a hidden holder root holds nothing", async () => {
    const s = await seed();
    const root = await s.issue();
    await s.tag(root.id);
    expect((await s.svc.tryAcquire(s.companyId, root.id)).ok).toBe(true);
    await db.update(issues).set({ hiddenAt: new Date() }).where(eq(issues.id, root.id));
    expect((await s.svc.sweep(s.deps(), { companyId: s.companyId })).released).toBe(1);
  });

  it("deleting the holder root drops the lease (FK cascade)", async () => {
    const s = await seed();
    const root = await s.issue();
    await s.tag(root.id);
    expect((await s.svc.tryAcquire(s.companyId, root.id)).ok).toBe(true);
    await db.delete(issueLabels).where(eq(issueLabels.issueId, root.id));
    await db.delete(issues).where(eq(issues.id, root.id));
    expect(await s.leases()).toHaveLength(0);
  });

  it("removing the label from the holder root releases the lease", async () => {
    const s = await seed();
    const rootA = await s.issue();
    await s.tag(rootA.id);
    const rootB = await s.issue();
    await s.tag(rootB.id);
    expect((await s.svc.tryAcquire(s.companyId, rootA.id)).ok).toBe(true);
    await db.delete(issueLabels).where(and(eq(issueLabels.issueId, rootA.id), eq(issueLabels.labelId, s.label.id)));
    expect((await s.svc.tryAcquire(s.companyId, rootB.id)).ok).toBe(true);
  });

  it("deleting the label drops config and lease (FK cascade); gates become inert", async () => {
    const s = await seed();
    const rootA = await s.issue();
    await s.tag(rootA.id);
    const rootB = await s.issue();
    await s.tag(rootB.id);
    expect((await s.svc.tryAcquire(s.companyId, rootA.id)).ok).toBe(true);
    await db.delete(labels).where(eq(labels.id, s.label.id));
    expect(await s.leases()).toHaveLength(0);
    expect(await s.svc.hasEnabled(s.companyId)).toBe(false);
    expect(await s.svc.tryAcquire(s.companyId, rootB.id)).toEqual({ ok: true, mutex: null });
  });

  it("disabling the mutex while held lets other trees pass; the sweep drops the disabled lease", async () => {
    const s = await seed();
    const rootA = await s.issue();
    await s.tag(rootA.id);
    const rootB = await s.issue();
    await s.tag(rootB.id);
    expect((await s.svc.tryAcquire(s.companyId, rootA.id)).ok).toBe(true);
    await s.svc.upsert(s.companyId, { labelId: s.label.id, enabled: false });
    expect(await s.svc.tryAcquire(s.companyId, rootB.id)).toEqual({ ok: true, mutex: null });
    expect((await s.svc.sweep(s.deps(), { companyId: s.companyId })).released).toBe(1);
    expect(await s.leases()).toHaveLength(0);
    await s.svc.upsert(s.companyId, { labelId: s.label.id, enabled: true });
    // free again: the first gate after re-enable wins
    expect((await s.svc.tryAcquire(s.companyId, rootB.id)).ok).toBe(true);
    expect((await s.svc.tryAcquire(s.companyId, rootA.id)).ok).toBe(false);
  });

  it("removing the label from the holder root lets the sweep release and wake the waiter", async () => {
    const s = await seed();
    const rootA = await s.issue({ status: "in_progress" });
    await s.tag(rootA.id);
    const rootB = await s.issue();
    await s.tag(rootB.id);
    expect((await s.svc.tryAcquire(s.companyId, rootA.id)).ok).toBe(true);
    await db.delete(issueLabels).where(and(eq(issueLabels.issueId, rootA.id), eq(issueLabels.labelId, s.label.id)));
    const d = s.deps();
    expect((await s.svc.sweep(d, { companyId: s.companyId })).released).toBe(1);
    expect(d.wakeup).toHaveBeenCalledTimes(1);
  });

  it("forceRelease drops the lease and the next gate grants the other tree", async () => {
    const s = await seed();
    const rootA = await s.issue();
    await s.tag(rootA.id);
    const rootB = await s.issue();
    await s.tag(rootB.id);
    expect((await s.svc.tryAcquire(s.companyId, rootA.id)).ok).toBe(true);
    const released = await s.svc.forceRelease(s.companyId, s.label.id);
    expect(released?.holderRootIssueId).toBe(rootA.id);
    expect(await s.svc.forceRelease(s.companyId, s.label.id)).toBeNull();
    expect((await s.svc.tryAcquire(s.companyId, rootB.id)).ok).toBe(true);
    expect((await s.leases())[0]!.holderRootIssueId).toBe(rootB.id);
  });

  it("remove() deletes config and lease, scoped to the company", async () => {
    const s = await seed();
    const other = await seed();
    const root = await s.issue();
    await s.tag(root.id);
    expect((await s.svc.tryAcquire(s.companyId, root.id)).ok).toBe(true);
    expect(await s.svc.remove(other.companyId, s.label.id)).toBe(false);
    expect(await s.leases()).toHaveLength(1);
    expect(await s.svc.forceRelease(other.companyId, s.label.id)).toBeNull();
    expect(await s.svc.remove(s.companyId, s.label.id)).toBe(true);
    expect(await s.leases()).toHaveLength(0);
  });

  it("upsert refuses a label of another company", async () => {
    const s = await seed();
    const other = await seed({ configure: false });
    expect(await s.svc.upsert(s.companyId, { labelId: other.label.id })).toBeNull();
    expect(await s.svc.upsert(s.companyId, { labelName: "  pod:new  " })).toMatchObject({ enabled: true });
    const [created] = await db.select().from(labels).where(and(eq(labels.companyId, s.companyId), eq(labels.name, "pod:new")));
    expect(created).toBeTruthy();
  });

  // ---- wake next ----

  it("wakes waiters by priority, then age; holder-tree todo issues are not woken", async () => {
    const s = await seed({ holdingStatuses: ["in_progress"] });
    const holder = await s.issue({ status: "in_progress" });
    await s.tag(holder.id);
    expect((await s.svc.tryAcquire(s.companyId, holder.id)).ok).toBe(true);
    const mk = async (priority: string, at: string) => {
      const r = await s.issue({ priority, createdAt: new Date(at) });
      await s.tag(r.id);
      return r;
    };
    await mk("medium", "2026-01-01");
    const highOld = await mk("high", "2026-02-01");
    await mk("high", "2026-03-01");
    await db.update(issues).set({ status: "done" }).where(eq(issues.id, holder.id));
    const d = s.deps();
    await s.svc.sweep(d, { companyId: s.companyId });
    expect(d.wakeup).toHaveBeenCalledTimes(1);
    expect((d.wakeup.mock.calls[0] as unknown as [string, any])[1]).toMatchObject({
      reason: "pod_mutex_released",
      payload: { issueId: highOld.id },
      contextSnapshot: { issueId: highOld.id },
    });
  });

  it("a todo-only waiter is woken exactly once (on release), not every tick", async () => {
    const s = await seed();
    const holder = await s.issue();
    await s.tag(holder.id);
    expect((await s.svc.tryAcquire(s.companyId, holder.id)).ok).toBe(true);
    const waiter = await s.issue();
    await s.tag(waiter.id);
    const d = s.deps();
    await s.svc.sweep(d, { companyId: s.companyId }); // still held
    await db.update(issues).set({ status: "done" }).where(eq(issues.id, holder.id));
    await s.svc.sweep(d, { companyId: s.companyId }); // release + wake
    await s.svc.sweep(d, { companyId: s.companyId }); // free, no wake
    await s.svc.sweep(d, { companyId: s.companyId });
    expect(d.wakeup).toHaveBeenCalledTimes(1);
    expect(d.resumeQueuedRuns).not.toHaveBeenCalled();
  });

  it("a queued-run waiter is re-dispatched on release (resumeQueuedRuns, not wakeup)", async () => {
    const s = await seed();
    const holder = await s.issue();
    await s.tag(holder.id);
    expect((await s.svc.tryAcquire(s.companyId, holder.id)).ok).toBe(true);
    const waiter = await s.issue({ status: "backlog", priority: "low" });
    await s.tag(waiter.id);
    await db.insert(heartbeatRuns).values({
      companyId: s.companyId, agentId: s.agentId, status: "queued", invocationSource: "automation",
      contextSnapshot: { issueId: waiter.id },
    });
    const d = s.deps();
    await s.svc.sweep(d, { companyId: s.companyId });
    expect(d.resumeQueuedRuns).not.toHaveBeenCalled(); // still held
    await db.update(issues).set({ status: "done" }).where(eq(issues.id, holder.id));
    await s.svc.sweep(d, { companyId: s.companyId });
    expect(d.resumeQueuedRuns).toHaveBeenCalledWith({ companyId: s.companyId });
    expect(d.wakeup).not.toHaveBeenCalled();
  });

  it("no wake when nothing waits", async () => {
    const s = await seed();
    const holder = await s.issue();
    await s.tag(holder.id);
    expect((await s.svc.tryAcquire(s.companyId, holder.id)).ok).toBe(true);
    await s.issue(); // unlabelled todo: not a waiter
    const unassigned = await s.issue({ assignee: null });
    await s.tag(unassigned.id); // todo without assignee: not a waiter
    await db.update(issues).set({ status: "done" }).where(eq(issues.id, holder.id));
    const d = s.deps();
    expect((await s.svc.sweep(d, { companyId: s.companyId })).released).toBe(1);
    expect(d.wakeup).not.toHaveBeenCalled();
    expect(d.resumeQueuedRuns).not.toHaveBeenCalled();
  });

  it("sweep errors in one company do not stop the others", async () => {
    const s = await seed();
    const root = await s.issue();
    await s.tag(root.id);
    await s.svc.tryAcquire(s.companyId, root.id);
    await db.update(issues).set({ status: "done" }).where(eq(issues.id, root.id));
    const waiter = await s.issue();
    await s.tag(waiter.id);
    const d = { wakeup: vi.fn(async () => { throw new Error("boom"); }) };
    await expect(s.svc.sweep(d, { companyId: s.companyId })).resolves.toEqual({ released: 1 });
  });

  // ---- checkout ----

  it("checkout 409 payload carries reason, label, holder; holder-tree checkout succeeds", async () => {
    const s = await seed();
    const rootA = await s.issue();
    await s.tag(rootA.id);
    const childA = await s.issue({ parentId: rootA.id });
    const rootB = await s.issue();
    await s.tag(rootB.id);
    const childB = await s.issue({ parentId: rootB.id });
    const issuesSvc = issueService(db);
    const checked = await issuesSvc.checkout(childA.id, s.agentId, ["todo"], null);
    expect(checked?.status).toBe("in_progress");
    await expect(issuesSvc.checkout(rootA.id, s.agentId, ["todo"], null)).resolves.toBeTruthy();
    const err = await issuesSvc.checkout(childB.id, s.agentId, ["todo"], null).then(() => null, (e) => e);
    expect(err).toMatchObject({
      status: 409,
      details: {
        issueId: childB.id,
        reason: "pod_mutex_held",
        labelId: s.label.id,
        labelName: "pod:igor-3090",
        holderRootIssueId: rootA.id,
        holderIdentifier: rootA.identifier,
      },
    });
    expect(String(err.message)).toContain("pod:igor-3090");
  });

  // ---- inert ----

  it("inert: no configured labels -> tryAcquire runs a single config lookup", async () => {
    const s = await seed({ configure: false });
    const root = await s.issue();
    await s.tag(root.id);
    const selectSpy = vi.spyOn(db, "select");
    const executeSpy = vi.spyOn(db, "execute");
    const insertSpy = vi.spyOn(db, "insert");
    expect(await s.svc.tryAcquire(s.companyId, root.id)).toEqual({ ok: true, mutex: null });
    expect(selectSpy).toHaveBeenCalledTimes(1);
    expect(executeSpy).not.toHaveBeenCalled();
    expect(insertSpy).not.toHaveBeenCalled();
    selectSpy.mockRestore();
    executeSpy.mockRestore();
    insertSpy.mockRestore();
    const issuesSvc = issueService(db);
    await expect(issuesSvc.checkout(root.id, s.agentId, ["todo"], null)).resolves.toBeTruthy();
  });

  it("inert: no configured labels -> create/update guard, checkout and list issue one config lookup each, no ancestor CTE", async () => {
    const s = await seed({ configure: false });
    const root = await s.issue();
    await s.tag(root.id);
    const child = await s.issue({ parentId: root.id });
    const queries: string[] = [];
    const spy = vi.spyOn(PgDialect.prototype, "sqlToQuery").mockImplementation(function (this: PgDialect, ...args) {
      const out = sqlToQuery.apply(this, args);
      queries.push(out.sql);
      return out;
    });
    const podQueries = () => queries.filter((q) => /pod_mutex|WITH RECURSIVE chain|issue_labels/.test(q));
    const actor = { kind: "agent" as const, actorType: "agent" as const, actorId: s.agentId, agentId: s.agentId };
    const loader = vi.fn(async () => ({
      before: { status: "todo", parentId: null, labelIds: [s.label.id] },
      after: { status: "in_progress", parentId: null, labelIds: [s.label.id] },
    }));
    try {
      // create
      await expect(enforcePodMutexOnIssueWrite(db, actor, {
        companyId: s.companyId, issueId: null, before: null,
        after: { status: "in_progress", parentId: root.id, labelIds: [s.label.id] },
      })).resolves.toBeNull();
      expect(podQueries()).toHaveLength(1);
      expect(podQueries()[0]).toContain("pod_mutex_labels");
      // update (issue labels are loaded lazily, never without config)
      queries.length = 0;
      await expect(enforcePodMutexOnIssueWrite(db, actor, { companyId: s.companyId, issueId: child.id, load: loader })).resolves.toBeNull();
      expect(loader).not.toHaveBeenCalled();
      expect(podQueries()).toHaveLength(1);
      // checkout
      queries.length = 0;
      const issuesSvc = issueService(db);
      await expect(issuesSvc.checkout(child.id, s.agentId, ["todo"], null)).resolves.toBeTruthy();
      expect(podQueries().filter((q) => /pod_mutex|WITH RECURSIVE chain/.test(q))).toHaveLength(1);
      // list
      queries.length = 0;
      const rows = await issuesSvc.list(s.companyId);
      expect(rows.length).toBeGreaterThanOrEqual(2);
      expect(rows.every((r) => !("podMutex" in r))).toBe(true);
      expect(queries.filter((q) => /pod_mutex|WITH RECURSIVE chain/.test(q))).toHaveLength(1);
    } finally {
      spy.mockRestore();
    }
    expect(await s.leases()).toHaveLength(0);
  });

  // ---- concurrency ----

  it("two trees racing tryAcquire: exactly one lease, the other blocked, no error", async () => {
    for (let round = 0; round < 5; round += 1) {
      const s = await seed();
      const rootA = await s.issue();
      await s.tag(rootA.id);
      const rootB = await s.issue();
      await s.tag(rootB.id);
      const results = await Promise.all([
        s.svc.tryAcquire(s.companyId, rootA.id),
        s.svc.tryAcquire(s.companyId, rootB.id),
      ]);
      expect(results.filter((r) => r.ok)).toHaveLength(1);
      expect(results.filter((r) => !r.ok)).toHaveLength(1);
      const ls = await s.leases();
      expect(ls).toHaveLength(1);
      const winner = results[0]!.ok ? rootA.id : rootB.id;
      expect(ls[0]!.holderRootIssueId).toBe(winner);
    }
  });

  it("two concurrent checkouts of different trees: one succeeds, the other 409", async () => {
    const s = await seed();
    const rootA = await s.issue();
    await s.tag(rootA.id);
    const rootB = await s.issue();
    await s.tag(rootB.id);
    const issuesSvc = issueService(db);
    const settled = await Promise.allSettled([
      issuesSvc.checkout(rootA.id, s.agentId, ["todo"], null),
      issuesSvc.checkout(rootB.id, s.agentId, ["todo"], null),
    ]);
    expect(settled.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = settled.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!.reason).toMatchObject({ status: 409, details: { reason: "pod_mutex_held" } });
    expect(await s.leases()).toHaveLength(1);
  });
  // ---- same label nested inside a holder tree (no deadlock) ----

  it("same label nested in a tree uses the farthest same-label ancestor as root", async () => {
    const s = await seed();
    const root = await s.issue({ status: "in_progress" });
    await s.tag(root.id);
    const sub = await s.issue({ parentId: root.id });
    await s.tag(sub.id); // re-tagged with the same label
    const leaf = await s.issue({ parentId: sub.id });
    expect((await s.svc.resolveEffectiveMutex(s.companyId, sub.id))?.rootIssueId).toBe(root.id);
    expect((await s.svc.resolveEffectiveMutex(s.companyId, leaf.id))?.rootIssueId).toBe(root.id);
    expect((await s.svc.tryAcquire(s.companyId, root.id)).ok).toBe(true);
    expect((await s.svc.tryAcquire(s.companyId, leaf.id)).ok).toBe(true);
    expect((await s.svc.tryAcquire(s.companyId, sub.id)).ok).toBe(true);
    expect(await s.leases()).toHaveLength(1);
    // listWaiters applies the same rule: the nested sub-tree is the holder tree, not a waiter
    const waiters = await s.svc.listWaiters(s.companyId, s.label.id);
    expect(new Set(waiters.map((w) => w.rootIssueId))).toEqual(new Set([root.id]));
  });

  it("a different label nested between same labels cuts the farthest-root walk", async () => {
    const s = await seed();
    const [other] = await db.insert(labels).values({ companyId: s.companyId, name: "pod:other", color: "#111" }).returning();
    await s.svc.upsert(s.companyId, { labelId: other!.id });
    const top = await s.issue();
    await s.tag(top.id);
    const mid = await s.issue({ parentId: top.id });
    await s.tag(mid.id, other!.id);
    const low = await s.issue({ parentId: mid.id });
    await s.tag(low.id);
    expect(await s.svc.resolveEffectiveMutex(s.companyId, low.id)).toMatchObject({ labelId: s.label.id, rootIssueId: low.id });
  });

  // ---- activity trail ----

  it("lease acquired / released (auto) are in the activity log", async () => {
    const s = await seed();
    const root = await s.issue();
    await s.tag(root.id);
    expect((await s.svc.tryAcquire(s.companyId, root.id, { actor: { actorType: "agent", actorId: s.agentId, agentId: s.agentId } })).ok).toBe(true);
    await db.update(issues).set({ status: "done" }).where(eq(issues.id, root.id));
    await s.svc.sweep(s.deps(), { companyId: s.companyId });
    const rows = await db.select().from(activityLog).where(eq(activityLog.companyId, s.companyId));
    const acquired = rows.find((r) => r.action === "pod_mutex.acquired");
    const released = rows.find((r) => r.action === "pod_mutex.released");
    expect(acquired).toMatchObject({ entityType: "label", entityId: s.label.id, actorType: "agent", agentId: s.agentId });
    expect(acquired!.details).toMatchObject({ holderRootIssueId: root.id });
    expect(released!.details).toMatchObject({ holderRootIssueId: root.id, reason: "holder_tree_idle", manual: false });
  });

  // ---- lease leak ----

  it("checkout that does not match drops the lease it took (no leak)", async () => {
    const s = await seed();
    const root = await s.issue();
    await s.tag(root.id);
    const issuesSvc = issueService(db);
    await issuesSvc.checkout(root.id, s.agentId, ["backlog"], null).catch(() => null);
    expect(await s.leases()).toHaveLength(0);
  });

  it("releaseAcquired only drops the lease the call inserted", async () => {
    const s = await seed();
    const rootA = await s.issue();
    await s.tag(rootA.id);
    const gate = await s.svc.tryAcquire(s.companyId, rootA.id);
    expect(gate.ok && gate.acquiredLeaseId).toBeTruthy();
    const again = await s.svc.tryAcquire(s.companyId, rootA.id);
    expect(again.ok && again.acquiredLeaseId).toBeFalsy();
    expect(await s.svc.releaseAcquired(s.companyId, again, "test")).toBe(false);
    expect(await s.leases()).toHaveLength(1);
    expect(await s.svc.releaseAcquired(s.companyId, gate, "test")).toBe(true);
    expect(await s.leases()).toHaveLength(0);
    // a stale handle never drops a newer lease of the same tree
    const fresh = await s.svc.tryAcquire(s.companyId, rootA.id);
    expect(fresh.ok).toBe(true);
    expect(await s.svc.releaseAcquired(s.companyId, gate, "test")).toBe(false);
    expect(await s.leases()).toHaveLength(1);
  });

  // ---- issue writes ----

  it("issue write: agent status move into holding -> 409, board override -> activity, tree change -> warning", async () => {
    const s = await seed();
    const rootA = await s.issue({ status: "in_progress" });
    await s.tag(rootA.id);
    const rootB = await s.issue({ status: "backlog" });
    await s.tag(rootB.id);
    expect((await s.svc.tryAcquire(s.companyId, rootA.id)).ok).toBe(true);
    const agentActor = { kind: "agent" as const, actorType: "agent" as const, actorId: s.agentId, agentId: s.agentId };
    const boardActor = { kind: "board" as const, actorType: "user" as const, actorId: "user-1" };
    const move = {
      companyId: s.companyId, issueId: rootB.id,
      before: { status: "backlog", parentId: null, labelIds: [s.label.id] },
      after: { status: "todo", parentId: null, labelIds: [s.label.id] },
    };
    const err = await enforcePodMutexOnIssueWrite(db, agentActor, move).then(() => null, (e) => e);
    expect(err).toMatchObject({
      status: 409,
      details: { issueId: rootB.id, reason: "pod_mutex_held", labelId: s.label.id, holderRootIssueId: rootA.id, holderIdentifier: rootA.identifier },
    });
    await expect(enforcePodMutexOnIssueWrite(db, boardActor, move)).resolves.toMatchObject({ cause: "status" });
    // create in todo with the held label
    const create = { companyId: s.companyId, issueId: null, before: null, after: { status: "todo", parentId: null, labelIds: [s.label.id] } };
    await expect(enforcePodMutexOnIssueWrite(db, agentActor, create)).rejects.toMatchObject({ status: 409 });
    // create under the holder tree is fine; backlog is not a holding status
    await expect(enforcePodMutexOnIssueWrite(db, agentActor, { ...create, after: { status: "todo", parentId: rootA.id, labelIds: [] } })).resolves.toBeNull();
    await expect(enforcePodMutexOnIssueWrite(db, agentActor, { ...create, after: { status: "backlog", parentId: null, labelIds: [s.label.id] } })).resolves.toBeNull();
    // running unlabelled issue gets re-parented under the waiting tree: warning, not refused
    const loose = await s.issue({ status: "in_progress" });
    await expect(enforcePodMutexOnIssueWrite(db, agentActor, {
      companyId: s.companyId, issueId: loose.id,
      before: { status: "in_progress", parentId: null, labelIds: [] },
      after: { status: "in_progress", parentId: rootB.id, labelIds: [] },
    })).resolves.toMatchObject({ cause: "tree" });
    const acts = (await db.select().from(activityLog).where(eq(activityLog.companyId, s.companyId))).map((r) => r.action);
    expect(acts).toEqual(expect.arrayContaining(["pod_mutex.conflict_override", "pod_mutex.conflict_warning"]));
    // no conflict once the holder is done
    await db.update(issues).set({ status: "done" }).where(eq(issues.id, rootA.id));
    await expect(enforcePodMutexOnIssueWrite(db, agentActor, move)).resolves.toBeNull();
  });

  // ---- issue presentation ----

  it("issue states: holder / waiting, blocked waiter gets waiting_on_resource", async () => {
    const s = await seed();
    const rootA = await s.issue({ status: "in_progress" });
    await s.tag(rootA.id);
    const childA = await s.issue({ parentId: rootA.id });
    const rootB = await s.issue({ status: "blocked" });
    await s.tag(rootB.id);
    const plain = await s.issue();
    expect((await s.svc.tryAcquire(s.companyId, childA.id)).ok).toBe(true);
    const rows = await attachPodMutexStates(db, s.companyId, [childA, rootB, plain].map((i) => ({ id: i.id, status: i.status })));
    expect(rows[0]).toMatchObject({ podMutex: { role: "holder", labelName: "pod:igor-3090", rootIssueId: rootA.id } });
    expect(rows[1]).toMatchObject({
      podMutex: { role: "waiting", holderRootIssueId: rootA.id, holderIdentifier: rootA.identifier },
      blockerAttention: { state: "covered", reason: "waiting_on_resource", resource: { labelName: "pod:igor-3090", holderIdentifier: rootA.identifier } },
    });
    expect(rows[2]).not.toHaveProperty("podMutex");
    // list() of the issue service carries the same field
    const listed = await issueService(db).list(s.companyId);
    expect(listed.find((r) => r.id === rootB.id)).toMatchObject({ podMutex: { role: "waiting" } });
  });
  // ---- review fixes ----

  async function secondLabel(s: Awaited<ReturnType<typeof seed>>) {
    const [m] = await db.insert(labels).values({ companyId: s.companyId, name: "pod:other", color: "#111" }).returning();
    await s.svc.upsert(s.companyId, { labelId: m!.id });
    return m!;
  }

  it("a different label cuts the holder tree: R(L)->X(M)->C(L)->G, G does not keep R holding (no self-deadlock)", async () => {
    const s = await seed();
    const m = await secondLabel(s);
    const r = await s.issue({ status: "done" });
    await s.tag(r.id);
    const xi = await s.issue({ parentId: r.id, status: "done" });
    await s.tag(xi.id, m.id);
    const c = await s.issue({ parentId: xi.id, status: "done" });
    await s.tag(c.id);
    const g = await s.issue({ parentId: c.id, status: "todo" });
    expect(await s.svc.resolveEffectiveMutex(s.companyId, g.id)).toMatchObject({ labelId: s.label.id, rootIssueId: c.id });
    // R's lease from earlier work; only G (C's tree) is active now
    await db.insert(podMutexLeases).values({ companyId: s.companyId, labelId: s.label.id, holderRootIssueId: r.id });
    expect(await s.svc.treeHolds(s.companyId, r.id, ["todo", "in_progress"], s.label.id)).toBe(false);
    expect(await s.svc.treeHolds(s.companyId, c.id, ["todo", "in_progress"], s.label.id)).toBe(true);
    // the waiter computation agrees: G waits as C's tree, never as R's
    const waiters = await s.svc.listWaiters(s.companyId, s.label.id);
    expect(waiters.map((w) => [w.issueId, w.rootIssueId])).toEqual([[g.id, c.id]]);
    const gate = await s.svc.tryAcquire(s.companyId, g.id);
    expect(gate.ok).toBe(true);
    expect((await s.leases())[0]!.holderRootIssueId).toBe(c.id);
  });

  it("no cross-deadlock between two labels nested in each other's trees", async () => {
    const s = await seed();
    const m = await secondLabel(s);
    // tree A: R(L) -> X(M) ; tree B: S(M) -> Y(L); roots idle, only X and Y want work
    const r = await s.issue({ status: "done" });
    await s.tag(r.id);
    const xi = await s.issue({ parentId: r.id, status: "todo" });
    await s.tag(xi.id, m.id);
    const sRoot = await s.issue({ status: "done" });
    await s.tag(sRoot.id, m.id);
    const y = await s.issue({ parentId: sRoot.id, status: "todo" });
    await s.tag(y.id);
    await db.insert(podMutexLeases).values([
      { companyId: s.companyId, labelId: s.label.id, holderRootIssueId: r.id },
      { companyId: s.companyId, labelId: m.id, holderRootIssueId: sRoot.id },
    ]);
    expect((await s.svc.tryAcquire(s.companyId, xi.id)).ok).toBe(true);
    expect((await s.svc.tryAcquire(s.companyId, y.id)).ok).toBe(true);
    const byLabel = new Map((await s.leases()).map((l) => [l.labelId, l.holderRootIssueId]));
    expect(byLabel.get(m.id)).toBe(xi.id);
    expect(byLabel.get(s.label.id)).toBe(y.id);
  });

  it("label added to an ancestor of the holder root: the lease moves to the new root instead of blocking its own tree", async () => {
    const s = await seed();
    const p = await s.issue({ status: "todo" });
    const h = await s.issue({ parentId: p.id, status: "in_progress" });
    await s.tag(h.id);
    expect((await s.svc.tryAcquire(s.companyId, h.id)).ok).toBe(true);
    const sibling = await s.issue({ parentId: p.id, status: "todo" });
    await s.tag(p.id); // the tree root moves up to P
    expect(await s.svc.heldByOther(s.companyId, (await s.svc.resolveEffectiveMutex(s.companyId, sibling.id))!)).toBeNull();
    const states = await s.svc.issueStates(s.companyId, [sibling.id]);
    expect(states.get(sibling.id)?.role).toBe("holder");
    expect((await s.svc.tryAcquire(s.companyId, sibling.id)).ok).toBe(true);
    const ls = await s.leases();
    expect(ls).toHaveLength(1);
    expect(ls[0]!.holderRootIssueId).toBe(p.id);
    const moved = await db.select().from(activityLog)
      .where(and(eq(activityLog.companyId, s.companyId), eq(activityLog.action, "pod_mutex.holder_moved")));
    expect(moved).toHaveLength(1);
    expect(moved[0]!.details).toMatchObject({ fromHolderRootIssueId: h.id, holderRootIssueId: p.id });
    // another tree is still blocked by the (moved) holder
    const other = await s.issue();
    await s.tag(other.id);
    expect((await s.svc.tryAcquire(s.companyId, other.id)).ok).toBe(false);
  });

  it("holder root re-parented under a same-label tree: that tree's issues pass and the lease follows", async () => {
    const s = await seed();
    const h = await s.issue({ status: "in_progress" });
    await s.tag(h.id);
    expect((await s.svc.tryAcquire(s.companyId, h.id)).ok).toBe(true);
    const p = await s.issue({ status: "todo" });
    await s.tag(p.id);
    await db.update(issues).set({ parentId: p.id }).where(eq(issues.id, h.id));
    expect((await s.svc.tryAcquire(s.companyId, p.id)).ok).toBe(true);
    expect((await s.leases())[0]!.holderRootIssueId).toBe(p.id);
  });

  it("force-release wakes a todo waiter exactly once on the next sweep", async () => {
    const s = await seed();
    const holder = await s.issue({ status: "in_progress" });
    await s.tag(holder.id);
    expect((await s.svc.tryAcquire(s.companyId, holder.id)).ok).toBe(true);
    const waiter = await s.issue();
    await s.tag(waiter.id);
    const d = s.deps();
    await s.svc.sweep(d, { companyId: s.companyId }); // held: nothing
    expect(d.wakeup).not.toHaveBeenCalled();
    expect(await s.svc.forceRelease(s.companyId, s.label.id)).toBeTruthy();
    await s.svc.sweep(d, { companyId: s.companyId });
    await s.svc.sweep(d, { companyId: s.companyId });
    await s.svc.sweep(d, { companyId: s.companyId });
    expect(d.wakeup).toHaveBeenCalledTimes(1);
    expect((d.wakeup.mock.calls[0] as unknown as [string, any])[1]).toMatchObject({ payload: { issueId: waiter.id } });
  });

  it("delete and disable while held wake a todo waiter once", async () => {
    for (const how of ["delete", "disable"] as const) {
      const s = await seed();
      const holder = await s.issue({ status: "in_progress" });
      await s.tag(holder.id);
      expect((await s.svc.tryAcquire(s.companyId, holder.id)).ok).toBe(true);
      const waiter = await s.issue();
      await s.tag(waiter.id);
      if (how === "delete") expect(await s.svc.remove(s.companyId, s.label.id)).toBe(true);
      else await s.svc.upsert(s.companyId, { labelId: s.label.id, enabled: false });
      const d = s.deps();
      await s.svc.sweep(d, { companyId: s.companyId });
      await s.svc.sweep(d, { companyId: s.companyId });
      expect(d.wakeup, how).toHaveBeenCalledTimes(1);
      expect((d.wakeup.mock.calls[0] as unknown as [string, any])[1], how).toMatchObject({ payload: { issueId: waiter.id } });
      expect(await s.leases()).toHaveLength(0);
    }
  });

  it("a claim that drops its own lease (releaseAcquired) wakes a todo waiter on the next sweep", async () => {
    const s = await seed();
    const a = await s.issue({ status: "in_progress" });
    await s.tag(a.id);
    const gate = await s.svc.tryAcquire(s.companyId, a.id);
    const waiter = await s.issue();
    await s.tag(waiter.id);
    expect(await s.svc.releaseAcquired(s.companyId, gate, "claim_not_started")).toBe(true);
    const d = s.deps();
    await s.svc.sweep(d, { companyId: s.companyId });
    await s.svc.sweep(d, { companyId: s.companyId });
    // both trees want the free mutex; the oldest goes first
    expect(d.wakeup).toHaveBeenCalledTimes(1);
  });

  it("sweep drops a lease whose mutex config no longer exists", async () => {
    const s = await seed();
    const root = await s.issue({ status: "in_progress" });
    await s.tag(root.id);
    expect((await s.svc.tryAcquire(s.companyId, root.id)).ok).toBe(true);
    await db.delete(podMutexLabels).where(eq(podMutexLabels.companyId, s.companyId));
    expect(await s.svc.sweep(s.deps(), { companyId: s.companyId })).toEqual({ released: 1 });
    expect(await s.leases()).toHaveLength(0);
    const released = await db.select().from(activityLog)
      .where(and(eq(activityLog.companyId, s.companyId), eq(activityLog.action, "pod_mutex.released")));
    expect(released.map((r) => (r.details as { reason?: string }).reason)).toContain("mutex_deleted");
  });

  it("forceRelease and remove take the label lock (wait for an in-flight acquire)", async () => {
    const s = await seed();
    const root = await s.issue({ status: "in_progress" });
    await s.tag(root.id);
    let releaseLock!: () => void;
    const locked = new Promise<void>((resolve) => { releaseLock = resolve; });
    let lockHeld!: () => void;
    const held = new Promise<void>((resolve) => { lockHeld = resolve; });
    const holder = db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('pod_mutex'), hashtext(${`${s.companyId}:${s.label.id}`}))`);
      await tx.insert(podMutexLeases).values({ companyId: s.companyId, labelId: s.label.id, holderRootIssueId: root.id });
      lockHeld();
      await locked;
    });
    await held;
    let done = false;
    const release = s.svc.forceRelease(s.companyId, s.label.id).then((r) => { done = true; return r; });
    await new Promise((r) => setTimeout(r, 200));
    expect(done).toBe(false);
    releaseLock();
    await holder;
    // the lease committed by the lock holder is the one force-released
    expect((await release)?.holderRootIssueId).toBe(root.id);
    expect(await s.leases()).toHaveLength(0);
  });

  it("non-UUID issue ids (e.g. a stray contextSnapshot issueId) resolve to no mutex instead of failing", async () => {
    const s = await seed();
    const root = await s.issue();
    await s.tag(root.id);
    const out = await s.svc.resolveMany(s.companyId, ["not-a-uuid", root.id], await s.svc.listConfigs(s.companyId));
    expect(out.get("not-a-uuid")).toBeNull();
    expect(out.get(root.id)?.rootIssueId).toBe(root.id);
    expect((await s.svc.tryAcquire(s.companyId, "not-a-uuid")).ok).toBe(true);
  });

  it("treeHoldsMany answers many roots in one query", async () => {
    const s = await seed();
    const a = await s.issue({ status: "in_progress" });
    await s.tag(a.id);
    const b = await s.issue({ status: "done" });
    await s.tag(b.id);
    const spy = vi.spyOn(db, "execute");
    const res = await s.svc.treeHoldsMany(s.companyId, [
      { rootIssueId: a.id, holdingStatuses: ["in_progress"], labelId: s.label.id },
      { rootIssueId: b.id, holdingStatuses: ["in_progress"], labelId: s.label.id },
      { rootIssueId: a.id, holdingStatuses: ["todo"], labelId: s.label.id },
    ]);
    expect(res).toEqual([true, false, false]);
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });
});
