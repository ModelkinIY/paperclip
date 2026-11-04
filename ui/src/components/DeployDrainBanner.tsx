import { useEffect, useState } from "react";

/** inferdyne fork: banner while a board upgrade is planned (deploy/upgrade.sh, GET /api/deploy-drain). */
type DeployDrain = { active: boolean; target: string | null; since: string | null; expiresAt: string | null };

export const DEPLOY_DRAIN_POLL_MS = 20_000;

export function DeployDrainBanner() {
  const [state, setState] = useState<DeployDrain | null>(null);
  useEffect(() => {
    let stopped = false;
    const poll = async () => {
      try {
        const response = await fetch("/api/deploy-drain", { credentials: "same-origin", cache: "no-store" });
        if (response.ok && !stopped) setState(await response.json() as DeployDrain);
      } catch { /* the connection banner covers outages */ }
    };
    void poll();
    const timer = window.setInterval(poll, DEPLOY_DRAIN_POLL_MS);
    return () => { stopped = true; window.clearInterval(timer); };
  }, []);
  if (!state?.active) return null;
  const since = state.since ? new Date(state.since).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : null;
  return (
    <div className="pointer-events-none fixed inset-x-0 top-2 z-(--z-120) flex justify-center px-2">
      <div
        role="status"
        aria-live="polite"
        className="pointer-events-auto rounded-full border border-amber-500/40 bg-amber-100 px-4 py-1.5 text-center text-sm text-amber-900 shadow-sm dark:bg-amber-950 dark:text-amber-100"
      >
        Запланирована выкладка доски{state.target ? ` (${state.target})` : ""}{since ? `, с ${since}` : ""}: агенты остановятся в начале следующего шага,
        начатые шаги доработают.
      </div>
    </div>
  );
}
