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

import { useSyncExternalStore } from 'react';
import type { SellableStock, SellableStockProduct } from '@oto/shared';
import { getInventoryItem } from '@/store/catalogStore';
import { INVENTORY_DEFAULT_VARIANT_ID, type InventoryItem, type MerchItem } from '@/types';
import { api, isMissingRoute } from './client';

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
