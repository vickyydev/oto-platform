import { createMenuApi } from '@oto/admin-screens/lifted/api/menu';
import type { ApiResponse } from '@oto/api-types';
import { api } from './client';

/** One canonical mapper cache and the real file capability per page snapshot. */
export const createConsoleMenu = () => createMenuApi(api);
export const readMenuStock = (branchId: string) =>
  api.get<ApiResponse<'/branches/{branchId}/stock/sellable', 'get'>>(`/branches/${branchId}/stock/sellable`);
