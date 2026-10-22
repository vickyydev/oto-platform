import type { ApiResponse } from '@oto/api-types';
import type {StockAttentionView, StockCostOfGoods, StockItemBody, StockPlaceOpening, StockReports} from '@oto/shared';
import type { InventoryItem,StockLocation,PurchaseOrder,MerchItem } from '../model/types';
import type { LiftedAdminApi } from '../../api/lifted-api';
import {idemKey,isApiError} from './client';


// =====================================================================================
// S2-14b round 2 — THE STOCK MODULE ON THE PLATFORM (plan §2.3).
//
// The mobile Stock module and the admin Inventory panels were ported from the
// prototype on its in-memory inventory (`store/catalogStore.ts`, `mockApi.ts`).
// They read and write the platform now, through this one store, in the
// prototype's own shapes so every screen keeps its exact look:
//
//   - an `InventoryItem` is one stocked thing with its sizes: the platform keeps
//     one stock item per size, and the sizes that share a `groupId` are one
//     item here. Each size's `InventoryVariant.id` IS its platform stock item
//     id, so every write names exactly the size on screen;
//   - `stockByLocation` holds every live place (0 where nothing is), which is
//     what the overview's location filter and the transfer flow read;
//   - a `PurchaseOrder`'s lines point back at that item and size.
//
// Every write goes to the platform with an idempotency key, then the module and
// the till's sellable counts are read back, so the screen shows what the
// database holds — never an edit that did not land.
// =====================================================================================

export interface StockModuleState {
  /** The platform branch these figures are for. */
  branchId: string | null;
  loaded: boolean;
  /** Why the last read failed, in words for the screen; null when it did not. */
  error: string | null;
  /** Every stocked item, retired ones included (`active === false`). */
  inventory: InventoryItem[];
  /** Every place, retired ones included. */
  locations: StockLocation[];
  orders: PurchaseOrder[];
  attention: StockAttentionView[];
  /**
   * Each item's reorder point TODAY by the platform's rule (item id → point;
   * null while it has none) — the trend point once the item has the sales
   * history, else the one set in Admin Inventory. "Low" is judged on it, as
   * the Alerts tab's rows are.
   */
  reorderPointNow: Record<string, number | null>;
}
export interface StockModuleHooks {
  useStockModule: (branchApiId:string|null|undefined) => StockModuleState & {reload:()=>Promise<void>};
  merchItemsWithStock: () => MerchItem[];
  refreshSellableStock: () => Promise<void>;
  useSellableStockVersion: () => number;
}


/**
 * The admin form's item as the platform's body. A size keeps its stock item id
 * when it already exists on the platform. Only a new item sends starting stock,
 * which the platform records as an audited movement rather than a level overwrite.
 */
export function inventoryItemToStockBody(
  item: InventoryItem,
  opts: { existingSizeIds: ReadonlySet<string>; productSized: boolean; newItem?: boolean },
): StockItemBody {
  const rs = item.reorderSettings;
  return {
    name: item.name,
    sku: item.sku ?? null,
    category: item.category ?? null,
    active: item.active !== false,
    productId: item.linkedId ? item.linkedId : null,
    unitCostSatang: item.unitCostTHB != null ? Math.round(item.unitCostTHB * 100) : null,
    reorder: rs
      ? {
          reorderPoint: rs.reorderPoint,
          reorderQuantity: rs.reorderQty,
          leadTimeDays: rs.leadTimeDays,
          supplierName: rs.supplierName,
          supplierContact: rs.supplierContact ?? null,
        }
      : null,
    units: (item.units ?? []).map((u) => ({ label: u.label, eaches: u.eaches })),
    photoUrl: item.photoUrl ?? null,
    showPhotoInPos: item.showPhotoInPos ?? false,
    sizes: item.variants.map((v) => ({
      ...(opts.existingSizeIds.has(v.id) ? { stockItemId: v.id } : {}),
      variantId: opts.productSized && v.productVariantRef ? v.productVariantRef : null,
      label: v.label,
      ...(opts.newItem ? { startingStock: v.stock } : {}),
      sku: v.sku ?? null,
      lowStockThreshold: v.lowStockThreshold ?? null,
      parByLocation: v.parByLocation ?? {},
    })),
  };
}


