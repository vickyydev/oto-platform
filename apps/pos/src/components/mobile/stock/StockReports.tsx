import { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  Package,
  ShoppingCart,
  TrendingDown,
  DollarSign,
  Info,
} from 'lucide-react';
import type { StockReports as StockReportsData } from '@oto/shared';
import { InventoryItem, StockLocation } from '@/types';
import { fetchStockReports, stockErrorWords } from '@/api/stock';

/*
 * S2-14b round 4 — THE REPORTS, FROM THE LEDGER (plan §2.5). The prototype's
 * five tabs, their exact look, on the platform's figures: Discrepancies from
 * the counts, Usage from sales net of refunds, Shrinkage from count variances
 * and corrections down, Purchases from the orders and their receipts, Value
 * from what each size holds × its cost with "no cost set" flagged. The
 * prototype mocked Usage and Shrinkage behind a banner; both are real now, and
 * the banner is gone. Every figure is satang and whole eaches, turned into baht
 * only on screen. Cost figures are a manager's: to anyone else they are not
 * shown (the platform does not send them).
 */

type ReportView = 'discrepancies' | 'usage' | 'shrinkage' | 'purchases' | 'value';

interface ReportTab {
  id: ReportView;
  label: string;
  icon: React.ElementType;
}

const REPORT_TABS: ReportTab[] = [
  { id: 'discrepancies', label: 'Discrepancies', icon: AlertTriangle },
  { id: 'usage',         label: 'Usage',         icon: TrendingDown },
  { id: 'shrinkage',     label: 'Shrinkage',     icon: Package },
  { id: 'purchases',     label: 'Purchases',     icon: ShoppingCart },
  { id: 'value',         label: 'Value',         icon: DollarSign },
];

interface StockReportsProps {
  /** The platform branch the reports are for; null shows nothing to report. */
  branchId: string | null;
  inventory: InventoryItem[];
  locations: StockLocation[];
}

/** Satang as the stock screens show baht: "฿1,250", "฿12.50". */
function baht(satang: number): string {
  return `฿${(satang / 100).toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
}

/** Today in the device's calendar, `yyyy-mm-dd`. */
function isoToday(): string {
  const now = new Date();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${now.getFullYear()}-${m}-${d}`;
}

function isoDaysBefore(iso: string, days: number): string {
  const [y, m, d] = iso.split('-').map(Number) as [number, number, number];
  const at = new Date(y, m - 1, d - days);
  return `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, '0')}-${String(at.getDate()).padStart(2, '0')}`;
}

/** The start of the record, for a filter left empty ("all of it"). */
const BEGINNING = '2000-01-01';

/** The reports over a range, read from the platform; refetched when the range moves. */
function useStockReports(branchId: string | null, from: string, to: string) {
  const [state, setState] = useState<{ data: StockReportsData | null; error: string | null; loading: boolean }>({
    data: null,
    error: null,
    loading: false,
  });
  useEffect(() => {
    if (!branchId) {
      setState({ data: null, error: null, loading: false });
      return;
    }
    let live = true;
    setState((s) => ({ ...s, loading: true, error: null }));
    fetchStockReports(branchId, from, to)
      .then((data) => live && setState({ data, error: null, loading: false }))
      .catch((err: unknown) => live && setState((s) => ({ ...s, error: stockErrorWords(err), loading: false })));
    return () => {
      live = false;
    };
  }, [branchId, from, to]);
  return state;
}

function LoadState({ loading, error }: { loading: boolean; error: string | null }) {
  if (error) {
    return (
      <div className="rounded-xl border border-destructive/20 bg-destructive/[0.04] px-4 py-3 flex gap-2 items-start">
        <AlertTriangle className="w-4 h-4 text-destructive mt-0.5 shrink-0" />
        <p className="text-xs text-destructive leading-relaxed">{error}</p>
      </div>
    );
  }
  if (loading) return <p className="text-xs text-foreground/40 text-center py-2">Reading the stock ledger…</p>;
  return null;
}

