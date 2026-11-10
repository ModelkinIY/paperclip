import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  agentWakeupRequests,
  authUsers,
  companyMemberships,
  companies,
  createDb,
  heartbeatRuns,
  issueLabels,
  issues,
  labels,
  podMutexLeases,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.ts";
import { runningProcesses } from "../adapters/index.ts";
import { podMutexService } from "../services/pod-mutex.js";
import { readPodMutexRunWait } from "@paperclipai/shared";
import { createHeartbeatQueue } from "../services/heartbeat/queue.js";
import { createHeartbeatQueueTestDependencies as queueDeps } from "./helpers/heartbeat-queue.js";

const mockAdapterExecute = vi.hoisted(() =>
  vi.fn(async () => ({
    exitCode: 0, signal: null, timedOut: false, errorMessage: null,
    summary: "pod mutex queue test run.", provider: "test", model: "test-model",
  })),
);

vi.mock("../adapters/index.ts", async () => {
  const actual = await vi.importActual<typeof import("../adapters/index.ts")>("../adapters/index.ts");
  return {
    ...actual,
    getServerAdapter: vi.fn(() => ({ supportsLocalAgentJwt: false, execute: mockAdapterExecute })),
  };
});

const sqlToQuery = PgDialect.prototype.sqlToQuery;
const support = await getEmbeddedPostgresTestSupport();
const describeDb = support.supported ? describe : describe.skip;

