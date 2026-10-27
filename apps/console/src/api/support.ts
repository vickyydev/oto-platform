import type { ApiBody, ApiResponse } from '@oto/api-types';
import { api, qs } from './client';

/** SCRUM-648 (S2-23 P5-6): the Support tools' reads and impersonation writes. */
export type SupportLookup = ApiResponse<'/console/support/lookup', 'get'>;
export type SupportSection = SupportLookup['sections'][number];
export type SupportQueryKind = SupportSection['kind'];
export type SupportTrace = ApiResponse<'/console/support/trace', 'get'>;
export type TraceStep = SupportTrace['steps'][number];
export type TraceKind = SupportTrace['anchor']['kind'];
export type ImpersonationCard = ApiResponse<'/console/support/impersonations', 'get'>;
export type ImpersonationWindow = ImpersonationCard['windows'][number];
export type ImpersonationApproval = ImpersonationCard['approvals'][number];
export type ImpersonationStart = ApiBody<'/console/support/impersonations', 'post'>;
export type ImpersonationStarted = ApiResponse<'/console/support/impersonations', 'post'>;
export type ImpersonationTargetApp = ImpersonationStart['targetApp'];

export const supportApi = {
  /** Every lookup is one data_access audit row; each section is its own app's answer. */
  lookup: (q: string, kind?: SupportQueryKind) => api.get<ApiResponse<'/console/support/lookup', 'get'>>(`/console/support/lookup${qs({ q, kind })}`),
  /** The exact query shape the Money oversight links carry: `trace=<id>&kind=…`. */
  trace: (id: string, kind: TraceKind) => api.get<ApiResponse<'/console/support/trace', 'get'>>(`/console/support/trace${qs({ id, kind })}`),
  impersonations: () => api.get<ApiResponse<'/console/support/impersonations', 'get'>>('/console/support/impersonations'),
  /** The answer carries the hand-off into the window: never stored, never retried under a key. */
  start: (body: ImpersonationStart) => api.post<ApiResponse<'/console/support/impersonations', 'post'>>('/console/support/impersonations', body),
  requestWrite: (body: ApiBody<'/console/support/impersonations/approvals', 'post'>, idempotencyKey: string) =>
    api.post<ApiResponse<'/console/support/impersonations/approvals', 'post'>>('/console/support/impersonations/approvals', body, { idempotencyKey }),
  approveWrite: (id: string, body: ApiBody<'/console/support/impersonations/approvals/{id}/approve', 'post'>, idempotencyKey: string) =>
    api.post<ApiResponse<'/console/support/impersonations/approvals/{id}/approve', 'post'>>(
      `/console/support/impersonations/approvals/${id}/approve`, body, { idempotencyKey }),
  end: (id: string, idempotencyKey: string) =>
    api.post<ApiResponse<'/console/support/impersonations/{id}/end', 'post'>>(`/console/support/impersonations/${id}/end`, {}, { idempotencyKey }),
};
