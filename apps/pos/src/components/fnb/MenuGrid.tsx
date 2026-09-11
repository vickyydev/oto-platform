import { useMemo, useState } from 'react';
import { MenuItem, MenuCategoryDef } from '@/types';
import { resolveRateToday } from '@/lib/pricingMode';
import { getMenuCategories, getInventoryItem } from '@/mockApi';
import { topLevelCategories, subCategoriesOf } from '@/lib/menu';
import { variantStatus, type VariantStatus } from '@/lib/inventory';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import { cn } from '@/lib/utils';
import { hasModifiers } from '@/lib/fnb';
import { UtensilsCrossed, CupSoda, Wine, Cookie, Plus, SlidersHorizontal, Search, X, type LucideIcon } from 'lucide-react';

interface MenuGridProps {
  items: MenuItem[];
  quantities: Record<string, number>;
  onAdd: (item: MenuItem) => void;
}

// Icons for the seeded categories; custom categories fall back to a generic one.
const CATEGORY_ICONS: Record<string, LucideIcon> = {
  food: UtensilsCrossed,
  drinks: CupSoda,
  bar: Wine,
  snacks: Cookie,
};
const iconFor = (id: string): LucideIcon => CATEGORY_ICONS[id] ?? UtensilsCrossed;

// Worst stock status across a menu item's tracked variants ('out' beats 'low').
// undefined when the item isn't stock-tracked (no inventory link) — no badge.
function menuItemStockStatus(item: MenuItem): VariantStatus | undefined {
  if (!item.inventoryItemId) return undefined;
  const inv = getInventoryItem(item.inventoryItemId);
  if (!inv || inv.variants.length === 0) return undefined;
  let worst: VariantStatus = 'ok';
  for (const v of inv.variants) {
    const s = variantStatus(v);
    if (s === 'out') return 'out';
    if (s === 'low') worst = 'low';
  }
  return worst;
}

interface MenuItemCardProps {
  item: MenuItem;
  qty: number;
  onAdd: (item: MenuItem) => void;
}

function MenuItemCard({ item, qty, onAdd }: MenuItemCardProps) {
  const inCart = qty > 0;
  const stock = menuItemStockStatus(item);
  const outOfStock = stock === 'out';
  return (
    <Card
      role="button"
      tabIndex={outOfStock ? -1 : 0}
      aria-disabled={outOfStock}
      onClick={() => !outOfStock && onAdd(item)}
      onKeyDown={(e) => {
        if (outOfStock) return;
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onAdd(item);
        }
      }}
      className={cn(
        'relative p-4 flex flex-col justify-between min-h-[112px] select-none transition-all',
        outOfStock
          ? 'opacity-50 cursor-not-allowed border-destructive/40'
          : 'cursor-pointer active:scale-[0.97]',
        !outOfStock && (inCart ? 'border-primary bg-primary/10 ring-1 ring-primary' : 'hover:border-primary/50')
      )}
    >
      {inCart && (
        <div className="absolute top-2 right-2 min-w-7 h-7 px-2 rounded-full bg-primary text-primary-foreground text-sm font-bold flex items-center justify-center tabular-nums">
          {qty}
        </div>
      )}
      {stock && stock !== 'ok' && !inCart && (
        <span
          className={cn(
            'absolute top-2 right-2 rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide',
            stock === 'out'
              ? 'bg-destructive text-destructive-foreground'
              : 'bg-amber-500 text-black'
          )}
        >
          {stock === 'out' ? 'Out' : 'Low'}
        </span>
      )}
      <div className="pr-8">
        <div className="font-bold text-lg leading-tight">{item.name}</div>
        {hasModifiers(item) && (
          <span className="inline-flex items-center gap-1 mt-1 text-[11px] font-medium text-muted-foreground">
            <SlidersHorizontal className="w-3 h-3" />
            Customizable
          </span>
        )}
      </div>
      <div className="flex items-center justify-between mt-3">
        <span className="text-primary font-bold text-lg tabular-nums">฿{resolveRateToday(item.price)}</span>
        <span
          className={cn(
            'w-9 h-9 rounded-lg flex items-center justify-center shrink-0',
            inCart ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground'
          )}
        >
          <Plus className="w-5 h-5" />
        </span>
      </div>
    </Card>
  );
}

// Pseudo-id for the "Other" sub-chip that gathers items assigned directly to a
// top-level category (i.e. not placed in any of its sub-categories).
const OTHER = '__other__';

// Case-insensitive match on the whole name OR any individual word in it, so
// "chick" or "rice" both find "Grilled Chicken Rice".
function matchesQuery(name: string, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const lower = name.toLowerCase();
  if (lower.includes(q)) return true;
  return lower.split(/\s+/).some((word) => word.includes(q));
}

