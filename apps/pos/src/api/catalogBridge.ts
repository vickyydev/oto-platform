import type { AddOn, PaymentMethod, PricingOverride, TaxConfig, TicketType, TierDef } from '@/types';
import { hydrateFromApi, updateDropOffPricing } from '@/store/catalogStore';
import { setBranchDayStart, setBranchRateMode, setBranchTimezone } from '@/lib/pricingMode';
import { apiBranchToBranch, apiPackageToTicketType, holidayToPricingOverride } from './mappers';
import { branchesApi, catalogApi, type ApiBranch, type ApiPaymentMethod, type PublicAddOn } from './platform';
import { reloadMenuInto } from './menu';
import { loadSellableStock } from './stock';
import { isMissingRoute } from './client';

let _apiBranches: ApiBranch[] = [];

export function apiBranchIdForSlug(slug: string): string | null {
  return _apiBranches.find((b) => b.code === slug)?.id ?? null;
}

const apiPaymentMethodToStore = (m: ApiPaymentMethod): PaymentMethod => ({
  id: m.id,
  label: m.label,
  kind: m.kind,
  enabled: m.enabled,
  sortOrder: m.sortOrder,
});

async function fetchPaymentMethods(): Promise<PaymentMethod[] | undefined> {
  try {
    const { methods } = await catalogApi.paymentMethods();
    return methods.map(apiPaymentMethodToStore);
  } catch (err) {
    if (isMissingRoute(err)) return undefined;
    throw err;
  }
}

export async function loadMenuFromApi(branchSlug: string): Promise<boolean> {
  const branchId = apiBranchIdForSlug(branchSlug);
  if (!branchId) return false;
  try {
    // The whole catalogue in one place (SCRUM-204): categories, F&B items, the
    // modifier library, the shop, the ticket add-ons and the discount codes.
    // The shape lives in `api/menu.ts` beside the mappers, so the cold load and
    // the read-back after an admin save cannot disagree about what a hydration
    // contains — which is how the shop came to be READ from the mock while the
    // menu beside it came from the database.
    await reloadMenuInto(branchId, branchSlug);
    // S2-14b — what each tracked size holds, beside the menu that names it. Its
    // own non-fatal read (`api/stock.ts`): a platform without the stock route
    // keeps the ported inventory, and the menu above is still the platform's.
    await loadSellableStock(branchId);
    return true;
  } catch (err) {
    if (isMissingRoute(err)) return false;
    throw err;
  }
}

export async function loadCatalogFromApi(activeSlug?: string): Promise<void> {
  const { branches } = await branchesApi.list();
  _apiBranches = branches;
  const mapped = branches.map(apiBranchToBranch);
  // The tenders are operator-wide, so they are fetched once here and not inside
  // the per-branch block below (SCRUM-206).
  const paymentMethods = await fetchPaymentMethods();

  const slug = activeSlug ?? mapped[0]?.id;
  const perBranch: Record<
    string,
    Partial<{ tiers: TierDef[]; ticketTypes: TicketType[]; taxConfig: TaxConfig }>
  > = {};
  let pricingOverrides: PricingOverride[] | undefined;

  const active = branches.find((b) => b.code === slug);
  if (active) {
    // The trading day is read off the branch's calendar, not the browser's
    // (SCRUM-229). Set before anything prices, and re-set on every branch switch.
    setBranchTimezone(active.timezone);
    // And its trading day starts at 05:00, not midnight (SCRUM-308).
    setBranchDayStart(active.businessDayStart);
    const [tiersRes, packagesRes, holidaysRes, taxRes, rateModeRes] = await Promise.all([
      catalogApi.tiers(),
      catalogApi.packages(active.id),
      catalogApi.holidays(active.id),
      catalogApi.taxConfig(active.id),
      // The platform's own answer for today, decided on a clock the park
      // controls. Non-fatal: a till that cannot get it falls back to its own
      // clock on the branch's calendar, which is what it did before.
      catalogApi.pricingMode(active.id).catch(() => null),
    ]);
    setBranchRateMode(rateModeRes);
    const tiers: TierDef[] = tiersRes.tiers.map((t) => ({
      id: t.id,
      name: t.name,
      isDefault: t.isDefault,
      requiresVerification: t.requiresVerification,
      sortOrder: t.sortOrder,
    }));
    perBranch[active.code] = {
      tiers,
      ticketTypes: packagesRes.packages.map(apiPackageToTicketType),
      ...(taxRes.config ? { taxConfig: taxRes.config as TaxConfig } : {}),
    };
    pricingOverrides = holidaysRes.holidays.map(holidayToPricingOverride);
  }

  hydrateFromApi({
    branches: mapped,
    perBranch,
    pricingOverrides,
    ...(paymentMethods ? { paymentMethods } : {}),
  });

  // After the branch list is in place, so `apiBranchIdForSlug` can resolve.
  if (slug) await loadMenuFromApi(slug);
}

