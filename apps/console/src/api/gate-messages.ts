import type { ApiBody, ApiResponse } from '@oto/api-types';
import { api } from './client';

/** SCRUM-1078 — what the gate readers at one park say, per case and language. */
export type GateMessagesRead = ApiResponse<'/branches/{branchId}/gate-messages', 'get'>;
export type GateMessagesWrite = ApiBody<'/branches/{branchId}/gate-messages', 'put'>;

export const gateMessagesApi = {
  read: (branchId: string) =>
    api.get<ApiResponse<'/branches/{branchId}/gate-messages', 'get'>>(`/branches/${branchId}/gate-messages`),
  save: (branchId: string, body: GateMessagesWrite, idempotencyKey: string) =>
    api.put<ApiResponse<'/branches/{branchId}/gate-messages', 'put'>>(
      `/branches/${branchId}/gate-messages`,
      body,
      { idempotencyKey },
    ),
};
