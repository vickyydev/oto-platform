import { useState, useRef, useEffect } from 'react';
import {
  ArrowLeftRight, Download, Boxes, TrendingDown, ChevronLeft,
  ShoppingCart, Menu, X, BarChart2,
} from 'lucide-react';
import { StockSuggestions, Suggestion } from './StockSuggestions';
import { StockTransferFlow } from './StockTransferFlow';
import { StockReplenishFlow } from './StockReplenishFlow';
import { StockTakeFlow } from './StockTakeFlow';
import { StockOverview } from './StockOverview';
import { StockPurchasing } from './StockPurchasing';
import { StockReports } from './StockReports';
import { InventoryItem } from '@/types';
import { stockApi, stockErrorWords, useStockModule } from '@/api/stock';
import { useBranch } from '@/branch/BranchContext';

type Tab = 'stock' | 'suggestions' | 'transfer' | 'replenish' | 'purchasing' | 'reports';

const TABS: { id: Tab; label: string; icon: React.ElementType }[] = [
  { id: 'suggestions', label: 'Alerts',    icon: TrendingDown },
  { id: 'transfer',   label: 'Transfer',   icon: ArrowLeftRight },
  { id: 'replenish',  label: 'Receive',    icon: Download },
  { id: 'stock',      label: 'Stock',      icon: Boxes },
  { id: 'purchasing', label: 'Purchase',   icon: ShoppingCart },
  { id: 'reports',    label: 'Reports',    icon: BarChart2 },
];

/** Width (px) below which the 5-column tab bar is replaced by a hamburger menu. */
const NARROW_THRESHOLD = 360;

/**
 * All-staff stock operations module. Accessible from the mobile bottom nav
 * and from a route on the iPad (/stock). Does NOT include item/variant setup —
 * that stays in the manager-only Admin Inventory section.
 *
 * Sub-surfaces:
 *  - Stock: main on-hand overview (all items, per-location breakdown, filters);
 *    the existing stock-take flow launches from a button here (not its own tab)
 *  - Alerts: par-level transfer suggestions + reorder-point flags (external supplier)
 *  - Transfer: fast inter-location batch transfer
 *  - Receive: replenish stock into a location (logs to RestockLog)
 *  - Purchase: supplier purchase orders (To order → Ordered → Received)
 *
 * On narrow screens (< 360 px) the tab bar collapses into a compact hamburger
 * header + dropdown menu so labels remain readable and tappable one-handed.
 * Switching widths mid-flow preserves the active section and any prefill state.
 */
