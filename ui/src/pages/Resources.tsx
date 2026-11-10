import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ISSUE_STATUSES, type IssueStatus } from "@paperclipai/shared";
import { Lock } from "lucide-react";
import { Link } from "@/lib/router";
import { podMutexApi, type PodMutexEntry } from "../api/podMutex";
import { issuesApi } from "../api/issues";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { ToggleSwitch } from "../components/ui/toggle-switch";
import { cn } from "../lib/utils";
import { useOptionalToastActions } from "../context/ToastContext";

/**
 * inferdyne fork: shared resources (GPU pods) locked via labels — pod mutex.
 * Put the label on a ROOT issue; its whole subtree shares the lease.
 */
export function Resources() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();
  const companyId = selectedCompanyId ?? "";
  const listKey = ["pod-mutexes", companyId];

  useEffect(() => {
    setBreadcrumbs([{ label: "Resources" }]);
  }, [setBreadcrumbs]);

  const list = useQuery({
    queryKey: listKey,
    queryFn: () => podMutexApi.list(companyId),
    enabled: Boolean(selectedCompanyId),
    refetchInterval: 15_000,
  });
  const labels = useQuery({
    queryKey: ["labels", companyId],
    queryFn: () => issuesApi.listLabels(companyId),
    enabled: Boolean(selectedCompanyId),
  });
  const invalidate = () => queryClient.invalidateQueries({ queryKey: listKey });

  const toast = useOptionalToastActions();
  const reportError = (title: string) => (err: unknown) => {
    toast?.pushToast({ title, body: err instanceof Error ? err.message : String(err), tone: "error" });
  };

  const update = useMutation({
    mutationFn: (v: { labelId: string; holdingStatuses?: IssueStatus[]; enabled?: boolean }) =>
      podMutexApi.update(companyId, v.labelId, v),
    onError: reportError("Couldn't update the mutex label."),
    onSettled: invalidate,
  });
  const release = useMutation({
    mutationFn: (labelId: string) => podMutexApi.release(companyId, labelId),
    onSuccess: (res) => {
      if (res?.holderHasRunningRun) {
        toast?.pushToast({
          title: "Released, but the former holder still has a running run.",
          body: "That run keeps using the resource until it finishes; the next waiter may collide with it.",
          tone: "warn",
        });
      }
    },
    onError: reportError("Couldn't release the resource."),
    onSettled: invalidate,
  });
  const remove = useMutation({
    mutationFn: (labelId: string) => podMutexApi.remove(companyId, labelId),
    onError: reportError("Couldn't remove the mutex label."),
    onSettled: invalidate,
  });
  const create = useMutation({
    mutationFn: (v: { labelId?: string; labelName?: string }) => podMutexApi.create(companyId, v),
    onError: reportError("Couldn't add the mutex label."),
    onSettled: () => {
      void invalidate();
      void queryClient.invalidateQueries({ queryKey: ["labels", companyId] });
    },
  });

  const [newLabel, setNewLabel] = useState("");
  const configured = new Set((list.data ?? []).map((e) => e.labelId));
  const freeLabels = (labels.data ?? []).filter((l) => !configured.has(l.id));

  const submitNew = () => {
    const name = newLabel.trim();
    if (!name) return;
    const existing = (labels.data ?? []).find((l) => l.name === name);
    create.mutate(existing ? { labelId: existing.id } : { labelName: name });
    setNewLabel("");
  };

  const errorMessage = (err: unknown) => (err instanceof Error ? err.message : String(err));

  if (!selectedCompanyId) {
    return <EmptyState icon={Lock} message="Select an organization to view resources." />;
  }

  if (list.isLoading) {
    return <PageSkeleton variant="list" />;
  }

  return (
    <div className="min-w-0 space-y-6">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">Resources</h1>
        <p className="text-sm text-muted-foreground">
          A mutex label (e.g. <code>pod:igor-3090</code>) on a root issue locks the resource for that whole issue
          tree. Other trees with the same label wait (their runs stay queued) until the holder tree has no issues in
          the holding statuses. If a tree carries several mutex labels, the one nearest to the issue wins.
        </p>
      </div>

      {list.error ? (
        <p role="alert" className="text-sm text-destructive">{errorMessage(list.error)}</p>
      ) : null}
      {labels.error ? (
        <p role="alert" className="text-sm text-destructive">
          Couldn't load existing labels for suggestions: {errorMessage(labels.error)}
        </p>
      ) : null}

      <div className="flex flex-col gap-3">
        {(list.data ?? []).length === 0 ? (
          <EmptyState
            icon={Lock}
            message="No mutex labels configured"
            description="The feature is inactive until you add one below."
          />
        ) : null}
        {(list.data ?? []).map((entry) => (
          <MutexRow
            key={entry.labelId}
            entry={entry}
            onToggleStatus={(status) => {
              const on = entry.holdingStatuses.includes(status);
              if (on && entry.holdingStatuses.length <= 1) return;
              const next = on
                ? entry.holdingStatuses.filter((s) => s !== status)
                : [...entry.holdingStatuses, status];
              update.mutate({ labelId: entry.labelId, holdingStatuses: next });
            }}
            onToggleEnabled={(enabled) => update.mutate({ labelId: entry.labelId, enabled })}
            onRelease={() => {
              if (window.confirm(`Force-release "${entry.labelName}"? The holder tree loses the resource.`)) {
                release.mutate(entry.labelId);
              }
            }}
            onRemove={() => {
              if (window.confirm(`Stop using "${entry.labelName}" as a mutex? The label itself stays.`)) {
                remove.mutate(entry.labelId);
              }
            }}
          />
        ))}
      </div>

      <form
        className="flex flex-wrap items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          submitNew();
        }}
      >
        <Input
          aria-label="Mutex label name"
          list="pod-mutex-labels"
          value={newLabel}
          onChange={(e) => setNewLabel(e.target.value)}
          placeholder="Label name, e.g. pod:igor-3090"
          className="flex-1 sm:max-w-sm"
        />
        <datalist id="pod-mutex-labels">
          {freeLabels.map((l) => (
            <option key={l.id} value={l.name} />
          ))}
        </datalist>
        <Button type="submit" size="sm" disabled={!newLabel.trim() || create.isPending}>
          Add mutex label
        </Button>
      </form>
    </div>
  );
}

