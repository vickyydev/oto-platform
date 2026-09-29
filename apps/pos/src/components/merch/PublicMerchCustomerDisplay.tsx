import type { ReactNode } from 'react';
import type { DisplayMerchCart, DisplayPayment, DisplayTotals } from '@oto/shared';
import { summarizeTax, roundTHB, type TaxBreakdown } from '@/lib/tax';
import { PaymentExpiry, PaymentQr } from '@/components/till/PaymentQr';
import { LanguageSwitcher } from '@/components/shared/LanguageSwitcher';
import { useLanguage } from '@/i18n/LanguageContext';
import { Sparkles, Wallet, ShoppingBag, PartyPopper, Banknote, CreditCard,
  BadgePercent, QrCode as QrCodeIcon, Loader2 } from 'lucide-react';

export type PublicMerchStage = 'welcome' | 'order' | 'payment' | 'thankyou';
type Discount = DisplayMerchCart['manualDiscounts'][number];
const discountDetail = (discount: Discount) => discount.type === 'comp' ? 'Comp (100% off)'
  : discount.type === 'percent' ? `${discount.value}% off` : `฿${discount.value} off`;

function taxRows(totals: DisplayTotals) {
  const captured: TaxBreakdown = { netSubtotal: 0, discountTotal: 0, exclusiveTaxTotal: 0,
    inclusiveTaxTotal: 0, taxTotal: 0, grandTotal: totals.total,
    serviceChargeTotal: totals.taxBreakdown.serviceChargeTotal,
    categories: totals.taxBreakdown.categories.map(category => ({ ...category, category: 'merch',
      base: 0, taxPercent: 0, serviceCharge: 0, secondaryTaxPercent: 0, gross: 0 })),
  };
  return summarizeTax(captured);
}

function Shell({ children }: { children: ReactNode }) {
  return <div className="h-full w-full bg-[image:var(--cd-gradient)] text-foreground flex flex-col relative">
    <div className="absolute top-4 right-4 z-40"><LanguageSwitcher variant="dark" /></div>
    {children}
  </div>;
}

function Brand() {
  const { t } = useLanguage();
  return <div className="flex items-center gap-3">
    <div className="w-11 h-11 rounded-2xl bg-primary flex items-center justify-center text-primary-foreground font-black text-2xl">O</div>
    <span className="text-2xl font-bold tracking-tight">{t('common.brand')}</span>
  </div>;
}

function PaidRow({ icon: Icon, label, amount }: { icon: typeof Wallet; label: string; amount: number }) {
  return <div className="flex items-center justify-between text-base text-foreground/60">
    <span className="flex items-center gap-2"><Icon className="w-5 h-5" />{label}</span>
    <span className="tabular-nums">฿{amount}</span>
  </div>;
}

