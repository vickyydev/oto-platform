import { useState } from 'react';
import { ArrowRight, Package, TrendingDown, ShoppingCart, AlertTriangle, Truck, ClipboardList, ChevronDown, ChevronUp, PackageX } from 'lucide-react';
import type { StockAttentionView } from '@oto/shared';
import { InventoryItem, InventoryVariant, PurchaseOrder, StockLocation } from '@/types';
import { getReorderAlerts, ReorderAlert } from '@/lib/inventory';

/** Open purchase-order status for one inventory item (outstanding qty only). */
interface OnOrderStatus {
  state: 'to_order' | 'ordered';
  /** Outstanding eaches still due (orderedQty − receivedQty across open lines). */
  qty: number;
  supplierName: string;
  expectedArrivalDate?: string;
}

/** Map itemId → open PO status so alert cards can show "already on order". */
function buildOnOrderMap(orders: readonly PurchaseOrder[]): Map<string, OnOrderStatus> {
  const map = new Map<string, OnOrderStatus>();
  for (const po of orders) {
    if (po.state === 'received') continue;
    for (const line of po.lines) {
      const outstanding = line.orderedQty - line.receivedQty;
      if (outstanding <= 0) continue;
      const existing = map.get(line.inventoryItemId);
      if (existing) {
        existing.qty += outstanding;
        // 'ordered' (actually placed) wins over 'to_order' for display.
        if (po.state === 'ordered' && existing.state === 'to_order') {
          existing.state = 'ordered';
          existing.expectedArrivalDate = po.expectedArrivalDate;
        }
      } else {
        map.set(line.inventoryItemId, {
          state: po.state,
          qty: outstanding,
          supplierName: po.supplierName,
          ...(po.expectedArrivalDate ? { expectedArrivalDate: po.expectedArrivalDate } : {}),
        });
      }
    }
  }
  return map;
}

