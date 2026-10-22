import type { ApiResponse } from '@oto/api-types';
import type { AdminApi } from '../../api/admin-api';
import type { LiftedAdminApi } from '../../api/lifted-api';
import type { AddOn, TaxableCategory } from '../model/types';
import { newId as newRecordId } from '@oto/shared';
import { idemKey } from './client';



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


// --- branches / catalog -----------------------------------------------------
export interface ApiBranch {
  id: string;
  name: string;
  code: string;
  timezone: string;
  /** When the trading day starts, "05:00:00" (SCRUM-308). Absent on an older api. */
  businessDayStart?: string;
  country: string | null;
  address?: string | null;
  openingHours?: unknown;
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


export interface ApiPaymentMethod {
  /** The tender's code — the token stored on a sale, and the store's `id`. */
  id: string;
  label: string;
  kind: 'cash' | 'card' | 'qr' | 'other';
  enabled: boolean;
  sortOrder: number;
  attempts: number;
}


/**
 * Printing (S2-06).
 *
 * The till and the admin console both read templates, so this sits beside the
 * catalogue rather than under `adminApi`. Editing one is an admin act and the
 * API says so; reading one is not.
 */
export type ApiPrintTemplate = ApiResponse<'/branches/{branchId}/print-templates', 'get'>['templates'][number];


export type ApiPrintJob = ApiResponse<'/print-templates/{id}/test-print', 'post'>['printJob'];


export type ApiStationPrinter = ApiResponse<'/stations/{id}/printers', 'get'>['printers'][number];


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
export interface TestPrintTarget {
  printer: { deviceId: string; label: string } | null;
  /** Why nothing would print, in words for the editor; null when a printer is there. */
  note: string | null;
  widthDots: number;
}


export function createOrganisationAdminApi(api: AdminApi) {
const branchesApi = {
  list: () => api.get<ApiResponse<'/branches/', 'get'>>('/branches'),
  create: (body: { name: string; code: string; timezone?: string; country?: string }) =>
    api.post<ApiResponse<'/branches/', 'post'>>('/branches', body, { idempotencyKey: idemKey() }),
  update: (id: string, patch: Record<string, unknown>) => api.patch<ApiResponse<'/branches/{id}', 'patch'>>(`/branches/${id}`, patch, { idempotencyKey: idemKey() }),
  /** What copying `sourceBranchId` into `branchId` would create. Reads only. */
  clonePreview: (branchId: string, sourceBranchId: string) =>
    api.get<ApiClonePreview>(
      `/branches/${branchId}/clone-preview?from=${encodeURIComponent(sourceBranchId)}`,
    ),
  /**
   * Copy it, once, in one transaction. Carries a key for the same reason every
   * write does: a retry through a dropped connection must not run the copy a
   * second time while the first one is still committing.
   */
  clone: (branchId: string, sourceBranchId: string) =>
    api.post<ApiCloneResult>(
      `/branches/${branchId}/clone`,
      { sourceBranchId },
      { idempotencyKey: idemKey() },
    ),
};

const adminApi = {
  operators: () => api.get<ApiResponse<'/operators/', 'get'>>('/operators'),
  createOperator: (name: string) =>
    api.post<ApiResponse<'/operators/', 'post'>>('/operators', { name }, { idempotencyKey: idemKey() }),
  renameOperator: (id: string, name: string) => api.patch<ApiResponse<'/operators/{id}', 'patch'>>('/operators/' + id, { name }, { idempotencyKey: idemKey() }),
  archiveOperator: (id: string, confirmName: string) => api.patch<ApiResponse<'/operators/{id}', 'patch'>>(`/operators/${id}`, { archived: true, confirmName }, { idempotencyKey: idemKey() }),
  assignOperatorAdmin: (id: string, body: { phone: string; name: string }) =>
    /** `warning` is an object — see `createAccount` above for what typing it
     *  as a string cost. */
    api.post<ApiResponse<'/operators/{id}/administrators', 'post'>>(`/operators/${id}/administrators`, body, { idempotencyKey: idemKey() }),
};

const opsApi = {
  /**
   * Answers rather than refuses, so a console that is not entitled to the
   * control simply never renders it. `available` is false both for a caller
   * who is not a platform admin and on a deployment that did not opt in.
   */
  demoResetStatus: () =>
    api.get<{ available: boolean; confirmationPhrase: string; playground?: boolean }>('/ops/demo-reset'),
  demoReset: (confirm: string) =>
    api.post<{ deleted: Record<string, number> }>(
      '/ops/demo-reset',
      { confirm },
      { idempotencyKey: idemKey() },
    ),
};

const holidaysApi = {

  /**
   * `pricedSales` is how many sales each range priced. Nonzero means the
   * platform has frozen its dates (SCRUM-309), so the panel can say why rather
   * than let a manager find out by being refused.
   */
  holidays: (branchId: string) =>
    api.get<ApiResponse<'/branches/{branchId}/holidays', 'get'>>(`/branches/${branchId}/holidays`),
  createHoliday: (branchId: string, body: { name: string; startsOn: string; endsOn: string }) =>
    api.post<ApiResponse<'/branches/{branchId}/holidays', 'post'>>(`/branches/${branchId}/holidays`, body, { idempotencyKey: idemKey() }),
  /** The name always; the dates only while nothing has been priced by the range. */
  updateHoliday: (
    branchId: string,
    id: string,
    body: { name?: string; startsOn?: string; endsOn?: string },
  ) => api.patch<ApiResponse<'/branches/{branchId}/holidays/{id}', 'patch'>>(`/branches/${branchId}/holidays/${id}`, body, { idempotencyKey: idemKey() }),
  deleteHoliday: (branchId: string, id: string) =>
    api.delete<ApiResponse<'/branches/{branchId}/holidays/{id}', 'delete'>>(`/branches/${branchId}/holidays/${id}`, { idempotencyKey: idemKey() })
};
return { branchesApi, adminApi, opsApi, holidaysApi };
}

export function createPlatformAdminApi(api: LiftedAdminApi) {
const { branchesApi, adminApi, opsApi, holidaysApi } = createOrganisationAdminApi(api);





const catalogApi = {
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
  ...holidaysApi,
  taxConfig: (branchId: string) => api.get<{ config: unknown | null }>(`/branches/${branchId}/tax-config`),
  putTaxConfig: (branchId: string, config: unknown) =>
    api.put<{ ok: true }>(`/branches/${branchId}/tax-config`, config),

  /**
   * The tenders the park takes money in (SCRUM-206).
   *
   * Operator-wide, so there is no branch id on any of these — the prototype's
   * store says "paymentMethods (same physical tenders everywhere)"
   * (`catalogStore.ts:71`) and the routes match it. `id` in the answer is the
   * tender's CODE, which is the token a sale carries and the id the store
   * keys by.
   *
   * `attempts` is how many money rows name it. The panel needs it before it
   * offers a delete: the platform refuses one that has taken money, and a
   * screen that cannot see the count can only discover that by being refused.
   */
  paymentMethods: () => api.get<{ methods: ApiPaymentMethod[] }>('/payment-methods'),
  createPaymentMethod: (body: {
    code: string;
    label: string;
    kind: ApiPaymentMethod['kind'];
    sortOrder?: number;
  }) => api.post<{ id: string }>('/payment-methods', body, { idempotencyKey: idemKey() }),
  updatePaymentMethod: (
    code: string,
    patch: Partial<{ label: string; kind: ApiPaymentMethod['kind']; enabled: boolean; sortOrder: number }>,
  ) => api.patch<{ ok: true }>(`/payment-methods/${encodeURIComponent(code)}`, patch),
  /** One place up or down — the prototype's swap of two sort orders, done atomically. */
  movePaymentMethod: (code: string, direction: 'up' | 'down') =>
    api.post<{ ok: true; moved: boolean }>(
      `/payment-methods/${encodeURIComponent(code)}/move`,
      { direction },
      { idempotencyKey: idemKey() },
    ),
  deletePaymentMethod: (code: string) =>
    api.delete<{ ok: true }>(`/payment-methods/${encodeURIComponent(code)}`),
};


const printApi = {
  templates: (branchId: string) =>
    api.get<ApiResponse<'/branches/{branchId}/print-templates', 'get'>>(
      `/branches/${encodeURIComponent(branchId)}/print-templates`,
    ),
  updateTemplate: (
    id: string,
    body: Partial<Pick<ApiPrintTemplate, 'name' | 'showLogo' | 'headerText' | 'footerText' | 'fields'>>,
  ) => api.patch<ApiResponse<'/print-templates/{id}', 'patch'>>(`/print-templates/${encodeURIComponent(id)}`, body),
  /**
   * Print this template's sample on a real printer. No idempotency key: two
   * presses of "Test print" mean two pieces of paper, which is exactly what
   * somebody pressing it twice is asking for.
   */
  testPrint: (id: string, body?: { stationId?: string | null; copies?: number }) =>
    api.post<ApiResponse<'/print-templates/{id}/test-print', 'post'>>(
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
    api.get<ApiResponse<'/stations/{id}/printers', 'get'>>(
      `/stations/${encodeURIComponent(stationId)}/printers`,
    ),
};
const membersApi = {
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
  create: (body: { phone: string; nickname: string; preferredChannel?: 'whatsapp' | 'telegram' | 'line' }, id: string = newRecordId()) => {
    return api.post<{ member: ApiMember }>('/members', { id, ...body }, { idempotencyKey: idemKey() });
  },
  update: (id: string, patch: Record<string, unknown>) =>
    api.patch<{ member: ApiMember }>(`/members/${id}`, patch),
  /**
   * The till mints the child's id too (SCRUM-270, OD-12), for the reason given
   * on `create`: sending the same id again answers with the child that exists.
   */
  addChild: (memberId: string, body: Record<string, unknown>, id: string = newRecordId()) => {
    return api.post<{ child: ApiChild }>(
          `/members/${memberId}/children`,
          { id, ...body },
          { idempotencyKey: idemKey() },
        );
  },
  updateChild: (childId: string, patch: Record<string, unknown>, idempotencyKey?: string, signal?: AbortSignal) =>
    api.patch<{ child: ApiChild }>(`/members/children/${childId}`, patch, { idempotencyKey, signal }),
  /**
   * A tier checked on a document (OD-11): on the box lane it becomes a
   * `member.tier_changed` fact under the same permission as online.
   */
  verifyTier: (memberId: string, body: { toTier: string; evidenceType: string; evidenceExpiresAt?: string; note?: string }) =>
    api.post<{ member: ApiMember }>(`/members/${memberId}/tier-verification`, body, {
          idempotencyKey: idemKey(),
        }),
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
    api.deleteWithBody<{ member: ApiMember }>(`/members/${memberId}/tier-verification`, body, {
          idempotencyKey: idemKey(),
        }),
  tierVerifications: () =>
    api.get<{ verifications: ApiTierVerificationRecord[] }>('/members/tier-verifications'),
};

const templatesApi = {
  /**
   * The draft's sample, drawn by the renderer that drives the printer. The
   * body is `previewRequest`'s string, parsed back, so what is sent is exactly
   * what the preview's effect keyed on.
   */
  previewPng: (id: string, request: string, signal?: AbortSignal) =>
    api.postBlob(
      `/print-templates/${encodeURIComponent(id)}/preview.png`,
      JSON.parse(request) as unknown,
      signal,
    ),
  testPrintTarget: (id: string, stationId: string | null) =>
    api.get<ApiResponse<'/print-templates/{id}/test-print-target', 'get'>>(
      `/print-templates/${encodeURIComponent(id)}/test-print-target${
        stationId ? `?stationId=${encodeURIComponent(stationId)}` : ''
      }`,
    ),
};



return {branchesApi,catalogApi,printApi,membersApi,adminApi,templatesApi,opsApi};
}
