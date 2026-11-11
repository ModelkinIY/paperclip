import type { AiAuthMethod, AiProvider } from "@paperclipai/shared";
import { roleByDuration, type LimitPolicy } from "./policy.js";

export type { LimitPolicy } from "./policy.js";

export const claudeSubscriptionPolicy: LimitPolicy = {
  id: "claude-subscription",
  roleOf: (w) => {
    if (w.scope !== null) return "other"; // per-model windows are shown, not gated
    if (w.id === "five_hour") return "short";
    if (w.id === "seven_day") return "weekly";
    return "other";
  },
};

export const codexSubscriptionPolicy: LimitPolicy = {
  id: "codex-subscription",
  roleOf: (w) => (w.scope === null && w.id.startsWith("codex.") ? roleByDuration(w) : "other"),
};

export const grokSubscriptionPolicy: LimitPolicy = {
  id: "grok-subscription",
  // One billing-period window; its own duration drives the pace.
  roleOf: (w) => (w.scope === null && w.id === "grok_credits" ? "weekly" : "other"),
};

export const noLimitPolicy: LimitPolicy = { id: "no-limit", roleOf: () => "other" };

export function policyFor(provider: AiProvider, method: AiAuthMethod): LimitPolicy {
  if (method !== "subscription") return noLimitPolicy;
  if (provider === "anthropic") return claudeSubscriptionPolicy;
  if (provider === "openai") return codexSubscriptionPolicy;
  if (provider === "xai") return grokSubscriptionPolicy;
  return noLimitPolicy;
}
