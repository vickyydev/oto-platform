import { useState } from 'react';
import {
  ShoppingCart, ChevronDown, ChevronUp, Check, Clock, Truck,
  Edit2, Trash2, AlertTriangle, Plus, ArrowRight,
} from 'lucide-react';
import { InventoryItem, PurchaseOrder, PurchaseOrderLine } from '@/types';
import { stockApi, stockErrorWords } from '@/api/stock';
import { UnitQuantityInput } from './UnitQuantityInput';

interface StockPurchasingProps {
  /** The platform branch orders are written to. */
  branchId: string | null;
  inventory: InventoryItem[];
  /** The branch's purchase orders, from the platform (newest first). */
  orders: PurchaseOrder[];
  /** Navigate to the Receive tab with this order pre-selected. Purchase never mutates stock. */
  onGoToReceive: (orderId: string) => void;
}

// ISO date string for today + N days
function addDays(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

function isOverdue(order: PurchaseOrder): boolean {
  if (order.state !== 'ordered' || !order.expectedArrivalDate) return false;
  return order.expectedArrivalDate < new Date().toISOString().slice(0, 10);
}

// ── Ordering badge ───────────────────────────────────────────────────────────

function StateBadge({ state, overdue }: { state: PurchaseOrder['state']; overdue?: boolean }) {
  if (state === 'to_order') {
    return (
      <span className="inline-flex items-center gap-1 text-[11px] font-semibold px-2 py-0.5 rounded-full bg-amber-500/15 text-amber-400">
        <Clock className="w-3 h-3" />
        To order
      </span>
    );
  }
  if (state === 'ordered') {
    return (
      <span className={`inline-flex items-center gap-1 text-[11px] font-semibold px-2 py-0.5 rounded-full ${
        overdue ? 'bg-destructive/15 text-destructive' : 'bg-blue-500/15 text-blue-400'
      }`}>
        {overdue ? <AlertTriangle className="w-3 h-3" /> : <Truck className="w-3 h-3" />}
        {overdue ? 'Overdue' : 'Ordered'}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 text-[11px] font-semibold px-2 py-0.5 rounded-full bg-green-500/15 text-green-400">
      <Check className="w-3 h-3" />
      Received
    </span>
  );
}

// ── Add-to-order panel (any item on demand) ─────────────────────────────────

function AddItemPanel({
  inventory,
  onAdd,
  onClose,
}: {
  inventory: InventoryItem[];
  onAdd: (item: InventoryItem, variantId: string, qty: number) => void;
  onClose: () => void;
}) {
  const [search, setSearch] = useState('');
  const [selectedItem, setSelectedItem] = useState<InventoryItem | null>(null);
  const [selectedVariantId, setSelectedVariantId] = useState('');
  const [qtyRaw, setQtyRaw] = useState('');
  const [eaches, setEaches] = useState(0);

  const filtered = search.trim()
    ? inventory.filter((i) => i.name.toLowerCase().includes(search.toLowerCase()))
    : inventory.filter((i) => !!i.reorderSettings);

  const handleAdd = () => {
    if (!selectedItem || !selectedVariantId || eaches <= 0) return;
    onAdd(selectedItem, selectedVariantId, eaches);
    onClose();
  };

  return (
    <div className="rounded-2xl border border-foreground/15 bg-foreground/[0.03] p-4 flex flex-col gap-4">
      <p className="text-sm font-semibold">Add item to order</p>

      {!selectedItem ? (
        <>
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search items…"
            className="h-10 w-full rounded-lg border border-input bg-background px-3 text-sm"
          />
          <div className="rounded-xl border border-foreground/10 divide-y divide-foreground/5 overflow-hidden max-h-52 overflow-y-auto">
            {filtered.map((inv) => (
              <button
                key={inv.id}
                type="button"
                onClick={() => {
                  setSelectedItem(inv);
                  setSelectedVariantId(inv.variants[0].id);
                  const rs = inv.reorderSettings;
                  if (rs) {
                    setQtyRaw(String(rs.reorderQty));
                    setEaches(rs.reorderQty);
                  }
                }}
                className="w-full flex items-center justify-between gap-2 px-4 py-3 text-sm text-left hover:bg-foreground/5"
              >
                <span className="truncate">{inv.name}</span>
                {inv.reorderSettings && (
                  <span className="text-xs text-foreground/40 shrink-0">{inv.reorderSettings.supplierName}</span>
                )}
              </button>
            ))}
            {filtered.length === 0 && (
              <p className="px-4 py-3 text-sm text-foreground/40">No items found.</p>
            )}
          </div>
          <button type="button" onClick={onClose} className="text-xs text-foreground/40 underline self-start">Cancel</button>
        </>
      ) : (
        <>
          <div className="rounded-xl border border-foreground/10 bg-foreground/[0.02] px-3 py-2 flex items-center justify-between gap-2">
            <span className="text-sm font-medium">{selectedItem.name}</span>
            <button type="button" onClick={() => setSelectedItem(null)} className="text-xs text-primary underline">Change</button>
          </div>

          {selectedItem.variants.length > 1 && (
            <div className="flex flex-wrap gap-2">
              {selectedItem.variants.map((v) => (
                <button
                  key={v.id}
                  type="button"
                  onClick={() => setSelectedVariantId(v.id)}
                  className={`px-3 py-1.5 rounded-lg border text-sm font-medium transition-colors ${
                    selectedVariantId === v.id
                      ? 'border-primary bg-primary/10 text-primary'
                      : 'border-foreground/20 text-foreground/60'
                  }`}
                >
                  {v.label}
                </button>
              ))}
            </div>
          )}

          <UnitQuantityInput
            label="Quantity (eaches)"
            units={selectedItem.units}
            value={qtyRaw}
            onChange={(raw, ea) => { setQtyRaw(raw); setEaches(ea); }}
          />

          {selectedItem.reorderSettings && (
            <p className="text-xs text-foreground/40">Supplier: {selectedItem.reorderSettings.supplierName}</p>
          )}

          <div className="flex gap-2">
            <button
              type="button"
              onClick={handleAdd}
              disabled={eaches <= 0}
              className="flex-1 h-10 rounded-xl bg-primary text-primary-foreground text-sm font-semibold disabled:opacity-40"
            >
              Add to order
            </button>
            <button
              type="button"
              onClick={onClose}
              className="px-4 h-10 rounded-xl border border-foreground/20 text-sm text-foreground/60"
            >
              Cancel
            </button>
          </div>
        </>
      )}
    </div>
  );
}

// ── Line row (to_order: editable qty + remove; ordered: status only) ─────────

function LineRow({
  order,
  line,
  inventory,
  onUpdateQty,
  onRemove,
}: {
  order: PurchaseOrder;
  line: PurchaseOrderLine;
  inventory: InventoryItem[];
  onUpdateQty: (lineId: string, qty: number) => void;
  onRemove: (lineId: string) => void;
}) {
  const [editingQty, setEditingQty] = useState(false);
  const [qtyRaw, setQtyRaw] = useState(String(line.orderedQty));
  const [eaches, setEaches] = useState(line.orderedQty);

  const invItem = inventory.find((i) => i.id === line.inventoryItemId);
  const isFullyReceived = line.receivedQty >= line.orderedQty;

  const handleSaveQty = () => {
    if (eaches > 0) onUpdateQty(line.id, eaches);
    setEditingQty(false);
  };

  return (
    <div className={`rounded-xl border px-3 py-3 flex flex-col gap-2 ${
      isFullyReceived ? 'border-green-500/20 bg-green-500/[0.04]' : 'border-foreground/10'
    }`}>
      <div className="flex items-center gap-2">
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium">
            {line.itemName}
            {line.variantLabel !== 'Default' && (
              <span className="text-foreground/50 ml-1 text-xs">· {line.variantLabel}</span>
            )}
          </p>
          <p className="text-xs text-foreground/50 mt-0.5">
            {line.receivedQty} / {line.orderedQty} eaches received
            {isFullyReceived && <span className="ml-1 text-green-400">✓ Complete</span>}
          </p>
        </div>

        {order.state === 'to_order' && !isFullyReceived && (
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => { setEditingQty(!editingQty); setQtyRaw(String(line.orderedQty)); setEaches(line.orderedQty); }}
              className="p-1.5 rounded-lg hover:bg-foreground/5 text-foreground/40 hover:text-foreground/70"
            >
              <Edit2 className="w-3.5 h-3.5" />
            </button>
            <button
              type="button"
              onClick={() => onRemove(line.id)}
              className="p-1.5 rounded-lg hover:bg-destructive/10 text-foreground/40 hover:text-destructive"
            >
              <Trash2 className="w-3.5 h-3.5" />
            </button>
          </div>
        )}

      </div>

      {editingQty && (
        <div className="flex items-center gap-2 mt-1">
          <UnitQuantityInput
            units={invItem?.units}
            value={qtyRaw}
            onChange={(raw, ea) => { setQtyRaw(raw); setEaches(ea); }}
            placeholder="Qty"
          />
          <button
            type="button"
            onClick={handleSaveQty}
            className="px-3 h-10 rounded-lg bg-primary text-primary-foreground text-sm font-medium"
          >
            Save
          </button>
        </div>
      )}
    </div>
  );
}

// ── Order card ───────────────────────────────────────────────────────────────

function OrderCard({
  branchId,
  order,
  inventory,
  onGoToReceive,
}: {
  branchId: string | null;
  order: PurchaseOrder;
  inventory: InventoryItem[];
  onGoToReceive: (orderId: string) => void;
}) {
  const [error, setError] = useState('');
  /** Run one write to the platform; its refusal shows on the card. */
  const run = async (write: (branch: string) => Promise<unknown>): Promise<boolean> => {
    if (!branchId) return false;
    setError('');
    try {
      await write(branchId);
      return true;
    } catch (err) {
      setError(stockErrorWords(err));
      return false;
    }
  };
  const [expanded, setExpanded] = useState(order.state !== 'received');
  const [markOrdering, setMarkOrdering] = useState(false);
  const [arrivalDate, setArrivalDate] = useState(
    order.expectedArrivalDate ??
    addDays(
      // default = today + max(leadTimeDays) of items in this order
      Math.max(
        1,
        ...order.lines.map((l) => {
          const item = inventory.find((i) => i.id === l.inventoryItemId);
          return item?.reorderSettings?.leadTimeDays ?? 1;
        })
      )
    )
  );
  const [notes, setNotes] = useState(order.notes ?? '');

  const overdue = isOverdue(order);

  const handleMarkOrdered = async () => {
    const ok = await run((branch) =>
      stockApi.markOrdered(branch, order.id, {
        expectedArrivalDate: arrivalDate,
        ...(notes.trim() ? { notes: notes.trim() } : {}),
      }),
    );
    if (ok) setMarkOrdering(false);
  };

  const handleUpdateQty = (lineId: string, qty: number) => {
    void run((branch) => stockApi.setOrderLineQuantity(branch, order.id, lineId, qty));
  };

  const handleRemoveLine = (lineId: string) => {
    void run((branch) => stockApi.removeOrderLine(branch, order.id, lineId));
  };

  const totalLines = order.lines.length;
  const receivedLines = order.lines.filter((l) => l.receivedQty >= l.orderedQty).length;

  return (
    <div className={`rounded-2xl border flex flex-col overflow-hidden ${
      order.state === 'received'
        ? 'border-green-500/20 bg-green-500/[0.03]'
        : overdue
        ? 'border-destructive/30 bg-destructive/[0.04]'
        : order.state === 'ordered'
        ? 'border-blue-500/25 bg-blue-500/[0.04]'
        : 'border-foreground/15 bg-foreground/[0.02]'
    }`}>
      {/* Header */}
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="flex items-start gap-3 p-4 text-left w-full"
      >
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <p className="font-semibold text-sm">{order.supplierName}</p>
            <StateBadge state={order.state} overdue={overdue} />
          </div>
          <p className="text-xs text-foreground/40 mt-1">
            {totalLines} line{totalLines !== 1 ? 's' : ''}
            {order.state !== 'to_order' && ` · ${receivedLines}/${totalLines} received`}
            {order.expectedArrivalDate && order.state === 'ordered' && (
              <span className={overdue ? ' · text-destructive font-medium' : ''}>
                {' · '}Expected {formatDate(order.expectedArrivalDate)}
              </span>
            )}
          </p>
          <p className="text-[11px] text-foreground/30 mt-0.5">
            Created {formatDate(order.createdAt)} by {order.createdBy}
          </p>
        </div>
        {expanded ? <ChevronUp className="w-4 h-4 text-foreground/40 shrink-0 mt-0.5" /> : <ChevronDown className="w-4 h-4 text-foreground/40 shrink-0 mt-0.5" />}
      </button>

      {expanded && (
        <div className="flex flex-col gap-3 px-4 pb-4">
          {/* Lines */}
          {order.lines.map((line) => (
            <LineRow
              key={line.id}
              order={order}
              line={line}
              inventory={inventory}
              onUpdateQty={handleUpdateQty}
              onRemove={handleRemoveLine}
            />
          ))}

          {order.supplierContact && (
            <p className="text-xs text-foreground/40">Contact: {order.supplierContact}</p>
          )}

          {order.notes && (
            <p className="text-xs text-foreground/50 italic">"{order.notes}"</p>
          )}

          {error && <p role="alert" className="text-xs text-destructive">{error}</p>}

          {/* Mark as Ordered CTA */}
          {order.state === 'to_order' && (
            <>
              {!markOrdering ? (
                <button
                  type="button"
                  onClick={() => setMarkOrdering(true)}
                  className="w-full h-11 rounded-xl bg-blue-600 text-white font-semibold text-sm hover:bg-blue-500 transition-colors mt-1"
                >
                  Mark as Ordered
                </button>
              ) : (
                <div className="rounded-xl border border-blue-500/30 bg-blue-500/[0.06] p-4 flex flex-col gap-3 mt-1">
                  <p className="text-sm font-medium text-blue-300">Confirm order placed</p>
                  <div className="flex flex-col gap-1">
                    <label className="text-xs text-foreground/50">Expected arrival date</label>
                    <input
                      type="date"
                      value={arrivalDate}
                      onChange={(e) => setArrivalDate(e.target.value)}
                      className="h-10 rounded-lg border border-input bg-background px-3 text-sm"
                    />
                  </div>
                  <div className="flex flex-col gap-1">
                    <label className="text-xs text-foreground/50">Notes (optional)</label>
                    <input
                      type="text"
                      value={notes}
                      onChange={(e) => setNotes(e.target.value)}
                      placeholder="PO number, reference…"
                      className="h-10 rounded-lg border border-input bg-background px-3 text-sm"
                    />
                  </div>
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={() => void handleMarkOrdered()}
                      className="flex-1 h-10 rounded-xl bg-blue-600 text-white font-semibold text-sm hover:bg-blue-500"
                    >
                      Confirm ordered
                    </button>
                    <button
                      type="button"
                      onClick={() => setMarkOrdering(false)}
                      className="px-4 h-10 rounded-xl border border-foreground/20 text-sm text-foreground/60"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              )}
            </>
          )}

          {order.state === 'ordered' && (
            <>
              <div className="flex items-center gap-2 text-xs text-foreground/40 mt-1">
                <Truck className="w-3.5 h-3.5" />
                <span>Ordered by {order.orderedBy} on {formatDate(order.orderedAt!)} · Stock incoming.</span>
              </div>
              {/* Receiving happens ONLY in the Receive tab — this is a status view. */}
              <button
                type="button"
                onClick={() => onGoToReceive(order.id)}
                className="flex items-center justify-between w-full rounded-xl bg-primary/10 border border-primary/20
                           px-3 py-2.5 text-sm font-medium text-primary hover:bg-primary/15 transition-colors"
              >
                <span>Receive in Receive tab</span>
                <ArrowRight className="w-4 h-4 shrink-0" />
              </button>
            </>
          )}

          {order.state === 'received' && (
            <div className="flex items-center gap-2 text-xs text-green-400/70 mt-1">
              <Check className="w-3.5 h-3.5" />
              <span>Fully received by {order.receivedBy} on {formatDate(order.receivedAt!)}</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Main StockPurchasing panel ───────────────────────────────────────────────

export function StockPurchasing({ branchId, inventory, orders, onGoToReceive }: StockPurchasingProps) {
  const [showAddItem, setShowAddItem] = useState(false);
  const [filterState, setFilterState] = useState<'all' | 'active' | 'received'>('active');
  const [error, setError] = useState('');

  // The platform's orders, read back after every write (`api/stock.ts`).
  const allOrders = orders;

  const filtered =
    filterState === 'active'
      ? allOrders.filter((o) => o.state !== 'received')
      : filterState === 'received'
      ? allOrders.filter((o) => o.state === 'received')
      : allOrders;

  const handleAddItem = (_item: InventoryItem, variantId: string, qty: number) => {
    if (!branchId) return;
    // The platform puts it on the supplier's open order — the item's own
    // supplier, "Unknown supplier" when none is set — and merges a repeat size.
    setError('');
    stockApi.addToOrders(branchId, [{ stockItemId: variantId, quantity: qty }]).catch((err: unknown) => {
      setError(stockErrorWords(err));
    });
  };

  return (
    <div className="flex flex-col gap-4 p-4 pb-24">

      {/* Backend prediction note */}
      <div className="rounded-xl border border-foreground/10 bg-foreground/[0.02] px-3 py-2.5 text-[11px] text-foreground/40 leading-relaxed">
        <span className="font-semibold text-foreground/50">Note (future backend):</span> True auto-reorder
        (stock ≤ usage rate × lead time) requires server-side consumption history. The prototype uses the
        static reorder point set per item in Admin Inventory. Items below their reorder point appear as
        "Needs reordering" in the Suggestions tab.
      </div>

      {/* Controls row */}
      <div className="flex items-center gap-2">
        <div className="flex rounded-lg border border-foreground/15 overflow-hidden text-xs font-medium">
          {(['active', 'received', 'all'] as const).map((f) => (
            <button
              key={f}
              type="button"
              onClick={() => setFilterState(f)}
              className={`px-3 py-1.5 transition-colors ${
                filterState === f ? 'bg-foreground/10 text-foreground' : 'text-foreground/50'
              }`}
            >
              {f === 'active' ? 'Active' : f === 'received' ? 'Received' : 'All'}
            </button>
          ))}
        </div>
        <button
          type="button"
          onClick={() => setShowAddItem(!showAddItem)}
          className="ml-auto flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-foreground/20 text-xs font-medium text-foreground/60 hover:text-foreground hover:border-foreground/30 transition-colors"
        >
          <Plus className="w-3.5 h-3.5" />
          Add item
        </button>
      </div>

      {error && <p role="alert" className="text-xs text-destructive">{error}</p>}

      {/* Add item panel */}
      {showAddItem && (
        <AddItemPanel
          inventory={inventory}
          onAdd={handleAddItem}
          onClose={() => setShowAddItem(false)}
        />
      )}

      {/* Orders */}
      {filtered.length === 0 && !showAddItem && (
        <div className="flex flex-col items-center justify-center py-16 gap-3 text-center">
          <ShoppingCart className="w-10 h-10 text-foreground/20" />
          <p className="text-sm text-foreground/50">
            {filterState === 'active'
              ? 'No active purchase orders. Tap "Reorder" on the Suggestions tab or add an item above.'
              : filterState === 'received'
              ? 'No received orders yet.'
              : 'No purchase orders yet.'}
          </p>
        </div>
      )}

      {filtered.map((order) => (
        <OrderCard
          key={order.id}
          branchId={branchId}
          order={order}
          inventory={inventory}
          onGoToReceive={onGoToReceive}
        />
      ))}
    </div>
  );
}
