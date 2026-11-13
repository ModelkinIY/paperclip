/**
 * inferdyne fork: the agent's adapters by priority. Adapters themselves
 * (harness, connection, settings) are edited on the Adapters page; here they
 * are picked, ordered and removed, and the agent chooses its model and
 * thinking effort on each one.
 */
import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, X } from "lucide-react";
import { agentHarnessType, aiConnectionBindingSchema, aiRoutingHarness, type CompanyAdapterView } from "@paperclipai/shared";
import { agentsApi } from "@/api/agents";
import { useConnectionModels } from "@/components/ai-connections/useConnectionModels";
import { setupEfforts } from "@/lib/agent-setup-fields";
import { companyAdaptersApi } from "@/api/company-adapters";
import { AgentPanel } from "@/components/agent-detail/AgentPanels";
import { Button } from "@/components/ui/button";
import { ToggleSwitch } from "@/components/ui/toggle-switch";
import { adapterLabel, adapterStatusText } from "@/pages/Adapters";
import { Link } from "@/lib/router";
import { cn } from "@/lib/utils";

type Item = { adapterId: string; enabled: boolean; model: string | null; effort: string | null };

const inputClass = "h-8 rounded-md border border-input bg-background px-2 text-sm";

/** Model and thinking effort of this agent on one adapter. */
function ModelEffort({ adapter, companyId, item, effortSupported, onChange }: {
  adapter: CompanyAdapterView; companyId: string; item: Item; effortSupported: boolean; onChange: (patch: Partial<Item>) => void;
}) {
  const binding = aiConnectionBindingSchema.safeParse(adapter.aiConnection).data;
  const harness = agentHarnessType(adapter.adapterType, adapter.adapterConfig);
  const connectionModels = useConnectionModels(companyId, binding, aiRoutingHarness(adapter.adapterType));
  const { data: fetched } = useQuery({
    queryKey: ["agents", companyId, "adapter-models", adapter.adapterType, adapter.defaultEnvironmentId ?? null, JSON.stringify(binding ?? null)],
    queryFn: () => agentsApi.adapterModels(companyId, adapter.adapterType, { environmentId: adapter.defaultEnvironmentId ?? null, aiConnection: binding }),
    enabled: !connectionModels,
    staleTime: 60_000,
    retry: false,
  });
  const models = connectionModels?.models ?? fetched ?? [];
  const efforts = setupEfforts(harness, item.model ?? "");
  const listId = `adapter-models-${adapter.id}`;
  return (
    <div className="flex basis-full flex-wrap items-center gap-2 pl-8">
      <label className="flex items-center gap-1.5 text-xs text-muted-foreground">Model
        <input className={cn(inputClass, "w-64 font-mono")} list={listId} aria-label={`Model for ${adapter.name}`} placeholder="Default"
          value={item.model ?? ""} onChange={(e) => onChange({ model: e.target.value || null })} />
        <datalist id={listId}>{models.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}</datalist>
      </label>
      {effortSupported ? <label className="flex items-center gap-1.5 text-xs text-muted-foreground">Thinking effort
        {efforts.length ? (
          <select className={inputClass} aria-label={`Thinking effort for ${adapter.name}`} value={item.effort ?? ""} onChange={(e) => onChange({ effort: e.target.value || null })}>
            <option value="">Auto</option>
            {item.effort && !efforts.includes(item.effort) ? <option value={item.effort}>{item.effort}</option> : null}
            {efforts.map((e) => <option key={e} value={e}>{e === "xhigh" ? "X-High" : e[0]!.toUpperCase() + e.slice(1)}</option>)}
          </select>
        ) : (
          <input className={cn(inputClass, "w-28")} aria-label={`Thinking effort for ${adapter.name}`} placeholder="Auto"
            value={item.effort ?? ""} onChange={(e) => onChange({ effort: e.target.value || null })} />
        )}
      </label> : null}
    </div>
  );
}

/** Max turns belong to the agent (Claude Code), whatever adapter it runs on. */
function MaxTurns({ agentId, companyId }: { agentId: string; companyId: string }) {
  const queryClient = useQueryClient();
  const { data: agent } = useQuery({ queryKey: ["agents", "detail", agentId, "max-turns"], queryFn: () => agentsApi.get(agentId, companyId) });
  const stored = Number((agent?.adapterConfig as Record<string, unknown> | undefined)?.maxTurnsPerRun ?? 1000);
  const [value, setValue] = useState<string>("");
  const loaded = !!agent;
  useEffect(() => { if (loaded) setValue(String(stored)); }, [loaded, stored]);
  const save = useMutation({
    mutationFn: (n: number) => agentsApi.update(agentId, { adapterConfig: { maxTurnsPerRun: n } }, companyId),
    onSuccess: () => { void queryClient.invalidateQueries({ queryKey: ["agents"] }); },
  });
  if (!agent) return null;
  const n = Number(value);
  return (
    <label className="flex items-center gap-2 text-xs text-muted-foreground">Max turns per run (Claude Code)
      <input type="number" min={1} className={cn(inputClass, "w-24")} aria-label="Max turns per run" value={value} onChange={(e) => setValue(e.target.value)} />
      {Number.isFinite(n) && n > 0 && n !== stored ? <Button size="sm" variant="outline" disabled={save.isPending} onClick={() => save.mutate(n)}>Save</Button> : null}
      {save.error ? <span className="text-destructive">{(save.error as Error).message}</span> : null}
    </label>
  );
}

