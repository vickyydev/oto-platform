import { CartLine, DiscountTarget, MenuItem, MenuCategoryDef } from '@/types';
import { computeLineBreakdown } from '@/lib/pricing';
import { getTicketTypes, getAddOns, getMenuItems, getMenuCategories } from '@/store/catalogStore';

const SOCKS_ID = 'a-socks';

/**
 * The ฿ subtotal of a ticket cart that falls within a discount's target scope.
 * F&B-only targets (fnb / fnbCategory / menuItems) return 0 here because the
 * ticket cart carries no F&B lines — they're sold separately at the F&B
 * register. A discount simply finds nothing to apply to in that cart.
 */
export function discountTargetBase(
  lines: CartLine[],
  target: DiscountTarget
): number {
  if (target.kind === 'everything') {
    return lines.reduce((acc, l) => acc + l.lineTotal, 0);
  }

  let base = 0;
  for (const line of lines) {
    for (const row of computeLineBreakdown(line)) {
      if (rowMatches(row.kind, row.key, line.ticketType.id, target)) {
        base += row.subtotal;
      }
    }
  }
  return base;
}

function rowMatches(
  kind: 'kids' | 'adults' | 'socks' | 'addon',
  key: string,
  ticketTypeId: string,
  target: DiscountTarget
): boolean {
  const isTicket = kind === 'kids' || kind === 'adults';
  // A real add-on row or the socks row (socks is an add-on); exclude the
  // drop-off/nanny service fee row which reuses the 'addon' kind.
  const isAddOn = kind === 'socks' || (kind === 'addon' && key !== 'dropoff-service');

  switch (target.kind) {
    case 'tickets':
      return isTicket;
    case 'ticketGroup':
      return kind === target.group;
    case 'ticketType':
      return isTicket && ticketTypeId === target.ticketTypeId;
    case 'addOns':
      return isAddOn;
    case 'addOn':
      return (
        (kind === 'addon' && key === target.addOnId) ||
        (kind === 'socks' && target.addOnId === SOCKS_ID)
      );
    // F&B, merch, and event-pass scopes never match a ticket-cart row —
    // those items are sold at separate registers (F&B station, merch desk,
    // online /book). A discount applied here finds no base to reduce.
    case 'fnb':
    case 'fnbCategory':
    case 'menuItems':
    case 'merch':
    case 'event_pass':
    case 'everything':
      return false;
  }
}

/**
 * Whether a menu item (F&B) falls within a discount/benefit target's scope.
 * The mirror image of `rowMatches` for the F&B side: ticket-only target kinds
 * (tickets/ticketGroup/ticketType/addOns/addOn/merch/event_pass) never match a
 * menu item here — those are sold at a different register. `fnbCategory`
 * matches the item's own category OR its parent category, so scoping to a
 * top-level category (e.g. 'drinks') also covers its sub-categories
 * (e.g. 'drinks-coffee').
 */
export function menuItemMatchesTarget(
  item: MenuItem,
  target: DiscountTarget,
  categories: MenuCategoryDef[] = getMenuCategories()
): boolean {
  switch (target.kind) {
    case 'everything':
    case 'fnb':
      return true;
    case 'fnbCategory': {
      if (item.category === target.category) return true;
      const cat = categories.find((c) => c.id === item.category);
      return cat?.parentId === target.category;
    }
    case 'menuItems':
      return target.menuItemIds.includes(item.id);
    case 'tickets':
    case 'ticketGroup':
    case 'ticketType':
    case 'addOns':
    case 'addOn':
    case 'merch':
    case 'event_pass':
      return false;
  }
}

/** Short human label for a discount target, e.g. "Only kids tickets", "Free: Ice Cream". */
export function formatDiscountTargetLabel(target?: DiscountTarget): string {
  if (!target || target.kind === 'everything') return 'Whole order';
  switch (target.kind) {
    case 'tickets':
      return 'All tickets';
    case 'ticketGroup':
      return target.group === 'kids' ? 'Kids tickets' : 'Adult tickets';
    case 'ticketType': {
      const t = getTicketTypes().find((x) => x.id === target.ticketTypeId);
      return t ? `Ticket: ${t.name}` : 'Specific ticket';
    }
    case 'addOns':
      return 'All add-ons';
    case 'addOn': {
      const a = getAddOns().find((x) => x.id === target.addOnId);
      return a ? `Add-on: ${a.name}` : 'Specific add-on';
    }
    case 'fnb':
      return 'All F&B';
    case 'fnbCategory': {
      const cat = getMenuCategories().find((c) => c.id === target.category);
      return `F&B: ${cat?.name ?? target.category}`;
    }
    case 'menuItems': {
      const items = getMenuItems();
      const names = target.menuItemIds
        .map((id) => items.find((x) => x.id === id)?.name)
        .filter((n): n is string => !!n);
      if (names.length === 0) return 'Specific items';
      if (names.length === 1) return `Item: ${names[0]}`;
      if (names.length === 2) return `Items: ${names.join(', ')}`;
      return `Items: ${names[0]}, ${names[1]} +${names.length - 2}`;
    }
    case 'merch':
      return 'All merch';
    case 'event_pass':
      return 'Event passes';
  }
}
