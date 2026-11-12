/**
 * inferdyne fork: the agent's ordered pool of inference adapters.
 * Slot 1 is the agent's own adapter (edited in the form above); the rest are
 * fallbacks tried in order when a slot hits its provider limit.
 */
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, Plus, Trash2 } from "lucide-react";
import { aiRuntimeConnectionBindingSchema, type AgentInferenceSlotInput, type AiRuntimeConnectionBinding } from "@paperclipai/shared";
import { inferenceSlotsApi, type InferenceSlotView } from "@/api/inference-slots";
import { agentsApi } from "@/api/agents";
import { listUIAdapters } from "@/adapters/registry";
import { AiConnectionField } from "@/components/ai-connections/AiConnectionField";
import { AgentPanel } from "@/components/agent-detail/AgentPanels";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { ToggleSwitch } from "@/components/ui/toggle-switch";

type Draft = {
  key: string;
  id?: string;
  enabled: boolean;
  label: string;
  adapterType: string;
  model: string;
  /** Plain env lines KEY=value; non-plain bindings are kept as they are. */
  envText: string;
  envOther: Record<string, unknown>;
  rest: Record<string, unknown>;
  aiConnection: AiRuntimeConnectionBinding | undefined;
};

const SLOT_ADAPTERS = ["claude_local", "codex_local", "opencode_local", "gemini_local", "grok_local", "pi_local"];

function toDraft(slot: InferenceSlotView): Draft {
  const { model, env, ...rest } = slot.adapterConfig as Record<string, unknown> & { env?: Record<string, unknown> };
  const lines: string[] = [];
  const envOther: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(env ?? {})) {
    const b = v as { type?: string; value?: unknown } | string;
    if (typeof b === "string") lines.push(`${k}=${b}`);
    else if (b && b.type === "plain") lines.push(`${k}=${String(b.value ?? "")}`);
    else envOther[k] = v;
  }
  return {
    key: slot.id, id: slot.id, enabled: slot.enabled, label: slot.label ?? "", adapterType: slot.adapterType,
    model: typeof model === "string" ? model : "", envText: lines.join("\n"), envOther, rest,
    aiConnection: aiRuntimeConnectionBindingSchema.safeParse(slot.aiConnection).data,
  };
}

function toInput(d: Draft): AgentInferenceSlotInput {
  const env: Record<string, unknown> = { ...d.envOther };
  for (const line of d.envText.split("\n")) {
    const i = line.indexOf("=");
    if (i <= 0) continue;
    env[line.slice(0, i).trim()] = { type: "plain", value: line.slice(i + 1).trim() };
  }
  const adapterConfig: Record<string, unknown> = { ...d.rest, ...(d.model ? { model: d.model } : {}) };
  if (Object.keys(env).length) adapterConfig.env = env;
  return { id: d.id, enabled: d.enabled, label: d.label.trim() || null, adapterType: d.adapterType, adapterConfig, aiConnection: d.aiConnection ?? null };
}

function statusText(slot: { status: InferenceSlotView["status"] }) {
  const st = slot.status;
  if (!st) return null;
  const until = st.until ? ` until ${st.until.replace("T", " ").slice(0, 16)} UTC` : "";
  if (st.state === "hard_limit") return { text: `limit reached${until}`, tone: "text-destructive" };
  if (st.state === "soft_limit") return { text: `pacing hold${until}`, tone: "text-amber-600 dark:text-amber-400" };
  if (st.state === "disabled") return { text: "off", tone: "text-muted-foreground" };
  return { text: "available", tone: "text-(--status-task-done)" };
}

function adapterLabel(type: string) {
  return listUIAdapters().find((a) => a.type === type)?.label ?? type;
}

function slotModel(config: Record<string, unknown>) {
  return typeof config.model === "string" && config.model ? config.model : "default model";
}

function ModelInput({ companyId, adapterType, value, onChange }: { companyId: string; adapterType: string; value: string; onChange: (v: string) => void }) {
  const { data } = useQuery({
    queryKey: ["adapter-models", companyId, adapterType],
    queryFn: () => agentsApi.adapterModels(companyId, adapterType),
    enabled: Boolean(companyId && adapterType),
    staleTime: 5 * 60_000,
  });
  const listId = `slot-models-${adapterType}`;
  return (
    <>
      <Input value={value} onChange={(e) => onChange(e.target.value)} placeholder="Model (empty = adapter default)" list={listId} />
      <datalist id={listId}>{(data ?? []).map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}</datalist>
    </>
  );
}

