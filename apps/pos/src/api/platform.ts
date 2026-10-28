import type { ApiBody, ApiResponse } from '@oto/api-types';
import type { BookingEventPass, BookingEventPassInput, BookingSupervisionInput, PublicEventPassesAnswer, PublicSupervisionConfig } from '@oto/shared';
// Typed calls to the Sprint 1 API surface, with mapping between the API's
// satang integers and the prototype UI's whole-baht numbers done in mappers.ts.
import { newId as newRecordId } from '@oto/shared';

import type { UiPreferences } from '@oto/shared/ui-preferences';
import type { AddOn, StationCapability, TaxableCategory, TaxConfig } from '@/types';
import { api, idemKey } from './client';
import { bridgeApi } from './bridge';
import { viaLane } from '@/lib/lane';
import { tierNeedsProof } from '@/lib/membership';

/**
 * A record write on the box lane (offline plan Round 3): the bridge intent
 * with the till's own id, answered in the shape the platform route answers.
 */
async function onBox<R>(stationId: string, type: string, payload: Record<string, unknown>): Promise<R> {
  const answer = await bridgeApi.intent<R>(stationId, type, payload, { actionId: `${type}:${newRecordId()}` });
  return answer.result as R;
}

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
  /**
   * How every staff app looks for this person (SCRUM-653). Optional because an
   * api from before the column answers without it.
   */
  preferences?: UiPreferences;
  /**
   * SCRUM-648 — present when this session is a support administrator's
   * audited view-as window: the till shows a fixed banner naming both people
   * for as long as it lasts. Optional for an api from before it.
   */
  impersonation?: PosImpersonation | null;
}

/** SCRUM-648: who is really at this till, as whom, and until when. */
export interface PosImpersonation {
  id: string;
  actor: { accountId: string; name: string | null };
  subject: { accountId: string; name: string | null };
  targetApp: 'pos' | 'oto_app' | 'radar' | 'inbox';
  mode: 'read_only' | 'write_allowed';
  expiresAt: string;
}

/** SCRUM-653 — the caller's own theme and language, either alone. */
export const preferencesApi = {
  put: (body: ApiBody<'/me/preferences', 'put'>, idempotencyKey: string) =>
    api.put<ApiResponse<'/me/preferences', 'put'>>('/me/preferences', body, { idempotencyKey }),
};

