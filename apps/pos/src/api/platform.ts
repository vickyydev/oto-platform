// Typed calls to the Sprint 1 API surface, with mapping between the API's
// satang integers and the prototype UI's whole-baht numbers done in mappers.ts.
import { newId as newRecordId } from '@oto/shared';
import { PERMISSIONS, type Permission } from '@oto/shared/permissions';
import { api, idemKey } from './client';

// --- auth / me -------------------------------------------------------------
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

export const authApi = {
  signIn: (phone: string, password: string) =>
    api.post<{ accountId: string; mustChangePassword: boolean }>('/auth/sign-in', { phone, password }),
  signOut: () => api.post<{ ok: true }>('/auth/sign-out'),
  /**
   * Spend a launcher hand-off token for this origin's own session cookie
   * (S2-02). The token is single-use, short-lived and bound to this origin,
   * so one copied out of the address bar buys nothing anywhere else. The
   * refusal reason arrives as the error code (and `details.reason`), because
   * "expired" and "issued for another app" call for different actions.
   */
  handoffExchange: (token: string) => api.post<{ ok: true }>('/auth/handoff/exchange', { token }),
  /** Inactivity lock: the session survives, business routes refuse (S2-01a). */
  lock: () => api.post<{ locked: true }>('/auth/lock'),
  unlock: (password: string) => api.post<{ locked: false }>('/auth/unlock', { password }),
  me: () => api.get<MeResponse>('/me'),
  permissions: () =>
    api.get<{ permissions: Array<{ permission: string; scopeType: string; scopeId: string | null }> }>(
      '/me/permissions',
    ),
  changePassword: (currentPassword: string, password: string) =>
    api.post<{ ok: true }>('/auth/change-password', { currentPassword, password }),
  setupStart: (phone: string) => api.post<{ ok: true }>('/auth/setup/start', { phone }),
  setupComplete: (phone: string, code: string, password: string) =>
    api.post<{ ok: true }>('/auth/setup/complete', { phone, code, password }),
  resetRequest: (phone: string) => api.post<{ ok: true }>('/auth/password-reset/request', { phone }),
  resetComplete: (phone: string, code: string, password: string) =>
    api.post<{ ok: true }>('/auth/password-reset/complete', { phone, code, password }),
  switchBranch: (branchId: string) => api.put<{ ok: true }>('/me/session/branch', { branchId }),
  stagePendingLookup: (phone: string) => api.put<{ ok: true }>('/me/session/pending-lookup', { phone }),
  consumePendingLookup: () => api.post<{ phone: string | null }>('/me/session/pending-lookup/consume'),
};

// --- members / children / visits -------------------------------------------
export interface ApiChild {
  id: string;
  name: string;
  dateOfBirth: string | null;
  ageYears: number | null;
  allergies: string | null;
  medicalNotes: string | null;
  medicalAlert: boolean;
  dietary: string | null;
  foodRestrictions: string | null;
  notes: string | null;
  lastConfirmedAt: string | null;
}

export interface ApiMember {
  id: string;
  phone: string;
  nickname: string;
  name: string | null;
  email: string | null;
  tierCode: string;
  preferredChannel: 'whatsapp' | 'telegram' | 'line' | null;
  notes: string | null;
  tierVerification: {
    tier: string;
    proofType: string;
    verifiedAt: string;
    /** Staff who checked the document — stamped server-side from the session. */
    verifiedBy: string | null;
    /** Document expiry (YYYY-MM-DD); the API hides expired verifications. */
    expiresAt: string | null;
  } | null;
  children: ApiChild[];
}

export interface ApiTierVerificationRecord {
  id: string;
  member: { id: string; nickname: string; phone: string };
  fromTier: string;
  toTier: string;
  evidenceType: string;
  evidenceExpiresAt: string | null;
  expired: boolean;
  verifiedBy: string | null;
  branch: string | null;
  note: string | null;
  verifiedAt: string;
}

