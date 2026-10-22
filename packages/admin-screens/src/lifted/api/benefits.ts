import type { BenefitProfile as PlatformProfile, BenefitRole, BenefitTarget } from '@oto/shared';
import type { BenefitProfile, DiscountTarget } from '../model/types';
import type { ApiBody, ApiResponse } from '@oto/api-types';
import type { LiftedAdminApi } from '../../api/lifted-api';
import { idemKey } from './client';

/**
 * Admin > Staff Benefits, from the back office's side (S2-21, SCRUM-218,
 * round 1 of docs/progress/plans/benefits/PLAN.md). Every rule — which version
 * is in force on a day, what an override does, who may change what — is the
 * platform's (`apps/api/src/services/benefits.ts`); this file carries it.
 *
 *   templates  `GET /benefits/templates`, `GET/PUT /benefits/templates/:role`
 *   staff      `GET /benefits/profiles`, `GET/PUT /benefits/profiles/:employeeId`
 *   QR         `GET/POST /benefits/credentials`, `GET /benefits/credentials/:id/qr`,
 *              `POST /benefits/credentials/:id/revoke` (round 2)
 *   checkout   `POST /benefits/resolve`, `DELETE /sales/:id/benefit` (round 3);
 *              the preview rides every quote and the claim the commit
 *              (`api/sales.ts`, the cart's `benefit`)
 *
 * The platform keeps money in satang; the prototype's editor
 * (`BenefitProfileFields`) holds baht, so a profile is converted at this
 * boundary and nowhere else.
 */

/*
 * The shapes below are the platform's own description of these routes
 * (SCRUM-272): generated from the api's OpenAPI document into
 * `@oto/api-types`, so a change to what a route answers fails this file's
 * typecheck instead of a screen at run time. They keep the names the screens
 * import; none of them is written by hand any more.
 */
type TemplatesAnswer = ApiResponse<'/benefits/templates', 'get'>;
type StaffAnswer = ApiResponse<'/benefits/profiles', 'get'>;

export type BenefitTemplateRow = TemplatesAnswer['templates'][number];
export type BenefitTemplateVersion = NonNullable<BenefitTemplateRow['current']>;
export type BenefitVersionAuthor = NonNullable<BenefitTemplateVersion['createdBy']>;

export type StaffBenefitRow = StaffAnswer['staff'][number];
export type StaffBenefitVersion = NonNullable<StaffBenefitRow['current']>;

/** What a template version and a staff version share. */
type BenefitVersionBase = Pick<BenefitTemplateVersion, 'effectiveFrom' | 'effectiveTo'>;

/** A staff member's benefit QR, as the platform records it — never the code (round 2). */
export type BenefitCredential = ApiResponse<'/benefits/credentials', 'get'>['credentials'][number];

/**
 * A scanned or typed staff benefit QR as the platform resolved it (S2-21 round
 * 3; `POST /benefits/resolve`): whose it is and what applies to them today.
 * Never the QR.
 */
export type ResolvedBenefitView = ApiResponse<'/benefits/resolve', 'post'>;

/** One entry of the Staff Benefits Audit log, from the platform (round 3). */
export type BenefitApplicationLogRow = ApiResponse<
  '/benefits/applications',
  'get'
>['applications'][number];

/** What taking the benefit off a rung-up sale gave back (round 3). */
export type RemovedSaleBenefit = ApiResponse<'/sales/{id}/benefit', 'delete'>;

/** What the QR dialog prints: the name over the QR and the code it encodes. */
export type BenefitQrPayload = ApiResponse<'/benefits/credentials/{credentialId}/qr', 'get'>;

const path = (s: string) => encodeURIComponent(s);

