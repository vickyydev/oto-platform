import { ManualDiscount, MerchOrder, MerchOrderLine, Wristband } from '@/types';
import { summarizeTax, roundTHB, type TaxBreakdown } from '@/lib/tax';
import { resolveRateToday } from '@/lib/pricingMode';
import { computeManualDiscount, formatDiscountDetail } from '@/lib/manualDiscount';
import { QrCode } from '@/components/till/QrCode';
import { LanguageSwitcher } from '@/components/shared/LanguageSwitcher';
import { useLanguage } from '@/i18n/LanguageContext';
import { resolveName } from '@/i18n/resolveTranslation';
import {
  Sparkles,
  Wallet,
  ShoppingBag,
  PartyPopper,
  Banknote,
  CreditCard,
  BadgePercent,
  QrCode as QrCodeIcon,
  Loader2,
} from 'lucide-react';

export type MerchCustomerStage = 'welcome' | 'order' | 'payment' | 'thankyou';

interface MerchCustomerDisplayProps {
  stage: MerchCustomerStage;
  wristband: Wristband | null;
  lines: MerchOrderLine[];
  manualDiscounts: ManualDiscount[];
  total: number;
  taxBreakdown: TaxBreakdown;
  promptpayAmount: number | null;
  completedOrder: MerchOrder | null;
  newBalance: number | null;
  /**
   * S2-14a round 2 — the credit the station is REALLY taking on this order
   * (the payment stage's figure), in satang. The prototype subtracted the
   * band's whole balance here whether or not the station could spend it
   * (plan §6); the display now shows only what the platform takes.
   */
  creditSatang?: number;
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

function BalanceChip({ wristband }: { wristband: Wristband }) {
  const { t } = useLanguage();
  return (
    <div className="inline-flex items-center gap-3 rounded-2xl bg-foreground/5 border border-foreground/10 px-5 py-3">
      <Wallet className="w-6 h-6 text-primary shrink-0" />
      <div className="text-left">
        <div className="text-sm text-foreground/60 leading-tight">
          {wristband.customerNickname}'s {t('common.credit')}
        </div>
        <div className="text-2xl font-black text-primary tabular-nums leading-tight">
          ฿{wristband.creditBalanceTHB ?? 0}
        </div>
      </div>
    </div>
  );
}

function OrderLines({ lines }: { lines: MerchOrderLine[] }) {
  const { lang } = useLanguage();
  return (
    <div className="space-y-3">
      {lines.map((line) => (
        <div
          key={line.id}
          className="bg-foreground/5 rounded-2xl px-5 py-4 border border-foreground/10 animate-in fade-in slide-in-from-right-2 duration-300"
        >
          <div className="flex items-start justify-between gap-4">
            <div className="flex items-start gap-4 min-w-0">
              <span className="w-10 h-10 rounded-xl bg-primary/15 text-primary font-black text-lg flex items-center justify-center shrink-0 tabular-nums">
                {line.qty}
              </span>
              <div className="min-w-0">
                <div className="text-xl font-bold leading-tight">{resolveName(line.merchItem, lang)}</div>
                <div className="text-foreground/40 text-sm tabular-nums">
                  ฿{resolveRateToday(line.merchItem.price)} each
                </div>
              </div>
            </div>
            <div className="text-2xl font-bold tabular-nums shrink-0">฿{line.lineTotal}</div>
          </div>
        </div>
      ))}
    </div>
  );
}

function PaidRow({
  icon: Icon,
  label,
  amount,
}: {
  icon: typeof Wallet;
  label: string;
  amount: number;
}) {
  return (
    <div className="flex items-center justify-between text-base text-foreground/60">
      <span className="flex items-center gap-2">
        <Icon className="w-5 h-5" />
        {label}
      </span>
      <span className="tabular-nums">฿{amount}</span>
    </div>
  );
}

export function MerchCustomerDisplay({
  stage,
  wristband,
  lines,
  manualDiscounts,
  total,
  taxBreakdown,
  promptpayAmount,
  completedOrder,
  newBalance,
  creditSatang,
}: MerchCustomerDisplayProps) {
  const { t, lang } = useLanguage();
  if (stage === 'welcome') {
    return (
      <Shell>
        <div className="flex-1 flex flex-col items-center justify-center text-center px-10 animate-in fade-in zoom-in-95 duration-500">
          <div className="w-28 h-28 rounded-[2rem] bg-primary flex items-center justify-center text-primary-foreground mb-8 shadow-2xl shadow-primary/30">
            <ShoppingBag className="w-14 h-14" />
          </div>
          <h1 className="text-6xl font-black tracking-tight mb-4">{t('merch.welcome.title')}</h1>
          <p className="text-2xl text-foreground/70 max-w-lg">{t('merch.welcome.subtitle')}</p>
          <div className="flex items-center gap-2 mt-10 text-foreground/50 text-lg">
            <Sparkles className="w-5 h-5" />
            {t('merch.welcome.staffHelp')}
          </div>
        </div>
      </Shell>
    );
  }

  if (stage === 'order') {
    if (lines.length === 0) {
      return (
        <Shell>
          <div className="flex-1 flex flex-col items-center justify-center text-center px-10 animate-in fade-in zoom-in-95 duration-500">
            {wristband ? (
              <>
                <div className="text-2xl text-foreground/70 mb-2">{t('merch.order.welcomeBack')}</div>
                <h1 className="text-6xl font-black tracking-tight mb-8">
                  {wristband.customerNickname}!
                </h1>
                <div className="rounded-3xl bg-foreground/5 border border-foreground/10 px-10 py-7">
                  <div className="text-lg text-foreground/60 mb-1">{t('merch.order.yourCredit')}</div>
                  <div className="text-6xl font-black text-primary tabular-nums">
                    ฿{wristband.creditBalanceTHB ?? 0}
                  </div>
                </div>
                <p className="text-xl text-foreground/60 mt-8">{t('merch.order.whatCanWeGet')}</p>
              </>
            ) : (
              <>
                <div className="w-24 h-24 rounded-3xl bg-primary/15 text-primary flex items-center justify-center mb-6">
                  <ShoppingBag className="w-12 h-12" />
                </div>
                <h1 className="text-5xl font-black tracking-tight mb-3">{t('merch.order.letsShop')}</h1>
                <p className="text-xl text-foreground/60">{t('merch.order.staffAdding')}</p>
              </>
            )}
          </div>
        </Shell>
      );
    }

    const subtotal = lines.reduce((acc, l) => acc + l.lineTotal, 0);
    const lineAmounts = Object.fromEntries(lines.map((l) => [l.id, l.lineTotal]));
    const { amounts: manualAmounts } = computeManualDiscount(
      manualDiscounts,
      subtotal,
      lineAmounts
    );
    const orderDiscounts = manualDiscounts.filter((md) => md.scope === 'order');
    return (
      <Shell>
        <div className="p-8 flex items-center justify-between border-b border-foreground/10 shrink-0">
          <Brand />
          {wristband ? (
            <BalanceChip wristband={wristband} />
          ) : (
            <span className="text-lg text-foreground/60">{t('merch.header.yourSale')}</span>
          )}
        </div>
        <div className="flex-1 overflow-y-auto p-8 space-y-4">
          <OrderLines lines={lines} />
        </div>
        <div className="p-8 border-t border-foreground/10 shrink-0">
          {orderDiscounts.map((md) => {
            const amt = manualAmounts[md.id] ?? 0;
            if (amt <= 0) return null;
            return (
              <div key={md.id} className="flex items-center justify-between mb-2 text-(--cd-success)">
                <span className="flex items-center gap-2 text-lg">
                  <BadgePercent className="w-5 h-5 shrink-0" />
                  {t('common.discount')} · {formatDiscountDetail(md)}
                </span>
                <span className="text-lg font-bold tabular-nums">−฿{amt}</span>
              </div>
            );
          })}
          {summarizeTax(taxBreakdown).map((row) => (
            <div
              key={row.key}
              className="flex items-center justify-between mb-2 text-foreground/60"
            >
              <span className="text-lg">{row.label}</span>
              <span className="text-lg tabular-nums">฿{roundTHB(row.amount)}</span>
            </div>
          ))}
          <div className="flex items-center justify-between">
            <span className="text-2xl text-foreground/70">{t('common.total')}</span>
            <span className="text-5xl font-black text-primary tabular-nums">฿{total}</span>
          </div>
        </div>
      </Shell>
    );
  }

  if (stage === 'payment') {
    const creditUsed = Math.min((creditSatang ?? 0) / 100, total);
    const remainderDue = roundTHB(total - creditUsed);

    if (promptpayAmount !== null) {
      return (
        <Shell>
          <div className="flex-1 flex flex-col items-center justify-center text-center px-10 animate-in fade-in zoom-in-95 duration-500">
            <div className="inline-flex items-center gap-2 text-(--cd-violet) mb-4">
              <QrCodeIcon className="w-6 h-6" />
              <span className="uppercase tracking-widest text-sm font-bold">
                {t('merch.payment.thaiQrPromptpay')}
              </span>
            </div>
            <h2 className="text-4xl font-black mb-6">{t('merch.payment.scanToPay')}</h2>
            <div className="bg-white rounded-3xl p-6 shadow-2xl shadow-violet-500/20">
              <QrCode seed={`merch-promptpay-${promptpayAmount}`} className="w-64 h-64" />
            </div>
            <div className="text-6xl font-black text-(--cd-violet) mt-8 tabular-nums">
              ฿{promptpayAmount}
            </div>
            {creditUsed > 0 && (
              <p className="text-lg text-foreground/60 mt-3">
                {t('merch.payment.paidFromCredit', { amount: String(creditUsed) })}
              </p>
            )}
            <p className="text-xl text-foreground/60 mt-4 max-w-md">
              {t('merch.payment.openBankingApp')}
            </p>
            <div className="flex items-center gap-3 mt-6 text-foreground/50 text-lg">
              <Loader2 className="w-5 h-5 animate-spin" />
              {t('merch.payment.waiting')}
            </div>
          </div>
        </Shell>
      );
    }

    return (
      <Shell>
        <div className="flex-1 flex flex-col items-center justify-center text-center px-10 animate-in fade-in zoom-in-95 duration-500">
          <div className="w-24 h-24 rounded-full bg-primary/15 flex items-center justify-center text-primary mb-8">
            <Wallet className="w-12 h-12" />
          </div>
          <p className="text-2xl text-foreground/70 mb-6">{t('merch.payment.amountToPay')}</p>

          <div className="w-full max-w-md space-y-3">
            {creditUsed > 0 && (
              <div className="flex items-center justify-between bg-foreground/5 rounded-2xl px-6 py-4 border border-foreground/10">
                <span className="flex items-center gap-3 text-xl text-foreground/80">
                  <Wallet className="w-6 h-6 text-primary" />
                  {t('merch.payment.fromCredit')}
                </span>
                <span className="text-2xl font-black text-primary tabular-nums">฿{creditUsed}</span>
              </div>
            )}
            <div className="flex items-center justify-between bg-foreground/5 rounded-2xl px-6 py-4 border border-foreground/10">
              <span className="flex items-center gap-3 text-xl text-foreground/80">
                <Banknote className="w-6 h-6 text-foreground/60" />
                {creditUsed > 0 ? t('merch.payment.leftToPay') : t('merch.payment.toPay')}
              </span>
              <span className="text-4xl font-black tabular-nums">฿{remainderDue}</span>
            </div>
          </div>

          <p className="text-xl text-foreground/60 mt-8">{t('merch.payment.confirmWithStaff')}</p>
        </div>
      </Shell>
    );
  }

  // thankyou
  const order = completedOrder;
  if (!order) {
    return (
      <Shell>
        <div className="flex-1 flex items-center justify-center text-foreground/50 text-2xl">
          {t('merch.thankyou.title')}
        </div>
      </Shell>
    );
  }

  const paidCash = order.payment.cash;
  const paidCard = order.payment.card;
  const paidPromptpay = order.payment.promptpay;

  return (
    <Shell>
      <div className="flex-1 flex flex-col p-8 overflow-y-auto animate-in fade-in zoom-in-95 duration-500">
        <div className="text-center mb-6 shrink-0">
          <div className="w-20 h-20 rounded-full bg-emerald-500/20 flex items-center justify-center text-(--cd-success) mx-auto mb-4">
            <PartyPopper className="w-10 h-10" />
          </div>
          <h2 className="text-5xl font-black">{t('merch.thankyou.title')}</h2>
          <p className="text-foreground/60 text-xl mt-2">{t('merch.thankyou.subtitle')}</p>
        </div>

        <div className="mx-auto w-full max-w-xl space-y-4">
          <div className="rounded-3xl bg-foreground/5 border border-foreground/10 p-6">
            <div className="text-sm font-bold uppercase tracking-wide text-foreground/50 mb-3">
              {t('merch.thankyou.yourPurchase')}
            </div>
            <div className="space-y-2">
              {order.lines.map((line) => (
                <div key={line.id} className="flex items-start justify-between text-lg gap-3">
                  <span className="text-foreground/80 min-w-0">
                    <span className="font-bold tabular-nums">{line.qty}×</span>{' '}
                    {resolveName(line.merchItem, lang)}
                  </span>
                  <span className="font-bold tabular-nums shrink-0">฿{line.lineTotal}</span>
                </div>
              ))}
            </div>
            <div className="border-t border-foreground/10 mt-3 pt-3 space-y-1.5">
              <div className="flex items-center justify-between text-xl font-bold">
                <span>{t('common.total')}</span>
                <span className="tabular-nums">฿{order.total}</span>
              </div>
              {order.payment.creditUsed > 0 && (
                <PaidRow icon={Wallet} label={t('common.credit')} amount={order.payment.creditUsed} />
              )}
              {paidCash > 0 && <PaidRow icon={Banknote} label={t('common.cash')} amount={paidCash} />}
              {paidCard > 0 && <PaidRow icon={CreditCard} label={t('common.card')} amount={paidCard} />}
              {paidPromptpay > 0 && (
                <PaidRow icon={QrCodeIcon} label={t('common.thaiQrPromptpay')} amount={paidPromptpay} />
              )}
            </div>
          </div>

          {order.wristband && newBalance !== null && (
            <div className="rounded-3xl bg-primary/10 border border-primary/30 p-6 flex items-center justify-between">
              <div className="flex items-center gap-3">
                <Wallet className="w-7 h-7 text-primary" />
                <div>
                  <div className="text-lg text-foreground/80">{t('merch.thankyou.remainingCredit')}</div>
                  <div className="text-sm text-foreground/50">
                    {order.wristband.customerNickname}
                  </div>
                </div>
              </div>
              <span className="text-4xl font-black text-primary tabular-nums">฿{newBalance}</span>
            </div>
          )}
        </div>
      </div>
    </Shell>
  );
}
