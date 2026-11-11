/** Persisted on a queued run's contextSnapshot.aiLimitWait while its AI account is over its limit pace. */
export interface AiLimitRunWait {
  grantId: string;
  provider: string;
  accountName: string | null;
  reason: string;
  /** ISO time the holding window resets, when known. */
  heldUntil: string | null;
  since: string;
}

export function readAiLimitRunWait(contextSnapshot: unknown): AiLimitRunWait | null {
  if (!contextSnapshot || typeof contextSnapshot !== "object") return null;
  const raw = (contextSnapshot as Record<string, unknown>).aiLimitWait;
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.grantId !== "string" || typeof r.reason !== "string") return null;
  return {
    grantId: r.grantId,
    provider: typeof r.provider === "string" ? r.provider : "",
    accountName: typeof r.accountName === "string" ? r.accountName : null,
    reason: r.reason,
    heldUntil: typeof r.heldUntil === "string" ? r.heldUntil : null,
    since: typeof r.since === "string" ? r.since : "",
  };
}
