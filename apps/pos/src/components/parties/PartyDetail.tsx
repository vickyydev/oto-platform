import { Fragment, useState, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { ScrollArea } from '@/components/ui/scroll-area';
import { PartyBooking, PartyPaymentMethod } from '@/types';
import {
  computePartyTotal,
  computePartyOutstanding,
  partyExtraChargesTotal,
  partyPaymentsTotal,
  partyLineItemsTotal,
  PARTY_STATUS_LABELS,
} from '@/lib/party';
import { addPartyExtraCharge, addPartyPayment, updateParty } from '@/mockApi';
import { useOperator } from '@/auth/OperatorContext';
import { PartyBalanceModal } from './PartyBalanceModal';
import { PartyFnbModal } from './PartyFnbModal';
import { PartyTicketModal } from './PartyTicketModal';
import { PartyEditForm, type PartyEditPatch } from './PartyEditForm';
import { MessagingPanel, type MessagingContext } from '@/components/shared/MessagingPanel';
import {
  ArrowLeft,
  Pencil,
  Wallet,
  GlassWater,
  Ticket,
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
  MessageCircle,
} from 'lucide-react';
import { paymentMethodLabel, paymentMethodIcon, paymentMethodKind } from '@/lib/payments';

interface PartyDetailProps {
  party: PartyBooking;
  surface: 'till' | 'fnb';
  onBack: () => void;
  onChanged: () => void;
}

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
    <Card className="p-5 bg-card/50">
      <div className="flex items-center gap-2 mb-4 font-bold">
        <Icon className="w-5 h-5 text-primary" />
        {title}
      </div>
      {children}
    </Card>
  );
}

function InfoRow({ icon: Icon, label, value }: { icon?: typeof Wallet; label: string; value: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 py-1.5">
      <span className="flex items-center gap-2 text-muted-foreground shrink-0">
        {Icon && <Icon className="w-4 h-4" />}
        {label}
      </span>
      <span className="text-right font-medium">{value}</span>
    </div>
  );
}

