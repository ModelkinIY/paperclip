import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
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
import {
  normalizeHoldingStatuses,
  pickEffectiveMutex,
  pickNextWaiter,
  podMutexService,
  type WaiterCandidate,
} from "../services/pod-mutex.js";
import { issueService } from "../services/issues.ts";

describe("pod mutex pure logic", () => {
  const cfg = new Map([
    ["L1", { labelId: "L1", holdingStatuses: ["todo", "in_progress"], enabled: true }],
    ["L2", { labelId: "L2", holdingStatuses: ["in_progress"], enabled: true }],
    ["OFF", { labelId: "OFF", holdingStatuses: ["todo"], enabled: false }],
  ]);

  it("picks the nearest enabled mutex label", () => {
    expect(pickEffectiveMutex([
      { issueId: "root", depth: 2, labelId: "L1" },
      { issueId: "mid", depth: 1, labelId: "L2" },
    ], cfg)).toEqual({ labelId: "L2", rootIssueId: "mid", holdingStatuses: ["in_progress"] });
  });

  it("same label nested: the farthest same-label ancestor is the root", () => {
    expect(pickEffectiveMutex([
      { issueId: "self", depth: 0, labelId: "L1" },
      { issueId: "mid", depth: 1, labelId: "L1" },
      { issueId: "top", depth: 3, labelId: "L1" },
    ], cfg)).toMatchObject({ labelId: "L1", rootIssueId: "top" });
  });

  it("a different enabled label stops the farthest-root walk; disabled labels do not", () => {
    expect(pickEffectiveMutex([
      { issueId: "self", depth: 0, labelId: "L1" },
      { issueId: "mid", depth: 1, labelId: "L2" },
      { issueId: "top", depth: 2, labelId: "L1" },
    ], cfg)).toMatchObject({ labelId: "L1", rootIssueId: "self" });
    expect(pickEffectiveMutex([
      { issueId: "self", depth: 0, labelId: "L1" },
      { issueId: "mid", depth: 1, labelId: "OFF" },
      { issueId: "top", depth: 2, labelId: "L1" },
    ], cfg)).toMatchObject({ labelId: "L1", rootIssueId: "top" });
  });

  it("ignores disabled and unconfigured labels", () => {
    expect(pickEffectiveMutex([
      { issueId: "self", depth: 0, labelId: "OFF" },
      { issueId: "x", depth: 0, labelId: "random" },
    ], cfg)).toBeNull();
    expect(pickEffectiveMutex([], new Map())).toBeNull();
  });

  it("orders waiters by priority, then age, excluding the holder tree", () => {
    const w = (id: string, priority: string, at: string, root = id): WaiterCandidate => ({
      issueId: id, identifier: id, title: id, priority, status: "todo", rootIssueId: root,
      assigneeAgentId: "a", queuedAgentId: null, createdAt: new Date(at),
    });
    const list = [
      w("low-old", "low", "2026-01-01"),
      w("high-new", "high", "2026-03-01"),
      w("high-old", "high", "2026-02-01"),
      w("crit-holder", "critical", "2026-01-01", "holder"),
    ];
    expect(pickNextWaiter(list, "holder")?.issueId).toBe("high-old");
    expect(pickNextWaiter([], null)).toBeNull();
  });

  it("normalizes holding statuses", () => {
    expect(normalizeHoldingStatuses(["todo", "bogus", "todo", "blocked"])).toEqual(["todo", "blocked"]);
    expect(normalizeHoldingStatuses(undefined)).toEqual(["todo", "in_progress"]);
    expect(normalizeHoldingStatuses([])).toEqual(["todo", "in_progress"]);
    expect(normalizeHoldingStatuses(["bogus"])).toEqual(["todo", "in_progress"]);
  });
});

const support = await getEmbeddedPostgresTestSupport();
const describeDb = support.supported ? describe : describe.skip;
if (!support.supported) {
  console.warn(`Skipping embedded Postgres pod mutex tests: ${support.reason ?? "unsupported"}`);
}

