import { z } from "zod";

const paceParamsSchema = z.object({
  holdAbove: z.number().min(-100).max(100),
  releaseAtOrBelow: z.number().min(-100).max(100),
}).strict().refine((p) => p.releaseAtOrBelow <= p.holdAbove, "releaseAtOrBelow must not exceed holdAbove");

/** Board edits of one account's limit accounting; every field optional. */
export const accountLimitSettingsPatchSchema = z.object({
  enabled: z.boolean().optional(),
  paceModel: z.string().min(1).max(40).optional(),
  weekly: paceParamsSchema.optional(),
  fiveHour: paceParamsSchema.optional(),
  maxStaleMinutes: z.number().int().min(5).max(1440).optional(),
}).strict();
export type AccountLimitSettingsPatch = z.infer<typeof accountLimitSettingsPatchSchema>;

export const accountLimitParamsSchema = z.object({ companyId: z.string(), grantId: z.string().uuid() });

export interface AccountLimitWindowView {
  id: string; label: string; scope: string | null; role: "short" | "weekly" | "other";
  usedPercent: number | null; expectedPercent: number | null; elapsedPercent: number | null; delta: number | null;
  resetsAt: string | null; durationSeconds: number | null; hold: boolean;
}

export interface AccountLimitView {
  grantId: string;
  connectionId: string;
  provider: string;
  method: string;
  accountName: string;
  accountLabel: string | null;
  limitsSupported: boolean;
  settings: {
    enabled: boolean; paceModel: string; weekly: { holdAbove: number; releaseAtOrBelow: number };
    fiveHour: { holdAbove: number; releaseAtOrBelow: number }; maxStaleMinutes: number;
  };
  capacity: {
    available: boolean; headroom: number | null; reason: string; observedAt: string | null; source: string | null;
    heldUntil: string | null; windows: AccountLimitWindowView[];
  };
  history: Array<{ at: string; windows: Array<{ id: string; usedPercent: number | null }> }>;
  agents: Array<{ id: string; name: string; via: "grant" | "responsible_user" }>;
  queuedRuns: Array<{ id: string; agentId: string; issueId: string | null; since: string | null }>;
  paceModels: string[];
}
