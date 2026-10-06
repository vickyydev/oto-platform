import { useState } from 'react';
import { ArrowRight, Package, TrendingDown, ShoppingCart, AlertTriangle, Truck, ClipboardList, ChevronDown, ChevronUp, PackageX } from 'lucide-react';
import { STOCK_TREND_HISTORY_DAYS, type StockAttentionView } from '@oto/shared';
import { InventoryItem, InventoryVariant, PurchaseOrder, StockLocation } from '@/types';

/** The platform's current low-stock rows, with transfer actions and open-order reminders. */

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

/** A transfer the Alerts screen offers: move stock into a place below par. */
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
   * The platform's open stock attention — THE source of the cards: each
   * low-stock or reorder row is one card, and the rows a SALE raised (sold more
   * than the record held, or with no size) are shown above them, to be looked at.
   */
  attention: StockAttentionView[];
  onResolveAttention: (attentionId: string) => void;
  onStartTransfer: (suggestion: Suggestion) => void;
  onReorder: (item: InventoryItem) => void;
}

/** One size under its par at one place, as the platform's row read it. */
interface Shortfall {
  stockItemId: string;
  /** The size's label when the item comes in more than one. */
  sizeLabel: string | null;
  locationName: string;
  currentQty: number;
  par: number;
  shortage: number;
  /** The move that would fill it, when another place on screen holds some. */
  transfer?: Suggestion;
}

/**
 * One card per platform row (one row per ITEM: the platform folds "below par
 * at a place" and "at or below the reorder point" into one), with the ONE
 * primary action that is actually possible:
 *   - stock exists at another location  → Transfer (move, not a buy)
 *   - nothing anywhere to transfer      → Reorder from supplier (if configured)
 *   - neither possible                  → informational card, no dead action
 */
