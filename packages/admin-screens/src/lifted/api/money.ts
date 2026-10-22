import type { ApiResponse } from '@oto/api-types';
import type { AdminApi } from '../../api/admin-api';
import type { PaymentMethod } from '../model/types';
import { idemKey } from './client';
import { createEventsAdminApi } from './events';
import { apiPackageToTicketType } from './mappers';
import { createMenuCatalogueApi } from './menu';
import { createCatalogueAdminApi, type ApiPaymentMethod } from './platform';
import { createVoucherPromotionsApi } from './voucherPromotions';

function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value !== null && typeof value === 'object') return '{' + Object.entries(value)
    .filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => JSON.stringify(key) + ':' + canonical(item)).join(',') + '}';
  return JSON.stringify(value) ?? 'undefined';
}

/** A snapshot owns retry identity until its canonical read replaces it. */
export function createMoneyAdminApi(transport: AdminApi & { href: (path: string) => string }) {
  const pending = new Map<string, string>();
  const options = (method: string, path: string, body: unknown, supplied?: { idempotencyKey?: string }) => {
    const operation = method + ':' + path + ':' + canonical(body);
    const idempotencyKey = pending.get(operation) ?? supplied?.idempotencyKey ?? idemKey();
    pending.set(operation, idempotencyKey);
    return { idempotencyKey };
  };
  const api: AdminApi = {
    get: path => transport.get(path),
    post: (path, body, supplied) => transport.post(path, body, options('POST', path, body, supplied)),
    patch: (path, body, supplied) => transport.patch(path, body, options('PATCH', path, body, supplied)),
    put: (path, body, supplied) => transport.put(path, body, options('PUT', path, body, supplied)),
    delete: (path, supplied) => transport.delete(path, options('DELETE', path, undefined, supplied)),
  };
  const catalogApi = createCatalogueAdminApi(api);
  const menu = createMenuCatalogueApi(api);
  const { eventsApi } = createEventsAdminApi(api);
  const voucherPromotionsApi = createVoucherPromotionsApi({ ...api, href: transport.href });
  const mapPaymentMethods = (methods: ApiPaymentMethod[]): PaymentMethod[] => methods.map(method => ({
    id: method.id, label: method.label, kind: method.kind, enabled: method.enabled, sortOrder: method.sortOrder,
  }));
  const saveTender = async (method: PaymentMethod, existing: boolean) => {
    if (existing) await catalogApi.updatePaymentMethod(method.id, {
      label: method.label, kind: method.kind, enabled: method.enabled, sortOrder: method.sortOrder,
    });
    else await catalogApi.createPaymentMethod({
      code: method.id, label: method.label, kind: method.kind, sortOrder: method.sortOrder,
    });
  };
  return { catalogApi, menu, eventsApi, voucherPromotionsApi, saveDiscount: menu.saveDiscount, saveTender,
    mapPaymentMethods, apiPackageToTicketType,
    voucherLinkOptions: () => api.get<ApiResponse<'/voucher-definitions/link-options', 'get'>>('/voucher-definitions/link-options'),
  };
}
