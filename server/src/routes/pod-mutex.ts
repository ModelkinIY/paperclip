import { Router, type Request } from "express";
import { podMutexLabelParamsSchema, podMutexUpsertSchema, type PodMutexReleaseResponse } from "@paperclipai/shared";
import type { Db } from "@paperclipai/db";
import { assertBoard, assertCompanyAccess, getActorInfo } from "./authz.js";
import { validate } from "../middleware/validate.js";
import { badRequest, notFound } from "../errors.js";
import { logger } from "../middleware/logger.js";
import { logActivity } from "../services/activity-log.js";
import { podMutexService, type PodMutexWakeDeps } from "../services/pod-mutex.js";

/**
 * inferdyne fork: pod mutex admin (services/pod-mutex.ts). Board users only.
 * Every change (holding statuses, enable/disable, delete, force-release) runs
 * the sweep for the company right away so waiters wake without the 30s tick.
 */
export function podMutexRoutes(db: Db, wakeDeps: PodMutexWakeDeps = {}) {
  const router = Router();
  const svc = podMutexService(db);

  function guard(req: Request) {
    const companyId = req.params.companyId as string;
    assertBoard(req);
    assertCompanyAccess(req, companyId);
    return companyId;
  }

  function labelIdParam(req: Request) {
    const parsed = podMutexLabelParamsSchema.safeParse(req.params);
    if (!parsed.success) throw badRequest("labelId must be a UUID");
    return parsed.data.labelId;
  }

  async function log(req: Request, companyId: string, action: string, labelId: string, details: Record<string, unknown>) {
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action,
      entityType: "label",
      entityId: labelId,
      details,
    });
  }

  async function sweepNow(companyId: string) {
    try {
      await svc.sweep(wakeDeps, { companyId });
    } catch (err) {
      logger.error({ err, companyId }, "pod mutex: sweep after admin action failed");
    }
  }

  router.get("/companies/:companyId/pod-mutexes", async (req, res) => {
    const companyId = guard(req);
    res.json(await svc.list(companyId));
  });

  router.post("/companies/:companyId/pod-mutexes", validate(podMutexUpsertSchema), async (req, res) => {
    const companyId = guard(req);
    if (!req.body.labelId && !req.body.labelName) throw badRequest("labelId or labelName is required");
    const row = await svc.upsert(companyId, req.body);
    if (!row) throw notFound("Label not found");
    await log(req, companyId, "pod_mutex.upserted", row.labelId, {
      holdingStatuses: row.holdingStatuses,
      enabled: row.enabled,
    });
    await sweepNow(companyId);
    res.status(201).json(row);
  });

  router.patch("/companies/:companyId/pod-mutexes/:labelId", validate(podMutexUpsertSchema), async (req, res) => {
    const companyId = guard(req);
    const labelId = labelIdParam(req);
    const row = await svc.upsert(companyId, { ...req.body, labelId, labelName: null });
    if (!row) throw notFound("Label not found");
    await log(req, companyId, "pod_mutex.updated", labelId, {
      holdingStatuses: row.holdingStatuses,
      enabled: row.enabled,
    });
    await sweepNow(companyId);
    res.json(row);
  });

  router.delete("/companies/:companyId/pod-mutexes/:labelId", async (req, res) => {
    const companyId = guard(req);
    const labelId = labelIdParam(req);
    const removed = await svc.remove(companyId, labelId);
    if (!removed) throw notFound("Pod mutex not found");
    await log(req, companyId, "pod_mutex.deleted", labelId, {});
    await sweepNow(companyId);
    res.json({ ok: true });
  });

  router.post("/companies/:companyId/pod-mutexes/:labelId/release", async (req, res) => {
    const companyId = guard(req);
    const labelId = labelIdParam(req);
    const lease = await svc.forceRelease(companyId, labelId);
    let holderHasRunningRun = false;
    if (lease) {
      holderHasRunningRun =
        (await svc.holderRunInfo(companyId, [lease.holderRootIssueId])).get(lease.holderRootIssueId)?.hasRunningRun ?? false;
      await log(req, companyId, "pod_mutex.force_released", labelId, {
        holderRootIssueId: lease.holderRootIssueId,
        acquiredAt: lease.acquiredAt,
        holderHasRunningRun,
        manual: true,
      });
      await sweepNow(companyId);
    }
    const body: PodMutexReleaseResponse = {
      ok: true,
      released: Boolean(lease),
      held: Boolean(lease),
      holderRootIssueId: lease?.holderRootIssueId ?? null,
      holderHasRunningRun,
    };
    res.json(body);
  });

  return router;
}
