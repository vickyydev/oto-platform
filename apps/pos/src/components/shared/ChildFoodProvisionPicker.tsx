import { useMemo, useState } from 'react';
import { ChildFoodProvision, ChildFoodProvisionMode, PrepaidItem } from '@/types';
import { getMenuItems, getMenuCategories } from '@/mockApi';
import { resolveRateToday } from '@/lib/pricingMode';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { UtensilsCrossed, Wallet, ShoppingBasket, AlertTriangle, Plus, Minus } from 'lucide-react';

interface ChildFoodProvisionPickerProps {
  /** Name of the child this provision applies to (for display only). */
  childName: string;
  /** The child's declared allergies — surfaced when picking prepaid items. */
  allergiesMedical?: string;
  /** Current value (controlled). */
  value: ChildFoodProvision;
  onChange: (v: ChildFoodProvision) => void;
  /**
   * Visual context: 'dark' for the door customer-consent screen
   * (sky/slate gradient), 'default' for light-mode admin surfaces.
   */
  variant?: 'dark' | 'default';
}

const NONE_PROVISION: ChildFoodProvision = { mode: 'none', paidTHB: 0 };

function computePaidTHB(
  mode: ChildFoodProvisionMode,
  creditAmount: number,
  items: PrepaidItem[],
): number {
  if (mode === 'prepaid_credit') return Math.max(0, creditAmount);
  if (mode === 'prepaid_items') return items.reduce((s, i) => s + i.unitPriceTHB * i.qty, 0);
  return 0;
}

/**
 * Portable food-provision picker for a single drop-off / nanny child. Used on
 * the door customer-consent screen; also portable enough to drop into the
 * public booking site later. No door- or booking-specific imports — only mockApi
 * catalog reads and standard shared UI.
 *
 * Three choices:
 *   No food        — mode:'none', blocks ordering at the F&B station
 *   Prepaid credit — parent pays ฿ amount loaded onto the band as F&B credit
 *                    (not taxed at load; taxed at spend)
 *   Prepaid items  — parent picks specific items from the menu (taxed now as F&B)
 *
 * The child's declared allergies are surfaced prominently when items are being
 * selected so the parent doesn't accidentally pre-order something unsafe.
 */
