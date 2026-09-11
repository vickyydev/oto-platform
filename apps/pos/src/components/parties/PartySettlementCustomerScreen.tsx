import { PartyBooking, PartyPaymentMethod } from '@/types';
import {
  computePartyTotal,
  computePartyOutstanding,
  partyExtraChargeGroups,
  partyLineItemsTotal,
  partyPaymentsTotal,
} from '@/lib/party';
import { paymentMethodLabel, paymentMethodIcon, paymentMethodKind } from '@/lib/payments';
import { PromptPayCustomerScreen } from '@/components/shared/PromptPayCustomerScreen';
import { LanguageSwitcher } from '@/components/shared/LanguageSwitcher';
import { useLanguage } from '@/i18n/LanguageContext';
import {
  PartyPopper,
  ReceiptText,
  Banknote,
  CheckCircle2,
  Loader2,
} from 'lucide-react';

// Customer-facing party-settlement display. Self-contained: it takes the whole
// settlement state (party + the amount/method being collected + stage) as props
// so a backend dev can later swap the shared-state link for real device sync.
export type SettlementStage = 'idle' | 'review' | 'payment' | 'thankyou';

interface PartySettlementCustomerScreenProps {
  stage: SettlementStage;
  party: PartyBooking;
  // Amount being collected in THIS transaction (live in review, frozen once the
  // operator moves to the payment stage).
  amount: number;
  method?: PartyPaymentMethod;
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="h-full w-full bg-[image:var(--cd-gradient)] text-foreground flex flex-col relative">
      <div className="absolute top-4 right-4 z-40">
        <LanguageSwitcher variant="dark" />
      </div>
      {children}
    </div>
  );
}

function Brand() {
  const { t } = useLanguage();
  return (
    <div className="flex items-center gap-3">
      <div className="w-11 h-11 rounded-2xl bg-primary flex items-center justify-center text-primary-foreground font-black text-2xl">
        O
      </div>
      <span className="text-2xl font-bold tracking-tight">{t('common.brand')}</span>
    </div>
  );
}

function BillRow({
  label,
  value,
  muted,
  strong,
}: {
  label: React.ReactNode;
  value: React.ReactNode;
  muted?: boolean;
  strong?: boolean;
}) {
  return (
    <div
      className={`flex items-baseline justify-between gap-4 ${
        strong ? 'text-xl font-bold' : 'text-lg'
      } ${muted ? 'text-foreground/55' : 'text-foreground/90'}`}
    >
      <span className="min-w-0">{label}</span>
      <span className="tabular-nums shrink-0">{value}</span>
    </div>
  );
}