export function AgentAdaptersList({ agentId, companyId }: { agentId: string; companyId: string }) {
  const queryClient = useQueryClient();
  const key = ["agent-adapters", agentId];
  const { data, error } = useQuery({ queryKey: key, queryFn: () => companyAdaptersApi.agentList(agentId), refetchOnWindowFocus: false });
  const { data: all } = useQuery({ queryKey: ["company-adapters", companyId], queryFn: () => companyAdaptersApi.list(companyId) });
  const [draft, setDraft] = useState<Item[] | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const saved: Item[] = useMemo(() => (data?.adapters ?? []).map((a) => ({ adapterId: a.id, enabled: a.enabled, model: a.model, effort: a.effort })), [data]);
  const items = draft ?? saved;
  const byId = new Map<string, CompanyAdapterView>();
  for (const a of all?.adapters ?? []) byId.set(a.id, a);
  for (const a of data?.adapters ?? []) byId.set(a.id, a);
  const available = (all?.adapters ?? []).filter((a) => !items.some((i) => i.adapterId === a.id));
  const [toAdd, setToAdd] = useState("");

  const save = useMutation({
    mutationFn: (list: Item[]) => companyAdaptersApi.saveAgentList(agentId, { adapters: list }),
    onSuccess: (res) => {
      queryClient.setQueryData(key, res);
      setDraft(null);
      setProblem(null);
      void queryClient.invalidateQueries({ queryKey: ["company-adapters", companyId] });
      void queryClient.invalidateQueries({ queryKey: ["agents"] });
    },
    onError: (err) => setProblem(err instanceof Error ? err.message : String(err)),
  });
  const move = (i: number, d: number) => { const next = [...items]; const [x] = next.splice(i, 1); next.splice(i + d, 0, x!); setDraft(next); };

  return (
    <AgentPanel title="Adapters" aria-label="Adapters" meta={<span>Tried in order; an adapter that hits its provider limit hands the task to the next one</span>}
      action={<Link to="/adapters" className="text-xs hover:underline">Manage adapters</Link>}>
      <div className="flex flex-col gap-2 px-(--agent-detail-module-inset) pb-(--agent-detail-module-inset) text-sm">
        {error ? <div className="text-destructive">{(error as Error).message}</div> : null}
        {items.map((item, i) => {
          const a = byId.get(item.adapterId);
          const st = a ? adapterStatusText(a.status) : null;
          return (
            <div key={item.adapterId} className={cn("flex flex-wrap items-center gap-3 rounded-md border border-border px-3 py-2", !item.enabled && "opacity-60")}>
              <span className="w-5 text-muted-foreground">{i + 1}</span>
              <Link to={`/adapters/${item.adapterId}`} className="font-medium hover:underline">{a?.name ?? item.adapterId}</Link>
              {a ? <span className="text-muted-foreground">{adapterLabel(a.adapterType)}</span> : null}
              {st ? <span className={cn("text-xs", st.tone)}>{st.text}</span> : null}
              <div className="ml-auto flex items-center gap-1">
                <ToggleSwitch checked={item.enabled} aria-label="Enabled" onCheckedChange={(v) => setDraft(items.map((x) => x.adapterId === item.adapterId ? { ...x, enabled: v } : x))} />
                <Button variant="ghost" size="icon" aria-label="Move up" disabled={i === 0} onClick={() => move(i, -1)}><ArrowUp className="size-4" /></Button>
                <Button variant="ghost" size="icon" aria-label="Move down" disabled={i === items.length - 1} onClick={() => move(i, 1)}><ArrowDown className="size-4" /></Button>
                <Button variant="ghost" size="icon" aria-label="Remove" onClick={() => setDraft(items.filter((x) => x.adapterId !== item.adapterId))}><X className="size-4" /></Button>
              </div>
              {a ? <ModelEffort adapter={a} companyId={companyId} item={item} effortSupported={a.adapterType !== "cursor"}
                onChange={(patch) => setDraft(items.map((x) => x.adapterId === item.adapterId ? { ...x, ...patch } : x))} /> : null}
            </div>
          );
        })}
        <div className="flex flex-wrap items-center gap-2">
          <select className="h-9 rounded-md border border-input bg-background px-2" aria-label="Adapter to add" value={toAdd} onChange={(e) => setToAdd(e.target.value)}>
            <option value="">Add adapter…</option>
            {available.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
          <Button variant="outline" size="sm" disabled={!toAdd} onClick={() => { setDraft([...items, { adapterId: toAdd, enabled: true, model: null, effort: null }]); setToAdd(""); }}>Add</Button>
          {draft ? (
            <>
              <Button size="sm" disabled={save.isPending} onClick={() => save.mutate(items)}>Save</Button>
              <Button variant="ghost" size="sm" onClick={() => { setDraft(null); setProblem(null); }}>Cancel</Button>
            </>
          ) : null}
        </div>
        {problem ? <div className="text-destructive">{problem}</div> : null}
        {items.some((i) => { const x = byId.get(i.adapterId); return !!x && agentHarnessType(x.adapterType, x.adapterConfig) === "claude_local"; }) ? <MaxTurns agentId={agentId} companyId={companyId} /> : null}
      </div>
    </AgentPanel>
  );
}
