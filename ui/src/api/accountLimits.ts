import type { AccountLimitSettingsPatch, AccountLimitView } from "@paperclipai/shared";
import { api } from "./client";

export type { AccountLimitSettingsPatch, AccountLimitView, AccountLimitWindowView } from "@paperclipai/shared";

/** inferdyne fork: subscription-limit accounting per AI account (grant), board only. */
export const accountLimitsApi = {
  list: (companyId: string) => api.get<AccountLimitView[]>(`/companies/${companyId}/account-limits`),
  update: (companyId: string, grantId: string, patch: AccountLimitSettingsPatch) =>
    api.patch<{ settings: AccountLimitView["settings"] }>(`/companies/${companyId}/account-limits/${encodeURIComponent(grantId)}`, patch),
  refresh: (companyId: string, grantId: string) =>
    api.post<{ probed: boolean }>(`/companies/${companyId}/account-limits/${encodeURIComponent(grantId)}/refresh`, {}),
};
