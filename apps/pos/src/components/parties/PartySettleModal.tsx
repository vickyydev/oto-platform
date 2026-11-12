import { useEffect, useRef, useState } from 'react';
import { newId, partySettleFormDefaults, partySocksIncludedFor, type PartyPlan, type PartySettleQuote } from '@oto/shared';
import { useOperator } from '@/auth/OperatorContext';
import { ApiError } from '@/api/client';
import {
  previewSettlementOnPlatform,
  settlePartyOnPlatform,
  type PartySettleForm,
  type PartySettleIds,
} from '@/api/parties';
import { finaliseSale, salesApi } from '@/api/sales';
import { usePaymentStage, type PaymentDisplayState } from '@/lib/usePaymentStage';
import { useTenderPresentation } from '@/lib/tenderDisplay';
import type { StationDisplayHandoff } from '@/lib/displaySession';
import type { SaleWriteOutcome } from '@/lib/saleWriter';
import { useCustomerDisplayPref } from '@/lib/customerDisplayPref';
import { bahtLabel } from '@/lib/heldSales';
import { paymentMethodKind } from '@/lib/payments';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { StepPayment } from '@/components/till/StepPayment';
import { PromptPayCustomerScreen } from '@/components/shared/PromptPayCustomerScreen';
import type { PartyBooking } from '@/types';
import { Baby, Check, CheckCircle2, Minus, PartyPopper, Plus, Sparkles, Users, Wallet, X } from 'lucide-react';
import { bahtText } from '@/lib/bahtText';

/**
 * SCRUM-804 — "SETTLE PARTY": the party's package rung up as ONE sale from the
 * plan the OTO App published (birthday plan §4).
 *
 * Staff confirm who actually came — the children, the adults, the pairs of
 * socks handed out — and which of the plan's add-ons and entertainment stand.
 * Every figure on this screen is the platform's (`POST /parties/:id/settle/
 * preview`, priced by the sale engine as the settlement will be): the till does
 * no arithmetic of its own. Confirm settles it (`POST /parties/:id/settle`) —
 * the deposit already paid is on the sale — and the balance is taken through
 * the ordinary payment stage, as any sale's is; the close prints the receipt,
 * the bands and the credit voucher. A settlement left at the payment stage is
 * resumed from the party page, as a partly paid sale is.
 */

interface PartySettleModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  party: PartyBooking;
  plan: PartyPlan;
  stationId: string | null;
  /** A settlement already rung up and waiting for its balance: straight to the payment stage. */
  resumeSaleId?: string | null;
  displayHandoff?: StationDisplayHandoff;
  /** Settled, or rung up: the party page reads the party again. */
  onSettled: () => void;
}

type Phase = 'form' | 'payment' | 'done';

/** The till's money face: "฿16,900", from satang. */
const money = (satang: number) => bahtLabel(satang);

function Stepper({
  label,
  value,
  onChange,
  min = 0,
  hint,
}: {
  label: string;
  value: number;
  onChange: (next: number) => void;
  min?: number;
  hint?: string;
}) {
  return (
    <div className="flex items-center justify-between gap-4 rounded-2xl border border-foreground/10 bg-foreground/5 p-4">
      <div className="min-w-0">
        <div className="font-bold">{label}</div>
        {hint && <div className="text-xs text-muted-foreground mt-0.5">{hint}</div>}
      </div>
      <div className="flex items-center gap-3 shrink-0">
        <Button variant="outline" size="icon" className="h-11 w-11" aria-label={`Fewer ${label.toLowerCase()}`} disabled={value <= min} onClick={() => onChange(Math.max(min, value - 1))}>
          <Minus className="w-4 h-4" />
        </Button>
        <span className="w-10 text-center text-2xl font-black tabular-nums">{value}</span>
        <Button variant="outline" size="icon" className="h-11 w-11" aria-label={`More ${label.toLowerCase()}`} onClick={() => onChange(value + 1)}>
          <Plus className="w-4 h-4" />
        </Button>
      </div>
    </div>
  );
}

