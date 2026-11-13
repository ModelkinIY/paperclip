import type { AgentAdapterListSave, CompanyAdapterSave, CompanyAdapterView } from "@paperclipai/shared";
import { api } from "./client";

/** inferdyne fork: company adapters (Adapters page) and agent adapter lists. */
export type AgentAdapterView = CompanyAdapterView & { enabled: boolean; priority: number; model: string | null; effort: string | null };

export const companyAdaptersApi = {
  list: (companyId: string) => api.get<{ adapters: CompanyAdapterView[] }>(`/companies/${encodeURIComponent(companyId)}/adapters`),
  create: (companyId: string, body: CompanyAdapterSave) => api.post<CompanyAdapterView>(`/companies/${encodeURIComponent(companyId)}/adapters`, body),
  update: (id: string, body: CompanyAdapterSave) => api.patch<CompanyAdapterView>(`/adapters/${encodeURIComponent(id)}`, body),
  remove: (id: string) => api.delete<void>(`/adapters/${encodeURIComponent(id)}`),
  agentList: (agentId: string) => api.get<{ adapters: AgentAdapterView[] }>(`/agents/${encodeURIComponent(agentId)}/adapters`),
  saveAgentList: (agentId: string, body: AgentAdapterListSave) => api.put<{ adapters: AgentAdapterView[] }>(`/agents/${encodeURIComponent(agentId)}/adapters`, body),
};