export function ChildFoodProvisionPicker({
  childName,
  allergiesMedical,
  value,
  onChange,
  variant = 'dark',
}: ChildFoodProvisionPickerProps) {
  const dark = variant === 'dark';

  // Local state for the credit amount input string (avoids the 0 → clear flicker).
  const [creditStr, setCreditStr] = useState<string>(
    value.creditAmountTHB != null && value.creditAmountTHB > 0
      ? String(value.creditAmountTHB)
      : '',
  );

  const allItems = useMemo(() => getMenuItems(), []);
  const allCategories = useMemo(() => getMenuCategories(), []);

  // Current item quantities (keyed by menuItemId).
  const qtyMap = useMemo(() => {
    const m: Record<string, number> = {};
    (value.items ?? []).forEach((i) => { m[i.menuItemId] = i.qty; });
    return m;
  }, [value.items]);

  const setMode = (mode: ChildFoodProvisionMode) => {
    if (mode === 'none') {
      onChange(NONE_PROVISION);
    } else if (mode === 'prepaid_credit') {
      const amt = parseFloat(creditStr) || 0;
      onChange({ mode, creditAmountTHB: amt, paidTHB: Math.max(0, amt) });
    } else {
      const items = value.items ?? [];
      onChange({
        mode,
        items,
        paidTHB: computePaidTHB('prepaid_items', 0, items),
      });
    }
  };

  const handleCreditChange = (raw: string) => {
    setCreditStr(raw);
    const amt = parseFloat(raw) || 0;
    onChange({ mode: 'prepaid_credit', creditAmountTHB: amt, paidTHB: Math.max(0, amt) });
  };

  const handleItemQty = (menuItemId: string, qty: number) => {
    const item = allItems.find((i) => i.id === menuItemId);
    if (!item) return;
    const next: PrepaidItem[] = qty <= 0
      ? (value.items ?? []).filter((i) => i.menuItemId !== menuItemId)
      : (value.items ?? []).some((i) => i.menuItemId === menuItemId)
        ? (value.items ?? []).map((i) =>
            i.menuItemId === menuItemId ? { ...i, qty } : i,
          )
        : [
            ...(value.items ?? []),
            // redeemedQty starts at 0 and is incremented at the F&B station as
            // each entitlement is served — reconciled against qty at pickup.
            { menuItemId: item.id, menuItemName: item.name, unitPriceTHB: resolveRateToday(item.price), qty, redeemedQty: 0 },
          ];
    onChange({
      mode: 'prepaid_items',
      items: next,
      paidTHB: computePaidTHB('prepaid_items', 0, next),
    });
  };

  const base = dark ? 'text-foreground' : 'text-foreground';
  const cardBase = dark
    ? 'rounded-2xl border border-foreground/10 bg-foreground/5 p-4'
    : 'rounded-2xl border border-border bg-card p-4';
  const modeBtn = (active: boolean) =>
    cn(
      'flex flex-1 flex-col items-center gap-1.5 rounded-xl border px-3 py-3 transition-all',
      active
        ? dark
          ? 'border-primary bg-primary/20 text-primary'
          : 'border-primary bg-primary/10 text-primary ring-1 ring-primary'
        : dark
          ? 'border-foreground/10 bg-foreground/5 text-foreground/60 hover:border-foreground/30 hover:text-foreground'
          : 'border-border bg-background text-muted-foreground hover:border-primary/40',
    );

  return (
    <div className="space-y-3">
      {/* Mode picker */}
      <div className="flex gap-2">
        <button type="button" className={modeBtn(value.mode === 'none')} onClick={() => setMode('none')}>
          <UtensilsCrossed className="h-5 w-5" />
          <span className="text-sm font-semibold">No food</span>
        </button>
        <button type="button" className={modeBtn(value.mode === 'prepaid_credit')} onClick={() => setMode('prepaid_credit')}>
          <Wallet className="h-5 w-5" />
          <span className="text-sm font-semibold text-center leading-tight">Prepaid credit</span>
        </button>
        <button type="button" className={modeBtn(value.mode === 'prepaid_items')} onClick={() => setMode('prepaid_items')}>
          <ShoppingBasket className="h-5 w-5" />
          <span className="text-sm font-semibold text-center leading-tight">Choose items</span>
        </button>
      </div>

      {/* No food explanation */}
      {value.mode === 'none' && (
        <p className={cn('text-sm', dark ? 'text-foreground/50' : 'text-muted-foreground')}>
          Staff will not be able to place food orders for {childName || 'this child'} without a manager override.
        </p>
      )}

      {/* Prepaid credit input */}
      {value.mode === 'prepaid_credit' && (
        <div className={cardBase}>
          <p className={cn('mb-3 text-sm', dark ? 'text-foreground/70' : 'text-muted-foreground')}>
            Enter an amount to load onto {childName || "the child"}'s wristband as spendable credit.
            The credit is NOT taxed now — it is taxed when spent at the counter.
          </p>
          <div className="relative">
            <span className={cn('pointer-events-none absolute inset-y-0 left-3 flex items-center text-lg font-bold', dark ? 'text-foreground/60' : 'text-muted-foreground')}>฿</span>
            <Input
              type="number"
              inputMode="numeric"
              min={0}
              step={50}
              value={creditStr}
              onChange={(e) => handleCreditChange(e.target.value)}
              placeholder="0"
              className={cn(
                'h-14 pl-8 text-2xl font-bold',
                dark && 'border-foreground/10 bg-foreground/5 text-foreground placeholder:text-foreground/30',
              )}
            />
          </div>
          {(value.creditAmountTHB ?? 0) > 0 && (
            <p className={cn('mt-2 text-sm font-semibold', dark ? 'text-primary' : 'text-primary')}>
              ฿{value.creditAmountTHB} will be added to the total and loaded onto the band at payment.
            </p>
          )}
        </div>
      )}

      {/* Prepaid items picker */}
      {value.mode === 'prepaid_items' && (
        <div className="space-y-3">
          {/* Allergy alert — shown prominently so parent doesn't pre-buy unsafe items */}
          {allergiesMedical?.trim() && (
            <div className={cn(
              'flex items-start gap-2 rounded-xl border p-3',
              dark
                ? 'border-amber-500/40 bg-amber-500/10 text-amber-200'
                : 'border-amber-500/40 bg-amber-50 text-amber-800',
            )}>
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-400" />
              <div className="text-sm">
                <span className="font-bold">Allergy / medical: </span>
                {allergiesMedical}
              </div>
            </div>
          )}

          {/* Items grouped by category */}
          {allCategories.map((cat) => {
            const items = allItems.filter((i) => i.category === cat.id);
            if (items.length === 0) return null;
            return (
              <div key={cat.id} className={cardBase}>
                <div className={cn('mb-2 text-xs font-bold uppercase tracking-widest', dark ? 'text-foreground/40' : 'text-muted-foreground')}>
                  {cat.name}
                </div>
                <div className="space-y-2">
                  {items.map((item) => {
                    const qty = qtyMap[item.id] ?? 0;
                    return (
                      <div key={item.id} className="flex items-center gap-3">
                        <div className="min-w-0 flex-1">
                          <div className={cn('text-sm font-medium', base)}>{item.name}</div>
                          <div className={cn('text-xs', dark ? 'text-foreground/50' : 'text-muted-foreground')}>฿{resolveRateToday(item.price)}</div>
                        </div>
                        <div className="flex items-center gap-2">
                          <Button
                            type="button"
                            size="icon"
                            variant="outline"
                            className={cn('h-8 w-8 rounded-lg', dark && 'border-foreground/10 bg-foreground/5 text-foreground hover:bg-foreground/10')}
                            onClick={() => handleItemQty(item.id, qty - 1)}
                            disabled={qty === 0}
                          >
                            <Minus className="h-3 w-3" />
                          </Button>
                          <span className={cn('w-5 text-center text-sm font-bold tabular-nums', base)}>{qty}</span>
                          <Button
                            type="button"
                            size="icon"
                            variant="outline"
                            className={cn('h-8 w-8 rounded-lg', dark && 'border-foreground/10 bg-foreground/5 text-foreground hover:bg-foreground/10')}
                            onClick={() => handleItemQty(item.id, qty + 1)}
                          >
                            <Plus className="h-3 w-3" />
                          </Button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}

          {/* Running total */}
          {value.paidTHB > 0 ? (
            <div className={cn('rounded-xl border p-3', dark ? 'border-primary/30 bg-primary/10' : 'border-primary/20 bg-primary/5')}>
              <div className="flex items-center justify-between">
                <span className={cn('text-sm font-semibold', dark ? 'text-primary' : 'text-primary')}>
                  Prepaid items total
                </span>
                <span className={cn('text-lg font-bold tabular-nums', dark ? 'text-primary' : 'text-primary')}>
                  ฿{value.paidTHB}
                </span>
              </div>
              <p className={cn('mt-1 text-xs', dark ? 'text-foreground/50' : 'text-muted-foreground')}>
                These items are taxed now and loaded as entitlements on the band.
              </p>
            </div>
          ) : (
            <p className={cn('text-sm', dark ? 'text-foreground/50' : 'text-muted-foreground')}>
              Pick at least one item above to proceed with prepaid items.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