export function MobileStock() {
  // S2-14b round 2 — the platform's stock, not the ported in-memory inventory:
  // every count, transfer, delivery and order here is a write to the branch's
  // ledger (`api/stock.ts`). Retired items and places stay out of staff stock
  // operations (`types.ts` InventoryItem.active).
  const { branch } = useBranch();
  const branchId = branch?.apiId ?? null;
  const stock = useStockModule(branchId);
  const inventory = stock.inventory.filter((i) => i.active !== false);
  const stockLocations = stock.locations.filter((l) => l.active);
  const [tab, setTab] = useState<Tab>('suggestions');
  // Stock-take flow launched from the Stock overview (button, not a tab)
  const [stockTakeActive, setStockTakeActive] = useState(false);
  const [prefillTransfer, setPrefillTransfer] = useState<
    Parameters<typeof StockTransferFlow>[0]['prefill']
  >(undefined);
  // Deep link from Purchase → Receive with an outstanding order pre-selected.
  const [prefillReceiveOrderId, setPrefillReceiveOrderId] = useState<string | undefined>(undefined);

  // --- Responsive tab bar ------------------------------------------------
  const containerRef = useRef<HTMLDivElement>(null);
  const [isNarrow, setIsNarrow] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      setIsNarrow(entry.contentRect.width < NARROW_THRESHOLD);
    });
    ro.observe(el);
    // Sync immediately with current size
    setIsNarrow(el.getBoundingClientRect().width < NARROW_THRESHOLD);
    return () => ro.disconnect();
  }, []);

  // Close the hamburger menu whenever the screen widens back to normal
  useEffect(() => {
    if (!isNarrow) setMenuOpen(false);
  }, [isNarrow]);
  // -----------------------------------------------------------------------

  const handleGoToReceive = (orderId: string) => {
    setPrefillReceiveOrderId(orderId);
    setTab('replenish');
  };

  const handleSuggestionTransfer = (s: Suggestion) => {
    if (!s.sourceLocationId) return;
    setPrefillTransfer({
      item: s.item,
      variant: s.variant,
      fromLocationId: s.sourceLocationId,
      toLocationId: s.locationId,
      qty: s.shortage,
    });
    setTab('transfer');
  };

  /** One-tap Reorder from the Suggestions tab: add to PO and switch to Purchasing.
   *
   * Total ordered qty equals reorderSettings.reorderQty for the item.
   * - Single-variant: one line at the full reorderQty.
   * - Multi-variant: one line per variant; qty distributed as floor(reorderQty/n)
   *   per variant, with any remainder added to the first variant so the total
   *   always equals reorderQty (no over-ordering).
   */
  const handleReorder = async (item: InventoryItem) => {
    if (!branchId) return;
    const rs = item.reorderSettings;
    if (!rs) return;

    const n = item.variants.length;
    const baseQty = Math.floor(rs.reorderQty / n);
    const remainder = rs.reorderQty - baseQty * n;

    // One write for every size: the platform puts them on the supplier's open
    // order (creating it when there is none) and merges a size already on it.
    const lines = item.variants
      .map((variant, idx) => ({ stockItemId: variant.id, quantity: baseQty + (idx === 0 ? remainder : 0) }))
      .filter((line) => line.quantity > 0);
    try {
      await stockApi.addToOrders(branchId, lines);
      setTab('purchasing');
    } catch (err) {
      window.alert(stockErrorWords(err));
    }
  };

  const handleTabChange = (t: Tab) => {
    if (t !== 'transfer') setPrefillTransfer(undefined);
    if (t !== 'replenish') setPrefillReceiveOrderId(undefined);
    if (t !== 'stock') setStockTakeActive(false);
    setTab(t);
    setMenuOpen(false);
  };

  const activeTab = TABS.find((t) => t.id === tab)!;

  return (
    <div ref={containerRef} className="flex flex-col h-full">
      {/* ── Tab navigation ─────────────────────────────────────────────── */}
      {isNarrow ? (
        /* Narrow layout: compact header with hamburger + dropdown menu */
        <div className="shrink-0 relative border-b">
          {/* Header row */}
          <div className="flex items-center gap-2 px-3 py-2.5">
            <button
              type="button"
              aria-label={menuOpen ? 'Close section menu' : 'Open section menu'}
              aria-expanded={menuOpen}
              onClick={() => setMenuOpen((o) => !o)}
              className="w-8 h-8 flex items-center justify-center rounded-md text-foreground hover:bg-muted transition-colors"
            >
              {menuOpen ? <X className="w-4 h-4" /> : <Menu className="w-4 h-4" />}
            </button>
            <activeTab.icon className="w-4 h-4 text-primary" />
            <span className="text-sm font-semibold text-foreground">{activeTab.label}</span>
          </div>

          {/* Dropdown menu */}
          {menuOpen && (
            <div className="absolute top-full left-0 right-0 z-50 bg-card border-b shadow-md">
              {TABS.map(({ id, label, icon: Icon }) => (
                <button
                  key={id}
                  type="button"
                  onClick={() => handleTabChange(id)}
                  className={`w-full flex items-center gap-3 px-4 py-3 text-sm font-medium transition-colors ${
                    tab === id
                      ? 'text-primary bg-primary/10'
                      : 'text-foreground hover:bg-muted'
                  }`}
                >
                  <Icon className={`w-4 h-4 shrink-0 ${tab === id ? 'text-primary' : 'text-muted-foreground'}`} />
                  {label}
                  {tab === id && (
                    <span className="ml-auto w-1.5 h-1.5 rounded-full bg-primary" />
                  )}
                </button>
              ))}
            </div>
          )}
        </div>
      ) : (
        /* Normal layout: 5-column tab bar — unchanged */
        <div
          className="shrink-0 grid border-b"
          style={{ gridTemplateColumns: `repeat(${TABS.length}, minmax(0,1fr))` }}
        >
          {TABS.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              type="button"
              onClick={() => handleTabChange(id)}
              className={`flex flex-col items-center justify-center gap-0.5 py-2.5 text-[10px] font-semibold transition-colors ${
                tab === id ? 'text-primary border-b-2 border-primary' : 'text-muted-foreground'
              }`}
            >
              <Icon className="w-4 h-4" />
              {label}
            </button>
          ))}
        </div>
      )}

      {/* ── Content ────────────────────────────────────────────────────── */}
      <div className="flex-1 min-h-0 overflow-y-auto">
        {/* The platform's answer, or why there is none: never the seed's figures. */}
        {(stock.error || (!stock.loaded && branchId)) && (
          <p role="status" className="mx-4 mt-3 rounded-lg border border-foreground/10 px-3 py-2 text-xs text-foreground/50">
            {stock.error ?? 'Loading stock…'}
          </p>
        )}
        {!branchId && (
          <p role="status" className="mx-4 mt-3 rounded-lg border border-foreground/10 px-3 py-2 text-xs text-foreground/50">
            This branch is not on the platform yet, so it has no stock to show.
          </p>
        )}
        {tab === 'stock' && !stockTakeActive && (
          <StockOverview
            inventory={inventory}
            locations={stockLocations}
            reorderPointNow={stock.reorderPointNow}
            onStartStockTake={() => setStockTakeActive(true)}
          />
        )}
        {tab === 'stock' && stockTakeActive && (
          <>
            <div className="px-4 pt-3 pb-0">
              <button
                type="button"
                onClick={() => setStockTakeActive(false)}
                className="flex items-center gap-1 text-xs text-primary"
              >
                <ChevronLeft className="w-3.5 h-3.5" />
                Back to stock
              </button>
            </div>
            <StockTakeFlow
              branchId={branchId}
              inventory={inventory}
              locations={stockLocations}
              onDone={() => setStockTakeActive(false)}
            />
          </>
        )}
        {tab === 'suggestions' && (
          <StockSuggestions
            inventory={inventory}
            locations={stockLocations}
            orders={stock.orders}
            attention={stock.attention}
            onResolveAttention={(id) => {
              if (!branchId) return;
              stockApi.resolveAttention(branchId, id).catch((err: unknown) => window.alert(stockErrorWords(err)));
            }}
            onStartTransfer={handleSuggestionTransfer}
            onReorder={(item) => void handleReorder(item)}
          />
        )}
        {tab === 'transfer' && (
          <>
            {prefillTransfer && (
              <div className="px-4 pt-3 pb-0">
                <button
                  type="button"
                  onClick={() => { setPrefillTransfer(undefined); setTab('suggestions'); }}
                  className="flex items-center gap-1 text-xs text-primary"
                >
                  <ChevronLeft className="w-3.5 h-3.5" />
                  Back to suggestions
                </button>
              </div>
            )}
            <StockTransferFlow
              branchId={branchId}
              inventory={inventory}
              locations={stockLocations}
              prefill={prefillTransfer}
              onDone={() => { setPrefillTransfer(undefined); setTab('suggestions'); }}
            />
          </>
        )}
        {tab === 'replenish' && (
          <StockReplenishFlow
            branchId={branchId}
            inventory={inventory}
            locations={stockLocations}
            orders={stock.orders}
            onDone={() => setTab('suggestions')}
            prefillOrderId={prefillReceiveOrderId}
          />
        )}
        {tab === 'purchasing' && (
          <StockPurchasing
            branchId={branchId}
            inventory={inventory}
            orders={stock.orders}
            onGoToReceive={handleGoToReceive}
          />
        )}
        {tab === 'reports' && (
          <StockReports
            branchId={branchId}
            inventory={inventory}
            locations={stockLocations}
          />
        )}
      </div>
    </div>
  );
}
