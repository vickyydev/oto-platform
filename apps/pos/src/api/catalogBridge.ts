import {createCatalogBridge} from '@oto/admin-screens/lifted/api/catalogBridge';
import type {AddOn} from '@/types';
import {getActiveBranch,hydrateFromApi,updateDropOffPricing} from '@/store/catalogStore';
import {setBranchDayStart,setBranchRateMode,setBranchTimezone} from '@/lib/pricingMode';
import {apiPackageToTicketType} from './mappers';
import type {PublicAddOn} from './platform';
import {reloadMenuInto} from './menu';
import {loadSellableStock} from './stock';
import {adminScreenApi} from './admin-screen-api';

const bound = createCatalogBridge(adminScreenApi,{getActiveBranch,hydrateFromApi,setBranchDayStart,setBranchRateMode,setBranchTimezone,reloadMenuInto,loadSellableStock});
export const {apiBranchIdForSlug, paymentMethodUsage, loadMenuFromApi, loadCatalogFromApi, saveTicketTypeToApi, archiveTicketTypeInApi, saveHolidayToApi, holidaySaleCounts, deleteHolidayInApi, saveTierToApi, deleteTierInApi, savePaymentMethodToApi, movePaymentMethodInApi, deletePaymentMethodInApi, saveTaxConfigToApi, saveBranchToApi} = bound;

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
