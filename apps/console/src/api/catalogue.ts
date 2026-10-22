import { createCatalogueAdminApi } from '@oto/admin-screens/lifted/api/platform';
import { createMenuCatalogueApi } from '@oto/admin-screens/lifted/api/menu';
import { api } from './client';

export const catalogueApi = createCatalogueAdminApi(api);

/** One mapper cache per park snapshot keeps hidden product fields with their owner. */
export function createCatalogueMenu() {
  const { menuApi, mapMenu, addOnToApiBody } = createMenuCatalogueApi(api);
  return { menuApi, mapMenu, addOnToApiBody };
}
