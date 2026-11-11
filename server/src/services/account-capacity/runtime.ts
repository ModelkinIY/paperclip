import { AccountCapacityStore } from "./store.js";
import { DbLimitSettingsStore } from "./settings-db.js";

/** Process-wide state: one snapshot per grant. Settings move to the DB in a later stage. */
export const limitSettingsStore = new DbLimitSettingsStore();
export const accountCapacity = new AccountCapacityStore(limitSettingsStore);

export function resetAccountCapacityForTests() {
  (accountCapacity as unknown as { entries: Map<string, unknown> }).entries.clear();
}
