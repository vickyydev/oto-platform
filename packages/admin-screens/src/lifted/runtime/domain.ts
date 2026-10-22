import type { CatalogReaders, LegacyPorts } from '../model/ports';
import { createMembershipHelpers } from '../lib/membership';
import { createMenuHelpers } from '../lib/menu';
import { createPricingModeHelpers } from '../lib/pricingMode';
import { createPaymentsHelpers } from '../lib/payments';
import { createPricingHelpers } from '../lib/pricing';
import { createDiscountTargetHelpers } from '../lib/discountTarget';
import { createBenefitsHelpers } from '../lib/benefits';
import { createCartWireHelpers } from '../lib/cartWire';
import { createReportingHelpers } from '../lib/reporting';
import { createTicketPricingHelpers } from '../components/admin/tickets/ticketPricing';
import { createMemberLabelsHelpers } from '../components/admin/members/memberLabels';
import { createBenefitSummaryHelpers } from '../components/admin/staff-benefits/summary';

export function createAdminDomain(ports: {
  catalog: CatalogReaders;
  legacy: LegacyPorts;
  wallet: ReturnType<typeof import('../api/wallet').createWalletAdminApi>;
  stock: ReturnType<typeof import('../api/stock').createStockAdminApi>;
}) {
  const { catalog, legacy, wallet, stock } = ports;
  const membership = createMembershipHelpers({ catalog });
  const menu = createMenuHelpers({ catalog });
  const pricingMode = createPricingModeHelpers({ catalog });
  const payments = createPaymentsHelpers({ catalog });
  const pricing = createPricingHelpers({ catalog, membership, pricingMode });
  const discountTarget = createDiscountTargetHelpers({ catalog, pricing });
  const benefits = createBenefitsHelpers({ catalog, discountTarget });
  const cartWire = createCartWireHelpers({ catalog, menu, pricingMode });
  const reporting = createReportingHelpers({ catalog, legacy, cartWire, pricingMode, wallet, stock });
  const ticketPricing = createTicketPricingHelpers({ catalog, membership, pricingMode });
  const memberLabels = createMemberLabelsHelpers({ catalog });
  const benefitSummary = createBenefitSummaryHelpers({ benefits, discountTarget });
  return { membership, menu, pricingMode, payments, pricing, discountTarget, benefits, cartWire, reporting, ticketPricing, memberLabels, benefitSummary };
}

export type AdminDomain = ReturnType<typeof createAdminDomain>;
