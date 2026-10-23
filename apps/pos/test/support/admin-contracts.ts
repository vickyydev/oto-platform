/** Native Admin contracts exercised by retained POS parity/transport regressions. */
import { adminScreenApi } from '@/api/admin-screen-api';
import { createBenefitsAdminApi } from '../../../../packages/admin-screens/src/lifted/api/benefits';
import { createAnalyticsReportsApi } from '../../../../packages/admin-screens/src/lifted/api/analyticsReports';
import { createVoucherPromotionsApi } from '../../../../packages/admin-screens/src/lifted/api/voucherPromotions';
export { inForceOn, profileFromApi, profileToApi, sameProfile } from '../../../../packages/admin-screens/src/lifted/api/benefits';
export const benefitsApi = createBenefitsAdminApi(adminScreenApi);
export const analyticsReportsApi = createAnalyticsReportsApi(adminScreenApi);
export const voucherPromotionsApi = createVoucherPromotionsApi(adminScreenApi);
import { createMenuCatalogueApi } from '../../../../packages/admin-screens/src/lifted/api/menu';
import { createWalletAdminApi } from '../../../../packages/admin-screens/src/lifted/api/wallet';
export const { merchItemToApiBody, apiProductToAddOn, apiProductToMerchItem, catalogueSizesOf, isSocksAddOnId, mapMenu } = createMenuCatalogueApi(adminScreenApi);
export type { ApiProduct } from '../../../../packages/admin-screens/src/lifted/api/menu';
export const { reactivateWallet } = createWalletAdminApi(adminScreenApi);
