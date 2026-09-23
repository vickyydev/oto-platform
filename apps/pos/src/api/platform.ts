// Typed calls to the Sprint 1 API surface, with mapping between the API's
// satang integers and the prototype UI's whole-baht numbers done in mappers.ts.
import { newId as newRecordId } from '@oto/shared';
import { PERMISSIONS, type Permission } from '@oto/shared/permissions';
import type { StationCapability } from '@/types';
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
  /**
   * Unlock with no internet (S2-06): the box checks the shift token against
   * its cached signing key and deny-list, and the password against its cached
   * hash. `cachedAt` is how old that copy is, which the banner shows — an
   * unlock allowed by a two-day-old cache is a different statement from one
   * allowed by a cache taken ten minutes ago.
   */
  unlockOffline: (token: string | null, password: string) =>
    api.post<{
      locked: false;
      authMethod: string;
      cachedAt: string | null;
      cacheAgeSeconds: number | null;
    }>('/auth/unlock-offline', token ? { token, password } : { password }),
  /** Mint a shift token for the station this session already holds. */
  staffToken: () =>
    api.post<{ token: string; jti: string; expiresAt: string; stationId: string }>(
      '/me/staff-token',
    ),
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
  /**
   * End a verified tier (SCRUM-241): the member goes back to the operator's
   * baseline rate and the typed reason is filed with the revocation.
   *
   * Nothing is erased — the grant row and this one both stay, which is what
   * makes the record readable as "who gave this rate and who took it away".
   * Needs `pos:member:tier_downgrade`, which reception does not hold; a till
   * session gets a 403 with that message and the screens ask a manager.
   */
  revokeTierVerification: (memberId: string, body: { reason: string }) =>
    api.delete<{ member: ApiMember }>(`/members/${memberId}/tier-verification`, body, {
      idempotencyKey: idemKey(),
    }),
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
  /** When the trading day starts, "05:00:00" (SCRUM-308). Absent on an older api. */
  businessDayStart?: string;
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
  /** The tier's `id` in the POS store is its `code` on the platform (SCRUM-228). */
  createTier: (body: {
    code: string;
    name: string;
    isDefault: boolean;
    requiresVerification: boolean;
    sortOrder: number;
  }) => api.post<{ id: string }>('/tiers', body, { idempotencyKey: idemKey() }),
  updateTier: (
    code: string,
    patch: Partial<{ name: string; isDefault: boolean; requiresVerification: boolean; sortOrder: number }>,
  ) => api.patch<{ ok: true }>(`/tiers/${encodeURIComponent(code)}`, patch),
  deleteTier: (code: string) => api.delete<{ ok: true }>(`/tiers/${encodeURIComponent(code)}`),
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
  /**
   * `pricedSales` is how many sales each range priced. Nonzero means the
   * platform has frozen its dates (SCRUM-309), so the panel can say why rather
   * than let a manager find out by being refused.
   */
  holidays: (branchId: string) =>
    api.get<{
      holidays: Array<{
        id: string;
        name: string;
        startsOn: string;
        endsOn: string;
        pricedSales: number;
      }>;
    }>(`/branches/${branchId}/holidays`),
  createHoliday: (branchId: string, body: { name: string; startsOn: string; endsOn: string }) =>
    api.post<{ id: string }>(`/branches/${branchId}/holidays`, body, { idempotencyKey: idemKey() }),
  /** The name always; the dates only while nothing has been priced by the range. */
  updateHoliday: (
    branchId: string,
    id: string,
    body: { name?: string; startsOn?: string; endsOn?: string },
  ) => api.patch<{ ok: true }>(`/branches/${branchId}/holidays/${id}`, body, { idempotencyKey: idemKey() }),
  deleteHoliday: (branchId: string, id: string) =>
    api.delete<{ ok: true }>(`/branches/${branchId}/holidays/${id}`),
  taxConfig: (branchId: string) => api.get<{ config: unknown | null }>(`/branches/${branchId}/tax-config`),
  putTaxConfig: (branchId: string, config: unknown) =>
    api.put<{ ok: true }>(`/branches/${branchId}/tax-config`, config),
};

