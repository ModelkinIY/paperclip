import type { AgentInferenceSlotInput, InferenceSlotStatus } from "@paperclipai/shared";
import { api } from "./client";

function withCompanyScope(path: string, companyId?: string) {
  if (!companyId) return path;
  return `${path}${path.includes("?") ? "&" : "?"}companyId=${encodeURIComponent(companyId)}`;
}

/** inferdyne fork: an agent's inference slots as the server returns them (primary first). */
export interface InferenceSlotView {
  id: string;
  agentId: string;
  priority: number;
  enabled: boolean;
  label: string | null;
  primary: boolean;
  adapterType: string;
  adapterConfig: Record<string, unknown>;
  aiConnection: Record<string, unknown> | null;
  status: InferenceSlotStatus | null;
}

const path = (agentId: string, companyId?: string, suffix = "") =>
  withCompanyScope(`/agents/${encodeURIComponent(agentId)}/inference-slots${suffix}`, companyId);

export const inferenceSlotsApi = {
  list: (agentId: string, companyId?: string) => api.get<{ slots: InferenceSlotView[] }>(path(agentId, companyId)),
  /** Fallback slots only, in priority order. */
  save: (agentId: string, slots: AgentInferenceSlotInput[], companyId?: string) =>
    api.put<{ slots: InferenceSlotView[] }>(path(agentId, companyId), { slots }),
  promote: (agentId: string, slotId: string, companyId?: string) =>
    api.post<{ slots: InferenceSlotView[] }>(path(agentId, companyId, `/${encodeURIComponent(slotId)}/promote`), {}),
};
