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
  };
}

/** In-memory cache with write-through to ai_grant_limit_settings. Reads stay synchronous. */
export class DbLimitSettingsStore extends InMemoryLimitSettingsStore {
  /** Replace the cache with the table's contents (rows only; defaults are implicit). */
  async load(db: Db) {
    const rows = await db.select().from(aiGrantLimitSettings);
    this.clear();
    for (const row of rows) this.set(row.grantId, fromRow(row));
  }

  async update(db: Db, companyId: string, grantId: string, patch: AccountLimitSettingsPatch, actor: string | null): Promise<LimitSettings> {
    const next: LimitSettings = {
      ...this.get(grantId),
      ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
      ...(patch.paceModel !== undefined ? { paceModel: patch.paceModel } : {}),
      ...(patch.weekly ? { weekly: patch.weekly } : {}),
      ...(patch.fiveHour ? { fiveHour: patch.fiveHour } : {}),
      ...(patch.maxStaleMinutes !== undefined ? { maxStaleMinutes: patch.maxStaleMinutes } : {}),
    };
    const values = {
      enabled: next.enabled, paceModel: next.paceModel, weeklyParams: next.weekly, fiveHourParams: next.fiveHour,
      maxStaleMinutes: next.maxStaleMinutes, updatedAt: new Date(), updatedBy: actor,
    };
    await db.insert(aiGrantLimitSettings).values({ companyId, grantId, ...values })
      .onConflictDoUpdate({ target: [aiGrantLimitSettings.companyId, aiGrantLimitSettings.grantId], set: values });
    this.set(grantId, next);
    return next;
  }
}
