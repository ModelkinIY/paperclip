import type { AiAuthMethod, AiProvider } from "@paperclipai/shared";
import { evaluateObservation, type HeldState } from "./evaluate.js";
import { policyFor } from "./policies/index.js";
import { DEFAULT_LIMIT_SETTINGS, type Capacity, type LimitSettings, type Observation } from "./types.js";

export interface LimitSettingsStore {
  get(grantId: string): LimitSettings;
}

export class InMemoryLimitSettingsStore implements LimitSettingsStore {
  private readonly map = new Map<string, LimitSettings>();
  get(grantId: string): LimitSettings {
    return this.map.get(grantId) ?? DEFAULT_LIMIT_SETTINGS;
  }
  set(grantId: string, settings: LimitSettings) {
    this.map.set(grantId, settings);
  }
}

interface Entry {
  observation: Observation;
  held: HeldState;
  history: Array<{ at: Date; windows: Array<{ id: string; usedPercent: number | null }> }>;
}

const HISTORY_LIMIT = 200;

/** Latest observation per grant plus the hysteresis state. */
export class AccountCapacityStore {
  private readonly entries = new Map<string, Entry>();

  constructor(private readonly settings: LimitSettingsStore) {}

  /** The newest observation wins; an older one never replaces it. */
  record(grantId: string, observation: Observation) {
    const entry = this.entries.get(grantId);
    if (entry && entry.observation.observedAt.getTime() > observation.observedAt.getTime()) return;
    const history = entry?.history ?? [];
    history.push({ at: observation.observedAt, windows: observation.windows.map((w) => ({ id: w.id, usedPercent: w.usedPercent })) });
    if (history.length > HISTORY_LIMIT) history.splice(0, history.length - HISTORY_LIMIT);
    this.entries.set(grantId, { observation, held: entry?.held ?? {}, history });
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
      // Unknown must never stop work.
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
