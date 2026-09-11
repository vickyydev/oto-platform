import { useMemo, useState } from 'react';
import { ClipboardList, Search, PackageX } from 'lucide-react';
import { InventoryItem, StockLocation } from '@/types';
import { formatInUnits } from '@/lib/stockUnits';

/**
 * Main Stock overview — "what do we actually have, everywhere".
 *
 * Lists ALL inventory items with actual on-hand quantities: per-location
 * breakdown (Bulk / back-of-house / rotation) plus item total. Filters by
 * location, item search, category (linked product kind), and a low/out/
 * below-par quick filter. Stock take is launched from a button here (the
 * existing StockTakeFlow, unchanged) instead of a dedicated tab.
 */

type CategoryFilter = 'all' | 'merch' | 'addon' | 'menu';
type QuickFilter = 'all' | 'low' | 'out' | 'belowPar';

const CATEGORY_LABEL: Record<Exclude<CategoryFilter, 'all'>, string> = {
  merch: 'Merch',
  addon: 'Add-ons',
  menu: 'F&B',
};

const kindLabel = (kind: InventoryItem['linkedKind']) => CATEGORY_LABEL[kind];

interface StockOverviewProps {
  inventory: InventoryItem[];
  locations: StockLocation[];
  onStartStockTake: () => void;
}

