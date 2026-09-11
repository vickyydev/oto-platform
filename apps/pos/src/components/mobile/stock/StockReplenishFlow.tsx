import { useState } from 'react';
import { Check, Search, Truck, ChevronDown, ChevronUp, AlertTriangle } from 'lucide-react';
import {
  InventoryItem, InventoryVariant, StockLocation, PurchaseOrder, PurchaseOrderLine,
} from '@/types';
import { UnitQuantityInput } from './UnitQuantityInput';
import { recordInventoryAdjustment, getPurchaseOrders, receivePurchaseOrderLine } from '@/mockApi';
import { useOperator } from '@/auth/OperatorContext';

interface StockReplenishFlowProps {
  inventory: InventoryItem[];
  locations: StockLocation[];
  onDone: () => void;
  /** Pre-select this outstanding order (deep link from the Purchase tab). */
  prefillOrderId?: string;
}

const REPLENISH_REASONS = [
  'Received delivery',
  'Supplier top-up',
  'Inventory adjustment',
  'Opening stock',
];

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

function isOverdue(order: PurchaseOrder): boolean {
  if (order.state !== 'ordered' || !order.expectedArrivalDate) return false;
  return order.expectedArrivalDate < new Date().toISOString().slice(0, 10);
}

// ── Per-line receive row (arrived qty + destination location, staff-picked) ──

function OrderLineReceiveRow({
  line,
  inventory,
  locations,
  onReceive,
}: {
  line: PurchaseOrderLine;
  inventory: InventoryItem[];
  locations: StockLocation[];
  onReceive: (lineId: string, qty: number, locationId: string) => void;
}) {
  const [qtyRaw, setQtyRaw] = useState('');
  const [eaches, setEaches] = useState(0);
  // No pre-set default — staff pick the destination every time.
  const [locId, setLocId] = useState('');

  const invItem = inventory.find((i) => i.id === line.inventoryItemId);
  const remaining = line.orderedQty - line.receivedQty;
  const isFullyReceived = remaining <= 0;

  if (isFullyReceived) {
    return (
      <div className="rounded-xl border border-green-500/20 bg-green-500/[0.04] px-3 py-2.5">
        <p className="text-sm font-medium">
          {line.itemName}
          {line.variantLabel !== 'Default' && (
            <span className="text-foreground/50 ml-1 text-xs">· {line.variantLabel}</span>
          )}
        </p>
        <p className="text-xs text-green-400 mt-0.5">
          {line.receivedQty} / {line.orderedQty} eaches received ✓ Complete
        </p>
      </div>
    );
  }

  const canCommit = eaches > 0 && !!locId;

  return (
    <div className="rounded-xl border border-foreground/10 px-3 py-3 flex flex-col gap-2.5">
      <div>
        <p className="text-sm font-medium">
          {line.itemName}
          {line.variantLabel !== 'Default' && (
            <span className="text-foreground/50 ml-1 text-xs">· {line.variantLabel}</span>
          )}
        </p>
        <p className="text-xs text-foreground/50 mt-0.5">
          {line.receivedQty} / {line.orderedQty} eaches received · {remaining} outstanding
        </p>
      </div>

      <UnitQuantityInput
        units={invItem?.units}
        value={qtyRaw}
        onChange={(raw, ea) => { setQtyRaw(raw); setEaches(ea); }}
        label={`Arrived qty (outstanding: ${remaining})`}
      />

      <div className="flex flex-col gap-1">
        <label className="text-xs text-foreground/50">Receive into location *</label>
        <select
          value={locId}
          onChange={(e) => setLocId(e.target.value)}
          className="h-10 rounded-lg border border-input bg-background px-2 text-sm"
        >
          <option value="" disabled>Choose location…</option>
          {locations.filter((l) => l.active).map((l) => (
            <option key={l.id} value={l.id}>{l.name}</option>
          ))}
        </select>
      </div>

      <button
        type="button"
        disabled={!canCommit}
        onClick={() => {
          onReceive(line.id, eaches, locId);
          setQtyRaw('');
          setEaches(0);
          setLocId('');
        }}
        className="h-10 rounded-lg bg-primary text-primary-foreground text-sm font-semibold disabled:opacity-40"
      >
        Receive {eaches > 0 ? `${eaches} eaches` : ''}
      </button>
    </div>
  );
}

// ── Outstanding order card (the ONLY place PO stock is received) ─────────────