function Choice({ chosen, title, detail, price, onToggle }: { chosen: boolean; title: string; detail?: string; price: string; onToggle: () => void }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      className={`w-full flex items-center gap-4 rounded-2xl border p-4 text-left transition-colors ${
        chosen ? 'border-primary/60 bg-primary/10' : 'border-foreground/10 bg-foreground/5 hover:bg-foreground/10'
      }`}
    >
      <div className={`h-6 w-6 rounded-md border flex items-center justify-center shrink-0 ${chosen ? 'bg-primary border-primary' : 'border-foreground/30'}`}>
        {chosen && <Check className="w-4 h-4 text-primary-foreground" />}
      </div>
      <div className="flex-1 min-w-0">
        <div className="font-bold truncate">{title}</div>
        {detail && <div className="text-xs text-muted-foreground mt-0.5">{detail}</div>}
      </div>
      <div className="font-semibold tabular-nums shrink-0">{price}</div>
    </button>
  );
}

/** The figures, as the platform priced them. */
function QuoteSummary({ quote }: { quote: PartySettleQuote }) {
  const row = (label: string, value: string, strong = false) => (
    <div className={`flex items-center justify-between py-1.5 ${strong ? 'font-semibold' : ''}`}>
      <span className={strong ? '' : 'text-muted-foreground'}>{label}</span>
      <span className="tabular-nums">{value}</span>
    </div>
  );
  const extras = quote.extraChildrenSatang + quote.extraAdultsSatang;
  return (
    <div className="text-sm">
      {row(`${quote.packageName} · ${quote.rateMode === 'weekend' ? 'weekend' : 'weekday'}`, money(quote.packageSatang))}
      {(quote.extraChildren > 0 || quote.extraAdults > 0) &&
        row(
          `Extras · ${[quote.extraChildren ? `${quote.extraChildren} child${quote.extraChildren === 1 ? '' : 'ren'}` : '', quote.extraAdults ? `${quote.extraAdults} adult${quote.extraAdults === 1 ? '' : 's'}` : ''].filter(Boolean).join(', ')}`,
          money(extras),
        )}
      {(quote.freeSocks > 0 || quote.paidSocks > 0) &&
        row(`Socks · ${quote.freeSocks} free${quote.paidSocks ? `, ${quote.paidSocks} sold` : ''}`, money(quote.socksSatang))}
      {quote.addOnsSatang > 0 && row('Add-ons', money(quote.addOnsSatang))}
      {quote.entertainmentSatang > 0 && row('Entertainment', money(quote.entertainmentSatang))}
      <div className="border-t mt-1 pt-1">{row('Total', money(quote.totalSatang), true)}</div>
      {quote.creditSatang > 0 && row('F&B credit (voucher on the receipt)', money(quote.creditSatang))}
      {row('Deposit paid', `−${money(quote.depositSatang)}`)}
      <div className="flex items-center justify-between mt-2 pt-3 border-t">
        <span className="font-bold">Balance</span>
        <span className="text-3xl font-black tabular-nums text-amber-400">{money(quote.balanceSatang)}</span>
      </div>
    </div>
  );
}

/** What the guest sees opposite the payment stage: the QR, or the amount to pay staff. */
function CustomerPaymentPane({ amount, unread = false, qr, method, title }: { amount: number; unread?: boolean; qr: PaymentDisplayState; method: string | null; title: string }) {
  if (method && paymentMethodKind(method) === 'qr') {
    return <PromptPayCustomerScreen amount={amount} qrPayload={qr.qrPayload} qrImageUrl={qr.qrImageUrl} expiresAt={qr.expiresAt} note={title} />;
  }
  return (
    <div className="h-full w-full bg-gradient-to-b from-sky-950 via-slate-950 to-slate-950 text-white flex flex-col items-center justify-center text-center px-10">
      <div className="h-16 w-16 rounded-full bg-white/10 flex items-center justify-center mb-5">
        <Wallet className="w-8 h-8 text-sky-300" />
      </div>
      <h2 className="text-3xl font-black mb-3">Amount due</h2>
      {/* SCRUM-902 — the balance not read yet: a dash, never ฿0. */}
      <div className="text-6xl font-black text-sky-300 tabular-nums">{unread ? '—' : `฿${bahtText(amount)}`}</div>
      <p className="text-lg text-white/60 mt-3">{title}</p>
      <p className="text-xl text-white/60 mt-6 max-w-md">
        {method ? 'Please complete payment with our staff.' : 'Our staff will help you choose how to pay.'}
      </p>
    </div>
  );
}