export function PartyDetail({ party, surface, onBack, onChanged }: PartyDetailProps) {
  const { operator } = useOperator();
  const [showBalance, setShowBalance] = useState(false);
  const [showFnb, setShowFnb] = useState(false);
  const [showTickets, setShowTickets] = useState(false);
  const [showMessage, setShowMessage] = useState(false);
  const [editing, setEditing] = useState(false);

  // Message the parent in-app with party context so the party templates
  // ({parentName}, {time}=party start time) resolve correctly.
  const messageCtx: MessagingContext | null = party.whatsapp
    ? {
        parentName: party.parentName,
        phone: party.whatsapp,
        childName: party.childName,
        time: party.startTime,
        // Parties don't yet carry a channel preference; default to whatsapp.
        channel: 'whatsapp',
      }
    : null;

  const total = computePartyTotal(party);
  const outstanding = computePartyOutstanding(party);
  const extras = partyExtraChargesTotal(party);
  const paid = partyPaymentsTotal(party);
  const lineItemsTotal = partyLineItemsTotal(party);

  const handleTakePayment = (amount: number, method: PartyPaymentMethod) => {
    if (!operator) return;
    addPartyPayment(party.id, {
      amount,
      method,
      takenBy: operator.name,
      takenById: operator.id,
    });
    onChanged();
  };

  const handleChargeExtra =
    (kind: 'fnb' | 'ticket') =>
    (items: { name: string; qty: number; lineTotal: number }[], chargeTotal: number) => {
      if (!operator) return;
      addPartyExtraCharge(party.id, {
        kind,
        items,
        total: chargeTotal,
        chargedBy: operator.name,
        chargedById: operator.id,
      });
      onChanged();
    };

  const handleSaveEdit = (patch: PartyEditPatch) => {
    if (!operator) return;
    updateParty(party.id, patch, { editedBy: operator.name, editedById: operator.id });
    setEditing(false);
    onChanged();
  };

  const cake = party.kitchen.cake;
  const cakeLabel =
    cake.type === 'none'
      ? 'No cake'
      : cake.type === 'own'
        ? 'Customer brings their own'
        : `Our cake${cake.qty ? ` ×${cake.qty}` : ''}`;

  const billSection = (
    <SectionCard icon={ReceiptText} title="Party bill">
      <div className="text-sm">
        <InfoRow label={party.packageName ?? 'Base package'} value={`฿${party.basePrice}`} />
        {party.lineItems.map((li) => (
          <InfoRow
            key={li.id}
            label={`${li.name}${li.qty ? ` ×${li.qty}` : ''}`}
            value={`฿${li.qty * li.price}`}
          />
        ))}
        {party.lineItems.length > 0 && (
          <div className="flex items-center justify-between py-1.5 text-muted-foreground border-t mt-1 pt-2">
            <span>Add-ons subtotal</span>
            <span className="tabular-nums">฿{lineItemsTotal}</span>
          </div>
        )}
        {party.partyExtraCharges.length > 0 && (
          <InfoRow icon={ReceiptText} label="Extra charges" value={`+฿${extras}`} />
        )}
        <div className="flex items-center justify-between py-1.5 font-semibold border-t mt-1 pt-2">
          <span>Total</span>
          <span className="tabular-nums">฿{total}</span>
        </div>
        <InfoRow label="Deposit paid" value={`−฿${party.deposit}`} />
        {paid > 0 && <InfoRow label="Payments taken" value={`−฿${paid}`} />}
        <div className="flex items-center justify-between mt-2 pt-3 border-t">
          <span className="font-bold">Outstanding</span>
          <span
            className={`text-3xl font-black tabular-nums ${
              outstanding > 0 ? 'text-amber-400' : 'text-emerald-400'
            }`}
          >
            ฿{outstanding}
          </span>
        </div>
      </div>
    </SectionCard>
  );

  const eventSection = (
    <SectionCard icon={Sparkles} title="Event info">
      <div className="text-sm">
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
          <div className="border-t mt-2 pt-2">
            {party.partyHost && <InfoRow icon={Mic2} label="Party host" value={party.partyHost} />}
            {party.entertainmentHost && (
              <InfoRow icon={Mic2} label="Entertainment" value={party.entertainmentHost} />
            )}
          </div>
        )}
      </div>
    </SectionCard>
  );

  const contactSection = (
    <SectionCard icon={Phone} title="Parent contact">
      <div className="text-sm">
        <InfoRow label="Parent" value={party.parentName} />
        {party.whatsapp && <InfoRow icon={Phone} label="WhatsApp" value={party.whatsapp} />}
        {party.rsvp && (
          <div className="border-t mt-2 pt-2">
            <InfoRow
              icon={ListChecks}
              label="RSVP"
              value={`${party.rsvp.attending} attending · ${party.rsvp.maybe} maybe · ${party.rsvp.declined} declined`}
            />
            <InfoRow
              label="RSVP headcount"
              value={`${party.rsvp.totalKids} kids · ${party.rsvp.totalAdults} adults`}
            />
          </div>
        )}
        {party.posNotes && (
          <div className="mt-3 rounded-lg bg-muted p-3 text-muted-foreground">{party.posNotes}</div>
        )}
        {party.finalMessage && (
          <div className="mt-2 rounded-lg bg-amber-500/10 text-amber-300 p-3 text-xs">
            <span className="font-semibold">Staff note: </span>
            {party.finalMessage}
          </div>
        )}
      </div>
    </SectionCard>
  );

  const kitchenSection = (
    <SectionCard icon={UtensilsCrossed} title="Kitchen plan">
      {party.kitchen.needed ? (
        <div className="text-sm space-y-1">
          {party.kitchen.serviceTime && (
            <InfoRow icon={Clock} label="Food service" value={party.kitchen.serviceTime} />
          )}
          {party.kitchen.setMenu != null && (
            <InfoRow label="Menu type" value={party.kitchen.setMenu ? 'Set menu' : 'À la carte'} />
          )}
          {party.kitchen.kidsMenu.length > 0 && (
            <InfoRow label="Kids menu" value={party.kitchen.kidsMenu.join(', ')} />
          )}
          {party.kitchen.adultsMenu.length > 0 && (
            <InfoRow label="Adults menu" value={party.kitchen.adultsMenu.join(', ')} />
          )}
          {party.kitchen.foodItems.length > 0 && (
            <div className="border-t mt-2 pt-2 space-y-1">
              {party.kitchen.foodItems.map((f) => (
                <InfoRow key={f.id} label={f.name} value={`×${f.qty}`} />
              ))}
            </div>
          )}
          <div className="mt-3 rounded-lg bg-primary/10 p-3 flex items-start gap-2">
            <Cake className="w-5 h-5 text-primary shrink-0 mt-0.5" />
            <div className="min-w-0">
              <div className="font-semibold">
                {cakeLabel}
                {cake.time ? ` · ${cake.time}` : ''}
              </div>
              {cake.note && <div className="text-xs text-muted-foreground">{cake.note}</div>}
            </div>
          </div>
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">No kitchen service for this party.</p>
      )}
    </SectionCard>
  );

  const barSection = party.bar && (
    <SectionCard icon={GlassWater} title="Bar plan">
      <div className="text-sm">
        {party.bar.serviceTime && (
          <InfoRow icon={Clock} label="Bar service" value={party.bar.serviceTime} />
        )}
        {party.bar.items?.map((b) => <InfoRow key={b.id} label={b.name} value={`×${b.qty}`} />)}
      </div>
    </SectionCard>
  );

  const timelineSection = (
    <SectionCard icon={Clock} title="Run of show">
      <div className="space-y-2">
        {party.timeline.map((t, i) => {
          const highlight = /food|cake/i.test(t.label);
          return (
            <div
              key={i}
              className={`flex items-center gap-3 rounded-lg px-3 py-2 ${
                highlight ? 'bg-primary/10' : 'bg-muted/40'
              }`}
            >
              <span className="font-mono font-bold tabular-nums w-14 shrink-0">{t.time}</span>
              <span className={`flex-1 ${highlight ? 'font-semibold' : ''}`}>{t.label}</span>
              {highlight && <Cake className="w-4 h-4 text-primary shrink-0" />}
            </div>
          );
        })}
      </div>
    </SectionCard>
  );

  const activitySection = (party.partyExtraCharges.length > 0 || party.partyPayments.length > 0) && (
    <SectionCard icon={ReceiptText} title="POS activity">
      <div className="space-y-2 text-sm">
        {party.partyExtraCharges.map((c) => (
          <div key={c.id} className="rounded-lg border bg-background p-3">
            <div className="flex items-center justify-between font-semibold">
              <span className="flex items-center gap-2">
                {c.kind === 'ticket' ? (
                  <Ticket className="w-4 h-4 text-primary" />
                ) : (
                  <GlassWater className="w-4 h-4 text-primary" />
                )}
                {c.kind === 'ticket' ? 'Extra tickets' : 'Extra F&B'}
              </span>
              <span className="tabular-nums">+฿{c.total}</span>
            </div>
            <div className="text-xs text-muted-foreground mt-1">
              {c.items.map((it) => `${it.qty}× ${it.name}`).join(', ')}
            </div>
            <div className="text-xs text-muted-foreground mt-0.5">
              {c.chargedBy} · {fmtTimestamp(c.chargedAt)}
            </div>
          </div>
        ))}
        {party.partyPayments.map((p) => {
          const Icon = paymentMethodIcon(paymentMethodKind(p.method));
          return (
            <div key={p.id} className="rounded-lg border bg-background p-3">
              <div className="flex items-center justify-between font-semibold">
                <span className="flex items-center gap-2">
                  <Icon className="w-4 h-4 text-emerald-400" />
                  Payment · {paymentMethodLabel(p.method)}
                </span>
                <span className="tabular-nums text-emerald-400">−฿{p.amount}</span>
              </div>
              <div className="text-xs text-muted-foreground mt-1">
                {p.takenBy} · {fmtTimestamp(p.takenAt)}
              </div>
            </div>
          );
        })}
      </div>
    </SectionCard>
  );

  // F&B surface leads with kitchen/bar/timeline; reception leads with bill/contact.
  const leftColumn =
    surface === 'fnb'
      ? [kitchenSection, barSection, timelineSection]
      : [billSection, eventSection, contactSection];
  const rightColumn =
    surface === 'fnb'
      ? [eventSection, billSection, contactSection, activitySection]
      : [kitchenSection, timelineSection, barSection, activitySection];

  if (editing) {
    return <PartyEditForm party={party} onSave={handleSaveEdit} onCancel={() => setEditing(false)} />;
  }

  return (
    <div className="h-full flex flex-col min-h-0">
      {/* Header */}
      <div className="shrink-0 mb-4">
        <button
          type="button"
          onClick={onBack}
          className="flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground transition-colors mb-3"
        >
          <ArrowLeft className="w-4 h-4" />
          All parties
        </button>
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div className="min-w-0">
            <div className="flex items-center gap-3 flex-wrap">
              <h2 className="text-2xl font-black tracking-tight">{party.title}</h2>
              <span
                className={`text-xs font-bold uppercase tracking-wide rounded-full px-2.5 py-1 ${STATUS_STYLE[party.status]}`}
              >
                {PARTY_STATUS_LABELS[party.status]}
              </span>
            </div>
            <p className="text-muted-foreground mt-1">
              {party.childName}
              {party.kidAge ? ` · turning ${party.kidAge}` : ''} · {party.startTime}–{party.endTime} ·{' '}
              {party.location}
            </p>
            {party.lastEditedBy && party.lastEditedAt && (
              <div className="inline-flex items-center gap-1.5 mt-2 text-xs text-muted-foreground">
                <Pencil className="w-3 h-3" />
                Last edited by {party.lastEditedBy} · {fmtTimestamp(party.lastEditedAt)}
              </div>
            )}
          </div>
          <div className="flex items-center gap-3 shrink-0">
            {messageCtx && (
              <Button
                variant="outline"
                size="lg"
                className="gap-2 h-12"
                onClick={() => setShowMessage(true)}
              >
                <MessageCircle className="w-5 h-5" />
                Message parent
              </Button>
            )}
            <Button
              variant="outline"
              size="lg"
              className="gap-2 h-12"
              onClick={() => setEditing(true)}
            >
              <Pencil className="w-5 h-5" />
              Edit party
            </Button>
            <Button
              variant="outline"
              size="lg"
              className="gap-2 h-12"
              onClick={() => setShowTickets(true)}
            >
              <Ticket className="w-5 h-5" />
              Add tickets
            </Button>
            <Button
              variant="outline"
              size="lg"
              className="gap-2 h-12"
              onClick={() => setShowFnb(true)}
            >
              <GlassWater className="w-5 h-5" />
              Add F&amp;B to party
            </Button>
            <Button
              size="lg"
              className="gap-2 h-12"
              disabled={outstanding <= 0}
              onClick={() => setShowBalance(true)}
            >
              <Wallet className="w-5 h-5" />
              {outstanding > 0 ? `Take balance ฿${outstanding}` : 'Fully paid'}
            </Button>
          </div>
        </div>
      </div>

      {/* Body */}
      <ScrollArea className="flex-1 -mx-1 px-1">
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 pb-2">
          <div className="space-y-4">
            {leftColumn.map((node, i) => (
              <Fragment key={i}>{node}</Fragment>
            ))}
          </div>
          <div className="space-y-4">
            {rightColumn.map((node, i) => (
              <Fragment key={i}>{node}</Fragment>
            ))}
          </div>
        </div>
      </ScrollArea>

      <PartyBalanceModal
        open={showBalance}
        onOpenChange={setShowBalance}
        party={party}
        operatorName={operator?.name ?? ''}
        onConfirm={handleTakePayment}
      />
      <PartyFnbModal
        open={showFnb}
        onOpenChange={setShowFnb}
        party={party}
        operatorName={operator?.name ?? ''}
        onCharge={handleChargeExtra('fnb')}
      />
      <PartyTicketModal
        open={showTickets}
        onOpenChange={setShowTickets}
        party={party}
        operatorName={operator?.name ?? ''}
        onCharge={handleChargeExtra('ticket')}
      />
      <MessagingPanel
        open={showMessage}
        onOpenChange={setShowMessage}
        context={messageCtx}
        category="party"
      />
    </div>
  );
}