export const authApi = {
  signIn: (phone: string, password: string) =>
    api.post<{ accountId: string; mustChangePassword: boolean }>('/auth/sign-in', { phone, password }),
  signOut: (stationLeaseId?: string) => api.post<{ ok: true }>('/auth/sign-out',
    stationLeaseId ? { stationLeaseId } : undefined),
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
    /** Document expiry (YYYY-MM-DD), when one was recorded. */
    expiresAt: string | null;
    /** The recorded expiry has passed: staff re-check the document. The rate holds. */
    reverifyDue?: boolean;
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

/**
 * The member, child and visit calls the till makes at the counter go through
 * the lane arbiter (`lib/lane.ts`, OD-1): the platform while it answers, the
 * box when the link is down or the station is forced offline. The ids are
 * minted here once, before either is asked, so a record begun on one lane and
 * finished on the other is the same record (OD-12).
 */
/**
 * Read the box's cached tier as the entitlement it is (offline finding 2).
 *
 * The box's cached member carries the tier it was pulled at (`tierCode`) but no
 * evidence rows — the bundle's doctrine leaves `tierVerification` null. The
 * till's tier gate reads `tierVerification`, so without this it forces a
 * re-verification the box cannot record and then prices that very tier
 * unconditionally. The platform moves `member.tier_code` only on a filed
 * verification, so the cached code IS a verified entitlement: synthesise one for
 * it (no document — that is the "full verification flow" the box does not run),
 * so choosing the member's own rate offline skips the dialog while a HIGHER
 * unverified tier still gates (`isTierVerified`). Online never reaches here.
 */
function withCachedTierEntitlement(m: ApiMember): ApiMember {
  if (m.tierVerification || !tierNeedsProof(m.tierCode)) return m;
  return {
    ...m,
    tierVerification: {
      tier: m.tierCode,
      proofType: 'On file',
      verifiedAt: new Date().toISOString(),
      verifiedBy: null,
      expiresAt: null,
    },
  };
}

const cloudMembersApi = {
lookup: (phone: string) =>
    api.get<{ member: ApiMember | null }>(`/members/lookup?phone=${encodeURIComponent(phone)}`),
get: (id: string) => api.get<{ member: ApiMember }>(`/members/${id}`),
create: (body: { phone: string; nickname: string; preferredChannel?: 'whatsapp' | 'telegram' | 'line' }, id: string = newRecordId()) => {
    return api.post<{ member: ApiMember }>('/members', { id, ...body }, { idempotencyKey: idemKey() });
  },
update: (id: string, patch: Record<string, unknown>) =>
    api.patch<{ member: ApiMember }>(`/members/${id}`, patch),
addChild: (memberId: string, body: Record<string, unknown>, id: string = newRecordId()) => {
    return api.post<{ child: ApiChild }>(
          `/members/${memberId}/children`,
          { id, ...body },
          { idempotencyKey: idemKey() },
        );
  },
updateChild: (childId: string, patch: Record<string, unknown>, idempotencyKey?: string, signal?: AbortSignal) =>
    api.patch<{ child: ApiChild }>(`/members/children/${childId}`, patch, { idempotencyKey, signal }),
verifyTier: (memberId: string, body: { toTier: string; evidenceType: string; evidenceExpiresAt?: string; note?: string }) =>
    api.post<{ member: ApiMember }>(`/members/${memberId}/tier-verification`, body, {
          idempotencyKey: idemKey(),
        }),
revokeTierVerification: (memberId: string, body: { reason: string }) =>
    api.delete<{ member: ApiMember }>(`/members/${memberId}/tier-verification`, body, {
          idempotencyKey: idemKey(),
        }),
};

export const membersApi = {
lookup: (phone: string) =>
    viaLane(
      () => cloudMembersApi.lookup(phone),
      async (stationId) => {
        const answer = (await bridgeApi.lookup(stationId, phone)) as unknown as {
          member: ApiMember | null;
        };
        return { member: answer.member ? withCachedTierEntitlement(answer.member) : null };
      },
    ),
get: (id: string) => cloudMembersApi.get(id),
create: (body: { phone: string; nickname: string; preferredChannel?: 'whatsapp' | 'telegram' | 'line' }) => {
    const id = newRecordId();
    return viaLane(
      () => cloudMembersApi.create(body, id),
      (stationId) => onBox<{ member: ApiMember }>(stationId, 'member.create', { memberId: id, ...body }),
    );
  },
update: (id: string, patch: Record<string, unknown>) =>
    viaLane(
      () => cloudMembersApi.update(id, patch),
      (stationId) => onBox<{ member: ApiMember }>(stationId, 'member.update', { memberId: id, ...patch }),
    ),
addChild: (memberId: string, body: Record<string, unknown>) => {
    const id = newRecordId();
    return viaLane(
      () =>
        cloudMembersApi.addChild(memberId, body, id),
      (stationId) => onBox<{ child: ApiChild }>(stationId, 'child.create', { childId: id, memberId, ...body }),
    );
  },
updateChild: (childId: string, patch: Record<string, unknown>, idempotencyKey?: string, signal?: AbortSignal) =>
    viaLane(
      () => cloudMembersApi.updateChild(childId, patch, idempotencyKey, signal),
      (stationId) => onBox<{ child: ApiChild }>(stationId, 'child.update', { childId, ...patch }),
    ),
verifyTier: (memberId: string, body: { toTier: string; evidenceType: string; evidenceExpiresAt?: string; note?: string }) =>
    viaLane(
      () =>
        cloudMembersApi.verifyTier(memberId, body),
      (stationId) =>
        onBox<{ member: ApiMember }>(stationId, 'member.tier_change', {
          direction: 'upgrade',
          memberId,
          verificationId: newRecordId(),
          ...body,
        }),
    ),
revokeTierVerification: (memberId: string, body: { reason: string }) =>
    viaLane(
      () =>
        cloudMembersApi.revokeTierVerification(memberId, body),
      (stationId) =>
        onBox<{ member: ApiMember }>(stationId, 'member.tier_change', {
          direction: 'downgrade',
          memberId,
          verificationId: newRecordId(),
          reason: body.reason,
        }),
    ),
};

export const visitsApi = {
  /** Client-minted id, for the reason given on membersApi.create; either lane. */
  create: (body: { memberId?: string | null; childIds: string[] }) => {
    const id = newRecordId();
    return viaLane(
      () =>
        api.post<{ id: string; visitDate: string; status: string }>(
          '/visits',
          { id, ...body },
          { idempotencyKey: idemKey() },
        ),
      (stationId) =>
        onBox<{ id: string; visitDate: string; status: string }>(stationId, 'visit.create', {
          visitId: id,
          memberId: body.memberId ?? null,
          childIds: body.childIds,
        }),
    );
  },
  /**
   * SCRUM-339 — add confirmed children to the visit this family already has
   * today, so the membership check and the supervision gate share ONE visit.
   * Answers with that visit's id.
   *
   * The box has no "add to a visit" step, so on the box lane the children get
   * a visit of their own (the earlier behaviour) and its id is returned; the
   * caller carries on with whichever id comes back.
   */
  addChildren: (visitId: string, body: { memberId: string; childIds: string[] }) =>
    viaLane(
      () =>
        api.post<ApiResponse<'/visits/{id}/children', 'post'>>(
          `/visits/${visitId}/children`,
          { childIds: body.childIds },
          { idempotencyKey: idemKey() },
        ),
      (stationId) =>
        onBox<{ id: string; visitDate: string; status: string }>(stationId, 'visit.create', {
          visitId: newRecordId(),
          memberId: body.memberId,
          childIds: body.childIds,
        }),
    ),
};

/**
 * SCRUM-339 — the one place a counter screen confirms children for a visit:
 * onto the family's open visit when the till already holds one for this
 * member, otherwise as a new visit. Returns the visit id the sale should carry.
 */
export async function confirmVisitChildren(
  openVisitId: string | null,
  body: { memberId: string; childIds: string[] },
): Promise<string> {
  if (openVisitId && body.childIds.length > 0) {
    return (await visitsApi.addChildren(openVisitId, body)).id;
  }
  if (openVisitId) return openVisitId;
  return (await visitsApi.create(body)).id;
}

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

/**
 * What a branch catalogue clone would do, or did, per entity (SCRUM-204).
 *
 * `blocked` carries a `name` rather than a `key` on purpose — the api's
 * idempotency store refuses to keep a response with a `key`-suffixed field in
 * it, so the name is what makes a retried clone replayable.
 */
export interface ApiCloneEntityPlan {
  create: string[];
  exists: string[];
  blocked: Array<{ name: string; reason: string }>;
}

export interface ApiCloneCounts {
  created: number;
  existing: number;
  blocked: number;
}

/** The entity keys the preview and the clone both answer with. */
export type ApiCloneEntity =
  | 'ticketPackages'
  | 'holidays'
  | 'taxConfig'
  | 'products'
  | 'modifierGroups'
  | 'modifierOptions'
  | 'modifierLinks'
  | 'discountCodes'
  | 'taxOverrides'
  | 'printTemplates'
  | 'stockLocations';

export interface ApiClonePreview {
  sourceBranch: { id: string; name: string };
  targetBranch: { id: string; name: string };
  /** True when the target has traded: the clone is refused. */
  targetHasSales: boolean;
  plan: Record<ApiCloneEntity, ApiCloneEntityPlan>;
  counts: Record<ApiCloneEntity, ApiCloneCounts>;
  /** Operator-wide rows a copied item points at rather than duplicates. */
  shared: string[];
}

export interface ApiCloneResult {
  sourceBranchId: string;
  targetBranchId: string;
  counts: Record<ApiCloneEntity, ApiCloneCounts>;
  plan: Record<ApiCloneEntity, ApiCloneEntityPlan>;
  created: number;
}
export const branchesApi = {
list: () => api.get<ApiResponse<'/branches/', 'get'>>('/branches'),
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
    api.get<ApiResponse<'/tiers', 'get'>>('/tiers'),
packages: (branchId: string) =>
    api.get<ApiResponse<'/branches/{branchId}/ticket-packages', 'get'>>(`/branches/${branchId}/ticket-packages`),
pricingMode: (branchId: string, date?: string) =>
    api.get<{ date: string; mode: 'weekday' | 'weekend'; reason: string; overrideName?: string }>(
      `/branches/${branchId}/pricing-mode${date ? `?date=${date}` : ''}`,
    ),
taxConfig: (branchId: string) => api.get<ApiResponse<'/branches/{branchId}/tax-config', 'get'>>(`/branches/${branchId}/tax-config`),
paymentMethods: () => api.get<ApiResponse<'/payment-methods', 'get'>>('/payment-methods'),

holidays: (branchId: string) =>
    api.get<ApiResponse<'/branches/{branchId}/holidays', 'get'>>(`/branches/${branchId}/holidays`),
};


export interface ApiPaymentMethod {
  /** The tender's code — the token stored on a sale, and the store's `id`. */
  id: string;
  label: string;
  kind: 'cash' | 'card' | 'qr' | 'other';
  enabled: boolean;
  sortOrder: number;
  attempts: number;
}

// --- public booking site (no session) ---------------------------------------
export interface PublicCatalog {
  supervision?: PublicSupervisionConfig;
  branch: { code: string; name: string; timezone: string; businessDayStart?: string };
  tiers: Array<{ id: string; name: string; isDefault: boolean; requiresVerification: boolean }>;
  packages: ApiTicketPackage[];
  rateMode: { date: string; mode: 'weekday' | 'weekend'; reason: string; overrideName?: string };
  holidays: Array<{ name: string; startsOn: string; endsOn: string }>;
  /**
   * S2-12 — the extras on sale online and the branch's tax configuration, so
   * the total this site shows is built from the numbers the platform prices the
   * booking with. Optional: an API that predates them leaves the site's own.
   */
  addOns?: PublicAddOn[];
  taxConfig?: TaxConfig | null;
}

/** One extra on sale online, as the platform prices it. Money in satang. */
export interface PublicAddOn {
  /** What a booking line sends back: a seeded extra's prototype id (`a-socks`), or the product's id. */
  id: string;
  name: string;
  priceSatang: number;
  /** Null when the weekend price is the weekday price. */
  priceWeekendSatang: number | null;
  taxCategory: TaxableCategory | null;
  translations: AddOn['translations'] | null;
}

/** A saved child, as the open route answers it once the phone's code is typed back. */
export interface PublicSavedChild {
  id: string;
  name: string;
  dateOfBirth: string | null;
  ageYears: number | null;
  allergies: string | null;
  foodRestrictions: string | null;
}

export const publicApi = {
  catalog: (branchCode: string) => api.get<PublicCatalog>(`/public/branches/${branchCode}/catalog`),
  /** SCRUM-507 — the parks the booking site offers: those of the operator running `branchCode`. */
  parks: (branchCode: string) =>
    api.get<{ branches: Array<{ code: string; name: string }> }>(
      `/public/branches/${encodeURIComponent(branchCode)}/parks`,
    ),
  /**
   * SCRUM-357 — send a six-digit code to the phone, so a returning family can
   * see its saved children. The answer is the same whether or not the phone is
   * a member's.
   */
  savedChildrenCode: (phone: string, branchCode: string) =>
    api.post<{ ok: true }>('/public/saved-children/code', { phone, branch: branchCode }),
  /** The code typed back: right, it is spent and the family's saved children come back. */
  savedChildrenVerify: (phone: string, branchCode: string, code: string) =>
    api.post<{ children: PublicSavedChild[] }>('/public/saved-children/verify', {
      phone,
      branch: branchCode,
      code,
    }),
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
  /**
   * S2-12 — the booking is written PENDING; it is paid only when the payment
   * gateway confirms the money to the platform, never by anything this page
   * does. `displayedTotalSatang` is what the page showed: the platform refuses
   * (`BOOKING_TOTAL_CHANGED`) rather than charge a different figure.
   */
  createBooking: (body: {
    id?: string;
    branchCode: string;
    phone?: string;
    parentName: string;
    tier: string;
    visitDate?: string;
    consentAck?: boolean;
    acknowledgedConfirmationIds?: string[];
    lines: Array<{
      supervision?: BookingSupervisionInput;
      packageId: string;
      kids: number;
      adults: number;
      socks?: number;
      addOns?: Array<{ id: string; quantity: number }>;
    }>;
    /**
     * S2-20 E5 — event passes (consistency #21): priced by the platform at the
     * visit date's rate, and registered with the OTO App once the booking is
     * paid, under the attendee id this page minted when the pass was added.
     */
    eventPasses?: BookingEventPassInput[];
    contactChannel?: 'whatsapp' | 'telegram' | 'line';
    locale?: string;
    clientSnapshot?: unknown;
    displayedTotalSatang?: number;
  }) =>
    api.post<{
      id: string;
      reference: string;
      visitDate: string;
      rateMode: 'weekday' | 'weekend';
      totalSatang: number;
      lines: unknown[];
      eventPasses?: BookingEventPass[];
      status: string;
      expiresAt: string | null;
    }>('/public/bookings', body, { idempotencyKey: idemKey() }),
  /**
   * S2-20 E5 — the event passes on sale online for a visit date: camps running
   * that day and one-off events that day or later, at their flat price. An
   * empty list on a deployment without the OTO App's events.
   */
  eventPasses: (branchCode: string, date: string) =>
    api.get<PublicEventPassesAnswer>(
      `/public/branches/${encodeURIComponent(branchCode)}/event-passes?date=${encodeURIComponent(date)}`,
    ),
  /**
   * The booking's one payment: the page to send the browser to. A
   * `redirectUrl` starting with `/` is the platform's own (the simulator's pay /
   * fail page) and is reached through `/api` — see `paymentPageHref`.
   */
  checkoutBooking: (bookingId: string, method: 'card' | 'promptpay', locale?: string) =>
    api.post<{
      bookingId: string;
      attemptId: string;
      redirectUrl: string;
      expiresAt: string;
      provider: '2c2p' | 'simulator';
    }>(`/public/bookings/${encodeURIComponent(bookingId)}/checkout`, { method, locale }),
  /** What the waiting page polls: the booking's state, and its signed QR once paid. */
  bookingStatus: (bookingId: string) =>
    api.get<PublicBookingStatus>(`/public/bookings/${encodeURIComponent(bookingId)}/status`),
};

export interface PublicBookingStatus {
  id: string;
  reference: string;
  /** `pending` until the gateway confirms; `paid`; `redeemed`; `expired`; `cancelled`. */
  status: string;
  visitDate: string;
  totalSatang: number;
  rateMode: 'weekday' | 'weekend';
  kidsCount: number;
  adultsCount: number;
  paidAt: string | null;
  expiresAt: string | null;
  /** The QR the park signed — present only once the booking is paid. */
  qr: string | null;
}

/**
 * Where the browser goes for the payment page. The payment partner's page is
 * an absolute address; the simulator's is the platform's own path, which this
 * site reaches through the same `/api` prefix every call here uses.
 */
export function paymentPageHref(redirectUrl: string): string {
  return redirectUrl.startsWith('/') ? `/api${redirectUrl}` : redirectUrl;
}

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


export type ApiStationPrinter = ApiResponse<'/stations/{id}/printers', 'get'>['printers'][number];
export const printApi = {
stationPrinters: (stationId: string) =>
    api.get<ApiResponse<'/stations/{id}/printers', 'get'>>(
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
   * there.
   *
   * SCRUM-381 — through the station's print-jobs route, as the Console's Box
   * drawer does (SCRUM-364), and not as a bare `test_print` command: that
   * route writes the `edge.print_job` row first and hands the box its id, so
   * the outcome the box reports lands on a row and shows in the Printing panel
   * like any other print. The bare command wrote no row, and the box's report
   * was refused. The box routes by the job a printer does at a station, so the
   * station and the role are the whole address. Each press its own key: two
   * presses are two pieces of paper.
   */
  testPrint: (stationId: string, role: StationDeviceRole) =>
    api.post<ApiResponse<'/stations/{id}/test-print', 'post'>>(
      `/stations/${encodeURIComponent(stationId)}/test-print`,
      { kind: 'test_page', role },
      { idempotencyKey: idemKey() },
    ),
};

export const opsApi = {
demoResetStatus: () =>
    api.get<ApiResponse<'/ops/demo-reset', 'get'>>('/ops/demo-reset'),
};
