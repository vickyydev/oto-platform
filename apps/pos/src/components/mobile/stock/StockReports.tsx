import { useState, useMemo } from 'react';
import {
  BarChart2,
  AlertTriangle,
  Package,
  ShoppingCart,
  TrendingDown,
  DollarSign,
  Info,
} from 'lucide-react';
import { InventoryItem, StockLocation } from '@/types';
import { getStockTakeLog, getPurchaseOrders } from '@/mockApi';

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
  inventory: InventoryItem[];
  locations: StockLocation[];
}

// ── Category filter chips (shared by Purchases + Value reports) ──────────────
type CategoryFilter = 'all' | InventoryItem['linkedKind'];

const CATEGORY_CHIP_OPTIONS: { id: CategoryFilter; label: string }[] = [
  { id: 'all',   label: 'All categories' },
  { id: 'menu',  label: 'F&B' },
  { id: 'merch', label: 'Merch' },
  { id: 'addon', label: 'Add-ons' },
];

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

// ── Prototype banner ─────────────────────────────────────────────────────────
function PrototypeBanner({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-amber-500/25 bg-amber-500/[0.06] px-4 py-3 flex gap-2 items-start">
      <Info className="w-4 h-4 text-amber-400 mt-0.5 shrink-0" />
      <p className="text-xs text-amber-300/80 leading-relaxed">{children}</p>
    </div>
  );
}