export const membersApi = {
  lookup: (phone: string) =>
    api.get<{ member: ApiMember | null }>(`/members/lookup?phone=${encodeURIComponent(phone)}`),
  list: (q?: string) =>
    api.get<{ members: ApiMember[] }>(`/members${q ? `?q=${encodeURIComponent(q)}` : ''}`),
  archive: (id: string) => api.delete<{ ok: true }>(`/members/${id}`),
  get: (id: string) => api.get<{ member: ApiMember }>(`/members/${id}`),
  /**
   * The till mints the member's id (S2-01b). A retry through a dropped
   * connection then carries the same id, and the API answers with the member
   * that already exists instead of creating a second one — belt to the
   * Idempotency-Key's braces, and the one that survives a client restart.
   */
  create: (body: { phone: string; nickname: string; preferredChannel?: 'whatsapp' | 'telegram' | 'line' }) =>
    api.post<{ member: ApiMember }>('/members', { id: newRecordId(), ...body }, { idempotencyKey: idemKey() }),
  update: (id: string, patch: Record<string, unknown>) =>
    api.patch<{ member: ApiMember }>(`/members/${id}`, patch),
  addChild: (memberId: string, body: Record<string, unknown>) =>
    api.post<{ child: ApiChild }>(`/members/${memberId}/children`, body, { idempotencyKey: idemKey() }),
  updateChild: (childId: string, patch: Record<string, unknown>) =>
    api.patch<{ child: ApiChild }>(`/members/children/${childId}`, patch),
  verifyTier: (memberId: string, body: { toTier: string; evidenceType: string; evidenceExpiresAt: string; note?: string }) =>
    api.post<{ member: ApiMember }>(`/members/${memberId}/tier-verification`, body, { idempotencyKey: idemKey() }),
  tierVerifications: () =>
    api.get<{ verifications: ApiTierVerificationRecord[] }>('/members/tier-verifications'),
};

export const visitsApi = {
  /** Client-minted id, for the reason given on membersApi.create. */
  create: (body: { memberId?: string | null; childIds: string[] }) =>
    api.post<{ id: string; visitDate: string; status: string }>(
      '/visits',
      { id: newRecordId(), ...body },
      { idempotencyKey: idemKey() },
    ),
};

// --- branches / catalog -----------------------------------------------------
export interface ApiBranch {
  id: string;
  name: string;
  code: string;
  timezone: string;
  country: string | null;
  archived: boolean;
}

export const branchesApi = {
  list: () => api.get<{ branches: ApiBranch[] }>('/branches'),
  create: (body: { name: string; code: string; timezone?: string; country?: string }) =>
    api.post<{ id: string }>('/branches', body, { idempotencyKey: idemKey() }),
  update: (id: string, patch: Record<string, unknown>) => api.patch<{ ok: true }>(`/branches/${id}`, patch),
};

export interface ApiTicketPackage {
  id: string;
  name: string;
  description: string | null;
  durationLabel: string;
  hours: number;
  prices: Record<string, { weekday: number; weekend: number }>;
  tierPricing: Record<string, { mode: string; value: number }> | null;
  adultRules: Record<
    string,
    { kind: string; price?: { weekday: number; weekend: number }; freeAdults?: number; overflow?: string }
  > | null;
  freebies: unknown[] | null;
  creditRule: { appliesTo: string; basis: string; value?: number } | null;
  gateAccess: boolean;
  translations: Record<string, { name: string; description?: string }> | null;
  active: boolean;
}

export const catalogApi = {
  tiers: () =>
    api.get<{
      tiers: Array<{ id: string; name: string; isDefault: boolean; requiresVerification: boolean; sortOrder: number }>;
    }>('/tiers'),
  packages: (branchId: string) =>
    api.get<{ packages: ApiTicketPackage[] }>(`/branches/${branchId}/ticket-packages`),
  createPackage: (branchId: string, body: Record<string, unknown>) =>
    api.post<{ id: string }>(`/branches/${branchId}/ticket-packages`, body, { idempotencyKey: idemKey() }),
  updatePackage: (branchId: string, id: string, body: Record<string, unknown>) =>
    api.patch<{ ok: true }>(`/branches/${branchId}/ticket-packages/${id}`, body),
  archivePackage: (branchId: string, id: string) =>
    api.delete<{ ok: true }>(`/branches/${branchId}/ticket-packages/${id}`),
  pricingMode: (branchId: string, date?: string) =>
    api.get<{ date: string; mode: 'weekday' | 'weekend'; reason: string; overrideName?: string }>(
      `/branches/${branchId}/pricing-mode${date ? `?date=${date}` : ''}`,
    ),
  holidays: (branchId: string) =>
    api.get<{ holidays: Array<{ id: string; name: string; startsOn: string; endsOn: string }> }>(
      `/branches/${branchId}/holidays`,
    ),
  createHoliday: (branchId: string, body: { name: string; startsOn: string; endsOn: string }) =>
    api.post<{ id: string }>(`/branches/${branchId}/holidays`, body, { idempotencyKey: idemKey() }),
  deleteHoliday: (branchId: string, id: string) =>
    api.delete<{ ok: true }>(`/branches/${branchId}/holidays/${id}`),
  taxConfig: (branchId: string) => api.get<{ config: unknown | null }>(`/branches/${branchId}/tax-config`),
  putTaxConfig: (branchId: string, config: unknown) =>
    api.put<{ ok: true }>(`/branches/${branchId}/tax-config`, config),
};

