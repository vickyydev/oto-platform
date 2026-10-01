import {
  newId as newRecordId,
  satangFromBaht,
  type DropOffPricingConfig,
  type SupervisionPolicy,
  type SupervisionRequirement,
} from '@oto/shared';
import type { CheckIn, ChildFoodProvision, ContactChannel, DropOffServiceType } from '@/types';
import { api, idemKey } from './client';
import { apiBranchIdForSlug } from './catalogBridge';

/**
 * S2-13 round 1 — the supervision gate's calls (plan
 * docs/progress/plans/checkin/PLAN.md §2.2), ONLINE ONLY.
 *
 * Where the prototype's till called its in-memory mutators —
 * `registerWalkInChildren`, `recordSupervisionWaiver`,
 * `checkInFamilyWithPayment` + `linkCheckInSaleId` + `braceletPrintJobs`,
 * `markCheckInsBooked` — it calls these. The box answers for them in round 4;
 * until then a till with no link gets the platform's refusal, never a record
 * that exists only in this browser.
 */

/**
 * THE PARK, IN THE PLATFORM'S ID (round-1 fix, finding R1).
 *
 * The till's `useBranch().branch.id` is the CATALOGUE SLUG (`hkt-central`);
 * every `/checkin` route names the platform's branch row by its uuid, exactly
 * as the cart identity does through `apiBranchIdForSlug`. The first build
 * sent the slug, so every supervised walk-in was refused at Continue, the
 * roster was always empty and the waiting-bookings picker always errored.
 *
 * So the slug is mapped here, in one place, and a till with no platform
 * branch — a device still on the prototype's own setup — is refused in the
 * counter's words before anything is sent. `config` and `awaiting` refuse a
 * value that is not a uuid for the same reason: a slug can never again leave
 * this till as a branch id.
 */
export const TILL_NOT_LINKED =
  "This till isn't linked to a park on the platform, so nobody can be registered or checked in from it. Sign out and back in, or ask an administrator.";

const PLATFORM_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The platform's branch id for the park on screen, or the plain refusal. */
export function requirePlatformBranchId(branchSlug: string): string {
  const id = apiBranchIdForSlug(branchSlug);
  if (!id) throw new Error(TILL_NOT_LINKED);
  return id;
}

function assertPlatformBranchId(branchId: string): string {
  if (!PLATFORM_ID.test(branchId)) throw new Error(TILL_NOT_LINKED);
  return branchId;
}

export interface ApiNanny {
  id: string;
  name: string;
  onShift: boolean;
  load: number;
  coveredNames: string[];
}

export interface ApiSupervisionConfig {
  policy: SupervisionPolicy;
  pricing: DropOffPricingConfig;
  photoRetentionDays: number;
  nannies: ApiNanny[];
}

export interface ApiFoodProvision {
  mode: 'none' | 'prepaid_credit' | 'prepaid_items';
  paidSatang: number;
  creditSatang?: number;
  items?: { menuItemId: string; menuItemName: string; unitSatang: number; qty: number; redeemedQty: number }[];
}

export interface ApiCheckin {
  id: string;
  registrationId: string;
  childId: string | null;
  childName: string;
  childAgeYears: number;
  dateOfBirth: string | null;
  allergies: string | null;
  foodRestrictions: string | null;
  mayOrderFood: boolean;
  foodProvision: ApiFoodProvision | null;
  service: SupervisionRequirement;
  status: 'registered' | 'in_park' | 'out';
  scheduledFor: string | null;
  bookedMinutes: number | null;
  nannyId: string | null;
  checkedInAt: string | null;
  saleId: string | null;
  bandId: string | null;
  visitId: string | null;
  photoFileId: string | null;
}

export interface ApiRegistration {
  id: string;
  branchId: string;
  memberId: string | null;
  guardianName: string;
  guardianPhone: string | null;
  contactChannel: string;
  consentRecordedAt: string | null;
  acknowledgedConfirmations: { itemId: string; text: string; acknowledgedAt: string }[];
  source: string;
  photoFileId: string | null;
  createdAt: string;
  children: ApiCheckin[];
}

export interface RegistrationChildBody {
  checkinId: string;
  childId?: string | null;
  name: string;
  ageYears: number;
  dateOfBirth?: string | null;
  service: SupervisionRequirement;
  allergies?: string | null;
  foodRestrictions?: string | null;
  foodProvision?: ApiFoodProvision | null;
}

