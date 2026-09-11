import { Fragment, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { ScrollArea } from '@/components/ui/scroll-area';
import { PartyBooking } from '@/types';
import {
  computePartyTotal,
  computePartyOutstanding,
  partyExtraChargesTotal,
  partyPaymentsTotal,
  partyLineItemsTotal,
  PARTY_STATUS_LABELS,
} from '@/lib/party';
import { paymentMethodLabel, paymentMethodIcon, paymentMethodKind } from '@/lib/payments';
import {
  ArrowLeft,
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
  onBack: () => void;
  onTakePayment: () => void;
  onAddFnb: () => void;
}

export function MobilePartyDetail({
  party,
  onBack,
  onTakePayment,
  onAddFnb,
}: MobilePartyDetailProps) {
  const total = computePartyTotal(party);
  const outstanding = computePartyOutstanding(party);
  const extras = partyExtraChargesTotal(party);
  const paid = partyPaymentsTotal(party);
  const lineItemsTotal = partyLineItemsTotal(party);
  const cake = party.kitchen.cake;
  const cakeLabel =
    cake.type === 'none'
      ? 'No cake'
      : cake.type === 'own'
        ? 'Customer brings their own'
        : `Our cake${cake.qty ? ` ×${cake.qty}` : ''}`;

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
            {outstanding > 0 ? (
              <>
                <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Due</div>
                <div className="text-xl font-black tabular-nums text-amber-400">฿{outstanding}</div>
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
              <InfoRow label={party.packageName ?? 'Base package'} value={`฿${party.basePrice}`} />
              {party.lineItems.map((li) => (
                <InfoRow
                  key={li.id}
                  label={`${li.name}${li.qty ? ` ×${li.qty}` : ''}`}
                  value={`฿${li.qty * li.price}`}
                />
              ))}
              {party.lineItems.length > 0 && (
                <div className="flex items-center justify-between py-1 text-muted-foreground border-t mt-1 pt-1.5">
                  <span>Add-ons subtotal</span>
                  <span className="tabular-nums">฿{lineItemsTotal}</span>
                </div>
              )}
              {party.partyExtraCharges.length > 0 && (
                <InfoRow icon={ReceiptText} label="Extra charges" value={`+฿${extras}`} />
              )}
              <div className="flex items-center justify-between py-1 font-semibold border-t mt-1 pt-1.5">
                <span>Total</span>
                <span className="tabular-nums">฿{total}</span>
              </div>
              <InfoRow label="Deposit paid" value={`−฿${party.deposit}`} />
              {paid > 0 && <InfoRow label="Payments taken" value={`−฿${paid}`} />}
              <div className="flex items-center justify-between mt-1.5 pt-2 border-t">
                <span className="font-bold">Outstanding</span>
                <span
                  className={`text-2xl font-black tabular-nums ${
                    outstanding > 0 ? 'text-amber-400' : 'text-emerald-400'
                  }`}
                >
                  ฿{outstanding}
                </span>
              </div>
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
                      <InfoRow key={f.id} label={f.name} value={`×${f.qty}`} />
                    ))}
                  </div>
                )}
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
              </div>
            ) : (
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
                      <span className="tabular-nums">+฿{c.total}</span>
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
                        <span className="tabular-nums text-emerald-400">−฿{p.amount}</span>
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
          disabled={outstanding <= 0}
          onClick={onTakePayment}
        >
          <Wallet className="w-5 h-5" />
          {outstanding > 0 ? `Take payment · ฿${outstanding}` : 'Fully paid'}
        </Button>
      </div>
    </div>
  );
}
