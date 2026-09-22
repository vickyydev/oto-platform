// Hydration + write-through bridge between the platform API and the ported
// catalog store. Load once after sign-in (and on branch switches); the wired
// admin mutators call the write-through helpers so the DB is the source of
// truth while every prototype screen keeps its exact rendering path.
import type { PricingOverride, TaxConfig, TicketType, TierDef } from '@/types';
import { getActiveBranch, hydrateFromApi } from '@/store/catalogStore';
import { setBranchRateMode, setBranchTimezone } from '@/lib/pricingMode';
import { branchesApi, catalogApi, type ApiBranch } from './platform';
import { isMissingRoute } from './client';
import { mapMenu, menuApi } from './menu';
import { apiBranchToBranch, apiPackageToTicketType, holidayToPricingOverride, ticketTypeToApiBody } from './mappers';

let _apiBranches: ApiBranch[] = [];

export function apiBranchIdForSlug(slug: string): string | null {
  return _apiBranches.find((b) => b.code === slug)?.id ?? null;
}

/**
 * Pull the branch's menu off the platform (SCRUM-232).
 *
 * The SHOP and the ticket ADD-ONS ride in the same answer — one `product` table,
 * told apart by `kind` — but `mapMenu` keeps only `kind === 'menu'`, so those
 * two screens still render the ported mock. `MOCK_MUTATOR_TICKETS` names the
 * ticket for each.
 *
 * Non-fatal, and deliberately so: a deployment without the menu routes keeps the
 * ported catalogue the screens have always shown rather than an empty menu.
 * `pricingMode` above is non-fatal for the same reason, and only for a route
 * that answers 404 with none of our own error codes — the platform's words for
 * "that route is not here". A refusal WITH a code is a real answer and is left
 * to throw.
 *
 * Reading is one of the two halves that exist. The menu panel's Import writes
 * through this API as well, and calls this afterwards to pick up what it wrote;
 * editing one item in the admin form is the part that is still in-memory, which
 * is what that panel's notice says.
 *
 * Returns whether the menu on screen came from the database.
 */
export async function loadMenuFromApi(branchSlug: string): Promise<boolean> {
  const branchId = apiBranchIdForSlug(branchSlug);
  if (!branchId) return false;
  try {
    const { categories, menuItems, modifierGroups } = mapMenu(await menuApi.load(branchId));
    hydrateFromApi({
      perBranch: { [branchSlug]: { menuCategories: categories, menuItems, modifierGroups } },
    });
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

  hydrateFromApi({ branches: mapped, perBranch, pricingOverrides });

  // After the branch list is in place, so `apiBranchIdForSlug` can resolve.
  if (slug) await loadMenuFromApi(slug);
}

/**
 * Public /book hydration (no session): pull the branch's active packages +
 * tiers + holidays through the public endpoint so the customer site prices
 * from the database. Returns the catalog for direct use (rate mode etc.).
 */
export async function loadPublicCatalog(branchCode: string) {
  const { publicApi } = await import('./platform');
  const cat = await publicApi.catalog(branchCode);
  // A visitor booking from their phone is in whatever timezone they are in;
  // the prices they are quoted are the branch's (SCRUM-229).
  setBranchTimezone(cat.branch.timezone);
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
      },
    },
    pricingOverrides: cat.holidays.map((h, i) => ({
      id: `pub-${i}`,
      name: h.name,
      startDate: h.startsOn,
      endDate: h.endsOn,
    })),
  });
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
    // Holidays have no PATCH — replace (delete + create) keeps the API simple.
    await catalogApi.deleteHoliday(branchId, o.id);
  }
  await catalogApi.createHoliday(branchId, { name: o.name, startsOn: o.startDate, endsOn: o.endDate });
  await loadCatalogFromApi(branchSlug);
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