// --- public booking site (no session) ---------------------------------------
export interface PublicCatalog {
  branch: { code: string; name: string; timezone: string; businessDayStart?: string };
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
    /**
     * `codeSent` is false when the account was created but the text did not
     * go out — the account exists and the code can be re-sent (S2-01c).
     *
     * `warning` is an OBJECT, not a string. It was typed `string` here, which
     * is what let `res.warning ?? '…'` compile in two panels: the fallback
     * never ran, React was handed an object as a child, and creating a staff
     * account white-screened the whole admin console. The account had been
     * created, so the person retried and was told the phone was already
     * taken. It only fired when the text failed, which on staging is every
     * time. The shape is `CodeDelivery` in `apps/api/src/services/auth.ts`;
     * keep the two in step.
     */
    api.post<{
      id: string;
      status: string;
      codeSent: boolean;
      warning?: { code: string; message: string };
    }>('/accounts', body, { idempotencyKey: idemKey() }),
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
    /** `warning` is an object — see `createAccount` above for what typing it
     *  as a string cost. */
    api.post<{
      accountId: string;
      codeSent: boolean;
      warning?: { code: string; message: string };
    }>(`/operators/${id}/administrators`, body, { idempotencyKey: idemKey() }),
};

// --- stations, boxes and devices (S2-04) ------------------------------------
//
// The shapes below are the same contract the Console reads (apps/console/src/
// api/fleet.ts): one set of routes, described twice because the two apps are
// built in different trees. Where a field is optional it is because the API is
// being built beside this and has not grown it yet — the POS renders what has
// arrived rather than insisting on a field it may not get.
//
// Branch-scoped reads are nested (`/branches/:id/stations`), the form the
// catalogue routes already use: a path parameter is required by the router and
// checked before the handler runs, where a `?branchId=` can be left off and
// quietly fall back to whatever branch the session is on. The two questions a
// till asks about ITSELF stay on `/me` — which stations are mine, and which am
// I taking — because neither takes a branch: the session already says.

/** What a station is for. `booth` is the Lucky Wheel's (S2-07b). */
export type StationKind = 'till' | 'kiosk' | 'gate' | 'display' | 'booth';

/**
 * Who may pick a station. The scope decides VISIBILITY, not merely permission:
 * an `all_staff` station is in every signed-in member's picker, a
 * `selected_staff` one is in the pickers of the accounts on its list and in
 * nobody else's. Someone who cannot use a till should not be looking at it and
 * wondering why it refuses them.
 */
export type StationAccessScope = 'all_staff' | 'selected_staff';

/** What a device does for a station — one per role, as the till has one field each. */
export type StationDeviceRole =
  | 'receipt'
  | 'kids_band'
  | 'adult_band'
  | 'kitchen'
  | 'bar'
  | 'scanner'
  | 'card_terminal'
  | 'qr_terminal'
  | 'gate'
  | 'cash_drawer';

export type DeviceKind =
  | 'receipt_printer'
  | 'band_printer'
  | 'kitchen_printer'
  | 'bar_printer'
  | 'scanner'
  | 'terminal'
  | 'gate'
  | 'gate_reader'
  | 'cash_drawer';

/** How the device is wired to its box; `simulated` is one on a virtual box. */
export type DeviceTransport = 'lan' | 'usb' | 'serial' | 'bluetooth' | 'simulated';

export type BoxStatus = 'unclaimed' | 'online' | 'offline' | 'disabled';

/** A box is a Raspberry Pi already standing at the branch, not a thing to create here. */
export interface ApiBox {
  id: string;
  branchId: string;
  name: string;
  /** The position on site — "counter-1". Survives a Pi being swapped. */
  slot: string;
  role: string;
  status: BoxStatus | string;
  agentVersion?: string | null;
  lastHeartbeatAt?: string | null;
  /**
   * Seconds since the last heartbeat AS THE API COUNTED IT, which is the one
   * to trust: an iPad with a wrong clock would otherwise report a healthy box
   * as silent for hours.
   */
  heartbeatAgeSeconds?: number | null;
  deviceCount?: number | null;
  archived?: boolean;
}

export interface ApiDevice {
  id: string;
  boxId: string;
  kind: DeviceKind | string;
  label: string;
  transport: DeviceTransport | string;
  address?: string | null;
  model?: string | null;
  protocol?: string | null;
  reachability?: 'unknown' | 'reachable' | 'unreachable' | string;
  /** Only meaningful on a printer; `unknown` everywhere else. */
  paperStatus?: 'unknown' | 'ok' | 'low' | 'out' | string;
  archived?: boolean;
}

/**
 * One device doing one job for a station. The label and the link are
 * denormalised by the API so a till can name the printer a receipt went to
 * without holding the whole device list.
 */
export interface StationDeviceAssignment {
  role: StationDeviceRole | string;
  deviceId: string;
  label?: string | null;
  kind?: DeviceKind | string | null;
  transport?: DeviceTransport | string | null;
  address?: string | null;
}

