import {
  newId as newRecordId,
  satangFromBaht,
  type DropOffPricingConfig,
  type SupervisionPolicy,
  type SupervisionRequirement,
} from '@oto/shared';
import type { CheckIn, ChildFoodProvision, ContactChannel } from '@/types';
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