/**
 * One extra from the public catalogue, as the ported store holds it: prices in
 * baht, as weekday/weekend, and the area the platform resolved carried as the
 * override so the site taxes it exactly as the booking quote does.
 */
export const publicAddOnToStore = (a: PublicAddOn): AddOn => ({
  id: a.id,
  name: a.name,
  price: {
    weekday: a.priceSatang / 100,
    weekend: (a.priceWeekendSatang ?? a.priceSatang) / 100,
  },
  ...(a.taxCategory ? { taxCategoryOverride: a.taxCategory } : {}),
  ...(a.translations ? { translations: a.translations } : {}),
});

/**
 * Public /book hydration (no session): pull the branch's active packages +
 * tiers + holidays through the public endpoint so the customer site prices
 * from the database. Returns the catalog for direct use (rate mode etc.).
 *
 * S2-12: the extras and the tax configuration come from it too. The platform
 * refuses a booking whose shown total is not its own quote, so the figures the
 * total is built from have to be the platform's — the prototype's add-on list
 * and tax set-up held in this browser agreed with it only while nobody had
 * edited either in the Console.
 */
export async function loadPublicCatalog(branchCode: string) {
  const { publicApi } = await import('./platform');
  const cat = await publicApi.catalog(branchCode);
  // A visitor booking from their phone is in whatever timezone they are in;
  // the prices they are quoted are the branch's (SCRUM-229).
  setBranchTimezone(cat.branch.timezone);
  setBranchDayStart(cat.branch.businessDayStart);
  setBranchRateMode(cat.rateMode);
  hydrateFromApi({
    perBranch: {
      [cat.branch.code]: {
        tiers: cat.tiers.map((t, i) => ({
          id: t.id,
          name: t.name,
          isDefault: t.isDefault,
          requiresVerification: t.requiresVerification,
          sortOrder: i,
        })),
        ticketTypes: cat.packages.map(apiPackageToTicketType),
        ...(cat.addOns ? { addOns: cat.addOns.map(publicAddOnToStore) } : {}),
        ...(cat.taxConfig ? { taxConfig: cat.taxConfig } : {}),
        ...(cat.supervision ? { supervisionPolicy: cat.supervision.policy } : {}),
      },
    },
    pricingOverrides: cat.holidays.map((h, i) => ({
      id: `pub-${i}`,
      name: h.name,
      startDate: h.startsOn,
      endDate: h.endsOn,
    })),
  });
  if (cat.supervision) {
    const p = cat.supervision.pricing;
    updateDropOffPricing({
      oneTimeFeeTHB: { weekday: p.oneTimeFee.weekday / 100, weekend: p.oneTimeFee.weekend / 100 },
      nannyHourlyRateTHB: { weekday: p.nannyHourly.weekday / 100, weekend: p.nannyHourly.weekend / 100 },
      extraHourTHB: { weekday: p.extraHour.weekday / 100, weekend: p.extraHour.weekend / 100 },
      fullDayHours: p.fullDayHours, nannyRatioSoftMax: p.nannyRatioSoftMax, prepaidFoodRefundPolicy: p.prepaidFoodUnused,
    });
  }
  return cat;
}
