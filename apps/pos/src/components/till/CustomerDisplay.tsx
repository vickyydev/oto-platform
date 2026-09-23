import { Sale, Member, ChargeTarget, ContactChannel } from '@/types';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { QrCode } from './QrCode';
import { PhoneInput } from '@/components/shared/PhoneInput';
import { LanguageSwitcher } from '@/components/shared/LanguageSwitcher';
import { useLanguage } from '@/i18n/LanguageContext';
import { resolveName } from '@/i18n/resolveTranslation';
import {
  computeLineBreakdown,
  componentKey,
  breakdownComponentKey,
  isAdultRulePriced,
  isTierPriced,
  unpricedCartLines,
  unpricedLineReason,
  type LineBreakdownKind,
} from '@/lib/pricing';
import { computeTotals } from '@/lib/sale';
import { summarizeTax, roundTHB } from '@/lib/tax';
import { formatDiscountDetail, formatDiscountTarget } from '@/lib/manualDiscount';
import { paymentMethodKind, paymentMethodLabel } from '@/lib/payments';
import { tierNeedsProof } from '@/lib/membership';
import {
  Sparkles,
  Baby,
  User,
  ShoppingBag,
  UtensilsCrossed,
  Wallet,
  PartyPopper,
  Smartphone,
  Footprints,
  BadgePercent,
  QrCode as QrCodeIcon,
  Loader2,
  IdCard,
  BadgeCheck,
  AlertTriangle,
  type LucideIcon,
} from 'lucide-react';

const BREAKDOWN_ICONS: Record<LineBreakdownKind, LucideIcon> = {
  kids: Baby,
  adults: User,
  socks: Footprints,
  addon: ShoppingBag,
};

function BreakdownRow({
  kind,
  label,
  unitPrice,
  quantity,
  subtotal,
  unpriced,
}: {
  kind: LineBreakdownKind;
  label: string;
  unitPrice: number;
  quantity: number;
  subtotal: number;
  /** No price exists for this row — print a dash, never the ฿0 that stands in for one. */
  unpriced?: boolean;
}) {
  const Icon = BREAKDOWN_ICONS[kind];
  return (
    <div className="flex items-center justify-between py-2.5 border-b border-foreground/5 last:border-b-0">
      <span className="flex items-center gap-3 text-xl text-foreground/70">
        <Icon className="w-6 h-6 text-foreground/50 shrink-0" />
        <span>
          {label}
          <span className="text-foreground/40 text-base ml-2">
            {quantity} × {unpriced ? '—' : `฿${unitPrice}`}
          </span>
        </span>
      </span>
      <span className="text-xl font-bold tabular-nums">{unpriced ? '—' : `฿${subtotal}`}</span>
    </div>
  );
}

export type CustomerStage = 'identify' | 'welcome' | 'order' | 'input' | 'payment' | 'thankyou';

interface CustomerDisplayProps {
  stage: CustomerStage;
  sale: Sale;
  phone: string;
  nickname: string;
  member: Member | null;
  onPhoneChange: (v: string) => void;
  onNicknameChange: (v: string) => void;
  onIdentify: () => void;
  onSkipIdentify: () => void;
  onCustomerDone: () => void;
  /** When the order is billed to a party tab, show which party on the display. */
  chargeTarget?: ChargeTarget;
  /** Channel selector attached to the phone field (both identify + input stages). */
  contactChannel?: ContactChannel;
  onContactChannelChange?: (v: ContactChannel) => void;
  /**
   * The order's figures as the platform quoted them (S2-09a / SCRUM-203).
   * Absent = price it here, which is what the harness and the party-tab callers
   * do. The visitor's screen and the staff panel must never show two different
   * numbers for the same cart, so when the till has a platform quote it hands
   * the same one to both.
   */
  totals?: Pick<
    ReturnType<typeof computeTotals>,
    'manualAmounts' | 'discountAmount' | 'total' | 'taxBreakdown'
  >;
}

function ChargeBanner({ target }: { target: ChargeTarget }) {
  return (
    <div className="shrink-0 flex items-center justify-center gap-3 bg-primary/15 border-b border-primary/30 px-6 py-4 text-primary text-center">
      <PartyPopper className="w-6 h-6 shrink-0" />
      <span className="font-bold text-xl">
        Charging to {target.partyTitle}
        {target.childName ? ` · ${target.childName}` : ''}
      </span>
    </div>
  );
}