function OutstandingOrderCard({
  order,
  inventory,
  locations,
  expanded,
  onToggle,
  onReceiveLine,
}: {
  order: PurchaseOrder;
  inventory: InventoryItem[];
  locations: StockLocation[];
  expanded: boolean;
  onToggle: () => void;
  onReceiveLine: (orderId: string, lineId: string, qty: number, locationId: string) => void;
}) {
  const overdue = isOverdue(order);
  const totalOrdered = order.lines.reduce((s, l) => s + l.orderedQty, 0);
  const totalReceived = order.lines.reduce((s, l) => s + l.receivedQty, 0);

  return (
    <div className={`rounded-2xl border overflow-hidden ${
      overdue ? 'border-destructive/30 bg-destructive/[0.04]' : 'border-blue-500/25 bg-blue-500/[0.04]'
    }`}>
      <button
        type="button"
        onClick={onToggle}
        className="flex items-start gap-3 p-4 text-left w-full"
      >
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <p className="font-semibold text-sm">{order.supplierName}</p>
            {overdue ? (
              <span className="inline-flex items-center gap-1 text-[11px] font-semibold px-2 py-0.5 rounded-full bg-destructive/15 text-destructive">
                <AlertTriangle className="w-3 h-3" />
                Overdue
              </span>
            ) : (
              <span className="inline-flex items-center gap-1 text-[11px] font-semibold px-2 py-0.5 rounded-full bg-blue-500/15 text-blue-400">
                <Truck className="w-3 h-3" />
                Ordered
              </span>
            )}
          </div>
          <p className="text-xs text-foreground/40 mt-1">
            {totalReceived}/{totalOrdered} eaches received
            {order.expectedArrivalDate && (
              <span className={overdue ? ' text-destructive font-medium' : ''}>
                {' · '}Expected {formatDate(order.expectedArrivalDate)}
              </span>
            )}
          </p>
          {order.orderedBy && order.orderedAt && (
            <p className="text-[11px] text-foreground/30 mt-0.5">
              Ordered by {order.orderedBy} on {formatDate(order.orderedAt)}
            </p>
          )}
        </div>
        {expanded
          ? <ChevronUp className="w-4 h-4 text-foreground/40 shrink-0 mt-0.5" />
          : <ChevronDown className="w-4 h-4 text-foreground/40 shrink-0 mt-0.5" />}
      </button>

      {expanded && (
        <div className="flex flex-col gap-2.5 px-4 pb-4">
          {order.lines.map((line) => (
            <OrderLineReceiveRow
              key={line.id}
              line={line}
              inventory={inventory}
              locations={locations}
              onReceive={(lineId, qty, locationId) => onReceiveLine(order.id, lineId, qty, locationId)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ── Manual receive (no purchase order) ───────────────────────────────────────

function ManualReceiveSection({ inventory, locations, onDone }: StockReplenishFlowProps) {
  const { operator } = useOperator();

  const [targetLocId, setTargetLocId] = useState(locations.find((l) => l.active)?.id ?? '');
  const [selectedItem, setSelectedItem] = useState<InventoryItem | null>(null);
  const [selectedVariant, setSelectedVariant] = useState<InventoryVariant | null>(null);
  const [qtyRaw, setQtyRaw] = useState('');
  const [eaches, setEaches] = useState(0);
  const [reason, setReason] = useState('');
  const [customReason, setCustomReason] = useState('');
  const [search, setSearch] = useState('');
  const [done, setDone] = useState(false);

  const activeLocations = locations.filter((l) => l.active);

  const filtered = search.trim()
    ? inventory.filter((i) => i.name.toLowerCase().includes(search.toLowerCase()))
    : inventory;

  const finalReason = reason === '__custom__' ? customReason.trim() : reason;

  const canSubmit =
    targetLocId && selectedItem && selectedVariant && eaches > 0 && finalReason.length > 0;

  const handleSubmit = () => {
    if (!canSubmit || !operator || !selectedItem || !selectedVariant) return;
    // Single canonical stock write: recordInventoryAdjustment adjusts the
    // location-aware stock AND appends the RestockLog entry in one call.
    recordInventoryAdjustment({
      inventoryItemId: selectedItem.id,
      variantId: selectedVariant.id,
      delta: eaches,
      reason: finalReason,
      operator: operator.name,
      operatorId: operator.id,
      locationId: targetLocId,
    });
    setDone(true);
  };

  if (done) {
    const locName = activeLocations.find((l) => l.id === targetLocId)?.name ?? targetLocId;
    const varSuffix = selectedItem && selectedItem.variants.length > 1 && selectedVariant
      ? ` · ${selectedVariant.label}` : '';
    return (
      <div className="flex flex-col items-center justify-center py-12 gap-4 text-center px-6">
        <div className="w-16 h-16 rounded-full bg-green-500/15 flex items-center justify-center">
          <Check className="w-8 h-8 text-green-500" />
        </div>
        <div>
          <p className="font-semibold text-lg">Stock received</p>
          <p className="text-sm text-foreground/50 mt-1">
            +{eaches} eaches of {selectedItem?.name}{varSuffix}<br />
            into {locName}
          </p>
        </div>
        <button
          type="button"
          onClick={onDone}
          className="mt-2 px-6 py-2.5 rounded-xl bg-primary text-primary-foreground font-medium text-sm"
        >
          Done
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-5">
      {/* Target location */}
      <div className="flex flex-col gap-1.5">
        <label className="text-sm font-medium">Receive into location</label>
        <select
          value={targetLocId}
          onChange={(e) => setTargetLocId(e.target.value)}
          className="h-11 rounded-lg border border-input bg-background px-3 text-sm"
        >
          {activeLocations.map((l) => (
            <option key={l.id} value={l.id}>{l.name}</option>
          ))}
        </select>
      </div>

      {/* Item selection */}
      {!selectedItem ? (
        <>
          <div className="relative">
            <Search className="absolute left-3 top-3 w-4 h-4 text-foreground/30 pointer-events-none" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search item to replenish…"
              className="h-11 w-full rounded-lg border border-input bg-background pl-9 pr-3 text-sm"
            />
          </div>
          <div className="rounded-xl border border-foreground/10 divide-y divide-foreground/5 overflow-hidden max-h-64 overflow-y-auto">
            {filtered.map((inv) => (
              <button
                key={inv.id}
                type="button"
                onClick={() => {
                  setSelectedItem(inv);
                  setSelectedVariant(inv.variants.length === 1 ? inv.variants[0] : null);
                  setSearch('');
                }}
                className="w-full flex items-center justify-between gap-2 px-4 py-3 text-sm text-left hover:bg-foreground/5 transition-colors"
              >
                <span className="flex items-center gap-2 min-w-0">
                  {inv.photoUrl && (
                    <img
                      src={inv.photoUrl}
                      alt=""
                      className="w-9 h-9 shrink-0 rounded-md object-cover border border-foreground/10"
                    />
                  )}
                  <span className="truncate">{inv.name}</span>
                </span>
                <span className="text-xs text-foreground/40 capitalize shrink-0">{inv.linkedKind}</span>
              </button>
            ))}
            {filtered.length === 0 && (
              <p className="px-4 py-3 text-sm text-foreground/40">No items found.</p>
            )}
          </div>
        </>
      ) : (
        <>
          {/* Selected item + variant picker */}
          <div className="rounded-xl border border-primary/30 bg-primary/[0.04] p-3 flex items-center gap-3">
            {selectedItem.photoUrl && (
              <img
                src={selectedItem.photoUrl}
                alt=""
                className="w-12 h-12 shrink-0 rounded-lg object-cover border border-foreground/10"
              />
            )}
            <div>
              <p className="font-medium text-sm">{selectedItem.name}</p>
              <button
                type="button"
                onClick={() => { setSelectedItem(null); setSelectedVariant(null); }}
                className="text-xs text-primary underline mt-0.5"
              >
                Change item
              </button>
            </div>
          </div>

          {selectedItem.variants.length > 1 && (
            <div className="flex flex-col gap-1.5">
              <label className="text-sm font-medium">Variant</label>
              <div className="flex flex-wrap gap-2">
                {selectedItem.variants.map((v) => (
                  <button
                    key={v.id}
                    type="button"
                    onClick={() => setSelectedVariant(v)}
                    className={`px-3 py-1.5 rounded-lg border text-sm font-medium transition-colors ${
                      selectedVariant?.id === v.id
                        ? 'border-primary bg-primary/10 text-primary'
                        : 'border-foreground/20 text-foreground/60'
                    }`}
                  >
                    {v.label}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Quantity */}
          {selectedVariant && (
            <UnitQuantityInput
              label="Quantity received"
              units={selectedItem.units}
              value={qtyRaw}
              onChange={(raw, ea) => { setQtyRaw(raw); setEaches(ea); }}
              placeholder={selectedItem.units?.length ? 'e.g. 2 Cases' : 'Qty'}
            />
          )}

          {/* Reason */}
          <div className="flex flex-col gap-2">
            <label className="text-sm font-medium">Reason *</label>
            <div className="flex flex-wrap gap-2">
              {REPLENISH_REASONS.map((r) => (
                <button
                  key={r}
                  type="button"
                  onClick={() => setReason(r)}
                  className={`px-3 py-1.5 rounded-full border text-xs font-medium transition-colors ${
                    reason === r
                      ? 'border-primary bg-primary/10 text-primary'
                      : 'border-foreground/20 text-foreground/60'
                  }`}
                >
                  {r}
                </button>
              ))}
              <button
                type="button"
                onClick={() => setReason('__custom__')}
                className={`px-3 py-1.5 rounded-full border text-xs font-medium transition-colors ${
                  reason === '__custom__'
                    ? 'border-primary bg-primary/10 text-primary'
                    : 'border-foreground/20 text-foreground/60'
                }`}
              >
                Other…
              </button>
            </div>
            {reason === '__custom__' && (
              <input
                type="text"
                value={customReason}
                onChange={(e) => setCustomReason(e.target.value)}
                placeholder="Enter reason…"
                className="h-10 rounded-lg border border-input bg-background px-3 text-sm"
              />
            )}
          </div>

          <button
            type="button"
            disabled={!canSubmit}
            onClick={handleSubmit}
            className="w-full h-12 rounded-xl bg-primary text-primary-foreground font-semibold text-sm
                       disabled:opacity-40 transition-opacity"
          >
            Receive {eaches > 0 ? `${eaches} eaches` : 'stock'}
          </button>
        </>
      )}
    </div>
  );
}

// ── Receive tab: the ONLY place stock is received ────────────────────────────
// Outstanding purchase orders first (from the Purchase list), then a manual
// receive path for deliveries without a PO. The Purchase tab is status-only
// and deep-links here with an order pre-selected.

export function StockReplenishFlow({ inventory, locations, onDone, prefillOrderId }: StockReplenishFlowProps) {
  const { operator } = useOperator();
  const [tick, setTick] = useState(0);
  const [expandedOrderId, setExpandedOrderId] = useState<string | null>(prefillOrderId ?? null);

  void tick;

  // Outstanding = placed with the supplier but not fully received yet.
  const outstanding = getPurchaseOrders().filter((o) => o.state === 'ordered');

  const handleReceiveLine = (orderId: string, lineId: string, qty: number, locationId: string) => {
    if (!operator) return;
    receivePurchaseOrderLine({
      orderId,
      lineId,
      receivedQty: qty,
      locationId,
      operator: operator.name,
      operatorId: operator.id,
    });
    setTick((t) => t + 1);
  };

  return (
    <div className="flex flex-col gap-6 p-4 pb-24">
      {/* Outstanding purchase orders */}
      <div className="flex flex-col gap-3">
        <div>
          <h3 className="text-sm font-semibold">Incoming orders</h3>
          <p className="text-xs text-foreground/40 mt-0.5">
            Placed supplier orders awaiting delivery. Receive lines here — you choose the destination location each time.
          </p>
        </div>
        {outstanding.length === 0 ? (
          <p className="text-xs text-foreground/40 italic rounded-xl border border-foreground/10 px-3 py-3">
            No outstanding orders. Orders marked "Ordered" in the Purchase tab appear here.
          </p>
        ) : (
          outstanding.map((o) => (
            <OutstandingOrderCard
              key={o.id}
              order={o}
              inventory={inventory}
              locations={locations}
              expanded={expandedOrderId === o.id}
              onToggle={() => setExpandedOrderId(expandedOrderId === o.id ? null : o.id)}
              onReceiveLine={handleReceiveLine}
            />
          ))
        )}
      </div>

      {/* Manual receive (no PO) */}
      <div className="flex flex-col gap-3">
        <div>
          <h3 className="text-sm font-semibold">Manual receive</h3>
          <p className="text-xs text-foreground/40 mt-0.5">
            Stock arriving without a purchase order (top-ups, opening stock, corrections).
          </p>
        </div>
        <ManualReceiveSection inventory={inventory} locations={locations} onDone={onDone} />
      </div>
    </div>
  );
}
