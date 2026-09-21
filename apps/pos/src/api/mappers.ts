// Mapping between the platform API (satang integers, uuid ids, snake truth)
// and the prototype UI shapes (whole ฿, string ids). This is the ONE place
// money units convert — the ported UI keeps thinking in baht.
import type {
  Branch,
  Member,
  SavedChild,
  TicketType,
  TierVerification,
  WeekdayWeekendPrice,
  PricingOverride,
} from '@/types';
import type { ApiBranch, ApiChild, ApiMember, ApiTicketPackage } from './platform';

const b = (satang: number): number => satang / 100;
const s = (baht: number): number => Math.round(baht * 100);

const wwToBaht = (p: { weekday: number; weekend: number }): WeekdayWeekendPrice => ({
  weekday: b(p.weekday),
  weekend: b(p.weekend),
});
const wwToSatang = (p: WeekdayWeekendPrice): { weekday: number; weekend: number } => ({
  weekday: s(p.weekday),
  weekend: s(p.weekend),
});

export function apiChildToSavedChild(c: ApiChild): SavedChild {
  return {
    id: c.id,
    childName: c.name,
    childAge: c.ageYears ?? ageFromDob(c.dateOfBirth) ?? 0,
    dateOfBirth: c.dateOfBirth ?? undefined,
    allergiesMedical: c.allergies ?? undefined,
    dietary: c.dietary ?? undefined,
    foodRestrictions: c.foodRestrictions ?? undefined,
    notes: c.notes ?? undefined,
    savedAt: c.lastConfirmedAt ?? new Date().toISOString(),
    updatedAt: c.lastConfirmedAt ?? new Date().toISOString(),
    savedBy: undefined,
  };
}

function ageFromDob(dob: string | null): number | null {
  if (!dob) return null;
  const born = new Date(`${dob}T00:00:00`);
  const now = new Date();
  let age = now.getFullYear() - born.getFullYear();
  const m = now.getMonth() - born.getMonth();
  if (m < 0 || (m === 0 && now.getDate() < born.getDate())) age--;
  return Math.max(0, age);
}

export function apiMemberToMember(m: ApiMember): Member {
  const verification: TierVerification | undefined = m.tierVerification
    ? {
        tier: m.tierVerification.tier,
        proofType: m.tierVerification.proofType,
        verifiedBy: m.tierVerification.verifiedBy ?? 'Verified',
        verifiedById: 'api',
        verifiedAt: m.tierVerification.verifiedAt,
        expiresAt: m.tierVerification.expiresAt ?? undefined,
      }
    : undefined;
  return {
    id: m.id,
    phone: m.phone,
    nickname: m.nickname,
    tierVerification: verification,
    preferredChannel: m.preferredChannel ?? undefined,
    savedChildren: m.children.map(apiChildToSavedChild),
  };
}

export function apiPackageToTicketType(p: ApiTicketPackage): TicketType {
  const prices: TicketType['prices'] = {};
  for (const [tier, pair] of Object.entries(p.prices)) prices[tier] = wwToBaht(pair);
  const adultRules: TicketType['adultRules'] = p.adultRules
    ? Object.fromEntries(
        Object.entries(p.adultRules).map(([tier, r]) => [
          tier,
          {
            kind: r.kind as 'same_as_kid' | 'set_price' | 'free_adults',
            price: r.price ? wwToBaht(r.price) : undefined,
            freeAdults: r.freeAdults,
            overflow: r.overflow as 'same_as_kid' | 'set_price' | undefined,
          },
        ]),
      )
    : undefined;
  return {
    id: p.id,
    name: p.name,
    durationLabel: p.durationLabel,
    hours: p.hours,
    prices,
    tierPricing: (p.tierPricing as TicketType['tierPricing']) ?? undefined,
    adultRules,
    freebies: (p.freebies as TicketType['freebies']) ?? undefined,
    creditRule: (p.creditRule as TicketType['creditRule']) ?? undefined,
    gateAccess: p.gateAccess,
    translations: (p.translations as TicketType['translations']) ?? undefined,
  };
}

export function ticketTypeToApiBody(t: TicketType): Record<string, unknown> {
  const prices: Record<string, { weekday: number; weekend: number }> = {};
  for (const [tier, pair] of Object.entries(t.prices)) prices[tier] = wwToSatang(pair);
  const adultRules = t.adultRules
    ? Object.fromEntries(
        Object.entries(t.adultRules).map(([tier, r]) => [
          tier,
          { ...r, price: r.price ? wwToSatang(r.price) : undefined },
        ]),
      )
    : null;
  return {
    name: t.name,
    durationLabel: t.durationLabel,
    hours: t.hours,
    prices,
    tierPricing: t.tierPricing ?? null,
    adultRules,
    freebies: t.freebies ?? null,
    creditRule: t.creditRule ?? null,
    gateAccess: t.gateAccess ?? false,
    translations: t.translations ?? null,
  };
}

/** API branch → prototype Branch (id stays the slug so mock catalogs keep working). */
export function apiBranchToBranch(br: ApiBranch): Branch {
  return {
    id: br.code,
    name: br.name,
    country: br.country ?? undefined,
    timezone: br.timezone,
    active: !br.archived,
    apiId: br.id,
  };
}

export function holidayToPricingOverride(h: { id: string; name: string; startsOn: string; endsOn: string }): PricingOverride {
  return { id: h.id, name: h.name, startDate: h.startsOn, endDate: h.endsOn };
}