export interface CreateRegistrationBody {
  id: string;
  branchId: string;
  stationId?: string | null;
  memberId?: string | null;
  visitId?: string | null;
  guardianName: string;
  guardianPhone?: string | null;
  contactChannel: 'whatsapp' | 'telegram' | 'line';
  consentAcknowledged: boolean;
  acknowledgedConfirmationIds: string[];
  children: RegistrationChildBody[];
}

/** The prototype's provision (baht) on the wire (satang). */
export function foodProvisionToWire(fp: ChildFoodProvision | undefined | null): ApiFoodProvision | null {
  if (!fp) return null;
  return {
    mode: fp.mode,
    paidSatang: satangFromBaht(fp.paidTHB ?? 0),
    ...(fp.creditAmountTHB !== undefined ? { creditSatang: satangFromBaht(fp.creditAmountTHB) } : {}),
    ...(fp.items
      ? {
          items: fp.items.map((i) => ({
            menuItemId: i.menuItemId,
            menuItemName: i.menuItemName,
            unitSatang: satangFromBaht(i.unitPriceTHB),
            qty: i.qty,
            redeemedQty: i.redeemedQty ?? 0,
          })),
        }
      : {}),
  };
}

/** The platform's provision (satang) as the prototype's screens read it (baht). */
export function foodProvisionFromWire(fp: ApiFoodProvision | null | undefined): ChildFoodProvision | undefined {
  if (!fp) return undefined;
  return {
    mode: fp.mode,
    paidTHB: fp.paidSatang / 100,
    ...(fp.creditSatang !== undefined ? { creditAmountTHB: fp.creditSatang / 100 } : {}),
    ...(fp.items
      ? {
          items: fp.items.map((i) => ({
            menuItemId: i.menuItemId,
            menuItemName: i.menuItemName,
            unitPriceTHB: i.unitSatang / 100,
            qty: i.qty,
            redeemedQty: i.redeemedQty,
          })),
        }
      : {}),
  };
}

/**
 * A platform stay in the prototype's `CheckIn` shape, which the till's
 * drop-off line builder (`makeDropOffLine`) and its pickers read. The id is
 * the platform's: the drop-off cart line takes it as its own id, which is how
 * the sale line comes to carry `cart_line_id = checkin.id`.
 */
export function apiCheckinToCheckIn(c: ApiCheckin, reg: Pick<ApiRegistration, 'guardianName' | 'guardianPhone' | 'contactChannel' | 'createdAt' | 'branchId'>, extra: { childPhotoUrl?: string } = {}): CheckIn {
  return {
    id: c.id,
    branchId: reg.branchId,
    registrationId: c.registrationId,
    childName: c.childName,
    childAge: c.childAgeYears,
    ...(c.dateOfBirth ? { dateOfBirth: c.dateOfBirth } : {}),
    ...(extra.childPhotoUrl ? { childPhotoUrl: extra.childPhotoUrl } : {}),
    parentName: reg.guardianName,
    contactMethod: (reg.contactChannel as ContactChannel) ?? 'whatsapp',
    phone: reg.guardianPhone ?? '',
    ...(c.allergies ? { allergiesMedical: c.allergies } : {}),
    mayOrderFood: c.mayOrderFood,
    ...(c.foodRestrictions ? { foodRestrictions: c.foodRestrictions } : {}),
    ...(c.foodProvision ? { foodProvision: foodProvisionFromWire(c.foodProvision) } : {}),
    confirmationsAccepted: true,
    serviceType: c.service,
    status: c.status,
    ...(c.scheduledFor ? { scheduledFor: c.scheduledFor } : {}),
    registeredAt: reg.createdAt,
  } as CheckIn;
}

/** A data URL as the bytes and type an upload sends. */
function blobOfDataUrl(dataUrl: string): Blob {
  const [head, body = ''] = dataUrl.split(',');
  const type = /data:([^;]+)/.exec(head ?? '')?.[1] ?? 'image/jpeg';
  const bytes = atob(body);
  const out = new Uint8Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) out[i] = bytes.charCodeAt(i);
  return new Blob([out], { type });
}

