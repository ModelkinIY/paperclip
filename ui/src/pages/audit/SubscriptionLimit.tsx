import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Gauge } from "lucide-react";
import { Link } from "@/lib/router";
import { accountLimitsApi, type AccountLimitView, type AccountLimitWindowView } from "@/api/accountLimits";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ToggleSwitch } from "@/components/ui/toggle-switch";
import { EmptyState } from "@/components/EmptyState";
import { PageSkeleton } from "@/components/PageSkeleton";
import { useOptionalToastActions } from "@/context/ToastContext";
import { cn } from "@/lib/utils";

const PROVIDER_LABEL: Record<string, string> = {
  anthropic: "Claude", openai: "Codex / OpenAI", xai: "Grok", openrouter: "OpenRouter", google: "Google", github: "GitHub",
};
const REASON_LABEL: Record<string, string> = {
  ok: "Within pace", no_limit: "No limit to track", gate_disabled: "Accounting off",
  weekly_ahead_of_pace: "Weekly window ahead of pace", short_window_ahead_of_pace: "5-hour window ahead of pace",
  window_exhausted: "Window exhausted", stale_unknown: "No fresh data",
};
const ROLE_LABEL = { short: "5-hour", weekly: "Weekly", other: "Other" } as const;

export const pct = (n: number | null, digits = 1) => (n == null ? "—" : `${n.toFixed(digits)}%`);
const signed = (n: number | null) => (n == null ? "—" : `${n > 0 ? "+" : ""}${n.toFixed(1)}`);

export function formatUntil(iso: string | null, now = Date.now()) {
  if (!iso) return "—";
  const ms = new Date(iso).getTime() - now;
  if (!Number.isFinite(ms)) return "—";
  if (ms <= 0) return "now";
  const h = Math.floor(ms / 3_600_000);
  if (h >= 48) return `in ${Math.floor(h / 24)} d ${h % 24} h`;
  if (h >= 1) return `in ${h} h ${Math.floor((ms % 3_600_000) / 60_000)} min`;
  return `in ${Math.max(1, Math.round(ms / 60_000))} min`;
}
export function formatAge(iso: string | null, now = Date.now()) {
  if (!iso) return "never";
  const min = Math.round((now - new Date(iso).getTime()) / 60_000);
  if (min < 1) return "just now";
  if (min < 90) return `${min} min ago`;
  return `${Math.round(min / 60)} h ago`;
}

export function statusOf(a: AccountLimitView): { label: string; tone: "ok" | "hold" | "muted" | "warn" } {
  if (!a.limitsSupported) return { label: "No limit", tone: "muted" };
  if (!a.settings.enabled) return { label: "Accounting off", tone: "muted" };
  if (!a.capacity.available) return { label: "Holding", tone: "hold" };
  if (a.capacity.reason === "stale_unknown") return { label: "No fresh data", tone: "warn" };
  return { label: "Passing", tone: "ok" };
}

const TONE = {
  ok: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
  hold: "bg-amber-500/20 text-amber-800 dark:text-amber-200",
  warn: "bg-yellow-500/15 text-yellow-800 dark:text-yellow-200",
  muted: "bg-muted text-muted-foreground",
} as const;

function StatusBadge({ account }: { account: AccountLimitView }) {
  const s = statusOf(account);
  return <span className={cn("rounded px-1.5 py-0.5 text-xs font-medium", TONE[s.tone])} data-testid="limit-status">{s.label}</span>;
}

/** Used share against the share of the window that has passed (the pace line). */
function WindowBar({ w }: { w: AccountLimitWindowView }) {
  const used = Math.max(0, Math.min(100, w.usedPercent ?? 0));
  const expected = w.expectedPercent == null ? null : Math.max(0, Math.min(100, w.expectedPercent));
  return (
    <div className="relative h-2 w-full rounded bg-muted" role="img" aria-label={`Used ${pct(w.usedPercent)}, expected ${pct(w.expectedPercent)}`}>
      <div className={cn("h-2 rounded", w.hold ? "bg-amber-500" : "bg-emerald-500")} style={{ width: `${used}%` }} />
      {expected != null && <div className="absolute top-[-2px] h-3 w-0.5 bg-foreground/70" style={{ left: `${expected}%` }} title={`Expected by pace: ${pct(expected)}`} />}
    </div>
  );
}