/** The approved guest layout reads captured facts only; it has no catalog or wallet access. */
export function PublicMerchCustomerDisplay({ stage, cart, totals, payment }: {
  stage: PublicMerchStage;
  cart: DisplayMerchCart;
  totals?: DisplayTotals;
  payment?: DisplayPayment;
}) {
  const { t, lang } = useLanguage();
  if (stage === 'welcome' || stage === 'order' && cart.lines.length === 0) {
    return <Shell>
      <div className="flex-1 flex flex-col items-center justify-center text-center px-10 transition-none animate-in fade-in zoom-in-95 duration-500">
        <div className="w-28 h-28 rounded-[2rem] bg-primary flex items-center justify-center text-primary-foreground mb-8 shadow-2xl shadow-primary/30">
          <ShoppingBag className="w-14 h-14" />
        </div>
        <h1 className="text-6xl font-black tracking-tight mb-4">{t('merch.welcome.title')}</h1>
        <p className="text-2xl text-foreground/70 max-w-lg">{t('merch.display.guestWelcome')}</p>
        <div className="flex items-center gap-2 mt-10 text-foreground/50 text-lg">
          <Sparkles className="w-5 h-5" />{t('merch.welcome.staffHelp')}
        </div>
      </div>
    </Shell>;
  }
  if (stage === 'order' && totals) {
    return <Shell>
      <div className="py-8 pl-8 pr-36 flex items-center justify-between border-b border-foreground/10 shrink-0">
        <Brand /><span className="text-lg text-foreground/60">{t('merch.header.yourSale')}</span>
      </div>
      <div className="flex-1 overflow-y-auto p-8 space-y-4">
        <div className="space-y-3">{cart.lines.map(line => <div key={line.id} data-testid="merch-display-line"
          className="bg-foreground/5 rounded-2xl px-5 py-4 border border-foreground/10 transition-none animate-in fade-in slide-in-from-right-2 duration-300">
          <div className="flex items-start justify-between gap-4">
            <div className="flex items-start gap-4 min-w-0">
              <span className="w-10 h-10 rounded-xl bg-primary/15 text-primary font-black text-lg flex items-center justify-center shrink-0 tabular-nums">{line.qty}</span>
              <div className="min-w-0">
                <div className="text-xl font-bold leading-tight">{line.translations?.[lang] ?? line.name}</div>
                {line.variantLabel && <div className="text-foreground/60 text-sm">{line.variantLabel}</div>}
                <div className="text-foreground/40 text-sm tabular-nums">฿{line.unitPrice} each</div>
              </div>
            </div>
            <div className="text-2xl font-bold tabular-nums shrink-0">฿{line.lineTotal}</div>
          </div>
          {cart.manualDiscounts.filter(discount => discount.scope === 'line' && discount.targetLineId === line.id)
            .map(discount => totals.manualAmounts[discount.id] > 0 && <div key={discount.id}
              className="mt-3 flex items-center justify-between rounded-xl bg-emerald-500/10 px-4 py-2.5 text-(--cd-success)">
              <span className="flex items-center gap-2.5 text-base font-semibold"><BadgePercent className="w-5 h-5 shrink-0" />{discountDetail(discount)}</span>
              <span className="text-lg font-bold tabular-nums">−฿{totals.manualAmounts[discount.id]}</span>
            </div>)}
        </div>)}</div>
      </div>
      <div className="p-8 border-t border-foreground/10 shrink-0">
        {cart.manualDiscounts.filter(discount => discount.scope === 'order').map(discount => totals.manualAmounts[discount.id] > 0
          && <div key={discount.id} className="flex items-center justify-between mb-2 text-(--cd-success)">
            <span className="flex items-center gap-2 text-lg"><BadgePercent className="w-5 h-5 shrink-0" />
              {t('common.discount')} · {discountDetail(discount)}</span>
            <span className="text-lg font-bold tabular-nums">−฿{totals.manualAmounts[discount.id]}</span>
          </div>)}
        {taxRows(totals).map(row => <div key={row.key} className="flex items-center justify-between mb-2 text-foreground/60">
          <span className="text-lg">{row.label}</span><span className="text-lg tabular-nums">฿{roundTHB(row.amount)}</span>
        </div>)}
        <div className="flex items-center justify-between"><span className="text-2xl text-foreground/70">{t('common.total')}</span>
          <span className="text-5xl font-black text-primary tabular-nums">฿{totals.total}</span></div>
      </div>
    </Shell>;
  }
  if (stage === 'payment' && payment) {
    if (payment.online && payment.status === 'pending' && (payment.qrPayload || payment.qrImageUrl)) {
      return <Shell><div className="flex-1 flex flex-col items-center justify-center text-center px-10 transition-none animate-in fade-in zoom-in-95 duration-500">
        <div className="inline-flex items-center gap-2 text-(--cd-violet) mb-4"><QrCodeIcon className="w-6 h-6" />
          <span className="uppercase tracking-widest text-sm font-bold">{t('merch.payment.thaiQrPromptpay')}</span></div>
        <h2 className="text-4xl font-black mb-6">{t('merch.payment.scanToPay')}</h2>
        <div className="bg-white rounded-3xl p-6 shadow-2xl shadow-violet-500/20">
          <PaymentQr payload={payment.qrPayload} imageUrl={payment.qrImageUrl} className="w-64 h-64" /></div>
        <div className="text-6xl font-black text-(--cd-violet) mt-8 tabular-nums">฿{payment.amountSatang / 100}</div>
        <PaymentExpiry expiresAt={payment.expiresAt} />
        <p className="text-xl text-foreground/60 mt-4 max-w-md">{t('merch.payment.openBankingApp')}</p>
        <div className="flex items-center gap-3 mt-6 text-foreground/50 text-lg"><Loader2 className="w-5 h-5 animate-spin" />{t('merch.payment.waiting')}</div>
      </div></Shell>;
    }
    return <Shell><div className="flex-1 flex flex-col items-center justify-center text-center px-10 transition-none animate-in fade-in zoom-in-95 duration-500">
      <div className="w-24 h-24 rounded-full bg-primary/15 flex items-center justify-center text-primary mb-8"><Wallet className="w-12 h-12" /></div>
      <p className="text-2xl text-foreground/70 mb-6">{t('merch.payment.amountToPay')}</p>
      <div className="w-full max-w-md space-y-3"><div className="flex items-center justify-between bg-foreground/5 rounded-2xl px-6 py-4 border border-foreground/10">
        <span className="flex items-center gap-3 text-xl text-foreground/80"><Banknote className="w-6 h-6 text-foreground/60" />{t('merch.payment.toPay')}</span>
        <span className="text-4xl font-black tabular-nums">฿{payment.amountSatang / 100}</span></div></div>
      <p className="text-xl text-foreground/60 mt-8">{!payment.online ? t('till.payment.reconnect') : payment.offline ? t('till.payment.offlineRecorded')
        : payment.status === 'pending' ? t('merch.payment.waiting') : payment.status === 'paid' ? t('till.payment.received')
          : payment.status === 'blocked' ? t('till.payment.checking') : t('merch.payment.confirmWithStaff')}</p>
    </div></Shell>;
  }
  const completion = cart.completion;
  if (stage === 'thankyou' && completion) {
    return <Shell><div className="flex-1 flex flex-col p-8 overflow-y-auto transition-none animate-in fade-in zoom-in-95 duration-500">
      <div className="text-center mb-6 shrink-0"><div className="w-20 h-20 rounded-full bg-emerald-500/20 flex items-center justify-center text-(--cd-success) mx-auto mb-4"><PartyPopper className="w-10 h-10" /></div>
        <h2 className="text-5xl font-black">{t('merch.thankyou.title')}</h2><p className="text-foreground/60 text-xl mt-2">{t('merch.thankyou.subtitle')}</p></div>
      <div className="mx-auto w-full max-w-xl space-y-4"><div className="rounded-3xl bg-foreground/5 border border-foreground/10 p-6">
        <div className="text-sm font-bold uppercase tracking-wide text-foreground/50 mb-3">{t('merch.thankyou.yourPurchase')}</div>
        <div className="space-y-2">{cart.lines.map(line => <div key={line.id} className="flex items-start justify-between text-lg gap-3">
          <span className="text-foreground/80 min-w-0"><span className="font-bold tabular-nums">{line.qty}×</span>{' '}{line.translations?.[lang] ?? line.name}
            {line.variantLabel && <span className="block text-sm text-foreground/50">{line.variantLabel}</span>}</span>
          <span className="font-bold tabular-nums shrink-0">฿{line.lineTotal}</span></div>)}</div>
        <div className="border-t border-foreground/10 mt-3 pt-3 space-y-1.5">
          <div className="flex items-center justify-between text-xl font-bold"><span>{t('common.total')}</span><span className="tabular-nums">฿{completion.total}</span></div>
          {completion.payment.cash > 0 && <PaidRow icon={Banknote} label={t('common.cash')} amount={completion.payment.cash} />}
          {completion.payment.card > 0 && <PaidRow icon={CreditCard} label={t('common.card')} amount={completion.payment.card} />}
          {completion.payment.promptpay > 0 && <PaidRow icon={QrCodeIcon} label={t('common.thaiQrPromptpay')} amount={completion.payment.promptpay} />}
        </div>
      </div></div>
    </div></Shell>;
  }
  return <Shell><div className="flex-1 flex items-center justify-center p-8 text-center text-xl">Please follow the staff screen.</div></Shell>;
}
