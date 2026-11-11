import { Router, type Request } from "express";
import { and, eq } from "drizzle-orm";
import { connectionGrants, toolConnections, type Db } from "@paperclipai/db";
import { accountLimitParamsSchema, accountLimitSettingsPatchSchema, aiConnectionMetadataSchema } from "@paperclipai/shared";
import { assertBoard, assertCompanyAccess, getActorInfo } from "./authz.js";
import { validate } from "../middleware/validate.js";
import { badRequest, notFound } from "../errors.js";
import { paceModelIds } from "../services/account-capacity/pace/index.js";
import { logActivity } from "../services/activity-log.js";
import { accountCapacity, limitSettingsStore } from "../services/account-capacity/runtime.js";
import { probeGrant, type AccountProbeUsage } from "../services/account-capacity/probe.js";
import { listAccountLimitViews } from "../services/account-capacity/view.js";

/**
 * inferdyne fork: subscription-limit accounting per AI account (grant),
 * board only. Read the state, switch accounting on or off, tune the pace
 * model, and take a fresh measurement.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function accountLimitsRoutes(db: Db, deps: { usage: AccountProbeUsage; resumeQueuedRuns?: () => Promise<unknown> }) {
  const router = Router();

  function guard(req: Request) {
    const companyId = req.params.companyId as string;
    if (!UUID.test(companyId)) throw badRequest("companyId must be a UUID");
    assertBoard(req);
    assertCompanyAccess(req, companyId);
    return companyId;
  }
  function grantParam(req: Request) {
    const parsed = accountLimitParamsSchema.safeParse(req.params);
    if (!parsed.success) throw badRequest("grantId must be a UUID");
    return parsed.data.grantId;
  }
  async function account(companyId: string, grantId: string) {
    const [row] = await db.select({ grant: connectionGrants, connection: toolConnections }).from(connectionGrants)
      .innerJoin(toolConnections, eq(toolConnections.id, connectionGrants.connectionId))
      .where(and(eq(connectionGrants.companyId, companyId), eq(connectionGrants.id, grantId), eq(toolConnections.connectionPurpose, "ai")))
      .limit(1);
    const meta = row ? aiConnectionMetadataSchema.safeParse((row.connection.config as Record<string, unknown>).ai) : null;
    if (!row || !meta?.success) throw notFound("AI account not found");
    return { row, meta: meta.data };
  }

  router.get("/companies/:companyId/account-limits", async (req, res) => {
    const companyId = guard(req);
    res.setHeader("Cache-Control", "no-store");
    res.json(await listAccountLimitViews(db, accountCapacity, limitSettingsStore, companyId));
  });

  router.patch("/companies/:companyId/account-limits/:grantId", validate(accountLimitSettingsPatchSchema), async (req, res) => {
    const companyId = guard(req);
    const grantId = grantParam(req);
    await account(companyId, grantId);
    if (req.body.paceModel !== undefined && !paceModelIds().includes(req.body.paceModel)) {
      throw badRequest(`Unknown pace model; available: ${paceModelIds().join(", ")}`);
    }
    const before = limitSettingsStore.get(grantId);
    const actor = getActorInfo(req);
    const next = await limitSettingsStore.update(db, companyId, grantId, req.body, actor.actorId);
    await logActivity(db, {
      companyId, actorType: actor.actorType, actorId: actor.actorId, agentId: actor.agentId, runId: actor.runId,
      action: "account_limit.updated", entityType: "connection_grant", entityId: grantId,
      details: { before, after: next },
    });
    // Turning accounting off (or relaxing it) may free held runs right away.
    if (before.enabled && !next.enabled) await deps.resumeQueuedRuns?.();
    res.setHeader("Cache-Control", "no-store");
    res.json({ settings: next });
  });

  router.post("/companies/:companyId/account-limits/:grantId/refresh", async (req, res) => {
    const companyId = guard(req);
    const grantId = grantParam(req);
    const { row, meta } = await account(companyId, grantId);
    const actor = getActorInfo(req);
    const outcome = await probeGrant(accountCapacity, deps.usage, {
      companyId, grantId, connectionId: row.connection.id, provider: meta.provider, method: meta.method, userId: actor.actorId,
    }, new Date(), true);
    res.setHeader("Cache-Control", "no-store");
    res.json({
      probed: outcome === "ok",
      ...(outcome === "failed" ? { error: "The provider did not return limits. Check that the account is connected and you may use it." } : {}),
      capacity: accountCapacity.getCapacity(grantId, meta.provider, meta.method),
    });
  });

  return router;
}
