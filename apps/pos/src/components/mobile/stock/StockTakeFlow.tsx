import { useState } from 'react';
import { AlertTriangle, Check, ChevronDown, ChevronUp } from 'lucide-react';
import { STOCK_TAKE_FLAG_THRESHOLD } from '@oto/shared';
import { InventoryItem, InventoryVariant, StockLocation } from '@/types';
import { UnitQuantityInput } from './UnitQuantityInput';
import { stockApi, stockErrorWords } from '@/api/stock';

// Discrepancy threshold: flag if |discrepancy| > this many eaches (OD-S1; the
// platform applies the same figure and is the one that records it).
const DISCREPANCY_THRESHOLD = STOCK_TAKE_FLAG_THRESHOLD;

interface CountRow {
  item: InventoryItem;
  variant: InventoryVariant;
  expectedQty: number;
  qtyRaw: string;
  eaches: number;
}

interface AdjustedRow {
  itemName: string;
  variantLabel: string;
  multiVariant: boolean;
  expectedQty: number;
  countedQty: number;
  delta: number;
  flagged: boolean;
}

interface StockTakeFlowProps {
  /** The platform branch the count is committed to. */
  branchId: string | null;
  inventory: InventoryItem[];
  locations: StockLocation[];
  onDone: () => void;
}