describeDb("pod mutex queue gate (startNextQueuedRunForAgent)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let heartbeat!: ReturnType<typeof heartbeatService>;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-pod-mutex-queue-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db);
  }, 180_000);

  afterEach(async () => {
    await heartbeat.drainActiveRunExecutions();
    mockAdapterExecute.mockClear();
    runningProcesses.clear();
    await db.execute(sql`truncate table ${companies} cascade`);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seed(maxConcurrentRuns = 5) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const prefix = `Q${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    await db.insert(companies).values({
      id: companyId, name: "Q Co", status: "active", issuePrefix: prefix, requireBoardApprovalForNewAgents: false,
    });
    // the manual wakes below name board-user as responsible user; it must be an active member
    await db.insert(authUsers).values({ id: `board-user-${companyId}`, name: "Owner", email: `${companyId}@example.test`, createdAt: new Date(), updatedAt: new Date() });
    await db.insert(companyMemberships).values({ companyId, principalId: `board-user-${companyId}`, principalType: "user", status: "active", membershipRole: "owner" });
    await db.insert(agents).values({
      id: agentId, companyId, name: "Coder", role: "engineer", status: "idle",
      adapterType: "codex_local", adapterConfig: {},
      runtimeConfig: { heartbeat: { enabled: true, intervalSec: 60, wakeOnDemand: true, maxConcurrentRuns } },
      permissions: {},
    });
    const [label] = await db.insert(labels).values({ companyId, name: "pod:igor-3090", color: "#000" }).returning();
    let n = 0;
    const issue = async (opts: { parentId?: string; status?: string } = {}) => {
      n += 1;
      const [row] = await db.insert(issues).values({
        companyId, identifier: `${prefix}-${n}`, title: `Issue ${n}`, status: opts.status ?? "todo",
        priority: "medium", parentId: opts.parentId ?? null, assigneeAgentId: agentId,
      }).returning();
      return row!;
    };
    const tag = (issueId: string) => db.insert(issueLabels).values({ issueId, labelId: label!.id, companyId });
    const queuedRun = async (issueId: string | null, extra: Partial<typeof heartbeatRuns.$inferInsert> = {}) => {
      const wakeupRequestId = randomUUID();
      const runId = randomUUID();
      await db.insert(agentWakeupRequests).values({
        id: wakeupRequestId, companyId, agentId, source: "on_demand", triggerDetail: "manual", status: "queued",
        runId, requestedByActorType: "user", requestedByActorId: `board-user-${companyId}`, payload: { manualUserWake: true },
      });
      await db.insert(heartbeatRuns).values({
        id: runId, companyId, agentId, invocationSource: "on_demand", triggerDetail: "manual", status: "queued",
        wakeupRequestId, contextSnapshot: issueId ? { issueId } : {}, createdAt: new Date(Date.now() - 60_000),
        ...extra,
      });
      return runId;
    };
    const svc = podMutexService(db);
    await svc.upsert(companyId, { labelId: label!.id });
    return { companyId, agentId, label: label!, issue, tag, queuedRun, svc };
  }

  async function runStatus(runId: string) {
    const [row] = await db.select({ status: heartbeatRuns.status, errorCode: heartbeatRuns.errorCode })
      .from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    return row ?? null;
  }

  async function dispatch() {
    await heartbeat.resumeQueuedRuns();
    await heartbeat.drainActiveRunExecutions();
  }

  it("holder-tree run starts, other-tree run stays queued, unrelated run of the same agent starts", async () => {
    const s = await seed();
    const rootA = await s.issue();
    await s.tag(rootA.id);
    const childA = await s.issue({ parentId: rootA.id });
    const rootB = await s.issue();
    await s.tag(rootB.id);
    const unrelated = await s.issue();
    expect((await s.svc.tryAcquire(s.companyId, rootA.id)).ok).toBe(true);

    const runA = await s.queuedRun(childA.id);
    const runB = await s.queuedRun(rootB.id);
    const runU = await s.queuedRun(unrelated.id);
    await dispatch();

    expect((await runStatus(runA))?.status).toBe("succeeded");
    expect(await runStatus(runB)).toMatchObject({ status: "queued", errorCode: null });
    expect((await runStatus(runU))?.status).toBe("succeeded");
    const [lease] = await db.select().from(podMutexLeases).where(eq(podMutexLeases.companyId, s.companyId));
    expect(lease!.holderRootIssueId).toBe(rootA.id);
  }, 60_000);

  it("a deferred run is retried and stays queued over several passes, then starts after release + sweep", async () => {
    const s = await seed();
    const rootA = await s.issue({ status: "in_progress" });
    await s.tag(rootA.id);
    const rootB = await s.issue();
    await s.tag(rootB.id);
    expect((await s.svc.tryAcquire(s.companyId, rootA.id)).ok).toBe(true);
    const runB = await s.queuedRun(rootB.id);
    await dispatch();
    await dispatch();
    expect(await runStatus(runB)).toMatchObject({ status: "queued" });
    expect(mockAdapterExecute).not.toHaveBeenCalled();

    await db.update(issues).set({ status: "done" }).where(eq(issues.id, rootA.id));
    await s.svc.sweep({ resumeQueuedRuns: (scope) => heartbeat.resumeQueuedRunsAfterDrain(scope) }, { companyId: s.companyId });
    await heartbeat.drainActiveRunExecutions();
    expect((await runStatus(runB))?.status).toBe("succeeded");
    const [lease] = await db.select().from(podMutexLeases).where(eq(podMutexLeases.companyId, s.companyId));
    expect(lease!.holderRootIssueId).toBe(rootB.id);
  }, 60_000);

  it("a resuming run (startedAt set) is not gated", async () => {
    const s = await seed();
    const rootA = await s.issue();
    await s.tag(rootA.id);
    const rootB = await s.issue();
    await s.tag(rootB.id);
    expect((await s.svc.tryAcquire(s.companyId, rootA.id)).ok).toBe(true);
    const runB = await s.queuedRun(rootB.id, { startedAt: new Date(Date.now() - 30_000) });
    await dispatch();
    expect((await runStatus(runB))?.status).toBe("succeeded");
    // the lease was not stolen by the resuming run
    const [lease] = await db.select().from(podMutexLeases).where(eq(podMutexLeases.companyId, s.companyId));
    expect(lease!.holderRootIssueId).toBe(rootA.id);
  }, 60_000);

  it("with no mutex configured, labelled runs start as usual (inert)", async () => {
    const s = await seed();
    await s.svc.remove(s.companyId, s.label.id);
    const rootA = await s.issue();
    await s.tag(rootA.id);
    const rootB = await s.issue();
    await s.tag(rootB.id);
    const runA = await s.queuedRun(rootA.id);
    const runB = await s.queuedRun(rootB.id);
    const queries: string[] = [];
    const spy = vi.spyOn(PgDialect.prototype, "sqlToQuery").mockImplementation(function (this: PgDialect, ...args) {
      const out = sqlToQuery.apply(this, args);
      queries.push(out.sql);
      return out;
    });
    try {
      await dispatch();
    } finally {
      spy.mockRestore();
    }
    // run claim: config lookups only, never the ancestor CTE or the lease table
    expect(queries.some((q) => q.includes("pod_mutex_labels"))).toBe(true);
    expect(queries.filter((q) => /WITH RECURSIVE chain|pod_mutex_leases/.test(q))).toHaveLength(0);
    expect((await runStatus(runA))?.status).toBe("succeeded");
    expect((await runStatus(runB))?.status).toBe("succeeded");
    expect(await db.select().from(podMutexLeases).where(eq(podMutexLeases.companyId, s.companyId))).toHaveLength(0);
  }, 60_000);
  it("records why a deferred run waits on contextSnapshot.podMutex and clears it once it starts", async () => {
    const s = await seed();
    const rootA = await s.issue({ status: "in_progress" });
    await s.tag(rootA.id);
    const rootB = await s.issue();
    await s.tag(rootB.id);
    expect((await s.svc.tryAcquire(s.companyId, rootA.id)).ok).toBe(true);
    const runB = await s.queuedRun(rootB.id);
    await dispatch();
    const [waiting] = await db.select({ ctx: heartbeatRuns.contextSnapshot }).from(heartbeatRuns).where(eq(heartbeatRuns.id, runB));
    expect(readPodMutexRunWait(waiting!.ctx)).toMatchObject({
      label: "pod:igor-3090", holderRootIssueId: rootA.id, holderIdentifier: rootA.identifier,
    });
    await db.update(issues).set({ status: "done" }).where(eq(issues.id, rootA.id));
    await s.svc.sweep({ resumeQueuedRuns: (scope) => heartbeat.resumeQueuedRunsAfterDrain(scope) }, { companyId: s.companyId });
    await heartbeat.drainActiveRunExecutions();
    const [done] = await db.select({ status: heartbeatRuns.status, ctx: heartbeatRuns.contextSnapshot }).from(heartbeatRuns).where(eq(heartbeatRuns.id, runB));
    expect(done!.status).toBe("succeeded");
    expect(readPodMutexRunWait(done!.ctx)).toBeNull();
  }, 60_000);

  it("the run's issue resolves from issueId / nativeIssueId, not only contextSnapshot", async () => {
    const s = await seed();
    const rootA = await s.issue({ status: "in_progress" });
    await s.tag(rootA.id);
    const rootB = await s.issue();
    await s.tag(rootB.id);
    expect((await s.svc.tryAcquire(s.companyId, rootA.id)).ok).toBe(true);
    const runB = await s.queuedRun(null, { issueId: rootB.id });
    await dispatch();
    expect(await runStatus(runB)).toMatchObject({ status: "queued" });
    expect(mockAdapterExecute).not.toHaveBeenCalled();
  }, 60_000);

  describe("claimQueuedRun (every claim path, e.g. executeRun)", () => {
    function queueWith(agentRow: Record<string, unknown> | null) {
      const deps = queueDeps(db);
      deps.getAgent.mockImplementation(async () => agentRow as any);
      return { queue: createHeartbeatQueue(db, deps), deps };
    }
    async function loadRun(id: string) {
      const [row] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, id));
      return row!;
    }

    it("a direct claim of another tree's run returns null, leaves it queued and never starts", async () => {
      const s = await seed();
      const rootA = await s.issue({ status: "in_progress" });
      await s.tag(rootA.id);
      const rootB = await s.issue();
      await s.tag(rootB.id);
      expect((await s.svc.tryAcquire(s.companyId, rootA.id)).ok).toBe(true);
      const runB = await s.queuedRun(rootB.id);
      const [agentRow] = await db.select().from(agents).where(eq(agents.id, s.agentId));
      const { queue, deps } = queueWith(agentRow!);
      expect(await queue.claimQueuedRun(await loadRun(runB))).toBeNull();
      expect(deps.cancelRunInternal).not.toHaveBeenCalled();
      expect(mockAdapterExecute).not.toHaveBeenCalled();
      expect(await runStatus(runB)).toMatchObject({ status: "queued", errorCode: null });
      expect(readPodMutexRunWait((await loadRun(runB)).contextSnapshot)).toMatchObject({ holderRootIssueId: rootA.id });
    }, 60_000);

    it("a deferred claim (agent awaiting setup) never takes the lease: no acquired/released churn over several passes", async () => {
      const s = await seed();
      const rootB = await s.issue();
      await s.tag(rootB.id);
      const runB = await s.queuedRun(rootB.id);
      // agent awaiting setup: the claim keeps the run queued and returns null
      const [agentRow] = await db.select().from(agents).where(eq(agents.id, s.agentId));
      const { queue } = queueWith({ ...agentRow!, lifecycleState: "preparing", lifecycleHolds: [] });
      for (let i = 0; i < 3; i += 1) {
        expect(await queue.claimQueuedRun(await loadRun(runB))).toBeNull();
        await s.svc.sweep({}, { companyId: s.companyId });
      }
      expect(await runStatus(runB)).toMatchObject({ status: "queued" });
      expect(await db.select().from(podMutexLeases).where(eq(podMutexLeases.companyId, s.companyId))).toHaveLength(0);
      const churn = await db.select().from(activityLog).where(and(
        eq(activityLog.companyId, s.companyId),
        sql`${activityLog.action} IN ('pod_mutex.acquired', 'pod_mutex.released')`,
      ));
      expect(churn).toHaveLength(0);
    }, 60_000);

    it("a dependency-blocked run is withheld before the gate: no lease, no activity rows", async () => {
      const s = await seed();
      const blocker = await s.issue();
      const rootB = await s.issue();
      await s.tag(rootB.id);
      const [agentRow] = await db.select().from(agents).where(eq(agents.id, s.agentId));
      const { queue, deps } = queueWith(agentRow!);
      deps.issuesSvc.listDependencyReadiness.mockImplementation(async () => new Map([[rootB.id, {
        issueId: rootB.id, blockerIssueIds: [blocker.id], unresolvedBlockerIssueIds: [blocker.id],
        unresolvedBlockerCount: 1, allBlockersDone: false, isDependencyReady: false,
      }]]) as any);
      // each pass: a fresh queued run for the blocked issue is withheld (cancelled) at the claim
      for (let i = 0; i < 3; i += 1) {
        const runB = await s.queuedRun(rootB.id);
        expect(await queue.claimQueuedRun(await loadRun(runB))).toBeNull();
        expect((await runStatus(runB))?.status).not.toBe("running");
        await s.svc.sweep({}, { companyId: s.companyId });
      }
      expect(await db.select().from(podMutexLeases).where(eq(podMutexLeases.companyId, s.companyId))).toHaveLength(0);
      const churn = await db.select().from(activityLog).where(and(
        eq(activityLog.companyId, s.companyId),
        sql`${activityLog.action} IN ('pod_mutex.acquired', 'pod_mutex.released')`,
      ));
      expect(churn).toHaveLength(0);
    }, 60_000);
  });
});