export interface ApiStation {
  id: string;
  branchId: string;
  boxId: string | null;
  boxName?: string | null;
  boxStatus?: BoxStatus | string | null;
  name: string;
  kind: StationKind | string;
  capabilities?: (StationCapability | string)[];
  accessScope?: StationAccessScope | string;
  /** What the box compares on each config poll. */
  configVersion?: number | null;
  devices?: StationDeviceAssignment[];
  /**
   * Who may pick it. Empty unless the scope is `selected_staff` — and empty
   * from `pick` whatever the scope, because taking a till is no reason to hand
   * an iPad on the counter the list of everybody else who may stand at it. The
   * settings screen reads the list from `get` instead.
   */
  staff?: Array<{ accountId: string; name?: string | null }>;
  archived?: boolean;
}

/**
 * One row of the picker. It carries the box and its state as well as the name,
 * because a till whose box is not answering prints nothing, and the person
 * about to stand at it should know that before the first sale rather than at
 * the moment they try to hand somebody a receipt.
 */
export interface PickableStation {
  id: string;
  name: string;
  kind: StationKind | string;
  accessScope?: StationAccessScope | string;
  boxId: string | null;
  boxName?: string | null;
  boxStatus?: BoxStatus | string | null;
  deviceCount?: number | null;
}

/**
 * An account that may be put on a station's list: the staff of that branch.
 *
 * The name is nullable because an account need not have an employee record
 * behind it — somebody granted a role at this branch and never entered in the
 * staff directory is a real person who can be named on a station, and their
 * phone is what identifies them until the rest is filled in.
 */
export interface StaffCandidate {
  accountId: string;
  name?: string | null;
  phone?: string | null;
  status?: string | null;
}

/**
 * Everything a station is written with. The branch comes from the path, not
 * the body: a station belongs to the branch it was created under and no write
 * moves it.
 *
 * The staff list and the device assignments are both sent WHOLE rather than as
 * deltas — one call, one audit row, and a before and after that reads as what
 * it is. So a role left out of `devices` is a role with nothing assigned:
 * clearing a printer is dropping it from the set, not sending a null.
 */
export interface StationInput {
  boxId: string;
  name: string;
  kind: StationKind;
  capabilities: StationCapability[];
  accessScope: StationAccessScope;
  staffAccountIds: string[];
  devices: Array<{ role: StationDeviceRole; deviceId: string }>;
}

/**
 * Scanning (S2-06).
 *
 * Every code a till reads goes to the BOX, which classifies it, hands it to
 * whichever handler claimed it and writes a fingerprint-only line on the
 * station's tape. The code itself never comes back and is never stored.
 */
export const scanApi = {
  /**
   * A badge presented or a PIN typed at a locked till. Reachable while the
   * session is locked, because that is the screen it is for.
   */
  badge: (value: string, source: 'manual' | 'keyboard' | 'camera' = 'manual') =>
    api.post<{ outcome: string; handler: string | null; message: string | null }>('/auth/badge', {
      value,
      source,
    }),
  /** Any other code — the camera, or a scanner paired to this iPad. */
  scan: (stationId: string, code: string, source: 'camera' | 'keyboard' | 'manual' = 'camera') =>
    api.post<{
      accepted: boolean;
      kind: string;
      outcome: string;
      handler: string | null;
      errorCode: string | null;
      codeFingerprint: string;
      handlers: string[];
    }>(`/stations/${encodeURIComponent(stationId)}/scan`, { code, source }),
};

/**
 * Printing (S2-06).
 *
 * The till and the admin console both read templates, so this sits beside the
 * catalogue rather than under `adminApi`. Editing one is an admin act and the
 * API says so; reading one is not.
 */
export interface ApiPrintTemplate {
  id: string;
  branchId: string;
  type: 'receipt' | 'kids_wristband' | 'adult_wristband' | 'kitchen_ticket' | 'bar_ticket' | 'credit_voucher';
  name: string;
  showLogo: boolean;
  headerText: string | null;
  footerText: string | null;
  fields: Record<string, boolean | undefined>;
  version: number;
  updatedAt: string;
}

export interface ApiPrintJob {
  id: string;
  kind: string;
  status: 'queued' | 'printed' | 'failed' | 'skipped';
  deviceId: string | null;
  deviceLabel: string | null;
  role: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  attempts: number;
  queuedAt: string;
  finishedAt: string | null;
}

export interface ApiStationPrinter {
  deviceId: string;
  label: string;
  role: string;
  kind: string;
  reachability: 'unknown' | 'reachable' | 'unreachable';
  paperStatus: 'unknown' | 'ok' | 'low' | 'out';
  lastError: string | null;
  lastSeenAt: string | null;
  queued: number;
}