export function PartySettlementCustomerScreen({
  stage,
  party,
  amount,
  method,
}: PartySettlementCustomerScreenProps) {
  const { t } = useLanguage();
  const lineItemsTotal = partyLineItemsTotal(party);
  const extraGroups = partyExtraChargeGroups(party);
  const total = computePartyTotal(party);
  const prior = partyPaymentsTotal(party);
  const outstanding = computePartyOutstanding(party);

  if (stage === 'idle') {
    return (
      <Shell>
        <div className="flex-1 flex flex-col items-center justify-center text-center px-10 animate-in fade-in zoom-in-95 duration-500">
          <div className="w-24 h-24 rounded-3xl bg-primary/15 text-primary flex items-center justify-center mb-6">
            <PartyPopper className="w-12 h-12" />
          </div>
          <h1 className="text-5xl font-black tracking-tight mb-3">{t('common.brand')}</h1>
          <p className="text-xl text-foreground/60">{t('party.idle.thanks')}</p>
        </div>
      </Shell>
    );
  }

  if (stage === 'review') {
    return (
      <Shell>
        <div className="p-8 flex items-center justify-between border-b border-foreground/10 shrink-0">
          <Brand />
          <span className="inline-flex items-center gap-2 text-lg text-foreground/60">
            <ReceiptText className="w-6 h-6" />
            {t('party.review.yourBill')}
          </span>
        </div>

        <div className="flex-1 overflow-y-auto p-8 space-y-6">
          <div>
            <div className="text-3xl font-black tracking-tight">{party.title}</div>
            <div className="text-lg text-foreground/55 mt-1">
              {party.childName}
              {party.kidAge ? ` · turning ${party.kidAge}` : ''}
            </div>
          </div>

          <div className="rounded-2xl bg-foreground/5 border border-foreground/10 p-6 space-y-3">
            <BillRow label={party.packageName ?? t('party.review.partyPackage')} value={`฿${party.basePrice}`} />
            {party.lineItems.map((li) => (
              <BillRow
                key={li.id}
                label={
                  <span>
                    {li.name}
                    {li.qty > 1 ? <span className="text-foreground/40"> ×{li.qty}</span> : null}
                  </span>
                }
                value={`฿${li.qty * li.price}`}
                muted
              />
            ))}
            {party.lineItems.length > 0 && (
              <BillRow
                label={<span className="text-foreground/55">{t('party.review.addOnsSubtotal')}</span>}
                value={`฿${lineItemsTotal}`}
                muted
              />
            )}

            {extraGroups.length > 0 && (
              <div className="border-t border-foreground/10 pt-3 space-y-4">
                <div className="flex items-center gap-2 text-(--cd-sky) font-semibold">
                  <PartyPopper className="w-5 h-5" />
                  {t('party.review.addedOnDay')}
                </div>
                {extraGroups.map((g) => (
                  <div key={g.kind} className="space-y-2">
                    {g.items.map((it, i) => (
                      <BillRow
                        key={`${g.kind}-${i}`}
                        label={
                          <span>
                            {it.name}
                            {it.qty > 1 ? <span className="text-foreground/40"> ×{it.qty}</span> : null}
                          </span>
                        }
                        value={`฿${it.lineTotal}`}
                        muted
                      />
                    ))}
                    {g.adjustment !== 0 && (
                      <BillRow
                        label={
                          <span className="text-foreground/55">
                            {g.adjustment < 0 ? t('party.review.discount') : t('party.review.adjustment')}
                          </span>
                        }
                        value={`${g.adjustment < 0 ? '−' : '+'}฿${Math.abs(g.adjustment)}`}
                        muted
                      />
                    )}
                    <BillRow
                      label={<span className="text-foreground/55">{t('party.review.subtotal', { label: g.label })}</span>}
                      value={`+฿${g.total}`}
                      muted
                    />
                  </div>
                ))}
              </div>
            )}

            <div className="border-t border-foreground/10 pt-3 space-y-2">
              <BillRow label={t('party.review.total')} value={`฿${total}`} strong />
              <BillRow label={t('party.review.lessDeposit')} value={`−฿${party.deposit}`} muted />
              {prior > 0 && (
                <BillRow label={t('party.review.lessPayments')} value={`−฿${prior}`} muted />
              )}
            </div>
          </div>
        </div>

        <div className="p-8 border-t border-foreground/10 shrink-0 flex items-center justify-between">
          <span className="text-2xl font-bold">{t('party.review.outstandingDue')}</span>
          <span
            className={`text-6xl font-black tabular-nums ${
              outstanding > 0 ? 'text-primary' : 'text-(--cd-success)'
            }`}
          >
            ฿{outstanding}
          </span>
        </div>
      </Shell>
    );
  }

  if (stage === 'payment') {
    const remainingAfter = Math.max(0, outstanding - amount);
    const isPartial = amount < outstanding;

    if (method && paymentMethodKind(method) === 'qr') {
      return (
        <PromptPayCustomerScreen
          amount={amount}
          seed={`party-promptpay-${party.id}-${amount}`}
          note={isPartial ? t('party.payment.partPayment', { remaining: remainingAfter }) : undefined}
        />
      );
    }

    const Icon = method ? paymentMethodIcon(paymentMethodKind(method)) : Banknote;
    const label = method ? paymentMethodLabel(method) : '';
    return (
      <Shell>
        <div className="flex-1 flex flex-col items-center justify-center text-center px-10 animate-in fade-in zoom-in-95 duration-500">
          <div className="w-24 h-24 rounded-3xl bg-primary/15 text-primary flex items-center justify-center mb-6">
            <Icon className="w-12 h-12" />
          </div>
          <div className="text-2xl text-foreground/70 mb-2">{t('party.payment.pleasePay')}</div>
          <div className="text-7xl font-black tabular-nums mb-3">฿{amount}</div>
          <div className="text-2xl text-foreground/70 mb-6">{t('party.payment.by', { method: label })}</div>
          {isPartial && (
            <div className="rounded-2xl bg-foreground/5 border border-foreground/10 px-8 py-5 text-lg">
              <span className="text-foreground/60">{t('party.payment.payingNow')} </span>
              <span className="font-bold tabular-nums">฿{amount}</span>
              <span className="text-foreground/40"> · </span>
              <span className="text-foreground/60">{t('party.payment.remainingAfter')} </span>
              <span className="font-bold tabular-nums text-primary">฿{remainingAfter}</span>
            </div>
          )}
          <div className="flex items-center gap-3 mt-8 text-foreground/50 text-lg">
            <Loader2 className="w-5 h-5 animate-spin" />
            {t('party.payment.waiting')}
          </div>
        </div>
      </Shell>
    );
  }

  // thankyou — party already mutated, so `outstanding` is the post-payment figure.
  const settled = outstanding <= 0;
  return (
    <Shell>
      <div className="flex-1 flex flex-col items-center justify-center text-center px-10 animate-in fade-in zoom-in-95 duration-500">
        <div
          className={`w-28 h-28 rounded-full flex items-center justify-center mb-8 ${
            settled ? 'bg-emerald-500/15 text-(--cd-success)' : 'bg-primary/15 text-primary'
          }`}
        >
          <CheckCircle2 className="w-16 h-16" />
        </div>
        <h1 className="text-6xl font-black tracking-tight mb-3">
          {settled ? t('party.thankyou.allSettled') : t('party.thankyou.paymentReceived')}
        </h1>
        <p className="text-2xl text-foreground/60 mb-8">{party.title}</p>
        <div className="rounded-3xl bg-foreground/5 border border-foreground/10 px-12 py-8 space-y-3">
          <div>
            <div className="text-lg text-foreground/60">{t('party.thankyou.paidNow')}</div>
            <div className="text-5xl font-black tabular-nums text-(--cd-success)">฿{amount}</div>
          </div>
          <div className="border-t border-foreground/10 pt-3">
            <div className="text-lg text-foreground/60">{t('party.thankyou.outstanding')}</div>
            <div
              className={`text-4xl font-black tabular-nums ${
                settled ? 'text-(--cd-success)' : 'text-primary'
              }`}
            >
              ฿{outstanding}
            </div>
          </div>
        </div>
        {settled && (
          <p className="text-xl text-foreground/60 mt-8">{t('party.thankyou.fullyPaid')}</p>
        )}
      </div>
    </Shell>
  );
}
