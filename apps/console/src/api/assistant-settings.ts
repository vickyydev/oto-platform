import type { ApiBody, ApiResponse } from '@oto/api-types';
import { api } from './client';

export type AssistantSettingsRead = ApiResponse<'/assistant-settings', 'get'>;
export type AssistantSettingsWrite = ApiBody<'/assistant-settings', 'put'>;
export type AssistantRate = AssistantSettingsWrite['rates'][number];

export const assistantSettingsApi = {
  read: () => api.get<ApiResponse<'/assistant-settings', 'get'>>('/assistant-settings'),
  save: (body: AssistantSettingsWrite, idempotencyKey: string) =>
    api.put<ApiResponse<'/assistant-settings', 'put'>>('/assistant-settings', body, { idempotencyKey }),
};
