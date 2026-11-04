/**
 * Weekly pace hold (inferdyne fork).
 *
 * Agents with `runtimeConfig.weeklyPace.hold === true` do not start new runs
 * while the company's subscription is ahead of an even weekly pace:
 * delta = used% of the seven-day window − elapsed% of that window.
 * Running runs are never touched (a run on a warm cache is cheaper to finish),
 * held runs stay queued and start once the delta falls back.
 *
 * One snapshot per company, fed from two sources:
 * - `rate_limit_event` lines that Claude Code prints in every run's output
 *   (free and fresh while anything runs);
 * - the board's usage probe of the company's default Anthropic subscription,
 *   only when the snapshot is stale.
 * The snapshot lives in memory: after a restart the first tick probes again.
 */
import { and, eq } from "drizzle-orm";
import { agents, companyMemberships, type Db } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";

export const WEEK_SECONDS = 604_800;
/** Hold when the delta is above this value (percentage points). */
export const HOLD_ABOVE = 0;
/** Release a hold once the delta is at or below this value. */
export const RELEASE_AT_OR_BELOW = -2;
/** Probe the account when the freshest observation is older than this. */
export const STALE_AFTER_MS = 30 * 60_000;

export interface WeeklyPaceObservation {
  /** Used share of the seven-day window, in percent (0–100+). */
  usedPercent: number;
  resetsAt: Date;
  observedAt: Date;
  source: "run_output" | "usage_probe";
}

interface CompanyPaceState {
  observation: WeeklyPaceObservation | null;
  held: boolean;
  lastProbeAt: number;
}

const states = new Map<string, CompanyPaceState>();

function state(companyId: string): CompanyPaceState {
  let s = states.get(companyId);
  if (!s) {
    s = { observation: null, held: false, lastProbeAt: 0 };
    states.set(companyId, s);
  }
  return s;
}

export function resetWeeklyPaceStateForTests() {
  states.clear();
}

export function weeklyPaceDelta(observation: WeeklyPaceObservation, now: Date): number {
  const remaining = (observation.resetsAt.getTime() - now.getTime()) / 1000;
  const elapsed = Math.min(WEEK_SECONDS, Math.max(0, WEEK_SECONDS - remaining));
  return observation.usedPercent - (elapsed / WEEK_SECONDS) * 100;
}

/** Keep the newest observation; an older one never replaces a newer one. */
export function recordWeeklyPaceObservation(companyId: string, observation: WeeklyPaceObservation) {
  const s = state(companyId);
  if (s.observation && s.observation.observedAt.getTime() > observation.observedAt.getTime()) return;
  s.observation = observation;
}

/**
 * Re-evaluate the company's hold with hysteresis. Returns the new state and
 * whether it changed. Without an observation nothing is held.
 */
export function evaluateWeeklyPace(companyId: string, now = new Date()) {
  const s = state(companyId);
  if (!s.observation) return { held: s.held = false, changed: false, delta: null as number | null };
  const delta = weeklyPaceDelta(s.observation, now);
  const before = s.held;
  if (delta > HOLD_ABOVE) s.held = true;
  else if (delta <= RELEASE_AT_OR_BELOW) s.held = false;
  const changed = before !== s.held;
  if (changed) {
    logger.info(
      { companyId, delta: Number(delta.toFixed(2)), usedPercent: s.observation.usedPercent,
        resetsAt: s.observation.resetsAt.toISOString(), source: s.observation.source },
      s.held ? "weekly pace: ahead of pace, holding new runs of pace-held agents"
        : "weekly pace: back under pace, releasing pace-held agents",
    );
  }
  return { held: s.held, changed, delta };
}

export function agentHasWeeklyPaceHold(agent: { runtimeConfig: unknown }): boolean {
  const rc = agent.runtimeConfig;
  if (!rc || typeof rc !== "object") return false;
  const wp = (rc as Record<string, unknown>).weeklyPace;
  return !!wp && typeof wp === "object" && (wp as Record<string, unknown>).hold === true;
}

/** Gate for starting a new run: true means keep it queued. */
export function shouldHoldNewRunForWeeklyPace(
  agent: { companyId: string; runtimeConfig: unknown },
  now = new Date(),
): boolean {
  if (!agentHasWeeklyPaceHold(agent)) return false;
  return evaluateWeeklyPace(agent.companyId, now).held;
}

/**
 * Line scanner for run output: buffers partial lines and records each
 * `rate_limit_event` that carries the seven-day window.
 */