describeDb("pod mutex service", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-pod-mutex-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seed() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const prefix = `P${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    await db.insert(companies).values({ id: companyId, name: "Co", issuePrefix: prefix, requireBoardApprovalForNewAgents: false });
    await db.insert(agents).values({
      id: agentId, companyId, name: "Coder", role: "engineer", status: "active",
      adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {},
    });
    const [label] = await db.insert(labels).values({ companyId, name: "pod:igor-3090", color: "#000" }).returning();
    let n = 0;
    const issue = async (opts: { parentId?: string; status?: string; priority?: string; createdAt?: Date } = {}) => {
      n += 1;
      const [row] = await db.insert(issues).values({
        companyId, identifier: `${prefix}-${n}`, title: `Issue ${n}`,
        status: opts.status ?? "todo", priority: opts.priority ?? "medium",
        parentId: opts.parentId ?? null, assigneeAgentId: agentId,
        ...(opts.createdAt ? { createdAt: opts.createdAt } : {}),
      }).returning();
      return row!;
    };
    const tag = async (issueId: string, labelId = label!.id) => {
      await db.insert(issueLabels).values({ issueId, labelId, companyId });
    };
    return { companyId, agentId, label: label!, issue, tag };
  }

  it("is inert when no mutex label is configured", async () => {
    const s = await seed();
    const root = await s.issue();
    await s.tag(root.id);
    const svc = podMutexService(db);
    expect(await svc.hasEnabled(s.companyId)).toBe(false);
    expect(await svc.tryAcquire(s.companyId, root.id)).toEqual({ ok: true, mutex: null });
    expect(await db.select().from(podMutexLeases).where(eq(podMutexLeases.companyId, s.companyId))).toHaveLength(0);
  });

  it("resolves the root through ancestors and survives a parent cycle", async () => {
    const s = await seed();
    const svc = podMutexService(db);
    await svc.upsert(s.companyId, { labelId: s.label.id });
    const root = await s.issue();
    await s.tag(root.id);
    const child = await s.issue({ parentId: root.id });
    const grandchild = await s.issue({ parentId: child.id });
    expect((await svc.resolveEffectiveMutex(s.companyId, grandchild.id))?.rootIssueId).toBe(root.id);

    // cycle a <-> b, no label: terminates and returns null
    const a = await s.issue();
    const b = await s.issue({ parentId: a.id });
    await db.update(issues).set({ parentId: b.id }).where(eq(issues.id, a.id));
    expect(await svc.resolveEffectiveMutex(s.companyId, a.id)).toBeNull();
    // labelled cycle still resolves
    await s.tag(b.id);
    expect((await svc.resolveEffectiveMutex(s.companyId, a.id))?.rootIssueId).toBe(b.id);
  });

  it("gates: holder tree passes, other tree blocked, unlabelled issue passes", async () => {
    const s = await seed();
    const svc = podMutexService(db);
    await svc.upsert(s.companyId, { labelId: s.label.id });
    const rootA = await s.issue();
    await s.tag(rootA.id);
    const childA1 = await s.issue({ parentId: rootA.id });
    const childA2 = await s.issue({ parentId: rootA.id });
    const rootB = await s.issue();
    await s.tag(rootB.id);
    const childB = await s.issue({ parentId: rootB.id });
    const unrelated = await s.issue();

    expect((await svc.tryAcquire(s.companyId, childA1.id)).ok).toBe(true);
    expect((await svc.tryAcquire(s.companyId, childA2.id)).ok).toBe(true);
    const blocked = await svc.tryAcquire(s.companyId, childB.id);
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) {
      expect(blocked.labelName).toBe("pod:igor-3090");
      expect(blocked.holderIdentifier).toBe(rootA.identifier);
    }
    expect(await svc.tryAcquire(s.companyId, unrelated.id)).toEqual({ ok: true, mutex: null });
  });

  it("checkout of a waiting tree returns 409 naming label and holder", async () => {
    const s = await seed();
    const svc = podMutexService(db);
    await svc.upsert(s.companyId, { labelId: s.label.id });
    const rootA = await s.issue();
    await s.tag(rootA.id);
    const rootB = await s.issue();
    await s.tag(rootB.id);
    const issuesSvc = issueService(db);
    await issuesSvc.checkout(rootA.id, s.agentId, ["todo"], null);
    await expect(issuesSvc.checkout(rootB.id, s.agentId, ["todo"], null)).rejects.toMatchObject({
      status: 409,
      details: { reason: "pod_mutex_held", labelName: "pod:igor-3090", holderIdentifier: rootA.identifier },
    });
    const [b] = await db.select().from(issues).where(eq(issues.id, rootB.id));
    expect(b!.status).toBe("todo");
  });

  it("releases lazily when the holder tree has no holding issues, then grants the next tree", async () => {
    const s = await seed();
    const svc = podMutexService(db);
    await svc.upsert(s.companyId, { labelId: s.label.id });
    const rootA = await s.issue();
    await s.tag(rootA.id);
    const childA = await s.issue({ parentId: rootA.id, status: "in_progress" });
    const rootB = await s.issue();
    await s.tag(rootB.id);
    expect((await svc.tryAcquire(s.companyId, childA.id)).ok).toBe(true);
    expect((await svc.tryAcquire(s.companyId, rootB.id)).ok).toBe(false);
    await db.update(issues).set({ status: "done" }).where(sql`${issues.id} in (${rootA.id}, ${childA.id})`);
    expect((await svc.tryAcquire(s.companyId, rootB.id)).ok).toBe(true);
    const [lease] = await db.select().from(podMutexLeases).where(eq(podMutexLeases.companyId, s.companyId));
    expect(lease!.holderRootIssueId).toBe(rootB.id);
  });

  it("sweep releases a stale lease and wakes the highest-priority waiter", async () => {
    const s = await seed();
    const svc = podMutexService(db);
    await svc.upsert(s.companyId, { labelId: s.label.id, holdingStatuses: ["in_progress"] });
    const rootA = await s.issue({ status: "in_progress" });
    await s.tag(rootA.id);
    expect((await svc.tryAcquire(s.companyId, rootA.id)).ok).toBe(true);
    const low = await s.issue({ priority: "low", createdAt: new Date("2026-01-01") });
    await s.tag(low.id);
    const high = await s.issue({ priority: "high", createdAt: new Date("2026-02-01") });
    await s.tag(high.id);
    const highChild = await s.issue({ parentId: high.id, priority: "critical", status: "backlog" });
    void highChild;

    const wakeup = vi.fn(async () => null);
    const resumeQueuedRuns = vi.fn(async () => null);
    // holder still holds: nothing released, no todo wake (only queued-run waiters are re-dispatched)
    expect((await svc.sweep({ wakeup, resumeQueuedRuns }, { companyId: s.companyId })).released).toBe(0);
    expect(wakeup).not.toHaveBeenCalled();

    await db.update(issues).set({ status: "in_review" }).where(eq(issues.id, rootA.id));
    expect((await svc.sweep({ wakeup, resumeQueuedRuns }, { companyId: s.companyId })).released).toBe(1);
    expect(wakeup).toHaveBeenCalledTimes(1);
    expect(wakeup.mock.calls[0]![0]).toBe(s.agentId);
    expect((wakeup.mock.calls[0] as unknown as [string, { payload: { issueId: string } }])[1].payload.issueId).toBe(high.id);
    expect(await db.select().from(podMutexLeases).where(eq(podMutexLeases.companyId, s.companyId))).toHaveLength(0);
  });

  it("a waiter with a queued run is re-dispatched and stays queued", async () => {
    const s = await seed();
    const svc = podMutexService(db);
    await svc.upsert(s.companyId, { labelId: s.label.id });
    const rootA = await s.issue();
    await s.tag(rootA.id);
    expect((await svc.tryAcquire(s.companyId, rootA.id)).ok).toBe(true);
    const rootB = await s.issue({ status: "backlog" });
    await s.tag(rootB.id);
    const [run] = await db.insert(heartbeatRuns).values({
      companyId: s.companyId, agentId: s.agentId, status: "queued", invocationSource: "automation",
      contextSnapshot: { issueId: rootB.id },
    }).returning();
    const listed = await svc.list(s.companyId);
    expect(listed[0]!.holder?.rootIssueId).toBe(rootA.id);
    expect(listed[0]!.waiting.map((w) => w.issueId)).toEqual([rootB.id]);
    expect((await svc.tryAcquire(s.companyId, rootB.id)).ok).toBe(false);
    const [still] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run!.id));
    expect(still!.status).toBe("queued");

    await svc.forceRelease(s.companyId, s.label.id);
    const resumeQueuedRuns = vi.fn(async () => null);
    await svc.sweep({ resumeQueuedRuns }, { companyId: s.companyId });
    expect(resumeQueuedRuns).toHaveBeenCalledWith({ companyId: s.companyId });
    await db.delete(podMutexLabels).where(eq(podMutexLabels.companyId, s.companyId));
  });
});