export const checkinApi = {
  /** A fresh client-minted id (OD-12) for a registration, a stay or a waiver. */
  newId: (): string => newRecordId(),

  /** The park's policy, pricing and nanny roster. `branchId` is the PLATFORM's id (`requirePlatformBranchId`). */
  config: async (branchId: string) =>
    api.get<ApiSupervisionConfig>(
      `/checkin/config?branchId=${encodeURIComponent(assertPlatformBranchId(branchId))}`,
    ),

  /** Registrations waiting to be checked in. `branchId` is the PLATFORM's id (`requirePlatformBranchId`). */
  awaiting: async (branchId: string) =>
    api.get<{ registrations: ApiRegistration[] }>(
      `/checkin/registrations?branchId=${encodeURIComponent(assertPlatformBranchId(branchId))}`,
    ),

  /** The same id again answers with the registration that exists — consent and payment never make two. */
  createRegistration: (body: CreateRegistrationBody) =>
    api.post<ApiRegistration>('/checkin/registrations', body, { idempotencyKey: idemKey() }),

  addChildren: (registrationId: string, children: RegistrationChildBody[]) =>
    api.post<ApiRegistration>(`/checkin/registrations/${registrationId}/children`, { children }, { idempotencyKey: idemKey() }),

  recordWaiver: (body: {
    id: string;
    branchId: string;
    stationId?: string | null;
    registrationId?: string | null;
    child: { name: string; ageYears: number; childId?: string | null };
    sibling: { name: string; ageYears: number; childId?: string | null };
    waivedRequirement: 'drop_off' | 'nanny';
  }) => api.post<{ id: string; siblingName: string }>('/checkin/waivers', body, { idempotencyKey: idemKey() }),

  /**
   * The combined child-and-guardian photo (OD-C2): registered under the
   * registration, PUT straight to storage on the presigned URL, then attached.
   */
  uploadPhoto: async (registrationId: string, dataUrl: string, checkinIds: string[]): Promise<ApiRegistration> => {
    const blob = blobOfDataUrl(dataUrl);
    const file = await api.post<{ id: string; uploadUrl: string }>(
      '/files',
      {
        id: newRecordId(),
        contentType: blob.type,
        ownerEntityType: 'registration',
        ownerEntityId: registrationId,
        filename: `consent.${blob.type.split('/')[1] ?? 'jpg'}`,
      },
      { idempotencyKey: idemKey() },
    );
    const put = await fetch(file.uploadUrl, { method: 'PUT', body: blob, headers: { 'content-type': blob.type } });
    if (!put.ok) throw new Error(`The photo did not upload (${put.status})`);
    return api.post<ApiRegistration>(
      `/checkin/registrations/${registrationId}/photo`,
      { fileId: file.id, checkinIds },
      { idempotencyKey: idemKey() },
    );
  },

  checkInNow: (body: { saleId: string; entries: { checkinId: string; nannyId?: string | null }[] }) =>
    api.post<{
      saleId: string;
      children: ApiCheckin[];
      bands: { id: string; checkinId: string; childName: string }[];
      printJobs: { id: string; kind: string; status: string }[];
      notes: string[];
    }>('/checkin/check-in-now', body, { idempotencyKey: idemKey() }),

  leaveAsBooked: (body: { saleId: string; scheduledFor?: string; entries: { checkinId: string }[] }) =>
    api.post<{ saleId: string; children: ApiCheckin[] }>('/checkin/leave-as-booked', body, { idempotencyKey: idemKey() }),
};

// ================================================================================
// S2-13 round 2 — THE BOARD (plan §2.3). The DropOff page, its cards, the
// overstay banner and the admin panels call these where the prototype called
// `getCheckIns`, `getNannyRoster`, `updateCheckIn`, `assignNanny`,
// `checkInFamilyBooked`, the WhatsApp connection-check mutators and the
// catalogue store's supervision setters.
// ================================================================================

export type ApiBoardTab = 'registered' | 'in_park' | 'out';

export interface ApiContact {
  status: 'pending' | 'confirmed' | 'failed';
  sentAt: string | null;
  confirmedAt: string | null;
}

export interface ApiBoardChild extends ApiCheckin {
  nannyName: string | null;
  checkedOutAt: string | null;
}

export interface ApiBoardFamily {
  registrationId: string;
  branchId: string;
  memberId: string | null;
  guardianName: string;
  guardianPhone: string | null;
  contactChannel: string;
  consentRecordedAt: string | null;
  source: string;
  photoFileId: string | null;
  createdAt: string;
  contact: ApiContact | null;
  tab: ApiBoardTab;
  children: ApiBoardChild[];
}

export interface ApiBoard {
  families: ApiBoardFamily[];
  counts: Record<ApiBoardTab, number>;
  unconfirmedFamilies: number;
  nannies: ApiNanny[];
  nannyRatioSoftMax: number;
  prepaidFoodUnused: 'refund' | 'forfeit';
}

/** The editable fields of a stay (the prototype's `CheckInEdits`, mockApi.ts:5358). */
export interface CheckInEdits {
  childName: string;
  childAge: number;
  parentName: string;
  contactMethod: ContactChannel;
  phone: string;
  serviceType: DropOffServiceType;
  mayOrderFood: boolean;
  foodRestrictions?: string;
  allergiesMedical?: string;
  bookedDurationMinutes?: number;
  assignedNannyId?: string;
}

