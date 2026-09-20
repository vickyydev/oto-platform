// The slice of the platform API the launcher speaks to. Shapes match
// apps/pos/src/api/platform.ts where the two call the same route, so a change
// to a response is felt in one place per app rather than being re-guessed.
import { api } from './client';
import type { SuiteAppKey } from '@/suite/apps';

export interface MeResponse {
  account: {
    id: string;
    phone: string;
    status: string;
    mustChangePassword: boolean;
    operatorId: string;
  };
  employee: { id: string; name: string; nickname: string | null } | null;
  branch: { id: string; name: string; code: string; timezone: string } | null;
  isPlatformAdmin: boolean;
  photoFileId: string | null;
  /** True when this session is locked on inactivity (S2-01a). */
  sessionLocked: boolean;
}

export interface EffectivePermission {
  permission: string;
  scopeType: string;
  scopeId: string | null;
}

export const authApi = {
  signIn: (phone: string, password: string) =>
    api.post<{ accountId: string; mustChangePassword: boolean }>('/auth/sign-in', { phone, password }),
  signOut: () => api.post<{ ok: true }>('/auth/sign-out'),
  /**
   * The lock lives on the session row, so a till that locks on inactivity
   * locks this page too. The password re-opens the same session from either
   * side (S2-01a).
   */
  unlock: (password: string) => api.post<{ locked: false }>('/auth/unlock', { password }),
  /**
   * An account issued a temporary password may reach nothing else until this
   * succeeds — the API refuses every guarded route with MUST_CHANGE_PASSWORD —
   * so the front door is where it is asked for.
   */
  changePassword: (currentPassword: string, password: string) =>
    api.post<{ ok: true }>('/auth/change-password', { currentPassword, password }),
  me: () => api.get<MeResponse>('/me'),
  permissions: () => api.get<{ permissions: EffectivePermission[] }>('/me/permissions'),
  setupStart: (phone: string) => api.post<{ ok: true }>('/auth/setup/start', { phone }),
  setupComplete: (phone: string, code: string, password: string) =>
    api.post<{ ok: true }>('/auth/setup/complete', { phone, code, password }),
  resetRequest: (phone: string) => api.post<{ ok: true }>('/auth/password-reset/request', { phone }),
  resetComplete: (phone: string, code: string, password: string) =>
    api.post<{ ok: true }>('/auth/password-reset/complete', { phone, code, password }),
};

/**
 * Hand-off (S2-02). The suite is one session across several origins, and a
 * parent-domain cookie is impossible on `*.onrender.com` and would not reach
 * the booking site's own domain anyway. So the launcher asks the API for a
 * short-lived token naming the app it is about to open, and that app exchanges
 * the token at its own origin for its own cookie against the same session row.
 *
 * The token rides in the URL fragment, never the query string: a fragment is
 * not sent to any server and does not reach a Referer header, so it cannot end
 * up in an access log on the way.
 */
export interface IssuedHandoff {
  token: string;
  audience: SuiteAppKey;
  origin: string;
  /** Composed by the API from its own `HANDOFF_APP_ORIGINS` — the fragment is in it. */
  launchUrl: string;
  expiresAt: string;
}

export const handoffApi = {
  issue: (app: SuiteAppKey) => api.post<IssuedHandoff>('/auth/handoff', { app }),
};

export interface AuditEntry {
  id: string;
  action: string;
  entityType: string | null;
  entityId: string | null;
  actorAccountId: string | null;
  requestId: string | null;
  after: Record<string, unknown> | null;
  createdAt: string;
}

export const accountApi = {
  sessions: (accountId: string) =>
    api.get<{
      sessions: Array<{
        id: string;
        branchId: string | null;
        stationId: string | null;
        lockedAt: string | null;
        lastSeenAt: string;
        expiresAt: string;
        createdAt: string;
      }>;
    }>(`/accounts/${accountId}/sessions`),
  /** Ends every session this account holds, on every app origin at once. */
  revokeSessions: (accountId: string) =>
    api.post<{ sessionsEnded: number }>(`/accounts/${accountId}/sessions/revoke`),
  /** Hand-offs the API refused for this account, newest first. */
  handoffRejections: (accountId: string, limit = 10) =>
    api.get<{ entries: AuditEntry[] }>(
      `/audit?action=auth.handoff_rejected&actorAccountId=${encodeURIComponent(accountId)}&limit=${limit}`,
    ),
};
