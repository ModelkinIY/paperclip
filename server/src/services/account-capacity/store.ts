import type { AiAuthMethod, AiProvider } from "@paperclipai/shared";
import { evaluateObservation, type HeldState } from "./evaluate.js";
import { policyFor } from "./policies/index.js";
import { DEFAULT_LIMIT_SETTINGS, type Capacity, type LimitSettings, type Observation } from "./types.js";

export interface LimitSettingsStore {
  get(grantId: string): LimitSettings;
  /** True when accounting is on for at least one grant (lets hot paths skip all work otherwise). */
  anyEnabled(): boolean;
}

export class InMemoryLimitSettingsStore implements LimitSettingsStore {
  private map = new Map<string, LimitSettings>();
  get(grantId: string): LimitSettings {
    return this.map.get(grantId) ?? DEFAULT_LIMIT_SETTINGS;
  }
  set(grantId: string, settings: LimitSettings) {
    this.map.set(grantId, settings);
  }
  clear() {
    this.map.clear();
  }
  /** Swap the whole content at once, so readers never see a half-loaded table. */
  replaceAll(entries: Map<string, LimitSettings>) {
    this.map = entries;
  }
  anyEnabled(): boolean {
    for (const v of this.map.values()) if (v.enabled) return true;
    return false;
  }
}

interface Entry {
  observation: Observation;
  held: HeldState;
  history: Array<{ at: Date; windows: Array<{ id: string; usedPercent: number | null }> }>;
}

const HISTORY_LIMIT = 200;
/** One history point per this long; events can arrive many times a minute. */
const HISTORY_MIN_GAP_MS = 5 * 60_000;
/** Observations closer than this are parts of one picture. */
const MERGE_WITHIN_MS = 30 * 60_000;

/** Latest observation per grant plus the hysteresis state. */
export class AccountCapacityStore {
  private readonly entries = new Map<string, Entry>();

  constructor(private readonly settings: LimitSettingsStore) {}

  /**
   * The newest observation wins; an older one never replaces it. A partial
   * observation (an event that carries only one window) keeps the windows it
   * does not mention from the previous, still fresh, observation.
   */
  record(grantId: string, observation: Observation) {
    const entry = this.entries.get(grantId);
    if (entry && entry.observation.observedAt.getTime() > observation.observedAt.getTime()) return;
    let merged = observation;
    if (entry && observation.observedAt.getTime() - entry.observation.observedAt.getTime() < MERGE_WITHIN_MS) {
      const key = (w: { id: string; scope: string | null }) => `${w.id}\u0000${w.scope ?? ""}`;
      const seen = new Set(observation.windows.map(key));
      const carried = entry.observation.windows.filter((w) => !seen.has(key(w)) && (!w.resetsAt || w.resetsAt > observation.observedAt));
      if (carried.length > 0) merged = { ...observation, windows: [...observation.windows, ...carried] };
    }
    const history = entry?.history ?? [];
    const last = history[history.length - 1];
    if (!last || observation.observedAt.getTime() - last.at.getTime() >= HISTORY_MIN_GAP_MS) {
      history.push({ at: observation.observedAt, windows: merged.windows.map((w) => ({ id: w.id, usedPercent: w.usedPercent })) });
      if (history.length > HISTORY_LIMIT) history.splice(0, history.length - HISTORY_LIMIT);
    }
    this.entries.set(grantId, { observation: merged, held: entry?.held ?? {}, history });
  }

  /** Cheap check for hot paths: no account has accounting on. */
  anyEnabled(): boolean {
    return this.settings.anyEnabled();
  }

  observationOf(grantId: string): Observation | null {
    return this.entries.get(grantId)?.observation ?? null;
  }

  historyOf(grantId: string) {
    return this.entries.get(grantId)?.history ?? [];
  }

  /** Whether a fresh observation exists (to decide on probing). */
  isFresh(grantId: string, maxAgeMs: number, now = new Date()): boolean {
    const o = this.entries.get(grantId)?.observation;
    return !!o && now.getTime() - o.observedAt.getTime() < maxAgeMs;
  }

  getCapacity(grantId: string, provider: AiProvider, method: AiAuthMethod, now = new Date()): Capacity {
    const settings = this.settings.get(grantId);
    const policy = policyFor(provider, method);
    const base = { grantId, provider, method };
    const entry = this.entries.get(grantId);
    if (policy.id === "no-limit") {
      return { ...base, available: true, headroom: null, reason: "no_limit", windows: [], observedAt: null, source: null, heldUntil: null };
    }
    const stale = !entry || now.getTime() - entry.observation.observedAt.getTime() > settings.maxStaleMinutes * 60_000;
    if (!entry || stale) {
      // Unknown must never stop work; the next reading starts without an old hold.
      if (entry) entry.held = {};
      return {
        ...base, available: true, headroom: null, reason: settings.enabled ? "stale_unknown" : "gate_disabled",
        windows: [], observedAt: entry?.observation.observedAt ?? null, source: entry?.observation.source ?? null, heldUntil: null,
      };
    }
    const result = evaluateObservation(entry.observation, policy, settings, entry.held, now);
    entry.held = result.nextHeld;
    const { nextHeld: _unused, ...rest } = result;
    return { ...base, ...rest, observedAt: entry.observation.observedAt, source: entry.observation.source };
  }
}