function Sparkline({ account }: { account: AccountLimitView }) {
  const id = account.capacity.windows.find((w) => w.role === "weekly")?.id ?? account.capacity.windows[0]?.id;
  const points = account.history.map((h) => h.windows.find((w) => w.id === id)?.usedPercent).filter((v): v is number => v != null);
  if (points.length < 2) return <div className="text-xs text-muted-foreground">Not enough measurements yet.</div>;
  const max = Math.max(100, ...points);
  const path = points.map((v, i) => `${i === 0 ? "M" : "L"}${((i / (points.length - 1)) * 200).toFixed(1)},${(40 - (v / max) * 40).toFixed(1)}`).join(" ");
  return (
    <svg viewBox="0 0 200 40" className="h-10 w-full" role="img" aria-label="Used share over recent measurements">
      <path d={path} fill="none" stroke="currentColor" strokeWidth="1.5" className="text-foreground/70" />
    </svg>
  );
}

function ParamsEditor(props: {
  title: string; value: { holdAbove: number; releaseAtOrBelow: number }; disabled: boolean;
  onSave: (v: { holdAbove: number; releaseAtOrBelow: number }) => void;
}) {
  const [hold, setHold] = useState(String(props.value.holdAbove));
  const [release, setRelease] = useState(String(props.value.releaseAtOrBelow));
  useEffect(() => { setHold(String(props.value.holdAbove)); setRelease(String(props.value.releaseAtOrBelow)); }, [props.value.holdAbove, props.value.releaseAtOrBelow]);
  const h = Number(hold), r = Number(release);
  const valid = hold.trim() !== "" && release.trim() !== "" && Number.isFinite(h) && Number.isFinite(r) && r <= h;
  const dirty = h !== props.value.holdAbove || r !== props.value.releaseAtOrBelow;
  return (
    <div className="flex flex-wrap items-end gap-2" data-testid={`params-${props.title}`}>
      <div className="w-28 text-sm font-medium">{props.title}</div>
      <label className="text-xs text-muted-foreground">Hold above
        <Input className="mt-1 h-8 w-20" inputMode="decimal" value={hold} onChange={(e) => setHold(e.target.value)} disabled={props.disabled} aria-label={`${props.title} hold above`} />
      </label>
      <label className="text-xs text-muted-foreground">Release at or below
        <Input className="mt-1 h-8 w-20" inputMode="decimal" value={release} onChange={(e) => setRelease(e.target.value)} disabled={props.disabled} aria-label={`${props.title} release at or below`} />
      </label>
      <Button size="xs" variant="outline" disabled={props.disabled || !valid || !dirty} onClick={() => props.onSave({ holdAbove: h, releaseAtOrBelow: r })}>Save</Button>
      {!valid && <span className="text-xs text-destructive">Release must not exceed hold.</span>}
    </div>
  );
}

