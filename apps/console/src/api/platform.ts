// The slice of the platform API every page of the console leans on: who is
// signed in, what they may do, and the two lookups that turn ids into names.
// Shapes match apps/launcher/src/api/platform.ts where the two call the same
// route, so a change to a response is felt in one place per app.
import { api } from './client';

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
  unlock: (password: string) => api.post<{ locked: false }>('/auth/unlock', { password }),
  /**
   * Spend the launcher's hand-off token for a cookie on this origin (S2-02).
   * Single-use, short-lived and bound to the console's origin, so one copied
   * out of an address bar buys nothing anywhere else.
   */
  handoffExchange: (token: string) => api.post<{ ok: true }>('/auth/handoff/exchange', { token }),
  me: () => api.get<MeResponse>('/me'),
  permissions: () => api.get<{ permissions: EffectivePermission[] }>('/me/permissions'),
};

export interface BranchRow {
  id: string;
  name: string;
  code: string;
  timezone: string;
  archived: boolean;
  /**
   * When this branch trades, per weekday (S2-04). Optional because the route
   * may not send it yet, and the difference matters: UNDEFINED means this
   * deployment does not report hours, NULL means nobody has set them — and the
   * watchdog only calls a box offline during trading, so a branch with no
   * hours never raises that alert. Health says so rather than looking healthy.
   */
  openingHours?: Record<string, { open: string; close: string }> | null;
}

export interface AccountRow {
  id: string;
  phone: string;
  status: string;
  employee: { id: string; name: string } | null;
}

/**
 * Names for the ids the audit log records. Both are optional to the console:
 * an account holding `admin:audit:read` need not hold `admin:branch:read` or
 * `admin:account:read`, so each lookup is allowed to fail and the page falls
 * back to the id. A filter that disappears is better than a page that does.
 */
export const directoryApi = {
  branches: () => api.get<{ branches: BranchRow[] }>('/branches'),
  accounts: () => api.get<{ accounts: AccountRow[] }>('/accounts'),
};
