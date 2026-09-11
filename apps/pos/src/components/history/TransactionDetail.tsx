import { useMemo, useState } from 'react';
import { useLocation } from 'wouter';
import { TxnSummary, Sale, FnbOrder, MerchOrder } from '@/types';
import {
  getRecordByKind,
  getDiscountReasons,
  getExtensionOptions,
  recordRefund,
  recordReprint,
  recordExtension,
} from '@/mockApi';
import { computeLineBreakdown } from '@/lib/pricing';
import { computeTotals } from '@/lib/sale';
import { computeMerchTotals } from '@/lib/merch';
import {
  paymentMethodLabel,
  paymentMethodIcon,
  paymentMethodKind,
  refundModeForMethod,
  type RefundMode,
} from '@/lib/payments';
import { computeFnbTotals, describeModifiers } from '@/lib/fnb';
import { summarizeTax, roundTHB } from '@/lib/tax';
import { tierLabel } from '@/lib/membership';
import { useOperator } from '@/auth/OperatorContext';
import { setCorrectedOrder } from '@/lib/correctedOrder';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { ScrollArea } from '@/components/ui/scroll-area';
import { StatusBadge } from './StatusBadge';
import { RefundModal, RefundLineOption, RefundResult } from './RefundModal';
import { ReprintModal, ReprintItemOption } from './ReprintModal';
import { AddTimeModal, AddTimeResult } from './AddTimeModal';
import {
  ArrowLeft,
  Ticket,
  GlassWater,
  ShoppingBag,
  Undo2,
  Wallet,
  Banknote,
  CreditCard,
  QrCode as QrCodeIcon,
  User as UserIcon,
  Users,
  Clock,
  RotateCcw,
  Plus,
  Check,
  Printer,
  Timer,
} from 'lucide-react';

interface TransactionDetailProps {
  txn: TxnSummary;
  onBack: () => void;
  onChanged: () => void;
}

const fmtTime = (iso: string) =>
  new Date(iso).toLocaleString('en-GB', {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });

export function TransactionDetail({ txn, onBack, onChanged }: TransactionDetailProps) {
  const { operator } = useOperator();
  const [, setLocation] = useLocation();
  const [refundOpen, setRefundOpen] = useState(false);
  const [reprintOpen, setReprintOpen] = useState(false);
  const [addTimeOpen, setAddTimeOpen] = useState(false);
  const [localVersion, setLocalVersion] = useState(0);
  const [justRefunded, setJustRefunded] = useState(false);
  const [flash, setFlash] = useState<string | null>(null);

  const record = useMemo<Sale | FnbOrder | MerchOrder | null>(
    () => getRecordByKind(txn.kind, txn.id),
    // localVersion forces a re-read after an in-place refund mutation.
    [txn.id, txn.kind, localVersion],
  );

  if (!record) {
    return (
      <div className="flex h-full items-center justify-center text-muted-foreground">
        Transaction not found.
      </div>
    );
  }

  const alreadyRefunded = record.refunds.reduce((acc, r) => acc + r.amountTHB, 0);
  const remaining = Math.max(0, record.total - alreadyRefunded);

  const sale = txn.kind === 'ticket' ? (record as Sale) : null;
  const order = txn.kind === 'fnb' ? (record as FnbOrder) : null;
  const merch = txn.kind === 'merch' ? (record as MerchOrder) : null;
  // F&B and merch share the same wristband + multi-tender payment shape, so
  // identity / money / credit rows read through this combined handle.
  const payOrder = order ?? merch;

  // Customer identity: tickets carry nickname + phone (or walk-in); F&B/merch
  // orders are tied to a scanned wristband (nickname + band code).
  const customerName = sale
    ? sale.customerNickname?.trim() || 'Walk-in'
    : payOrder!.wristband?.customerNickname || (merch ? 'Retail order' : 'Wristband order');
  const customerSub = sale
    ? sale.customerPhone || undefined
    : payOrder!.wristband
      ? `Band ${payOrder!.wristband.code}`
      : undefined;

  const braceletCount = sale ? sale.bracelets.children + sale.bracelets.adults : 0;

  // Re-derive the charge breakdown so the detail view shows subtotal → discounts
  // → total exactly as it was rung up (F&B has no scanned promo, only manual).
  const subtotal = record.lines.reduce((acc, l) => acc + l.lineTotal, 0);
  const manualDiscounts = record.manualDiscounts;
  const manualDiscountAmount = manualDiscounts.reduce((acc, d) => acc + d.amountTHB, 0);
  const scannedDiscounts = sale
    ? computeTotals(sale.lines, sale.discounts ?? [], sale.manualDiscounts).scannedDiscounts
    : [];
  const scannedDiscountAmount = scannedDiscounts.reduce((acc, sd) => acc + sd.amount, 0);

  // Re-derive the tax/service breakdown the same way it was rung up, so the
  // receipt reports the same VAT/service lines as the live till.
  const taxBreakdown = sale
    ? computeTotals(sale.lines, sale.discounts ?? [], sale.manualDiscounts).taxBreakdown
    : merch
      ? computeMerchTotals(merch.lines, merch.manualDiscounts).taxBreakdown
      : computeFnbTotals(order!.lines, order!.manualDiscounts).taxBreakdown;
  const taxRows = summarizeTax(taxBreakdown);

  // F&B credit still restorable to the wristband (F&B paid by credit only).
  const creditAlreadyRestored = record.refunds.reduce((acc, r) => acc + r.creditRestoredTHB, 0);
  const restorableCredit = payOrder
    ? Math.max(0, payOrder.payment.creditUsed - creditAlreadyRestored)
    : 0;

  // Refund routing HINT (advisory, not persisted): tickets route by the sale's
  // tender; F&B routes by its non-credit tender (card/QR auto-reverse, cash manual).
  const refundMode: RefundMode = sale
    ? sale.paymentMethod
      ? refundModeForMethod(sale.paymentMethod)
      : 'manual'
    : payOrder && (payOrder.payment.card > 0 || payOrder.payment.promptpay > 0)
      ? 'auto'
      : 'manual';

  const lineOptions: RefundLineOption[] = sale
    ? sale.lines.filter(l => !l.promoItem).map((l) => ({
        id: l.id,
        label: `${l.ticketType.name} · ${l.kids + l.adults} ppl`,
        amount: l.lineTotal,
      }))
    : merch
      ? merch.lines.map((l) => ({
          id: l.id,
          label: `${l.qty}× ${l.merchItem.name}`,
          amount: l.lineTotal,
        }))
      : order!.lines.map((l) => ({
          id: l.id,
          label: `${l.qty}× ${l.menuItem.name}`,
          amount: l.lineTotal,
        }));

  const reprints = record.reprints ?? [];
  const extensions = sale?.extensions ?? [];

  // Everything reprintable on this transaction: receipt + (tickets) each bracelet
  // group and each credit grant; (F&B) the pickup ticket.
  const reprintItems: ReprintItemOption[] = [{ id: 'receipt', label: 'Full receipt' }];
  if (sale) {
    if (sale.bracelets.children > 0)
      reprintItems.push({
        id: 'br-child',
        label: 'Child bracelet',
        sublabel: `×${sale.bracelets.children}`,
      });
    if (sale.bracelets.adults > 0)
      reprintItems.push({
        id: 'br-adult',
        label: 'Adult bracelet',
        sublabel: `×${sale.bracelets.adults}`,
      });
    sale.creditGrants.forEach((v) =>
      reprintItems.push({
        id: v.id,
        label: v.label,
        sublabel: v.quantity ? `×${v.quantity}` : v.valueTHB != null ? `฿${v.valueTHB}` : undefined,
      }),
    );
  }
  if (order) {
    reprintItems.push({ id: 'pickup', label: `Pickup ticket #${order.pickupCode}` });
  }

  const handleConfirmReprint = (labels: string[]) => {
    if (!operator) return;
    recordReprint({
      transactionId: record.id,
      kind: txn.kind,
      items: labels,
      reprintedBy: operator.name,
      reprintedById: operator.id,
    });
    setLocalVersion((v) => v + 1);
    setFlash(`Sent ${labels.length} item${labels.length > 1 ? 's' : ''} to the printer`);
  };

  const handleConfirmAddTime = (result: AddTimeResult) => {
    if (!operator || !sale) return;
    recordExtension({
      transactionId: record.id,
      label: result.label,
      minutesAdded: result.minutesAdded,
      braceletCount: result.braceletCount,
      amountTHB: result.amountTHB,
      paymentMethod: result.paymentMethod,
      extendedBy: operator.name,
      extendedById: operator.id,
    });
    setLocalVersion((v) => v + 1);
    setFlash(
      `Added ${result.label} to ${result.braceletCount} of ${braceletCount} bracelet${braceletCount > 1 ? 's' : ''}`,
    );
  };

  const handleConfirmRefund = (result: RefundResult) => {
    if (!operator) return;
    recordRefund({
      transactionId: record.id,
      kind: txn.kind,
      scope: result.scope,
      amountTHB: result.amountTHB,
      creditRestoredTHB: result.creditRestoredTHB,
      wristbandId: payOrder?.wristband?.id,
      reason: result.reason,
      note: result.note,
      refundedBy: operator.name,
      refundedById: operator.id,
      refundedLineIds: result.lineIds,
    });
    setLocalVersion((v) => v + 1);
    setJustRefunded(true);
    onChanged();
  };

  // "Start corrected order" — stash a prefill and jump to the originating station.
  const handleCorrectedOrder = () => {
    if (sale) {
      setCorrectedOrder({
        kind: 'ticket',
        tier: sale.tier,
        lines: sale.lines,
        memberId: sale.memberId,
        customerPhone: sale.customerPhone,
        customerNickname: sale.customerNickname,
      });
      setLocation('/');
    } else if (order) {
      setCorrectedOrder({ kind: 'fnb', lines: order.lines, wristband: order.wristband });
      setLocation('/order-station');
    }
  };

  const handleNewSale = () =>
    setLocation(sale ? '/' : merch ? '/merch-station' : '/order-station');

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* Header */}
      <div className="shrink-0 flex items-center justify-between gap-3 mb-4">
        <Button variant="ghost" className="gap-2" onClick={onBack}>
          <ArrowLeft className="w-4 h-4" />
          Back to history
        </Button>
        <StatusBadge status={record.status} />
      </div>

      <div className="flex-1 min-h-0 grid grid-cols-1 lg:grid-cols-[1fr_380px] gap-6">
        {/* Left: contents */}
        <Card className="p-6 flex flex-col min-h-0 bg-card/50">
          <div className="flex items-start gap-4 mb-5 shrink-0">
            <div className="w-16 h-16 rounded-2xl bg-primary/15 text-primary flex items-center justify-center shrink-0">
              {sale ? (
                <Ticket className="w-8 h-8" />
              ) : merch ? (
                <ShoppingBag className="w-8 h-8" />
              ) : (
                <GlassWater className="w-8 h-8" />
              )}
            </div>
            <div className="min-w-0 flex-1">
              <div className="text-2xl font-black leading-tight tracking-tight">
                {sale ? 'Ticket sale' : merch ? 'Retail sale' : 'F&B order'}{' '}
                <span className="text-primary">{txn.reference}</span>
              </div>
              <div className="text-lg font-semibold flex items-center gap-2 mt-1.5">
                <UserIcon className="w-5 h-5 text-primary shrink-0" />
                <span className="truncate">{customerName}</span>
                {customerSub && (
                  <span className="text-muted-foreground font-normal text-base">· {customerSub}</span>
                )}
              </div>
              <div className="text-sm text-muted-foreground flex items-center gap-1.5 mt-1.5">
                <Clock className="w-4 h-4" />
                {fmtTime(record.createdAt)} · sold by {record.operatorName}
              </div>
              {sale?.bookingReference && (
                <div className="mt-2 inline-flex items-center gap-1.5 rounded-lg bg-primary/15 text-primary px-2.5 py-1 text-sm font-semibold">
                  <QrCodeIcon className="w-4 h-4" />
                  Booking {sale.bookingReference}
                </div>
              )}
            </div>
          </div>

          <ScrollArea className="flex-1 -mx-2 px-2">
            <div className="space-y-3">
              {sale &&
                sale.lines.map((line) => (
                  <div key={line.id} className="rounded-xl border bg-background/40 p-4">
                    {line.promoItem ? (
                      <div className="flex items-center justify-between text-emerald-400">
                        <span className="font-bold">🎁 Free: {line.promoItem.name}</span>
                        <span className="tabular-nums font-bold">฿0</span>
                      </div>
                    ) : (
                      <>
                        <div className="flex items-center justify-between font-bold text-lg">
                          <span>
                            {line.ticketType.name}
                            <span className="text-muted-foreground font-normal text-base"> · {tierLabel(line.tier)}</span>
                          </span>
                          <span className="tabular-nums">฿{line.lineTotal}</span>
                        </div>
                        <div className="mt-2 space-y-1">
                          {computeLineBreakdown(line).map((b) => (
                            <div key={b.key} className="flex justify-between text-sm text-muted-foreground">
                              <span>
                                {b.label} {b.quantity}× ฿{b.unitPrice}
                              </span>
                              <span className="tabular-nums">฿{b.subtotal}</span>
                            </div>
                          ))}
                        </div>
                      </>
                    )}
                  </div>
                ))}
              {order &&
                order.lines.map((line) => {
                  const mods = describeModifiers(line.menuItem, line.selectedModifiers);
                  const unitPrice = Math.round(line.lineTotal / line.qty);
                  return (
                    <div key={line.id} className="rounded-xl border bg-background/40 p-4">
                      <div className="flex items-start justify-between gap-3 text-lg">
                        <span className="min-w-0 font-bold">{line.menuItem.name}</span>
                        <span className="font-bold tabular-nums shrink-0">฿{line.lineTotal}</span>
                      </div>
                      <div className="flex justify-between text-sm text-muted-foreground mt-1">
                        <span className="tabular-nums">
                          {line.qty} × ฿{unitPrice}
                        </span>
                      </div>
                      {mods.length > 0 && (
                        <span className="block text-sm text-muted-foreground mt-1">
                          {mods.join(', ')}
                        </span>
                      )}
                    </div>
                  );
                })}
              {merch &&
                merch.lines.map((line) => {
                  const unitPrice = Math.round(line.lineTotal / line.qty);
                  return (
                    <div key={line.id} className="rounded-xl border bg-background/40 p-4">
                      <div className="flex items-start justify-between gap-3 text-lg">
                        <span className="min-w-0 font-bold">{line.merchItem.name}</span>
                        <span className="font-bold tabular-nums shrink-0">฿{line.lineTotal}</span>
                      </div>
                      <div className="flex justify-between text-sm text-muted-foreground mt-1">
                        <span className="tabular-nums">
                          {line.qty} × ฿{unitPrice}
                        </span>
                      </div>
                    </div>
                  );
                })}
            </div>
          </ScrollArea>

          {/* Issued summary — prominent stat cards (tickets) */}
          {sale && (braceletCount > 0 || sale.creditGrants.length > 0) && (
            <div className="shrink-0 mt-4 grid grid-cols-1 sm:grid-cols-2 gap-3">
              {braceletCount > 0 && (
                <div className="rounded-xl border bg-background/40 p-4">
                  <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-wide text-muted-foreground mb-2">
                    <Users className="w-4 h-4" />
                    Bracelets printed
                  </div>
                  <div className="flex items-end justify-between gap-3">
                    <span className="text-4xl font-black tabular-nums leading-none">
                      {braceletCount}
                    </span>
                    <div className="text-sm text-muted-foreground text-right leading-snug">
                      {sale.bracelets.children > 0 && <div>{sale.bracelets.children} child</div>}
                      {sale.bracelets.adults > 0 && <div>{sale.bracelets.adults} adult</div>}
                    </div>
                  </div>
                </div>
              )}
              {sale.creditGrants.length > 0 && (
                <div className="rounded-xl border bg-background/40 p-4">
                  <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-wide text-muted-foreground mb-2">
                    <Wallet className="w-4 h-4" />
                    Credit grants issued
                  </div>
                  <div className="space-y-1.5">
                    {sale.creditGrants.map((v) => (
                      <div key={v.id} className="flex items-center justify-between gap-2 text-sm">
                        <span className="truncate">
                          {v.quantity ? `${v.quantity}× ` : ''}
                          {v.label}
                        </span>
                        {v.valueTHB != null && (
                          <span className="tabular-nums font-semibold shrink-0">฿{v.valueTHB}</span>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Pickup ticket (F&B) */}
          {order && (
            <div className="shrink-0 mt-4 rounded-xl border bg-background/40 p-4 flex items-center justify-between">
              <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-wide text-muted-foreground">
                <GlassWater className="w-4 h-4" />
                Pickup ticket
              </div>
              <span className="text-2xl font-black tabular-nums">#{order.pickupCode}</span>
            </div>
          )}
        </Card>

        {/* Right: money + refunds + actions */}
        <div className="flex flex-col min-h-0 gap-4">
          <Card className="p-6 shrink-0 bg-card/50 space-y-3">
            {/* Charge breakdown: subtotal → discounts → total */}
            {(manualDiscountAmount > 0 || scannedDiscountAmount > 0 || taxRows.length > 0) && (
              <div className="space-y-1 pb-2 border-b text-sm">
                <div className="flex items-center justify-between text-muted-foreground">
                  <span>Subtotal</span>
                  <span className="tabular-nums">฿{subtotal}</span>
                </div>
                {manualDiscounts.map((d) => (
                  <div key={d.id} className="flex items-start justify-between text-emerald-400">
                    <span className="min-w-0">
                      <span className="block truncate">
                        {d.type === 'comp'
                          ? 'Comp'
                          : d.type === 'percent'
                            ? `${d.value}% off`
                            : 'Discount'}
                        {d.targetLabel ? ` · ${d.targetLabel}` : ''}
                      </span>
                      <span className="block text-xs text-muted-foreground">
                        {d.reason}
                        {d.note ? ` — ${d.note}` : ''} · by {d.appliedBy}
                      </span>
                    </span>
                    <span className="tabular-nums shrink-0">−฿{d.amountTHB}</span>
                  </div>
                ))}
                {scannedDiscounts
                  .filter((sd) => sd.type !== 'free_item')
                  .map((sd) => (
                    <div key={sd.code} className="flex items-center justify-between text-emerald-400">
                      <span className="truncate">Promo · {sd.label}</span>
                      <span className="tabular-nums shrink-0">−฿{sd.amount}</span>
                    </div>
                  ))}
                {taxRows.map((row) => (
                  <div key={row.key} className="flex items-center justify-between text-muted-foreground">
                    <span>{row.label}</span>
                    <span className="tabular-nums">฿{roundTHB(row.amount)}</span>
                  </div>
                ))}
              </div>
            )}
            <div className="flex items-end justify-between gap-3">
              <span className="text-base font-semibold text-muted-foreground">Total paid</span>
              <span className="text-4xl font-black tabular-nums leading-none">฿{record.total}</span>
            </div>
            <div className="border-t pt-3 space-y-2">
              {sale && (
                <PayRow
                  icon={sale.paymentMethod ? paymentMethodIcon(paymentMethodKind(sale.paymentMethod)) : Wallet}
                  label={sale.paymentMethod ? paymentMethodLabel(sale.paymentMethod) : 'Payment'}
                  amount={sale.total}
                />
              )}
              {payOrder && payOrder.payment.creditUsed > 0 && (
                <PayRow
                  icon={Wallet}
                  label="Credit"
                  amount={payOrder.payment.creditUsed}
                />
              )}
              {payOrder && payOrder.payment.cash > 0 && (
                <PayRow icon={Banknote} label="Cash" amount={payOrder.payment.cash} />
              )}
              {payOrder && payOrder.payment.card > 0 && (
                <PayRow icon={CreditCard} label="Card" amount={payOrder.payment.card} />
              )}
              {payOrder && payOrder.payment.promptpay > 0 && (
                <PayRow icon={QrCodeIcon} label="Thai QR / PromptPay" amount={payOrder.payment.promptpay} />
              )}
            </div>
            {alreadyRefunded > 0 && (
              <div className="border-t pt-2 flex items-center justify-between text-rose-400 font-semibold">
                <span>Refunded</span>
                <span className="tabular-nums">−฿{alreadyRefunded}</span>
              </div>
            )}
          </Card>

          {/* Prior refunds */}
          {record.refunds.length > 0 && (
            <Card className="p-4 shrink-0 bg-card/50">
              <div className="text-xs font-bold uppercase tracking-wide text-muted-foreground mb-2">
                Refund history
              </div>
              <div className="space-y-2">
                {record.refunds.map((r) => (
                  <div key={r.id} className="text-sm border-l-2 border-rose-500/40 pl-3">
                    <div className="flex items-center justify-between">
                      <span className="font-semibold text-rose-400 tabular-nums">−฿{r.amountTHB}</span>
                      <span className="text-xs text-muted-foreground">{fmtTime(r.refundedAt)}</span>
                    </div>
                    <div className="text-muted-foreground">
                      {r.reason}
                      {r.creditRestoredTHB > 0 && ` · ฿${r.creditRestoredTHB} to wristband`}
                    </div>
                    {r.note && <div className="text-xs text-muted-foreground italic">“{r.note}”</div>}
                    <div className="text-xs text-muted-foreground">by {r.refundedBy}</div>
                  </div>
                ))}
              </div>
            </Card>
          )}

          {/* Time added (tickets) */}
          {extensions.length > 0 && (
            <Card className="p-4 shrink-0 bg-card/50">
              <div className="text-xs font-bold uppercase tracking-wide text-muted-foreground mb-2">
                Time added
              </div>
              <div className="space-y-2">
                {extensions.map((e) => (
                  <div key={e.id} className="text-sm border-l-2 border-primary/40 pl-3">
                    <div className="flex items-center justify-between">
                      <span className="font-semibold flex items-center gap-1.5">
                        <Timer className="w-3.5 h-3.5 text-primary" />
                        {e.label}
                      </span>
                      <span className="font-semibold tabular-nums">฿{e.amountTHB}</span>
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {e.braceletCount} bracelet{e.braceletCount > 1 ? 's' : ''} ·{' '}
                      {paymentMethodLabel(e.paymentMethod)} · {fmtTime(e.extendedAt)} · by {e.extendedBy}
                    </div>
                  </div>
                ))}
              </div>
            </Card>
          )}

          {/* Reprint history */}
          {reprints.length > 0 && (
            <Card className="p-4 shrink-0 bg-card/50">
              <div className="text-xs font-bold uppercase tracking-wide text-muted-foreground mb-2">
                Reprint history
              </div>
              <div className="space-y-2">
                {reprints.map((rp) => (
                  <div key={rp.id} className="text-sm border-l-2 border-primary/40 pl-3">
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-medium flex items-center gap-1.5 min-w-0">
                        <Printer className="w-3.5 h-3.5 text-primary shrink-0" />
                        <span className="truncate">{rp.items.join(', ')}</span>
                      </span>
                      <span className="text-xs text-muted-foreground shrink-0">
                        {fmtTime(rp.reprintedAt)}
                      </span>
                    </div>
                    <div className="text-xs text-muted-foreground">by {rp.reprintedBy}</div>
                  </div>
                ))}
              </div>
            </Card>
          )}

          {/* Flash confirmation for reprint / add-time */}
          {flash && (
            <div className="shrink-0 rounded-lg border border-emerald-500/40 bg-emerald-500/10 p-3 text-sm font-medium text-emerald-400 flex items-center gap-2">
              <Check className="w-4 h-4 shrink-0" />
              {flash}
            </div>
          )}

          {/* Actions */}
          {justRefunded ? (
            <Card className="p-4 bg-card/50 space-y-2">
              <div className="text-sm font-semibold flex items-center gap-2 text-emerald-400">
                <Check className="w-4 h-4" />
                Refund recorded
              </div>
              {(sale || order) && (
                <Button className="w-full h-12 gap-2" onClick={handleCorrectedOrder}>
                  <RotateCcw className="w-4 h-4" />
                  Start corrected order
                </Button>
              )}
              <Button variant="outline" className="w-full h-12 gap-2" onClick={handleNewSale}>
                <Plus className="w-4 h-4" />
                New sale
              </Button>
              <Button variant="ghost" className="w-full h-12" onClick={onBack}>
                Done
              </Button>
            </Card>
          ) : (
            <div className="shrink-0 space-y-2">
              <div className="grid grid-cols-2 gap-2">
                <Button
                  variant="outline"
                  className="h-14 text-base gap-2"
                  onClick={() => {
                    setFlash(null);
                    setReprintOpen(true);
                  }}
                >
                  <Printer className="w-5 h-5" />
                  Reprint
                </Button>
                {sale && braceletCount > 0 && (
                  <Button
                    variant="outline"
                    className="h-14 text-base gap-2"
                    onClick={() => {
                      setFlash(null);
                      setAddTimeOpen(true);
                    }}
                  >
                    <Timer className="w-5 h-5" />
                    Add time
                  </Button>
                )}
              </div>
              {remaining > 0 ? (
                <Button
                  className="w-full h-14 text-lg gap-2 bg-rose-500 hover:bg-rose-600 text-white"
                  onClick={() => setRefundOpen(true)}
                >
                  <Undo2 className="w-5 h-5" />
                  Refund (฿{remaining} left)
                </Button>
              ) : (
                <div className="rounded-lg border border-dashed p-4 text-center text-sm text-muted-foreground">
                  Fully refunded — nothing left to refund.
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      <RefundModal
        open={refundOpen}
        onOpenChange={setRefundOpen}
        maxRefund={remaining}
        restorableCredit={restorableCredit}
        lines={lineOptions}
        reasons={getDiscountReasons()}
        operatorName={operator?.name ?? ''}
        refundMode={refundMode}
        onConfirm={handleConfirmRefund}
      />

      <ReprintModal
        open={reprintOpen}
        onOpenChange={setReprintOpen}
        items={reprintItems}
        operatorName={operator?.name ?? ''}
        onConfirm={handleConfirmReprint}
      />

      {sale && braceletCount > 0 && (
        <AddTimeModal
          open={addTimeOpen}
          onOpenChange={setAddTimeOpen}
          braceletCount={braceletCount}
          options={getExtensionOptions()}
          operatorName={operator?.name ?? ''}
          onConfirm={handleConfirmAddTime}
        />
      )}
    </div>
  );
}

function PayRow({
  icon: Icon,
  label,
  amount,
}: {
  icon: typeof Wallet;
  label: string;
  amount: number;
}) {
  return (
    <div className="flex items-center justify-between text-base text-muted-foreground">
      <span className="flex items-center gap-2">
        <Icon className="w-5 h-5" />
        {label}
      </span>
      <span className="tabular-nums">฿{amount}</span>
    </div>
  );
}