/** The platform's refusal in its own words, or what happened on the way. */
export function stockErrorWords(err: unknown): string {
  if (isApiError(err)) return err.message;
  return 'The platform could not be reached — nothing was saved. Check the connection and try again.';
}
export interface StockWritePorts { writeThenRead:<T>(branchId:string,write:()=>Promise<T>)=>Promise<T>; }
export function createStockAdminApi(api: LiftedAdminApi,{writeThenRead}:StockWritePorts) {


const stockBase = (branchId: string) => `/branches/${branchId}/stock`;

const once = () => ({ idempotencyKey: idemKey() });


/**
 * The stock module's writes. Each refusal is the platform's, in the counter's
 * words (`ApiError.message`; `stockErrorWords` for the screen).
 */
const stockApi = {
  transfer: (branchId: string, body: { fromLocationId: string; toLocationId: string; lines: Array<{ stockItemId: string; quantity: number }> }) =>
    writeThenRead(branchId, () => api.post<ApiResponse<'/branches/{branchId}/stock/transfers', 'post'>>(`${stockBase(branchId)}/transfers`, body, once())),

  receive: (branchId: string, body: { stockItemId: string; locationId: string; quantity: number; reason: string }) =>
    writeThenRead(branchId, () => api.post<ApiResponse<'/branches/{branchId}/stock/receipts', 'post'>>(`${stockBase(branchId)}/receipts`, body, once())),

  receiveOrderLine: (branchId: string, orderId: string, lineId: string, body: { quantity: number; locationId: string }) =>
    writeThenRead(branchId, () =>
      api.post<ApiResponse<'/branches/{branchId}/stock/purchase-orders/{orderId}/lines/{lineId}/receive', 'post'>>(
        `${stockBase(branchId)}/purchase-orders/${orderId}/lines/${lineId}/receive`,
        body,
        once(),
      ),
    ),

  addToOrders: (branchId: string, lines: Array<{ stockItemId: string; quantity: number }>) =>
    writeThenRead(branchId, () =>
      api.post<ApiResponse<'/branches/{branchId}/stock/purchase-orders/lines', 'post'>>(`${stockBase(branchId)}/purchase-orders/lines`, { lines }, once()),
    ),

  setOrderLineQuantity: (branchId: string, orderId: string, lineId: string, quantity: number) =>
    writeThenRead(branchId, () =>
      api.patch(`${stockBase(branchId)}/purchase-orders/${orderId}/lines/${lineId}`, { quantity }, once()),
    ),

  removeOrderLine: (branchId: string, orderId: string, lineId: string) =>
    writeThenRead(branchId, () =>
      api.delete(`${stockBase(branchId)}/purchase-orders/${orderId}/lines/${lineId}`, once()),
    ),

  markOrdered: (branchId: string, orderId: string, body: { expectedArrivalDate?: string; notes?: string }) =>
    writeThenRead(branchId, () => api.post(`${stockBase(branchId)}/purchase-orders/${orderId}/ordered`, body, once())),

  commitStockTake: (branchId: string, lines: Array<{ stockItemId: string; locationId: string; countedQuantity: number }>) =>
    writeThenRead(branchId, () => api.post<ApiResponse<'/branches/{branchId}/stock/stock-takes', 'post'>>(`${stockBase(branchId)}/stock-takes`, { lines }, once())),

  adjust: (branchId: string, body: { stockItemId: string; locationId?: string; delta: number; reason: string }) =>
    writeThenRead(branchId, () => api.post<ApiResponse<'/branches/{branchId}/stock/adjustments', 'post'>>(`${stockBase(branchId)}/adjustments`, body, once())),

  createLocation: (branchId: string, body: { name: string; type: StockLocation['type'] }) =>
    writeThenRead(branchId, () => api.post<ApiResponse<'/branches/{branchId}/stock/locations', 'post'>>(`${stockBase(branchId)}/locations`, body, once())),

  updateLocation: (branchId: string, locationId: string, patch: { name?: string; type?: StockLocation['type']; active?: boolean }) =>
    writeThenRead(branchId, () =>
      api.patch<ApiResponse<'/branches/{branchId}/stock/locations/{locationId}', 'patch'>>(`${stockBase(branchId)}/locations/${locationId}`, patch, once()),
    ),

  setSellPoint: (branchId: string, locationId: string) =>
    writeThenRead(branchId, () =>
      api.post<ApiResponse<'/branches/{branchId}/stock/locations/{locationId}/sell-point', 'post'>>(`${stockBase(branchId)}/locations/${locationId}/sell-point`, undefined, once()),
    ),

  saveItem: (branchId: string, groupId: string | null, body: StockItemBody, actionId = idemKey()) =>
    writeThenRead(branchId, () =>
      groupId
        ? api.put<ApiResponse<'/branches/{branchId}/stock/items/{groupId}', 'put'>>(`${stockBase(branchId)}/items/${groupId}`, body, { idempotencyKey: actionId })
        : api.post<ApiResponse<'/branches/{branchId}/stock/items', 'post'>>(`${stockBase(branchId)}/items`, body, { idempotencyKey: actionId }),
    ),

  resolveAttention: (branchId: string, attentionId: string) =>
    writeThenRead(branchId, () => api.post(`${stockBase(branchId)}/attention/${attentionId}/resolve`, undefined, once())),
};


// =====================================================================================
// S2-14b round 4 — THE REPORTS, FROM THE LEDGER (plan §2.5).
//
// The Reports tab of the stock module used to read the prototype's session log
// and two mocked lists (Usage, Shrinkage). It reads the platform's ledger now:
// `GET /branches/:branchId/stock/reports` answers all five over a range of
// business dates, every figure adding up to the movements it names, costs only
// to a manager. The profitability report's cost of goods reads
// `/stock/reports/cost-of-goods`: the cost frozen on each sale line.
// =====================================================================================

/**
 * Whether each place has had its opening count (stock walkthrough F2): the
 * count's review screen asks before the commit, so a place's first count is
 * described as what the platform records it as — its opening, flagging nothing.
 */
async function fetchPlaceOpenings(branchId: string): Promise<StockPlaceOpening[]> {
  return (await api.get<ApiResponse<'/branches/{branchId}/stock/openings', 'get'>>(`${stockBase(branchId)}/openings`)).places;
}


/** The five stock reports over inclusive business dates. */
function fetchStockReports(branchId: string, from: string, to: string): Promise<StockReports> {
  const q = new URLSearchParams({ from, to });
  return api.get<ApiResponse<'/branches/{branchId}/stock/reports', 'get'>>(`${stockBase(branchId)}/reports?${q.toString()}`);
}


/** Cost of goods per product over inclusive business dates, at the cost frozen on each sale line. */
function fetchCostOfGoods(branchId: string, from: string, to: string): Promise<StockCostOfGoods> {
  const q = new URLSearchParams({ from, to });
  return api.get<ApiResponse<'/branches/{branchId}/stock/reports/cost-of-goods', 'get'>>(`${stockBase(branchId)}/reports/cost-of-goods?${q.toString()}`);
}
return {stockApi,fetchPlaceOpenings,fetchStockReports,fetchCostOfGoods,inventoryItemToStockBody,stockErrorWords};
}