export function MenuGrid({ items, quantities, onAdd }: MenuGridProps) {
  const [search, setSearch] = useState('');
  const query = search.trim();
  const searchResults = useMemo(
    () => (query ? items.filter((item) => matchesQuery(item.name, query)) : []),
    [items, query]
  );
  // Snapshot categories at mount (admin edits flow in on the next route mount),
  // matching how the POS reads the rest of the catalog.
  const categories = useMemo<MenuCategoryDef[]>(() => getMenuCategories(), []);
  const topLevels = useMemo(() => topLevelCategories(categories), [categories]);

  // Items grouped by their (sub)category id — an item's `category` may point at a
  // top-level category directly, or at one of its sub-categories.
  const grouped = useMemo(() => {
    const map: Record<string, MenuItem[]> = {};
    for (const cat of categories) map[cat.id] = [];
    for (const item of items) map[item.category]?.push(item);
    return map;
  }, [items, categories]);

  // How many items live under a top-level branch (direct + every sub-category).
  const branchCount = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const top of topLevels) {
      let n = grouped[top.id]?.length ?? 0;
      for (const sub of subCategoriesOf(top.id, categories)) {
        n += grouped[sub.id]?.length ?? 0;
      }
      counts[top.id] = n;
    }
    return counts;
  }, [topLevels, grouped, categories]);

  // Primary tabs: top-level categories that have at least one item in their branch.
  const visibleTopLevels = topLevels.filter((c) => (branchCount[c.id] ?? 0) > 0);

  const [activeTop, setActiveTop] = useState<string>(
    () => visibleTopLevels[0]?.id ?? ''
  );
  const activeTopId = visibleTopLevels.some((c) => c.id === activeTop)
    ? activeTop
    : visibleTopLevels[0]?.id ?? '';

  // Secondary chips for the active top-level: each sub-category that has items,
  // plus an "Other" chip when items sit directly on the top-level. Hidden
  // entirely when the top-level has no populated sub-categories (flat list).
  const subChips = useMemo(() => {
    if (!activeTopId) return [];
    const chips: { id: string; name: string }[] = [];
    for (const sub of subCategoriesOf(activeTopId, categories)) {
      if ((grouped[sub.id]?.length ?? 0) > 0) {
        chips.push({ id: sub.id, name: sub.name });
      }
    }
    // Only surface the catch-all when sub-categories exist AND direct items exist.
    if (chips.length > 0 && (grouped[activeTopId]?.length ?? 0) > 0) {
      chips.push({ id: OTHER, name: 'Other' });
    }
    return chips;
  }, [activeTopId, categories, grouped]);

  const [activeSub, setActiveSub] = useState<string>('');
  // Default the sub-selection to the first chip whenever the chip set changes.
  const activeSubId = useMemo(() => {
    if (subChips.length === 0) return '';
    return subChips.some((c) => c.id === activeSub) ? activeSub : subChips[0].id;
  }, [subChips, activeSub]);

  const shown = useMemo(() => {
    if (!activeTopId) return [];
    // No sub-chips → flat list of every item in the branch (direct items only,
    // since a populated sub-category would have produced a chip).
    if (subChips.length === 0) return grouped[activeTopId] ?? [];
    if (activeSubId === OTHER) return grouped[activeTopId] ?? [];
    return grouped[activeSubId] ?? [];
  }, [activeTopId, activeSubId, subChips, grouped]);

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="relative mb-3 shrink-0">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search dish…"
          className="h-11 pl-9 pr-9 text-base"
        />
        {search.length > 0 && (
          <button
            type="button"
            onClick={() => setSearch('')}
            aria-label="Clear search"
            className="absolute right-2 top-1/2 flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        )}
      </div>

      {query ? (
        <ScrollArea className="flex-1 -mx-2 px-2">
          {searchResults.length === 0 ? (
            <div className="flex h-32 items-center justify-center text-sm text-muted-foreground">
              No dishes match
            </div>
          ) : (
            <div className="grid grid-cols-2 lg:grid-cols-3 gap-3 pb-2">
              {searchResults.map((item) => (
                <MenuItemCard key={item.id} item={item} qty={quantities[item.id] ?? 0} onAdd={onAdd} />
              ))}
            </div>
          )}
        </ScrollArea>
      ) : (
        <>
          <div className="flex gap-2 mb-3 shrink-0 flex-wrap">
            {visibleTopLevels.map((cat) => {
              const Icon = iconFor(cat.id);
              const isActive = cat.id === activeTopId;
              return (
                <button
                  key={cat.id}
                  type="button"
                  onClick={() => {
                    setActiveTop(cat.id);
                    setActiveSub('');
                  }}
                  className={cn(
                    'flex items-center gap-2 px-5 h-12 rounded-xl font-bold transition-all active:scale-95',
                    isActive
                      ? 'bg-primary text-primary-foreground'
                      : 'bg-card border text-muted-foreground hover:text-foreground hover:border-primary/50'
                  )}
                >
                  <Icon className="w-5 h-5" />
                  {cat.name}
                </button>
              );
            })}
          </div>

          {/* Secondary level: sub-category chips (only when the top-level has them) */}
          {subChips.length > 0 && (
            <div className="shrink-0 mb-3 -mx-2 px-2 overflow-x-auto">
              <div className="flex gap-2 w-max">
                {subChips.map((chip) => {
                  const isActive = chip.id === activeSubId;
                  return (
                    <button
                      key={chip.id}
                      type="button"
                      onClick={() => setActiveSub(chip.id)}
                      className={cn(
                        'px-4 h-9 rounded-full text-sm font-semibold whitespace-nowrap transition-all active:scale-95',
                        isActive
                          ? 'bg-amber-500/20 text-amber-400 border border-amber-500'
                          : 'bg-card border text-muted-foreground hover:text-amber-400 hover:border-amber-500/50'
                      )}
                    >
                      {chip.name}
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          <ScrollArea className="flex-1 -mx-2 px-2">
            <div className="grid grid-cols-2 lg:grid-cols-3 gap-3 pb-2">
              {shown.map((item) => (
                <MenuItemCard key={item.id} item={item} qty={quantities[item.id] ?? 0} onAdd={onAdd} />
              ))}
            </div>
          </ScrollArea>
        </>
      )}
    </div>
  );
}
