import { FnbOrder } from '@/types';
import { buildPrepTickets, describeModifiers } from '@/lib/fnb';
import { getPrintTemplate } from '@/mockApi';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { StaffBenefitBreakdown } from '@/components/fnb/StaffBenefitBreakdown';
import {
  CheckCircle2,
  ChefHat,
  Wine,
  Wallet,
  Banknote,
  CreditCard,
  Plus,
  Hash,
  Printer,
  AlertTriangle,
  ShieldX,
  StickyNote,
  QrCode as QrCodeIcon,
  Gift,
} from 'lucide-react';

interface FnbConfirmationProps {
  order: FnbOrder;
  newBalance: number | null;
  onNewOrder: () => void;
  /**
   * THE RECEIPT NUMBER THE PLATFORM ALLOCATED (S2-09b), when the order reached
   * the ledger. Null on a station with no platform station behind it, where
   * `SaleNotSavedNotice` above says why — so the absence of a number is never
   * silent, and its presence is the proof the order is in the day's takings
   * rather than in this browser.
   */
  receiptNumber?: string | null;
  /**
   * When true (mobile portrait), the whole confirmation flows naturally and the
   * surrounding page scrolls — the items list is NOT trapped in a fixed-height
   * inner ScrollArea (which collapses and overlaps siblings on a short screen).
   * Defaults to the bounded iPad panel layout.
   */
  flowLayout?: boolean;
}