/** One change-log entry, read back from the audit rows (OD-C5). */
export interface ApiChangeLogEntry {
  id: string;
  field: string;
  oldValue: string;
  newValue: string;
  changedBy: string;
  changedById: string | null;
  changedAt: string;
}

/** A nanny as the pickers render her (the prototype's `NannyAvailability`). */
export interface NannyChoice {
  id: string;
  name: string;
  onShift: boolean;
  /** Children she covers OTHER than the one being edited. */
  load: number;
  coveredNames: string[];
  /** On shift = pickable; the server checks it again. */
  available: boolean;
}

function removeOne(names: readonly string[], name: string): string[] {
  const i = names.indexOf(name);
  return i < 0 ? [...names] : [...names.slice(0, i), ...names.slice(i + 1)];
}

/**
 * The roster for one child's picker (prototype `getNannyRoster(forCheckInId)`):
 * the child being edited is not counted against her own nanny.
 */
export function nannyChoicesFor(
  nannies: readonly ApiNanny[],
  forCheckIn?: Pick<CheckIn, 'childName' | 'assignedNannyId' | 'status'> | null,
): NannyChoice[] {
  return nannies.map((n) => {
    const own = !!forCheckIn && forCheckIn.assignedNannyId === n.id && forCheckIn.status !== 'out';
    return {
      id: n.id,
      name: n.name,
      onShift: n.onShift,
      load: own ? Math.max(0, n.load - 1) : n.load,
      coveredNames: own ? removeOne(n.coveredNames, forCheckIn.childName) : [...n.coveredNames],
      available: n.onShift,
    };
  });
}

// --- Photos: a presigned read per file, once per page --------------------------------

const photoUrls = new Map<string, Promise<string | null>>();

/**
 * The consent photo's short-lived URL. Every read is access-logged on the
 * platform (R-94), so each file is asked for once per page and remembered,
 * rather than on every ten-second redraw of the board.
 */
export function photoUrlOf(fileId: string): Promise<string | null> {
  let found = photoUrls.get(fileId);
  if (!found) {
    found = api
      .get<{ url: string }>(`/files/${fileId}/url`)
      .then((r) => r.url)
      .catch(() => {
        photoUrls.delete(fileId);
        return null;
      });
    photoUrls.set(fileId, found);
  }
  return found;
}

/**
 * A board row in the prototype's `CheckIn` shape, which the cards, the modals
 * and round 3's CheckOutModal render unchanged. The connection status is the
 * registration's (one channel per guardian, every sibling the same, as the
 * prototype stamped it).
 */
export function boardChildToCheckIn(c: ApiBoardChild, fam: ApiBoardFamily, photoUrl?: string | null): CheckIn {
  const base = apiCheckinToCheckIn(c, fam, photoUrl ? { childPhotoUrl: photoUrl } : {});
  return {
    ...base,
    confirmationsAccepted: !!fam.consentRecordedAt,
    ...(c.photoFileId || fam.photoFileId ? { photoOnFile: true } : {}),
    ...(c.nannyId ? { assignedNannyId: c.nannyId, ...(c.nannyName ? { assignedNannyName: c.nannyName } : {}) } : {}),
    ...(c.checkedInAt ? { checkedInAt: c.checkedInAt } : {}),
    ...(c.checkedOutAt ? { checkedOutAt: c.checkedOutAt } : {}),
    ...(c.bookedMinutes != null ? { bookedDurationMinutes: c.bookedMinutes } : {}),
    ...(fam.contact
      ? {
          waConnection: {
            status: fam.contact.status,
            ...(fam.contact.sentAt ? { sentAt: fam.contact.sentAt } : {}),
            ...(fam.contact.confirmedAt ? { confirmedAt: fam.contact.confirmedAt } : {}),
          },
        }
      : {}),
  };
}