// --- public booking site (no session) ---------------------------------------
export interface PublicCatalog {
  branch: { code: string; name: string; timezone: string };
  tiers: Array<{ id: string; name: string; isDefault: boolean; requiresVerification: boolean }>;
  packages: ApiTicketPackage[];
  rateMode: { date: string; mode: 'weekday' | 'weekend'; reason: string; overrideName?: string };
  holidays: Array<{ name: string; startsOn: string; endsOn: string }>;
}

export const publicApi = {
  catalog: (branchCode: string) => api.get<PublicCatalog>(`/public/branches/${branchCode}/catalog`),
  /** `branchCode` scopes the lookup to one operator — required by the API. */
  memberTier: (phone: string, branchCode: string) =>
    api.get<
      | { found: false }
      | {
          found: true;
          memberId: string;
          nickname: string;
          tierCode: string;
          preferredChannel: 'whatsapp' | 'telegram' | 'line' | null;
        }
    >(
      `/public/member-tier?phone=${encodeURIComponent(phone)}&branch=${encodeURIComponent(branchCode)}`,
    ),
  createBooking: (body: {
    branchCode: string;
    phone?: string;
    parentName: string;
    tier: string;
    visitDate?: string;
    lines: Array<{ packageId: string; kids: number; adults: number }>;
    contactChannel?: 'whatsapp' | 'telegram' | 'line';
    locale?: string;
    clientSnapshot?: unknown;
  }) =>
    api.post<{
      id: string;
      reference: string;
      visitDate: string;
      rateMode: 'weekday' | 'weekend';
      totalSatang: number;
      lines: unknown[];
    }>('/public/bookings', body, { idempotencyKey: idemKey() }),
};

// --- admin: accounts / roles / operators ------------------------------------
export const adminApi = {
  accounts: (q?: string) =>
    api.get<{
      accounts: Array<{
        id: string;
        phone: string;
        status: string;
        mustChangePassword: boolean;
        employee: { id: string; name: string } | null;
      }>;
    }>(`/accounts${q ? `?q=${encodeURIComponent(q)}` : ''}`),
  createAccount: (body: {
    phone: string;
    employeeName?: string;
    roles: Array<{ roleName: string; scopeType: string; scopeId: string | null }>;
  }) =>
    /** `codeSent` is false when the account was created but the text did not
     *  go out — the account exists and the code can be re-sent (S2-01c). */
    api.post<{ id: string; status: string; codeSent: boolean; warning?: string }>(
      '/accounts',
      body,
      { idempotencyKey: idemKey() },
    ),
  updateAccount: (id: string, patch: { status?: 'active' | 'inactive'; phone?: string }) =>
    api.patch<{ ok: true }>(`/accounts/${id}`, patch),
  tempPassword: (id: string) => api.post<{ temporaryPassword: string }>(`/accounts/${id}/temp-password`),
  accountPermissions: (id: string) =>
    api.get<{
      assignments: Array<{ id: string; roleName: string; scopeType: string; scopeId: string | null }>;
      effective: Array<{ permission: string; scopeType: string; scopeId: string | null; roleName: string }>;
    }>(`/accounts/${id}/permissions`),
  assignRole: (id: string, body: { roleName: string; scopeType: string; scopeId: string | null }) =>
    api.post<{ id: string }>(`/accounts/${id}/role-assignments`, body, { idempotencyKey: idemKey() }),
  removeAssignment: (accountId: string, assignmentId: string) =>
    api.delete<{ ok: true }>(`/accounts/${accountId}/role-assignments/${assignmentId}`),
  /** S2-01a — sessions an account holds, for the Login Users panel. */
  accountSessions: (id: string) =>
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
    }>(`/accounts/${id}/sessions`),
  /** S2-01a — "Sign out everywhere": end every session this account holds. */
  revokeSessions: (id: string) =>
    api.post<{ sessionsEnded: number }>(`/accounts/${id}/sessions/revoke`),
  /** S2-01a — refusals recorded by the API, newest first. */
  recentDenials: (limit = 10) =>
    api.get<{
      entries: Array<{
        id: string;
        actorAccountId: string | null;
        requestId: string | null;
        after: { code: string; message: string; method: string; url: string } | null;
        createdAt: string;
      }>;
    }>(`/audit?action=access.denied&limit=${limit}`),
  operators: () => api.get<{ operators: Array<{ id: string; name: string }> }>('/operators'),
  createOperator: (name: string) =>
    api.post<{ id: string }>('/operators', { name }, { idempotencyKey: idemKey() }),
  archiveOperator: (id: string) => api.patch<{ ok: true }>(`/operators/${id}`, { archived: true }),
  assignOperatorAdmin: (id: string, body: { phone: string; name: string }) =>
    api.post<{ accountId: string; codeSent: boolean; warning?: string }>(
      `/operators/${id}/administrators`,
      body,
      { idempotencyKey: idemKey() },
    ),
};

