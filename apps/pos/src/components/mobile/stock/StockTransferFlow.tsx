import { useState } from 'react';
import { ArrowRight, Check, Search, X } from 'lucide-react';
import { InventoryItem, InventoryVariant, StockLocation } from '@/types';
import { UnitQuantityInput } from './UnitQuantityInput';
import { stockApi, stockErrorWords } from '@/api/stock';

interface TransferItem {
  item: InventoryItem;
  variant: InventoryVariant;
  qty: string;          // raw input string
  eaches: number;
}

interface StockTransferFlowProps {
  /** The platform branch the transfer is written to. */
  branchId: string | null;
  inventory: InventoryItem[];
  locations: StockLocation[];
  // Pre-fill from suggestion tap
  prefill?: {
    item: InventoryItem;
    variant: InventoryVariant;
    fromLocationId: string;
    toLocationId: string;
    qty: number;
  };
  onDone: () => void;
}

export function StockTransferFlow({
  branchId,
  inventory,
  locations,
  prefill,
  onDone,
}: StockTransferFlowProps) {
  const [fromLocId, setFromLocId] = useState(prefill?.fromLocationId ?? locations[1]?.id ?? '');
  const [toLocId, setToLocId] = useState(prefill?.toLocationId ?? locations[2]?.id ?? '');
  const [search, setSearch] = useState('');
  const [items, setItems] = useState<TransferItem[]>(
    prefill
      ? [{ item: prefill.item, variant: prefill.variant, qty: String(prefill.qty), eaches: prefill.qty }]
      : [],
  );
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  /** Lines that actually moved, as the platform answered — the clamp included. */
  const [movedLines, setMovedLines] = useState<Array<{ name: string; requested: number; moved: number }>>([]);

  const activeLocations = locations.filter((l) => l.active);

  // Items available at fromLoc with qty > 0
  const availableItems = inventory.filter((inv) =>
    inv.variants.some((v) =>
      v.stockByLocation ? (v.stockByLocation[fromLocId] ?? 0) > 0 : v.stock > 0,
    ),
  );

  const filteredItems = search.trim()
    ? availableItems.filter((i) => i.name.toLowerCase().includes(search.toLowerCase()))
    : availableItems;

  const addItem = (item: InventoryItem, variant: InventoryVariant) => {
    if (items.some((t) => t.item.id === item.id && t.variant.id === variant.id)) return;
    setItems((prev) => [...prev, { item, variant, qty: '1', eaches: 1 }]);
    setSearch('');
  };

  const updateItem = (idx: number, qty: string, eaches: number) => {
    setItems((prev) => prev.map((t, i) => (i === idx ? { ...t, qty, eaches } : t)));
  };

  const removeItem = (idx: number) => setItems((prev) => prev.filter((_, i) => i !== idx));

  const canSubmit =
    !!branchId &&
    !busy &&
    fromLocId &&
    toLocId &&
    fromLocId !== toLocId &&
    items.length > 0 &&
    items.every((t) => t.eaches > 0);

  const handleSubmit = async () => {
    if (!canSubmit || !branchId) return;
    setBusy(true);
    setError('');
    try {
      // The platform clamps each line to what the source holds at this moment
      // and records what ACTUALLY moved — never the requested qty — so the
      // ledger is always accurate (the prototype's rule, now server-side).
      const result = await stockApi.transfer(branchId, {
        fromLocationId: fromLocId,
        toLocationId: toLocId,
        lines: items.map((t) => ({ stockItemId: t.variant.id, quantity: t.eaches })),
      });
      setMovedLines(
        result.lines.map((line) => {
          const t = items.find((x) => x.variant.id === line.stockItemId);
          const name = t ? `${t.item.name}${t.item.variants.length > 1 ? ` · ${t.variant.label}` : ''}` : '';
          return { name, requested: line.requested, moved: line.moved };
        }),
      );
      setDone(true);
    } catch (err) {
      setError(stockErrorWords(err));
    } finally {
      setBusy(false);
    }
  };

  if (done) {
    const fromName = activeLocations.find((l) => l.id === fromLocId)?.name ?? fromLocId;
    const toName   = activeLocations.find((l) => l.id === toLocId)?.name ?? toLocId;
    const moved = movedLines.filter((l) => l.moved > 0);
    const short = movedLines.filter((l) => l.moved < l.requested);
    return (
      <div className="flex flex-col items-center justify-center py-16 gap-4 text-center px-6">
        <div className="w-16 h-16 rounded-full bg-green-500/15 flex items-center justify-center">
          <Check className="w-8 h-8 text-green-500" />
        </div>
        <div>
          <p className="font-semibold text-lg">Transfer done</p>
          <p className="text-sm text-foreground/50 mt-1">
            {moved.length} item{moved.length !== 1 ? 's' : ''} moved<br />
            {fromName} → {toName}
          </p>
          {short.map((l) => (
            <p key={l.name} className="text-xs text-amber-600 dark:text-amber-400 mt-1">
              {l.name}: only {l.moved} of {l.requested} were at {fromName}
            </p>
          ))}
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
    <div className="flex flex-col gap-5 p-4 pb-20">
      {/* From / To */}
      <div className="grid grid-cols-[1fr_auto_1fr] gap-2 items-center">
        <div className="flex flex-col gap-1">
          <label className="text-[11px] font-semibold uppercase tracking-wider text-foreground/40">From</label>
          <select
            value={fromLocId}
            onChange={(e) => setFromLocId(e.target.value)}
            className="h-10 rounded-lg border border-input bg-background px-2 text-sm"
          >
            {activeLocations.map((l) => (
              <option key={l.id} value={l.id}>{l.name}</option>
            ))}
          </select>
        </div>
        <ArrowRight className="w-4 h-4 text-foreground/30 mt-5" />
        <div className="flex flex-col gap-1">
          <label className="text-[11px] font-semibold uppercase tracking-wider text-foreground/40">To</label>
          <select
            value={toLocId}
            onChange={(e) => setToLocId(e.target.value)}
            className="h-10 rounded-lg border border-input bg-background px-2 text-sm"
          >
            {activeLocations.map((l) => (
              <option key={l.id} value={l.id}>{l.name}</option>
            ))}
          </select>
        </div>
      </div>
      {fromLocId === toLocId && (
        <p className="text-xs text-destructive">From and To must be different.</p>
      )}

      {/* Item search */}
      <div className="relative">
        <Search className="absolute left-3 top-3 w-4 h-4 text-foreground/30 pointer-events-none" />
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search items to transfer…"
          className="h-11 w-full rounded-lg border border-input bg-background pl-9 pr-3 text-sm"
        />
      </div>

      {/* Search results */}
      {search.trim() && (
        <div className="rounded-xl border border-foreground/10 divide-y divide-foreground/5 overflow-hidden">
          {filteredItems.length === 0 ? (
            <p className="px-4 py-3 text-sm text-foreground/40">No items found at {activeLocations.find(l=>l.id===fromLocId)?.name ?? fromLocId}.</p>
          ) : (
            filteredItems.map((inv) =>
              inv.variants.map((v) => {
                const available = v.stockByLocation ? (v.stockByLocation[fromLocId] ?? 0) : v.stock;
                const alreadyAdded = items.some((t) => t.item.id === inv.id && t.variant.id === v.id);
                return (
                  <button
                    key={`${inv.id}-${v.id}`}
                    type="button"
                    disabled={alreadyAdded || available <= 0}
                    onClick={() => addItem(inv, v)}
                    className="w-full flex items-center justify-between px-4 py-3 text-sm text-left
                               hover:bg-foreground/5 disabled:opacity-40 transition-colors"
                  >
                    <span>
                      {inv.name}
                      {inv.variants.length > 1 && <span className="text-foreground/50"> · {v.label}</span>}
                    </span>
                    <span className="text-foreground/50">{available} at src</span>
                  </button>
                );
              }),
            )
          )}
        </div>
      )}

      {/* Batched items */}
      {items.length > 0 && (
        <div className="flex flex-col gap-3">
          <p className="text-xs font-semibold uppercase tracking-wider text-foreground/40">Transfer batch</p>
          {items.map((t, idx) => {
            const available = t.variant.stockByLocation
              ? (t.variant.stockByLocation[fromLocId] ?? 0)
              : t.variant.stock;
            const overQty = t.eaches > available;
            return (
              <div key={idx} className="rounded-xl border border-foreground/10 bg-foreground/[0.02] p-3 flex flex-col gap-2">
                <div className="flex items-center justify-between">
                  <p className="text-sm font-medium">
                    {t.item.name}
                    {t.item.variants.length > 1 && <span className="text-foreground/50"> · {t.variant.label}</span>}
                  </p>
                  <button type="button" onClick={() => removeItem(idx)} className="text-foreground/30 hover:text-destructive transition-colors">
                    <X className="w-4 h-4" />
                  </button>
                </div>
                <p className="text-xs text-foreground/40">Available: {available}</p>
                <UnitQuantityInput
                  units={t.item.units}
                  value={t.qty}
                  onChange={(raw, eaches) => updateItem(idx, raw, eaches)}
                  placeholder="Qty"
                  error={overQty ? `Max ${available} available` : undefined}
                />
              </div>
            );
          })}
        </div>
      )}

      {items.length === 0 && !search.trim() && (
        <p className="text-sm text-foreground/40 text-center py-6">
          Search for items above to add them to the transfer batch.
        </p>
      )}

      <div className="fixed bottom-20 left-0 right-0 px-4">
        {error && <p role="alert" className="mb-2 text-xs text-destructive text-center">{error}</p>}
        <button
          type="button"
          disabled={!canSubmit}
          onClick={() => void handleSubmit()}
          className="w-full h-12 rounded-xl bg-primary text-primary-foreground font-semibold text-sm
                     disabled:opacity-40 transition-opacity"
        >
          Apply transfer ({items.length} item{items.length !== 1 ? 's' : ''})
        </button>
      </div>
    </div>
  );
}