export function FnbConfirmation({
  order,
  newBalance,
  onNewOrder,
  receiptNumber = null,
  flowLayout = false,
}: FnbConfirmationProps) {
  const { payment } = order;
  const bounded = !flowLayout;
  // Simulated kitchen/bar ticket previews — what each prep station receives.
  const prepTickets = buildPrepTickets(order);
  // Printout CONTENT follows the active templates (routing is unchanged). With
  // no template configured, default to showing everything.
  const receiptTpl = getPrintTemplate('receipt');
  const showReceiptItems = receiptTpl ? !!receiptTpl.fields.itemizedLines : true;

  return (
    <div
      className={`flex flex-col items-center p-6 animate-in zoom-in-95 duration-400 ${
        bounded ? 'h-full overflow-y-auto' : 'min-h-full'
      }`}
    >
      <div className="w-full max-w-xl flex flex-col my-auto">
        <div className="flex flex-col items-center text-center mb-5 shrink-0">
          <div className="w-20 h-20 rounded-full bg-emerald-500/20 text-emerald-500 flex items-center justify-center mb-3">
            <CheckCircle2 className="w-11 h-11" />
          </div>
          <h2 className="text-3xl font-bold tracking-tight">Order Confirmed</h2>
          <div className="flex items-center gap-2 text-primary mt-2 text-lg font-medium">
            <ChefHat className="w-5 h-5" />
            Sent to kitchen &amp; bar
          </div>
          {receiptTpl?.headerText && (
            <p className="text-muted-foreground/80 mt-1 text-sm font-semibold tracking-wide">
              {receiptTpl.headerText}
            </p>
          )}
          <p className="text-muted-foreground mt-1">
            Order #{order.id}
            {order.wristband ? ` • ${order.wristband.customerNickname}` : ' • Guest'}
          </p>
          {receiptNumber && (
            <p className="mt-1 text-sm font-semibold tabular-nums text-foreground/80">
              Receipt {receiptNumber}
            </p>
          )}
        </div>

        <Card className="p-4 mb-4 shrink-0 flex items-center justify-between bg-primary/5 border-primary/30">
          <div className="flex items-center gap-3">
            <div className="w-11 h-11 rounded-xl bg-primary/20 text-primary flex items-center justify-center shrink-0">
              <Hash className="w-6 h-6" />
            </div>
            <div>
              <div className="text-sm text-muted-foreground">Pick-up code</div>
              <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <Printer className="w-3 h-3" />
                Printed on receipt
              </div>
            </div>
          </div>
          <div className="text-3xl font-bold text-primary tabular-nums tracking-widest">
            {order.pickupCode}
          </div>
        </Card>

        <Card className="p-5 flex flex-col bg-card/50 mb-4">
          <div className="text-xs font-bold uppercase tracking-wide text-muted-foreground mb-3 shrink-0">
            Items
          </div>
          <div className="-mx-2 px-2">
            {showReceiptItems ? (
              <div className="space-y-2">
                {order.lines.map((line) => {
                  const mods = describeModifiers(line.menuItem, line.selectedModifiers);
                  const isPrepaid = !!line.isPrepaid;
                  return (
                    <div key={line.id} className={`flex items-start justify-between gap-3 text-sm ${isPrepaid ? 'rounded-lg bg-violet-500/10 px-2 py-1.5 -mx-2' : ''}`}>
                      <span className="min-w-0">
                        <span className="font-bold tabular-nums">{line.qty}×</span>{' '}
                        {isPrepaid && <Gift className="inline w-3.5 h-3.5 text-violet-400 mr-1 -mt-0.5" />}
                        <span className={isPrepaid ? 'text-violet-100' : ''}>{line.menuItem.name}</span>
                        {isPrepaid && (
                          <span className="ml-1.5 rounded px-1.5 py-0.5 bg-violet-500/30 text-violet-300 text-[10px] font-bold uppercase tracking-wide">
                            Prepaid
                          </span>
                        )}
                        {mods.length > 0 && (
                          <span className="block text-xs text-muted-foreground">{mods.join(', ')}</span>
                        )}
                        {line.note && (
                          <span className="flex items-start gap-1 text-xs text-amber-300">
                            <StickyNote className="w-3 h-3 mt-0.5 shrink-0" />
                            {line.note}
                          </span>
                        )}
                      </span>
                      <span className={`font-bold tabular-nums shrink-0 ${isPrepaid ? 'text-violet-300' : ''}`}>
                        {isPrepaid ? '฿0' : `฿${line.lineTotal}`}
                      </span>
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="text-xs text-muted-foreground italic px-1">
                Itemized lines hidden by the receipt template.
              </div>
            )}
          </div>

          <div className="border-t mt-3 pt-3 space-y-1.5 shrink-0">
            {order.staffBenefit && order.staffBenefit.totalReliefTHB > 0 && (
              <StaffBenefitBreakdown
                data={{
                  scannedOperatorName: order.staffBenefit.scannedOperatorName,
                  compedTHB: order.staffBenefit.compedTHB,
                  freeItemsTHB: order.staffBenefit.freeItemsTHB,
                  creditTHB: order.staffBenefit.creditTHB,
                  discountTHB: order.staffBenefit.discountTHB,
                  totalReliefTHB: order.staffBenefit.totalReliefTHB,
                }}
              />
            )}
            <div className="flex items-center justify-between text-lg font-bold">
              <span>Total</span>
              <span className="tabular-nums">฿{order.total}</span>
            </div>
            {payment.creditUsed > 0 && (
              <PaidRow icon={Wallet} label="F\&B credit" amount={payment.creditUsed} />
            )}
            {payment.cash > 0 && <PaidRow icon={Banknote} label="Cash" amount={payment.cash} />}
            {payment.card > 0 && <PaidRow icon={CreditCard} label="Card" amount={payment.card} />}
            {payment.promptpay > 0 && (
              <PaidRow icon={QrCodeIcon} label="Thai QR / PromptPay" amount={payment.promptpay} />
            )}
            {receiptTpl?.footerText && (
              <div className="pt-1 text-center text-xs italic text-muted-foreground/70">
                {receiptTpl.footerText}
              </div>
            )}
          </div>
        </Card>

        {order.orderNote && (
          <Card className="p-3 mb-4 shrink-0 flex items-start gap-2.5 bg-amber-500/10 border-amber-500/40 text-amber-300">
            <StickyNote className="w-5 h-5 shrink-0 mt-0.5" />
            <div className="text-sm min-w-0">
              <span className="font-bold">Order note: </span>
              {order.orderNote}
            </div>
          </Card>
        )}

        {order.foodConsentOverride && (
          <Card className="p-3 mb-4 shrink-0 flex items-center gap-2.5 bg-amber-500/10 border-amber-500/40 text-amber-300">
            <ShieldX className="w-5 h-5 shrink-0" />
            <span className="text-sm">
              Food override by {order.foodConsentOverride.byName} — parent had not authorized food.
            </span>
          </Card>
        )}

        {prepTickets.length > 0 && (
          <div className="shrink-0 mb-4 grid gap-3 sm:grid-cols-2">
            {prepTickets.map((ticket) => {
              // Each prep ticket renders the sections its template enables; with
              // no template, default to showing everything.
              const tpl = getPrintTemplate(
                ticket.station === 'kitchen' ? 'kitchen_ticket' : 'bar_ticket',
              );
              const show = (v?: boolean) => (tpl ? !!v : true);
              const showHolder = show(tpl?.fields.holderName);
              const showAllergy = show(tpl?.fields.allergyLine);
              const showItems = show(tpl?.fields.itemizedLines);
              const showNotes = show(tpl?.fields.orderNotes);
              const showRef = show(tpl?.fields.orderRefTime);
              return (
                <Card
                  key={ticket.station}
                  className="p-4 bg-card/50 border-dashed flex flex-col"
                >
                  <div className="flex items-center gap-2 mb-2 text-sm font-bold">
                    {ticket.station === 'kitchen' ? (
                      <ChefHat className="w-4 h-4 text-primary" />
                    ) : (
                      <Wine className="w-4 h-4 text-primary" />
                    )}
                    {ticket.title} ticket
                  </div>
                  {showRef && (
                    <div className="text-[11px] text-muted-foreground mb-1.5 tabular-nums">
                      #{order.id} • {order.pickupCode}
                    </div>
                  )}
                  {showHolder && ticket.holderName && (
                    <div className="text-xs text-muted-foreground mb-1.5">For {ticket.holderName}</div>
                  )}
                  {showAllergy && ticket.allergiesMedical && (
                    <div className="mb-2 rounded-lg bg-red-500/15 border border-red-500/40 px-2.5 py-1.5 text-xs font-bold text-red-400 flex items-start gap-1.5">
                      <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                      <span>ALLERGY: {ticket.allergiesMedical}</span>
                    </div>
                  )}
                  {showItems && (
                    <ul className="space-y-1 text-sm">
                      {ticket.lines.map((line) => (
                        <li key={line.id} className="tabular-nums">
                          <span className="font-bold">{line.qty}×</span>{' '}
                          {line.menuItem.name}
                          {line.isPrepaid && (
                            <span className="ml-1.5 inline-flex items-center gap-0.5 rounded px-1.5 py-0.5 bg-violet-500/30 text-violet-300 text-[10px] font-bold uppercase tracking-wide">
                              <Gift className="w-2.5 h-2.5" />
                              Prepaid
                            </span>
                          )}
                          {showNotes && line.note && (
                            <span className="flex items-start gap-1 text-xs text-amber-300 not-italic">
                              <StickyNote className="w-3 h-3 mt-0.5 shrink-0" />
                              {line.note}
                            </span>
                          )}
                        </li>
                      ))}
                    </ul>
                  )}
                  {showNotes && ticket.orderNote && (
                    <div className="mt-2 pt-2 border-t border-dashed flex items-start gap-1.5 text-xs text-amber-300">
                      <StickyNote className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                      <span className="min-w-0">{ticket.orderNote}</span>
                    </div>
                  )}
                </Card>
              );
            })}
          </div>
        )}

        {order.wristband && newBalance !== null && (
          <Card className="p-4 mb-4 shrink-0 bg-primary/5 border-primary/30">
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-xl bg-primary/20 text-primary flex items-center justify-center">
                  <Wallet className="w-5 h-5" />
                </div>
                <div>
                  <div className="text-sm text-muted-foreground">Remaining credit</div>
                  <div className="text-xs text-muted-foreground">{order.wristband.customerNickname}</div>
                </div>
              </div>
              <div className="text-2xl font-bold text-primary tabular-nums">฿{newBalance}</div>
            </div>
            {order.wristband.ledger && order.wristband.ledger.length > 0 && (
              <div className="border-t border-primary/20 pt-2 space-y-1">
                <div className="text-[10px] font-bold uppercase tracking-wide text-muted-foreground mb-1">Wallet ledger</div>
                {order.wristband.ledger.slice().reverse().map((entry, i) => (
                  <div key={i} className="flex items-center justify-between text-xs text-muted-foreground">
                    <span className="capitalize">
                      {entry.kind}
                      <span className="opacity-70"> · {entry.source.replace(/_/g, ' ')}</span>
                      {entry.by ? <span className="opacity-60"> · {entry.by}</span> : null}
                    </span>
                    <span className={`tabular-nums font-semibold ${entry.amountTHB < 0 ? 'text-red-400' : 'text-emerald-400'}`}>
                      {entry.amountTHB > 0 ? '+' : ''}฿{entry.amountTHB}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </Card>
        )}

        <Button size="lg" className="w-full h-16 text-xl font-bold gap-2 shrink-0" onClick={onNewOrder}>
          <Plus className="w-6 h-6" />
          New Order
        </Button>
      </div>
    </div>
  );
}

function PaidRow({ icon: Icon, label, amount }: { icon: typeof Wallet; label: string; amount: number }) {
  return (
    <div className="flex items-center justify-between text-sm text-muted-foreground">
      <span className="flex items-center gap-2">
        <Icon className="w-4 h-4" />
        {label}
      </span>
      <span className="tabular-nums">฿{amount}</span>
    </div>
  );
}
