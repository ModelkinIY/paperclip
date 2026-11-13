/**
 * inferdyne fork: company adapters. Each adapter is a harness + connection +
 * model + adapter settings + environment override; agents list adapters by
 * priority on their runtime tab. The editor is the agent adapter form in
 * standalone mode (no agent-scoped calls).
 */
import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Trash2 } from "lucide-react";
import type { Agent, CompanyAdapterView } from "@paperclipai/shared";
import { companyAdaptersApi } from "@/api/company-adapters";
import { agentsApi } from "@/api/agents";
import { listUIAdapters } from "@/adapters/registry";
import { AgentConfigForm } from "@/components/AgentConfigForm";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { useCompany } from "@/context/CompanyContext";
import { queryKeys } from "@/lib/queryKeys";
import { Link, useNavigate, useParams } from "@/lib/router";
import { cn } from "@/lib/utils";

export function adapterLabel(type: string) {
  return listUIAdapters().find((a) => a.type === type)?.label ?? type;
}

export function adapterStatusText(status: CompanyAdapterView["status"]) {
  if (!status) return null;
  const until = status.until ? ` until ${status.until.replace("T", " ").slice(0, 16)} UTC` : "";
  if (status.state === "hard_limit") return { text: `limit reached${until}`, tone: "text-destructive" };
  if (status.state === "soft_limit") return { text: `pacing hold${until}`, tone: "text-amber-600 dark:text-amber-400" };
  return { text: "available", tone: "text-(--status-task-done)" };
}

function modelOf(a: Pick<CompanyAdapterView, "adapterConfig">) {
  const m = a.adapterConfig.model;
  return typeof m === "string" && m ? m : "default model";
}

/** The form edits agents; a company adapter is shown to it as a stand-in agent. */
function standInAgent(a: CompanyAdapterView): Agent {
  return {
    id: a.id, companyId: a.companyId, name: a.name, urlKey: a.id, role: "engineer", title: null, icon: null, status: "idle",
    reportsTo: null, capabilities: null, adapterType: a.adapterType, adapterConfig: a.adapterConfig,
    runtimeConfig: a.aiConnection ? { aiConnection: a.aiConnection } : {}, defaultEnvironmentId: a.defaultEnvironmentId,
    budgetMonthlyCents: 0, spentMonthlyCents: 0, pauseReason: null, pausedAt: null, permissions: { canCreateAgents: false },
    lastHeartbeatAt: null, metadata: null, lifecycleHolds: [], createdAt: new Date(a.createdAt), updatedAt: new Date(a.updatedAt),
  } as unknown as Agent;
}

function saveBody(a: CompanyAdapterView, patch: Record<string, unknown>, name?: string) {
  const runtime = patch.runtimeConfig as Record<string, unknown> | undefined;
  const nextConfig = patch.adapterConfig as Record<string, unknown> | undefined;
  return {
    name: name ?? a.name,
    adapterType: typeof patch.adapterType === "string" ? patch.adapterType : a.adapterType,
    adapterConfig: nextConfig ? (patch.replaceAdapterConfig ? nextConfig : { ...a.adapterConfig, ...nextConfig }) : a.adapterConfig,
    aiConnection: runtime && "aiConnection" in runtime ? (runtime.aiConnection as Record<string, unknown> | null) ?? null : a.aiConnection,
    defaultEnvironmentId: "defaultEnvironmentId" in patch ? (patch.defaultEnvironmentId as string | null) : a.defaultEnvironmentId,
  };
}

