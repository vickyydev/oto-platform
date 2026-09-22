import { useState, type ReactNode } from 'react';
import { CustomerTier, CartLine, Discount, ManualDiscount, ChargeTarget } from '@/types';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Separator } from '@/components/ui/separator';
import { computeTotals } from '@/lib/sale';
import { resolveFreeItem } from '@/lib/promoVoucher';
import { summarizeTax, roundTHB } from '@/lib/tax';
import { computeNannyGroups, resolveDropOffPricing } from '@/lib/dropoff';
import { getDropOffPricing, getAddOns } from '@/mockApi';
import { adultUnitDisplay, componentKey, priceForTier } from '@/lib/pricing';
import { resolveRateToday } from '@/lib/pricingMode';
import { formatDiscountDetail, formatDiscountTarget } from '@/lib/manualDiscount';
import { Ticket, User, Baby, Trash2, Tag, BadgePercent, Footprints, Minus, Plus, HandHeart, UserCheck, Pencil, AlertTriangle, ShoppingBag, PartyPopper, Gift, type LucideIcon } from 'lucide-react';

interface OrderSummaryProps {
  tier: CustomerTier | null;
  /** Customer nickname shown atop the panel (moved out of the nav bar). */
  customerName?: string;
  lines: CartLine[];
  activeLineId?: string | null;
  discounts: Discount[];
  manualDiscounts: ManualDiscount[];
  onUpdateLine: (id: string, updates: Partial<Pick<CartLine, 'kids' | 'adults' | 'socks'>>) => void;
  /** Open a drop-off line in its dedicated config view (step 3). */
  onConfigureLine?: (id: string) => void;
  onRemoveLine: (id: string) => void;
  /** Remove one applied promo code (by code) and its free-item line, if any. */
  onRemoveDiscount: (code: string) => void;
  /** Called when staff enter/scan a promo code and hit Apply. The parent
   *  validates and either calls setDiscount or sets promoError. */
  onApplyPromoCode?: (code: string) => void;
  /** When set, shows a rejection reason beneath the promo code input. */
  promoError?: string;
  onAddManualDiscount: () => void;
  onRemoveManualDiscount: (id: string) => void;
  onPay: () => void;
  onCancel: () => void;
  canPay: boolean;
  /** When set, this order is being billed to a party tab — shows a banner and
   *  swaps the Pay button for a "charge to party" action. */
  chargeTarget?: ChargeTarget;
  /** Override the primary-action button label (defaults to "Pay ฿{total}"). */
  payLabel?: string;
  /**
   * THE FIGURES TO SHOW, as the platform quoted them (S2-09a / SCRUM-203).
   *
   * Absent means "price it here", which is what every caller did before this
   * ticket and what the callers that are not the till still do — the party tab,
   * the booking screen and the mobile cart sheet own their own totals. The Till
   * passes the platform's quote, so the number a visitor is charged is the
   * number the platform computed rather than a second implementation of the
   * same rules that happens to agree.
   */
  totals?: Pick<
    ReturnType<typeof computeTotals>,
    'subtotal' | 'scannedDiscounts' | 'manualAmounts' | 'total' | 'taxBreakdown'
  >;
  /** Shown under the total when the figures did NOT come from the platform. */
  priceNote?: ReactNode;
}

function ManualDiscountRow({
  label,
  amount,
  reason,
  appliedBy,
  onRemove,
}: {
  label: string;
  amount: number;
  reason: string;
  appliedBy: string;
  onRemove: () => void;
}) {
  return (
    <div className="flex justify-between items-center text-emerald-500 bg-emerald-500/10 p-3 rounded-lg">
      <div className="flex items-center gap-2 min-w-0">
        <BadgePercent className="w-4 h-4 shrink-0" />
        <div className="min-w-0">
          <div className="font-medium truncate">{label}</div>
          <div className="text-xs text-emerald-500/70 truncate">
            {reason} · {appliedBy}
          </div>
        </div>
      </div>
      <div className="flex items-center gap-3 shrink-0">
        <span className="font-bold">-฿{amount}</span>
        <Button
          variant="ghost"
          size="icon"
          className="h-6 w-6 text-emerald-500 hover:bg-emerald-500/20 hover:text-emerald-600"
          onClick={onRemove}
        >
          <Trash2 className="w-4 h-4" />
        </Button>
      </div>
    </div>
  );
}

