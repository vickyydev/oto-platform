// Hydration + write-through bridge between the platform API and the ported
// catalog store. Load once after sign-in (and on branch switches); the wired
// admin mutators call the write-through helpers so the DB is the source of
// truth while every prototype screen keeps its exact rendering path.
import type { PricingOverride, TaxConfig, TicketType, TierDef } from '@/types';
import { hydrateFromApi } from '@/store/catalogStore';
import { branchesApi, catalogApi, type ApiBranch } from './platform';
import { apiBranchToBranch, apiPackageToTicketType, holidayToPricingOverride, ticketTypeToApiBody } from './mappers';

let _apiBranches: ApiBranch[] = [];

export function apiBranchIdForSlug(slug: string): string | null {
  return _apiBranches.find((b) => b.code === slug)?.id ?? null;
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
    const [tiersRes, packagesRes, holidaysRes, taxRes] = await Promise.all([
      catalogApi.tiers(),
      catalogApi.packages(active.id),
      catalogApi.holidays(active.id),
      catalogApi.taxConfig(active.id),
    ]);
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

export async function saveTaxConfigToApi(branchSlug: string, config: TaxConfig): Promise<void> {
  const branchId = apiBranchIdForSlug(branchSlug);
  if (!branchId) return;
  await catalogApi.putTaxConfig(branchId, config);
}

export async function saveBranchToApi(branch: {
  id: string;
  name: string;
  country?: string;
  active: boolean;
  apiId?: string;
}): Promise<void> {
  if (branch.apiId) {
    await branchesApi.update(branch.apiId, {
      name: branch.name,
      country: branch.country,
      archived: !branch.active,
    });
  } else {
    await branchesApi.create({ name: branch.name, code: branch.id, country: branch.country });
  }
  await loadCatalogFromApi();
}
