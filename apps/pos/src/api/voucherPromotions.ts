import { createVoucherPromotionsApi } from '@oto/admin-screens/lifted/api/voucherPromotions';
import { adminScreenApi } from './admin-screen-api';
export type * from '@oto/admin-screens/lifted/api/voucherPromotions';

export const voucherPromotionsApi = createVoucherPromotionsApi(adminScreenApi);