export const POD_MUTEX_STALE_MS = 30 * 60_000;

export function formatHeldDuration(ms: number) {
  const minutes = Math.max(0, Math.floor(ms / 60_000));
  if (minutes < 1) return "<1m";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

function MutexRow(props: {
  entry: PodMutexEntry;
  onToggleStatus: (status: IssueStatus) => void;
  onToggleEnabled: (enabled: boolean) => void;
  onRelease: () => void;
  onRemove: () => void;
}) {
  const { entry } = props;
  const holder = entry.holder;
  const now = Date.now();
  const heldMs = holder ? now - new Date(holder.acquiredAt).getTime() : 0;
  const lastActivity = holder ? new Date(holder.lastRunActivityAt ?? holder.acquiredAt).getTime() : now;
  const stale = Boolean(holder && holder.stillHolding && !holder.hasRunningRun && now - lastActivity > POD_MUTEX_STALE_MS);
  const hintId = `pod-mutex-hint-${entry.labelId}`;
  const lastOnly = entry.holdingStatuses.length <= 1;
  return (
    <section className="flex min-w-0 flex-col gap-3 rounded-md border p-3 text-sm" data-testid="pod-mutex-row">
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
        <span className="inline-flex min-w-0 items-center gap-2">
          <span className="size-2.5 shrink-0 rounded-full" style={{ backgroundColor: entry.labelColor }} />
          <span className="truncate font-medium">{entry.labelName}</span>
        </span>
        <div className="flex flex-wrap items-center gap-2">
          <ToggleSwitch checked={entry.enabled} onCheckedChange={props.onToggleEnabled} aria-label={`Enabled: ${entry.labelName}`} />
          <Button size="xs" variant="outline" disabled={!holder} onClick={props.onRelease} aria-label={`Release ${entry.labelName}`}>
            Release
          </Button>
          <Button size="xs" variant="ghost" onClick={props.onRemove} aria-label={`Remove ${entry.labelName}`}>
            Remove
          </Button>
        </div>
      </div>
      <div className="min-w-0 break-words">
        {holder ? (
          <span>
            held by{" "}
            <Link to={`/issues/${holder.identifier ?? holder.rootIssueId}`} className="underline">
              {holder.identifier ?? holder.rootIssueId.slice(0, 8)}
            </Link>{" "}
            <span title={new Date(holder.acquiredAt).toLocaleString()}>for {formatHeldDuration(heldMs)}</span>
            {!holder.stillHolding ? <span className="text-muted-foreground"> (releasing)</span> : null}
          </span>
        ) : (
          <span className="text-muted-foreground">free</span>
        )}
        {stale ? (
          <div role="alert" className="mt-1 text-xs text-(--status-task-icon-todo)">
            Warning: the holder tree has had no running run for over 30 min — check it, or force-release.
          </div>
        ) : null}
      </div>
      <div className="min-w-0">
        <div className="mb-1 text-xs text-muted-foreground">Waiting</div>
        {entry.waiting.length === 0 ? (
          <span className="text-muted-foreground">—</span>
        ) : (
          <ol className="flex flex-col gap-0.5">
            {entry.waiting.map((w) => (
              <li key={w.issueId} className="min-w-0 truncate">
                <Link to={`/issues/${w.identifier ?? w.issueId}`} className="underline">
                  {w.identifier ?? w.issueId.slice(0, 8)}
                </Link>{" "}
                <span className="text-xs text-muted-foreground">
                  {w.priority}
                  {w.hasQueuedRun ? ", queued run" : ""}
                </span>
              </li>
            ))}
          </ol>
        )}
      </div>
      <div className="min-w-0">
        <div className="mb-1 text-xs text-muted-foreground">Holding statuses</div>
        <div className="flex flex-wrap gap-1">
          {ISSUE_STATUSES.map((status) => {
            const on = entry.holdingStatuses.includes(status);
            const locked = on && lastOnly;
            return (
              <button
                key={status}
                type="button"
                aria-pressed={on}
                aria-disabled={locked || undefined}
                aria-describedby={locked ? hintId : undefined}
                onClick={() => {
                  if (!locked) props.onToggleStatus(status);
                }}
                className={cn(
                  "rounded-full border px-2 py-0.5 text-xs",
                  on ? "border-primary bg-primary/10 text-foreground" : "text-muted-foreground",
                  locked && "cursor-not-allowed opacity-70",
                )}
              >
                {status}
              </button>
            );
          })}
        </div>
        {lastOnly ? (
          <p id={hintId} className="mt-1 text-xs text-muted-foreground">At least one holding status is required.</p>
        ) : null}
      </div>
    </section>
  );
}