export function createRateLimitEventScanner(companyId: string, now: () => Date = () => new Date()) {
  let buffer = "";
  const MAX_BUFFER = 256 * 1024;
  function line(text: string) {
    if (!text.includes("rate_limit_event")) return;
    const start = text.indexOf("{");
    if (start < 0) return;
    let event: unknown;
    try { event = JSON.parse(text.slice(start)); } catch { return; }
    const observation = observationFromRateLimitEvent(event, now());
    if (observation) recordWeeklyPaceObservation(companyId, observation);
  }
  return {
    push(chunk: string) {
      if (!chunk) return;
      buffer += chunk;
      let nl = buffer.indexOf("\n");
      while (nl >= 0) {
        line(buffer.slice(0, nl));
        buffer = buffer.slice(nl + 1);
        nl = buffer.indexOf("\n");
      }
      // A run that prints a huge line without newlines must not grow memory.
      if (buffer.length > MAX_BUFFER) buffer = buffer.includes("rate_limit_event") ? buffer.slice(-MAX_BUFFER) : "";
    },
  };
}

export function observationFromRateLimitEvent(event: unknown, observedAt: Date): WeeklyPaceObservation | null {
  if (!event || typeof event !== "object") return null;
  const e = event as Record<string, unknown>;
  if (e.type !== "rate_limit_event") return null;
  const info = e.rate_limit_info;
  if (!info || typeof info !== "object") return null;
  const windows = (info as Record<string, unknown>).unifiedWindows;
  if (!windows || typeof windows !== "object") return null;
  const week = (windows as Record<string, unknown>).seven_day;
  if (!week || typeof week !== "object") return null;
  const utilization = (week as Record<string, unknown>).utilization;
  const resetsAt = (week as Record<string, unknown>).resetsAt;
  if (typeof utilization !== "number" || !Number.isFinite(utilization) || utilization < 0) return null;
  if (typeof resetsAt !== "number" || !Number.isFinite(resetsAt) || resetsAt <= 0) return null;
  // Claude Code reports utilization as a fraction of the window (0.11 = 11%).
  return { usedPercent: utilization * 100, resetsAt: new Date(resetsAt * 1000), observedAt, source: "run_output" };
}

type UsageProbe = {
  list(companyId: string, userId: string): Promise<Array<{
    id: string; provider?: string | null; method?: string | null; isDefault?: boolean | null;
    ownerUserId?: string | null; status?: string | null;
  }>>;
  probeUsage(companyId: string, userId: string, connectionId: string): Promise<{
    status?: string; limits?: Array<{ id: string; scope: string | null; usedPercent: number | null; resetsAt: string | null }>;
  }>;
};

/** Companies that have at least one pace-held agent. */
async function companiesWithPaceHeldAgents(db: Db): Promise<string[]> {
  const rows = await db.select({ companyId: agents.companyId, runtimeConfig: agents.runtimeConfig }).from(agents);
  return [...new Set(rows.filter(agentHasWeeklyPaceHold).map(r => r.companyId))];
}

async function probeCompany(db: Db, companyId: string, usage: UsageProbe, now: Date) {
  const owners = await db.select({ userId: companyMemberships.principalId }).from(companyMemberships)
    .where(and(eq(companyMemberships.companyId, companyId), eq(companyMemberships.principalType, "user"),
      eq(companyMemberships.status, "active")));
  for (const { userId } of owners) {
    const connections = await usage.list(companyId, userId).catch(() => []);
    const conn = connections.find(c => c.provider === "anthropic" && c.method === "subscription" && c.isDefault &&
      c.ownerUserId === userId);
    if (!conn) continue;
    const result = await usage.probeUsage(companyId, userId, conn.id);
    const week = result.limits?.find(l => l.id === "seven_day" && l.scope == null);
    if (result.status && result.status !== "ok" && !week) {
      logger.warn({ companyId, status: result.status }, "weekly pace: usage probe returned no weekly window");
      return;
    }
    if (week?.usedPercent != null && week.resetsAt) {
      recordWeeklyPaceObservation(companyId, {
        usedPercent: week.usedPercent, resetsAt: new Date(week.resetsAt), observedAt: now, source: "usage_probe",
      });
    }
    return;
  }
}

/**
 * Periodic work: probe stale companies, re-evaluate holds, and resume queues
 * of companies whose hold was released.
 */
export async function tickWeeklyPace(db: Db, deps: {
  usage: UsageProbe;
  resumeQueuedRuns: () => Promise<unknown>;
  now?: () => Date;
}) {
  const now = deps.now?.() ?? new Date();
  let released = false;
  for (const companyId of await companiesWithPaceHeldAgents(db)) {
    const s = state(companyId);
    const fresh = s.observation && now.getTime() - s.observation.observedAt.getTime() < STALE_AFTER_MS;
    if (!fresh && now.getTime() - s.lastProbeAt >= STALE_AFTER_MS) {
      s.lastProbeAt = now.getTime();
      await probeCompany(db, companyId, deps.usage, now).catch(err =>
        logger.warn({ err, companyId }, "weekly pace: usage probe failed"));
    }
    const { held, changed } = evaluateWeeklyPace(companyId, now);
    if (changed && !held) released = true;
  }
  if (released) await deps.resumeQueuedRuns();
}