// ── Discrepancies report ──────────────────────────────────────────────────────
function DiscrepanciesReport({ inventory, locations }: StockReportsProps) {
  const [filterItem, setFilterItem] = useState('');
  const [filterLocation, setFilterLocation] = useState('');
  const [filterFrom, setFilterFrom] = useState('');
  const [filterTo, setFilterTo] = useState('');

  const rawLog = getStockTakeLog();

  const enriched = useMemo(() => {
    return rawLog.map((r) => {
      const item = inventory.find((i) => i.id === r.inventoryItemId);
      const variant = item?.variants.find((v) => v.id === r.variantId);
      const loc = locations.find((l) => l.id === r.locationId);
      return { ...r, itemName: item?.name ?? r.inventoryItemId, variantLabel: variant?.label ?? '', locName: loc?.name ?? r.locationId, multiVariant: (item?.variants.length ?? 1) > 1 };
    });
  }, [rawLog, inventory, locations]);

  // Count occurrences per item to detect repeat offenders
  const offenderCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const r of enriched) {
      if (r.flagged) counts[r.inventoryItemId] = (counts[r.inventoryItemId] ?? 0) + 1;
    }
    return counts;
  }, [enriched]);

  const filtered = useMemo(() => {
    const fromMs = filterFrom ? new Date(filterFrom).getTime() : null;
    const toMs = filterTo ? new Date(filterTo + 'T23:59:59').getTime() : null;
    return enriched.filter((r) => {
      if (filterItem && !r.itemName.toLowerCase().includes(filterItem.toLowerCase())) return false;
      if (filterLocation && r.locationId !== filterLocation) return false;
      const at = new Date(r.countedAt).getTime();
      if (fromMs !== null && at < fromMs) return false;
      if (toMs !== null && at > toMs) return false;
      return true;
    });
  }, [enriched, filterItem, filterLocation, filterFrom, filterTo]);

  const onlyDiscrepant = filtered.filter((r) => r.discrepancy !== 0);

  if (rawLog.length === 0) {
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
      <div className="flex gap-2 items-center">
        <label className="text-xs text-foreground/40 shrink-0">From</label>
        <input
          type="date"
          value={filterFrom}
          onChange={(e) => setFilterFrom(e.target.value)}
          className="flex-1 h-8 rounded-lg border border-input bg-background px-2 text-xs"
        />
        <label className="text-xs text-foreground/40 shrink-0">To</label>
        <input
          type="date"
          value={filterTo}
          onChange={(e) => setFilterTo(e.target.value)}
          className="flex-1 h-8 rounded-lg border border-input bg-background px-2 text-xs"
        />
        {(filterFrom || filterTo) && (
          <button
            type="button"
            onClick={() => { setFilterFrom(''); setFilterTo(''); }}
            className="text-xs text-primary shrink-0"
          >
            Clear
          </button>
        )}
      </div>

      {/* Summary row */}
      <div className="grid grid-cols-3 gap-2">
        {[
          { label: 'Takes logged', value: enriched.length },
          { label: 'Discrepancies', value: onlyDiscrepant.length },
          { label: 'Flagged items', value: Object.values(offenderCounts).filter(v => v >= 1).length },
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
            {Object.entries(offenderCounts).map(([id, count]) => {
              const name = inventory.find((i) => i.id === id)?.name ?? id;
              return (
                <span key={id} className="rounded-full bg-destructive/10 border border-destructive/20 px-2.5 py-1 text-xs text-destructive">
                  {name} ×{count}
                </span>
              );
            })}
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
            const varSuffix = r.multiVariant ? ` · ${r.variantLabel}` : '';
            const dateStr = new Date(r.countedAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
            return (
              <div key={r.id} className={`rounded-xl border p-3 flex flex-col gap-1.5 ${r.flagged ? 'border-destructive/20 bg-destructive/[0.04]' : 'border-foreground/10'}`}>
                <div className="flex items-center justify-between gap-2">
                  <p className="text-sm font-medium truncate">
                    {r.flagged && <AlertTriangle className="inline w-3.5 h-3.5 text-destructive mr-1 -mt-0.5" />}
                    {r.itemName}{varSuffix}
                  </p>
                  <span className={`text-sm font-bold shrink-0 ${r.discrepancy < 0 ? 'text-destructive' : 'text-amber-400'}`}>
                    {r.discrepancy > 0 ? '+' : ''}{r.discrepancy}
                  </span>
                </div>
                <div className="flex items-center gap-3 text-xs text-foreground/40">
                  <span>{r.locName}</span>
                  <span>Exp {r.expectedQty} → got {r.countedQty}</span>
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

// ── Usage report (prototype shell) ───────────────────────────────────────────
const MOCK_USAGE = [
  { item: 'Regular Socks', period: 'Last 7 days', qty: 42, unit: 'ea' },
  { item: 'Grip Socks (M)', period: 'Last 7 days', qty: 31, unit: 'ea' },
  { item: 'Bottled Water', period: 'Last 7 days', qty: 88, unit: 'ea' },
  { item: 'Slushie (Red)', period: 'Last 7 days', qty: 24, unit: 'ea' },
  { item: 'Oto T-Shirt', period: 'Last 7 days', qty: 5, unit: 'ea' },
  { item: 'Sticker Pack', period: 'Last 7 days', qty: 8, unit: 'ea' },
];

function UsageReport() {
  return (
    <div className="flex flex-col gap-4">
      <PrototypeBanner>
        Prototype: usage is estimated from seeded stock levels. Live consumption tracking requires
        server-side sales history aggregation per SKU — wire this to the order-ledger backend.
      </PrototypeBanner>

      <p className="text-xs font-semibold uppercase tracking-wider text-foreground/40">Estimated consumption · last 7 days</p>

      <div className="flex flex-col gap-2">
        {MOCK_USAGE.map((row) => (
          <div key={row.item} className="rounded-xl border border-foreground/10 bg-foreground/[0.02] p-3 flex items-center justify-between">
            <div>
              <p className="text-sm font-medium">{row.item}</p>
              <p className="text-xs text-foreground/40 mt-0.5">{row.period}</p>
            </div>
            <span className="text-sm font-bold text-foreground/70">{row.qty} {row.unit}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Shrinkage report (prototype shell) ───────────────────────────────────────
const MOCK_SHRINKAGE = [
  { item: 'Grip Socks (Merch)', variance: -6, valueTHB: 210, note: 'Counted short 2× this month' },
  { item: 'Mascot Keyring', variance: -3, valueTHB: 75, note: 'Counted short last take' },
  { item: 'Bottled Water', variance: -4, valueTHB: 48, note: 'Possible breakage / spillage' },
];

function ShrinkageReport() {
  const totalLoss = MOCK_SHRINKAGE.reduce((s, r) => s + r.valueTHB, 0);
  return (
    <div className="flex flex-col gap-4">
      <PrototypeBanner>
        Prototype: shrinkage is derived from variance records in this session only. In production,
        calculate shrinkage as (opening stock + received) − (sales + closing stock) per period,
        aggregated server-side from the order ledger and stock-take history.
      </PrototypeBanner>

      <div className="grid grid-cols-2 gap-2">
        <div className="rounded-xl border border-foreground/10 bg-foreground/[0.02] p-3 text-center">
          <p className="text-xl font-bold text-destructive">{MOCK_SHRINKAGE.length}</p>
          <p className="text-[10px] text-foreground/40 mt-0.5">Items with shrinkage</p>
        </div>
        <div className="rounded-xl border border-foreground/10 bg-foreground/[0.02] p-3 text-center">
          <p className="text-xl font-bold text-destructive">-฿{totalLoss}</p>
          <p className="text-[10px] text-foreground/40 mt-0.5">Est. loss at cost</p>
        </div>
      </div>

      <div className="flex flex-col gap-2">
        {MOCK_SHRINKAGE.map((row) => (
          <div key={row.item} className="rounded-xl border border-destructive/20 bg-destructive/[0.03] p-3 flex flex-col gap-1">
            <div className="flex items-center justify-between">
              <p className="text-sm font-medium">{row.item}</p>
              <span className="text-sm font-bold text-destructive">{row.variance} ea</span>
            </div>
            <div className="flex items-center justify-between text-xs text-foreground/40">
              <span>{row.note}</span>
              <span>-฿{row.valueTHB} at cost</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Purchase history report ───────────────────────────────────────────────────
function PurchasesReport({ inventory }: { inventory: InventoryItem[] }) {
  const [filterCategory, setFilterCategory] = useState<CategoryFilter>('all');
  const [filterFrom, setFilterFrom] = useState('');
  const [filterTo, setFilterTo] = useState('');

  const allOrders = getPurchaseOrders();

  // Category + date-range filtering. Category keeps only matching lines and
  // drops orders with none left; stats below are computed on the filtered set.
  const orders = useMemo(() => {
    const kindOf = (id: string) => inventory.find((i) => i.id === id)?.linkedKind;
    const fromMs = filterFrom ? new Date(filterFrom).getTime() : null;
    const toMs = filterTo ? new Date(filterTo + 'T23:59:59').getTime() : null;
    return allOrders
      .filter((o) => {
        const at = new Date(o.createdAt).getTime();
        if (fromMs !== null && at < fromMs) return false;
        if (toMs !== null && at > toMs) return false;
        return true;
      })
      .map((o) =>
        filterCategory === 'all'
          ? o
          : { ...o, lines: o.lines.filter((l) => kindOf(l.inventoryItemId) === filterCategory) },
      )
      .filter((o) => o.lines.length > 0);
  }, [allOrders, inventory, filterCategory, filterFrom, filterTo]);

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

  /** Look up unitCostTHB for an inventory item */
  const costFor = (inventoryItemId: string): number | undefined =>
    inventory.find((i) => i.id === inventoryItemId)?.unitCostTHB;

  if (allOrders.length === 0) {
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
    .reduce((s, o) => s + o.lines.reduce((ls, l) => ls + l.receivedQty, 0), 0);

  const totalPending = orders
    .filter((o) => o.state === 'ordered')
    .reduce((s, o) => s + o.lines.reduce((ls, l) => ls + (l.orderedQty - l.receivedQty), 0), 0);

  // Total cost of all received units (only lines with known cost)
  const totalReceivedCost = orders.reduce((s, o) => {
    return s + o.lines.reduce((ls, l) => {
      const c = costFor(l.inventoryItemId);
      return ls + (c != null ? l.receivedQty * c : 0);
    }, 0);
  }, 0);

  return (
    <div className="flex flex-col gap-4">
      {/* Filters */}
      <CategoryChips value={filterCategory} onChange={setFilterCategory} />
      <div className="flex gap-2 items-center">
        <label className="text-xs text-foreground/40 shrink-0">From</label>
        <input
          type="date"
          value={filterFrom}
          onChange={(e) => setFilterFrom(e.target.value)}
          className="flex-1 h-8 rounded-lg border border-input bg-background px-2 text-xs"
        />
        <label className="text-xs text-foreground/40 shrink-0">To</label>
        <input
          type="date"
          value={filterTo}
          onChange={(e) => setFilterTo(e.target.value)}
          className="flex-1 h-8 rounded-lg border border-input bg-background px-2 text-xs"
        />
        {(filterFrom || filterTo) && (
          <button
            type="button"
            onClick={() => { setFilterFrom(''); setFilterTo(''); }}
            className="text-xs text-primary shrink-0"
          >
            Clear
          </button>
        )}
      </div>

      <div className="grid grid-cols-3 gap-2">
        {[
          { label: 'Total orders', value: String(orders.length) },
          { label: 'Units received', value: String(totalReceived) },
          { label: 'Cost received', value: totalReceivedCost > 0 ? `฿${totalReceivedCost.toLocaleString()}` : '—' },
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
                  <p className="text-xs text-foreground/40 mt-0.5">{dateStr} · {o.createdBy}</p>
                </div>
                <span className={`text-[10px] font-semibold uppercase border rounded-full px-2 py-0.5 shrink-0 ${colorClass}`}>
                  {stateLabel[o.state] ?? o.state}
                </span>
              </div>
              <div className="flex flex-col gap-1">
                {o.lines.map((l) => {
                  const c = costFor(l.inventoryItemId);
                  const lineTotal = c != null ? l.orderedQty * c : null;
                  const receivedTotal = c != null ? l.receivedQty * c : null;
                  return (
                    <div key={l.id} className="flex items-start justify-between gap-2 text-xs">
                      <div className="min-w-0">
                        <span className="text-foreground/70">{l.itemName} {l.variantLabel ? `(${l.variantLabel})` : ''}</span>
                        {c != null && (
                          <span className="text-foreground/40 ml-1">@ ฿{c}</span>
                        )}
                      </div>
                      <div className="text-right shrink-0">
                        <p className="text-foreground/50">{l.receivedQty}/{l.orderedQty} ea</p>
                        {lineTotal != null && (
                          <p className="text-foreground/35">
                            {receivedTotal != null && receivedTotal > 0
                              ? `฿${receivedTotal.toLocaleString()} / ฿${lineTotal.toLocaleString()}`
                              : `฿${lineTotal.toLocaleString()}`}
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
function StockValueReport({ inventory, locations }: StockReportsProps) {
  const [filterLocation, setFilterLocation] = useState('');
  const [filterCategory, setFilterCategory] = useState<CategoryFilter>('all');
  const [filterNoCost, setFilterNoCost] = useState(false);

  const rows = useMemo(() => {
    return inventory
      .filter((item) => filterCategory === 'all' || item.linkedKind === filterCategory)
      .flatMap((item) =>
      item.variants.map((v) => {
        const locs = locations.map((l) => ({
          locId: l.id,
          locName: l.name,
          qty: filterLocation
            ? (filterLocation === '__total__'
              ? v.stock
              : (v.stockByLocation?.[filterLocation] ?? 0))
            : v.stock,
        }));
        const totalQty = filterLocation && filterLocation !== '__total__'
          ? (v.stockByLocation?.[filterLocation] ?? 0)
          : v.stock;
        const costPer = item.unitCostTHB;
        const totalValue = costPer != null ? totalQty * costPer : null;
        return {
          item,
          variant: v,
          multiVariant: item.variants.length > 1,
          totalQty,
          costPer,
          totalValue,
          locs,
        };
      })
    );
  }, [inventory, locations, filterLocation, filterCategory]);

  const visibleRows = filterNoCost ? rows.filter((r) => r.costPer == null) : rows;

  const grandTotal = rows.reduce((s, r) => s + (r.totalValue ?? 0), 0);
  const unknownCount = rows.filter((r) => r.costPer == null).length;

  return (
    <div className="flex flex-col gap-4">
      {/* Summary */}
      <div className="grid grid-cols-2 gap-2">
        <div className="rounded-xl border border-foreground/10 bg-foreground/[0.02] p-3 text-center">
          <p className="text-xl font-bold">฿{grandTotal.toLocaleString()}</p>
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
            const varSuffix = r.multiVariant ? ` · ${r.variant.label}` : '';
            return (
              <div
                key={`${r.item.id}:${r.variant.id}`}
                className={`rounded-xl border p-3 flex items-center justify-between gap-2 ${
                  r.costPer == null ? 'border-amber-500/15 bg-amber-500/[0.03]' : 'border-foreground/10'
                }`}
              >
                <div className="min-w-0">
                  <p className="text-sm font-medium truncate">{r.item.name}{varSuffix}</p>
                  <p className="text-xs text-foreground/40 mt-0.5">
                    {r.totalQty} ea
                    {r.costPer != null ? ` × ฿${r.costPer}` : ''}
                  </p>
                </div>
                {r.totalValue != null ? (
                  <span className="text-sm font-bold shrink-0">฿{r.totalValue.toLocaleString()}</span>
                ) : (
                  <span className="text-xs text-amber-400/80 shrink-0">no cost set</span>
                )}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

// ── Main StockReports component ───────────────────────────────────────────────
export function StockReports({ inventory, locations }: StockReportsProps) {
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
        {view === 'discrepancies' && (
          <DiscrepanciesReport inventory={inventory} locations={activeLocations} />
        )}
        {view === 'usage' && <UsageReport />}
        {view === 'shrinkage' && <ShrinkageReport />}
        {view === 'purchases' && <PurchasesReport inventory={inventory} />}
        {view === 'value' && (
          <StockValueReport inventory={inventory} locations={activeLocations} />
        )}
      </div>
    </div>
  );
}