export const printApi = {
  templates: (branchId: string) =>
    api.get<{ templates: ApiPrintTemplate[] }>(
      `/branches/${encodeURIComponent(branchId)}/print-templates`,
    ),
  updateTemplate: (
    id: string,
    body: Partial<Pick<ApiPrintTemplate, 'name' | 'showLogo' | 'headerText' | 'footerText' | 'fields'>>,
  ) => api.patch<{ template: ApiPrintTemplate }>(`/print-templates/${encodeURIComponent(id)}`, body),
  /**
   * Print this template's sample on a real printer. No idempotency key: two
   * presses of "Test print" mean two pieces of paper, which is exactly what
   * somebody pressing it twice is asking for.
   */
  testPrint: (id: string, body?: { stationId?: string | null; copies?: number }) =>
    api.post<{ printJob: ApiPrintJob; commandId: string; actionId: string }>(
      `/print-templates/${encodeURIComponent(id)}/test-print`,
      body ?? {},
    ),
  /**
   * The editor's preview: this draft's sample, drawn by the renderer that
   * drives the printer, answered as a PNG.
   *
   * The draft rather than the saved row, because the preview's whole job is to
   * show the effect of a toggle before anybody commits to it. Abortable: an
   * edit made while the previous render is in flight replaces it rather than
   * racing it.
   */
  previewPng: (
    id: string,
    body: {
      name?: string;
      showLogo?: boolean;
      headerText?: string | null;
      footerText?: string | null;
      fields?: Record<string, boolean | undefined>;
      stationId?: string | null;
    },
    signal?: AbortSignal,
  ) => api.postBlob(`/print-templates/${encodeURIComponent(id)}/preview.png`, body, signal),
  /** What this station's printers last said. Drives the header indicator. */
  stationPrinters: (stationId: string) =>
    api.get<{ printers: ApiStationPrinter[] }>(
      `/stations/${encodeURIComponent(stationId)}/printers`,
    ),
};

export const stationsApi = {
  /**
   * The stations this account may work at the branch its session is on,
   * already filtered by access scope. The filtering is the API's and not ours:
   * a station somebody may not use never reaches this browser at all.
   */
  mine: () => api.get<{ stations: PickableStation[] }>('/me/stations'),
  /**
   * Take a station: the session records it, and the audit rows and log lines
   * this till writes afterwards carry it. Refused when the station is not on
   * that account's list — a list that hides something is not a permission
   * check, so the refusal stands whether or not a picker ever showed it.
   */
  pick: (stationId: string) =>
    api.put<{
      station: ApiStation;
      /**
       * The shift token for this station, minted in the same transaction as
       * the pick (S2-06). Null when the deployment has no signing key, and
       * `staffTokenUnavailable` then says so in words the till can show.
       */
      staffToken: { token: string; jti: string; expiresAt: string } | null;
      staffTokenUnavailable: string | null;
    }>('/me/session/station', { stationId }),
  /**
   * One station whole, for the settings screen. The pick response carries no
   * staff list, so editing "who may use it" has to start from the record
   * rather than from what this till happens to be holding — otherwise saving
   * would write an empty list over the people already on it.
   */
  get: (id: string) => api.get<{ station: ApiStation }>(`/stations/${encodeURIComponent(id)}`),
  create: (branchId: string, body: StationInput) =>
    api.post<{ station: ApiStation }>(
      `/branches/${encodeURIComponent(branchId)}/stations`,
      body,
      { idempotencyKey: idemKey() },
    ),
  update: (id: string, body: Partial<StationInput>) =>
    api.patch<{ station: ApiStation }>(`/stations/${encodeURIComponent(id)}`, body),
  /** The boxes standing at a branch, whether or not a station uses them yet. */
  boxes: (branchId: string) =>
    api.get<{ boxes: ApiBox[] }>(`/branches/${encodeURIComponent(branchId)}/boxes`),
  /**
   * What one box can reach. Devices are asked for per box and never per branch,
   * because a printer is reachable through the box it is plugged into and
   * through no other.
   */
  boxDevices: (boxId: string) =>
    api.get<{ devices: ApiDevice[] }>(`/boxes/${encodeURIComponent(boxId)}/devices`),
  /** Who can be added to a station's list: the staff of that branch. */
  staffCandidates: (branchId: string) =>
    api.get<{ staff: StaffCandidate[] }>(`/branches/${encodeURIComponent(branchId)}/staff`),
  /**
   * A test print is a command to the box, not a message down a wire from this
   * iPad: the cloud queues it, the box collects it on its next poll and runs it
   * there. So it can be sent while the station is still being set up.
   */
  testPrint: (boxId: string, deviceId: string) =>
    api.post<{ commandId: string; actionId?: string | null }>(
      `/boxes/${encodeURIComponent(boxId)}/commands`,
      { kind: 'test_print', payload: { deviceId } },
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
