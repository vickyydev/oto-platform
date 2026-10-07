import type { BenefitProfile as PlatformProfile, BenefitRole, BenefitTarget } from '@oto/shared';
import type { BenefitProfile, DiscountTarget } from '@/types';
import { api, idemKey } from './client';

/**
 * Admin > Staff Benefits, from the back office's side (S2-21, SCRUM-218,
 * round 1 of docs/progress/plans/benefits/PLAN.md). Every rule — which version
 * is in force on a day, what an override does, who may change what — is the
 * platform's (`apps/api/src/services/benefits.ts`); this file carries it.
 *
 *   templates  `GET /benefits/templates`, `GET/PUT /benefits/templates/:role`
 *   staff      `GET /benefits/profiles`, `GET/PUT /benefits/profiles/:employeeId`
 *
 * The platform keeps money in satang; the prototype's editor
 * (`BenefitProfileFields`) holds baht, so a profile is converted at this
 * boundary and nowhere else.
 */

export interface BenefitVersionAuthor {
  accountId: string;
  name: string | null;
}

interface BenefitVersionBase {
  id: string;
  /** First trading day the version counts on. */
  effectiveFrom: string;
  /** First trading day it no longer counts on (exclusive); null runs on. */
  effectiveTo: string | null;
  createdAt: string;
  /** Null for a version the seed wrote. */
  createdBy: BenefitVersionAuthor | null;
}

export interface BenefitTemplateVersion extends BenefitVersionBase {
  profile: PlatformProfile;
}

export interface StaffBenefitVersion extends BenefitVersionBase {
  benefitRole: BenefitRole | null;
  override: PlatformProfile | null;
}

export interface BenefitTemplateRow {
  role: BenefitRole;
  name: string;
  current: BenefitTemplateVersion | null;
  upcoming: BenefitTemplateVersion[];
}

export interface StaffBenefitRow {
  employeeId: string;
  name: string;
  nickname: string | null;
  branchId: string | null;
  branchName: string | null;
  source: 'platform' | 'otoapp';
  current: StaffBenefitVersion | null;
  upcoming: StaffBenefitVersion[];
  effectiveProfile: PlatformProfile;
}

const path = (s: string) => encodeURIComponent(s);

export const benefitsApi = {
  templates: () =>
    api.get<{ today: string; templates: BenefitTemplateRow[] }>('/benefits/templates'),
  templateHistory: (role: BenefitRole) =>
    api.get<{ today: string; template: BenefitTemplateRow; versions: BenefitTemplateVersion[] }>(
      `/benefits/templates/${path(role)}`,
    ),
  /** One key per press: a retried Save is the same version, never a second. */
  saveTemplate: (
    role: BenefitRole,
    body: { profile: PlatformProfile; effectiveFrom: string },
    idempotencyKey: string = idemKey(),
  ) =>
    api.put<{ changed: boolean; template: BenefitTemplateRow }>(
      `/benefits/templates/${path(role)}`,
      body,
      {
        idempotencyKey,
      },
    ),
  staff: () => api.get<{ today: string; staff: StaffBenefitRow[] }>('/benefits/profiles'),
  staffHistory: (employeeId: string) =>
    api.get<{ today: string; staff: StaffBenefitRow; versions: StaffBenefitVersion[] }>(
      `/benefits/profiles/${path(employeeId)}`,
    ),
  saveStaff: (
    employeeId: string,
    body: {
      benefitRole: BenefitRole | null;
      override: PlatformProfile | null;
      effectiveFrom: string;
    },
    idempotencyKey: string = idemKey(),
  ) =>
    api.put<{ changed: boolean; staff: StaffBenefitRow }>(
      `/benefits/profiles/${path(employeeId)}`,
      body,
      {
        idempotencyKey,
      },
    ),
};

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
