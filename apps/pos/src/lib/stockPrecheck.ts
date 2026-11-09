import { stockSizeName } from '@oto/shared';
import { inventoryFor } from '@/api/stock';
import { isSocksAddOnId } from '@/api/menu';
import { INVENTORY_DEFAULT_VARIANT_ID, type AddOn, type CartLine } from '@/types';

/**
 * THE TILL'S PRE-CHECKOUT STOCK GUARD (S2-14b): every stocked unit in the cart,
 * added up per shelf and size, against what the platform says the branch holds
 * (`api/stock.ts`), so an edge-case UI race cannot oversell. It is the
 * platform's own rule, read early: the commit refuses the same cart, and a race
 * this cannot see is recorded at finalise. Answers one "Name (need N, have M)"
 * per shelf that is short; empty when the cart fits.
 *
 * - Add-ons are keyed by `inventoryItemId` + size. An add-on split across sizes
 *   counts each size against its own shelf (the prototype's guard ignored the
 *   split and counted only the default).
 * - The socks counter (`CartLine.socks`) is the branch's Regular Socks product
 *   on the platform whichever id this till holds it under (`isSocksAddOnId`),
 *   counted on the same shelf as socks sold from the add-on grid.
 * - SCRUM-799 — an add-on that takes stock from another item's shelf (Free
 *   Socks from Regular Socks) carries the owner's id (`api/menu.ts`), so it adds
 *   to the owner's count, and a shortage is named for the item that owns the
 *   shelf, as the platform names it.
 */
export function cartStockShortfalls(
  lines: ReadonlyArray<Pick<CartLine, 'socks' | 'addOns'>>,
  addOns: readonly AddOn[],
): string[] {
  const needed = new Map<string, { name: string; label: string | null; qty: number }>();
  const socksAddOn = addOns.find((a) => isSocksAddOnId(a.id));
  const totalSocks = lines.reduce((sum, l) => sum + l.socks, 0);
  if (socksAddOn?.inventoryItemId && totalSocks > 0) {
    const vid = inventoryFor(socksAddOn.inventoryItemId)?.variants[0]?.id ?? INVENTORY_DEFAULT_VARIANT_ID;
    needed.set(`${socksAddOn.inventoryItemId}:${vid}`, { name: socksAddOn.name, label: null, qty: totalSocks });
  }
  for (const line of lines) {
    for (const sa of line.addOns) {
      const ao = addOns.find((a) => a.id === sa.id);
      if (!ao?.inventoryItemId) continue;
      // The shelf's own item when it is another add-on (a share), else this one.
      const shelfName =
        ao.inventoryItemId !== ao.id ? (addOns.find((a) => a.id === ao.inventoryItemId)?.name ?? ao.name) : ao.name;
      const parts =
        sa.variantBreakdown && sa.variantBreakdown.length > 0
          ? sa.variantBreakdown.map((b) => ({ vid: b.variantId, label: b.variantLabel, qty: b.quantity }))
          : [{ vid: sa.variantId ?? INVENTORY_DEFAULT_VARIANT_ID, label: null, qty: sa.quantity }];
      for (const part of parts) {
        const key = `${ao.inventoryItemId}:${part.vid}`;
        const prev = needed.get(key);
        if (prev) {
          prev.qty += part.qty;
        } else {
          needed.set(key, { name: shelfName, label: part.label, qty: part.qty });
        }
      }
    }
  }
  const shortfalls: string[] = [];
  for (const [key, { name, label, qty }] of needed) {
    const [itemId, variantId] = key.split(':');
    const invItem = inventoryFor(itemId);
    const variant = invItem?.variants.find((v) => v.id === variantId);
    const available = variant?.stock ?? Infinity;
    if (qty > available) {
      shortfalls.push(`${stockSizeName(name, label ?? null)} (need ${qty}, have ${available})`);
    }
  }
  return shortfalls;
}
