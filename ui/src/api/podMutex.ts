import type {
  PodMutexConfigRowResponse,
  PodMutexEntry,
  PodMutexReleaseResponse,
  PodMutexUpsertInput,
} from "@paperclipai/shared";
import { api } from "./client";

/** inferdyne fork: pod mutex (resource lock via labels). Types live in @paperclipai/shared. */
export type {
  PodMutexConfigRowResponse,
  PodMutexEntry,
  PodMutexHolder,
  PodMutexReleaseResponse,
  PodMutexUpsertInput,
  PodMutexWaiter,
} from "@paperclipai/shared";

export const podMutexApi = {
  list: (companyId: string) => api.get<PodMutexEntry[]>(`/companies/${companyId}/pod-mutexes`),
  create: (companyId: string, data: PodMutexUpsertInput) =>
    api.post<PodMutexConfigRowResponse>(`/companies/${companyId}/pod-mutexes`, data),
  update: (companyId: string, labelId: string, data: PodMutexUpsertInput) =>
    api.patch<PodMutexConfigRowResponse>(`/companies/${companyId}/pod-mutexes/${encodeURIComponent(labelId)}`, data),
  remove: (companyId: string, labelId: string) =>
    api.delete<{ ok: true }>(`/companies/${companyId}/pod-mutexes/${encodeURIComponent(labelId)}`),
  release: (companyId: string, labelId: string) =>
    api.post<PodMutexReleaseResponse>(`/companies/${companyId}/pod-mutexes/${encodeURIComponent(labelId)}/release`, {}),
};
