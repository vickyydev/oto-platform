// Hydration + write-through bridge between the platform API and the ported
// catalog store. Load once after sign-in (and on branch switches); the wired
// admin mutators call the write-through helpers so the DB is the source of
// truth while every prototype screen keeps its exact rendering path.
import type { AddOn, PaymentMethod, PricingOverride, TaxConfig, TicketType, TierDef } from '@/types';
import { getActiveBranch, hydrateFromApi, updateDropOffPricing } from '@/store/catalogStore';
import { setBranchDayStart, setBranchRateMode, setBranchTimezone } from '@/lib/pricingMode';
import { branchesApi, catalogApi, type ApiBranch, type ApiPaymentMethod, type PublicAddOn } from './platform';
import { isMissingRoute } from './client';
import { reloadMenuInto } from './menu';
import { loadSellableStock } from './stock';
import { apiBranchToBranch, apiPackageToTicketType, holidayToPricingOverride, ticketTypeToApiBody } from './mappers';

let _apiBranches: ApiBranch[] = [];

export function apiBranchIdForSlug(slug: string): string | null {
  return _apiBranches.find((b) => b.code === slug)?.id ?? null;
}

/**
 * How many money rows name each tender, by code, as of the last hydration
 * (SCRUM-206).
 *
 * It is kept here rather than in the catalog store because it is a fact about
 * the LEDGER, not part of the configured tender: a `PaymentMethod` is what the
 * park takes money in, and how much money has been taken in it is a different
 * question — the same split the holiday panel makes with `pricedSales`.
 *
 * The platform refuses to delete a tender that has taken money, with the count,
 * whatever this says. This exists so the panel can say so BEFORE the press
 * rather than after the refusal.
 */
let _paymentMethodUsage: Record<string, number> = {};

/** Money rows recorded against a tender, 0 for one the platform has never seen. */
export function paymentMethodUsage(code: string): number {
  return _paymentMethodUsage[code] ?? 0;
}

/** The API's tender row as the ported store holds it: `id` IS the token. */
const apiPaymentMethodToStore = (m: ApiPaymentMethod): PaymentMethod => ({
  id: m.id,
  label: m.label,
  kind: m.kind,
  enabled: m.enabled,
  sortOrder: m.sortOrder,
});

/**
 * Pull the tender list, or answer `undefined` and leave the seeded three alone.
 *
 * Non-fatal for the same reason the menu and the pricing mode are: a deployment
 * whose API predates these routes should keep showing the tenders it has always
 * shown rather than a till with no method grid at all. A refusal WITH one of our
 * error codes is a real answer and is left to throw.
 */
async function fetchPaymentMethods(): Promise<PaymentMethod[] | undefined> {
  try {
    const { methods } = await catalogApi.paymentMethods();
    _paymentMethodUsage = Object.fromEntries(methods.map((m) => [m.id, m.attempts]));
    return methods.map(apiPaymentMethodToStore);
  } catch (err) {
    if (isMissingRoute(err)) return undefined;
    throw err;
  }
}

/**
 * Pull the branch's catalogue off the platform (SCRUM-232, SCRUM-204).
 *
 * The SHOP and the ticket ADD-ONS ride in the same answer — one `product`
 * table, told apart by `kind` — and since SCRUM-204 all three are mapped, so
 * the F&B menu, the shop grid and the add-on list are read from the database.
 * The discount codes are fetched beside them: they are operator-wide and have
 * no branch, so they are not part of the menu answer.
 *
 * Non-fatal, and deliberately so: a deployment without the menu routes keeps the
 * ported catalogue the screens have always shown rather than an empty menu.
 * `pricingMode` above is non-fatal for the same reason, and only for a route
 * that answers 404 with none of our own error codes — the platform's words for
 * "that route is not here". A refusal WITH a code is a real answer and is left
 * to throw.
 *
 * Reading is one of the two halves. The menu panel's Import writes through this
 * API, and so do the Merch, Add-ons, Modifiers and Discounts panels; the F&B
 * item and category forms are the part still in-memory, which is what the
 * notice on that one panel says.
 *
 * Returns whether the menu on screen came from the database.
 */
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

/** Fetch branches + the active branch's wired collections and hydrate the store. */
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

// --- Write-through helpers (called by CatalogStoreContext wrappers) ---------

export async function saveTicketTypeToApi(branchSlug: string, t: TicketType, exists: boolean): Promise<void> {
  const branchId = apiBranchIdForSlug(branchSlug);
  if (!branchId) return; // branch not server-backed — mock-only edit
  if (exists) {
    await catalogApi.updatePackage(branchId, t.id, ticketTypeToApiBody(t));
  } else {
    await catalogApi.createPackage(branchId, ticketTypeToApiBody(t));
  }
  await loadCatalogFromApi(branchSlug); // pick up server ids / canonical state
}

export async function archiveTicketTypeInApi(branchSlug: string, id: string): Promise<void> {
  const branchId = apiBranchIdForSlug(branchSlug);
  if (!branchId) return;
  await catalogApi.archivePackage(branchId, id);
  await loadCatalogFromApi(branchSlug);
}

export async function saveHolidayToApi(branchSlug: string, o: PricingOverride, exists: boolean): Promise<void> {
  const branchId = apiBranchIdForSlug(branchSlug);
  if (!branchId) return;
  if (exists) {
    // SCRUM-309: an edit is a PATCH. It used to be a delete and a create, and
    // the platform refuses to remove a range once a sale was priced by it — so
    // the first ticket sold under a mistyped holiday froze the typo for good.
    await catalogApi.updateHoliday(branchId, o.id, {
      name: o.name,
      startsOn: o.startDate,
      endsOn: o.endDate,
    });
  } else {
    await catalogApi.createHoliday(branchId, {
      name: o.name,
      startsOn: o.startDate,
      endsOn: o.endDate,
    });
  }
  await loadCatalogFromApi(branchSlug);
}

