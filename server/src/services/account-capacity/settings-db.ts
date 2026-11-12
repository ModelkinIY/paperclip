import { and, eq } from "drizzle-orm";
import { aiGrantLimitSettings, type Db } from "@paperclipai/db";
import type { AccountLimitSettingsPatch } from "@paperclipai/shared";
import { InMemoryLimitSettingsStore } from "./store.js";
import { DEFAULT_LIMIT_SETTINGS, type LimitSettings } from "./types.js";

type Row = typeof aiGrantLimitSettings.$inferSelect;

function fromRow(row: Row): LimitSettings {
  return {
    enabled: row.enabled,
    paceModel: row.paceModel,
    weekly: row.weeklyParams ?? DEFAULT_LIMIT_SETTINGS.weekly,
    fiveHour: row.fiveHourParams ?? DEFAULT_LIMIT_SETTINGS.fiveHour,
    maxStaleMinutes: row.maxStaleMinutes ?? DEFAULT_LIMIT_SETTINGS.maxStaleMinutes,
    cacheKeepaliveMode: row.cacheKeepaliveMode ?? DEFAULT_LIMIT_SETTINGS.cacheKeepaliveMode,
  };
}

/** In-memory cache with write-through to ai_grant_limit_settings. Reads stay synchronous. */
export class DbLimitSettingsStore extends InMemoryLimitSettingsStore {
  /** Replace the cache with the table's contents (rows only; defaults are implicit). */
  async load(db: Db) {
    const rows = await db.select().from(aiGrantLimitSettings);
    this.replaceAll(new Map(rows.map((row) => [row.grantId, fromRow(row)])));
  }

  /** Writes only the fields in the patch, so concurrent edits of different fields do not undo each other. */
  async update(db: Db, companyId: string, grantId: string, patch: AccountLimitSettingsPatch, actor: string | null): Promise<LimitSettings> {
    const changes: Partial<typeof aiGrantLimitSettings.$inferInsert> = {
      ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
      ...(patch.paceModel !== undefined ? { paceModel: patch.paceModel } : {}),
      ...(patch.weekly ? { weeklyParams: patch.weekly } : {}),
      ...(patch.fiveHour ? { fiveHourParams: patch.fiveHour } : {}),
      ...(patch.maxStaleMinutes !== undefined ? { maxStaleMinutes: patch.maxStaleMinutes } : {}),
      updatedAt: new Date(), updatedBy: actor,
    };
    const [row] = await db.insert(aiGrantLimitSettings).values({ companyId, grantId, ...changes })
      .onConflictDoUpdate({ target: [aiGrantLimitSettings.companyId, aiGrantLimitSettings.grantId], set: changes })
      .returning();
    const next = fromRow(row!);
    this.set(grantId, next);
    return next;
  }
}
