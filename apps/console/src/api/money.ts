import { createMoneyAdminApi } from '@oto/admin-screens/lifted/api/money';
import { api, apiUrl } from './client';

export const createConsoleMoney = () => createMoneyAdminApi({ ...api, href: apiUrl });
