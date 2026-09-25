import { ChargeTarget, FnbOrder, FnbOrderLine, ManualDiscount, Wristband } from '@/types';
import { breakdownModifiers, describeModifiers } from '@/lib/fnb';
import { resolveRateToday } from '@/lib/pricingMode';
import { summarizeTax, roundTHB, type TaxBreakdown } from '@/lib/tax';
import { computeManualDiscount, formatDiscountDetail } from '@/lib/manualDiscount';
import { QrCode } from '@/components/till/QrCode';
import { LanguageSwitcher } from '@/components/shared/LanguageSwitcher';
import { useLanguage } from '@/i18n/LanguageContext';
import { resolveName } from '@/i18n/resolveTranslation';
import {
  Sparkles,
  Wallet,
  UtensilsCrossed,
  PartyPopper,
  Hash,
  Banknote,
  CreditCard,
  GlassWater,
  BadgePercent,
  QrCode as QrCodeIcon,
  Loader2,
  StickyNote,
} from 'lucide-react';

export type FnbCustomerStage = 'welcome' | 'order' | 'payment' | 'thankyou';

interface FnbCustomerDisplayProps {
  stage: FnbCustomerStage;
  wristband: Wristband | null;
  lines: FnbOrderLine[];
  orderNote: string;
  manualDiscounts: ManualDiscount[];
  total: number;
  taxBreakdown: TaxBreakdown;
  promptpayAmount: number | null;
  completedOrder: FnbOrder | null;
  newBalance: number | null;
  chargeTarget?: ChargeTarget;
}