export function StockTakeFlow({ branchId, inventory, locations, onDone }: StockTakeFlowProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  /** True when the platform recorded this count as the branch's opening (OD-S5). */
  const [opening, setOpening] = useState(false);
  const [locationId, setLocationId] = useState(locations.find((l) => l.active)?.id ?? '');
  const [phase, setPhase] = useState<'count' | 'review' | 'done'>('count');
  const [rows, setRows] = useState<CountRow[]>([]);
  const [expandedItems, setExpandedItems] = useState<Set<string>>(new Set());
  const [adjustedRows, setAdjustedRows] = useState<AdjustedRow[]>([]);

  const activeLocations = locations.filter((l) => l.active);

  // Build count rows from inventory at the selected location
  const buildRows = (): CountRow[] =>
    inventory.flatMap((item) =>
      item.variants.map((v) => {
        const expectedQty = v.stockByLocation
          ? (v.stockByLocation[locationId] ?? 0)
          : v.stock;
        return {
          item,
          variant: v,
          expectedQty,
          qtyRaw: '',
          eaches: 0,
        };
      }),
    );

  const initCount = () => setRows(buildRows());

  const updateRow = (itemId: string, variantId: string, qtyRaw: string, eaches: number) => {
    setRows((prev) =>
      prev.map((r) =>
        r.item.id === itemId && r.variant.id === variantId
          ? { ...r, qtyRaw, eaches }
          : r,
      ),
    );
  };

  const toggleExpand = (key: string) =>
    setExpandedItems((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });

  // Rows that have been counted (qtyRaw not empty, and a whole number of eaches —
  // a refused entry shows its reason under the field and is not counted).
  const countedRows = rows.filter((r) => r.qtyRaw.trim() !== '' && Number.isInteger(r.eaches));

  const rowsWithDiscrepancy = countedRows.map((r) => ({
    ...r,
    discrepancy: r.eaches - r.expectedQty,
    flagged: Math.abs(r.eaches - r.expectedQty) > DISCREPANCY_THRESHOLD,
  }));

  const flaggedRows = rowsWithDiscrepancy.filter((r) => r.flagged);
  const cleanRows = rowsWithDiscrepancy.filter((r) => !r.flagged);

  const handleCommit = async () => {
    if (!branchId || busy) return;
    setBusy(true);
    setError('');
    try {
      // Auto-adjust ALL rows with a discrepancy (no manager approval gate,
      // OD-S1). The platform sets each counted shelf to what was counted,
      // against the record AT COMMIT — a sale rung up while the count was under
      // way is not counted twice — flags a difference above three, writes a
      // take line for every counted shelf (exact matches included, so the
      // Discrepancies report has the full history) and audits it.
      const take = await stockApi.commitStockTake(
        branchId,
        rowsWithDiscrepancy.map((r) => ({ stockItemId: r.variant.id, locationId, countedQuantity: r.eaches })),
      );
      const committed: AdjustedRow[] = [];
      for (const line of take.lines) {
        if (line.difference === 0) continue;
        const r = rowsWithDiscrepancy.find((x) => x.variant.id === line.stockItemId);
        if (!r) continue;
        committed.push({
          itemName: r.item.name,
          variantLabel: r.variant.label,
          multiVariant: r.item.variants.length > 1,
          expectedQty: line.expectedQuantity,
          countedQty: line.countedQuantity,
          delta: line.difference,
          flagged: line.flagged,
        });
      }
      setOpening(take.opening);
      setAdjustedRows(committed);
      setPhase('done');
    } catch (err) {
      setError(stockErrorWords(err));
    } finally {
      setBusy(false);
    }
  };

  if (phase === 'done') {
    const locName = activeLocations.find((l) => l.id === locationId)?.name ?? locationId;
    return (
      <div className="flex flex-col gap-4 p-4 pb-24">
        <div className="flex flex-col items-center py-8 gap-3 text-center">
          <div className="w-16 h-16 rounded-full bg-green-500/15 flex items-center justify-center">
            <Check className="w-8 h-8 text-green-500" />
          </div>
          <div>
            <p className="font-semibold text-lg">Stock take complete</p>
            <p className="text-sm text-foreground/50 mt-1">
              {countedRows.length} item{countedRows.length !== 1 ? 's' : ''} counted at {locName}
            </p>
            {opening && (
              <p className="text-xs text-foreground/40 mt-1">Recorded as this branch’s opening count.</p>
            )}
          </div>
        </div>

        {/* Adjustment summary */}
        {adjustedRows.length > 0 ? (
          <div className="flex flex-col gap-2">
            <p className="text-xs font-semibold uppercase tracking-wider text-foreground/50">
              Adjusted ({adjustedRows.length})
            </p>
            {adjustedRows.map((r, i) => {
              const varSuffix = r.multiVariant ? ` · ${r.variantLabel}` : '';
              return (
                <div
                  key={i}
                  className={`rounded-xl border px-3 py-2.5 flex items-center justify-between gap-2 ${
                    r.flagged ? 'border-destructive/20 bg-destructive/[0.04]' : 'border-foreground/10'
                  }`}
                >
                  <div className="min-w-0">
                    <p className="text-sm font-medium truncate">
                      {r.flagged && <AlertTriangle className="inline w-3.5 h-3.5 text-destructive mr-1 -mt-0.5" />}
                      {r.itemName}{varSuffix}
                    </p>
                    <p className="text-xs text-foreground/40 mt-0.5">
                      Expected {r.expectedQty} → counted {r.countedQty}
                    </p>
                  </div>
                  <span className={`text-sm font-bold shrink-0 ${r.delta < 0 ? 'text-destructive' : 'text-amber-400'}`}>
                    {r.delta > 0 ? '+' : ''}{r.delta}
                  </span>
                </div>
              );
            })}
          </div>
        ) : (
          <div className="rounded-xl border border-green-500/20 bg-green-500/[0.04] px-4 py-3 text-sm text-green-400 text-center">
            No discrepancies — all counts matched expected stock.
          </div>
        )}

        <button
          type="button"
          onClick={onDone}
          className="mt-2 w-full h-12 rounded-xl bg-primary text-primary-foreground font-semibold text-sm"
        >
          Done
        </button>
      </div>
    );
  }

  if (phase === 'review') {
    const locName = activeLocations.find((l) => l.id === locationId)?.name ?? locationId;
    return (
      <div className="flex flex-col gap-4 p-4 pb-24">
        <div>
          <p className="font-semibold">Review — {locName}</p>
          <p className="text-xs text-foreground/50 mt-0.5">
            {countedRows.length} counted · {flaggedRows.length} flagged
          </p>
        </div>

        {flaggedRows.length > 0 && (
          <div className="flex flex-col gap-2">
            <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-destructive">
              <AlertTriangle className="w-3.5 h-3.5" />
              Large discrepancies — will auto-adjust on commit
            </div>
            {flaggedRows.map((r) => {
              const key = `${r.item.id}:${r.variant.id}`;
              const varSuffix = r.item.variants.length > 1 ? ` · ${r.variant.label}` : '';
              return (
                <div key={key} className="rounded-xl border border-destructive/30 bg-destructive/[0.04] p-4 flex flex-col gap-2">
                  <div className="flex items-center gap-2 min-w-0">
                    {r.item.photoUrl && (
                      <img
                        src={r.item.photoUrl}
                        alt=""
                        className="w-9 h-9 shrink-0 rounded-md object-cover border border-foreground/10"
                      />
                    )}
                    <p className="font-medium text-sm truncate">{r.item.name}{varSuffix}</p>
                  </div>
                  <div className="grid grid-cols-3 text-xs gap-1">
                    <div className="text-center">
                      <p className="text-foreground/40">Expected</p>
                      <p className="font-bold">{r.expectedQty}</p>
                    </div>
                    <div className="text-center">
                      <p className="text-foreground/40">Counted</p>
                      <p className="font-bold">{r.eaches}</p>
                    </div>
                    <div className="text-center">
                      <p className="text-foreground/40">Diff</p>
                      <p className={`font-bold ${r.discrepancy < 0 ? 'text-destructive' : 'text-amber-600 dark:text-amber-400'}`}>
                        {r.discrepancy > 0 ? '+' : ''}{r.discrepancy}
                      </p>
                    </div>
                  </div>
                  <p className="text-xs text-foreground/40 italic">
                    Stock will be auto-adjusted to the counted value and flagged in the variance log.
                  </p>
                </div>
              );
            })}
          </div>
        )}

        {cleanRows.length > 0 && (
          <div className="flex flex-col gap-1.5">
            <p className="text-xs font-semibold uppercase tracking-wider text-foreground/40">
              Clean ({cleanRows.length})
            </p>
            {cleanRows.map((r) => {
              const key = `${r.item.id}:${r.variant.id}`;
              const varSuffix = r.item.variants.length > 1 ? ` · ${r.variant.label}` : '';
              const expanded = expandedItems.has(key);
              return (
                <button
                  key={key}
                  type="button"
                  onClick={() => toggleExpand(key)}
                  className="rounded-xl border border-foreground/10 bg-foreground/[0.02] p-3
                             flex items-center justify-between text-sm text-left"
                >
                  <span>
                    {r.item.name}{varSuffix}
                    <span className="text-foreground/40 ml-2 text-xs">
                      {r.discrepancy === 0 ? '✓ exact' : `diff ${r.discrepancy > 0 ? '+' : ''}${r.discrepancy}`}
                    </span>
                  </span>
                  {expanded ? <ChevronUp className="w-4 h-4 text-foreground/30" /> : <ChevronDown className="w-4 h-4 text-foreground/30" />}
                </button>
              );
            })}
          </div>
        )}

        <div className="fixed bottom-20 left-0 right-0 px-4">
          {error && <p role="alert" className="mb-2 text-xs text-destructive text-center">{error}</p>}
          <button
            type="button"
            disabled={busy || !branchId}
            onClick={() => void handleCommit()}
            className="w-full h-12 rounded-xl bg-primary text-primary-foreground font-semibold text-sm disabled:opacity-40"
          >
            Commit stock take
          </button>
        </div>
      </div>
    );
  }

  // Phase: count
  return (
    <div className="flex flex-col gap-4 p-4 pb-24">
      {/* Location picker */}
      <div className="flex flex-col gap-1.5">
        <label className="text-sm font-medium">Location to count</label>
        <select
          value={locationId}
          onChange={(e) => { setLocationId(e.target.value); setRows([]); }}
          className="h-11 rounded-lg border border-input bg-background px-3 text-sm"
        >
          {activeLocations.map((l) => (
            <option key={l.id} value={l.id}>{l.name}</option>
          ))}
        </select>
      </div>

      {rows.length === 0 ? (
        <button
          type="button"
          onClick={initCount}
          className="h-12 rounded-xl bg-primary text-primary-foreground font-semibold text-sm"
        >
          Start count
        </button>
      ) : (
        <>
          <p className="text-xs text-foreground/50">
            Enter counted quantities for each item. Leave blank to skip.
          </p>
          {rows.map((r) => {
            const key = `${r.item.id}:${r.variant.id}`;
            const varSuffix = r.item.variants.length > 1 ? ` · ${r.variant.label}` : '';
            return (
              <div key={key} className="rounded-xl border border-foreground/10 bg-foreground/[0.02] p-3 flex flex-col gap-2">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2 min-w-0">
                    {r.item.photoUrl && (
                      <img
                        src={r.item.photoUrl}
                        alt=""
                        className="w-9 h-9 shrink-0 rounded-md object-cover border border-foreground/10"
                      />
                    )}
                    <p className="text-sm font-medium truncate">{r.item.name}{varSuffix}</p>
                  </div>
                  <p className="text-xs text-foreground/40 shrink-0">Expected: {r.expectedQty}</p>
                </div>
                <UnitQuantityInput
                  units={r.item.units}
                  value={r.qtyRaw}
                  onChange={(raw, ea) => updateRow(r.item.id, r.variant.id, raw, ea)}
                  placeholder={`Expected ${r.expectedQty}`}
                />
              </div>
            );
          })}

          <div className="fixed bottom-20 left-0 right-0 px-4">
            <button
              type="button"
              disabled={countedRows.length === 0}
              onClick={() => setPhase('review')}
              className="w-full h-12 rounded-xl bg-primary text-primary-foreground font-semibold text-sm
                         disabled:opacity-40 transition-opacity"
            >
              Review {countedRows.length} counted item{countedRows.length !== 1 ? 's' : ''}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