// ── Category filter chips (shared by Purchases + Value reports) ──────────────
type CategoryFilter = 'all' | InventoryItem['linkedKind'];

const CATEGORY_CHIP_OPTIONS: { id: CategoryFilter; label: string }[] = [
  { id: 'all',   label: 'All categories' },
  { id: 'menu',  label: 'F&B' },
  { id: 'merch', label: 'Merch' },
  { id: 'addon', label: 'Add-ons' },
];

/** The platform's product kind as the chips name it; an unlinked item is shown under "All" only. */
function kindMatches(productKind: string | null, filter: CategoryFilter): boolean {
  if (filter === 'all') return true;
  return productKind === filter;
}

function CategoryChips({ value, onChange }: { value: CategoryFilter; onChange: (c: CategoryFilter) => void }) {
  return (
    <div className="flex gap-1.5 overflow-x-auto">
      {CATEGORY_CHIP_OPTIONS.map(({ id, label }) => (
        <button
          key={id}
          type="button"
          onClick={() => onChange(id)}
          className={`shrink-0 px-3 py-1.5 rounded-full border text-xs font-medium transition-colors ${
            value === id
              ? 'border-sky-500 bg-sky-500/10 text-sky-600 dark:text-sky-400'
              : 'border-foreground/15 text-foreground/50'
          }`}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

/** The From / To pair every report filters by — the prototype's own control. */
function DateRange({
  from,
  to,
  onFrom,
  onTo,
  onClear,
}: {
  from: string;
  to: string;
  onFrom: (v: string) => void;
  onTo: (v: string) => void;
  onClear?: () => void;
}) {
  return (
    <div className="flex gap-2 items-center">
      <label className="text-xs text-foreground/40 shrink-0">From</label>
      <input
        type="date"
        value={from}
        onChange={(e) => onFrom(e.target.value)}
        className="flex-1 h-8 rounded-lg border border-input bg-background px-2 text-xs"
      />
      <label className="text-xs text-foreground/40 shrink-0">To</label>
      <input
        type="date"
        value={to}
        onChange={(e) => onTo(e.target.value)}
        className="flex-1 h-8 rounded-lg border border-input bg-background px-2 text-xs"
      />
      {onClear && (from || to) && (
        <button type="button" onClick={onClear} className="text-xs text-primary shrink-0">
          Clear
        </button>
      )}
    </div>
  );
}

/** How many sizes each item has, so a one-size item is named without " · Default". */
function sizeCounts(data: StockReportsData | null): Map<string, number> {
  const counts = new Map<string, number>();
  for (const v of data?.value ?? []) counts.set(v.groupId, (counts.get(v.groupId) ?? 0) + 1);
  return counts;
}

const sizeSuffix = (counts: Map<string, number>, groupId: string, label: string | null) =>
  (counts.get(groupId) ?? 1) > 1 && label ? ` · ${label}` : '';

// ── Discrepancies report ──────────────────────────────────────────────────────
function DiscrepanciesReport({ branchId, locations }: StockReportsProps) {
  const [filterItem, setFilterItem] = useState('');
  const [filterLocation, setFilterLocation] = useState('');
  const [filterFrom, setFilterFrom] = useState('');
  const [filterTo, setFilterTo] = useState('');

  const { data, error, loading } = useStockReports(branchId, filterFrom || BEGINNING, filterTo || isoToday());
  const counts = useMemo(() => sizeCounts(data), [data]);
  const enriched = useMemo(() => data?.discrepancies ?? [], [data]);

  // Count occurrences per item to detect repeat offenders
  const offenderCounts = useMemo(() => {
    const out: Record<string, { name: string; count: number }> = {};
    for (const r of enriched) {
      if (!r.flagged) continue;
      out[r.groupId] = { name: r.name, count: (out[r.groupId]?.count ?? 0) + 1 };
    }
    return out;
  }, [enriched]);

  const filtered = useMemo(
    () =>
      enriched.filter((r) => {
        if (filterItem && !r.name.toLowerCase().includes(filterItem.toLowerCase())) return false;
        if (filterLocation && r.locationId !== filterLocation) return false;
        return true;
      }),
    [enriched, filterItem, filterLocation],
  );

  const onlyDiscrepant = filtered.filter((r) => r.difference !== 0);

  if (!loading && !error && data && data.discrepancies.length === 0 && !filterFrom && !filterTo) {
    return (
      <div className="flex flex-col items-center gap-3 py-16 text-center">
        <AlertTriangle className="w-10 h-10 text-foreground/20" />
        <p className="text-sm text-foreground/40">No stock takes recorded this session.</p>
        <p className="text-xs text-foreground/30">Complete a stock take in the Stock tab to generate data here.</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <LoadState loading={loading} error={error} />
      {/* Filters */}
      <div className="flex gap-2">
        <input
          type="text"
          value={filterItem}
          onChange={(e) => setFilterItem(e.target.value)}
          placeholder="Search item…"
          className="flex-1 h-9 rounded-lg border border-input bg-background px-3 text-sm placeholder:text-foreground/30"
        />
        <select
          value={filterLocation}
          onChange={(e) => setFilterLocation(e.target.value)}
          className="h-9 rounded-lg border border-input bg-background px-2 text-sm max-w-[140px]"
        >
          <option value="">All locations</option>
          {locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
        </select>
      </div>
      {/* Date-range filter */}
      <DateRange
        from={filterFrom}
        to={filterTo}
        onFrom={setFilterFrom}
        onTo={setFilterTo}
        onClear={() => { setFilterFrom(''); setFilterTo(''); }}
      />

      {/* Summary row */}
      <div className="grid grid-cols-3 gap-2">
        {[
          { label: 'Takes logged', value: filtered.length },
          { label: 'Discrepancies', value: onlyDiscrepant.length },
          { label: 'Flagged items', value: Object.keys(offenderCounts).length },
        ].map(({ label, value }) => (
          <div key={label} className="rounded-xl border border-foreground/10 bg-foreground/[0.02] p-3 text-center">
            <p className="text-xl font-bold">{value}</p>
            <p className="text-[10px] text-foreground/40 mt-0.5">{label}</p>
          </div>
        ))}
      </div>

      {/* Repeat offenders */}
      {Object.keys(offenderCounts).length > 0 && (
        <div className="rounded-xl border border-destructive/20 bg-destructive/[0.04] p-3">
          <p className="text-xs font-semibold text-destructive mb-2">Repeat discrepancy items</p>
          <div className="flex flex-wrap gap-2">
            {Object.entries(offenderCounts).map(([id, { name, count }]) => (
              <span key={id} className="rounded-full bg-destructive/10 border border-destructive/20 px-2.5 py-1 text-xs text-destructive">
                {name} ×{count}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Records table */}
      {onlyDiscrepant.length === 0 ? (
        <p className="text-sm text-foreground/40 text-center py-6">No discrepancies match the current filter.</p>
      ) : (
        <div className="flex flex-col gap-2">
          <p className="text-xs font-semibold uppercase tracking-wider text-foreground/40">
            Discrepant counts ({onlyDiscrepant.length})
          </p>
          {onlyDiscrepant.map((r) => {
            const varSuffix = sizeSuffix(counts, r.groupId, r.variantLabel);
            const dateStr = new Date(r.countedAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
            return (
              <div key={r.id} className={`rounded-xl border p-3 flex flex-col gap-1.5 ${r.flagged ? 'border-destructive/20 bg-destructive/[0.04]' : 'border-foreground/10'}`}>
                <div className="flex items-center justify-between gap-2">
                  <p className="text-sm font-medium truncate">
                    {r.flagged && <AlertTriangle className="inline w-3.5 h-3.5 text-destructive mr-1 -mt-0.5" />}
                    {r.name}{varSuffix}
                  </p>
                  <span className={`text-sm font-bold shrink-0 ${r.difference < 0 ? 'text-destructive' : 'text-amber-400'}`}>
                    {r.difference > 0 ? '+' : ''}{r.difference}
                  </span>
                </div>
                <div className="flex items-center gap-3 text-xs text-foreground/40">
                  <span>{r.locationName}</span>
                  <span>Exp {r.expectedQuantity} → got {r.countedQuantity}</span>
                  <span className="ml-auto">{dateStr}</span>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ── Usage report (from the ledger: sales net of refunds) ───────────────────
function UsageReport({ branchId }: { branchId: string | null }) {
  const today = isoToday();
  const [from, setFrom] = useState(() => isoDaysBefore(today, 6));
  const [to, setTo] = useState(today);
  const { data, error, loading } = useStockReports(branchId, from || BEGINNING, to || today);
  const counts = useMemo(() => sizeCounts(data), [data]);
  const rows = (data?.usage ?? []).filter((r) => r.sold !== 0 || r.refunded !== 0);

  return (
    <div className="flex flex-col gap-4">
      <LoadState loading={loading} error={error} />
      <DateRange from={from} to={to} onFrom={setFrom} onTo={setTo} />

      <p className="text-xs font-semibold uppercase tracking-wider text-foreground/40">Consumption · sales net of refunds</p>

      {rows.length === 0 && !loading ? (
        <p className="text-sm text-foreground/40 text-center py-6">Nothing was sold in this range.</p>
      ) : (
        <div className="flex flex-col gap-2">
          {rows.map((row) => (
            <div key={row.stockItemId} className="rounded-xl border border-foreground/10 bg-foreground/[0.02] p-3 flex items-center justify-between">
              <div>
                <p className="text-sm font-medium">{row.name}{sizeSuffix(counts, row.groupId, row.variantLabel)}</p>
                <p className="text-xs text-foreground/40 mt-0.5">
                  Sold {row.sold}{row.refunded > 0 ? ` · refunded ${row.refunded}` : ''}{row.soldOffline > 0 ? ` · ${row.soldOffline} offline` : ''}
                </p>
              </div>
              <span className="text-sm font-bold text-foreground/70">{row.net} ea</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Shrinkage report (from the ledger: count variances + corrections down) ─
function ShrinkageReport({ branchId }: { branchId: string | null }) {
  const today = isoToday();
  const [from, setFrom] = useState(() => isoDaysBefore(today, 29));
  const [to, setTo] = useState(today);
  const { data, error, loading } = useStockReports(branchId, from || BEGINNING, to || today);
  const counts = useMemo(() => sizeCounts(data), [data]);
  const rows = (data?.shrinkage ?? []).filter((r) => r.total < 0);
  const withCost = data?.withCost ?? false;
  const totalLoss = rows.reduce((s, r) => s + (r.lossSatang ?? 0), 0);

  return (
    <div className="flex flex-col gap-4">
      <LoadState loading={loading} error={error} />
      <DateRange from={from} to={to} onFrom={setFrom} onTo={setTo} />

      <div className="grid grid-cols-2 gap-2">
        <div className="rounded-xl border border-foreground/10 bg-foreground/[0.02] p-3 text-center">
          <p className="text-xl font-bold text-destructive">{rows.length}</p>
          <p className="text-[10px] text-foreground/40 mt-0.5">Items with shrinkage</p>
        </div>
        <div className="rounded-xl border border-foreground/10 bg-foreground/[0.02] p-3 text-center">
          <p className="text-xl font-bold text-destructive">{withCost ? `-${baht(totalLoss)}` : '—'}</p>
          <p className="text-[10px] text-foreground/40 mt-0.5">Est. loss at cost</p>
        </div>
      </div>

      {rows.length === 0 && !loading ? (
        <p className="text-sm text-foreground/40 text-center py-6">No shrinkage in this range.</p>
      ) : (
        <div className="flex flex-col gap-2">
          {rows.map((row) => {
            const notes = [
              ...(row.countedShort > 0 ? [`Counted short ${row.countedShort}×`] : []),
              ...(row.countVariance > 0 ? [`counts found ${row.countVariance} more`] : []),
              ...(row.adjustedDown < 0 ? [`corrections ${row.adjustedDown}`] : []),
            ];
            return (
              <div key={row.stockItemId} className="rounded-xl border border-destructive/20 bg-destructive/[0.03] p-3 flex flex-col gap-1">
                <div className="flex items-center justify-between">
                  <p className="text-sm font-medium">{row.name}{sizeSuffix(counts, row.groupId, row.variantLabel)}</p>
                  <span className="text-sm font-bold text-destructive">{row.total} ea</span>
                </div>
                <div className="flex items-center justify-between text-xs text-foreground/40">
                  <span>{notes.join(' · ')}</span>
                  {withCost && row.lossSatang !== null && (
                    <span>{row.costMissing ? 'no cost set' : `-${baht(row.lossSatang)} at cost`}</span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ── Purchase history report ───────────────────────────────────────────────────
function PurchasesReport({ branchId }: { branchId: string | null }) {
  const [filterCategory, setFilterCategory] = useState<CategoryFilter>('all');
  const [filterFrom, setFilterFrom] = useState('');
  const [filterTo, setFilterTo] = useState('');
  const { data, error, loading } = useStockReports(branchId, filterFrom || BEGINNING, filterTo || isoToday());

  // Category keeps only matching lines and drops orders with none left; the
  // stats below are computed on the filtered set.
  const orders = useMemo(
    () =>
      (data?.purchases ?? [])
        .map((o) => (filterCategory === 'all' ? o : { ...o, lines: o.lines.filter((l) => kindMatches(l.productKind, filterCategory)) }))
        .filter((o) => o.lines.length > 0),
    [data, filterCategory],
  );

  const stateLabel: Record<string, string> = {
    to_order: 'Draft',
    ordered: 'Ordered',
    received: 'Received',
  };
  const stateColor: Record<string, string> = {
    to_order: 'text-foreground/40 border-foreground/20',
    ordered: 'text-amber-400 border-amber-400/30',
    received: 'text-green-400 border-green-400/30',
  };

  if (!loading && !error && data && data.purchases.length === 0 && !filterFrom && !filterTo) {
    return (
      <div className="flex flex-col items-center gap-3 py-16 text-center">
        <ShoppingCart className="w-10 h-10 text-foreground/20" />
        <p className="text-sm text-foreground/40">No purchase orders this session.</p>
        <p className="text-xs text-foreground/30">Create orders in the Purchase tab to see them here.</p>
      </div>
    );
  }

  const totalReceived = orders
    .filter((o) => o.state === 'received')
    .reduce((s, o) => s + o.lines.reduce((ls, l) => ls + l.receivedQuantity, 0), 0);

  // Cost of every unit received, at the cost frozen on each receipt (lines with a known cost)
  const totalReceivedCost = orders.reduce(
    (s, o) => s + o.lines.reduce((ls, l) => ls + (l.receivedCostSatang ?? 0), 0),
    0,
  );

  return (
    <div className="flex flex-col gap-4">
      <LoadState loading={loading} error={error} />
      {/* Filters */}
      <CategoryChips value={filterCategory} onChange={setFilterCategory} />
      <DateRange
        from={filterFrom}
        to={filterTo}
        onFrom={setFilterFrom}
        onTo={setFilterTo}
        onClear={() => { setFilterFrom(''); setFilterTo(''); }}
      />

      <div className="grid grid-cols-3 gap-2">
        {[
          { label: 'Total orders', value: String(orders.length) },
          { label: 'Units received', value: String(totalReceived) },
          { label: 'Cost received', value: totalReceivedCost > 0 ? baht(totalReceivedCost) : '—' },
        ].map(({ label, value }) => (
          <div key={label} className="rounded-xl border border-foreground/10 bg-foreground/[0.02] p-3 text-center">
            <p className="text-xl font-bold">{value}</p>
            <p className="text-[10px] text-foreground/40 mt-0.5">{label}</p>
          </div>
        ))}
      </div>

      {orders.length === 0 && (
        <p className="text-sm text-foreground/40 text-center py-6">No purchase orders match the current filter.</p>
      )}

      <div className="flex flex-col gap-3">
        {orders.map((o) => {
          const dateStr = new Date(o.createdAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
          const colorClass = stateColor[o.state] ?? 'text-foreground/40 border-foreground/20';
          return (
            <div key={o.id} className="rounded-xl border border-foreground/10 bg-foreground/[0.02] p-4 flex flex-col gap-3">
              <div className="flex items-start justify-between gap-2">
                <div>
                  <p className="text-sm font-semibold">{o.supplierName}</p>
                  <p className="text-xs text-foreground/40 mt-0.5">{dateStr} · {o.createdBy ?? 'Staff'}</p>
                </div>
                <span className={`text-[10px] font-semibold uppercase border rounded-full px-2 py-0.5 shrink-0 ${colorClass}`}>
                  {stateLabel[o.state] ?? o.state}
                </span>
              </div>
              <div className="flex flex-col gap-1">
                {o.lines.map((l) => {
                  const c = l.unitCostSatang;
                  const lineTotal = c != null ? l.orderedQuantity * c : null;
                  const receivedTotal = l.receivedCostSatang;
                  return (
                    <div key={l.id} className="flex items-start justify-between gap-2 text-xs">
                      <div className="min-w-0">
                        <span className="text-foreground/70">{l.itemName} {l.variantLabel ? `(${l.variantLabel})` : ''}</span>
                        {c != null && (
                          <span className="text-foreground/40 ml-1">@ {baht(c)}</span>
                        )}
                      </div>
                      <div className="text-right shrink-0">
                        <p className="text-foreground/50">{l.receivedQuantity}/{l.orderedQuantity} ea</p>
                        {lineTotal != null && (
                          <p className="text-foreground/35">
                            {receivedTotal != null && receivedTotal > 0
                              ? `${baht(receivedTotal)} / ${baht(lineTotal)}`
                              : baht(lineTotal)}
                          </p>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
              {o.expectedArrivalDate && (
                <p className="text-xs text-foreground/30">ETA: {o.expectedArrivalDate}</p>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Stock value report ────────────────────────────────────────────────────────
function StockValueReport({ branchId, locations }: StockReportsProps) {
  const [filterLocation, setFilterLocation] = useState('');
  const [filterCategory, setFilterCategory] = useState<CategoryFilter>('all');
  const [filterNoCost, setFilterNoCost] = useState(false);
  const today = isoToday();
  const { data, error, loading } = useStockReports(branchId, today, today);
  const counts = useMemo(() => sizeCounts(data), [data]);
  const withCost = data?.withCost ?? false;

  const rows = useMemo(
    () =>
      (data?.value ?? [])
        .filter((v) => kindMatches(v.productKind, filterCategory))
        .map((v) => {
          const totalQty = filterLocation ? (v.byLocation[filterLocation] ?? 0) : v.onHand;
          const costPer = v.unitCostSatang;
          return { v, totalQty, costPer, totalValue: costPer != null ? totalQty * costPer : null };
        }),
    [data, filterLocation, filterCategory],
  );

  const visibleRows = filterNoCost ? rows.filter((r) => r.v.noCostSet) : rows;

  const grandTotal = rows.reduce((s, r) => s + (r.totalValue ?? 0), 0);
  const unknownCount = rows.filter((r) => r.v.noCostSet).length;

  return (
    <div className="flex flex-col gap-4">
      <LoadState loading={loading} error={error} />
      {/* Summary */}
      <div className="grid grid-cols-2 gap-2">
        <div className="rounded-xl border border-foreground/10 bg-foreground/[0.02] p-3 text-center">
          <p className="text-xl font-bold">{withCost ? baht(grandTotal) : '—'}</p>
          <p className="text-[10px] text-foreground/40 mt-0.5">On-hand value (known costs)</p>
        </div>
        <div className="rounded-xl border border-foreground/10 bg-foreground/[0.02] p-3 text-center">
          <p className={`text-xl font-bold ${unknownCount > 0 ? 'text-amber-400' : 'text-foreground'}`}>
            {unknownCount}
          </p>
          <p className="text-[10px] text-foreground/40 mt-0.5">Items without cost</p>
        </div>
      </div>

      {/* Filters */}
      <CategoryChips value={filterCategory} onChange={setFilterCategory} />
      <div className="flex gap-2">
        <select
          value={filterLocation}
          onChange={(e) => setFilterLocation(e.target.value)}
          className="flex-1 h-9 rounded-lg border border-input bg-background px-2 text-sm"
        >
          <option value="">All locations (total qty)</option>
          {locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
        </select>
        <button
          type="button"
          onClick={() => setFilterNoCost((v) => !v)}
          className={`h-9 px-3 rounded-lg border text-xs font-medium transition-colors ${
            filterNoCost
              ? 'border-amber-500/50 bg-amber-500/10 text-amber-400'
              : 'border-foreground/20 text-foreground/50'
          }`}
        >
          No cost
        </button>
      </div>

      {/* Rows */}
      <div className="flex flex-col gap-1.5">
        {visibleRows.length === 0 ? (
          <p className="text-sm text-foreground/40 text-center py-6">
            {filterNoCost ? 'All items have a cost set.' : 'No inventory items found.'}
          </p>
        ) : (
          visibleRows.map((r) => {
            const varSuffix = sizeSuffix(counts, r.v.groupId, r.v.variantLabel);
            return (
              <div
                key={r.v.stockItemId}
                className={`rounded-xl border p-3 flex items-center justify-between gap-2 ${
                  r.v.noCostSet ? 'border-amber-500/15 bg-amber-500/[0.03]' : 'border-foreground/10'
                }`}
              >
                <div className="min-w-0">
                  <p className="text-sm font-medium truncate">{r.v.name}{varSuffix}</p>
                  <p className="text-xs text-foreground/40 mt-0.5">
                    {r.totalQty} ea
                    {r.costPer != null ? ` × ${baht(r.costPer)}` : ''}
                    {!filterLocation && r.v.retiredOnHand !== 0 ? ` · incl. ${r.v.retiredOnHand} at a retired place` : ''}
                  </p>
                </div>
                {r.totalValue != null ? (
                  <span className="text-sm font-bold shrink-0">{baht(r.totalValue)}</span>
                ) : r.v.noCostSet ? (
                  <span className="text-xs text-amber-400/80 shrink-0">no cost set</span>
                ) : null}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

// ── Main StockReports component ───────────────────────────────────────────────
export function StockReports({ branchId, inventory, locations }: StockReportsProps) {
  const [view, setView] = useState<ReportView>('discrepancies');
  const activeLocations = locations.filter((l) => l.active);

  return (
    <div className="flex flex-col min-h-full">
      {/* Tab bar */}
      <div className="flex gap-0 border-b border-foreground/10 overflow-x-auto shrink-0">
        {REPORT_TABS.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            type="button"
            onClick={() => setView(id)}
            className={`flex flex-col items-center gap-0.5 py-2.5 px-3 text-[11px] font-medium shrink-0 border-b-2 transition-colors ${
              view === id
                ? 'text-primary border-primary'
                : 'text-muted-foreground border-transparent'
            }`}
          >
            <Icon className="w-4 h-4" />
            {label}
          </button>
        ))}
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto p-4 pb-24">
        {!branchId && (
          <div className="rounded-xl border border-amber-500/25 bg-amber-500/[0.06] px-4 py-3 flex gap-2 items-start">
            <Info className="w-4 h-4 text-amber-400 mt-0.5 shrink-0" />
            <p className="text-xs text-amber-300/80 leading-relaxed">Choose a branch to see its stock reports.</p>
          </div>
        )}
        {view === 'discrepancies' && (
          <DiscrepanciesReport branchId={branchId} inventory={inventory} locations={activeLocations} />
        )}
        {view === 'usage' && <UsageReport branchId={branchId} />}
        {view === 'shrinkage' && <ShrinkageReport branchId={branchId} />}
        {view === 'purchases' && <PurchasesReport branchId={branchId} />}
        {view === 'value' && (
          <StockValueReport branchId={branchId} inventory={inventory} locations={activeLocations} />
        )}
      </div>
    </div>
  );
}
