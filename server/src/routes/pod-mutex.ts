import { Router, type Request } from "express";
import { z } from "zod";
import { ISSUE_STATUSES } from "@paperclipai/shared";
import type { Db } from "@paperclipai/db";
import { assertBoard, assertCompanyAccess, getActorInfo } from "./authz.js";
import { validate } from "../middleware/validate.js";
import { badRequest, notFound } from "../errors.js";
import { logActivity } from "../services/activity-log.js";
import { podMutexService } from "../services/pod-mutex.js";

const upsertSchema = z.object({
  labelId: z.string().uuid().optional().nullable(),
  labelName: z.string().trim().min(1).max(100).optional().nullable(),
  holdingStatuses: z.array(z.enum(ISSUE_STATUSES)).optional(),
  enabled: z.boolean().optional(),
});

/** inferdyne fork: pod mutex admin (services/pod-mutex.ts). Board users only. */
export function podMutexRoutes(db: Db) {
  const router = Router();
  const svc = podMutexService(db);

  function guard(req: Request) {
    const companyId = req.params.companyId as string;
    assertBoard(req);
    assertCompanyAccess(req, companyId);
    return companyId;
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

  router.get("/companies/:companyId/pod-mutexes", async (req, res) => {
    const companyId = guard(req);
    res.json(await svc.list(companyId));
  });

  router.post("/companies/:companyId/pod-mutexes", validate(upsertSchema), async (req, res) => {
    const companyId = guard(req);
    if (!req.body.labelId && !req.body.labelName) throw badRequest("labelId or labelName is required");
    const row = await svc.upsert(companyId, req.body);
    if (!row) throw notFound("Label not found");
    await log(req, companyId, "pod_mutex.upserted", row.labelId, {
      holdingStatuses: row.holdingStatuses,
      enabled: row.enabled,
    });
    res.status(201).json(row);
  });

  router.patch("/companies/:companyId/pod-mutexes/:labelId", validate(upsertSchema), async (req, res) => {
    const companyId = guard(req);
    const labelId = req.params.labelId as string;
    const row = await svc.upsert(companyId, { ...req.body, labelId, labelName: null });
    if (!row) throw notFound("Label not found");
    await log(req, companyId, "pod_mutex.updated", labelId, {
      holdingStatuses: row.holdingStatuses,
      enabled: row.enabled,
    });
    res.json(row);
  });

  router.delete("/companies/:companyId/pod-mutexes/:labelId", async (req, res) => {
    const companyId = guard(req);
    const labelId = req.params.labelId as string;
    const removed = await svc.remove(companyId, labelId);
    if (!removed) throw notFound("Pod mutex not found");
    await log(req, companyId, "pod_mutex.deleted", labelId, {});
    res.json({ ok: true });
  });

  router.post("/companies/:companyId/pod-mutexes/:labelId/release", async (req, res) => {
    const companyId = guard(req);
    const labelId = req.params.labelId as string;
    const lease = await svc.forceRelease(companyId, labelId);
    await log(req, companyId, "pod_mutex.force_released", labelId, {
      holderRootIssueId: lease?.holderRootIssueId ?? null,
    });
    res.json({ ok: true, released: Boolean(lease) });
  });

  return router;
}
