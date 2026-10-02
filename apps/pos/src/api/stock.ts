// S2-14b round 1 — what the platform says each shelf holds, for the selling
// screens (plan docs/progress/plans/stock/PLAN.md §2.2).
//
// The till's grids, size pickers and its stock guard used to read the ported
// prototype's in-memory inventory (`store/catalogStore.ts:getInventoryItem`),
// which a refresh reset and no other till could see. They read this now: the
// platform's `GET /branches/:branchId/stock/sellable`, cached here, in the
// prototype's own `InventoryItem` shape so every screen keeps its exact
// rendering path. A product the platform tracks is keyed by its own id — the
// catalogue mappers (`api/menu.ts`) put that id in `inventoryItemId` — and the
// mock inventory is still the answer for a deployment with no platform menu.
//
// It is a READ. The platform's guard at commit is the rule ("Only 3 Grip Socks
// S left") and its decrement at finalise is the count; this exists so the till
// does not offer what is not there, and it is refreshed after every sale the
// till closes.

import { useEffect, useSyncExternalStore } from 'react';
import type {
  PurchaseOrderView,
  SellableStock,
  SellableStockProduct,
  StockAdjustResult,
  StockAttentionView,
  StockCostOfGoods,
  StockItemBody,
  StockLevels,
  StockLocationView,
  StockPlaceOpening,
  StockPlaceOpenings,
  StockReceiveResult,
  StockReports,
  StockTakeResult,
  StockTransferResult,
} from '@oto/shared';
import { getInventoryItem } from '@/store/catalogStore';
import {
  INVENTORY_DEFAULT_VARIANT_ID,
  type InventoryItem,
  type InventoryVariant,
  type MerchItem,
  type PurchaseOrder,
  type StockLocation,
} from '@/types';
import { api, ApiError, idemKey, isMissingRoute } from './client';

let branchId: string | null = null;
let byProduct = new Map<string, SellableStockProduct>();
let version = 0;
const listeners = new Set<() => void>();