function QtyRow({
  icon: Icon,
  label,
  value,
  unitPrice,
  unitNote,
  onChange,
}: {
  icon: LucideIcon;
  label: string;
  value: number;
  unitPrice?: number;
  /** Appended to the "฿x each" hint, e.g. "1 free" on an adult free allowance. */
  unitNote?: string;
  onChange: (next: number) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="flex items-center gap-2 text-sm text-foreground min-w-0">
        <Icon className="w-4 h-4 text-muted-foreground shrink-0" />
        <span className="truncate">{label}</span>
        {unitPrice !== undefined && (
          <span className="text-xs text-muted-foreground tabular-nums shrink-0">
            ฿{unitPrice} each{unitNote ? ` · ${unitNote}` : ''}
          </span>
        )}
      </span>
      <div className="flex items-center gap-1.5 shrink-0">
        <button
          type="button"
          aria-label={`Remove one ${label}`}
          disabled={value <= 0}
          onClick={() => onChange(Math.max(0, value - 1))}
          className="w-8 h-8 rounded-md border bg-background flex items-center justify-center transition-transform hover:bg-muted active:scale-90 disabled:opacity-30 disabled:pointer-events-none"
        >
          <Minus className="w-4 h-4" />
        </button>
        <span className="w-7 text-center font-bold tabular-nums">{value}</span>
        <button
          type="button"
          aria-label={`Add one ${label}`}
          onClick={() => onChange(value + 1)}
          className="w-8 h-8 rounded-md bg-primary text-primary-foreground flex items-center justify-center transition-transform hover:bg-primary/90 active:scale-90"
        >
          <Plus className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
}

/**
 * The Adults stepper, priced by the line's own per-tier adult rule
 * (`set_price` / `free_adults` / `same_as_kid`) rather than by the kid price.
 * SCRUM-226: the kid price is what this row used to show, so the staff panel
 * quoted a figure the till never charged on every package this branch sells.
 */
function AdultQtyRow({ line, onChange }: { line: CartLine; onChange: (next: number) => void }) {
  const { unitPrice, note } = adultUnitDisplay(line.ticketType, line.tier, line.adults);
  return (
    <QtyRow
      icon={User}
      label="Adults"
      value={line.adults}
      unitPrice={unitPrice}
      unitNote={note}
      onChange={onChange}
    />
  );
}

export function OrderSummary({ tier, customerName, lines, activeLineId, discounts, manualDiscounts, onUpdateLine, onConfigureLine, onRemoveLine, onRemoveDiscount, onApplyPromoCode, promoError, onAddManualDiscount, onRemoveManualDiscount, onPay, onCancel, canPay, chargeTarget, payLabel, totals, priceNote }: OrderSummaryProps) {
  const [promoInput, setPromoInput] = useState('');

  const { subtotal, scannedDiscounts, manualAmounts, total, taxBreakdown } =
    totals ?? computeTotals(lines, discounts, manualDiscounts);
  const taxRows = summarizeTax(taxBreakdown);

  // Shared nanny supervision: one row per nanny (fee charged once across the kids
  // she covers), plus a pending row for any nanny line without a nanny yet.
  const nannyGroups = computeNannyGroups(lines, resolveDropOffPricing(getDropOffPricing()));

  // A drop-off child's own extras (socks + add-ons), excluding the service fee.
  const socksAddOn = getAddOns().find((a) => a.id === 'a-socks');
  const socksPrice = socksAddOn ? resolveRateToday(socksAddOn.price) : 0;
  const dropOffExtras = (line: CartLine) =>
    line.socks * socksPrice + line.addOns.reduce((sum, a) => sum + a.price * a.quantity, 0);

  // Whole-line discounts (no component target) — shown under the line as before.
  const lineDiscountsFor = (id: string) =>
    manualDiscounts.filter(
      (md) => md.scope === 'line' && md.targetLineId === id && !md.targetComponent,
    );
  // Discounts targeting one component of a line — shown under that component row.
  const componentDiscountsFor = (id: string, key: string) =>
    manualDiscounts.filter(
      (md) =>
        md.scope === 'line' &&
        md.targetLineId === id &&
        md.targetComponent &&
        componentKey(md.targetComponent) === key,
    );
  const renderComponentDiscounts = (id: string, key: string) =>
    componentDiscountsFor(id, key).map((md) => {
      const amt = manualAmounts[md.id] ?? 0;
      if (amt <= 0) return null;
      return (
        <div key={md.id} className="mt-1.5">
          <ManualDiscountRow
            label={`${formatDiscountTarget(md)} — ${formatDiscountDetail(md)}`}
            amount={amt}
            reason={md.reason}
            appliedBy={md.appliedBy}
            onRemove={() => onRemoveManualDiscount(md.id)}
          />
        </div>
      );
    });
  const orderDiscounts = manualDiscounts.filter((md) => md.scope === 'order');

  return (
    <div className="h-full flex flex-col">
      <div className="flex items-center justify-between mb-2">
        <h2 className="text-2xl font-bold">Current Order</h2>
        {tier && (
          <span className="px-3 py-1 rounded-full bg-primary/20 text-primary text-sm font-bold uppercase tracking-wider">
            {tier}
          </span>
        )}
      </div>

      {chargeTarget && (
        <div className="flex items-center gap-2 mb-3 rounded-lg bg-primary/15 border border-primary/30 px-3 py-2 text-primary">
          <PartyPopper className="w-4 h-4 shrink-0" />
          <span className="font-semibold text-sm truncate">
            Charging to {chargeTarget.partyTitle}
            {chargeTarget.childName ? ` · ${chargeTarget.childName}` : ''}
          </span>
        </div>
      )}

      {customerName && (
        <div className="flex items-center gap-2 mb-3 text-sm">
          <User className="w-4 h-4 text-primary shrink-0" />
          <span className="font-semibold text-foreground truncate">{customerName}</span>
        </div>
      )}

      <ScrollArea className="flex-1 -mx-6 px-6">
        {lines.length === 0 ? (
          <div className="h-full flex flex-col items-center justify-center text-muted-foreground pt-20">
            <Ticket className="w-16 h-16 mb-4 opacity-20" />
            <p>No items added yet</p>
          </div>
        ) : (
          <div className="space-y-2.5">
            {lines.map((line) => (
              <div
                key={line.id}
                className={`p-3 rounded-xl bg-card border group relative transition-all ${
                  line.id === activeLineId ? 'border-primary ring-1 ring-primary shadow-md' : ''
                }`}
              >
                {line.promoItem ? (
                  /* Synthetic free-item line: shelf price is in lineTotal; the
                     matching discount.value cancels it so grandTotal is unchanged.
                     Showing ฿0 to staff mirrors what the customer pays. */
                  <div className="flex justify-between items-center">
                    <div className="flex items-center gap-2 min-w-0">
                      <Gift className="w-4 h-4 text-emerald-400 shrink-0" />
                      <div className="min-w-0">
                        <div className="font-semibold text-emerald-300 leading-tight truncate">
                          {line.promoItem.name}
                        </div>
                        <div className="text-xs text-emerald-400/70 font-mono">
                          {line.id.replace(/^promo-/, '')} · Free item
                        </div>
                      </div>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <span className="font-bold text-emerald-300">฿0</span>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7 text-emerald-400 hover:bg-emerald-500/20 opacity-0 group-hover:opacity-100 transition-opacity"
                        onClick={() => onRemoveDiscount(line.id.replace(/^promo-/, ''))}
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </Button>
                    </div>
                  </div>
                ) : line.dropOff ? (
                  <>
                    <div className="flex justify-between items-start mb-1.5">
                      <div className="font-bold text-base flex items-center gap-2 min-w-0">
                        <HandHeart className="w-4 h-4 text-primary shrink-0" />
                        <span className="truncate">{line.dropOff.childName}</span>
                        {line.id === activeLineId && (
                          <span className="px-2 py-0.5 rounded-full bg-primary/20 text-primary text-[10px] font-bold uppercase tracking-wider shrink-0">
                            Editing
                          </span>
                        )}
                      </div>
                      {/* Nanny kids show the child's own charge (ticket + extras);
                          the shared nanny fee is its own row below. Plain drop-off
                          shows the full line (ticket + extras + one-time fee). */}
                      <div className="font-bold text-base shrink-0">
                        {line.dropOff.lengthChosen
                          ? `฿${line.dropOff.service === 'nanny' ? priceForTier(line.ticketType, line.tier) + dropOffExtras(line) : line.lineTotal}`
                          : '—'}
                      </div>
                    </div>
                    <div className="space-y-1 mt-1 text-sm text-muted-foreground">
                      {line.dropOff.lengthChosen ? (
                        <>
                          <div className="flex items-center justify-between gap-2">
                            <span className="flex items-center gap-2 min-w-0">
                              <Ticket className="w-4 h-4 shrink-0" />
                              <span className="truncate">{line.ticketType.name}</span>
                            </span>
                            <span className="tabular-nums shrink-0">฿{priceForTier(line.ticketType, line.tier)}</span>
                          </div>
                          {line.socks > 0 && (
                            <div className="flex items-center justify-between gap-2">
                              <span className="flex items-center gap-2 min-w-0">
                                <Footprints className="w-4 h-4 shrink-0" />
                                <span className="truncate">Regular Socks × {line.socks}</span>
                              </span>
                              <span className="tabular-nums shrink-0">฿{line.socks * socksPrice}</span>
                            </div>
                          )}
                          {line.addOns.map((a) => (
                            <div key={a.id} className="flex items-center justify-between gap-2">
                              <span className="flex items-center gap-2 min-w-0">
                                <ShoppingBag className="w-4 h-4 shrink-0" />
                                <span className="truncate">
                                  {a.name}
                                  {a.quantity > 1 && ` × ${a.quantity}`}
                                </span>
                              </span>
                              <span className="tabular-nums shrink-0">฿{a.price * a.quantity}</span>
                            </div>
                          ))}
                        </>
                      ) : (
                        <div className="flex items-center gap-2 text-amber-300">
                          <AlertTriangle className="w-4 h-4 shrink-0" /> Choose length
                        </div>
                      )}
                      <div className="flex items-center justify-between gap-2">
                        {line.dropOff.service === 'nanny' ? (
                          <span className="flex items-center gap-2 min-w-0">
                            <UserCheck className="w-4 h-4 shrink-0" />
                            <span className="truncate">
                              Nanny
                              {line.dropOff.nannyName ? ` · ${line.dropOff.nannyName}` : ''}
                            </span>
                          </span>
                        ) : (
                          <>
                            <span className="flex items-center gap-2 min-w-0">
                              <HandHeart className="w-4 h-4 shrink-0" />
                              <span className="truncate">Drop-off service</span>
                            </span>
                            {line.dropOff.lengthChosen && line.dropOff.serviceFeeTHB > 0 && (
                              <span className="tabular-nums shrink-0">฿{line.dropOff.serviceFeeTHB}</span>
                            )}
                          </>
                        )}
                      </div>
                      {line.dropOff.service === 'nanny' && !line.dropOff.nannyId && (
                        <div className="flex items-center gap-2 text-amber-300">
                          <AlertTriangle className="w-4 h-4 shrink-0" /> Assign a nanny
                        </div>
                      )}
                    </div>
                    {onConfigureLine && (
                      <Button
                        variant="outline"
                        size="sm"
                        className="mt-2 w-full gap-2"
                        onClick={() => onConfigureLine(line.id)}
                      >
                        <Pencil className="w-3.5 h-3.5" />
                        Configure
                      </Button>
                    )}
                  </>
                ) : (
                  <>
                <div className="flex justify-between items-start mb-1.5 gap-2">
                  <div className="font-bold text-base flex items-center gap-2 min-w-0">
                    <span className="truncate">{line.ticketType.name}</span>
                    {line.id === activeLineId && (
                      <span className="px-2 py-0.5 rounded-full bg-primary/20 text-primary text-[10px] font-bold uppercase tracking-wider shrink-0">
                        Editing
                      </span>
                    )}
                  </div>
                  <div className="font-bold text-base shrink-0">฿{line.lineTotal}</div>
                </div>
                <div className="space-y-1.5 mt-2">
                  <QtyRow
                    icon={Baby}
                    label="Kids"
                    value={line.kids}
                    unitPrice={priceForTier(line.ticketType, line.tier)}
                    onChange={(v) => onUpdateLine(line.id, { kids: v })}
                  />
                  {renderComponentDiscounts(line.id, 'kids')}
                  <AdultQtyRow
                    line={line}
                    onChange={(v) => onUpdateLine(line.id, { adults: v })}
                  />
                  {renderComponentDiscounts(line.id, 'adults')}
                  <QtyRow
                    icon={Footprints}
                    label="Regular Socks"
                    value={line.socks}
                    unitPrice={socksPrice}
                    onChange={(v) => onUpdateLine(line.id, { socks: v })}
                  />
                  {renderComponentDiscounts(line.id, 'socks')}
                  {line.addOns.length > 0 && (
                    <div className="pt-1 space-y-1 text-sm text-muted-foreground">
                      {line.addOns.map((a) => (
                        <div key={a.id}>
                          <div className="flex items-center justify-between gap-2">
                            <span className="flex items-center gap-2 min-w-0">
                              <ShoppingBag className="w-4 h-4 shrink-0" />
                              <span className="truncate">
                                {a.name}
                                {a.quantity > 1 && ` × ${a.quantity}`}
                              </span>
                            </span>
                            <span className="tabular-nums shrink-0">฿{a.price * a.quantity}</span>
                          </div>
                          {renderComponentDiscounts(line.id, `addon:${a.id}`)}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
                  </>
                )}
                {lineDiscountsFor(line.id).map((md) => {
                  const amt = manualAmounts[md.id] ?? 0;
                  if (amt <= 0) return null;
                  return (
                    <div key={md.id} className="mt-3">
                      <ManualDiscountRow
                        label={formatDiscountDetail(md)}
                        amount={amt}
                        reason={md.reason}
                        appliedBy={md.appliedBy}
                        onRemove={() => onRemoveManualDiscount(md.id)}
                      />
                    </div>
                  );
                })}
                <Button 
                  variant="ghost" 
                  size="icon" 
                  className="absolute -top-2 -right-2 h-8 w-8 rounded-full bg-destructive text-destructive-foreground opacity-0 group-hover:opacity-100 transition-opacity"
                  onClick={() => onRemoveLine(line.id)}
                >
                  <Trash2 className="w-4 h-4" />
                </Button>
              </div>
            ))}

            {nannyGroups.length > 0 && (
              <div className="mt-2 pt-3 border-t space-y-2">
                <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  <UserCheck className="w-4 h-4" /> Nanny supervision
                </div>
                {nannyGroups.map((g) => (
                  <div
                    key={g.key}
                    className="flex justify-between items-start gap-2 text-sm bg-card border rounded-lg p-3"
                  >
                    <div className="min-w-0">
                      {g.assigned ? (
                        <>
                          <div className="font-semibold text-foreground truncate">
                            Nanny · {g.nannyName}
                          </div>
                          <div className="text-xs text-muted-foreground truncate">
                            {g.childNames.length > 1
                              ? `Covers ${g.childNames.join(', ')} · ${g.hours}h`
                              : `${g.childNames[0]} · ${g.hours}h`}
                          </div>
                        </>
                      ) : (
                        <div className="font-semibold text-amber-300 flex items-center gap-1.5">
                          <AlertTriangle className="w-4 h-4 shrink-0" />
                          Nanny — assign for {g.childNames[0]}
                        </div>
                      )}
                    </div>
                    <div className="font-bold shrink-0 tabular-nums">฿{g.fee}</div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </ScrollArea>

      <div className="mt-4 space-y-3 pt-4 border-t">
        {/* Applied percent / fixed promo code badges (one row per code — codes
            stack only when every applied code is marked stackable).
            free_item promos are rendered as a cart-area line above (฿0 item),
            not here, because they are item grants, not bill deductions. */}
        {scannedDiscounts
          .filter((sd) => sd.type !== 'free_item')
          .map((sd) => (
            <div key={sd.code} className="flex justify-between items-center text-emerald-500 bg-emerald-500/10 p-3 rounded-lg">
              <div className="flex items-center gap-2">
                <Tag className="w-4 h-4" />
                <div>
                  <div className="font-medium leading-tight">{sd.label}</div>
                  <div className="text-xs text-emerald-500/70 font-mono">{sd.code}</div>
                </div>
              </div>
              <div className="flex items-center gap-3">
                <span className="font-bold">-฿{sd.amount.toFixed(0)}</span>
                <Button variant="ghost" size="icon" className="h-6 w-6 text-emerald-500 hover:bg-emerald-500/20 hover:text-emerald-600" onClick={() => onRemoveDiscount(sd.code)}>
                  <Trash2 className="w-4 h-4" />
                </Button>
              </div>
            </div>
          ))}

        {/* Promo code entry — always available so additional stackable codes can
            be added; non-stackable combinations are rejected on apply. */}
        {onApplyPromoCode && (
          <div className="space-y-1.5">
            <div className="flex gap-2">
              <input
                type="text"
                value={promoInput}
                onChange={(e) => setPromoInput(e.target.value.toUpperCase())}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && promoInput.trim()) {
                    onApplyPromoCode(promoInput.trim());
                  }
                }}
                placeholder="Promo code…"
                className="flex-1 h-9 rounded-xl border border-foreground/10 bg-black/20 px-3 text-sm font-mono uppercase tracking-wide placeholder:normal-case placeholder:tracking-normal text-foreground placeholder:text-foreground/30 focus:outline-none focus:ring-2 focus:ring-primary/50 transition-colors"
                disabled={lines.length === 0}
              />
              <Button
                size="sm"
                variant="outline"
                className="h-9 px-3 shrink-0"
                disabled={!promoInput.trim() || lines.length === 0}
                onClick={() => {
                  if (promoInput.trim()) {
                    onApplyPromoCode(promoInput.trim());
                  }
                }}
              >
                Apply
              </Button>
            </div>
            {promoError && (
              <p className="text-xs text-rose-400 px-1">{promoError}</p>
            )}
          </div>
        )}

        {orderDiscounts.map((md) => {
          const amt = manualAmounts[md.id] ?? 0;
          if (amt <= 0) return null;
          return (
            <ManualDiscountRow
              key={md.id}
              label={`${formatDiscountTarget(md)} · ${formatDiscountDetail(md)}`}
              amount={amt}
              reason={md.reason}
              appliedBy={md.appliedBy}
              onRemove={() => onRemoveManualDiscount(md.id)}
            />
          );
        })}

        <Button
          variant="outline"
          className="w-full gap-2 border-dashed"
          onClick={onAddManualDiscount}
          disabled={lines.length === 0}
        >
          <BadgePercent className="w-4 h-4" />
          Add manual discount
        </Button>

        <div className="space-y-2 text-lg">
          <div className="flex justify-between text-muted-foreground">
            <span>Subtotal</span>
            <span>฿{subtotal}</span>
          </div>
          {taxRows.map((row) => (
            <div key={row.key} className="flex justify-between text-muted-foreground text-sm">
              <span>{row.label}</span>
              <span className="tabular-nums">฿{roundTHB(row.amount)}</span>
            </div>
          ))}
          <Separator />
          <div className="flex justify-between font-bold text-2xl pt-2">
            <span>Total</span>
            <span className="text-primary">฿{total}</span>
          </div>
          {priceNote}
        </div>

        <div className="grid grid-cols-3 gap-3 pt-2">
          <Button variant="outline" size="lg" className="col-span-1" onClick={onCancel}>
            Cancel
          </Button>
          <Button 
            size="lg" 
            className="col-span-2 text-xl font-bold h-14" 
            onClick={onPay}
            disabled={!canPay}
          >
            {payLabel ?? `Pay ฿${total}`}
          </Button>
        </div>
      </div>
    </div>
  );
}
