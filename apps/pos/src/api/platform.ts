// Typed calls to the Sprint 1 API surface, with mapping between the API's
// satang integers and the prototype UI's whole-baht numbers done in mappers.ts.
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
}

export const authApi = {
  signIn: (phone: string, password: string) =>
    api.post<{ accountId: string; mustChangePassword: boolean }>('/auth/sign-in', { phone, password }),
  signOut: () => api.post<{ ok: true }>('/auth/sign-out'),
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
  preferredChannel: 'whatsapp' | 'telegram' | null;
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
  create: (body: { phone: string; nickname: string; preferredChannel?: 'whatsapp' | 'telegram' }) =>
    api.post<{ member: ApiMember }>('/members', body, { idempotencyKey: idemKey() }),
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
  create: (body: { memberId?: string | null; childIds: string[] }) =>
    api.post<{ id: string; visitDate: string; status: string }>('/visits', body, {
      idempotencyKey: idemKey(),
    }),
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
  memberTier: (phone: string) =>
    api.get<
      | { found: false }
      | {
          found: true;
          memberId: string;
          nickname: string;
          tierCode: string;
          preferredChannel: 'whatsapp' | 'telegram' | null;
        }
    >(`/public/member-tier?phone=${encodeURIComponent(phone)}`),
  createBooking: (body: {
    branchCode: string;
    phone?: string;
    parentName: string;
    tier: string;
    visitDate?: string;
    lines: Array<{ packageId: string; kids: number; adults: number }>;
    contactChannel?: 'whatsapp' | 'telegram';
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
  }) => api.post<{ id: string; status: string }>('/accounts', body, { idempotencyKey: idemKey() }),
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
  operators: () => api.get<{ operators: Array<{ id: string; name: string }> }>('/operators'),
  createOperator: (name: string) =>
    api.post<{ id: string }>('/operators', { name }, { idempotencyKey: idemKey() }),
  archiveOperator: (id: string) => api.patch<{ ok: true }>(`/operators/${id}`, { archived: true }),
  assignOperatorAdmin: (id: string, body: { phone: string; name: string }) =>
    api.post<{ accountId: string }>(`/operators/${id}/administrators`, body, { idempotencyKey: idemKey() }),
};
