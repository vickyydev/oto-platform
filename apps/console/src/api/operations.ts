import type { ApiResponse } from '@oto/api-types';
import type { LiftedAdminApi } from '@oto/admin-screens';
import { createPlatformAdminApi, createCatalogueAdminApi } from '@oto/admin-screens/lifted/api/platform';
import { createMenuCatalogueApi } from '@oto/admin-screens/lifted/api/menu';
import { createStockAdminApi } from '@oto/admin-screens/lifted/api/stock';
import { createWalletAdminApi } from '@oto/admin-screens/lifted/api/wallet';
import { api, apiUrl } from './client';

/** Existing native calls keep their contracts; every awaited seam owns one current host. */
export function createOperationsApi(isCurrent: () => boolean, afterStockWrite: (branchId: string) => Promise<void>) {
  const assertCurrent = () => { if (!isCurrent()) throw new Error('The signed-in account or park changed. Reopen this page.'); };
  const scoped = <F extends (...args: never[]) => Promise<unknown>>(fn: F): F =>
    (async (...args: Parameters<F>) => {
      assertCurrent();
      const answer: unknown = await Reflect.apply(fn, undefined, args);
      assertCurrent();
      return answer;
    }) as F;
  const transport: LiftedAdminApi = { href: apiUrl,
    get: scoped(api.get), post: scoped(api.post), patch: scoped(api.patch), put: scoped(api.put),
    delete: scoped(api.delete), deleteWithBody: scoped(api.deleteWithBody),
    getBlob: scoped(api.getBlob), postBlob: scoped(api.postBlob), getFile: scoped(api.getFile),
  };
  const { membersApi } = createPlatformAdminApi(transport);
  const walletApi = createWalletAdminApi(transport);
  const menu = createMenuCatalogueApi(transport);
  const { tiers } = createCatalogueAdminApi(transport);
  const { stockApi } = createStockAdminApi(transport, { writeThenRead: async (branchId, write) => {
    assertCurrent(); const answer = await write(); assertCurrent();
    await afterStockWrite(branchId); assertCurrent(); return answer;
  } });
  return { membersApi, walletApi, menu, tiers, stockApi,
    stockLevels: (branchId: string) => transport.get<ApiResponse<'/branches/{branchId}/stock/levels', 'get'>>(`/branches/${branchId}/stock/levels`),
    stockLocations: (branchId: string) => transport.get<ApiResponse<'/branches/{branchId}/stock/locations', 'get'>>(`/branches/${branchId}/stock/locations?all=true`),
    sellableStock: (branchId: string) => transport.get<ApiResponse<'/branches/{branchId}/stock/sellable', 'get'>>(`/branches/${branchId}/stock/sellable`),
  };
}
