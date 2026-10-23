import type { ApiBody, ApiResponse } from '@oto/api-types';
import { withHandoffTarget } from '@oto/shared/handoff-target';
import { api, idemKey } from './client';

export type RoutingTeams = ApiResponse<'/inbox/teams', 'get'>;
export type RoutingTeam = RoutingTeams['teams'][number];
export type RoutingRules = ApiResponse<'/inbox/routing-rules', 'get'>;
export type RoutingRule = RoutingRules['rules'][number];
export type TeamCreate = ApiBody<'/inbox/teams', 'post'>;
export type TeamPatch = ApiBody<'/inbox/teams/{id}', 'patch'>;
export type RuleCreate = ApiBody<'/inbox/routing-rules', 'post'>;
export type RulePatch = ApiBody<'/inbox/routing-rules/{id}', 'patch'>;

export const inboxRoutingApi = {
  teams: () => api.get<ApiResponse<'/inbox/teams', 'get'>>('/inbox/teams'),
  rules: () => api.get<ApiResponse<'/inbox/routing-rules', 'get'>>('/inbox/routing-rules'),
  createTeam: (body: TeamCreate, idempotencyKey: string) =>
    api.post<ApiResponse<'/inbox/teams', 'post'>>('/inbox/teams', body, { idempotencyKey }),
  editTeam: (id: string, body: TeamPatch, idempotencyKey: string) =>
    api.patch<ApiResponse<'/inbox/teams/{id}', 'patch'>>(`/inbox/teams/${encodeURIComponent(id)}`, body, { idempotencyKey }),
  createRule: (body: RuleCreate, idempotencyKey: string) =>
    api.post<ApiResponse<'/inbox/routing-rules', 'post'>>('/inbox/routing-rules', body, { idempotencyKey }),
  editRule: (id: string, body: RulePatch, idempotencyKey: string) =>
    api.patch<ApiResponse<'/inbox/routing-rules/{id}', 'patch'>>(`/inbox/routing-rules/${encodeURIComponent(id)}`, body, { idempotencyKey }),
  archiveRule: (id: string, idempotencyKey: string) =>
    api.delete<ApiResponse<'/inbox/routing-rules/{id}', 'delete'>>(`/inbox/routing-rules/${encodeURIComponent(id)}`, { idempotencyKey }),
};

export type InboxSetting = 'numbers' | 'templates' | 'knowledge' | 'examples';

const SETTINGS_TARGETS: Record<InboxSetting, string> = {
  numbers: '/?settings=assistant&section=numbers',
  templates: '/?settings=templates',
  knowledge: '/?settings=assistant&section=knowledge',
  examples: '/?settings=assistant&section=examples',
};

/** Issue an acting-user handoff only when the person chooses a settings page. */
export async function openInboxSettings(kind: InboxSetting, isCurrent: () => boolean): Promise<void> {
  if (!isCurrent()) return;
  const issued = await api.post('/auth/handoff',
    { app: 'inbox' } satisfies ApiBody<'/auth/handoff', 'post'>, { idempotencyKey: idemKey() });
  if (!isCurrent()) return;
  if (typeof issued !== 'object' || issued === null || !('launchUrl' in issued) ||
    typeof issued.launchUrl !== 'string' || !issued.launchUrl) {
    throw new Error('Inbox has no configured destination.');
  }
  try {
    const destination = new URL(issued.launchUrl);
    if (!['http:', 'https:'].includes(destination.protocol) || !/^#handoff=[^&]+$/.test(destination.hash)) {
      throw new Error();
    }
  } catch {
    throw new Error('Inbox has no configured destination.');
  }
  try {
    window.location.assign(withHandoffTarget(issued.launchUrl, SETTINGS_TARGETS[kind]));
  } catch {
    // A browser exception can contain the one-use destination.
    throw new Error('Inbox settings could not be opened. Please try again.');
  }
}
