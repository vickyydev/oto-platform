import {
  FnbOrder,
  FnbOrderLine,
  MenuCategoryDef,
  MenuItem,
  ModifierGroup,
  PrepStation,
  SelectedModifier,
} from '@/types';
import { effectivePrepStation, getEffectiveModifierGroups } from '@/lib/menu';
import { getMenuCategories } from '@/store/catalogStore';
import { RateMode, resolveRate, todayRateMode } from '@/lib/pricingMode';

/*
 * SCRUM-271 — THE F&B COUNTER'S MONEY IS NOT HERE ANY MORE. This file priced an
 * item (`computeUnitPrice`, `computeLineTotal`) and totalled an order
 * (`fnbTaxInputs`, `computeFnbTotals`) with the prototype's baht arithmetic. An
 * F&B row is priced now by the shared item engine the platform prices it with
 * — `fnbUnitPrice` and `fnbLineTotal` in `lib/cartWire.ts` — and an order is
 * totalled by `itemOrderTotals` there, in satang. What stays is what the menu
 * asks and where the kitchen prints.
 */

/** True when the item requires a modifier selection before it can be added. */
export function hasModifiers(item: MenuItem): boolean {
  return getEffectiveModifierGroups(item).length > 0;
}

/** Human-readable list of chosen option names, in group order (for display). */
export function describeModifiers(item: MenuItem, selected: SelectedModifier[]): string[] {
  const labels: string[] = [];
  for (const group of getEffectiveModifierGroups(item)) {
    const sel = selected.find((s) => s.groupId === group.id);
    if (!sel) continue;
    for (const optId of sel.optionIds) {
      const opt = group.options.find((o) => o.id === optId);
      if (opt) labels.push(opt.name);
    }
  }
  return labels;
}

/** A single chosen option with its per-unit price delta, for itemized display. */
export interface ModifierLine {
  /** The group this option belongs to, e.g. "Size" or "Toppings". */
  groupName: string;
  /** The chosen option label, e.g. "Large". */
  optionName: string;
  /** Per-unit surcharge for this option (0 when free). */
  price: number;
}

/**
 * Itemized breakdown of every chosen option, in group order, including the
 * group name and per-unit price delta — used by the customer display.
 */
export function breakdownModifiers(
  item: MenuItem,
  selected: SelectedModifier[],
  mode: RateMode = todayRateMode().mode,
): ModifierLine[] {
  const lines: ModifierLine[] = [];
  for (const group of getEffectiveModifierGroups(item)) {
    const sel = selected.find((s) => s.groupId === group.id);
    if (!sel) continue;
    for (const optId of sel.optionIds) {
      const opt = group.options.find((o) => o.id === optId);
      if (opt) lines.push({ groupName: group.name, optionName: opt.name, price: resolveRate(opt.price, mode) });
    }
  }
  return lines;
}

/**
 * Stable signature for a selection, used to merge identical cart lines
 * (same item + same modifier choices increment qty instead of stacking).
 */
export function modifierSignature(selected: SelectedModifier[]): string {
  return [...selected]
    .map((s) => `${s.groupId}:${[...s.optionIds].sort().join(',')}`)
    .sort()
    .join('|');
}

/** Whether a single group's required/min/max constraint is currently satisfied. */
export function isGroupSatisfied(group: ModifierGroup, optionIds: string[]): boolean {
  const count = optionIds.length;
  if (group.selectionType === 'single') {
    return group.required ? count === 1 : count <= 1;
  }
  // multi
  const min = group.required ? (group.min ?? 1) : (group.min ?? 0);
  const max = group.max ?? Infinity;
  return count >= min && count <= max;
}

/** Whether every group on the item is satisfied (used to enable "Add to order"). */
export function areModifiersValid(item: MenuItem, selected: SelectedModifier[]): boolean {
  const groups = getEffectiveModifierGroups(item);
  if (groups.length === 0) return true;
  return groups.every((group) => {
    const sel = selected.find((s) => s.groupId === group.id);
    return isGroupSatisfied(group, sel?.optionIds ?? []);
  });
}

// --- Kitchen / bar ticket routing -----------------------------------------
// On confirmation an order is split into prep tickets by each item's EFFECTIVE
// prep station (per-item override, else its menu category's default). Items
// whose effective station is 'none' don't print a prep ticket at all. Each
// printing station gets its own ticket so prep happens in parallel.

// A prep station that actually prints a ticket (excludes 'none').
type PrintingStation = Exclude<PrepStation, 'none'>;

export interface PrepTicket {
  station: PrintingStation;
  title: string; // "Kitchen" | "Bar"
  lines: FnbOrderLine[];
  // Safety info copied onto the printed ticket so prep staff see it too. Pulled
  // from the band's drop-off CheckIn; absent for ordinary guests.
  holderName?: string;
  allergiesMedical?: string;
  foodRestrictions?: string;
  // Whole-order note — printed on BOTH prep tickets (kitchen + bar). Per-item
  // notes ride on each line and so only reach the station that gets that item.
  orderNote?: string;
}

const PREP_TITLE: Record<PrintingStation, string> = { kitchen: 'Kitchen', bar: 'Bar' };

/**
 * Split a finalized order into the prep tickets it produces, routing each line
 * by its EFFECTIVE prep station (per-item override, else its category default).
 * Lines whose effective station is 'none' don't print and are dropped. Only
 * printing stations that actually have lines get a ticket. Each ticket carries
 * the band's allergy/medical alert so it prints on the prep ticket too.
 */
export function buildPrepTickets(
  order: FnbOrder,
  categories: MenuCategoryDef[] = getMenuCategories()
): PrepTicket[] {
  const byStation: Record<PrintingStation, FnbOrderLine[]> = { kitchen: [], bar: [] };
  for (const line of order.lines) {
    const station = effectivePrepStation(line.menuItem, categories);
    if (station === 'none') continue; // not routed to any prep station
    byStation[station].push(line);
  }
  const wb = order.wristband;
  return (['kitchen', 'bar'] as PrintingStation[])
    .filter((station) => byStation[station].length > 0)
    .map((station) => ({
      station,
      title: PREP_TITLE[station],
      lines: byStation[station],
      holderName: wb?.holderName,
      allergiesMedical: wb?.allergiesMedical,
      foodRestrictions: wb?.foodRestrictions,
      orderNote: order.orderNote,
    }));
}
