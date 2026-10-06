import { SaleExtensions } from '@/components/history/SaleExtensions';
import { useState } from 'react';
import {
  ArrowLeft,
  ChevronDown,
  ChevronUp,
  Clock,
  Printer,
  Undo2,
  User as UserIcon,
  Ban,
  Plus,
  Check,
} from 'lucide-react';
import { baht } from '@/api/history';
import { getDiscountReasons } from '@/store/catalogStore';
import { tierLabel } from '@/lib/membership';
import { clearRefundRequests } from '@/lib/refundRequests';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { StatusBadge } from '@/components/history/StatusBadge';
import {
  DiscountLabel,
  PaymentRow,
  RefundHistory,
  RefundRequests,
  ReprintHistory,
  VoidSaleDialog,
  restorableCreditSatang,
  refundSliceWords,
  voidSentence,
  useSaleDetail,
  type SaleDetailProps,
} from '@/components/history/SaleDetail';
import { MobileRefundFlow } from './MobileRefundFlow';
import { MobileReprintFlow } from './MobileReprintFlow';

/** Phone presentation; all amounts and mutations come from the shared ledger controller. */
export function MobileTransactionDetail(props: SaleDetailProps) {
  const { txn, onBack, onVoided } = props;
  const state = useSaleDetail(props);
  const [linesExpanded, setLinesExpanded] = useState(true);
  const {
    detail,
    sale,
    totals,
    badge,
    fmt,
    operator,
    groups,
    attempts,
    closed,
    remainingSatang,
    offline,
  } = state;
  if (state.refundOpen)
    return (
      <MobileRefundFlow
        maxRefund={baht(remainingSatang)}
        restorableCredit={baht(restorableCreditSatang(attempts, detail?.refunds ?? []))}
        lines={state.refundOptions.map((option) => ({
          id: option.id,
          label: option.label,
          amount: baht(option.amountSatang),
        }))}
        reasons={getDiscountReasons()}
        operatorName={operator?.name ?? 'this account'}
        refundMode={state.refundHint}
        onConfirm={(result) => void state.confirmRefund(result)}
        onCancel={() => state.setRefundOpen(false)}
        busy={state.refundBusy}
        error={state.refundError}
        offline={offline}
      />
    );
  if (state.reprintOpen)
    return (
      <MobileReprintFlow
        items={state.reprintItems.map((option) => ({
          id: option.kind,
          label: option.label,
          sublabel: option.sublabel,
        }))}
        operatorName={operator?.name ?? 'this account'}
        onConfirm={(labels, ids) => void state.confirmReprint(labels, ids)}
        onCancel={() => state.setReprintOpen(false)}
        busy={state.reprintBusy}
        error={state.flash?.tone === 'bad' ? state.flash.text : null}
      />
    );
  return (
    <div className="flex flex-col h-full bg-background text-foreground">
      <div className="shrink-0 flex items-center gap-3 px-4 h-14 border-b bg-card/30">
        <button
          type="button"
          aria-label="Back to history"
          onClick={onBack}
          className="w-9 h-9 flex items-center justify-center rounded-md text-muted-foreground"
        >
          <ArrowLeft className="w-5 h-5" />
        </button>
        <div className="flex-1 min-w-0">
          <div className="font-bold truncate">{state.heading}</div>
          <div className="text-xs text-primary font-mono">{txn.reference}</div>
        </div>
        <StatusBadge status={badge} />
      </div>
      <div className="flex-1 overflow-y-auto">
        <div className="p-4 space-y-4 pb-6">
          <div className="space-y-1 text-sm">
            <div className="flex items-center gap-1.5 flex-wrap">
              <UserIcon className="w-4 h-4 text-muted-foreground" />
              <span className="font-medium">{txn.customerLabel ?? 'Walk-in'}</span>
              {sale.member?.phone && (
                <span className="text-muted-foreground">· {sale.member.phone}</span>
              )}
            </div>
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Clock className="w-3.5 h-3.5" />
              {fmt(sale.occurredAt)} · by {txn.operatorName}
            </div>
            <div className="text-xs text-muted-foreground">
              {sale.stationName ?? 'Unknown station'} · {sale.businessDate} ·{' '}
              {tierLabel(sale.customerTier)}
            </div>
            {state.tierClaim && (
              <div className="text-xs text-muted-foreground">
                Priced on {state.tierClaim.documentKind.toLowerCase()}, checked{' '}
                {fmt(state.tierClaim.verifiedAt)}
              </div>
            )}
          </div>
          {state.error ? (
            <p role="alert" className="text-sm text-destructive">
              {state.error}
            </p>
          ) : !detail ? (
            <p className="text-sm text-muted-foreground">Reading this sale…</p>
          ) : (
            <Card className="bg-card/50 overflow-hidden">
              <button
                type="button"
                aria-expanded={linesExpanded}
                onClick={() => setLinesExpanded((value) => !value)}
                className="w-full flex items-center justify-between p-4 text-left"
              >
                <span className="text-xs font-bold uppercase tracking-wide text-muted-foreground">
                  {txn.kind === 'ticket'
                    ? 'Ticket lines'
                    : txn.kind === 'merch'
                      ? 'Retail items'
                      : 'Order lines'}
                </span>
                {linesExpanded ? (
                  <ChevronUp className="w-4 h-4" />
                ) : (
                  <ChevronDown className="w-4 h-4" />
                )}
              </button>
              {linesExpanded && (
                <div className="px-4 pb-4 space-y-3">
                  {[...groups.entries()].map(([id, lines]) => (
                    <div key={id} className="rounded-xl border bg-background/40 p-3">
                      <div className="flex items-center justify-between gap-2 font-bold">
                        <span>
                          {state.packageName(lines[0]?.ticketPackageId ?? null) ?? lines[0]?.label}
                        </span>
                        <span className="shrink-0 tabular-nums">
                          ฿{baht(lines.reduce((sum, line) => sum + line.grossSatang, 0))}
                        </span>
                      </div>
                      {lines.map((line) => (
                        <div
                          key={line.id}
                          className="flex justify-between text-xs text-muted-foreground mt-1"
                        >
                          <span>
                            {line.label} · {line.quantity}× ฿{baht(line.unitSatang)}
                            {!!line.modifiers?.length && <span className="block">{line.modifiers.map((choice) => `${choice.groupName}: ${choice.optionName}`).join(', ')}</span>}
                            {line.note && <span className="block italic">{line.note}</span>}
                          </span>
                          <span className="tabular-nums">฿{baht(line.grossSatang)}</span>
                        </div>
                      ))}
                    </div>
                  ))}
                </div>
              )}
            </Card>
          )}
          {state.bands.length > 0 && (
            <Card className="p-4 bg-card/50">
              <div className="text-xs uppercase font-bold text-muted-foreground">
                Bracelets printed
              </div>
              <div className="text-3xl font-black">{state.bands.length}</div>
              <div className="text-sm text-muted-foreground">
                {state.kidBands.length} child · {state.adultBands.length} adult
              </div>
              <div className="flex gap-x-3 flex-wrap text-xs font-mono mt-2">
                {state.bands.map((band) => (
                  <span key={band.id}>
                    {band.shortCode ?? 'No code'}
                    {band.childName ? ` ${band.childName}` : ''}
                  </span>
                ))}
              </div>
            </Card>
          )}
          {detail?.pickupCode && (
            <Card className="p-4 bg-card/50 flex justify-between">
              <span>Pickup ticket</span>
              <strong>#{detail.pickupCode}</strong>
            </Card>
          )}
          <Card className="p-4 bg-card/50 space-y-2 text-sm">
            <div className="flex justify-between text-muted-foreground">
              <span>Subtotal</span>
              <span>฿{baht(totals.subtotalSatang)}</span>
            </div>
            {detail?.discounts.map((discount) => (
              <div key={discount.id} className="flex justify-between gap-2 text-emerald-400">
                <div className="min-w-0">
                  <DiscountLabel discount={discount} />
                  {(discount.reason || discount.appliedByName) && (
                    <div className="text-xs text-muted-foreground">
                      {discount.reason}
                      {discount.note ? ` — ${discount.note}` : ''}
                      {discount.appliedByName ? ` · by ${discount.appliedByName}` : ''}
                    </div>
                  )}
                </div>
                <span className="shrink-0">−฿{baht(discount.amountSatang)}</span>
              </div>
            ))}
            {totals.serviceChargeSatang > 0 && (
              <div className="flex justify-between">
                <span>Service charge</span>
                <span>฿{baht(totals.serviceChargeSatang)}</span>
              </div>
            )}
            {state.taxTotal > 0 && (
              <div className="flex justify-between text-muted-foreground">
                <span>
                  {state.taxName}
                  {totals.taxInclusiveSatang > 0 ? ' (included)' : ''}
                </span>
                <span>฿{baht(state.taxTotal)}</span>
              </div>
            )}
            <div className="border-t pt-3 flex items-end justify-between">
              <span className="font-semibold text-muted-foreground">
                {badge === 'unpaid'
                  ? 'Amount due'
                  : badge === 'voided'
                    ? 'Total (voided)'
                    : 'Total paid'}
              </span>
              <span className="text-3xl font-black">฿{baht(totals.grossSatang)}</span>
            </div>
            {totals.refundedSatang > 0 && (
              <div className="flex justify-between text-rose-400 font-semibold">
                <span>Refunded</span>
                <span>−฿{baht(totals.refundedSatang)}</span>
              </div>
            )}
            {detail?.timeExtension && <p className="border-t pt-2 text-muted-foreground">
              Separate charge for {detail.timeExtension.minutesAdded} minutes × {detail.timeExtension.braceletCount} bracelets. The original admission receipt stays unchanged.
            </p>}
            {sale.note && <p className="border-t pt-2 text-muted-foreground">{sale.note}</p>}
          </Card>
          {attempts.length > 0 && (
            <Card className="p-4 bg-card/50 space-y-3">
              <div className="text-xs uppercase font-bold text-muted-foreground">Payment</div>
              {attempts.map((attempt) => (
                <PaymentRow key={attempt.id} attempt={attempt} sale={sale} fmt={fmt} />
              ))}
            </Card>
          )}
          <RefundRequests
            requests={state.requests}
            fmt={fmt}
            onClear={() => {
              clearRefundRequests(sale.id);
              state.setRequests([]);
            }}
          />
          <RefundHistory refunds={detail?.refunds ?? []} fmt={fmt} />
          <ReprintHistory
            jobs={detail?.printJobs ?? []}
            bands={detail?.bands ?? []}
            madeBy={state.madeBy}
            fmt={fmt}
          />
          {txn.kind === 'ticket' && !detail?.timeExtension && <SaleExtensions key={sale.id} saleId={sale.id} eligible={sale.status === 'finalised'} offline={offline} />}

          {state.flash && (
            <p
              role="status"
              className={`rounded-xl border p-3 text-sm ${state.flash.tone === 'bad' ? 'text-destructive' : 'text-emerald-400'}`}
            >
              {state.flash.text}
            </p>
          )}
          {state.voidRecord && (
            <p className="rounded-xl border p-3 text-sm text-muted-foreground">
              {voidSentence(state.voidRecord, state.voucherHeld, fmt)}
            </p>
          )}
          {state.justRefunded ? (
            <Card className="p-4 space-y-3" data-testid="refund-recorded">
              <div className="text-sm text-emerald-400 font-semibold flex gap-2">
                <Check className="w-4 h-4" />
                Refund recorded · {state.justRefunded.number} · −฿
                {baht(state.justRefunded.amountSatang)}
              </div>
              {state.justRefunded.tenderAllocation.map((slice, index) => (
                <div
                  key={index}
                  className={`text-sm flex justify-between ${refundSliceWords(slice).tone}`}
                >
                  <span>{refundSliceWords(slice).text}</span>
                  <span>฿{baht(slice.amountSatang)}</span>
                </div>
              ))}
              {txn.kind !== 'merch' && !detail?.timeExtension && (
                <Button
                  className="w-full h-12"
                  disabled={state.correcting}
                  onClick={() => void state.startCorrectedOrder()}
                >
                  {state.correcting ? 'Opening…' : 'Start corrected order'}
                </Button>
              )}
              <Button variant="outline" className="w-full h-12 gap-2" onClick={state.newSale}>
                <Plus className="w-4 h-4" />
                New sale
              </Button>
              <Button variant="ghost" className="w-full h-12" onClick={onBack}>
                Done
              </Button>
            </Card>
          ) : (
            <div className="space-y-2">
              <div className="grid gap-2">
                <Button
                  variant="outline"
                  className="h-12 gap-2"
                  disabled={
                    !closed ||
                    !state.mayReprint ||
                    state.reprintBusy ||
                    state.reprintItems.length === 0
                  }
                  onClick={state.openReprint}
                >
                  <Printer className="w-4 h-4" />
                  Reprint
                </Button>

              </div>
              {state.tookNoMoney ? (
                <Button
                  className="w-full h-14 gap-2 bg-rose-500"
                  disabled={!state.mayVoid}
                  onClick={() => state.setShowVoid(true)}
                >
                  <Ban className="w-4 h-4" />
                  Void unpaid sale
                </Button>
              ) : state.status === 'voided' ? null : closed && remainingSatang <= 0 ? (
                <p className="text-sm text-muted-foreground text-center py-3">
                  Fully refunded — nothing left to refund.
                </p>
              ) : (
                <Button
                  className={`w-full h-14 gap-2 ${offline ? 'bg-amber-600' : 'bg-rose-500'}`}
                  disabled={!closed || !state.mayRefund}
                  onClick={state.openRefund}
                >
                  <Undo2 className="w-4 h-4" />
                  {offline ? 'Refund — online only' : 'Refund'} (฿{baht(remainingSatang)} left)
                </Button>
              )}
              {closed && !state.mayRefund && (
                <p className="text-xs text-muted-foreground">
                  Refunding a sale needs the till's refund permission.
                </p>
              )}
            </div>
          )}
        </div>
      </div>
      <VoidSaleDialog
        open={state.showVoid}
        onOpenChange={state.setShowVoid}
        txn={txn}
        stationName={sale.stationName}
        operatorName={operator?.name ?? 'this account'}
        fmt={fmt}
        onVoided={(answer) => {
          state.setVoided(answer);
          onVoided?.(sale.id);
        }}
      />
    </div>
  );
}