function AdapterEditor({ adapter, companyId, onDeleted }: { adapter: CompanyAdapterView; companyId: string; onDeleted: () => void }) {
  const queryClient = useQueryClient();
  const [name, setName] = useState(adapter.name);
  const [problem, setProblem] = useState<string | null>(null);
  useEffect(() => { setName(adapter.name); setProblem(null); }, [adapter.id, adapter.name]);
  const refresh = () => queryClient.invalidateQueries({ queryKey: ["company-adapters", companyId] });
  const update = useMutation({
    mutationFn: (body: ReturnType<typeof saveBody>) => companyAdaptersApi.update(adapter.id, body),
    onSuccess: () => { setProblem(null); void refresh(); void queryClient.invalidateQueries({ queryKey: queryKeys.agents.list(companyId) }); },
    onError: (err) => setProblem(err instanceof Error ? err.message : String(err)),
  });
  const remove = useMutation({
    mutationFn: () => companyAdaptersApi.remove(adapter.id),
    onSuccess: () => { void refresh(); onDeleted(); },
    onError: (err) => setProblem(err instanceof Error ? err.message : String(err)),
  });
  const catalogProvider = adapter.adapterType === "paperclip_runner" ? String(adapter.adapterConfig.provider ?? "codex") : undefined;
  const { data: adapterModels } = useQuery({
    queryKey: queryKeys.agents.adapterModels(companyId, adapter.adapterType, null, catalogProvider),
    queryFn: () => agentsApi.adapterModels(companyId, adapter.adapterType, { provider: catalogProvider }),
  });
  const agent = useMemo(() => standInAgent(adapter), [adapter]);
  const status = adapterStatusText(adapter.status);
  return (
    <div className="flex min-w-0 flex-1 flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <Input className="max-w-md" value={name} aria-label="Adapter name" onChange={(e) => setName(e.target.value)} />
        {name.trim() && name.trim() !== adapter.name ? (
          <Button size="sm" disabled={update.isPending} onClick={() => update.mutate(saveBody(adapter, {}, name.trim()))}>Rename</Button>
        ) : null}
        {status ? <span className={cn("text-xs", status.tone)}>{status.text}</span> : null}
        <Button variant="outline" size="sm" className="ml-auto" disabled={remove.isPending || adapter.agents.length > 0}
          title={adapter.agents.length ? "Remove it from the agents below first" : undefined}
          onClick={() => { if (window.confirm(`Delete adapter "${adapter.name}"?`)) remove.mutate(); }}>
          <Trash2 className="size-4" /> Delete
        </Button>
      </div>
      <div className="text-sm text-muted-foreground">
        {adapter.agents.length ? (
          <>Used by: {adapter.agents.map((a, i) => (
            <span key={a.id}>{i ? ", " : ""}<Link className="hover:underline" to={`/agents/${a.id}/runtime`}>{a.name}</Link> (#{a.priority + 1})</span>
          ))}</>
        ) : "Not used by any agent yet."}
      </div>
      {problem ? <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">{problem}</div> : null}
      <AgentConfigForm
        key={adapter.id + adapter.updatedAt}
        mode="edit"
        agent={agent}
        standaloneAdapter
        onSave={(patch) => update.mutateAsync(saveBody(adapter, patch))}
        isSaving={update.isPending}
        adapterModels={adapterModels}
        showAdapterTypeField
        content="configuration"
        sectionLayout="panels"
        sectionOrder={["adapter", "configuration", "environment"]}
        hiddenSections={["identity", "run-policy", "environment-variables", "secrets"]}
        sectionTitles={{ adapter: "", configuration: "", environment: "" }}
        hidePromptTemplate
        hideInstructionsFile
      />
    </div>
  );
}

export function Adapters() {
  const { selectedCompanyId: companyId } = useCompany();
  const { adapterId } = useParams<{ adapterId?: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { setBreadcrumbs } = useBreadcrumbs();
  useEffect(() => { setBreadcrumbs([{ label: "Adapters" }]); }, [setBreadcrumbs]);
  const { data, error } = useQuery({
    queryKey: ["company-adapters", companyId],
    queryFn: () => companyAdaptersApi.list(companyId!),
    enabled: Boolean(companyId),
  });
  const adapters = data?.adapters ?? [];
  const selected = adapters.find((a) => a.id === adapterId) ?? adapters[0] ?? null;
  const create = useMutation({
    mutationFn: () => {
      const names = new Set(adapters.map((a) => a.name));
      let n = adapters.length + 1;
      while (names.has(`New adapter ${n}`)) n++;
      return companyAdaptersApi.create(companyId!, { name: `New adapter ${n}`, adapterType: "claude_local", adapterConfig: {}, aiConnection: null, defaultEnvironmentId: null });
    },
    onSuccess: async (row) => {
      await queryClient.invalidateQueries({ queryKey: ["company-adapters", companyId] });
      navigate(`/adapters/${row.id}`);
    },
  });
  if (!companyId) return null;
  return (
    <div className="flex flex-col gap-4 p-4 md:flex-row md:items-start">
      <aside className="flex w-full shrink-0 flex-col gap-2 md:w-72" aria-label="Adapters">
        <div className="flex items-center justify-between">
          <h1 className="text-base font-semibold">Adapters</h1>
          <Button size="sm" variant="outline" disabled={create.isPending} onClick={() => create.mutate()}><Plus className="size-4" /> New</Button>
        </div>
        {error ? <div className="text-sm text-destructive">{(error as Error).message}</div> : null}
        {create.error ? <div className="text-sm text-destructive">{(create.error as Error).message}</div> : null}
        <ul className="flex flex-col gap-1">
          {adapters.map((a) => {
            const st = adapterStatusText(a.status);
            return (
              <li key={a.id}>
                <Link to={`/adapters/${a.id}`} className={cn("flex flex-col rounded-md border border-border px-3 py-2 text-sm hover:bg-accent", selected?.id === a.id && "border-primary bg-accent")}>
                  <span className="font-medium">{a.name}</span>
                  <span className="text-xs text-muted-foreground">{adapterLabel(a.adapterType)} · {modelOf(a)} · {a.agents.length} agent{a.agents.length === 1 ? "" : "s"}</span>
                  {st ? <span className={cn("text-xs", st.tone)}>{st.text}</span> : null}
                </Link>
              </li>
            );
          })}
        </ul>
      </aside>
      {selected ? (
        <AdapterEditor adapter={selected} companyId={companyId} onDeleted={() => navigate("/adapters")} />
      ) : (
        <div className="text-sm text-muted-foreground">No adapters yet.</div>
      )}
    </div>
  );
}
