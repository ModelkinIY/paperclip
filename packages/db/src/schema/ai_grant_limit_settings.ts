import { boolean, foreignKey, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { connectionGrants } from "./tool_access.js";

/** Subscription-limit accounting per AI account (grant). No row means defaults and accounting off. */
export const aiGrantLimitSettings = pgTable("ai_grant_limit_settings", {
  id: uuid("id").primaryKey().defaultRandom(),
  companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
  grantId: uuid("grant_id").notNull(),
  enabled: boolean("enabled").notNull().default(false),
  paceModel: text("pace_model").notNull().default("linear"),
  weeklyParams: jsonb("weekly_params").$type<{ holdAbove: number; releaseAtOrBelow: number }>(),
  fiveHourParams: jsonb("five_hour_params").$type<{ holdAbove: number; releaseAtOrBelow: number }>(),
  maxStaleMinutes: integer("max_stale_minutes"),
  lastObservation: jsonb("last_observation").$type<Record<string, unknown>>(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  updatedBy: text("updated_by"),
}, (t) => [
  uniqueIndex("ai_grant_limit_settings_company_grant_uq").on(t.companyId, t.grantId),
  foreignKey({ columns: [t.companyId, t.grantId], foreignColumns: [connectionGrants.companyId, connectionGrants.id], name: "ai_grant_limit_settings_company_grant_fk" }).onDelete("cascade"),
]);
