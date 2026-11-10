import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ISSUE_STATUSES, type IssueStatus } from "@paperclipai/shared";
import { Link } from "@/lib/router";
import { podMutexApi, type PodMutexEntry } from "../api/podMutex";
import { issuesApi } from "../api/issues";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { Button } from "../components/ui/button";
import { ToggleSwitch } from "../components/ui/toggle-switch";
import { cn } from "../lib/utils";

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

  const update = useMutation({
    mutationFn: (v: { labelId: string; holdingStatuses?: IssueStatus[]; enabled?: boolean }) =>
      podMutexApi.update(companyId, v.labelId, v),
    onSettled: invalidate,
  });
  const release = useMutation({
    mutationFn: (labelId: string) => podMutexApi.release(companyId, labelId),
    onSettled: invalidate,
  });
  const remove = useMutation({
    mutationFn: (labelId: string) => podMutexApi.remove(companyId, labelId),
    onSettled: invalidate,
  });
  const create = useMutation({
    mutationFn: (v: { labelId?: string; labelName?: string }) => podMutexApi.create(companyId, v),
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

  const error = list.error ?? update.error ?? release.error ?? remove.error ?? create.error;

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-6 p-4">
      <div>
        <h1 className="text-lg font-semibold">Resources</h1>
        <p className="text-sm text-muted-foreground">
          A mutex label (e.g. <code>pod:igor-3090</code>) on a root issue locks the resource for that whole issue
          tree. Other trees with the same label wait (their runs stay queued) until the holder tree has no issues in
          the holding statuses. If a tree carries several mutex labels, the one nearest to the issue wins.
        </p>
      </div>

      {error ? <div className="text-sm text-destructive">{String((error as Error).message ?? error)}</div> : null}

      <div className="overflow-x-auto rounded-md border">
        <table className="w-full text-sm">
          <thead className="bg-muted/40 text-left text-xs text-muted-foreground">
            <tr>
              <th className="px-3 py-2">Label</th>
              <th className="px-3 py-2">Status</th>
              <th className="px-3 py-2">Waiting</th>
              <th className="px-3 py-2">Holding statuses</th>
              <th className="px-3 py-2">Enabled</th>
              <th className="px-3 py-2" />
            </tr>
          </thead>
          <tbody>
            {(list.data ?? []).length === 0 ? (
              <tr>
                <td colSpan={6} className="px-3 py-6 text-center text-muted-foreground">
                  {list.isLoading ? "Loading…" : "No mutex labels configured — the feature is inactive."}
                </td>
              </tr>
            ) : null}
            {(list.data ?? []).map((entry) => (
              <MutexRow
                key={entry.labelId}
                entry={entry}
                onToggleStatus={(status) => {
                  const next = entry.holdingStatuses.includes(status)
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
          </tbody>
        </table>
      </div>

      <form
        className="flex flex-wrap items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          submitNew();
        }}
      >
        <input
          list="pod-mutex-labels"
          value={newLabel}
          onChange={(e) => setNewLabel(e.target.value)}
          placeholder="Label name, e.g. pod:igor-3090"
          className="h-9 min-w-64 rounded-md border bg-background px-3 text-sm"
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

function MutexRow(props: {
  entry: PodMutexEntry;
  onToggleStatus: (status: IssueStatus) => void;
  onToggleEnabled: (enabled: boolean) => void;
  onRelease: () => void;
  onRemove: () => void;
}) {
  const { entry } = props;
  const holder = entry.holder;
  return (
    <tr className="border-t align-top">
      <td className="px-3 py-2">
        <span className="inline-flex items-center gap-2">
          <span className="size-2.5 rounded-full" style={{ backgroundColor: entry.labelColor }} />
          <span className="font-medium">{entry.labelName}</span>
        </span>
      </td>
      <td className="px-3 py-2">
        {holder ? (
          <span>
            held by{" "}
            <Link to={`/issues/${holder.identifier ?? holder.rootIssueId}`} className="underline">
              {holder.identifier ?? holder.rootIssueId.slice(0, 8)}
            </Link>{" "}
            since {new Date(holder.acquiredAt).toLocaleString()}
            {!holder.stillHolding ? <span className="text-muted-foreground"> (releasing)</span> : null}
          </span>
        ) : (
          <span className="text-muted-foreground">free</span>
        )}
      </td>
      <td className="px-3 py-2">
        {entry.waiting.length === 0 ? (
          <span className="text-muted-foreground">—</span>
        ) : (
          <ol className="flex flex-col gap-0.5">
            {entry.waiting.map((w) => (
              <li key={w.issueId}>
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
      </td>
      <td className="px-3 py-2">
        <div className="flex flex-wrap gap-1">
          {ISSUE_STATUSES.map((status) => {
            const on = entry.holdingStatuses.includes(status);
            return (
              <button
                key={status}
                type="button"
                onClick={() => props.onToggleStatus(status)}
                className={cn(
                  "rounded-full border px-2 py-0.5 text-xs",
                  on ? "border-primary bg-primary/10 text-foreground" : "text-muted-foreground",
                )}
              >
                {status}
              </button>
            );
          })}
        </div>
      </td>
      <td className="px-3 py-2">
        <ToggleSwitch checked={entry.enabled} onCheckedChange={props.onToggleEnabled} aria-label="Enabled" />
      </td>
      <td className="px-3 py-2">
        <div className="flex gap-1">
          <Button size="xs" variant="outline" disabled={!holder} onClick={props.onRelease}>
            Release
          </Button>
          <Button size="xs" variant="ghost" onClick={props.onRemove}>
            Remove
          </Button>
        </div>
      </td>
    </tr>
  );
}
