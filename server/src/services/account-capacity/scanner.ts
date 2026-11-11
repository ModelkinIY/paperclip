import { observationFromRateLimitEvent } from "./normalize.js";
import type { Observation } from "./types.js";

/**
 * Line scanner for run stdout: buffers partial lines and reports each
 * `rate_limit_event`. The account is resolved lazily because it is only known
 * once the run's AI connection has been selected.
 */
export function createAccountRateLimitScanner(
  resolveGrantId: () => string | null | undefined,
  record: (grantId: string, observation: Observation) => void,
  now: () => Date = () => new Date(),
) {
  let buffer = "";
  const MAX_BUFFER = 256 * 1024;
  function line(text: string) {
    if (!text.includes("rate_limit_event")) return;
    const start = text.indexOf("{");
    if (start < 0) return;
    let event: unknown;
    try { event = JSON.parse(text.slice(start)); } catch { return; }
    const observation = observationFromRateLimitEvent(event, now());
    if (!observation) return;
    const grantId = resolveGrantId();
    if (grantId) record(grantId, observation);
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
