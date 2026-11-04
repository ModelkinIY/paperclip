/**
 * Deploy drain (inferdyne fork).
 *
 * deploy/upgrade.sh writes a small JSON file before a board upgrade. While it
 * exists and has not expired, no agent starts a new run: running runs finish,
 * new ones stay queued. The UI shows a banner. The script removes the file once
 * the new server is healthy (or after a rollback); the expiry keeps the board
 * from staying held if the script dies.
 *
 * File: PAPERCLIP_DEPLOY_DRAIN_FILE, default /paperclip/deploy-drain.json
 *   {"target": "paperclip-inf:abc1234", "since": "<ISO>", "expiresAt": "<ISO>"}
 */
import { readFileSync } from "node:fs";

export interface DeployDrainState {
  active: boolean;
  target: string | null;
  since: string | null;
  expiresAt: string | null;
}

const CACHE_MS = 3_000;
const INACTIVE: DeployDrainState = { active: false, target: null, since: null, expiresAt: null };
let cache: { at: number; state: DeployDrainState } | null = null;

export function deployDrainFile() {
  return process.env.PAPERCLIP_DEPLOY_DRAIN_FILE?.trim() || "/paperclip/deploy-drain.json";
}

export function parseDeployDrain(raw: string | null, now: Date): DeployDrainState {
  if (raw == null) return INACTIVE;
  let value: unknown;
  try { value = JSON.parse(raw); } catch { value = {}; }
  const v = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
  const str = (x: unknown) => (typeof x === "string" && x.length > 0 && x.length < 200 ? x : null);
  const expiresAt = str(v.expiresAt);
  const expiry = expiresAt ? Date.parse(expiresAt) : NaN;
  // No valid expiry — not a drain: a malformed file must never hold the board.
  if (!Number.isFinite(expiry) || now.getTime() >= expiry) return INACTIVE;
  return {
    active: true,
    target: str(v.target),
    since: str(v.since),
    expiresAt: new Date(expiry).toISOString(),
  };
}

export function readDeployDrain(now = new Date(), file = deployDrainFile()): DeployDrainState {
  if (cache && now.getTime() - cache.at < CACHE_MS) return cache.state;
  let raw: string | null = null;
  try { raw = readFileSync(file, "utf8").slice(0, 4096); } catch { raw = null; }
  const state = parseDeployDrain(raw, now);
  cache = { at: now.getTime(), state };
  return state;
}

export function resetDeployDrainCacheForTests() {
  cache = null;
}

/** Gate for starting a new run of any agent. */
export function shouldHoldNewRunForDeploy(now = new Date()): boolean {
  return readDeployDrain(now).active;
}
