import type { ReactNode } from 'react';
import { useLocation, useSearch } from 'wouter';
import { AdminScreenProvider } from '@oto/admin-screens/lifted/runtime';
import { useCatalogStore } from '@/store/CatalogStoreContext';
import * as reads from '@/store/catalogStore';
import { useOperator } from '@/auth/OperatorContext';
import { useBranch } from '@/branch/BranchContext';
import { useStation } from '@/station/StationContext';
import { useLanguage } from '@/i18n/LanguageContext';
import { toast } from '@/hooks/use-toast';
import { adminScreenApi } from '@/api/admin-screen-api';
import * as platform from '@/api/platform';
import * as menuApi from '@/api/menu';
import * as catalogBridge from '@/api/catalogBridge';
import * as analyticsReports from '@/api/analyticsReports';
import * as benefitsApi from '@/api/benefits';
import * as stock from '@/api/stock';
import * as events from '@/api/events';
import * as checkin from '@/api/checkin';
import * as wallet from '@/api/wallet';
import * as voucherPromotions from '@/api/voucherPromotions';
import * as membership from '@/lib/membership';
import * as menu from '@/lib/menu';
import * as pricingMode from '@/lib/pricingMode';
import * as payments from '@/lib/payments';
import * as pricing from '@/lib/pricing';
import * as discountTarget from '@/lib/discountTarget';
import * as benefits from '@/lib/benefits';
import * as cartWire from '@/lib/cartWire';
import * as reporting from '@/lib/reporting';
import * as ticketPricing from '@/components/admin/tickets/ticketPricing';
import * as memberLabels from '@/components/admin/members/memberLabels';
import * as benefitSummary from '@/components/admin/staff-benefits/summary';
import {
  countTierUsage,
  getDefaultTier,
  recordMerchStockAdjustment,
  getAllSalesForReporting,
  getAllFnbOrdersForReporting,
  getAllMerchOrdersForReporting,
  getAllEventsForReporting,
  getMockWristbands,
  getInventory,
} from '@/mockApi';

const api = {
  platform,
  menu: menuApi,
  catalogBridge,
  analyticsReports: analyticsReports.analyticsReportsApi,
  benefits: benefitsApi.benefitsApi,
  stock,
  events,
  checkin,
  wallet,
  voucherPromotions: voucherPromotions.voucherPromotionsApi,
};
const domain = {
  membership, menu, pricingMode, payments, pricing, discountTarget, benefits,
  cartWire, reporting, ticketPricing, memberLabels, benefitSummary,
};
const legacy = {
  countTierUsage, getDefaultTier, recordMerchStockAdjustment,
  getAllSalesForReporting, getAllFnbOrdersForReporting, getAllMerchOrdersForReporting,
  getAllEventsForReporting, getMockWristbands, getInventory,
};

/** Bind the existing POS providers to the shared screens without another store. */
export function AdminScreenHost({ children }: { children: ReactNode }) {
  const catalog = useCatalogStore();
  const { operator, can } = useOperator();
  const branch = useBranch();
  const { station } = useStation();
  const language = useLanguage();
  const search = useSearch();
  const [, navigate] = useLocation();
  return (
    <AdminScreenProvider value={{
      catalog, reads, session: { operator, can }, branch, station: { station },
      transport: adminScreenApi, api, domain, legacy, toast, language,
      navigation: { search, navigate },
    }}>
      {children}
    </AdminScreenProvider>
  );
}