export function InferenceSlotsPanel({ agent, companyId }: { agent: { id: string; name: string }; companyId: string }) {
  const queryClient = useQueryClient();
  const queryKey = ["agent-inference-slots", agent.id];
  // No background refetch: it would throw away unsaved edits.
  const { data, error } = useQuery({ queryKey, queryFn: () => inferenceSlotsApi.list(agent.id, companyId), refetchOnWindowFocus: false });
  const [drafts, setDrafts] = useState<Draft[] | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const primary = data?.slots.find((s) => s.primary);
  const fallbacks = useMemo(() => data?.slots.filter((s) => !s.primary) ?? [], [data]);
  const current = drafts ?? fallbacks.map(toDraft);
  const dirty = drafts !== null;

  const onDone = (res: { slots: InferenceSlotView[] }) => {
    queryClient.setQueryData(queryKey, res);
    setDrafts(null);
    void queryClient.invalidateQueries({ queryKey: ["agents"] });
    setProblem(null);
  };
  const onFail = (err: unknown) => setProblem(err instanceof Error ? err.message : String(err));
  const save = useMutation({ mutationFn: (list: Draft[]) => inferenceSlotsApi.save(agent.id, list.map(toInput), companyId), onSuccess: onDone, onError: onFail });
  const promote = useMutation({
    mutationFn: (slotId: string) => inferenceSlotsApi.promote(agent.id, slotId, companyId),
    onSuccess: (res) => { onDone(res); void queryClient.invalidateQueries(); },
    onError: onFail,
  });

  const edit = (key: string, patch: Partial<Draft>) => setDrafts(current.map((d) => (d.key === key ? { ...d, ...patch } : d)));
  const move = (index: number, delta: number) => {
    const next = [...current];
    const [item] = next.splice(index, 1);
    next.splice(index + delta, 0, item!);
    setDrafts(next);
  };
  const add = () => setDrafts([...current, {
    key: `new-${Date.now()}`, enabled: true, label: "", adapterType: "claude_local", model: "", envText: "", envOther: {}, rest: {}, aiConnection: undefined,
  }]);

  const primaryStatus = primary ? statusText(primary) : null;
  return (
    <AgentPanel
      title="Inference adapters"
      aria-label="Inference adapters"
      meta={<span>Tried in order; a slot that hits its provider limit hands the task to the next one</span>}
    >
      <div className="flex flex-col gap-3 px-(--agent-detail-module-inset) pb-(--agent-detail-module-inset) text-sm">
        {error ? <div className="text-destructive">{(error as Error).message}</div> : null}
        {primary ? (
          <div className="flex flex-wrap items-center gap-3 rounded-md border border-border px-3 py-2">
            <span className="w-6 text-muted-foreground">1</span>
            <span className="font-medium">{adapterLabel(primary.adapterType)}</span>
            <span className="text-muted-foreground">{slotModel(primary.adapterConfig)}</span>
            <span className="text-muted-foreground">· primary, configured above</span>
            {primaryStatus ? <span className={`ml-auto text-xs ${primaryStatus.tone}`}>{primaryStatus.text}</span> : null}
          </div>
        ) : null}

        {current.map((d, i) => {
          const view = fallbacks.find((s) => s.id === d.id);
          const st = view ? statusText(view) : null;
          return (
            <div key={d.key} className="flex flex-col gap-2 rounded-md border border-border px-3 py-2">
              <div className="flex flex-wrap items-center gap-2">
                <span className="w-6 text-muted-foreground">{i + 2}</span>
                <select
                  className="h-9 rounded-md border border-input bg-background px-2"
                  value={d.adapterType}
                  aria-label="Adapter"
                  onChange={(e) => edit(d.key, { adapterType: e.target.value, model: "", aiConnection: undefined })}
                >
                  {[...new Set([...SLOT_ADAPTERS, d.adapterType])].map((t) => <option key={t} value={t}>{adapterLabel(t)}</option>)}
                </select>
                <Input className="w-40" value={d.label} placeholder="Name (optional)" onChange={(e) => edit(d.key, { label: e.target.value })} />
                {st ? <span className={`text-xs ${st.tone}`}>{st.text}</span> : null}
                <div className="ml-auto flex items-center gap-1">
                  <ToggleSwitch checked={d.enabled} onCheckedChange={(v) => edit(d.key, { enabled: v })} aria-label="Enabled" />
                  <Button variant="ghost" size="icon" aria-label="Move up" disabled={i === 0} onClick={() => move(i, -1)}><ArrowUp className="size-4" /></Button>
                  <Button variant="ghost" size="icon" aria-label="Move down" disabled={i === current.length - 1} onClick={() => move(i, 1)}><ArrowDown className="size-4" /></Button>
                  <Button variant="ghost" size="icon" aria-label="Remove" onClick={() => setDrafts(current.filter((x) => x.key !== d.key))}><Trash2 className="size-4" /></Button>
                </div>
              </div>
              <ModelInput companyId={companyId} adapterType={d.adapterType} value={d.model} onChange={(v) => edit(d.key, { model: v })} />
              <AiConnectionField
                companyId={companyId} agentId={agent.id} agentName={agent.name} adapterType={d.adapterType} model={d.model}
                value={d.aiConnection} legacy onChange={(binding) => edit(d.key, { aiConnection: binding })}
              />
              <Textarea
                rows={2} value={d.envText} placeholder={"Provider env, one per line (e.g. ANTHROPIC_BASE_URL=http://host:port)"}
                onChange={(e) => edit(d.key, { envText: e.target.value })}
              />
              {d.id && !dirty ? (
                <div>
                  <Button variant="outline" size="sm" disabled={promote.isPending} onClick={() => promote.mutate(d.id!)}>Make primary</Button>
                </div>
              ) : null}
            </div>
          );
        })}

        {problem ? <div className="text-destructive">{problem}</div> : null}
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={add} disabled={current.length >= 10}><Plus className="size-4" /> Add fallback adapter</Button>
          {dirty ? (
            <>
              <Button size="sm" disabled={save.isPending} onClick={() => save.mutate(current)}>Save adapters</Button>
              <Button variant="ghost" size="sm" onClick={() => { setDrafts(null); setProblem(null); }}>Cancel</Button>
            </>
          ) : null}
        </div>
      </div>
    </AgentPanel>
  );
}