/**
 * The counts the form opens with: the plan's, else the party's, and the
 * package's socks. One rule in @oto/shared, so the quote the OTO App reads
 * (SCRUM-822) is priced on the same counts this form opens with.
 */
function formOf(party: PartyBooking, plan: PartyPlan): PartySettleForm {
  return partySettleFormDefaults(plan, party);
}

export function PartySettleModal({ open, onOpenChange, party, plan, stationId, resumeSaleId, displayHandoff, onSettled }: PartySettleModalProps) {
  const { locked: operatorLocked } = useOperator();
  const [showCustomerDisplay, setShowCustomerDisplay] = useCustomerDisplayPref();
  const [phase, setPhase] = useState<Phase>('form');
  const [form, setForm] = useState<PartySettleForm>(() => formOf(party, plan));
  // Socks follow the children until staff set them by hand.
  const [socksTouched, setSocksTouched] = useState(false);
  const [quote, setQuote] = useState<PartySettleQuote | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [confirmError, setConfirmError] = useState<string | null>(null);
  const [saleId, setSaleId] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<string | null>(null);
  const [session, setSession] = useState(0);
  const scope = `party-settle:${party.id}:${session}`;
  const scopeRef = useRef(scope);
  scopeRef.current = scope;
  /** The ids one press of Confirm is made under, kept for a retry of that press. */
  const idsRef = useRef<{ ids: PartySettleIds; press: string } | null>(null);
  const previewSeq = useRef(0);

  useEffect(() => {
    if (!open) return;
    setSession((s) => s + 1);
    setForm(formOf(party, plan));
    setSocksTouched(false);
    setQuote(null);
    setPreviewError(null);
    setConfirmError(null);
    setReceipt(null);
    idsRef.current = null;
    setSaleId(resumeSaleId ?? null);
    setPhase(resumeSaleId ? 'payment' : 'form');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // The figures, re-priced by the platform whenever the form changes.
  const formKey = JSON.stringify(form);
  useEffect(() => {
    if (!open || phase !== 'form') return;
    const seq = ++previewSeq.current;
    const timer = setTimeout(() => {
      void previewSettlementOnPlatform({ party, form, stationId }).then((outcome) => {
        if (seq !== previewSeq.current) return;
        if (outcome.ok) {
          setQuote(outcome.quote);
          setPreviewError(null);
        } else {
          setQuote(null);
          setPreviewError(outcome.message);
        }
      });
    }, 250);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, phase, formKey]);

  const setKids = (kids: number) =>
    setForm((f) => ({ ...f, kids, ...(socksTouched ? {} : { socksGiven: partySocksIncludedFor(plan.package, kids) }) }));
  const toggle = (key: 'addOnIds' | 'entertainmentIds', id: string) =>
    setForm((f) => ({ ...f, [key]: f[key].includes(id) ? f[key].filter((x) => x !== id) : [...f[key], id] }));

  const stage = usePaymentStage({
    scope,
    isCurrentScope: (s) => s === scopeRef.current,
    active: open && phase === 'payment' && !!saleId,
    paused: operatorLocked,
    totalSatang: quote?.balanceSatang ?? 0,
    // The sale is rung up already, with the deposit on it: the stage reads what is left.
    ...(saleId ? { resumeSaleId: saleId } : {}),
    prepareSale: async (): Promise<SaleWriteOutcome> => {
      if (!saleId) return { ok: false, saleId: '', message: 'This party has not been settled yet.', retryable: false };
      try {
        const detail = await salesApi.get(saleId);
        return { ok: true, written: true, sale: detail.sale, replay: true, saleId };
      } catch (err) {
        return { ok: false, saleId, message: err instanceof Error ? err.message : String(err), retryable: true };
      }
    },
    finaliseSale: async (tender, actionId): Promise<SaleWriteOutcome> => {
      if (!saleId || !actionId) return { ok: false, saleId: saleId ?? '', message: 'This party has not been settled yet.', retryable: true };
      try {
        const answer = await finaliseSale(saleId, actionId, tender);
        return { ok: true, written: true, saleId, ...answer };
      } catch (err) {
        return {
          ok: false,
          saleId,
          message: err instanceof Error ? err.message : 'The payment could not be confirmed.',
          retryable: !(err instanceof ApiError) || err.status >= 500 || err.code === 'IDEMPOTENCY_IN_FLIGHT',
          ...(err instanceof ApiError ? { code: err.code } : {}),
        };
      }
    },
    onComplete: (sale) => {
      setReceipt(sale.receiptNumber ?? null);
      setPhase('done');
      onSettled();
    },
  });
  useTenderPresentation(displayHandoff, 'party_balance', stage.state.method, stage.display, open && phase === 'payment');

  // Walk-ups the board already put on the tab: the platform refuses the
  // settlement (PARTY_WALK_UPS_ON_TAB), so the form says so before the press.
  const walkUpsOnTab = quote ? quote.walkUps : 0;
  const confirm = async () => {
    if (!quote || confirming || !stationId || walkUpsOnTab > 0) return;
    const press = JSON.stringify([form, quote.totalSatang]);
    if (!idsRef.current || idsRef.current.press !== press) {
      idsRef.current = { ids: { settlementId: newId(), saleId: newId(), actionId: newId() }, press };
    }
    setConfirming(true);
    setConfirmError(null);
    try {
      const outcome = await settlePartyOnPlatform({
        party,
        form,
        stationId,
        expectedTotalSatang: quote.totalSatang,
        ids: idsRef.current.ids,
      });
      if (outcome.ok) {
        const { sale } = outcome.answer;
        setSaleId(sale.id);
        onSettled();
        if (sale.status === 'finalised') {
          setReceipt(sale.receiptNumber);
          setPhase('done');
        } else {
          setPhase('payment');
        }
        return;
      }
      // A definite no: the next press asks afresh. Nothing answered: the same press goes again.
      if (!outcome.retryable) idsRef.current = null;
      // Settled at another press and still waiting for its balance: take it there.
      const held = outcome.details as { saleId?: string; state?: string } | undefined;
      if (outcome.code === 'PARTY_ALREADY_SETTLED' && held?.state === 'open' && held.saleId) {
        setSaleId(held.saleId);
        setPhase('payment');
        return;
      }
      setConfirmError(outcome.message);
    } finally {
      setConfirming(false);
    }
  };

  const close = () => {
    // A tender waiting for its answer holds the screen, as it holds the ticket till.
    if (phase === 'payment' && stage.locked) return;
    onOpenChange(false);
    // SCRUM-935 — closed with a settlement rung up (a part taken, a
    // settlement confirmed or resumed): the party page reads the party again,
    // so its bill and buttons show the balance the platform now holds
    // without a reload. Closed from the form, nothing changed: nothing is read.
    if (saleId) onSettled();
  };
  const closeRef = useRef(close);
  closeRef.current = close;
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeRef.current();
    };
    globalThis.addEventListener?.('keydown', onKey);
    return () => globalThis.removeEventListener?.('keydown', onKey);
  }, [open]);

  if (!open) return null;

  const pkg = plan.package;
  const balance = stage.state.outstandingSatang / 100;
  const formPane = (
    <div className="h-full flex flex-col min-h-0">
      <ScrollArea className="flex-1 min-h-0">
        <div className="mx-auto w-full max-w-lg px-6 py-5 space-y-5">
          <div>
            <h3 className="text-lg font-bold">{pkg.name}</h3>
            <p className="text-sm text-muted-foreground mt-0.5">
              Up to {pkg.kidsIncluded} children and {pkg.adultsIncluded} adults
              {pkg.hours ? ` · ${pkg.hours} hours` : ''}
              {pkg.socksIncluded === -1 ? ' · socks for all children' : pkg.socksIncluded > 0 ? ` · ${pkg.socksIncluded} pairs of socks` : ' · socks not included'}
            </p>
          </div>
          <div className="space-y-2">
            <Stepper label="Children" value={form.kids} min={1} onChange={setKids} hint={`${pkg.kidsIncluded} in the package`} />
            <Stepper label="Adults" value={form.adults} onChange={(adults) => setForm((f) => ({ ...f, adults }))} hint={`${pkg.adultsIncluded} in the package`} />
            <Stepper
              label="Socks given"
              value={form.socksGiven}
              onChange={(socksGiven) => {
                setSocksTouched(true);
                setForm((f) => ({ ...f, socksGiven }));
              }}
              hint={pkg.socksIncluded === 0 ? 'Every pair is sold' : 'Pairs beyond the package are sold'}
            />
          </div>
          {plan.addOns.length > 0 && (
            <div className="space-y-2">
              <h4 className="text-sm font-bold uppercase tracking-wide text-muted-foreground">Add-ons</h4>
              {plan.addOns.map((a) => (
                <Choice
                  key={a.id}
                  chosen={form.addOnIds.includes(a.id)}
                  title={`${a.name}${a.qty > 1 ? ` ×${a.qty}` : ''}`}
                  {...(a.fnbCreditSatang > 0 ? { detail: `${money(a.fnbCreditSatang)} F&B credit` } : {})}
                  price={money(a.qty * a.unitPriceSatang)}
                  onToggle={() => toggle('addOnIds', a.id)}
                />
              ))}
            </div>
          )}
          {plan.entertainment.length > 0 && (
            <div className="space-y-2">
              <h4 className="text-sm font-bold uppercase tracking-wide text-muted-foreground">Entertainment</h4>
              {plan.entertainment.map((e) => (
                <Choice
                  key={e.id}
                  chosen={form.entertainmentIds.includes(e.id)}
                  title={e.name}
                  {...(e.extraChildren > 0 ? { detail: `+${e.extraChildren} extra child${e.extraChildren === 1 ? '' : 'ren'}` } : {})}
                  price={money(e.priceSatang + e.extraChildren * (e.extraChildPriceSatang ?? 0))}
                  onToggle={() => toggle('entertainmentIds', e.id)}
                />
              ))}
            </div>
          )}
          <div className="rounded-2xl border border-foreground/10 bg-card/50 p-4">
            {quote ? (
              <QuoteSummary quote={quote} />
            ) : (
              <p className="text-sm text-muted-foreground">{previewError ?? 'Pricing the party…'}</p>
            )}
          </div>
          {quote && walkUpsOnTab > 0 && (
            <div className="rounded-xl bg-amber-500/15 text-amber-300 p-3 text-sm">
              {walkUpsOnTab} walk-up guest{walkUpsOnTab === 1 ? ' is' : 's are'} already on this party's tab (
              {money(quote.walkUpsSatang)}), so it cannot be settled as one sale. Take the balance on the tab instead.
            </div>
          )}
          {confirmError && <div className="rounded-xl bg-destructive/15 text-destructive p-3 text-sm">{confirmError}</div>}
        </div>
      </ScrollArea>
      <div className="shrink-0 flex items-center justify-between gap-3 px-6 py-4 border-t border-white/10 bg-card/40">
        <Button variant="outline" onClick={close}>
          Cancel
        </Button>
        <Button disabled={!quote || confirming || !stationId || walkUpsOnTab > 0} onClick={() => void confirm()}>
          {confirming ? 'Settling…' : quote ? `Confirm · ${money(quote.balanceSatang)} to pay` : 'Confirm'}
        </Button>
      </div>
    </div>
  );

  const staffPane =
    phase === 'form' ? (
      formPane
    ) : phase === 'payment' ? (
      <div className="h-full p-6">
        <div className="mx-auto w-full max-w-md h-full">
          <StepPayment
            total={balance}
            selectedMethod={stage.state.method}
            onSelectMethod={(method) => stage.selectMethod(method)}
            onComplete={() => undefined}
            onBack={close}
            paymentStage={stage}
            stickyFoot={false}
          />
        </div>
      </div>
    ) : (
      <div className="h-full flex flex-col items-center justify-center p-6 text-center">
        <div className="inline-flex h-12 w-12 rounded-full bg-emerald-500/15 items-center justify-center mb-3">
          <CheckCircle2 className="w-6 h-6 text-emerald-400" />
        </div>
        <h3 className="text-xl font-bold">Settled{receipt ? `, receipt ${receipt}` : ''}</h3>
        <p className="text-muted-foreground mt-1 text-sm max-w-sm">
          The receipt, a band for every child and adult{quote && quote.creditSatang > 0 ? ' and the F&B credit voucher' : ''} are printing.
        </p>
        <Button className="mt-6" onClick={() => onOpenChange(false)}>
          Done
        </Button>
      </div>
    );

  const customerPane =
    phase === 'payment' ? (
      <CustomerPaymentPane amount={balance} unread={Boolean(stage.recovering)} qr={stage.display} method={stage.state.method} title={party.title} />
    ) : (
      <div className="h-full w-full bg-gradient-to-b from-sky-950 via-slate-950 to-slate-950 text-white flex flex-col items-center justify-center text-center px-10">
        <div className="h-16 w-16 rounded-full bg-white/10 flex items-center justify-center mb-5">
          {phase === 'done' ? <CheckCircle2 className="w-8 h-8 text-emerald-300" /> : <PartyPopper className="w-8 h-8 text-sky-300" />}
        </div>
        <h2 className="text-3xl font-black mb-3">{phase === 'done' ? 'Thank you!' : party.title}</h2>
        {phase !== 'done' && quote && (
          <div className="w-full max-w-sm text-left text-lg space-y-1">
            <div className="flex justify-between"><span className="text-white/60">Total</span><span className="tabular-nums">{money(quote.totalSatang)}</span></div>
            <div className="flex justify-between"><span className="text-white/60">Deposit paid</span><span className="tabular-nums">−{money(quote.depositSatang)}</span></div>
            <div className="flex justify-between font-black text-2xl pt-2"><span>To pay</span><span className="tabular-nums text-sky-300">{money(quote.balanceSatang)}</span></div>
          </div>
        )}
      </div>
    );

  return (
    <div className="fixed inset-0 z-50 bg-background text-foreground flex flex-col">
      <div className="shrink-0 flex items-center justify-between gap-3 px-5 h-14 border-b border-white/10">
        <div className="flex items-center gap-3 min-w-0">
          <div className="h-9 w-9 rounded-full bg-primary/15 flex items-center justify-center">
            <Sparkles className="w-5 h-5 text-primary" />
          </div>
          <div className="min-w-0">
            <h2 className="text-base font-bold leading-tight truncate">
              {phase === 'form' ? 'Settle party' : phase === 'payment' ? 'Take the balance' : 'Party settled'}
            </h2>
            <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <PartyPopper className="w-3.5 h-3.5" />
              {party.title}
              <Baby className="w-3.5 h-3.5 ml-2" />
              {form.kids}
              <Users className="w-3.5 h-3.5 ml-2" />
              {form.adults}
            </span>
          </div>
        </div>
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            className="h-8 text-amber-300 hover:text-amber-200 hover:bg-amber-500/20"
            onClick={() => setShowCustomerDisplay((v) => !v)}
          >
            {showCustomerDisplay ? 'Hide' : 'Show'} customer display
          </Button>
          <Button variant="ghost" size="icon" onClick={close} aria-label="Close">
            <X className="w-5 h-5" />
          </Button>
        </div>
      </div>
      <div className="flex-1 flex min-h-0">
        <div className={`${showCustomerDisplay ? 'w-1/2 border-r border-white/10' : 'w-full'} h-full min-w-0`}>{staffPane}</div>
        {showCustomerDisplay && <div className="w-1/2 h-full min-w-0">{customerPane}</div>}
      </div>
    </div>
  );
}
