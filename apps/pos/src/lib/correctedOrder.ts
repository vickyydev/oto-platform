import type { ApiSaleDetail } from '@/api/history';
import type { AddOn, MenuItem, TicketType } from '@/types';
import { computeLineTotal } from '@/lib/pricing';
import { resolveRateToday } from '@/lib/pricingMode';
import { fnbLineTotal } from '@/lib/cartWire';
import { CartLine, CustomerTier, FnbOrderLine, Wristband, Member } from '@/types';

// Cross-route handoff for "Start corrected order" after a refund. When staff
// choose to redo a botched transaction, History stashes a prefill payload here
// and navigates to the till (/) or F&B station (/order-station), which consume
// it once on mount. Module-memory only — no storage, cleared after one read.

export interface TicketCorrection {
  kind: 'ticket';
  branchId?: string;
  tier: CustomerTier;
  lines: CartLine[];
  memberId?: string;
  member?: Member;
  notice?: string;
  customerPhone?: string;
  customerNickname?: string;
}

export interface FnbCorrection {
  kind: 'fnb';
  branchId?: string;
  note?: string;
  notice?: string;
  lines: FnbOrderLine[];
  wristband?: Wristband;
}

export type Correction = TicketCorrection | FnbCorrection;

let pending: Correction | null = null;

export const setCorrectedOrder = (correction: Correction): void => {
  pending = correction;
};

// Returns the pending correction (if any) and clears it so it's consumed once.
export const takeCorrectedOrder = (): Correction | null => {
  const current = pending;
  pending = null;
  return current;
};

/** Build a new draft from recorded identities; current catalogue prices are re-quoted. */
export function correctionFromSale(
  detail: ApiSaleDetail,
  kind: 'ticket' | 'fnb',
  catalogue: { tickets: TicketType[]; addOns: AddOn[]; menu: MenuItem[] },
): Correction {
  const notices = new Set<string>();
  if (kind === 'fnb') {
    const lines: FnbOrderLine[] = [];
    for (const row of detail.lines) {
      if (row.kind !== 'fnb_item') continue;
      if (row.prepaid) {
        notices.add(
          'Prepaid food must be selected again after scanning its bracelet; the recorded entitlement is not charged as an ordinary item.',
        );
        continue;
      }
      const menuItem = catalogue.menu.find((item) => item.id === row.productId);
      if (!menuItem) {
        notices.add(`${row.label} is no longer on this menu. Select its replacement.`);
        continue;
      }
      const modifiers = new Map<string, string[]>();
      for (const choice of row.modifiers ?? [])
        modifiers.set(choice.groupId, [...(modifiers.get(choice.groupId) ?? []), choice.optionId]);
      const selectedModifiers = [...modifiers].map(([groupId, optionIds]) => ({
        groupId,
        optionIds,
      }));
      const line: FnbOrderLine = {
        id: row.cartLineId,
        menuItem,
        qty: row.quantity,
        selectedModifiers,
        lineTotal: fnbLineTotal(menuItem, selectedModifiers, row.quantity),
        ...(row.note ? { note: row.note } : {}),
        ...(row.variant
          ? { variantId: row.variant.variantId, variantLabel: row.variant.variantLabel }
          : {}),
      };
      if (row.quantity > 0) lines.push(line);
    }
    if (
      detail.lines.some((row) => row.holderCheckinId || row.prepaid) ||
      detail.attempts?.some((attempt) => attempt.method === 'wallet')
    )
      notices.add(
        'Scan the original bracelet again to load its current balance, consent and food entitlement.',
      );
    return {
      kind,
      branchId: detail.sale.branchId,
      lines,
      ...(detail.sale.note ? { note: detail.sale.note } : {}),
      ...(notices.size ? { notice: [...notices].join(' ') } : {}),
    };
  }
  const grouped = new Map<string, ApiSaleDetail['lines']>();
  for (const row of detail.lines)
    grouped.set(row.cartLineId, [...(grouped.get(row.cartLineId) ?? []), row]);
  const lines: CartLine[] = [];
  for (const [id, rows] of grouped) {
    if (
      rows.some(
        (row) => row.supervised || row.kind === 'service_fee' || row.kind === 'food_provision',
      )
    ) {
      notices.add(
        'Re-enter the supervised child through check-in so consent, service and collection details are checked again.',
      );
      continue;
    }
    const first = rows.find((row) => row.ticketPackageId);
    if (!first) continue; // Promotional gifts are applied again only by a valid code.
    const ticketType = catalogue.tickets.find((ticket) => ticket.id === first.ticketPackageId);
    if (!ticketType) {
      notices.add(`${first.label} is no longer sold. Select its replacement.`);
      continue;
    }
    const addOns: CartLine['addOns'] = [];
    for (const row of rows.filter((row) => row.kind === 'addon')) {
      const addOn = catalogue.addOns.find(
        (item) => item.id === row.productId || item.id === row.componentKey,
      );
      if (!addOn) {
        notices.add(`${row.label} is no longer sold. Select its replacement.`);
        continue;
      }
      addOns.push({
        ...addOn,
        price: resolveRateToday(addOn.price),
        quantity: row.quantity,
        ...(row.variantBreakdown ? { variantBreakdown: row.variantBreakdown } : {}),
      });
    }
    const line: CartLine = {
      id,
      ticketType,
      tier: detail.sale.customerTier,
      kids: first.kidCount,
      adults: first.adultCount,
      socks: rows.filter((row) => row.kind === 'socks').reduce((sum, row) => sum + row.quantity, 0),
      addOns,
      lineTotal: 0,
    };
    line.lineTotal = computeLineTotal(line);
    lines.push(line);
  }
  return {
    kind,
    branchId: detail.sale.branchId,
    tier: detail.sale.customerTier,
    lines,
    ...(detail.sale.memberId ? { memberId: detail.sale.memberId } : {}),
    ...(notices.size ? { notice: [...notices].join(' ') } : {}),
  };
}
