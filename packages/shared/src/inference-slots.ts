import { z } from "zod";

/** inferdyne fork: one inference adapter of an agent's ordered pool. */
export interface AgentInferenceSlot {
  id: string;
  agentId: string;
  priority: number;
  enabled: boolean;
  label: string | null;
  adapterType: string;
  adapterConfig: Record<string, unknown>;
  aiConnection: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
}

/** Live availability of a slot, as the selector sees it. */
export type InferenceSlotState = "available" | "soft_limit" | "hard_limit" | "disabled";

export interface InferenceSlotStatus {
  slotId: string;
  state: InferenceSlotState;
  /** Capacity reason or "provider_quota" for a hard limit the provider reported. */
  reason: string;
  /** When the slot is expected back (soft or hard), if known. */
  until: string | null;
  accountName: string | null;
}

export const agentInferenceSlotInputSchema = z.object({
  id: z.string().uuid().optional(),
  enabled: z.boolean().default(true),
  label: z.string().trim().max(120).nullable().optional(),
  adapterType: z.string().trim().min(1),
  adapterConfig: z.record(z.string(), z.unknown()).default({}),
  aiConnection: z.record(z.string(), z.unknown()).nullable().optional(),
});
/** The whole ordered list; array order is the priority. */
export const agentInferenceSlotsSaveSchema = z.object({
  slots: z.array(agentInferenceSlotInputSchema).max(10),
});
export type AgentInferenceSlotInput = z.infer<typeof agentInferenceSlotInputSchema>;
export type AgentInferenceSlotsSave = z.infer<typeof agentInferenceSlotsSaveSchema>;

/** Persisted on the run's contextSnapshot.inferenceSlot at claim time. */
export interface InferenceSlotSelection {
  slotId: string;
  priority: number;
  adapterType: string;
  label: string | null;
  model: string | null;
  /** Why this slot: "affinity" (task stays), "priority" (first open), "switched_hard_limit". */
  reason: string;
  /** Slot the task ran on before, when this run moved it. */
  previousSlotId: string | null;
}

export function readInferenceSlotSelection(contextSnapshot: unknown): InferenceSlotSelection | null {
  if (!contextSnapshot || typeof contextSnapshot !== "object") return null;
  const raw = (contextSnapshot as Record<string, unknown>).inferenceSlot;
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.slotId !== "string" || typeof r.adapterType !== "string") return null;
  return {
    slotId: r.slotId,
    priority: typeof r.priority === "number" ? r.priority : 0,
    adapterType: r.adapterType,
    label: typeof r.label === "string" ? r.label : null,
    model: typeof r.model === "string" ? r.model : null,
    reason: typeof r.reason === "string" ? r.reason : "",
    previousSlotId: typeof r.previousSlotId === "string" ? r.previousSlotId : null,
  };
}
