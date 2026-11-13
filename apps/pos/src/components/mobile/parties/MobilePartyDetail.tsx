import type { ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { ScrollArea } from '@/components/ui/scroll-area';
import { PartyBooking } from '@/types';
import {
  computePartyOutstanding,
  partyExtraChargesTotal,
  partyLineItemsTotal,
  PARTY_STATUS_LABELS,
} from '@/lib/party';
import {
  partyBillShown,
  partyBillUnpriced,
  plannedQuoteOf,
  usePlannedSettleQuote,
} from '@/lib/partySettlementBill';
import { paymentMethodLabel, paymentMethodIcon, paymentMethodKind } from '@/lib/payments';
import { withPartyKitchen } from '@/api/events';
import { usePartyPlanReadState } from '@/hooks/usePartyPlanRead';
import { partyCakeLabel } from '@/lib/partyKitchen';
import {
  ArrowLeft,
  CheckCircle2,
  Wallet,
  GlassWater,
  CalendarDays,
  Clock,
  MapPin,
  Users,
  Cake,
  UtensilsCrossed,
  Phone,
  ListChecks,
  Sparkles,
  Mic2,
  ReceiptText,
  Ticket,
  ChevronRight,
} from 'lucide-react';
import { bahtText, satangText } from '@/lib/bahtText';

const STATUS_STYLE: Record<PartyBooking['status'], string> = {
  upcoming: 'bg-sky-500/15 text-sky-400',
  in_progress: 'bg-emerald-500/15 text-emerald-400',
  completed: 'bg-muted text-muted-foreground',
  cancelled: 'bg-destructive/15 text-destructive',
};

const fmtDate = (iso: string) =>
  new Date(iso + 'T00:00:00').toLocaleDateString('en-GB', {
    weekday: 'short',
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  });

const fmtTimestamp = (iso: string) =>
  new Date(iso).toLocaleString('en-GB', {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });

function SectionCard({
  icon: Icon,
  title,
  children,
}: {
  icon: typeof Wallet;
  title: string;
  children: ReactNode;
}) {
  return (
    <Card className="p-4 bg-card/50">
      <div className="flex items-center gap-2 mb-3 font-bold text-sm">
        <Icon className="w-4 h-4 text-primary" />
        {title}
      </div>
      {children}
    </Card>
  );
}

function InfoRow({
  icon: Icon,
  label,
  value,
}: {
  icon?: typeof Wallet;
  label: string;
  value: ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-4 py-1">
      <span className="flex items-center gap-1.5 text-muted-foreground text-xs shrink-0">
        {Icon && <Icon className="w-3.5 h-3.5" />}
        {label}
      </span>
      <span className="text-right font-medium text-xs">{value}</span>
    </div>
  );
}

interface MobilePartyDetailProps {
  party: PartyBooking;
  /** SCRUM-936 — the till the Settle party preview is asked from, as on the counter's page. */
  stationId?: string | null;
  onBack: () => void;
  onTakePayment: () => void;
  onAddFnb: () => void;
}

export function MobilePartyDetail({
  party: given,
  stationId = null,
  onBack,
  onTakePayment,
  onAddFnb,
}: MobilePartyDetailProps) {
  // SCRUM-906 — the party's kitchen plan, read on opening, on focus and every minute while open,
  // laid over the party in the page's own words (every line, the cake, the bar).
  // SCRUM-936 — the same read prices the bill: undefined until it answers.
  const planRead = usePartyPlanReadState(given);
  const kitchenPlan = planRead?.kitchenPlan ?? planRead?.plan ?? null;
  const party = withPartyKitchen(given, kitchenPlan);
  // SCRUM-936 — a party not settled yet owes its package: the platform's price
  // of Settle party on the plan's counts, as the counter's page reads it.
  const plannedQuote = usePlannedSettleQuote(given, planRead, stationId);
  // A party the platform settles on its tab (walk-ups, money taken there)
  // reads the tab's bill, and is taken on the tab here.
  const planned = plannedQuoteOf(party, plannedQuote);
  // Its package owed but not priced yet: a dash, never "Fully paid".
  const unpriced = partyBillUnpriced(party, plannedQuote);
  // The tab's own balance: what Take payment takes on this phone.
  const outstanding = computePartyOutstanding(party);
  const extras = partyExtraChargesTotal(party);
  const lineItemsTotal = partyLineItemsTotal(party);
  // SCRUM-916 — the bill as shown, as on the counter's party page: an open
  // settlement's own total, deposit and balance, never "Fully paid" while it
  // is owed. Its balance is taken by resuming it on a counter till.
  // SCRUM-936 — before a settlement, the package the plan owes, as the
  // counter's page shows it; settled on a counter till.
  const bill = partyBillShown(party, planned);
  const settlementOpen = party.settlement?.state === 'open';
  const cake = party.kitchen.cake;
  const cakeLabel = partyCakeLabel(cake);

  return (
    <div className="h-full flex flex-col overflow-hidden">
      {/* Compact header */}
      <div className="shrink-0 px-4 pt-3 pb-3 border-b">
        <button
          type="button"
          onClick={onBack}
          className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors mb-2"
        >
          <ArrowLeft className="w-3.5 h-3.5" />
          All parties
        </button>
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 flex-wrap">
              <h2 className="text-lg font-black tracking-tight leading-tight">{party.title}</h2>
              <span
                className={`text-[9px] font-bold uppercase tracking-wide rounded-full px-2 py-0.5 ${STATUS_STYLE[party.status]}`}
              >
                {PARTY_STATUS_LABELS[party.status]}
              </span>
            </div>
            <p className="text-xs text-muted-foreground mt-0.5">
              {party.childName}
              {party.kidAge ? ` · ${party.kidAge} yrs` : ''} · {party.startTime}–{party.endTime} ·{' '}
              {party.location}
            </p>
          </div>
          {/* Outstanding badge */}
          <div className="shrink-0 text-right">
            {unpriced ? (
              <>
                <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Due</div>
                <div className="text-xl font-black tabular-nums text-muted-foreground">—</div>
              </>
            ) : bill.outstanding > 0 ? (
              <>
                <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Due</div>
                <div className="text-xl font-black tabular-nums text-amber-400">฿{bahtText(bill.outstanding)}</div>
              </>
            ) : (
              <div className="text-sm font-bold text-emerald-400">Fully paid</div>
            )}
          </div>
        </div>
      </div>

      {/* Scrollable body */}
      <ScrollArea className="flex-1">
        <div className="p-4 space-y-3 pb-2">
          {/* Bill */}
          <SectionCard icon={ReceiptText} title="Party bill">
            <div className="text-xs">
              {settlementOpen ? (
                <InfoRow icon={CheckCircle2} label="Settlement open" value={`฿${bahtText(bill.settlementOwed)} to take`} />
              ) : (
                <>
                  <InfoRow
                    // SCRUM-953 — the package the plan names, as the counter's page reads it.
                    label={planRead?.plan?.package.name ?? party.packageName ?? 'Base package'}
                    value={unpriced ? '—' : planned ? `฿${satangText(planned.packageSatang)}` : `฿${bahtText(party.basePrice)}`}
                  />
                  {planned && planned.totalSatang > planned.packageSatang && (
                    <InfoRow label="Add-ons and extras" value={`฿${satangText(planned.totalSatang - planned.packageSatang)}`} />
                  )}
                </>
              )}
              {party.lineItems.map((li) => (
                <InfoRow
                  key={li.id}
                  label={`${li.name}${li.qty ? ` ×${li.qty}` : ''}`}
                  value={`฿${bahtText(li.qty * li.price)}`}
                />
              ))}
              {party.lineItems.length > 0 && (
                <div className="flex items-center justify-between py-1 text-muted-foreground border-t mt-1 pt-1.5">
                  <span>Add-ons subtotal</span>
                  <span className="tabular-nums">฿{bahtText(lineItemsTotal)}</span>
                </div>
              )}
              {party.partyExtraCharges.length > 0 && (
                <InfoRow icon={ReceiptText} label="Extra charges" value={`+฿${bahtText(extras)}`} />
              )}
              <div className="flex items-center justify-between py-1 font-semibold border-t mt-1 pt-1.5">
                <span>Total</span>
                <span className="tabular-nums">{unpriced ? '—' : `฿${bahtText(bill.total)}`}</span>
              </div>
              <InfoRow label="Deposit paid" value={`−฿${bahtText(bill.deposit)}`} />
              {bill.paid > 0 && <InfoRow label="Payments taken" value={`−฿${bahtText(bill.paid)}`} />}
              <div className="flex items-center justify-between mt-1.5 pt-2 border-t">
                <span className="font-bold">Outstanding</span>
                <span
                  className={`text-2xl font-black tabular-nums ${
                    unpriced ? 'text-muted-foreground' : bill.outstanding > 0 ? 'text-amber-400' : 'text-emerald-400'
                  }`}
                >
                  {unpriced ? '—' : `฿${bahtText(bill.outstanding)}`}
                </span>
              </div>
              {unpriced?.note && <p className="text-muted-foreground mt-1.5">{unpriced.note}</p>}
            </div>
          </SectionCard>

          {/* Event info */}
          <SectionCard icon={Sparkles} title="Event info">
            <div className="text-xs">
              <InfoRow icon={CalendarDays} label="Date" value={fmtDate(party.date)} />
              <InfoRow icon={Clock} label="Time" value={`${party.startTime} – ${party.endTime}`} />
              <InfoRow icon={MapPin} label="Room" value={party.location} />
              <InfoRow
                icon={Users}
                label="Headcount"
                value={`${party.expectedKids} kids · ${party.expectedAdults} adults`}
              />
              {party.decoration && <InfoRow label="Decoration" value={party.decoration} />}
              {party.activities && <InfoRow label="Activities" value={party.activities} />}
              {(party.partyHost || party.entertainmentHost) && (
                <div className="border-t mt-1 pt-1.5">
                  {party.partyHost && (
                    <InfoRow icon={Mic2} label="Party host" value={party.partyHost} />
                  )}
                  {party.entertainmentHost && (
                    <InfoRow icon={Mic2} label="Entertainment" value={party.entertainmentHost} />
                  )}
                </div>
              )}
            </div>
          </SectionCard>

          {/* Contact */}
          <SectionCard icon={Phone} title="Parent contact">
            <div className="text-xs">
              <InfoRow label="Parent" value={party.parentName} />
              {party.whatsapp && <InfoRow icon={Phone} label="WhatsApp" value={party.whatsapp} />}
              {party.rsvp && (
                <div className="border-t mt-1 pt-1.5">
                  <InfoRow
                    icon={ListChecks}
                    label="RSVP"
                    value={`${party.rsvp.attending} yes · ${party.rsvp.maybe} maybe · ${party.rsvp.declined} no`}
                  />
                  <InfoRow
                    label="RSVP headcount"
                    value={`${party.rsvp.totalKids}k · ${party.rsvp.totalAdults}a`}
                  />
                </div>
              )}
              {party.posNotes && (
                <div className="mt-2 rounded-lg bg-muted p-2.5 text-muted-foreground">
                  {party.posNotes}
                </div>
              )}
            </div>
          </SectionCard>

          {/* Kitchen */}
          <SectionCard icon={UtensilsCrossed} title="Kitchen plan">
            {party.kitchen.needed ? (
              <div className="text-xs space-y-0.5">
                {party.kitchen.serviceTime && (
                  <InfoRow icon={Clock} label="Food service" value={party.kitchen.serviceTime} />
                )}
                {party.kitchen.setMenu != null && (
                  <InfoRow
                    label="Menu type"
                    value={party.kitchen.setMenu ? 'Set menu' : 'À la carte'}
                  />
                )}
                {party.kitchen.kidsMenu.length > 0 && (
                  <InfoRow label="Kids menu" value={party.kitchen.kidsMenu.join(', ')} />
                )}
                {party.kitchen.adultsMenu.length > 0 && (
                  <InfoRow label="Adults menu" value={party.kitchen.adultsMenu.join(', ')} />
                )}
                {party.kitchen.foodItems.length > 0 && (
                  <div className="border-t mt-1.5 pt-1.5 space-y-0.5">
                    {party.kitchen.foodItems.map((f) => (
                      // A choice split over several dishes carries no count of its own (SCRUM-906).
                      <InfoRow key={f.id} label={f.name} value={f.qty ? `×${f.qty}` : ''} />
                    ))}
                  </div>
                )}
                {/* SCRUM-906: the cake as the BEO says it; nothing when the BEO says no cake. */}
                {(cake.type !== 'none' || !kitchenPlan) && (
                <div className="mt-2 rounded-lg bg-primary/10 p-2.5 flex items-start gap-2">
                  <Cake className="w-4 h-4 text-primary shrink-0 mt-px" />
                  <div className="min-w-0">
                    <div className="font-semibold text-xs">
                      {cakeLabel}
                      {cake.time ? ` · ${cake.time}` : ''}
                    </div>
                    {cake.note && (
                      <div className="text-[11px] text-muted-foreground">{cake.note}</div>
                    )}
                  </div>
                </div>
                )}
              </div>
            ) : planRead === undefined ? null : (
              // SCRUM-953 — not said while the plan is still being read: it may bring one.
              <p className="text-xs text-muted-foreground">No kitchen service for this party.</p>
            )}
          </SectionCard>

          {/* Bar */}
          {party.bar && (
            <SectionCard icon={GlassWater} title="Bar plan">
              <div className="text-xs">
                {party.bar.serviceTime && (
                  <InfoRow icon={Clock} label="Bar service" value={party.bar.serviceTime} />
                )}
                {party.bar.items?.map((b) => (
                  <InfoRow key={b.id} label={b.name} value={`×${b.qty}`} />
                ))}
              </div>
            </SectionCard>
          )}

          {/* Timeline */}
          {party.timeline.length > 0 && (
            <SectionCard icon={Clock} title="Run of show">
              <div className="space-y-1.5">
                {party.timeline.map((t, i) => {
                  const highlight = /food|cake/i.test(t.label);
                  return (
                    <div
                      key={i}
                      className={`flex items-center gap-2 rounded-lg px-2.5 py-1.5 ${
                        highlight ? 'bg-primary/10' : 'bg-muted/40'
                      }`}
                    >
                      <span className="font-mono font-bold tabular-nums w-12 shrink-0 text-xs">
                        {t.time}
                      </span>
                      <span className={`flex-1 text-xs ${highlight ? 'font-semibold' : ''}`}>
                        {t.label}
                      </span>
                      {highlight && <Cake className="w-3.5 h-3.5 text-primary shrink-0" />}
                    </div>
                  );
                })}
              </div>
            </SectionCard>
          )}

          {/* POS activity */}
          {(party.partyExtraCharges.length > 0 || party.partyPayments.length > 0) && (
            <SectionCard icon={ReceiptText} title="POS activity">
              <div className="space-y-2 text-xs">
                {party.partyExtraCharges.map((c) => (
                  <div key={c.id} className="rounded-lg border bg-background p-2.5">
                    <div className="flex items-center justify-between font-semibold">
                      <span className="flex items-center gap-1.5">
                        {c.kind === 'ticket' ? (
                          <Ticket className="w-3.5 h-3.5 text-primary" />
                        ) : (
                          <GlassWater className="w-3.5 h-3.5 text-primary" />
                        )}
                        {c.kind === 'ticket' ? 'Extra tickets' : 'Extra F&B'}
                      </span>
                      <span className="tabular-nums">+฿{bahtText(c.total)}</span>
                    </div>
                    <div className="text-muted-foreground mt-1">
                      {c.items.map((it) => `${it.qty}× ${it.name}`).join(', ')}
                    </div>
                    <div className="text-muted-foreground mt-0.5">
                      {c.chargedBy} · {fmtTimestamp(c.chargedAt)}
                    </div>
                  </div>
                ))}
                {party.partyPayments.map((p) => {
                  const Icon = paymentMethodIcon(paymentMethodKind(p.method));
                  return (
                    <div key={p.id} className="rounded-lg border bg-background p-2.5">
                      <div className="flex items-center justify-between font-semibold">
                        <span className="flex items-center gap-1.5">
                          <Icon className="w-3.5 h-3.5 text-emerald-400" />
                          Payment · {paymentMethodLabel(p.method)}
                        </span>
                        <span className="tabular-nums text-emerald-400">−฿{bahtText(p.amount)}</span>
                      </div>
                      <div className="text-muted-foreground mt-0.5">
                        {p.takenBy} · {fmtTimestamp(p.takenAt)}
                      </div>
                    </div>
                  );
                })}
              </div>
            </SectionCard>
          )}
        </div>
      </ScrollArea>

      {/* Action bar */}
      <div className="shrink-0 border-t p-4 space-y-2">
        <Button
          variant="outline"
          className="w-full h-12 gap-2 font-semibold"
          onClick={onAddFnb}
        >
          <GlassWater className="w-4 h-4" />
          Add F&amp;B to party tab
          <ChevronRight className="w-4 h-4 ml-auto" />
        </Button>
        <Button
          className="w-full h-14 text-lg font-bold gap-2"
          disabled={unpriced !== null || outstanding <= 0}
          onClick={onTakePayment}
        >
          <Wallet className="w-5 h-5" />
          {unpriced
            ? 'Take payment · —'
            : outstanding > 0
            ? `Take payment · ฿${bahtText(outstanding)}`
            : bill.settlementOwed > 0
              ? `${settlementOpen ? 'Settlement open' : 'Not settled'} · ฿${bahtText(bill.settlementOwed)}`
              : 'Fully paid'}
        </Button>
        {!unpriced && outstanding <= 0 && bill.settlementOwed > 0 && (
          <p className="text-xs text-muted-foreground text-center">
            {settlementOpen
              ? "Take it with Resume settlement on a counter till's party page."
              : "Take it with Settle party on a counter till's party page."}
          </p>
        )}
      </div>
    </div>
  );
}
