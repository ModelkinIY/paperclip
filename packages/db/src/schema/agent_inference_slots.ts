import { boolean, foreignKey, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { agents } from "./agents.js";

/**
 * inferdyne fork: an agent's ordered pool of inference adapters ("slots").
 * No rows means the agent runs on its own adapter fields as before. With rows,
 * the agent's adapterType/adapterConfig/runtimeConfig.aiConnection mirror the
 * first slot by priority, and each run picks a slot at claim time.
 */
/**
 * inferdyne fork: a company-level inference adapter (harness + connection +
 * model + adapter settings + environment override). Agents reference adapters
 * by priority through agent_inference_slots.adapter_id.
 */
export const companyAdapters = pgTable("company_adapters", {
  id: uuid("id").primaryKey().defaultRandom(),
  companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  adapterType: text("adapter_type").notNull(),
  /** Adapter-level adapterConfig keys only; agent-level keys (instructions, prompts, env, skills) stay on the agent. */
  adapterConfig: jsonb("adapter_config").$type<Record<string, unknown>>().notNull().default({}),
  aiConnection: jsonb("ai_connection").$type<Record<string, unknown> | null>(),
  defaultEnvironmentId: uuid("default_environment_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("company_adapters_company_name_uq").on(t.companyId, t.name),
  index("company_adapters_company_idx").on(t.companyId),
]);

export const agentInferenceSlots = pgTable("agent_inference_slots", {
  id: uuid("id").primaryKey().defaultRandom(),
  companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
  agentId: uuid("agent_id").notNull(),
  /** Lower runs first. */
  priority: integer("priority").notNull(),
  enabled: boolean("enabled").notNull().default(true),
  label: text("label"),
  /** Company adapter this slot runs (new style). Null: legacy inline slot. */
  adapterId: uuid("adapter_id").references(() => companyAdapters.id, { onDelete: "restrict" }),
  adapterType: text("adapter_type"),
  adapterConfig: jsonb("adapter_config").$type<Record<string, unknown>>().notNull().default({}),
  /** runtimeConfig.aiConnection for this slot; null means none (self-managed auth). */
  aiConnection: jsonb("ai_connection").$type<Record<string, unknown> | null>(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("agent_inference_slots_agent_priority_idx").on(t.agentId, t.priority),
  foreignKey({ columns: [t.companyId, t.agentId], foreignColumns: [agents.companyId, agents.id], name: "agent_inference_slots_company_agent_fk" }).onDelete("cascade"),
]);

/**
 * Which slot a task last ran on and when that run ended. Keeps a task on its
 * slot (session, prompt cache) and is the input of a future cache-aware policy.
 */
export const agentInferenceSlotTaskState = pgTable("agent_inference_slot_task_state", {
  id: uuid("id").primaryKey().defaultRandom(),
  companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
  agentId: uuid("agent_id").notNull(),
  taskKey: text("task_key").notNull(),
  /** "primary" (the agent's own adapter fields) or an agent_inference_slots id. */
  slotId: text("slot_id").notNull(),
  lastRunId: uuid("last_run_id"),
  lastRunFinishedAt: timestamp("last_run_finished_at", { withTimezone: true }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("agent_inference_slot_task_state_agent_task_uq").on(t.agentId, t.taskKey),
  foreignKey({ columns: [t.companyId, t.agentId], foreignColumns: [agents.companyId, agents.id], name: "agent_inference_slot_task_state_company_agent_fk" }).onDelete("cascade"),
]);

/**
 * Hard limits reported by a provider ("you've hit your limit"): nothing can run
 * on the key until `until`. Key is `grant:<grantId>` for a subscription/API
 * account, `slot:<slotId>` for a slot without an account binding.
 */
export const inferenceExhaustions = pgTable("inference_exhaustions", {
  id: uuid("id").primaryKey().defaultRandom(),
  companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
  key: text("key").notNull(),
  until: timestamp("until", { withTimezone: true }).notNull(),
  observedAt: timestamp("observed_at", { withTimezone: true }).notNull().defaultNow(),
  runId: uuid("run_id"),
  message: text("message"),
}, (t) => [
  uniqueIndex("inference_exhaustions_company_key_uq").on(t.companyId, t.key),
]);