export function createBenefitsAdminApi(api: LiftedAdminApi) {
  return {
  templates: () => api.get<ApiResponse<'/benefits/templates', 'get'>>('/benefits/templates'),
  templateHistory: (role: BenefitRole) =>
    api.get<ApiResponse<'/benefits/templates/{role}', 'get'>>(`/benefits/templates/${path(role)}`),
  /** One key per press: a retried Save is the same version, never a second. */
  saveTemplate: (
    role: BenefitRole,
    body: ApiBody<'/benefits/templates/{role}', 'put'>,
    idempotencyKey: string = idemKey(),
  ) =>
    api.put<ApiResponse<'/benefits/templates/{role}', 'put'>>(
      `/benefits/templates/${path(role)}`,
      body,
      {
        idempotencyKey,
      },
    ),
  staff: () => api.get<ApiResponse<'/benefits/profiles', 'get'>>('/benefits/profiles'),
  staffHistory: (employeeId: string) =>
    api.get<ApiResponse<'/benefits/profiles/{employeeId}', 'get'>>(
      `/benefits/profiles/${path(employeeId)}`,
    ),
  saveStaff: (
    employeeId: string,
    body: ApiBody<'/benefits/profiles/{employeeId}', 'put'>,
    idempotencyKey: string = idemKey(),
  ) =>
    api.put<ApiResponse<'/benefits/profiles/{employeeId}', 'put'>>(
      `/benefits/profiles/${path(employeeId)}`,
      body,
      {
        idempotencyKey,
      },
    ),
  // --- The benefit QR (round 2) ------------------------------------------------
  credentials: (employeeId: string) =>
    api.get<ApiResponse<'/benefits/credentials', 'get'>>(
      `/benefits/credentials?employeeId=${path(employeeId)}`,
    ),
  /** One key per press: a retried Issue is the same QR, never a second. */
  issueCredential: (employeeId: string, idempotencyKey: string = idemKey()) =>
    api.post<ApiResponse<'/benefits/credentials', 'post'>>(
      '/benefits/credentials',
      { employeeId },
      { idempotencyKey },
    ),
  credentialQr: (credentialId: string) =>
    api.get<ApiResponse<'/benefits/credentials/{credentialId}/qr', 'get'>>(
      `/benefits/credentials/${path(credentialId)}/qr`,
    ),
  revokeCredential: (credentialId: string, idempotencyKey: string = idemKey()) =>
    api.post<ApiResponse<'/benefits/credentials/{credentialId}/revoke', 'post'>>(
      `/benefits/credentials/${path(credentialId)}/revoke`,
      {},
      { idempotencyKey },
    ),
  /** The Audit log: every benefit applied to a recorded order, newest first (round 3). */
  applications: () =>
    api.get<ApiResponse<'/benefits/applications', 'get'>>('/benefits/applications'),
  };
}

// --- The editor's shape and the platform's ------------------------------------------

/** The platform's profile, in satang, as the prototype's editor holds it, in baht. */
export function profileFromApi(p: PlatformProfile): BenefitProfile {
  const out: BenefitProfile = {};
  if (p.comp) out.comp = true;
  if (p.freeItems)
    out.freeItems = p.freeItems.map((f) => ({ ...f, target: f.target as DiscountTarget }));
  if (p.credit) {
    out.credit = {
      amountTHB: p.credit.amountSatang / 100,
      period: p.credit.period,
      ...(p.credit.target ? { target: p.credit.target as DiscountTarget } : {}),
    };
  }
  if (p.standingDiscount) {
    out.standingDiscount = {
      percent: p.standingDiscount.percent,
      ...(p.standingDiscount.target ? { target: p.standingDiscount.target as DiscountTarget } : {}),
    };
  }
  return out;
}

/**
 * The editor's profile as the platform stores it. A switched-off comp and an
 * empty free-item list are left out rather than sent as `false` and `[]`, so
 * a profile edited back to what it was compares equal to it. The editor only
 * ever offers the F&B scopes, which are the ones the platform accepts.
 */
export function profileToApi(p: BenefitProfile): PlatformProfile {
  const out: PlatformProfile = {};
  if (p.comp) out.comp = true;
  if (p.freeItems && p.freeItems.length > 0) {
    out.freeItems = p.freeItems.map((f) => ({ ...f, target: f.target as BenefitTarget }));
  }
  if (p.credit) {
    out.credit = {
      amountSatang: Math.round(p.credit.amountTHB * 100),
      period: p.credit.period,
      ...(p.credit.target ? { target: p.credit.target as BenefitTarget } : {}),
    };
  }
  if (p.standingDiscount) {
    out.standingDiscount = {
      percent: p.standingDiscount.percent,
      ...(p.standingDiscount.target ? { target: p.standingDiscount.target as BenefitTarget } : {}),
    };
  }
  return out;
}

/** Key-order-independent JSON: whether two profiles say the same thing. */
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
}

export const sameProfile = (a: PlatformProfile | null, b: PlatformProfile | null): boolean =>
  canonical(a) === canonical(b);

/** The version of a list that is in force on `day`, if any. */
export function inForceOn<T extends BenefitVersionBase>(
  versions: readonly T[],
  day: string,
): T | undefined {
  return versions.find(
    (v) => v.effectiveFrom <= day && (v.effectiveTo === null || v.effectiveTo > day),
  );
}