/**
 * How many sales each of the branch's holiday ranges priced, by range id.
 *
 * The panel asks for this itself rather than reading it off the store: a
 * `PricingOverride` is the calendar entry, and how much was traded under it is
 * not part of that shape. Empty for a branch the platform does not know, which
 * is a mock-only branch where nothing has been sold at all.
 */
export async function holidaySaleCounts(branchSlug: string): Promise<Record<string, number>> {
  const branchId = apiBranchIdForSlug(branchSlug);
  if (!branchId) return {};
  const { holidays } = await catalogApi.holidays(branchId);
  return Object.fromEntries(holidays.map((h) => [h.id, h.pricedSales ?? 0]));
}

export async function deleteHolidayInApi(branchSlug: string, id: string): Promise<void> {
  const branchId = apiBranchIdForSlug(branchSlug);
  if (!branchId) return;
  await catalogApi.deleteHoliday(branchId, id);
  await loadCatalogFromApi(branchSlug);
}

/**
 * Tiers are operator-wide, not per branch, so there is no branch id to resolve
 * and no branch to skip: an edit here always goes to the platform (SCRUM-228).
 * `exists` says whether the store already held this tier id, which is what
 * separates a rename from a create — the id is the platform's tier code.
 */
export async function saveTierToApi(t: TierDef, exists: boolean): Promise<void> {
  if (exists) {
    await catalogApi.updateTier(t.id, {
      name: t.name,
      isDefault: t.isDefault,
      requiresVerification: t.requiresVerification,
      sortOrder: t.sortOrder,
    });
  } else {
    await catalogApi.createTier({
      code: t.id,
      name: t.name,
      isDefault: t.isDefault,
      requiresVerification: t.requiresVerification,
      sortOrder: t.sortOrder,
    });
  }
  await loadCatalogFromApi(getActiveBranch().id);
}

export async function deleteTierInApi(id: string): Promise<void> {
  await catalogApi.deleteTier(id);
  await loadCatalogFromApi(getActiveBranch().id);
}

/**
 * Save a tender (SCRUM-206).
 *
 * Operator-wide like the tiers above, so there is no branch id to resolve and
 * no mock-only branch to skip: an edit here always goes to the platform.
 * `exists` is what separates a rename from a create — the store's id is the
 * platform's tender code, minted by the panel and never changed afterwards.
 */
export async function savePaymentMethodToApi(m: PaymentMethod, exists: boolean): Promise<void> {
  if (exists) {
    await catalogApi.updatePaymentMethod(m.id, {
      label: m.label,
      kind: m.kind,
      enabled: m.enabled,
      sortOrder: m.sortOrder,
    });
  } else {
    await catalogApi.createPaymentMethod({
      code: m.id,
      label: m.label,
      kind: m.kind,
      sortOrder: m.sortOrder,
    });
  }
  await loadCatalogFromApi(getActiveBranch().id);
}

/**
 * Move a tender one place up or down.
 *
 * ONE request, not the panel's two writes: the prototype swaps two `sortOrder`
 * values (`PaymentMethodsSection.tsx:69-77`), and sending that as two PATCHes
 * would leave a window in which a till reading the list sees both rows on the
 * same number. The platform does the swap in one transaction with one audit row.
 */
export async function movePaymentMethodInApi(code: string, direction: 'up' | 'down'): Promise<void> {
  await catalogApi.movePaymentMethod(code, direction);
  await loadCatalogFromApi(getActiveBranch().id);
}

/**
 * Remove a tender. Refused by the platform once money has been taken in it,
 * with the count — the panel offers disable instead before it gets that far.
 */
export async function deletePaymentMethodInApi(code: string): Promise<void> {
  await catalogApi.deletePaymentMethod(code);
  await loadCatalogFromApi(getActiveBranch().id);
}

export async function saveTaxConfigToApi(branchSlug: string, config: TaxConfig): Promise<void> {
  const branchId = apiBranchIdForSlug(branchSlug);
  if (!branchId) return;
  await catalogApi.putTaxConfig(branchId, config);
}

export async function saveBranchToApi(branch: {
  id: string;
  name: string;
  country?: string;
  timezone?: string;
  active: boolean;
  apiId?: string;
}): Promise<void> {
  if (branch.apiId) {
    await branchesApi.update(branch.apiId, {
      name: branch.name,
      country: branch.country,
      ...(branch.timezone ? { timezone: branch.timezone } : {}),
      archived: !branch.active,
    });
  } else {
    // The slug the prototype uses as `Branch.id` IS the platform's branch
    // code — one name for the branch everywhere, which is what lets
    // `apiBranchIdForSlug` line the two up.
    await branchesApi.create({
      name: branch.name,
      code: branch.id,
      country: branch.country,
      ...(branch.timezone ? { timezone: branch.timezone } : {}),
    });
  }
  // Re-hydrate around the branch that is OPEN, not around whichever branch
  // the API listed first: this call also sets the trading-day timezone and
  // today's rate mode, and doing that from another branch's calendar would
  // re-price the till that is standing in front of somebody.
  await loadCatalogFromApi(getActiveBranch().id);
}