/** The edit modal's form as the PATCH body: only what differs from the stay as shown. */
export function editsToPatch(before: CheckIn, edits: CheckInEdits): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (edits.childName !== before.childName) body.childName = edits.childName;
  if (edits.childAge !== before.childAge) body.childAgeYears = edits.childAge;
  if (edits.parentName !== before.parentName) body.guardianName = edits.parentName;
  if (edits.contactMethod !== before.contactMethod) body.contactChannel = edits.contactMethod;
  if (edits.phone !== before.phone) body.guardianPhone = edits.phone || null;
  if (edits.serviceType !== before.serviceType) body.service = edits.serviceType;
  if (edits.mayOrderFood !== before.mayOrderFood) body.mayOrderFood = edits.mayOrderFood;
  if ((edits.foodRestrictions ?? '') !== (before.foodRestrictions ?? '')) body.foodRestrictions = edits.foodRestrictions || null;
  if ((edits.allergiesMedical ?? '') !== (before.allergiesMedical ?? '')) body.allergies = edits.allergiesMedical || null;
  const minutes = edits.bookedDurationMinutes && edits.bookedDurationMinutes > 0 ? edits.bookedDurationMinutes : null;
  if (minutes !== (before.bookedDurationMinutes ?? null)) body.bookedMinutes = minutes;
  if ((edits.assignedNannyId ?? null) !== (before.assignedNannyId ?? null)) body.nannyId = edits.assignedNannyId ?? null;
  return body;
}

export interface PolicyBody {
  bands: { id: string; label: string; minAge: number; maxAge: number | null; requirement: SupervisionRequirement }[];
  siblingWaiver: { enabled: boolean; guardianMinAge: number; waivableRequirement: SupervisionRequirement; staffOnly: boolean };
}

export interface PricingBody {
  oneTimeFee: { weekday: number; weekend: number };
  nannyHourly: { weekday: number; weekend: number };
  extraHour: { weekday: number; weekend: number };
  fullDayHours: number;
  nannyRatioSoftMax: number;
  prepaidFoodUnused: 'refund' | 'forfeit';
}

export const boardApi = {
  /** The park's board. `branchId` is the PLATFORM's id (`requirePlatformBranchId`). */
  board: (branchId: string) =>
    api.get<ApiBoard>(`/checkin/board?branchId=${encodeURIComponent(assertPlatformBranchId(branchId))}`),

  /** The Today screen's drop-off count. */
  today: (branchId: string) =>
    api.get<{ inPark: number; upcoming: number }>(
      `/checkin/today?branchId=${encodeURIComponent(assertPlatformBranchId(branchId))}`,
    ),

  /** One audited edit; the answer carries how many fields changed and any ratio warning. */
  edit: (checkinId: string, body: Record<string, unknown>) =>
    api.patch<{ checkin: ApiBoardChild; changed: number; warnings: string[]; contact: ApiContact | null }>(
      `/checkin/checkins/${checkinId}`,
      body,
      { idempotencyKey: idemKey() },
    ),

  history: (checkinId: string) => api.get<{ entries: ApiChangeLogEntry[] }>(`/checkin/checkins/${checkinId}/history`),

  assignNanny: (checkinId: string, nannyId: string) =>
    api.post<{ checkin: ApiBoardChild; warnings: string[] }>(
      `/checkin/checkins/${checkinId}/nanny`,
      { nannyId },
      { idempotencyKey: idemKey() },
    ),

  /** Booked, already-paid children: no payment, no sale — bands on the sale they paid on. */
  checkInBooked: (body: { entries: { checkinId: string; nannyId?: string | null }[]; consentAcknowledged?: boolean }) =>
    api.post<{
      saleIds: string[];
      children: ApiCheckin[];
      bands: { id: string; checkinId: string; childName: string }[];
      printJobs: { id: string; kind: string; status: string }[];
      notes: string[];
    }>('/checkin/check-in-booked', body, { idempotencyKey: idemKey() }),

  contactTest: (registrationId: string) =>
    api.post<ApiContact>(`/checkin/registrations/${registrationId}/contact-test`, {}, { idempotencyKey: idemKey() }),

  contactStatus: (registrationId: string, status: 'confirmed' | 'failed') =>
    api.post<ApiContact>(
      `/checkin/registrations/${registrationId}/contact-status`,
      { status },
      { idempotencyKey: idemKey() },
    ),

  savePolicy: (branchId: string, body: PolicyBody) =>
    api.put<ApiSupervisionConfig>(
      `/checkin/config/policy?branchId=${encodeURIComponent(assertPlatformBranchId(branchId))}`,
      body,
    ),

  saveConfirmations: (branchId: string, items: { id: string; text: string; required: boolean; order: number }[]) =>
    api.put<ApiSupervisionConfig>(
      `/checkin/config/confirmations?branchId=${encodeURIComponent(assertPlatformBranchId(branchId))}`,
      { items },
    ),

  savePricing: (branchId: string, body: PricingBody) =>
    api.put<ApiSupervisionConfig>(
      `/checkin/config/pricing?branchId=${encodeURIComponent(assertPlatformBranchId(branchId))}`,
      body,
    ),
};
