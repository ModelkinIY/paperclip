import type { IssueStatus } from "@paperclipai/shared";
import { api } from "./client";

/** inferdyne fork: pod mutex (resource lock via labels). */
export interface PodMutexHolder {
  rootIssueId: string;
  identifier: string | null;
  title: string | null;
  acquiredAt: string;
  acquiredByIssueId: string | null;
  stillHolding: boolean;
}

export interface PodMutexWaiter {
  issueId: string;
  identifier: string | null;
  title: string;
  priority: string;
  status: string;
  hasQueuedRun: boolean;
}

export interface PodMutexEntry {
  id: string;
  labelId: string;
  labelName: string;
  labelColor: string;
  holdingStatuses: IssueStatus[];
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
  holder: PodMutexHolder | null;
  waiting: PodMutexWaiter[];
}

export interface PodMutexUpsertInput {
  labelId?: string | null;
  labelName?: string | null;
  holdingStatuses?: IssueStatus[];
  enabled?: boolean;
}

export const podMutexApi = {
  list: (companyId: string) => api.get<PodMutexEntry[]>(`/companies/${companyId}/pod-mutexes`),
  create: (companyId: string, data: PodMutexUpsertInput) =>
    api.post<unknown>(`/companies/${companyId}/pod-mutexes`, data),
  update: (companyId: string, labelId: string, data: PodMutexUpsertInput) =>
    api.patch<unknown>(`/companies/${companyId}/pod-mutexes/${encodeURIComponent(labelId)}`, data),
  remove: (companyId: string, labelId: string) =>
    api.delete<unknown>(`/companies/${companyId}/pod-mutexes/${encodeURIComponent(labelId)}`),
  release: (companyId: string, labelId: string) =>
    api.post<unknown>(`/companies/${companyId}/pod-mutexes/${encodeURIComponent(labelId)}/release`, {}),
};
