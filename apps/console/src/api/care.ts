import { createCareAdminApi } from '@oto/admin-screens/lifted/api/care';
import { createBenefitsAdminApi } from '@oto/admin-screens/lifted/api/benefits';
import type { LiftedAdminApi } from '@oto/admin-screens';
import { api, apiUrl } from './client';

const transport: LiftedAdminApi = {
  ...api, href: apiUrl,
};

export const createConsoleCare = () => createCareAdminApi(transport);
export const createConsoleBenefits = () => createBenefitsAdminApi(transport);
