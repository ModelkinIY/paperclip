/**
 * inferdyne fork: the agent's adapters by priority. Adapters themselves are
 * edited on the Adapters page; here they are only picked, ordered, removed.
 */
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, X } from "lucide-react";
import type { CompanyAdapterView } from "@paperclipai/shared";
import { companyAdaptersApi } from "@/api/company-adapters";
import { AgentPanel } from "@/components/agent-detail/AgentPanels";
import { Button } from "@/components/ui/button";
import { ToggleSwitch } from "@/components/ui/toggle-switch";
import { adapterLabel, adapterStatusText } from "@/pages/Adapters";
import { Link } from "@/lib/router";
import { cn } from "@/lib/utils";

type Item = { adapterId: string; enabled: boolean };

export function AgentAdaptersList({ agentId, companyId }: { agentId: string; companyId: string }) {
  const queryClient = useQueryClient();
  const key = ["agent-adapters", agentId];
  const { data, error } = useQuery({ queryKey: key, queryFn: () => companyAdaptersApi.agentList(agentId), refetchOnWindowFocus: false });
  const { data: all } = useQuery({ queryKey: ["company-adapters", companyId], queryFn: () => companyAdaptersApi.list(companyId) });
  const [draft, setDraft] = useState<Item[] | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const saved: Item[] = useMemo(() => (data?.adapters ?? []).map((a) => ({ adapterId: a.id, enabled: a.enabled })), [data]);
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
          const model = a && typeof a.adapterConfig.model === "string" && a.adapterConfig.model ? a.adapterConfig.model : "default model";
          return (
            <div key={item.adapterId} className={cn("flex flex-wrap items-center gap-3 rounded-md border border-border px-3 py-2", !item.enabled && "opacity-60")}>
              <span className="w-5 text-muted-foreground">{i + 1}</span>
              <Link to={`/adapters/${item.adapterId}`} className="font-medium hover:underline">{a?.name ?? item.adapterId}</Link>
              {a ? <span className="text-muted-foreground">{adapterLabel(a.adapterType)} · {model}</span> : null}
              {st ? <span className={cn("text-xs", st.tone)}>{st.text}</span> : null}
              <div className="ml-auto flex items-center gap-1">
                <ToggleSwitch checked={item.enabled} aria-label="Enabled" onCheckedChange={(v) => setDraft(items.map((x) => x.adapterId === item.adapterId ? { ...x, enabled: v } : x))} />
                <Button variant="ghost" size="icon" aria-label="Move up" disabled={i === 0} onClick={() => move(i, -1)}><ArrowUp className="size-4" /></Button>
                <Button variant="ghost" size="icon" aria-label="Move down" disabled={i === items.length - 1} onClick={() => move(i, 1)}><ArrowDown className="size-4" /></Button>
                <Button variant="ghost" size="icon" aria-label="Remove" onClick={() => setDraft(items.filter((x) => x.adapterId !== item.adapterId))}><X className="size-4" /></Button>
              </div>
            </div>
          );
        })}
        <div className="flex flex-wrap items-center gap-2">
          <select className="h-9 rounded-md border border-input bg-background px-2" aria-label="Adapter to add" value={toAdd} onChange={(e) => setToAdd(e.target.value)}>
            <option value="">Add adapter…</option>
            {available.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
          <Button variant="outline" size="sm" disabled={!toAdd} onClick={() => { setDraft([...items, { adapterId: toAdd, enabled: true }]); setToAdd(""); }}>Add</Button>
          {draft ? (
            <>
              <Button size="sm" disabled={save.isPending} onClick={() => save.mutate(items)}>Save</Button>
              <Button variant="ghost" size="sm" onClick={() => { setDraft(null); setProblem(null); }}>Cancel</Button>
            </>
          ) : null}
        </div>
        {problem ? <div className="text-destructive">{problem}</div> : null}
      </div>
    </AgentPanel>
  );
}