// --- admin: app identities (S2-17a) -----------------------------------------
/** `app:<key>:access` — the permission that puts an app's tile on the launcher. */
export type AppAccessPermission = Extract<Permission, `app:${string}:access`>;

/** The slug in that permission, which is also the name the routes below take. */
export type AppKey = AppAccessPermission extends `app:${infer K}:access` ? K : never;

const isAppAccess = (p: Permission): p is AppAccessPermission =>
  p.startsWith('app:') && p.endsWith(':access');

/**
 * The apps a tile can be granted for, read out of the permission list itself
 * rather than written down a second time: an app joins the suite by gaining an
 * `app:<key>:access` string in packages/shared, and this list follows it there.
 */
export const APP_KEYS: AppKey[] = PERMISSIONS.filter(isAppAccess).map(
  // The template-literal type above guarantees the shape, but TypeScript cannot
  // narrow the result of a slice, so the key is asserted rather than parsed.
  (p) => p.slice('app:'.length, -':access'.length) as AppKey,
);

export const appAccessPermission = (app: AppKey): AppAccessPermission => `app:${app}:access`;

/** What an app knows this account as. One per app, at most. */
export interface AppIdentity {
  id: string;
  app: AppKey;
  /** The id inside that app — `otoapp.users.id` for the OTO App. */
  externalUserId: string;
  createdAt: string;
  createdBy: string | null;
  /**
   * The API's own answer to "does the tile actually open". The panel works the
   * same fact out of the role list instead, because it has to name the role
   * that grants it and one derivation is better than two.
   */
  hasAccess: boolean;
}

/**
 * The OTO App's own role vocabulary, as that app spells it
 * (`userRoles` in its `shared/schema.ts`). Not platform roles and not a
 * translation of them: they answer different questions, so whoever provisions
 * somebody picks from this list.
 */
export const OTO_APP_ROLES = [
  { value: 'global_admin', label: 'Global admin' },
  { value: 'operator_admin', label: 'Operator admin' },
  { value: 'admin', label: 'Admin' },
  { value: 'manager', label: 'Manager' },
  { value: 'staff', label: 'Staff' },
] as const;
export type OtoAppRole = (typeof OTO_APP_ROLES)[number]['value'];

export const appIdentitiesApi = {
  list: (accountId: string) =>
    api.get<{ identities: AppIdentity[] }>(`/admin/apps/users/${accountId}`),
  /**
   * Provisioning: one call records the link and grants `app:<key>:access`,
   * because the two halves are useless apart — a permission with no identity
   * opens onto a refusal, an identity with no permission is a user in that app
   * that nobody can reach.
   *
   * For the OTO App, which is on the same database, one of the two is sent:
   * `externalUserId` claims a user that app already has, `otoApp` creates one.
   * Every other app mints its own user, so its id is all there is to send.
   */
  link: (
    app: AppKey,
    body: {
      accountId: string;
      externalUserId?: string;
      otoApp?: { email: string; fullName?: string; role: OtoAppRole };
    },
  ) =>
    api.post<{
      id: string;
      app: AppKey;
      accountId: string;
      externalUserId: string;
      appUserCreated?: boolean;
    }>(`/admin/apps/${app}/users`, body, { idempotencyKey: idemKey() }),
  /** `accessRevoked` is false when the permission also comes from another role. */
  unlink: (app: AppKey, accountId: string) =>
    api.delete<{ ok: true; accessRevoked: boolean }>(`/admin/apps/${app}/users/${accountId}`),
};

// --- ops: staging-only controls (S2-01c) ------------------------------------
export const opsApi = {
  /**
   * Answers rather than refuses, so a console that is not entitled to the
   * control simply never renders it. `available` is false both for a caller
   * who is not a platform admin and on a deployment that did not opt in.
   */
  demoResetStatus: () =>
    api.get<{ available: boolean; confirmationPhrase: string }>('/ops/demo-reset'),
  demoReset: (confirm: string) =>
    api.post<{ deleted: Record<string, number> }>(
      '/ops/demo-reset',
      { confirm },
      { idempotencyKey: idemKey() },
    ),
};
