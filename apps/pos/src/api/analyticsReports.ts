import { createAnalyticsReportsApi } from '@oto/admin-screens/lifted/api/analyticsReports';
import { adminScreenApi } from './admin-screen-api';
export type * from '@oto/admin-screens/lifted/api/analyticsReports';

export const analyticsReportsApi = createAnalyticsReportsApi(adminScreenApi);
