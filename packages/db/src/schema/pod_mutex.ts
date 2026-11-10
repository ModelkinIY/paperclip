import { pgTable, uuid, text, timestamp, boolean, index, uniqueIndex } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { issues } from "./issues.js";
import { labels } from "./labels.js";

/**
 * inferdyne fork: a label configured as a resource mutex ("pod mutex").
 * Only one issue tree carrying the label may hold the resource at a time.
 */
export const podMutexLabels = pgTable(
  "pod_mutex_labels",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    labelId: uuid("label_id").notNull().references(() => labels.id, { onDelete: "cascade" }),
    holdingStatuses: text("holding_statuses").array().notNull().default(["todo", "in_progress"]),
    enabled: boolean("enabled").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyLabelIdx: uniqueIndex("pod_mutex_labels_company_label_idx").on(table.companyId, table.labelId),
  }),
);

/** inferdyne fork: the current holder of a pod mutex. Released lazily. */
export const podMutexLeases = pgTable(
  "pod_mutex_leases",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    labelId: uuid("label_id").notNull().references(() => labels.id, { onDelete: "cascade" }),
    holderRootIssueId: uuid("holder_root_issue_id").notNull().references(() => issues.id, { onDelete: "cascade" }),
    acquiredByIssueId: uuid("acquired_by_issue_id").references(() => issues.id, { onDelete: "set null" }),
    acquiredAt: timestamp("acquired_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyLabelIdx: uniqueIndex("pod_mutex_leases_company_label_idx").on(table.companyId, table.labelId),
    holderIdx: index("pod_mutex_leases_holder_idx").on(table.holderRootIssueId),
  }),
);