function Shell({
  customerName,
  children,
}: {
  customerName?: string;
  children: React.ReactNode;
}) {
  const { t } = useLanguage();
  return (
    <div className="h-full w-full bg-[image:var(--cd-gradient)] text-foreground flex flex-col relative">
      <div className="absolute top-4 right-4 z-40">
        <LanguageSwitcher variant="dark" />
      </div>
      {customerName ? (
        <div className="shrink-0 flex items-center gap-2 px-8 py-3 bg-foreground/5 border-b border-foreground/10">
          <User className="w-4 h-4 text-primary" />
          <span className="text-sm text-foreground/50">{t('common.customer')}</span>
          <span className="text-sm font-semibold">{customerName}</span>
        </div>
      ) : null}
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

export function CustomerDisplay({
  stage,
  sale,
  phone,
  nickname,
  member,
  onPhoneChange,
  onNicknameChange,
  onIdentify,
  onSkipIdentify,
  onCustomerDone,
  chargeTarget,
  contactChannel,
  onContactChannelChange,
  totals,
}: CustomerDisplayProps) {
  const { t, lang } = useLanguage();
  const displayName = nickname.trim() || member?.nickname || '';
  if (stage === 'identify') {
    return (
      <Shell>
        <div className="flex-1 flex flex-col p-8 overflow-y-auto animate-in fade-in slide-in-from-bottom-4 duration-300">
          <div className="text-center mb-6">
            <div className="inline-flex items-center gap-2 text-primary mb-2">
              <IdCard className="w-6 h-6" />
              <span className="uppercase tracking-widest text-sm font-bold">{t('till.identify.membersSave')}</span>
            </div>
            <h2 className="text-5xl font-black">{t('till.identify.title')}</h2>
            <p className="text-foreground/60 text-lg mt-2">{t('till.identify.subtitle')}</p>
          </div>

          <div className="mx-auto w-full max-w-md space-y-6">
            <PhoneInput
              value={phone}
              onChange={onPhoneChange}
              showKeypad
              channel={contactChannel}
              onChannelChange={onContactChannelChange}
              translate
            />

            <div>
              <label className="text-foreground/70 text-lg">
                {t('till.identify.nickname')}{' '}
                <span className="text-foreground/40 text-base">({t('till.identify.optional')})</span>
              </label>
              <Input
                value={nickname}
                onChange={(e) => onNicknameChange(e.target.value)}
                placeholder={t('till.identify.nicknamePlaceholder')}
                className="h-16 mt-2 text-2xl px-5 bg-foreground/5 border-foreground/10 text-foreground placeholder:text-foreground/30"
              />
            </div>
          </div>
        </div>
        <div className="p-8 border-t border-foreground/10 space-y-3">
          <Button
            size="lg"
            className="w-full h-20 text-2xl font-bold rounded-2xl"
            disabled={phone.trim().length === 0}
            onClick={onIdentify}
          >
            {t('till.identify.findMembership')}
          </Button>
          <Button
            variant="ghost"
            size="lg"
            className="w-full h-14 text-lg text-foreground/60 hover:text-foreground hover:bg-foreground/5 rounded-2xl"
            onClick={onSkipIdentify}
          >
            {t('till.identify.skip')}
          </Button>
        </div>
      </Shell>
    );
  }

  if (stage === 'welcome') {
    const memberRate = !!member && tierNeedsProof(sale.tier);
    return (
      <Shell customerName={displayName}>
        <div className="flex-1 flex flex-col items-center justify-center text-center px-10 animate-in fade-in zoom-in-95 duration-500">
          <div className="w-28 h-28 rounded-[2rem] bg-primary flex items-center justify-center text-primary-foreground font-black text-6xl mb-8 shadow-2xl shadow-primary/30">
            O
          </div>
          {member ? (
            <>
              <h1 className="text-6xl font-black tracking-tight mb-4">
                {t('till.welcome.backTitle', { name: member.nickname })}
              </h1>
              <p className="text-2xl text-foreground/70 max-w-lg">{t('till.welcome.backSubtitle')}</p>
              {memberRate && (
                <div className="flex items-center gap-2 mt-8 px-5 py-2.5 rounded-full bg-emerald-500/15 border border-emerald-500/30 text-(--cd-success) text-lg font-semibold">
                  <BadgeCheck className="w-5 h-5" />
                  {t('till.welcome.memberRate')}
                </div>
              )}
            </>
          ) : (
            <>
              <h1 className="text-6xl font-black tracking-tight mb-4">{t('till.welcome.title')}</h1>
              <p className="text-2xl text-foreground/70 max-w-lg">{t('till.welcome.subtitle')}</p>
            </>
          )}
          <div className="flex items-center gap-2 mt-10 text-foreground/50 text-lg">
            <Sparkles className="w-5 h-5" />
            {t('till.welcome.staffHelp')}
          </div>
        </div>
      </Shell>
    );
  }

  if (stage === 'order') {
    const { manualAmounts, discountAmount, total, taxBreakdown } =
      totals ??
      computeTotals(sale.lines, sale.discounts ?? [], sale.manualDiscounts);
    const taxRows = summarizeTax(taxBreakdown);
    const orderDiscounts = sale.manualDiscounts.filter((md) => md.scope === 'order');
    /**
     * WHAT THIS SCREEN WILL NOT QUOTE A FAMILY (SCRUM-312).
     *
     * A tier nobody priced on a ticket resolves to ฿0 here, because
     * `computeLineBreakdown` and `lineTotal` both go through `priceForTier`,
     * which flattens the missing price to a number so the arithmetic has one.
     * Unguarded, the drop-off line a family watches on this half printed
     * "Kids 1 × ฿0" and a ฿0 total while the staff panel beside it said no
     * price was set — two answers to the same cart, and the wrong one facing
     * the person paying. So this half refuses the same lines the order panel
     * refuses, read from the same helper: a dash where a figure would be, the
     * reason underneath, and no total while any line is unpriced.
     */
    const unpriced = unpricedCartLines(sale.lines);
    return (
      <Shell customerName={displayName}>
        {chargeTarget && <ChargeBanner target={chargeTarget} />}
        <div className="p-8 flex items-center justify-between border-b border-foreground/10">
          <Brand />
          <span className="text-lg text-foreground/60">{t('till.order.yourOrder')}</span>
        </div>
        <div className="flex-1 overflow-y-auto p-8 space-y-4">
          {sale.lines.length === 0 ? (
            <div className="h-full flex items-center justify-center text-foreground/50 text-2xl">
              {t('till.order.building')}
            </div>
          ) : (
            sale.lines.map((line) => {
              const lineDiscounts = sale.manualDiscounts.filter(
                (md) =>
                  md.scope === 'line' &&
                  md.targetLineId === line.id &&
                  !md.targetComponent
              );
              // Component-scoped discounts, indexed by their component key so
              // each renders directly beneath its matching breakdown row.
              const componentDiscounts = sale.manualDiscounts.filter(
                (md) =>
                  md.scope === 'line' &&
                  md.targetLineId === line.id &&
                  md.targetComponent
              );
              // promoItem lines are synthetic (free item at ฿0 net); render
              // as a simple grant card rather than a ticket breakdown card.
              if (line.promoItem) {
                return (
                  <div key={line.id} className="bg-emerald-500/10 rounded-3xl p-6 border border-emerald-500/20">
                    <div className="flex items-center justify-between">
                      <div className="text-2xl font-bold text-emerald-300">
                        🎁 {line.promoItem.name}
                      </div>
                      <div className="text-2xl font-bold text-emerald-300">฿0</div>
                    </div>
                    <div className="text-sm text-emerald-400/70 mt-1">{t('till.order.complimentary')}</div>
                  </div>
                );
              }
              // This line's own missing prices, if any — the line total is a
              // dash while it has one, and each row that lacks a price says so.
              const lineUnpriced = unpricedCartLines([line]).length > 0;
              return (
                <div key={line.id} className="bg-foreground/5 rounded-3xl p-6 border border-foreground/10">
                  <div className="flex items-center justify-between mb-2">
                    <div className="text-2xl font-bold">{resolveName(line.ticketType, lang)}</div>
                    <div className="text-2xl font-bold text-primary">
                      {lineUnpriced ? '—' : `฿${line.lineTotal}`}
                    </div>
                  </div>
                  <div className="mt-1">
                    {computeLineBreakdown(line).map((item) => {
                      const key = breakdownComponentKey(item);
                      const matches = componentDiscounts.filter(
                        (md) => componentKey(md.targetComponent!) === key
                      );
                      // The two rows a missing price reaches: the ticket row
                      // (kids, and a drop-off child's own ticket) and the paid
                      // adults row. Socks, add-ons and the drop-off service fee
                      // carry their own prices and are shown as they are.
                      const rowUnpriced =
                        item.kind === 'kids'
                          ? !isTierPriced(line.ticketType, line.tier)
                          : item.key === 'adults'
                            ? !isAdultRulePriced(line.ticketType, line.tier, line.adults)
                            : false;
                      return (
                        <div key={item.key}>
                          <BreakdownRow
                            kind={item.kind}
                            label={item.label}
                            unitPrice={item.unitPrice}
                            quantity={item.quantity}
                            subtotal={item.subtotal}
                            unpriced={rowUnpriced}
                          />
                          {matches.map((md) => {
                            const amt = manualAmounts[md.id] ?? 0;
                            if (amt <= 0) return null;
                            return (
                              <div
                                key={md.id}
                                className="flex items-center justify-between py-2 pl-9 text-(--cd-success)"
                              >
                                <span className="flex items-center gap-3 text-base font-semibold">
                                  <BadgePercent className="w-5 h-5 shrink-0" />
                                  {formatDiscountTarget(md)} · {formatDiscountDetail(md)}
                                </span>
                                <span className="text-lg font-bold tabular-nums">−฿{amt}</span>
                              </div>
                            );
                          })}
                        </div>
                      );
                    })}
                  </div>
                  {lineDiscounts.map((md) => {
                    const amt = manualAmounts[md.id] ?? 0;
                    if (amt <= 0) return null;
                    return (
                      <div
                        key={md.id}
                        className="mt-3 flex items-center justify-between rounded-2xl bg-emerald-500/10 px-4 py-3 text-(--cd-success)"
                      >
                        <span className="flex items-center gap-3 text-lg font-semibold">
                          <BadgePercent className="w-6 h-6 shrink-0" />
                          {formatDiscountDetail(md)}
                        </span>
                        <span className="text-xl font-bold tabular-nums">−฿{amt}</span>
                      </div>
                    );
                  })}
                </div>
              );
            })
          )}
        </div>
        <div className="p-8 border-t border-foreground/10">
          {/* The discount and tax rows are worked out from a subtotal that is
              missing the price nobody set, so while a line is unpriced they
              would state amounts of an order that has no amount. They come back
              with the total, once the price exists. */}
          {unpriced.length === 0 && (
            <>
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
              {discountAmount > 0 && (
                <div className="flex items-center justify-between mb-2 text-(--cd-success)">
                  <span className="text-lg">{t('till.order.discountCode')}</span>
                  <span className="text-lg font-bold tabular-nums">−฿{discountAmount}</span>
                </div>
              )}
            </>
          )}
          {member && tierNeedsProof(sale.tier) && (
            <div className="flex items-center gap-2 mb-3 text-(--cd-success) text-base font-semibold">
              <BadgeCheck className="w-5 h-5 shrink-0" />
              {t('till.welcome.memberRate')}
            </div>
          )}
          {unpriced.length === 0 &&
            taxRows.map((row) => (
              <div key={row.key} className="flex items-center justify-between mb-2 text-foreground/60">
                <span className="text-lg">{row.label}</span>
                <span className="text-lg tabular-nums">฿{roundTHB(row.amount)}</span>
              </div>
            ))}
          {/* The same sentence the staff panel shows, from the same helper, so
              the two halves of the counter say one thing about the same cart. */}
          {unpriced.length > 0 && (
            <div className="mb-3 space-y-1.5 text-foreground/60">
              {unpriced.map((u) => (
                <div
                  key={`${u.ticketName}-${u.tier}-${u.what}`}
                  className="flex items-center gap-2 text-base"
                >
                  <AlertTriangle className="w-5 h-5 shrink-0" />
                  <span>{unpricedLineReason(u)}</span>
                </div>
              ))}
            </div>
          )}
          <div className="flex items-center justify-between">
            <span className="text-2xl text-foreground/70">{t('common.total')}</span>
            <span className="text-5xl font-black text-primary">
              {unpriced.length > 0 ? '—' : `฿${total}`}
            </span>
          </div>
        </div>
      </Shell>
    );
  }

  if (stage === 'input') {
    return (
      <Shell customerName={displayName}>
        <div className="flex-1 flex flex-col p-8 overflow-y-auto animate-in fade-in slide-in-from-bottom-4 duration-300">
          <div className="text-center mb-6">
            <div className="inline-flex items-center gap-2 text-primary mb-2">
              <Smartphone className="w-6 h-6" />
              <span className="uppercase tracking-widest text-sm font-bold">{t('till.input.yourTurn')}</span>
            </div>
            <h2 className="text-4xl font-black">{t('till.input.enterDetails')}</h2>
            <p className="text-foreground/60 text-lg mt-1">{t('till.input.reach')}</p>
          </div>

          <div className="mx-auto w-full max-w-md space-y-6">
            <PhoneInput
              value={phone}
              onChange={onPhoneChange}
              showKeypad
              channel={contactChannel}
              onChannelChange={onContactChannelChange}
              translate
            />

            <div>
              <label className="text-foreground/70 text-lg">{t('till.identify.nickname')}</label>
              <Input
                value={nickname}
                onChange={(e) => onNicknameChange(e.target.value)}
                placeholder={t('till.identify.nicknamePlaceholder')}
                className="h-16 mt-2 text-2xl px-5 bg-foreground/5 border-foreground/10 text-foreground placeholder:text-foreground/30"
              />
            </div>
          </div>
        </div>
        <div className="p-8 border-t border-foreground/10">
          <Button
            size="lg"
            className="w-full h-20 text-2xl font-bold rounded-2xl"
            onClick={onCustomerDone}
          >
            {t('common.done')}
          </Button>
        </div>
      </Shell>
    );
  }

  if (stage === 'payment') {
    /**
     * THE AMOUNT THE FAMILY IS ASKED FOR (SCRUM-316).
     *
     * The order stage stopped quoting a cart it could not price (SCRUM-312);
     * this stage — the one that says "please pay" — went on printing
     * `sale.total`, which is the ฿0 `priceForTier` substitutes for a price
     * nobody set, in seven-rem type. It now reads the same helper the rows and
     * the staff panel read.
     *
     * A SECOND LOCK, NOT THE FIRST. Three routes set the payment step without
     * passing the order panel's Pay button — the supervision gate, the
     * customer-input step's Done, and "Done adding" for a known member — and
     * none of them asks whether the cart is priced. What keeps an unpriced cart
     * off this screen today is further upstream: `TicketCard` does not answer a
     * press for a tier it cannot price, so a line at such a tier never enters
     * the cart (the drop-off path attaches one by name, but its play length is
     * chosen from those same refused cards, so it cannot be configured or
     * advanced past the ticket step either). Driving it in a browser, an
     * unpriced cart could not be walked to this stage at all. So the guard is
     * here because this is where the figure is printed and nothing at this
     * stage checks it — not because a way through is known.
     */
    const unpriced = unpricedCartLines(sale.lines);
    if (sale.paymentMethod && paymentMethodKind(sale.paymentMethod) === 'qr') {
      return (
        <Shell customerName={displayName}>
          <div className="flex-1 flex flex-col items-center justify-center text-center px-10 animate-in fade-in zoom-in-95 duration-500">
            <div className="inline-flex items-center gap-2 text-(--cd-violet) mb-4">
              <QrCodeIcon className="w-6 h-6" />
              <span className="uppercase tracking-widest text-sm font-bold">{t('till.payment.scanToPay')}</span>
            </div>
            <h2 className="text-4xl font-black mb-6">{t('till.payment.scanToPay')}</h2>
            <div className="bg-white rounded-3xl p-6 shadow-2xl shadow-violet-500/20">
              <QrCode seed={`promptpay-${sale.id}-${sale.total}`} className="w-64 h-64" />
            </div>
            <div className="text-6xl font-black text-(--cd-violet) mt-8">
              {unpriced.length > 0 ? '—' : `฿${sale.total}`}
            </div>
            <p className="text-xl text-foreground/60 mt-4 max-w-md">{t('till.payment.openBankingApp')}</p>
            <div className="flex items-center gap-3 mt-6 text-foreground/50 text-lg">
              <Loader2 className="w-5 h-5 animate-spin" />
              {t('till.payment.waitingConfirmation')}
            </div>
          </div>
        </Shell>
      );
    }

    return (
      <Shell customerName={displayName}>
        <div className="flex-1 flex flex-col items-center justify-center text-center px-10 animate-in fade-in zoom-in-95 duration-500">
          <div className="w-24 h-24 rounded-full bg-primary/15 flex items-center justify-center text-primary mb-8">
            <Wallet className="w-12 h-12" />
          </div>
          <p className="text-2xl text-foreground/70 mb-2">{t('common.pleasePay')}</p>
          <div className="text-7xl font-black text-primary mb-4">
            {unpriced.length > 0 ? '—' : `฿${sale.total}`}
          </div>
          <p className="text-2xl text-foreground/70">{t('common.toStaff')}</p>
          {sale.paymentMethod && (
            <div className="mt-6 px-5 py-2 rounded-full bg-foreground/5 border border-foreground/10 text-lg text-foreground/80">
              {t('common.payingBy', { method: paymentMethodLabel(sale.paymentMethod) })}
            </div>
          )}
        </div>
      </Shell>
    );
  }

  // thankyou
  const credits = sale.creditGrants.filter((v) => v.type === 'fnb_credit');
  const items = sale.creditGrants.filter((v) => v.type === 'item');

  return (
    <Shell customerName={displayName}>
      <div className="flex-1 flex flex-col p-8 overflow-y-auto animate-in fade-in zoom-in-95 duration-500">
        <div className="text-center mb-6">
          <div className="w-20 h-20 rounded-full bg-emerald-500/20 flex items-center justify-center text-(--cd-success) mx-auto mb-4">
            <PartyPopper className="w-10 h-10" />
          </div>
          <h2 className="text-5xl font-black">{t('till.thankyou.title')}</h2>
          <p className="text-foreground/60 text-xl mt-2">{t('till.thankyou.subtitle')}</p>
        </div>

        <div className="mx-auto w-full max-w-xl space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div className="bg-foreground/5 rounded-3xl p-6 border border-foreground/10 text-center">
              <Baby className="w-8 h-8 mx-auto text-primary mb-2" />
              <div className="text-4xl font-black">{sale.bracelets.children}</div>
              <div className="text-foreground/60">
                {t(sale.bracelets.children !== 1 ? 'till.thankyou.childBracelets' : 'till.thankyou.childBracelet')}
              </div>
            </div>
            <div className="bg-foreground/5 rounded-3xl p-6 border border-foreground/10 text-center">
              <User className="w-8 h-8 mx-auto text-(--cd-sky) mb-2" />
              <div className="text-4xl font-black">{sale.bracelets.adults}</div>
              <div className="text-foreground/60">
                {t(sale.bracelets.adults !== 1 ? 'till.thankyou.adultBracelets' : 'till.thankyou.adultBracelet')}
              </div>
            </div>
          </div>

          {credits.length > 0 && (
            <div className="space-y-3">
              <div className="flex items-center gap-2 text-foreground/70 text-lg font-semibold">
                <UtensilsCrossed className="w-5 h-5" /> {t('till.thankyou.creditGrants')}
              </div>
              {credits.map((v) => (
                <div
                  key={v.id}
                  className="flex items-center gap-4 bg-foreground/5 rounded-2xl p-4 border border-foreground/10"
                >
                  <QrCode seed={v.id} className="w-16 h-16" />
                  <div className="flex-1">
                    <div className="text-foreground/60">{v.label}</div>
                    <div className="text-3xl font-black text-primary">฿{v.valueTHB}</div>
                  </div>
                </div>
              ))}
            </div>
          )}

          {items.length > 0 && (
            <div className="space-y-3">
              <div className="flex items-center gap-2 text-foreground/70 text-lg font-semibold">
                <ShoppingBag className="w-5 h-5" /> {t('till.thankyou.itemsToCollect')}
              </div>
              {items.map((v) => (
                <div
                  key={v.id}
                  className="flex items-center gap-4 bg-foreground/5 rounded-2xl p-4 border border-foreground/10"
                >
                  <QrCode seed={v.id} className="w-16 h-16" />
                  <div className="flex-1">
                    <div className="text-foreground/60">{v.label}</div>
                    <div className="text-2xl font-black">×{v.quantity}</div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </Shell>
  );
}