export function StockOverview({ inventory, locations, onStartStockTake }: StockOverviewProps) {
  const [search, setSearch] = useState('');
  const [locationFilter, setLocationFilter] = useState<string>('all');
  const [category, setCategory] = useState<CategoryFilter>('all');
  const [quick, setQuick] = useState<QuickFilter>('all');

  const activeLocations = locations.filter((l) => l.active);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();

    return inventory.filter((item) => {
      if (category !== 'all' && item.linkedKind !== category) return false;
      if (q && !item.name.toLowerCase().includes(q)) return false;

      // Location filter: only items that track stock at that location
      if (locationFilter !== 'all') {
        const tracksHere = item.variants.some(
          (v) => v.stockByLocation && locationFilter in v.stockByLocation,
        );
        if (!tracksHere) return false;
      }

      // Quick filter, evaluated against the selected location scope
      if (quick !== 'all') {
        const qtyOf = (v: (typeof item.variants)[number]) =>
          locationFilter === 'all'
            ? v.stock
            : v.stockByLocation?.[locationFilter] ?? 0;

        if (quick === 'out') {
          if (!item.variants.some((v) => qtyOf(v) === 0)) return false;
        } else if (quick === 'low') {
          const isLow = item.variants.some((v) => {
            const qty = qtyOf(v);
            if (qty === 0) return false; // "out" is its own filter
            if (v.lowStockThreshold != null && qty <= v.lowStockThreshold) return true;
            if (
              locationFilter === 'all' &&
              item.reorderSettings &&
              qty <= item.reorderSettings.reorderPoint
            )
              return true;
            return false;
          });
          if (!isLow) return false;
        } else if (quick === 'belowPar') {
          const below = item.variants.some((v) => {
            if (!v.parByLocation || !v.stockByLocation) return false;
            return Object.entries(v.parByLocation).some(([locId, par]) => {
              if (locationFilter !== 'all' && locId !== locationFilter) return false;
              return (v.stockByLocation?.[locId] ?? 0) < par;
            });
          });
          if (!below) return false;
        }
      }

      return true;
    });
  }, [inventory, search, locationFilter, category, quick]);

  return (
    <div className="flex flex-col gap-3 p-4 pb-24">
      {/* Header: title + stock take launcher */}
      <div className="flex items-center justify-between gap-2">
        <div>
          <p className="font-semibold">On-hand stock</p>
          <p className="text-xs text-foreground/50 mt-0.5">
            {filtered.length} of {inventory.length} item{inventory.length !== 1 ? 's' : ''}
          </p>
        </div>
        <button
          type="button"
          onClick={onStartStockTake}
          className="flex items-center gap-1.5 px-3.5 py-2 rounded-xl bg-primary text-primary-foreground text-sm font-semibold"
        >
          <ClipboardList className="w-4 h-4" />
          Stock take
        </button>
      </div>

      {/* Search */}
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-foreground/30" />
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search items…"
          className="w-full h-11 rounded-lg border border-input bg-background pl-9 pr-3 text-sm"
        />
      </div>

      {/* Location filter */}
      <select
        value={locationFilter}
        onChange={(e) => setLocationFilter(e.target.value)}
        className="h-11 rounded-lg border border-input bg-background px-3 text-sm"
      >
        <option value="all">All locations</option>
        {activeLocations.map((l) => (
          <option key={l.id} value={l.id}>{l.name}</option>
        ))}
      </select>

      {/* Category chips */}
      <div className="flex gap-1.5 overflow-x-auto">
        {(['all', 'menu', 'merch', 'addon'] as const).map((c) => (
          <button
            key={c}
            type="button"
            onClick={() => setCategory(c)}
            className={`shrink-0 px-3 py-1.5 rounded-full border text-xs font-medium transition-colors ${
              category === c
                ? 'border-sky-500 bg-sky-500/10 text-sky-600 dark:text-sky-400'
                : 'border-foreground/15 text-foreground/50'
            }`}
          >
            {c === 'all' ? 'All categories' : CATEGORY_LABEL[c]}
          </button>
        ))}
      </div>

      {/* Quick filter chips */}
      <div className="flex gap-1.5 overflow-x-auto">
        {([
          ['all', 'Everything'],
          ['low', 'Low'],
          ['out', 'Out'],
          ['belowPar', 'Below par'],
        ] as const).map(([f, label]) => (
          <button
            key={f}
            type="button"
            onClick={() => setQuick(f)}
            className={`shrink-0 px-3 py-1.5 rounded-full border text-xs font-medium transition-colors ${
              quick === f
                ? f === 'out'
                  ? 'border-destructive bg-destructive/10 text-destructive'
                  : f === 'low' || f === 'belowPar'
                  ? 'border-amber-400 bg-amber-400/10 text-amber-400'
                  : 'border-primary bg-primary/10 text-primary'
                : 'border-foreground/15 text-foreground/50'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {/* Item list */}
      {filtered.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 gap-3 text-center">
          <PackageX className="w-10 h-10 text-foreground/20" />
          <p className="text-sm text-foreground/50">No items match these filters.</p>
        </div>
      ) : (
        filtered.map((item) => (
          <ItemStockCard
            key={item.id}
            item={item}
            locations={activeLocations}
            locationFilter={locationFilter}
          />
        ))
      )}
    </div>
  );
}

// ── Per-item card ────────────────────────────────────────────────────────────

function ItemStockCard({
  item,
  locations,
  locationFilter,
}: {
  item: InventoryItem;
  locations: StockLocation[];
  locationFilter: string;
}) {
  const units = item.units ?? [];
  const itemTotal =
    locationFilter === 'all'
      ? item.variants.reduce((s, v) => s + v.stock, 0)
      : item.variants.reduce((s, v) => s + (v.stockByLocation?.[locationFilter] ?? 0), 0);

  const fmtQty = (qty: number) => {
    const inUnits = units.length > 0 ? formatInUnits(qty, units) : null;
    return inUnits && inUnits !== String(qty) ? `${qty} (${inUnits})` : String(qty);
  };

  return (
    <div className="rounded-xl border border-foreground/10 bg-foreground/[0.02] p-3 flex flex-col gap-2">
      {/* Header: photo, name, kind, item total */}
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          {item.photoUrl && (
            <img
              src={item.photoUrl}
              alt=""
              className="w-9 h-9 shrink-0 rounded-md object-cover border border-foreground/10"
            />
          )}
          <div className="min-w-0">
            <p className="text-sm font-medium truncate">{item.name}</p>
            <p className="text-[10px] text-foreground/40">{kindLabel(item.linkedKind)}</p>
          </div>
        </div>
        <div className="text-right shrink-0">
          <p className={`text-sm font-bold ${itemTotal === 0 ? 'text-destructive' : ''}`}>
            {fmtQty(itemTotal)}
          </p>
          <p className="text-[10px] text-foreground/40">
            {locationFilter === 'all' ? 'total on hand' : 'at this location'}
          </p>
        </div>
      </div>

      {/* Per-variant rows */}
      {item.variants.map((v) => {
        const qty =
          locationFilter === 'all' ? v.stock : v.stockByLocation?.[locationFilter] ?? 0;
        const isLow =
          qty > 0 && v.lowStockThreshold != null && qty <= v.lowStockThreshold;

        return (
          <div key={v.id} className="flex flex-col gap-1">
            {(item.variants.length > 1 || locationFilter === 'all') && (
              <div className="flex items-center justify-between text-xs">
                {item.variants.length > 1 ? (
                  <span className="text-foreground/60">{v.label}</span>
                ) : (
                  <span />
                )}
                {item.variants.length > 1 && (
                  <span
                    className={`font-semibold ${
                      qty === 0 ? 'text-destructive' : isLow ? 'text-amber-400' : ''
                    }`}
                  >
                    {fmtQty(qty)}
                  </span>
                )}
              </div>
            )}

            {/* Per-location breakdown (all-locations view only) */}
            {locationFilter === 'all' && v.stockByLocation && (
              <div className="flex flex-wrap gap-1">
                {locations
                  .filter((l) => v.stockByLocation && l.id in v.stockByLocation)
                  .map((l) => {
                    const locQty = v.stockByLocation?.[l.id] ?? 0;
                    const par = v.parByLocation?.[l.id];
                    const belowPar = par != null && locQty < par;
                    return (
                      <span
                        key={l.id}
                        className={`px-2 py-0.5 rounded-md border text-[10px] ${
                          locQty === 0
                            ? 'border-destructive/30 bg-destructive/[0.06] text-destructive'
                            : belowPar
                            ? 'border-amber-400/30 bg-amber-400/[0.06] text-amber-400'
                            : 'border-foreground/10 bg-foreground/[0.03] text-foreground/60'
                        }`}
                      >
                        {l.name}: <span className="font-semibold">{locQty}</span>
                        {par != null && <span className="opacity-60"> / par {par}</span>}
                      </span>
                    );
                  })}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