function publish(): void {
  version += 1;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * Pull the branch's stock. Non-fatal, as the menu is: a deployment whose api
 * predates the route keeps the ported inventory, and a fault leaves the last
 * answer on screen rather than an empty one. Answers whether the platform's
 * figures are now on screen.
 */
export async function loadSellableStock(forBranchId: string): Promise<boolean> {
  try {
    const answer = await api.get<SellableStock>(`/branches/${forBranchId}/stock/sellable`);
    branchId = forBranchId;
    byProduct = new Map(answer.products.map((p) => [p.productId, p]));
    publish();
    return true;
  } catch (err) {
    if (isMissingRoute(err)) return false;
    // Not this screen's to fail: the guard at commit still holds the line.
    return false;
  }
}

/** Read the branch's stock again — after a sale closes, so the grid shows what is left. */
export async function refreshSellableStock(): Promise<void> {
  if (branchId) await loadSellableStock(branchId);
}

/** True once the platform has answered for this branch. */
export const stockIsServerBacked = (): boolean => branchId !== null;

/** Re-render when the platform's figures change. Returns a number that moves with them. */
export function useSellableStockVersion(): number {
  return useSyncExternalStore(subscribe, () => version);
}

/** A tracked product as the prototype's screens read an inventory item. */
function asInventoryItem(p: SellableStockProduct): InventoryItem {
  return {
    id: p.productId,
    name: p.name,
    // Display only — no screen branches on it for a platform row.
    linkedKind: 'merch',
    linkedId: p.productId,
    variants: p.sizes.map((s) => ({
      id: s.variantId ?? INVENTORY_DEFAULT_VARIANT_ID,
      label: s.label ?? 'Default',
      // Everything the branch holds: the sale cascades past the counter shelf.
      stock: s.available,
      ...(s.lowStockThreshold !== null ? { lowStockThreshold: s.lowStockThreshold } : {}),
    })),
  };
}

/**
 * THE ONE READ the selling screens use for "how many are there": the
 * platform's answer for a product it tracks, else the ported inventory's
 * (a deployment with no platform menu), else nothing — untracked.
 */
export function inventoryFor(inventoryItemId: string | undefined | null): InventoryItem | undefined {
  if (!inventoryItemId) return undefined;
  const platform = byProduct.get(inventoryItemId);
  if (platform) return asInventoryItem(platform);
  // A platform product the platform does not track has no stock to read.
  if (branchId !== null && !inventoryItemId.startsWith('inv-')) return undefined;
  return getInventoryItem(inventoryItemId);
}

/**
 * A shop item with the platform's figures on it — `stock` and
 * `lowStockThreshold`, which the grid and its clamps read. One size: that
 * size's. In sizes: everything across them (the tile is out only when every
 * size is), with each size's own count in the picker.
 */
export function withPlatformStock(item: MerchItem): MerchItem {
  const p = item.inventoryItemId ? byProduct.get(item.inventoryItemId) : undefined;
  if (!p) return item;
  const total = p.sizes.reduce((sum, s) => sum + s.available, 0);
  const one = p.sizes.length === 1 ? p.sizes[0] : undefined;
  const next: MerchItem = { ...item, stock: total };
  delete next.lowStockThreshold;
  if (one && one.lowStockThreshold !== null) next.lowStockThreshold = one.lowStockThreshold;
  return next;
}

/** One size the station header's strip names: out of stock, or at or below its threshold. */
export interface SellableRestockAlert {
  name: string;
  /** The size's label, when the product is sold in more than one. */
  sizeLabel: string | null;
  status: 'out' | 'low';
}

/**
 * S2-14b round 2 — THE STRIP'S READ ("N out · N low", on every staff surface):
 * every size the platform tracks at this branch that is out or low, out first —
 * the prototype's `getRestockAlerts`, on the platform's counts, not the seed's.
 * Empty until the platform has answered: a strip of guessed figures is worse
 * than none.
 */
export function sellableRestockAlerts(): SellableRestockAlert[] {
  const alerts: SellableRestockAlert[] = [];
  for (const p of byProduct.values()) {
    for (const s of p.sizes) {
      if (s.status === 'ok') continue;
      alerts.push({ name: p.name, sizeLabel: p.sizes.length > 1 ? s.label : null, status: s.status });
    }
  }
  return alerts.sort((a, b) => (a.status === b.status ? a.name.localeCompare(b.name) : a.status === 'out' ? -1 : 1));
}

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

const EMPTY_MODULE: StockModuleState = {
  branchId: null,
  loaded: false,
  error: null,
  inventory: [],
  locations: [],
  orders: [],
  attention: [],
  reorderPointNow: {},
};

let moduleState: StockModuleState = EMPTY_MODULE;
const moduleListeners = new Set<() => void>();

function setModule(next: StockModuleState): void {
  moduleState = next;
  for (const listener of moduleListeners) listener();
}

function subscribeModule(listener: () => void): () => void {
  moduleListeners.add(listener);
  return () => moduleListeners.delete(listener);
}

/** The platform's refusal in its own words, or what happened on the way. */
export function stockErrorWords(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  return 'The platform could not be reached — nothing was saved. Check the connection and try again.';
}

type LevelItem = StockLevels['items'][number];

const linkedKindOf = (kind: string | null): InventoryItem['linkedKind'] =>
  kind === 'addon' || kind === 'menu' ? kind : 'merch';

/** The platform's levels as the prototype's inventory: one item per group, one variant per size. */
export function levelsToInventory(levels: StockLevels): InventoryItem[] {
  const live = levels.locations.map((l) => l.id);
  const groups = new Map<string, LevelItem[]>();
  for (const row of levels.items) groups.set(row.groupId, [...(groups.get(row.groupId) ?? []), row]);
  const out: InventoryItem[] = [];
  for (const [groupId, sizes] of groups) {
    const first = sizes[0]!;
    // Sizes in the catalogue's order (S, M, L) where the till knows it.
    const order = first.productId ? byProduct.get(first.productId)?.sizes.map((s) => s.stockItemId) : undefined;
    if (order) {
      const rank = (id: string) => {
        const at = order.indexOf(id);
        return at < 0 ? order.length : at;
      };
      sizes.sort((a, b) => rank(a.id) - rank(b.id));
    }
    const variants: InventoryVariant[] = sizes.map((s) => ({
      id: s.id,
      label: s.variantLabel ?? 'Default',
      ...(s.sku ? { sku: s.sku } : {}),
      ...(s.variantId ? { productVariantRef: s.variantId } : {}),
      stock: s.total,
      ...(s.lowStockThreshold !== null ? { lowStockThreshold: s.lowStockThreshold } : {}),
      stockByLocation: Object.fromEntries(live.map((id) => [id, s.byLocation[id] ?? 0])),
      ...(Object.keys(s.parByLocation).length > 0 ? { parByLocation: { ...s.parByLocation } } : {}),
    }));
    out.push({
      id: groupId,
      name: first.name,
      ...(first.itemSku ? { sku: first.itemSku } : {}),
      ...(first.category ? { category: first.category } : {}),
      active: sizes.some((s) => s.active),
      linkedKind: linkedKindOf(first.productKind),
      linkedId: first.productId ?? '',
      variants,
      branchId: levels.branchId,
      ...(first.units.length > 0 ? { units: first.units.map((u) => ({ id: u.code, label: u.label, eaches: u.eaches })) } : {}),
      ...(first.photoUrl ? { photoUrl: first.photoUrl, showPhotoInPos: first.showPhotoInPos } : {}),
      ...(first.reorderPoint !== null && first.supplierName
        ? {
            reorderSettings: {
              reorderPoint: first.reorderPoint,
              leadTimeDays: first.leadTimeDays ?? 1,
              supplierName: first.supplierName,
              ...(first.supplierContact ? { supplierContact: first.supplierContact } : {}),
              reorderQty: first.reorderQuantity ?? 1,
            },
          }
        : {}),
      ...(first.unitCostSatang !== null ? { unitCostTHB: first.unitCostSatang / 100 } : {}),
    });
  }
  return out;
}

const toLocation = (l: StockLocationView): StockLocation => ({
  id: l.id,
  name: l.name,
  type: l.type,
  ...(l.sellPoint ? { sellPoint: true } : {}),
  active: l.active,
});

/** A platform order as the prototype's, its lines pointing back at the item and size on screen. */
function toPurchaseOrder(o: PurchaseOrderView, groupOf: Map<string, string>): PurchaseOrder {
  return {
    id: o.id,
    branchId: o.branchId,
    supplierName: o.supplierName,
    ...(o.supplierContact ? { supplierContact: o.supplierContact } : {}),
    state: o.state,
    lines: o.lines.map((l) => ({
      id: l.id,
      inventoryItemId: groupOf.get(l.stockItemId) ?? l.stockItemId,
      variantId: l.stockItemId,
      itemName: l.itemName,
      variantLabel: l.variantLabel ?? 'Default',
      orderedQty: l.orderedQuantity,
      receivedQty: l.receivedQuantity,
    })),
    createdAt: o.createdAt,
    createdBy: o.createdBy ?? 'Staff',
    createdById: '',
    ...(o.orderedAt ? { orderedAt: o.orderedAt, orderedBy: o.orderedBy ?? 'Staff', orderedById: '' } : {}),
    ...(o.expectedArrivalDate ? { expectedArrivalDate: o.expectedArrivalDate } : {}),
    ...(o.receivedAt ? { receivedAt: o.receivedAt, receivedBy: o.receivedBy ?? 'Staff', receivedById: '' } : {}),
    ...(o.notes ? { notes: o.notes } : {}),
  };
}

/** Read the branch's whole stock module: levels, places, orders and what needs a person. */
export async function loadStockModule(forBranchId: string): Promise<void> {
  try {
    const base = `/branches/${forBranchId}/stock`;
    const [levels, places, orders, attention] = await Promise.all([
      api.get<StockLevels>(`${base}/levels`),
      api.get<{ locations: StockLocationView[] }>(`${base}/locations?all=true`),
      api.get<{ orders: PurchaseOrderView[] }>(`${base}/purchase-orders`),
      api.get<{ attention: StockAttentionView[] }>(`${base}/attention`),
    ]);
    const groupOf = new Map(levels.items.map((i) => [i.id, i.groupId]));
    setModule({
      branchId: forBranchId,
      loaded: true,
      error: null,
      inventory: levelsToInventory(levels),
      locations: places.locations.map(toLocation),
      orders: orders.orders.map((o) => toPurchaseOrder(o, groupOf)),
      attention: attention.attention,
      reorderPointNow: Object.fromEntries(levels.items.map((i) => [i.groupId, i.reorderPointNow])),
    });
  } catch (err) {
    // The last answer stays on screen for the same branch; the error says why it may be stale.
    const same = moduleState.branchId === forBranchId;
    setModule({ ...(same ? moduleState : EMPTY_MODULE), branchId: forBranchId, error: stockErrorWords(err) });
  }
}

/**
 * THE ONE READ the stock screens use. Loads the branch's module when the branch
 * changes; re-renders whenever any write here reads it back.
 */
export function useStockModule(branchApiId: string | null | undefined): StockModuleState & { reload: () => Promise<void> } {
  const state = useSyncExternalStore(subscribeModule, () => moduleState);
  useEffect(() => {
    if (branchApiId) void loadStockModule(branchApiId);
  }, [branchApiId]);
  const current = branchApiId && state.branchId === branchApiId ? state : EMPTY_MODULE;
  return {
    ...current,
    reload: () => (branchApiId ? loadStockModule(branchApiId) : Promise.resolve()),
  };
}

/** Write, then read the module and the till's counts back. */
async function writeThenRead<T>(branchId: string, write: () => Promise<T>): Promise<T> {
  const result = await write();
  await Promise.all([loadStockModule(branchId), refreshSellableStock()]);
  return result;
}

const stockBase = (branchId: string) => `/branches/${branchId}/stock`;
const once = () => ({ idempotencyKey: idemKey() });

/**
 * The stock module's writes. Each refusal is the platform's, in the counter's
 * words (`ApiError.message`; `stockErrorWords` for the screen).
 */
export const stockApi = {
  transfer: (branchId: string, body: { fromLocationId: string; toLocationId: string; lines: Array<{ stockItemId: string; quantity: number }> }) =>
    writeThenRead(branchId, () => api.post<StockTransferResult>(`${stockBase(branchId)}/transfers`, body, once())),

  receive: (branchId: string, body: { stockItemId: string; locationId: string; quantity: number; reason: string }) =>
    writeThenRead(branchId, () => api.post<StockReceiveResult>(`${stockBase(branchId)}/receipts`, body, once())),

  receiveOrderLine: (branchId: string, orderId: string, lineId: string, body: { quantity: number; locationId: string }) =>
    writeThenRead(branchId, () =>
      api.post<{ order: PurchaseOrderView; requested: number; received: number }>(
        `${stockBase(branchId)}/purchase-orders/${orderId}/lines/${lineId}/receive`,
        body,
        once(),
      ),
    ),

  addToOrders: (branchId: string, lines: Array<{ stockItemId: string; quantity: number }>) =>
    writeThenRead(branchId, () =>
      api.post<{ orders: PurchaseOrderView[] }>(`${stockBase(branchId)}/purchase-orders/lines`, { lines }, once()),
    ),

  setOrderLineQuantity: (branchId: string, orderId: string, lineId: string, quantity: number) =>
    writeThenRead(branchId, () =>
      api.patch(`${stockBase(branchId)}/purchase-orders/${orderId}/lines/${lineId}`, { quantity }, once()),
    ),

  removeOrderLine: (branchId: string, orderId: string, lineId: string) =>
    writeThenRead(branchId, () =>
      api.delete(`${stockBase(branchId)}/purchase-orders/${orderId}/lines/${lineId}`, undefined, once()),
    ),

  markOrdered: (branchId: string, orderId: string, body: { expectedArrivalDate?: string; notes?: string }) =>
    writeThenRead(branchId, () => api.post(`${stockBase(branchId)}/purchase-orders/${orderId}/ordered`, body, once())),

  commitStockTake: (branchId: string, lines: Array<{ stockItemId: string; locationId: string; countedQuantity: number }>) =>
    writeThenRead(branchId, () => api.post<StockTakeResult>(`${stockBase(branchId)}/stock-takes`, { lines }, once())),

  adjust: (branchId: string, body: { stockItemId: string; locationId?: string; delta: number; reason: string }) =>
    writeThenRead(branchId, () => api.post<StockAdjustResult>(`${stockBase(branchId)}/adjustments`, body, once())),

  createLocation: (branchId: string, body: { name: string; type: StockLocation['type'] }) =>
    writeThenRead(branchId, () => api.post<StockLocationView>(`${stockBase(branchId)}/locations`, body, once())),

  updateLocation: (branchId: string, locationId: string, patch: { name?: string; type?: StockLocation['type']; active?: boolean }) =>
    writeThenRead(branchId, () =>
      api.patch<StockLocationView>(`${stockBase(branchId)}/locations/${locationId}`, patch, once()),
    ),

  setSellPoint: (branchId: string, locationId: string) =>
    writeThenRead(branchId, () =>
      api.post<StockLocationView>(`${stockBase(branchId)}/locations/${locationId}/sell-point`, undefined, once()),
    ),

  saveItem: (branchId: string, groupId: string | null, body: StockItemBody) =>
    writeThenRead(branchId, () =>
      groupId
        ? api.put<{ groupId: string; stockItemIds: string[] }>(`${stockBase(branchId)}/items/${groupId}`, body, once())
        : api.post<{ groupId: string; stockItemIds: string[] }>(`${stockBase(branchId)}/items`, body, once()),
    ),

  resolveAttention: (branchId: string, attentionId: string) =>
    writeThenRead(branchId, () => api.post(`${stockBase(branchId)}/attention/${attentionId}/resolve`, undefined, once())),
};

/**
 * The admin form's item as the platform's body. A size keeps its stock item id
 * when it already exists on the platform; its stock is never sent — levels move
 * only through movements, and a new item opens with a count or a delivery.
 */
export function inventoryItemToStockBody(
  item: InventoryItem,
  opts: { existingSizeIds: ReadonlySet<string>; productSized: boolean },
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
      sku: v.sku ?? null,
      lowStockThreshold: v.lowStockThreshold ?? null,
      parByLocation: v.parByLocation ?? {},
    })),
  };
}

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
export async function fetchPlaceOpenings(branchId: string): Promise<StockPlaceOpening[]> {
  return (await api.get<StockPlaceOpenings>(`${stockBase(branchId)}/openings`)).places;
}

/** The five stock reports over inclusive business dates. */
export function fetchStockReports(branchId: string, from: string, to: string): Promise<StockReports> {
  const q = new URLSearchParams({ from, to });
  return api.get<StockReports>(`${stockBase(branchId)}/reports?${q.toString()}`);
}

/** Cost of goods per product over inclusive business dates, at the cost frozen on each sale line. */
export function fetchCostOfGoods(branchId: string, from: string, to: string): Promise<StockCostOfGoods> {
  const q = new URLSearchParams({ from, to });
  return api.get<StockCostOfGoods>(`${stockBase(branchId)}/reports/cost-of-goods?${q.toString()}`);
}