export interface AttentionEntry {
  /** The platform's row this card is. */
  row: StockAttentionView;
  /** The item's name: the screen's item, else the row's own words. */
  name: string;
  /** The item on screen, when the levels have it. */
  item?: InventoryItem;
  /** Par shortfalls for this item (may span sizes/places). */
  shortfalls: Shortfall[];
  /** True when the platform's rule found the total at or below the reorder point. */
  atReorderPoint: boolean;
  /** The point the platform held the total against (static, or the 30-day usage). */
  reorderPoint: number | null;
  /** True when the point came from the item's last 30 days of usage (OD-27). */
  trend: boolean;
  usedInWindow: number | null;
  /** Everything the item holds, as the platform read it. */
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

const SOURCE_TYPE_ORDER: Record<string, number> = { back_of_house: 0, bulk: 1, rotation: 2 };

/** The prototype's source pick: another live place holding some, back of house before bulk. */
function transferFor(
  item: InventoryItem,
  variant: InventoryVariant,
  into: StockLocation,
  locations: StockLocation[],
  currentQty: number,
  par: number,
): Suggestion {
  const suggestion: Suggestion = {
    item,
    variant,
    locationId: into.id,
    locationName: into.name,
    currentQty,
    par,
    shortage: par - currentQty,
  };
  const sources = locations
    .filter((l) => l.id !== into.id && l.active)
    .sort((a, b) => (SOURCE_TYPE_ORDER[a.type] ?? 9) - (SOURCE_TYPE_ORDER[b.type] ?? 9));
  for (const src of sources) {
    const avail = variant.stockByLocation?.[src.id] ?? 0;
    if (avail > 0) {
      suggestion.sourceLocationId = src.id;
      suggestion.sourceLocationName = src.name;
      suggestion.sourceAvailable = avail;
      break;
    }
  }
  return suggestion;
}

/** The platform's rows as the Alerts cards — exactly its low-stock and reorder rows, none of the device's own. */
export function buildAttentionList(
  attention: readonly StockAttentionView[],
  inventory: InventoryItem[],
  locations: StockLocation[],
  orders: readonly PurchaseOrder[],
): AttentionEntry[] {
  const onOrderMap = buildOnOrderMap(orders);
  const entries: AttentionEntry[] = [];
  for (const row of attention) {
    const low = row.lowStock;
    if ((row.kind !== 'low_stock' && row.kind !== 'reorder') || !low) continue;
    const item =
      inventory.find((i) => i.id === low.groupId) ??
      inventory.find((i) => i.variants.some((v) => v.id === row.stockItemId));
    const shortfalls: Shortfall[] = low.belowPar.map((b) => {
      const variant = item?.variants.find((v) => v.id === b.stockItemId);
      const into =
        locations.find((l) => b.locationId !== null && l.id === b.locationId) ??
        locations.find((l) => b.locationId === null && l.name === b.place);
      return {
        stockItemId: b.stockItemId,
        sizeLabel: item && item.variants.length > 1 ? (variant?.label ?? b.size) : null,
        locationName: b.place,
        currentQty: b.level,
        par: b.par,
        shortage: b.par - b.level,
        ...(item && variant && into ? { transfer: transferFor(item, variant, into, locations, b.level, b.par) } : {}),
      };
    });
    const entry: AttentionEntry = {
      row,
      name: item?.name ?? row.summary.split(': ')[0] ?? row.summary,
      ...(item ? { item } : {}),
      shortfalls,
      atReorderPoint: low.reorder,
      reorderPoint: low.reorderPoint,
      trend: low.reorderRule === 'trend',
      usedInWindow: low.usedInWindow,
      totalStock: low.total,
      reorder: false,
      urgency: 1,
      severity: 0,
    };
    const onOrder = item ? onOrderMap.get(item.id) : undefined;
    if (onOrder) entry.onOrder = onOrder;
    // Pick the primary action: transfer wins only when stock actually exists elsewhere.
    const transferable = shortfalls
      .flatMap((s) => (s.transfer?.sourceLocationId ? [s.transfer] : []))
      .sort((a, b) => (a.currentQty <= 0 ? 0 : 1) - (b.currentQty <= 0 ? 0 : 1) || b.shortage - a.shortage);
    if (transferable.length > 0) entry.transfer = transferable[0];
    // Reorder is the remedy when there is nothing to move and the item has a
    // supplier configured — either because total is at/below the reorder point,
    // or because a location is short with no stock anywhere else.
    if (!entry.transfer && item?.reorderSettings && (entry.atReorderPoint || shortfalls.length > 0)) {
      entry.reorder = true;
    }
    const worstShortfallOut = shortfalls.some((s) => s.currentQty <= 0);
    entry.urgency = entry.totalStock <= 0 || worstShortfallOut ? 0 : 1;
    entry.severity = Math.max(
      entry.atReorderPoint && entry.reorderPoint !== null ? entry.reorderPoint - entry.totalStock : 0,
      ...shortfalls.map((s) => s.shortage),
      0,
    );
    entries.push(entry);
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
  const entries = buildAttentionList(attention, inventory, locations, orders);
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
          Once an item has {STOCK_TREND_HISTORY_DAYS} days of sales, its reorder point follows its usage: what it
          sells on an average day over the last {STOCK_TREND_HISTORY_DAYS} days × lead time, rounded up.
        </span>
      </p>
      {entries.map((e) => (
        <AttentionCard key={e.row.id} entry={e} onStartTransfer={onStartTransfer} onReorder={onReorder} />
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
  const rs = e.item?.reorderSettings;
  const trendWords = e.trend ? ` (${STOCK_TREND_HISTORY_DAYS}-day usage)` : '';

  // Compact one-line summary of why the item is flagged (worst shortfall first).
  const summaryParts: string[] = [];
  if (e.shortfalls.length > 0) {
    const worst = [...e.shortfalls].sort(
      (a, b) => (a.currentQty <= 0 ? 0 : 1) - (b.currentQty <= 0 ? 0 : 1) || b.shortage - a.shortage,
    )[0]!;
    summaryParts.push(`${worst.locationName} ${worst.currentQty}/${worst.par}`);
    if (e.shortfalls.length > 1) summaryParts.push(`+${e.shortfalls.length - 1} more`);
  }
  if (e.atReorderPoint && e.reorderPoint !== null) {
    summaryParts.push(`total ${e.totalStock} ≤ reorder ${e.reorderPoint}${trendWords}`);
  }
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
          {e.name}
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
              <p key={`${s.stockItemId}-${s.locationName}`}>
                Below par at <strong className="text-foreground">{s.locationName}</strong>
                {s.sizeLabel && <span> ({s.sizeLabel})</span>}
                {': '}
                <strong className={s.currentQty <= 0 ? 'text-red-600 dark:text-red-400' : 'text-amber-700 dark:text-amber-400'}>{s.currentQty}</strong>
                <span className="text-foreground/40"> / par {s.par}</span>
                <span className="text-foreground/40"> · short {s.shortage}</span>
              </p>
            ))}
            {e.atReorderPoint && e.reorderPoint !== null && (
              <p>
                Total on hand <strong className="text-foreground">{e.totalStock}</strong>
                <span className="text-foreground/40"> ≤ reorder point {e.reorderPoint}{trendWords}</span>
                {e.trend && e.usedInWindow !== null && (
                  <span className="text-foreground/40">
                    {' '}· {e.usedInWindow} used in the last {STOCK_TREND_HISTORY_DAYS} days
                  </span>
                )}
              </p>
            )}
            {e.row.rule && <p className="text-foreground/40">Rule: {e.row.rule}</p>}
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
                  Reorder at: <strong className="text-foreground">{e.reorderPoint ?? rs.reorderPoint}</strong>
                  {e.trend && <span className="text-foreground/40">{trendWords}</span>}
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
      ) : e.reorder && rs && e.item ? (
        <button
          type="button"
          onClick={(ev) => { ev.stopPropagation(); onReorder(e.item!); }}
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