function formatArrival(iso: string): string {
  const d = new Date(`${iso}T00:00:00`);
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

interface Suggestion {
  item: InventoryItem;
  variant: InventoryVariant;
  locationId: string;
  locationName: string;
  currentQty: number;
  par: number;
  shortage: number;
  sourceLocationId?: string;
  sourceLocationName?: string;
  sourceAvailable?: number;
}

interface StockSuggestionsProps {
  inventory: InventoryItem[];
  locations: StockLocation[];
  /** The branch's purchase orders, from the platform — "already on order". */
  orders: PurchaseOrder[];
  /**
   * The platform's open stock attention. The low-stock rows are the cards below,
   * computed from the same counts; the rows a SALE raised — sold more than the
   * record held, or with no size — are shown above them, to be looked at.
   */
  attention: StockAttentionView[];
  onResolveAttention: (attentionId: string) => void;
  onStartTransfer: (suggestion: Suggestion) => void;
  onReorder: (item: InventoryItem) => void;
}

/** Par-based shortfall detection (existing logic — one entry per variant × location below par). */
function buildSuggestions(
  inventory: InventoryItem[],
  locations: StockLocation[],
): Suggestion[] {
  const locById = new Map(locations.map((l) => [l.id, l]));
  const suggestions: Suggestion[] = [];

  for (const item of inventory) {
    for (const variant of item.variants) {
      if (!variant.stockByLocation || !variant.parByLocation) continue;
      for (const [locId, par] of Object.entries(variant.parByLocation)) {
        const current = variant.stockByLocation[locId] ?? 0;
        if (current >= par) continue;
        const shortage = par - current;
        const loc = locById.get(locId);
        if (!loc) continue;

        // Find best source: another location with available stock (prefer BOH over bulk)
        let sourceLocationId: string | undefined;
        let sourceLocationName: string | undefined;
        let sourceAvailable: number | undefined;
        const sourceOrder = locations
          .filter((l) => l.id !== locId && l.active)
          .sort((a, b) => {
            const order: Record<string, number> = { back_of_house: 0, bulk: 1, rotation: 2 };
            return (order[a.type] ?? 9) - (order[b.type] ?? 9);
          });
        for (const srcLoc of sourceOrder) {
          const avail = variant.stockByLocation[srcLoc.id] ?? 0;
          if (avail > 0) {
            sourceLocationId = srcLoc.id;
            sourceLocationName = srcLoc.name;
            sourceAvailable = avail;
            break;
          }
        }

        suggestions.push({
          item,
          variant,
          locationId: locId,
          locationName: loc.name,
          currentQty: current,
          par,
          shortage,
          sourceLocationId,
          sourceLocationName,
          sourceAvailable,
        });
      }
    }
  }

  return suggestions;
}

/**
 * One unified attention entry per ITEM. Dedupes items that are flagged both
 * "below par at a location" AND "total at/below reorder point" into a single
 * card, and decides the ONE primary action that is actually possible:
 *   - stock exists at another location  → Transfer (move, not a buy)
 *   - nothing anywhere to transfer      → Reorder from supplier (if configured)
 *   - neither possible                  → informational card, no dead action
 */
interface AttentionEntry {
  item: InventoryItem;
  /** Par shortfalls for this item (may span variants/locations). */
  shortfalls: Suggestion[];
  /** Present when total on-hand ≤ reorder point. */
  reorderAlert?: ReorderAlert;
  totalStock: number;
  /** The transferable shortfall chosen as the primary transfer action (if any). */
  transfer?: Suggestion;
  /** True when the primary action is Reorder (has supplier settings, nothing to move). */
  reorder: boolean;
  /** Present when the item already sits on an open purchase order. */
  onOrder?: OnOrderStatus;
  /** Urgency: 0 = out, 1 = low. */
  urgency: 0 | 1;
  /** Severity for sorting within the same urgency (higher = worse). */
  severity: number;
}

function buildAttentionList(
  inventory: InventoryItem[],
  locations: StockLocation[],
  orders: readonly PurchaseOrder[],
): AttentionEntry[] {
  const suggestions = buildSuggestions(inventory, locations);
  const reorderAlerts = getReorderAlerts(inventory);
  const onOrderMap = buildOnOrderMap(orders);

  const byItem = new Map<string, AttentionEntry>();

  const ensure = (item: InventoryItem): AttentionEntry => {
    let e = byItem.get(item.id);
    if (!e) {
      const totalStock = item.variants.reduce((s, v) => s + v.stock, 0);
      e = { item, shortfalls: [], totalStock, reorder: false, urgency: 1, severity: 0 };
      byItem.set(item.id, e);
    }
    return e;
  };

  for (const s of suggestions) ensure(s.item).shortfalls.push(s);
  for (const a of reorderAlerts) ensure(a.item).reorderAlert = a;

  const entries = [...byItem.values()];

  for (const e of entries) {
    e.onOrder = onOrderMap.get(e.item.id);
    // Pick the primary action: transfer wins only when stock actually exists elsewhere.
    const transferable = e.shortfalls
      .filter((s) => s.sourceLocationId)
      .sort((a, b) => (a.currentQty <= 0 ? 0 : 1) - (b.currentQty <= 0 ? 0 : 1) || b.shortage - a.shortage);

    if (transferable.length > 0) {
      e.transfer = transferable[0];
    }
    // Reorder is the remedy when there is nothing to move and the item has a
    // supplier configured — either because total is at/below the reorder point,
    // or because a location is short with no stock anywhere else.
    if (!e.transfer && e.item.reorderSettings && (e.reorderAlert || e.shortfalls.length > 0)) {
      e.reorder = true;
    }

    const worstShortfallOut = e.shortfalls.some((s) => s.currentQty <= 0);
    e.urgency = e.totalStock <= 0 || worstShortfallOut ? 0 : 1;
    e.severity = Math.max(
      e.reorderAlert ? e.reorderAlert.reorderPoint - e.totalStock : 0,
      ...e.shortfalls.map((s) => s.shortage),
      0,
    );
  }

  // Out first, then Low; within the same urgency, worst severity first.
  return entries.sort((a, b) => a.urgency - b.urgency || b.severity - a.severity);
}

export function StockSuggestions({
  inventory,
  locations,
  orders,
  attention,
  onResolveAttention,
  onStartTransfer,
  onReorder,
}: StockSuggestionsProps) {
  const entries = buildAttentionList(inventory, locations, orders);
  const fromSales = attention.filter((a) => a.kind === 'stock_shortfall' || a.kind === 'size_unknown');

  if (entries.length === 0 && fromSales.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-16 gap-3 text-center">
        <Package className="w-10 h-10 text-foreground/20" />
        <p className="text-sm text-foreground/50">All locations are at or above par, and no items need reordering.</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3 p-4">
      {fromSales.map((a) => (
        <div
          key={a.id}
          className="rounded-2xl border border-red-500/40 bg-red-500/[0.06] px-3 py-2.5 flex items-start gap-2"
        >
          <PackageX className="w-4 h-4 shrink-0 mt-0.5 text-red-600 dark:text-red-400" />
          <p className="flex-1 min-w-0 text-xs text-foreground/70">{a.summary}</p>
          <button
            type="button"
            onClick={() => onResolveAttention(a.id)}
            className="shrink-0 text-xs font-medium text-primary underline"
          >
            Done
          </button>
        </div>
      ))}
      <div className="flex items-center gap-2">
        <AlertTriangle className="w-3.5 h-3.5 text-amber-600 dark:text-amber-400" />
        <p className="text-xs text-foreground/50 font-medium uppercase tracking-wider">
          Needs attention · {entries.length}
        </p>
      </div>
      <p className="text-[11px] text-foreground/35 -mt-1 leading-relaxed">
        One card per item, with the action that is actually possible: move stock from another
        location when it exists, otherwise reorder from the supplier.
        <br />
        <span className="italic opacity-70">
          Note: future releases will auto-trigger reorders on usage rate × lead time once consumption history is available.
        </span>
      </p>
      {entries.map((e) => (
        <AttentionCard key={e.item.id} entry={e} onStartTransfer={onStartTransfer} onReorder={onReorder} />
      ))}
    </div>
  );
}

function AttentionCard({
  entry: e,
  onStartTransfer,
  onReorder,
}: {
  entry: AttentionEntry;
  onStartTransfer: (suggestion: Suggestion) => void;
  onReorder: (item: InventoryItem) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const isOut = e.urgency === 0;
  const rs = e.item.reorderSettings;

  // Compact one-line summary of why the item is flagged (worst shortfall first).
  const summaryParts: string[] = [];
  if (e.shortfalls.length > 0) {
    const worst = [...e.shortfalls].sort(
      (a, b) => (a.currentQty <= 0 ? 0 : 1) - (b.currentQty <= 0 ? 0 : 1) || b.shortage - a.shortage,
    )[0];
    summaryParts.push(`${worst.locationName} ${worst.currentQty}/${worst.par}`);
    if (e.shortfalls.length > 1) summaryParts.push(`+${e.shortfalls.length - 1} more`);
  }
  if (e.reorderAlert) summaryParts.push(`total ${e.totalStock} ≤ reorder ${e.reorderAlert.reorderPoint}`);
  if (e.onOrder) summaryParts.push(`${e.onOrder.qty} on ${e.onOrder.state === 'ordered' ? 'order' : 'list'}`);

  return (
    <div
      onClick={() => setExpanded((x) => !x)}
      className={`rounded-2xl border px-3 py-2.5 flex flex-col gap-2 cursor-pointer select-none ${
        isOut
          ? 'border-red-500/40 bg-red-500/[0.06]'
          : 'border-amber-400/40 bg-amber-400/[0.08]'
      }`}
    >
      {/* Row 1: name + supplier + urgency badge */}
      <div className="flex items-center justify-between gap-2">
        <p className="font-semibold text-sm leading-tight truncate min-w-0">
          {e.item.name}
          {rs && <span className="font-normal text-xs text-foreground/45 ml-1.5">{rs.supplierName}</span>}
        </p>
        <div
          className={`flex items-center gap-1 text-xs font-bold px-2 py-0.5 rounded-full shrink-0 ${
            isOut
              ? 'text-red-600 dark:text-red-400 bg-red-500/10'
              : 'text-amber-700 dark:text-amber-400 bg-amber-400/15'
          }`}
        >
          {e.reorder ? <AlertTriangle className="w-3 h-3" /> : <TrendingDown className="w-3 h-3" />}
          {isOut ? 'Out' : `Low · ${e.totalStock}`}
        </div>
      </div>

      {/* Row 2: compact detail line + expand hint */}
      <div className="flex items-center justify-between gap-2 text-xs text-foreground/55">
        <p className="truncate min-w-0">{summaryParts.join(' · ')}</p>
        {expanded
          ? <ChevronUp className="w-3.5 h-3.5 shrink-0 text-foreground/30" />
          : <ChevronDown className="w-3.5 h-3.5 shrink-0 text-foreground/30" />}
      </div>

      {/* Expanded: full details (per-location, on-order, supplier terms) */}
      {expanded && (
        <>
          <div className="flex flex-col gap-1 text-xs text-foreground/60">
            {e.shortfalls.map((s) => (
              <p key={`${s.variant.id}-${s.locationId}`}>
                Below par at <strong className="text-foreground">{s.locationName}</strong>
                {e.item.variants.length > 1 && <span> ({s.variant.label})</span>}
                {': '}
                <strong className={s.currentQty <= 0 ? 'text-red-600 dark:text-red-400' : 'text-amber-700 dark:text-amber-400'}>{s.currentQty}</strong>
                <span className="text-foreground/40"> / par {s.par}</span>
                <span className="text-foreground/40"> · short {s.shortage}</span>
              </p>
            ))}
            {e.reorderAlert && (
              <p>
                Total on hand <strong className="text-foreground">{e.totalStock}</strong>
                <span className="text-foreground/40"> ≤ reorder point {e.reorderAlert.reorderPoint}</span>
              </p>
            )}
            {e.onOrder && (
              <p className="flex items-center gap-1.5 text-emerald-600 dark:text-emerald-400">
                {e.onOrder.state === 'ordered' ? (
                  <Truck className="w-3.5 h-3.5 shrink-0" />
                ) : (
                  <ClipboardList className="w-3.5 h-3.5 shrink-0" />
                )}
                {e.onOrder.state === 'ordered' ? (
                  <span>
                    {e.onOrder.qty} on order from {e.onOrder.supplierName}
                    {e.onOrder.expectedArrivalDate && (
                      <span className="text-emerald-600/70 dark:text-emerald-400/70"> · expected {formatArrival(e.onOrder.expectedArrivalDate)}</span>
                    )}
                  </span>
                ) : (
                  <span>{e.onOrder.qty} on the purchase list ({e.onOrder.supplierName}) — not yet ordered</span>
                )}
              </p>
            )}
          </div>

          <div className="flex items-center gap-3 text-xs text-foreground/60 flex-wrap">
            <span>
              On hand: <strong className={isOut ? 'text-red-600 dark:text-red-400' : 'text-foreground'}>{e.totalStock}</strong>
            </span>
            {rs && (
              <>
                <span>·</span>
                <span>
                  Reorder at: <strong className="text-foreground">{rs.reorderPoint}</strong>
                </span>
                <span>·</span>
                <span>
                  Default qty: <strong className="text-foreground">{rs.reorderQty}</strong>
                </span>
                <span>·</span>
                <span>
                  Lead time: <strong className="text-foreground">{rs.leadTimeDays}d</strong>
                </span>
              </>
            )}
          </div>
        </>
      )}

      {/* ONE primary action — the one that's actually possible (works collapsed + expanded) */}
      {e.transfer ? (
        <button
          type="button"
          onClick={(ev) => { ev.stopPropagation(); onStartTransfer(e.transfer!); }}
          className="flex items-center justify-between w-full rounded-lg bg-primary/10 border border-primary/20
                     px-3 py-2 text-xs font-medium text-primary hover:bg-primary/15 transition-colors"
        >
          <span className="truncate">
            Move {e.transfer.shortage} from {e.transfer.sourceLocationName}
            {e.transfer.sourceAvailable !== undefined && (
              <span className="text-primary/60 ml-1">({e.transfer.sourceAvailable} available)</span>
            )}
          </span>
          <ArrowRight className="w-3.5 h-3.5 shrink-0" />
        </button>
      ) : e.reorder && rs && e.onOrder ? (
        <div
          className="flex items-center gap-2 w-full rounded-lg bg-emerald-500/10 border border-emerald-500/25
                     px-3 py-2 text-xs font-medium text-emerald-600 dark:text-emerald-400"
        >
          {e.onOrder.state === 'ordered' ? (
            <Truck className="w-3.5 h-3.5 shrink-0" />
          ) : (
            <ClipboardList className="w-3.5 h-3.5 shrink-0" />
          )}
          <span className="truncate">
            {e.onOrder.state === 'ordered'
              ? `Already ordered — ${e.onOrder.qty} arriving${e.onOrder.expectedArrivalDate ? ` ${formatArrival(e.onOrder.expectedArrivalDate)}` : ''}`
              : 'Already on the purchase list — place the order in Purchase'}
          </span>
        </div>
      ) : e.reorder && rs ? (
        <button
          type="button"
          onClick={(ev) => { ev.stopPropagation(); onReorder(e.item); }}
          className="flex items-center justify-between w-full rounded-lg bg-red-500/10 border border-red-500/25
                     px-3 py-2 text-xs font-medium text-red-600 dark:text-red-400 hover:bg-red-500/20 transition-colors"
        >
          <span className="flex items-center gap-2 truncate">
            <ShoppingCart className="w-3.5 h-3.5 shrink-0" />
            Reorder from {rs.supplierName}
          </span>
          <ArrowRight className="w-3.5 h-3.5 shrink-0" />
        </button>
      ) : (
        <p className="text-xs text-foreground/40 italic">
          No stock available to transfer and no supplier configured — set reorder settings in Admin Inventory.
        </p>
      )}
    </div>
  );
}

export type { Suggestion };