function Details(props: {
  account: AccountLimitView; busy: boolean;
  onPatch: (patch: Parameters<typeof accountLimitsApi.update>[2]) => void; onRefresh: () => void;
}) {
  const a = props.account;
  const c = a.capacity;
  return (
    <div className="space-y-5" data-testid="limit-details">
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="text-base font-semibold">{a.accountName}</h2>
        <StatusBadge account={a} />
        <span className="text-sm text-muted-foreground">{REASON_LABEL[c.reason] ?? c.reason}</span>
        {c.heldUntil && !c.available && <span className="text-sm text-muted-foreground">until {formatUntil(c.heldUntil)}</span>}
      </div>

      {!a.limitsSupported ? (
        <p className="text-sm text-muted-foreground">This account has no subscription limit to track, so it never holds work.</p>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-3">
            <ToggleSwitch checked={a.settings.enabled} disabled={props.busy} onCheckedChange={(enabled) => props.onPatch({ enabled })} aria-label="Limit accounting" />
            <span className="text-sm">Limit accounting {a.settings.enabled ? "on" : "off"}</span>
            <Button size="xs" variant="outline" disabled={props.busy} onClick={props.onRefresh}>Refresh measurement</Button>
            <span className="text-xs text-muted-foreground">
              Measured {formatAge(c.observedAt)}{c.source ? ` · ${c.source.replace("_", " ")}` : ""}
            </span>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr className="text-left text-xs text-muted-foreground">
                <th className="py-1 pr-3">Window</th><th className="pr-3">Used</th><th className="pr-3">Expected</th>
                <th className="pr-3">Delta</th><th className="pr-3">Resets</th><th className="w-40">Pace</th>
              </tr></thead>
              <tbody>
                {c.windows.length === 0 && <tr><td colSpan={6} className="py-3 text-muted-foreground">No measurement yet.</td></tr>}
                {c.windows.map((w) => (
                  <tr key={`${w.id}:${w.scope ?? ""}`} className="border-t">
                    <td className="py-1.5 pr-3">{w.label}{w.scope ? ` · ${w.scope}` : ""} <span className="text-xs text-muted-foreground">{ROLE_LABEL[w.role]}</span></td>
                    <td className="pr-3">{pct(w.usedPercent)}</td>
                    <td className="pr-3">{pct(w.expectedPercent)}</td>
                    <td className={cn("pr-3", w.hold && "font-medium text-amber-700 dark:text-amber-300")}>{signed(w.delta)}</td>
                    <td className="pr-3">{formatUntil(w.resetsAt)}</td>
                    <td>{w.usedPercent != null ? <WindowBar w={w} /> : null}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div><div className="mb-1 text-xs text-muted-foreground">Used share, recent measurements</div><Sparkline account={a} /></div>

          <div className="space-y-3">
            <div className="flex items-center gap-2 text-sm">
              <span className="font-medium">Pace model</span>
              <select className="h-8 rounded border bg-background px-2 text-sm" value={a.settings.paceModel} disabled={props.busy}
                onChange={(e) => props.onPatch({ paceModel: e.target.value })} aria-label="Pace model">
                {[...new Set([a.settings.paceModel, ...a.paceModels])].map((m) => <option key={m} value={m}>{m}</option>)}
              </select>
            </div>
            <ParamsEditor title="Weekly" value={a.settings.weekly} disabled={props.busy} onSave={(weekly) => props.onPatch({ weekly })} />
            <ParamsEditor title="5-hour" value={a.settings.fiveHour} disabled={props.busy} onSave={(fiveHour) => props.onPatch({ fiveHour })} />
            <p className="text-xs text-muted-foreground">
              Delta is used share minus the share of the window that has passed. New runs wait while it is above “hold above” and start again at or below “release at or below”. Running work is never interrupted.
            </p>
          </div>
        </>
      )}

      <div className="grid gap-4 md:grid-cols-2">
        <div>
          <div className="mb-1 text-sm font-medium">Agents on this account ({a.agents.length})</div>
          {a.agents.length === 0 ? <p className="text-xs text-muted-foreground">None bound.</p> : (
            <ul className="space-y-0.5 text-sm">{a.agents.map((ag) => (
              <li key={ag.id}><Link to={`/agents/${ag.id}`} className="hover:underline">{ag.name}</Link>
                {ag.via === "responsible_user" && <span className="text-xs text-muted-foreground"> · via responsible user's default</span>}</li>
            ))}</ul>
          )}
        </div>
        <div>
          <div className="mb-1 text-sm font-medium">Runs waiting for this account ({a.queuedRuns.length})</div>
          {a.queuedRuns.length === 0 ? <p className="text-xs text-muted-foreground">Nothing is waiting.</p> : (
            <ul className="space-y-0.5 text-sm">{a.queuedRuns.map((r) => (
              <li key={r.id}><Link to={`/agents/${r.agentId}/runs/${r.id}`} className="hover:underline">Run {r.id.slice(0, 8)}</Link>
                <span className="text-xs text-muted-foreground"> · waiting {formatAge(r.since).replace(" ago", "")}</span></li>
            ))}</ul>
          )}
        </div>
      </div>
    </div>
  );
}

/** inferdyne fork: Activity → Subscription limit. One row per AI account (grant), grouped by provider. */
export function SubscriptionLimit({ companyId }: { companyId: string }) {
  const queryClient = useQueryClient();
  const toast = useOptionalToastActions();
  const key = ["account-limits", companyId];
  const list = useQuery({ queryKey: key, queryFn: () => accountLimitsApi.list(companyId), refetchInterval: 15_000 });
  const [selected, setSelected] = useState<string | null>(null);

  const accounts = list.data ?? [];
  const groups = useMemo(() => {
    const map = new Map<string, AccountLimitView[]>();
    for (const a of accounts) map.set(a.provider, [...(map.get(a.provider) ?? []), a]);
    return [...map.entries()];
  }, [accounts]);
  const current = accounts.find((a) => a.grantId === selected) ?? accounts.find((a) => a.limitsSupported) ?? accounts[0] ?? null;

  const fail = (title: string) => (err: unknown) =>
    toast?.pushToast({ title, body: err instanceof Error ? err.message : String(err), tone: "error" });
  const update = useMutation({
    mutationFn: (v: { grantId: string; patch: Parameters<typeof accountLimitsApi.update>[2] }) => accountLimitsApi.update(companyId, v.grantId, v.patch),
    onError: fail("Couldn't save the limit settings."),
    onSettled: () => queryClient.invalidateQueries({ queryKey: key }),
  });
  const refresh = useMutation({
    mutationFn: (grantId: string) => accountLimitsApi.refresh(companyId, grantId),
    onError: fail("Couldn't take a measurement."),
    onSettled: () => queryClient.invalidateQueries({ queryKey: key }),
  });

  if (list.isLoading) return <PageSkeleton variant="list" />;
  if (list.error) return <p className="p-4 text-sm text-destructive">{list.error instanceof Error ? list.error.message : "Couldn't load accounts."}</p>;
  if (accounts.length === 0) {
    return <EmptyState icon={Gauge} message="No AI accounts are connected yet. Connect a subscription to track its limits." />;
  }

  return (
    <div className="grid gap-6 md:grid-cols-[18rem_1fr]" data-testid="subscription-limit">
      <nav aria-label="AI accounts" className="space-y-4">
        {groups.map(([provider, items]) => (
          <div key={provider}>
            <div className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">{PROVIDER_LABEL[provider] ?? provider}</div>
            <ul className="space-y-1">
              {items.map((a) => (
                <li key={a.grantId}>
                  <div className={cn("flex items-center gap-2 rounded border px-2 py-1.5", current?.grantId === a.grantId && "border-foreground/40 bg-accent/40")}>
                    <button type="button" className="min-w-0 flex-1 text-left" onClick={() => setSelected(a.grantId)} aria-current={current?.grantId === a.grantId}>
                      <div className="truncate text-sm font-medium">{a.accountName}</div>
                      <div className="mt-0.5 flex items-center gap-1.5"><StatusBadge account={a} />
                        {a.capacity.headroom != null && a.limitsSupported && <span className="text-xs text-muted-foreground">{pct(a.capacity.headroom, 0)} left</span>}</div>
                    </button>
                    {a.limitsSupported && (
                      <ToggleSwitch checked={a.settings.enabled} disabled={update.isPending}
                        onCheckedChange={(enabled) => update.mutate({ grantId: a.grantId, patch: { enabled } })} aria-label={`Limit accounting: ${a.accountName}`} />
                    )}
                  </div>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </nav>
      {current && (
        <Details account={current} busy={update.isPending || refresh.isPending}
          onPatch={(patch) => update.mutate({ grantId: current.grantId, patch })} onRefresh={() => refresh.mutate(current.grantId)} />
      )}
    </div>
  );
}
