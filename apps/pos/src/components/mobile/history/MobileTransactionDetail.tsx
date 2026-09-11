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
import { StatusBadge } from '@/components/history/StatusBadge';
import type { RefundLineOption, RefundResult } from '@/components/history/RefundModal';
import type { ReprintItemOption } from '@/components/history/ReprintModal';
import { AddTimeModal, type AddTimeResult } from '@/components/history/AddTimeModal';
import { MobileRefundFlow } from './MobileRefundFlow';
import { MobileReprintFlow } from './MobileReprintFlow';
import {
  ArrowLeft,
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
  ChevronDown,
  ChevronUp,
} from 'lucide-react';

interface MobileTransactionDetailProps {
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

type SubView = 'detail' | 'refund' | 'reprint';

export function MobileTransactionDetail({ txn, onBack, onChanged }: MobileTransactionDetailProps) {
  const { operator } = useOperator();
  const [, setLocation] = useLocation();
  const [subView, setSubView] = useState<SubView>('detail');
  const [localVersion, setLocalVersion] = useState(0);
  const [justRefunded, setJustRefunded] = useState(false);
  const [flash, setFlash] = useState<string | null>(null);
  const [addTimeOpen, setAddTimeOpen] = useState(false);
  const [linesExpanded, setLinesExpanded] = useState(true);

  const record = useMemo<Sale | FnbOrder | MerchOrder | null>(
    () => getRecordByKind(txn.kind, txn.id),
    [txn.id, txn.kind, localVersion],
  );

  // ── Handlers ───────────────────────────────────────────────────────────────
  // Declared here so they can be passed to sub-view components.

  function handleConfirmReprint(labels: string[]) {
    if (!operator || !record) return;
    recordReprint({
      transactionId: record.id,
      kind: txn.kind,
      items: labels,
      reprintedBy: operator.name,
      reprintedById: operator.id,
    });
    setLocalVersion((v) => v + 1);
    setFlash(`Sent ${labels.length} item${labels.length > 1 ? 's' : ''} to the printer`);
    setSubView('detail');
  }

  function handleConfirmRefund(result: RefundResult) {
    if (!operator || !record) return;
    const payOrder =
      txn.kind === 'fnb' || txn.kind === 'merch' ? (record as FnbOrder | MerchOrder) : null;
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
    setSubView('detail');
    onChanged();
  }

  // ── null guard ─────────────────────────────────────────────────────────────

  if (!record) {
    return (
      <div className="flex h-full items-center justify-center text-muted-foreground p-6 text-center">
        Transaction not found.
      </div>
    );
  }

  // ── Derived values (all declared before sub-view branches) ─────────────────

  const sale = txn.kind === 'ticket' ? (record as Sale) : null;
  const order = txn.kind === 'fnb' ? (record as FnbOrder) : null;
  const merch = txn.kind === 'merch' ? (record as MerchOrder) : null;
  // F&B and merch share the wristband + multi-tender payment shape.
  const payOrder = order ?? merch;

  const alreadyRefunded = record.refunds.reduce((acc, r) => acc + r.amountTHB, 0);
  const remaining = Math.max(0, record.total - alreadyRefunded);

  const customerName = sale
    ? sale.customerNickname?.trim() || 'Walk-in'
    : payOrder!.wristband?.customerNickname || (merch ? 'Retail order' : 'Wristband order');
  const customerSub = sale
    ? sale.customerPhone || undefined
    : payOrder!.wristband
      ? `Band ${payOrder!.wristband.code}`
      : undefined;

  const braceletCount = sale ? sale.bracelets.children + sale.bracelets.adults : 0;

  const subtotal = record.lines.reduce((acc, l) => acc + l.lineTotal, 0);
  const manualDiscounts = record.manualDiscounts;
  const manualDiscountAmount = manualDiscounts.reduce((acc, d) => acc + d.amountTHB, 0);
  const scannedDiscounts = sale
    ? computeTotals(sale.lines, sale.discounts ?? [], sale.manualDiscounts).scannedDiscounts
    : [];
  const scannedDiscountAmount = scannedDiscounts.reduce((acc, sd) => acc + sd.amount, 0);

  const taxBreakdown = sale
    ? computeTotals(sale.lines, sale.discounts ?? [], sale.manualDiscounts).taxBreakdown
    : merch
      ? computeMerchTotals(merch.lines, merch.manualDiscounts).taxBreakdown
      : computeFnbTotals(order!.lines, order!.manualDiscounts).taxBreakdown;
  const taxRows = summarizeTax(taxBreakdown);

  const creditAlreadyRestored = record.refunds.reduce((acc, r) => acc + r.creditRestoredTHB, 0);
  const restorableCredit = payOrder
    ? Math.max(0, payOrder.payment.creditUsed - creditAlreadyRestored)
    : 0;

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

  const reprintItems: ReprintItemOption[] = [{ id: 'receipt', label: 'Full receipt' }];
  if (sale) {
    if (sale.bracelets.children > 0)
      reprintItems.push({ id: 'br-child', label: 'Child bracelet', sublabel: `×${sale.bracelets.children}` });
    if (sale.bracelets.adults > 0)
      reprintItems.push({ id: 'br-adult', label: 'Adult bracelet', sublabel: `×${sale.bracelets.adults}` });
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
  // Merch has only the receipt to reprint (no bracelets/credit grants/pickup).

  // ── Sub-view branches ──────────────────────────────────────────────────────

  if (subView === 'refund') {
    return (
      <MobileRefundFlow
        maxRefund={remaining}
        restorableCredit={restorableCredit}
        lines={lineOptions}
        reasons={getDiscountReasons()}
        operatorName={operator?.name ?? ''}
        refundMode={refundMode}
        onConfirm={handleConfirmRefund}
        onCancel={() => setSubView('detail')}
      />
    );
  }

  if (subView === 'reprint') {
    return (
      <MobileReprintFlow
        items={reprintItems}
        operatorName={operator?.name ?? ''}
        onConfirm={handleConfirmReprint}
        onCancel={() => setSubView('detail')}
      />
    );
  }

  // ── Add Time handler (only reachable in detail view) ──────────────────────

  function handleConfirmAddTime(result: AddTimeResult) {
    if (!operator || !sale) return;
    recordExtension({
      transactionId: record!.id,
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
  }

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

  // ── Detail view ────────────────────────────────────────────────────────────

  return (
    <div className="flex flex-col h-full bg-background text-foreground">
      {/* Compact header */}
      <div className="shrink-0 flex items-center gap-3 px-4 h-14 border-b bg-card/30">
        <button
          type="button"
          onClick={onBack}
          className="w-9 h-9 flex items-center justify-center rounded-md text-muted-foreground hover:text-foreground transition-colors"
        >
          <ArrowLeft className="w-5 h-5" />
        </button>
        <div className="flex-1 min-w-0">
          <div className="font-bold truncate">
            {sale ? 'Ticket sale' : merch ? 'Retail sale' : 'F&B order'}{' '}
            <span className="text-primary">{txn.reference}</span>
          </div>
          <div className="text-xs text-muted-foreground truncate">{customerName}</div>
        </div>
        <StatusBadge status={record.status} />
      </div>

      {/* Scrollable body */}
      <div className="flex-1 overflow-y-auto">
        <div className="p-4 space-y-4 pb-6">

          {/* Customer + time */}
          <div className="space-y-1 text-sm">
            <div className="flex items-center gap-1.5 flex-wrap">
              <UserIcon className="w-4 h-4 text-muted-foreground shrink-0" />
              <span className="font-medium text-foreground">{customerName}</span>
              {customerSub && (
                <span className="text-muted-foreground">· {customerSub}</span>
              )}
            </div>
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Clock className="w-3.5 h-3.5" />
              {fmtTime(record.createdAt)} · by {record.operatorName}
            </div>
          </div>

          {/* Lines */}
          <Card className="bg-card/50 overflow-hidden">
            <button
              type="button"
              onClick={() => setLinesExpanded((v) => !v)}
              className="w-full flex items-center justify-between p-4 text-left"
            >
              <span className="text-xs font-bold uppercase tracking-wide text-muted-foreground">
                {sale ? 'Ticket lines' : merch ? 'Retail items' : 'Order lines'}
              </span>
              {linesExpanded ? (
                <ChevronUp className="w-4 h-4 text-muted-foreground" />
              ) : (
                <ChevronDown className="w-4 h-4 text-muted-foreground" />
              )}
            </button>
            {linesExpanded && (
              <div className="px-4 pb-4 space-y-3">
                {sale &&
                  sale.lines.map((line) => (
                    <div key={line.id} className="rounded-xl border bg-background/40 p-3">
                      {line.promoItem ? (
                        <div className="flex items-center justify-between text-emerald-400">
                          <span className="font-bold truncate pr-2">🎁 Free: {line.promoItem.name}</span>
                          <span className="tabular-nums font-bold shrink-0">฿0</span>
                        </div>
                      ) : (
                        <>
                          <div className="flex items-center justify-between font-bold">
                            <span className="truncate pr-2">
                              {line.ticketType.name}
                              <span className="text-muted-foreground font-normal text-sm">
                                {' '}· {tierLabel(line.tier)}
                              </span>
                            </span>
                            <span className="tabular-nums shrink-0">฿{line.lineTotal}</span>
                          </div>
                          <div className="mt-1.5 space-y-0.5">
                            {computeLineBreakdown(line).map((b) => (
                              <div key={b.key} className="flex justify-between text-xs text-muted-foreground">
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
                      <div key={line.id} className="rounded-xl border bg-background/40 p-3">
                        <div className="flex items-start justify-between gap-2">
                          <span className="font-bold truncate">{line.menuItem.name}</span>
                          <span className="font-bold tabular-nums shrink-0">฿{line.lineTotal}</span>
                        </div>
                        <div className="text-xs text-muted-foreground mt-0.5">
                          {line.qty} × ฿{unitPrice}
                          {mods.length > 0 && ` · ${mods.join(', ')}`}
                        </div>
                      </div>
                    );
                  })}
                {merch &&
                  merch.lines.map((line) => {
                    const unitPrice = Math.round(line.lineTotal / line.qty);
                    return (
                      <div key={line.id} className="rounded-xl border bg-background/40 p-3">
                        <div className="flex items-start justify-between gap-2">
                          <span className="font-bold truncate">{line.merchItem.name}</span>
                          <span className="font-bold tabular-nums shrink-0">฿{line.lineTotal}</span>
                        </div>
                        <div className="text-xs text-muted-foreground mt-0.5">
                          {line.qty} × ฿{unitPrice}
                        </div>
                      </div>
                    );
                  })}
              </div>
            )}
          </Card>

          {/* Issued items (tickets only) */}
          {sale && (braceletCount > 0 || sale.creditGrants.length > 0) && (
            <div className="grid grid-cols-2 gap-3">
              {braceletCount > 0 && (
                <Card className="p-4 bg-card/50">
                  <div className="flex items-center gap-1.5 text-xs font-bold uppercase tracking-wide text-muted-foreground mb-2">
                    <Users className="w-3.5 h-3.5" />
                    Bracelets
                  </div>
                  <div className="text-3xl font-black tabular-nums leading-none">{braceletCount}</div>
                  <div className="text-xs text-muted-foreground mt-1">
                    {sale.bracelets.children > 0 && <div>{sale.bracelets.children} child</div>}
                    {sale.bracelets.adults > 0 && <div>{sale.bracelets.adults} adult</div>}
                  </div>
                </Card>
              )}
              {sale.creditGrants.length > 0 && (
                <Card className="p-4 bg-card/50">
                  <div className="flex items-center gap-1.5 text-xs font-bold uppercase tracking-wide text-muted-foreground mb-2">
                    <Wallet className="w-3.5 h-3.5" />
                    Credit grants
                  </div>
                  <div className="space-y-1">
                    {sale.creditGrants.map((v) => (
                      <div key={v.id} className="flex items-center justify-between gap-1 text-xs">
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
                </Card>
              )}
            </div>
          )}

          {/* Pickup code (F&B) */}
          {order && (
            <Card className="p-4 bg-card/50 flex items-center justify-between">
              <div className="flex items-center gap-1.5 text-xs font-bold uppercase tracking-wide text-muted-foreground">
                <GlassWater className="w-3.5 h-3.5" />
                Pickup ticket
              </div>
              <span className="text-2xl font-black tabular-nums">#{order.pickupCode}</span>
            </Card>
          )}

          {/* Payment breakdown */}
          <Card className="p-4 bg-card/50 space-y-3">
            {(manualDiscountAmount > 0 || scannedDiscountAmount > 0 || taxRows.length > 0) && (
              <div className="space-y-1 pb-2 border-b text-sm">
                <div className="flex items-center justify-between text-muted-foreground">
                  <span>Subtotal</span>
                  <span className="tabular-nums">฿{subtotal}</span>
                </div>
                {manualDiscounts.map((d) => (
                  <div key={d.id} className="flex items-start justify-between text-emerald-400 text-xs">
                    <span className="min-w-0 truncate pr-2">
                      {d.type === 'comp' ? 'Comp' : d.type === 'percent' ? `${d.value}% off` : 'Discount'}
                      {d.targetLabel ? ` · ${d.targetLabel}` : ''} · {d.reason} · {d.appliedBy}
                    </span>
                    <span className="tabular-nums shrink-0">−฿{d.amountTHB}</span>
                  </div>
                ))}
                {scannedDiscounts
                  .filter((sd) => sd.type !== 'free_item')
                  .map((sd) => (
                    <div key={sd.code} className="flex items-center justify-between text-emerald-400 text-xs">
                      <span className="truncate pr-2">Promo · {sd.label}</span>
                      <span className="tabular-nums shrink-0">−฿{sd.amount}</span>
                    </div>
                  ))}
                {taxRows.map((row) => (
                  <div key={row.key} className="flex items-center justify-between text-muted-foreground text-xs">
                    <span>{row.label}</span>
                    <span className="tabular-nums">฿{roundTHB(row.amount)}</span>
                  </div>
                ))}
              </div>
            )}
            <div className="flex items-end justify-between">
              <span className="text-sm font-semibold text-muted-foreground">Total paid</span>
              <span className="text-3xl font-black tabular-nums leading-none">฿{record.total}</span>
            </div>
            <div className="border-t pt-3 space-y-2">
              {sale && (() => {
                const Icon = sale.paymentMethod
                  ? paymentMethodIcon(paymentMethodKind(sale.paymentMethod))
                  : Wallet;
                return (
                  <div className="flex items-center justify-between text-sm text-muted-foreground">
                    <span className="flex items-center gap-1.5">
                      <Icon className="w-4 h-4" />
                      {sale.paymentMethod ? paymentMethodLabel(sale.paymentMethod) : 'Payment'}
                    </span>
                    <span className="tabular-nums">฿{sale.total}</span>
                  </div>
                );
              })()}
              {payOrder && payOrder.payment.creditUsed > 0 && (
                <div className="flex items-center justify-between text-sm text-muted-foreground">
                  <span className="flex items-center gap-1.5">
                    <Wallet className="w-4 h-4" />
                    Credit
                  </span>
                  <span className="tabular-nums">฿{payOrder.payment.creditUsed}</span>
                </div>
              )}
              {payOrder && payOrder.payment.cash > 0 && (
                <div className="flex items-center justify-between text-sm text-muted-foreground">
                  <span className="flex items-center gap-1.5"><Banknote className="w-4 h-4" />Cash</span>
                  <span className="tabular-nums">฿{payOrder.payment.cash}</span>
                </div>
              )}
              {payOrder && payOrder.payment.card > 0 && (
                <div className="flex items-center justify-between text-sm text-muted-foreground">
                  <span className="flex items-center gap-1.5"><CreditCard className="w-4 h-4" />Card</span>
                  <span className="tabular-nums">฿{payOrder.payment.card}</span>
                </div>
              )}
              {payOrder && payOrder.payment.promptpay > 0 && (
                <div className="flex items-center justify-between text-sm text-muted-foreground">
                  <span className="flex items-center gap-1.5"><QrCodeIcon className="w-4 h-4" />PromptPay</span>
                  <span className="tabular-nums">฿{payOrder.payment.promptpay}</span>
                </div>
              )}
            </div>
            {alreadyRefunded > 0 && (
              <div className="border-t pt-2 flex items-center justify-between text-rose-400 font-semibold text-sm">
                <span>Refunded</span>
                <span className="tabular-nums">−฿{alreadyRefunded}</span>
              </div>
            )}
          </Card>

          {/* Refund history */}
          {record.refunds.length > 0 && (
            <Card className="p-4 bg-card/50">
              <div className="text-xs font-bold uppercase tracking-wide text-muted-foreground mb-2">
                Refund history
              </div>
              <div className="space-y-3">
                {record.refunds.map((r) => (
                  <div key={r.id} className="text-sm border-l-2 border-rose-500/40 pl-3">
                    <div className="flex items-center justify-between">
                      <span className="font-semibold text-rose-400 tabular-nums">−฿{r.amountTHB}</span>
                      <span className="text-xs text-muted-foreground">{fmtTime(r.refundedAt)}</span>
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {r.reason}
                      {r.creditRestoredTHB > 0 && ` · ฿${r.creditRestoredTHB} to wristband`}
                    </div>
                    {r.note && <div className="text-xs text-muted-foreground italic">"{r.note}"</div>}
                    <div className="text-xs text-muted-foreground">by {r.refundedBy}</div>
                  </div>
                ))}
              </div>
            </Card>
          )}

          {/* Time added (tickets) */}
          {extensions.length > 0 && (
            <Card className="p-4 bg-card/50">
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
            <Card className="p-4 bg-card/50">
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
                      <span className="text-xs text-muted-foreground shrink-0">{fmtTime(rp.reprintedAt)}</span>
                    </div>
                    <div className="text-xs text-muted-foreground">by {rp.reprintedBy}</div>
                  </div>
                ))}
              </div>
            </Card>
          )}

          {/* Flash */}
          {flash && (
            <div className="rounded-xl border border-emerald-500/40 bg-emerald-500/10 p-3 text-sm font-medium text-emerald-400 flex items-center gap-2">
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
            <div className="space-y-2">
              <div className={`grid gap-2 ${sale && braceletCount > 0 ? 'grid-cols-2' : 'grid-cols-1'}`}>
                <Button
                  variant="outline"
                  className="h-14 text-base gap-2"
                  onClick={() => {
                    setFlash(null);
                    setSubView('reprint');
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
                  onClick={() => setSubView('refund')}
                >
                  <Undo2 className="w-5 h-5" />
                  Refund (฿{remaining} left)
                </Button>
              ) : (
                <div className="rounded-xl border border-dashed p-4 text-center text-sm text-muted-foreground">
                  Fully refunded — nothing left to refund.
                </div>
              )}
            </div>
          )}
        </div>
      </div>

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
