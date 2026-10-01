import { useMemo, useState } from 'react';
import { MerchItem } from '@/types';
import { isLowStock, isOutOfStock } from '@/lib/merch';
import { useSellableStockVersion, withPlatformStock } from '@/api/stock';
import { resolveRateToday } from '@/lib/pricingMode';
import { Card } from '@/components/ui/card';
import { ScrollArea } from '@/components/ui/scroll-area';
import { cn } from '@/lib/utils';
import { Plus, Ban, AlertTriangle } from 'lucide-react';

interface MerchGridProps {
  items: MerchItem[];
  // Units of each item already committed to the cart — drives the in-cart badge
  // and the remaining-availability clamp (can't add past on-hand stock).
  quantities: Record<string, number>;
  onAdd: (item: MerchItem) => void;
}

// Pseudo-id for the "All" chip that shows every item regardless of category.
const ALL = '__all__';
const labelFor = (item: MerchItem) => item.category?.trim() || 'Other';

function CatChip({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'px-5 h-12 rounded-xl font-bold transition-all active:scale-95',
        active
          ? 'bg-primary text-primary-foreground'
          : 'bg-card border text-muted-foreground hover:text-foreground hover:border-primary/50'
      )}
    >
      {label}
    </button>
  );
}

function StockLine({
  tracked,
  out,
  low,
  remaining,
  stock,
}: {
  /**
   * Whether anything counts this item at all (S2-09b).
   *
   * An item the platform does not stock-track (no stock item linked, S2-14b)
   * used to render its count as `Infinity in stock` — the literal word, on a
   * shelf tile, in front of a guest. It says nothing, which is the truth:
   * nobody is counting it.
   */
  tracked: boolean;
  out: boolean;
  low: boolean;
  remaining: number;
  stock: number;
}) {
  if (!tracked) return null;
  if (out) {
    return (
      <div className="flex items-center gap-1.5 text-xs font-bold text-destructive">
        <Ban className="w-3.5 h-3.5 shrink-0" />
        Out of stock
      </div>
    );
  }
  if (remaining <= 0) {
    return (
      <div className="flex items-center gap-1.5 text-xs font-semibold text-amber-400">
        <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
        All {stock} in cart
      </div>
    );
  }
  if (low) {
    return (
      <div className="flex items-center gap-1.5 text-xs font-semibold text-amber-400">
        <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
        Low stock · {remaining} left
      </div>
    );
  }
  return (
    <div className="text-xs text-muted-foreground tabular-nums">{remaining} in stock</div>
  );
}

export function MerchGrid({ items: given, quantities, onAdd }: MerchGridProps) {
  // S2-14b — the counts on the tiles are the platform's (`api/stock.ts`):
  // everything the branch holds, re-read after every sale the till closes.
  const stockVersion = useSellableStockVersion();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const items = useMemo(() => given.map(withPlatformStock), [given, stockVersion]);
  // Distinct free-text category labels — merch categories are plain strings
  // (not the structured F&B category tree). Uncategorised items group under "Other".
  const categories = useMemo(() => {
    const set = new Set<string>();
    for (const it of items) set.add(labelFor(it));
    return Array.from(set);
  }, [items]);

  const [active, setActive] = useState<string>(ALL);
  const activeCat = active === ALL || categories.includes(active) ? active : ALL;

  const shown = useMemo(() => {
    if (activeCat === ALL) return items;
    return items.filter((it) => labelFor(it) === activeCat);
  }, [items, activeCat]);

  return (
    <div className="flex flex-col h-full min-h-0">
      {categories.length > 1 && (
        <div className="flex gap-2 mb-3 shrink-0 flex-wrap">
          <CatChip label="All" active={activeCat === ALL} onClick={() => setActive(ALL)} />
          {categories.map((c) => (
            <CatChip
              key={c}
              label={c}
              active={activeCat === c}
              onClick={() => setActive(c)}
            />
          ))}
        </div>
      )}

      <ScrollArea className="flex-1 -mx-2 px-2">
        <div className="grid grid-cols-2 lg:grid-cols-3 gap-3 pb-2">
          {shown.map((item) => {
            const inCart = quantities[item.id] ?? 0;
            const tracked = item.stock !== undefined;
            const remaining = tracked ? item.stock! - inCart : Infinity;
            const out = isOutOfStock(item);
            const low = isLowStock(item);
            const blocked = out || remaining <= 0;
            return (
              <Card
                key={item.id}
                role="button"
                tabIndex={blocked ? -1 : 0}
                aria-disabled={blocked}
                onClick={() => {
                  if (!blocked) onAdd(item);
                }}
                onKeyDown={(e) => {
                  if ((e.key === 'Enter' || e.key === ' ') && !blocked) {
                    e.preventDefault();
                    onAdd(item);
                  }
                }}
                className={cn(
                  'relative p-4 flex flex-col justify-between min-h-[128px] select-none transition-all',
                  blocked
                    ? 'opacity-60 cursor-not-allowed'
                    : 'cursor-pointer active:scale-[0.97]',
                  inCart > 0 && !blocked
                    ? 'border-primary bg-primary/10 ring-1 ring-primary'
                    : !blocked
                      ? 'hover:border-primary/50'
                      : ''
                )}
              >
                {inCart > 0 && (
                  <div className="absolute top-2 right-2 min-w-7 h-7 px-2 rounded-full bg-primary text-primary-foreground text-sm font-bold flex items-center justify-center tabular-nums">
                    {inCart}
                  </div>
                )}
                {item.photoUrl && (
                  <img
                    src={item.photoUrl}
                    alt={item.name}
                    className="w-full h-24 object-cover rounded-lg mb-2 pointer-events-none select-none"
                    draggable={false}
                  />
                )}
                <div className="pr-8">
                  <div className="font-bold text-lg leading-tight">{item.name}</div>
                  {item.sku && (
                    <div className="text-[11px] text-muted-foreground font-mono mt-0.5">
                      {item.sku}
                    </div>
                  )}
                </div>
                <div className="mt-3">
                  <StockLine
                    tracked={tracked}
                    out={out}
                    low={low}
                    remaining={remaining}
                    stock={item.stock ?? 0}
                  />
                  <div className="flex items-center justify-between mt-2">
                    <span className="text-primary font-bold text-lg tabular-nums">
                      ฿{resolveRateToday(item.price)}
                    </span>
                    <span
                      className={cn(
                        'w-9 h-9 rounded-lg flex items-center justify-center shrink-0',
                        !blocked && inCart > 0
                          ? 'bg-primary text-primary-foreground'
                          : 'bg-muted text-muted-foreground'
                      )}
                    >
                      {blocked ? <Ban className="w-5 h-5" /> : <Plus className="w-5 h-5" />}
                    </span>
                  </div>
                </div>
              </Card>
            );
          })}
        </div>
      </ScrollArea>
    </div>
  );
}