function OrderNoteCallout({ note }: { note: string }) {
  const { t } = useLanguage();
  return (
    <div className="flex items-start gap-3 rounded-2xl bg-amber-400/10 border border-amber-400/30 px-5 py-4 text-(--cd-amber)">
      <StickyNote className="w-6 h-6 shrink-0 mt-0.5" />
      <div className="min-w-0">
        <div className="text-sm font-bold uppercase tracking-wide text-(--cd-amber)/80 leading-tight">
          {t('common.note')}
        </div>
        <div className="text-lg leading-snug">{note}</div>
      </div>
    </div>
  );
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

function ChargeBanner({ target }: { target: ChargeTarget }) {
  const { t } = useLanguage();
  return (
    <div className="shrink-0 flex items-center justify-center gap-3 bg-primary/15 border-b border-primary/30 px-6 py-4 text-primary text-center">
      <PartyPopper className="w-6 h-6 shrink-0" />
      <span className="font-bold text-xl">
        {t('till.order.chargingTo', { title: target.partyTitle })}
        {target.childName ? ` · ${target.childName}` : ''}
      </span>
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
        <div className="text-sm text-foreground/60 leading-tight">{wristband.customerNickname}'s {t('common.credit')}</div>
        <div className="text-2xl font-black text-primary tabular-nums leading-tight">
          ฿{wristband.creditBalanceTHB}
        </div>
      </div>
    </div>
  );
}

function OrderLines({
  lines,
  manualDiscounts,
  manualAmounts,
}: {
  lines: FnbOrderLine[];
  manualDiscounts: ManualDiscount[];
  manualAmounts: Record<string, number>;
}) {
  const { lang } = useLanguage();
  return (
    <div className="space-y-3">
      {lines.map((line) => {
        const breakdown = breakdownModifiers(line.menuItem, line.selectedModifiers);
        const lineDiscounts = manualDiscounts.filter(
          (md) => md.scope === 'line' && md.targetLineId === line.id
        );
        return (
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
                  <div className="text-xl font-bold leading-tight">{resolveName(line.menuItem, lang)}</div>
                  <div className="text-foreground/40 text-sm tabular-nums">฿{resolveRateToday(line.menuItem.price)} base</div>
                  {line.qty > 1 && (
                    <div className="text-foreground/40 text-sm tabular-nums">
                      {/*
                        The row's own figure divided by its count, NOT the base
                        price plus the option deltas worked out again here
                        (S2-09b): the total beside it is the platform's, and a
                        second arithmetic on this screen could contradict it in
                        front of the guest it is being read by.
                      */}
                      ฿{roundTHB(line.lineTotal / line.qty)} each × {line.qty}
                    </div>
                  )}
                  {breakdown.length > 0 && (
                    <ul className="mt-1.5 space-y-0.5">
                      {breakdown.map((mod, i) => (
                        <li
                          key={`${mod.groupName}-${mod.optionName}-${i}`}
                          className="flex items-baseline gap-2 text-foreground/60 text-sm leading-snug"
                        >
                          <span className="text-primary/60 shrink-0">+</span>
                          <span className="min-w-0 truncate">
                            <span className="text-foreground/40">{mod.groupName}:</span>{' '}
                            <span className="text-foreground/75">{mod.optionName}</span>
                          </span>
                          <span className="ml-auto shrink-0 tabular-nums">
                            {mod.price > 0 ? `฿${mod.price}` : 'free'}
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                  {line.note && (
                    <div className="mt-1.5 flex items-start gap-1.5 text-(--cd-amber) text-sm leading-snug">
                      <StickyNote className="w-4 h-4 shrink-0 mt-px" />
                      <span className="min-w-0">{line.note}</span>
                    </div>
                  )}
                </div>
              </div>
              <div className="text-2xl font-bold tabular-nums shrink-0">฿{line.lineTotal}</div>
            </div>
            {lineDiscounts.map((md) => {
              const amt = manualAmounts[md.id] ?? 0;
              if (amt <= 0) return null;
              return (
                <div
                  key={md.id}
                  className="mt-3 flex items-center justify-between rounded-xl bg-emerald-500/10 px-4 py-2.5 text-(--cd-success)"
                >
                  <span className="flex items-center gap-2.5 text-base font-semibold">
                    <BadgePercent className="w-5 h-5 shrink-0" />
                    {formatDiscountDetail(md)}
                  </span>
                  <span className="text-lg font-bold tabular-nums">−฿{amt}</span>
                </div>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}

export function FnbCustomerDisplay({
  stage,
  wristband,
  lines,
  orderNote,
  manualDiscounts,
  total,
  taxBreakdown,
  promptpayAmount,
  completedOrder,
  newBalance,
  chargeTarget,
}: FnbCustomerDisplayProps) {
  const { t } = useLanguage();
  if (stage === 'welcome') {
    return (
      <Shell>
        <div className="flex-1 flex flex-col items-center justify-center text-center px-10 animate-in fade-in zoom-in-95 duration-500">
          <div className="w-28 h-28 rounded-[2rem] bg-primary flex items-center justify-center text-primary-foreground mb-8 shadow-2xl shadow-primary/30">
            <GlassWater className="w-14 h-14" />
          </div>
          <h1 className="text-6xl font-black tracking-tight mb-4">{t('fnb.welcome.title')}</h1>
          <p className="text-2xl text-foreground/70 max-w-lg">{t('fnb.welcome.subtitle')}</p>
          <div className="flex items-center gap-2 mt-10 text-foreground/50 text-lg">
            <Sparkles className="w-5 h-5" />
            {t('fnb.welcome.staffHelp')}
          </div>
        </div>
      </Shell>
    );
  }

  if (stage === 'order') {
    // Wristband loaded but nothing ordered yet — greet by nickname and show balance.
    if (lines.length === 0) {
      return (
        <Shell>
          {chargeTarget && <ChargeBanner target={chargeTarget} />}
          <div className="flex-1 flex flex-col items-center justify-center text-center px-10 animate-in fade-in zoom-in-95 duration-500">
            {wristband ? (
              <>
                <div className="text-2xl text-foreground/70 mb-2">{t('fnb.order.welcomeBack')}</div>
                <h1 className="text-6xl font-black tracking-tight mb-8">{wristband.customerNickname}!</h1>
                <div className="rounded-3xl bg-foreground/5 border border-foreground/10 px-10 py-7">
                  <div className="text-lg text-foreground/60 mb-1">{t('fnb.order.creditBalance')}</div>
                  <div className="text-6xl font-black text-primary tabular-nums">
                    ฿{wristband.creditBalanceTHB}
                  </div>
                </div>
                <p className="text-xl text-foreground/60 mt-8">{t('fnb.order.whatCanWeGet')}</p>
              </>
            ) : chargeTarget ? (
              <>
                <div className="w-24 h-24 rounded-3xl bg-primary/15 text-primary flex items-center justify-center mb-6">
                  <UtensilsCrossed className="w-12 h-12" />
                </div>
                <div className="text-2xl text-foreground/70 mb-2">{t('fnb.order.welcomeBack')}</div>
                <h1 className="text-6xl font-black tracking-tight mb-3">{chargeTarget.parentName}!</h1>
                {chargeTarget.phone && (
                  <p className="text-xl text-foreground/50 font-mono mb-2">{chargeTarget.phone}</p>
                )}
                <p className="text-xl text-foreground/60">{t('fnb.order.staffAdding')}</p>
              </>
            ) : (
              <>
                <div className="w-24 h-24 rounded-3xl bg-primary/15 text-primary flex items-center justify-center mb-6">
                  <UtensilsCrossed className="w-12 h-12" />
                </div>
                <h1 className="text-5xl font-black tracking-tight mb-3">{t('fnb.order.letsOrder')}</h1>
                <p className="text-xl text-foreground/60">{t('fnb.order.staffAdding')}</p>
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
        {chargeTarget && <ChargeBanner target={chargeTarget} />}
        <div className="p-8 flex items-center justify-between border-b border-foreground/10 shrink-0">
          <Brand />
          {wristband ? (
            <BalanceChip wristband={wristband} />
          ) : chargeTarget ? (
            <div className="text-right">
              <div className="text-lg font-bold leading-tight">{chargeTarget.parentName}</div>
              {chargeTarget.phone && (
                <div className="text-sm text-foreground/50 font-mono">{chargeTarget.phone}</div>
              )}
            </div>
          ) : (
            <span className="text-lg text-foreground/60">{t('fnb.header.yourOrder')}</span>
          )}
        </div>
        <div className="flex-1 overflow-y-auto p-8 space-y-4">
          <OrderLines lines={lines} manualDiscounts={manualDiscounts} manualAmounts={manualAmounts} />
          {orderNote.trim() && <OrderNoteCallout note={orderNote.trim()} />}
        </div>
        <div className="p-8 border-t border-foreground/10 shrink-0">
          {orderDiscounts.map((md) => {
            const amt = manualAmounts[md.id] ?? 0;
            if (amt <= 0) return null;
            return (
              <div
                key={md.id}
                className="flex items-center justify-between mb-2 text-(--cd-success)"
              >
                <span className="flex items-center gap-2 text-lg">
                  <BadgePercent className="w-5 h-5 shrink-0" />
                  {t('common.discount')} · {formatDiscountDetail(md)}
                </span>
                <span className="text-lg font-bold tabular-nums">−฿{amt}</span>
              </div>
            );
          })}
          {summarizeTax(taxBreakdown).map((row) => (
            <div key={row.key} className="flex items-center justify-between mb-2 text-foreground/60">
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
    const balance = wristband?.creditBalanceTHB ?? 0;
    const creditUsed = Math.min(balance, total);
    const remainderDue = total - creditUsed;

    if (promptpayAmount !== null) {
      return (
        <Shell>
          <div className="flex-1 flex flex-col items-center justify-center text-center px-10 animate-in fade-in zoom-in-95 duration-500">
            <div className="inline-flex items-center gap-2 text-(--cd-violet) mb-4">
              <QrCodeIcon className="w-6 h-6" />
              <span className="uppercase tracking-widest text-sm font-bold">{t('fnb.payment.thaiQrPromptpay')}</span>
            </div>
            <h2 className="text-4xl font-black mb-6">{t('fnb.payment.scanToPay')}</h2>
            <div className="bg-white rounded-3xl p-6 shadow-2xl shadow-violet-500/20">
              <QrCode seed={`fnb-promptpay-${promptpayAmount}`} className="w-64 h-64" />
            </div>
            <div className="text-6xl font-black text-(--cd-violet) mt-8 tabular-nums">฿{promptpayAmount}</div>
            {creditUsed > 0 && (
              <p className="text-lg text-foreground/60 mt-3">
                {t('fnb.payment.paidFromCredit', { amount: String(creditUsed) })}
              </p>
            )}
            <p className="text-xl text-foreground/60 mt-4 max-w-md">{t('fnb.payment.openBankingApp')}</p>
            <div className="flex items-center gap-3 mt-6 text-foreground/50 text-lg">
              <Loader2 className="w-5 h-5 animate-spin" />
              {t('fnb.payment.waiting')}
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
          <p className="text-2xl text-foreground/70 mb-6">{t('fnb.payment.amountToPay')}</p>

          <div className="w-full max-w-md space-y-3">
            {creditUsed > 0 && (
              <div className="flex items-center justify-between bg-foreground/5 rounded-2xl px-6 py-4 border border-foreground/10">
                <span className="flex items-center gap-3 text-xl text-foreground/80">
                  <Wallet className="w-6 h-6 text-primary" />
                  {t('fnb.payment.fromCredit')}
                </span>
                <span className="text-2xl font-black text-primary tabular-nums">฿{creditUsed}</span>
              </div>
            )}
            <div className="flex items-center justify-between bg-foreground/5 rounded-2xl px-6 py-4 border border-foreground/10">
              <span className="flex items-center gap-3 text-xl text-foreground/80">
                <Banknote className="w-6 h-6 text-foreground/60" />
                {creditUsed > 0 ? t('fnb.payment.leftToPay') : t('fnb.payment.toPay')}
              </span>
              <span className="text-4xl font-black tabular-nums">฿{remainderDue}</span>
            </div>
          </div>

          <p className="text-xl text-foreground/60 mt-8">{t('fnb.payment.confirmWithStaff')}</p>
        </div>
      </Shell>
    );
  }

  // thankyou
  const order = completedOrder;
  if (!order) {
    return (
      <Shell>
        <div className="flex-1 flex items-center justify-center text-foreground/50 text-2xl">{t('fnb.thankyou.title')}</div>
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
          <h2 className="text-5xl font-black">{t('fnb.thankyou.title')}</h2>
          <p className="text-foreground/60 text-xl mt-2">{t('fnb.thankyou.subtitle')}</p>
        </div>

        <div className="mx-auto w-full max-w-xl space-y-4">
          <div className="rounded-3xl bg-primary/10 border border-primary/30 p-6 flex items-center justify-between">
            <div className="flex items-center gap-3">
              <Hash className="w-7 h-7 text-primary" />
              <span className="text-xl text-foreground/80">{t('fnb.thankyou.pickupCode')}</span>
            </div>
            <span className="text-4xl font-black text-primary tabular-nums tracking-widest">
              {order.pickupCode}
            </span>
          </div>

          <div className="rounded-3xl bg-foreground/5 border border-foreground/10 p-6">
            <div className="text-sm font-bold uppercase tracking-wide text-foreground/50 mb-3">{t('fnb.thankyou.yourOrder')}</div>
            <div className="space-y-2">
              {order.lines.map((line) => {
                const mods = describeModifiers(line.menuItem, line.selectedModifiers);
                return (
                  <div key={line.id} className="flex items-start justify-between text-lg gap-3">
                    <span className="text-foreground/80 min-w-0">
                      <span className="font-bold tabular-nums">{line.qty}×</span> {line.menuItem.name}
                      {mods.length > 0 && (
                        <span className="block text-sm text-foreground/50">{mods.join(', ')}</span>
                      )}
                      {line.note && (
                        <span className="flex items-start gap-1.5 text-sm text-(--cd-amber)">
                          <StickyNote className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                          {line.note}
                        </span>
                      )}
                    </span>
                    <span className="font-bold tabular-nums shrink-0">฿{line.lineTotal}</span>
                  </div>
                );
              })}
            </div>
            {order.orderNote && (
              <div className="mt-3 pt-3 border-t border-foreground/10">
                <OrderNoteCallout note={order.orderNote} />
              </div>
            )}
            <div className="border-t border-foreground/10 mt-3 pt-3 space-y-1.5">
              <div className="flex items-center justify-between text-xl font-bold">
                <span>{t('common.total')}</span>
                <span className="tabular-nums">฿{order.total}</span>
              </div>
              {order.payment.creditUsed > 0 && (
                <PaidRow icon={Wallet} label={t('fnb.thankyou.fnbCredit')} amount={order.payment.creditUsed} />
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
                  <div className="text-lg text-foreground/80">{t('fnb.thankyou.remainingCredit')}</div>
                  <div className="text-sm text-foreground/50">{order.wristband.customerNickname}</div>
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
