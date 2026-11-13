import { z } from "zod";
import { agentHarnessType } from "./agent-runner.js";

/**
 * adapterConfig keys an agent picks per adapter on its runtime tab (model and
 * thinking effort), not stored on the company adapter.
 */
export const SLOT_ADAPTER_KEYS = ["model", "effort", "modelReasoningEffort", "reasoningEffort", "variant", "mode", "thinking"] as const;

/** adapterConfig key that holds the thinking effort for this harness. */
export function slotEffortKey(adapterType: string, adapterConfig: Record<string, unknown> = {}): string {
  const harness = agentHarnessType(adapterType, adapterConfig);
  if (harness === "codex_local" || (adapterType === "paperclip_runner" && harness === "claude_local")) return "modelReasoningEffort";
  if (adapterType === "cursor") return "mode";
  if (adapterType === "opencode_local") return "variant";
  if (harness === "grok_local") return "reasoningEffort";
  if (adapterType === "pi_local") return "thinking";
  return "effort";
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

/** Create/update a company adapter (Adapters page). */
export const companyAdapterSaveSchema = z.object({
  name: z.string().trim().min(1).max(120),
  adapterType: z.string().trim().min(1),
  adapterConfig: z.record(z.string(), z.unknown()).default({}),
  aiConnection: z.record(z.string(), z.unknown()).nullable().optional(),
  defaultEnvironmentId: z.string().uuid().nullable().optional(),
});
export type CompanyAdapterSave = z.infer<typeof companyAdapterSaveSchema>;

/** An agent's adapter list; array order is the priority. */
export const agentAdapterListSaveSchema = z.object({
  adapters: z.array(z.object({
    adapterId: z.string().uuid(),
    enabled: z.boolean().default(true),
    /** Model of this agent on this adapter; null/empty: the harness default. */
    model: z.string().trim().max(200).nullable().optional(),
    /** Thinking effort; null/empty: auto. */
    effort: z.string().trim().max(40).nullable().optional(),
  })).min(1).max(10),
});
export type AgentAdapterListSave = z.infer<typeof agentAdapterListSaveSchema>;

/** A company adapter as the API returns it. */
export interface CompanyAdapterView {
  id: string;
  companyId: string;
  name: string;
  adapterType: string;
  adapterConfig: Record<string, unknown>;
  aiConnection: Record<string, unknown> | null;
  defaultEnvironmentId: string | null;
  status: InferenceSlotStatus | null;
  agents: Array<{ id: string; name: string; priority: number }>;
  createdAt: string;
  updatedAt: string;
}

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
