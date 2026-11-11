import type { AiAuthMethod, AiProvider } from "@paperclipai/shared";
import type { AccountCapacityStore } from "./store.js";

export interface PoolCandidateAccount { grantId: string; provider: AiProvider; method: AiAuthMethod }

/**
 * Keeps the pool members whose account may take new work. Accounts without
 * accounting or without limits always stay. When every account is held, none
 * is returned and `retryAt` is the earliest moment one is expected back.
 */
export function filterByAccountLimit<T>(
  candidates: T[],
  accountOf: (candidate: T) => PoolCandidateAccount,
  store: AccountCapacityStore,
  now = new Date(),
): { open: T[]; retryAt: Date | null } {
  const open: T[] = [];
  let retryAt: Date | null = null;
  for (const candidate of candidates) {
    const a = accountOf(candidate);
    const cap = store.getCapacity(a.grantId, a.provider, a.method, now);
    if (cap.available) { open.push(candidate); continue; }
    if (cap.heldUntil && (!retryAt || cap.heldUntil < retryAt)) retryAt = cap.heldUntil;
  }
  return { open, retryAt };
}
