import { Fragment, useEffect, useRef, useState, type ReactNode } from 'react';
import { newId } from '@oto/shared';
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
import { useOperator } from '@/auth/OperatorContext';
import { useStation } from '@/station/StationContext';
import {
  PARTY_CHARGE_NOT_CONFIRMED,
  PARTY_PAYMENT_NOT_CONFIRMED,
  chargePartyOnPlatform,
  partyChargeConfirmationOf,
  partyChargePress,
  partyEditOf,
  partyPaymentConfirmationOf,
  partyPaymentPress,
  partyWriteBlocker,
  payPartyOnPlatform,
  updatePartyOnPlatform,
  type PartyChargeConfirmation,
  type PartyChargeLine,
  type PartyPaymentConfirmation,
  type PartyWriteIds,
  type PartyWriteOutcome,
} from '@/api/parties';
import { toast } from '@/hooks/use-toast';
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

/** S2-20 E4 — the party writes a till keeps ids for. */
type WriteKey = 'payment' | 'fnb' | 'ticket' | 'edit';

/** "a", "a and b", "a, b and c" — for naming what the OTO App keeps. */
const listOf = (items: string[]) =>
  items.length <= 1 ? (items[0] ?? '') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;

export function PartyDetail({ party: shown, surface, onBack, onChanged }: PartyDetailProps) {
  const { operator } = useOperator();
  const { station } = useStation();
  // S2-20 E4 — the party as the platform last answered a write with it, until
  // the host's re-read of the day brings the same party back.
  const [fresh, setFresh] = useState<PartyBooking | null>(null);
  useEffect(() => setFresh(null), [shown]);
  const party = fresh ?? shown;
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

  /**
   * S2-20 E4 — THE PARTY TAB IS THE PLATFORM'S. What the till can know is
   * asked before a modal opens (no settlement screen thanks a guest for a
   * payment nothing recorded): a till not linked to the platform, one with no
   * connection, and — for money — a device that is not a till.
   */
  const blockerOf = (needsStation = false) =>
    partyWriteBlocker({ branchSlug: party.branchId, stationId: station?.stationId, needsStation });
  const openUnlessBlocked = (open: () => void, needsStation = false) => {
    const blocked = blockerOf(needsStation);
    if (blocked) toast(blocked);
    else open();
  };

  /**
   * The ids of each write, minted when it is first sent and kept for a retry
   * of the same press — so a press whose answer was lost is one charge, one
   * payment, one edit. A definite answer, either way, clears them. A payment
   * names its press (amount, tender, the balance shown), and a charge its
   * order (the party, the lines, the total): another press is another write,
   * under ids of its own.
   */
  const ids = useRef<Partial<Record<WriteKey, { ids: PartyWriteIds; press: string }>>>({});
  const idsFor = (key: WriteKey, press = ''): PartyWriteIds => {
    const held = ids.current[key];
    if (held && held.press === press) return held.ids;
    const minted = { ids: { id: newId(), actionId: newId() }, press };
    ids.current[key] = minted;
    return minted.ids;
  };
  /**
   * What came of a write: true when the platform recorded it. Says why when it
   * did not — and, when nothing answered (`unconfirmed`), that it may have
   * landed and the same press confirms it, never that it did not.
   */
  const settled = (
    key: WriteKey,
    outcome: PartyWriteOutcome,
    failure: string,
    unconfirmed?: { title: string; description: string; variant?: 'destructive' },
  ) => {
    if (outcome.ok || !outcome.retryable) ids.current[key] = undefined;
    if (!outcome.ok) {
      toast(
        outcome.retryable && unconfirmed
          ? unconfirmed
          : { title: failure, description: outcome.message, variant: 'destructive' },
      );
      // The bill may have moved under the till (another till, a charge): read it again.
      onChanged();
      return false;
    }
    setFresh(outcome.party);
    onChanged();
    return true;
  };

  /**
   * "Payment received": the amount, the tender and the balance as the modal
   * froze them when staff left the bill — never the balance as it reads now,
   * so a retry of the press is the same request and a balance that moved is
   * always refused, never recorded short.
   */
  const handleTakePayment = async (
    amount: number,
    method: PartyPaymentMethod,
    shownOutstanding: number,
  ): Promise<PartyPaymentConfirmation> => {
    const blocked = blockerOf(true);
    if (!operator || blocked || !station) {
      if (blocked) toast(blocked);
      // Nothing was sent: the same press may go again.
      return { recorded: false, retry: true };
    }
    const outcome = await payPartyOnPlatform({
      party,
      amount,
      method,
      outstanding: shownOutstanding,
      stationId: station.stationId,
      ids: idsFor('payment', partyPaymentPress(amount, method, shownOutstanding)),
    });
    settled('payment', outcome, 'Payment not recorded', PARTY_PAYMENT_NOT_CONFIRMED);
    return partyPaymentConfirmationOf(outcome, amount);
  };

  /**
   * "Charge ฿… to party": the order as the modal sent it. A charge nothing
   * answered is held by its modal exactly as it was sent, and its only press
   * sends that order again — the same press, so the same ids and the same
   * request — until the platform says yes or no.
   */
  const handleChargeExtra =
    (kind: 'fnb' | 'ticket') =>
    async (items: PartyChargeLine[], chargeTotal: number): Promise<PartyChargeConfirmation> => {
      const press = partyChargePress(party.id, kind, items, chargeTotal);
      const blocked = blockerOf();
      if (!operator || blocked) {
        if (blocked) toast(blocked);
        // Nothing was sent: an order held for its answer stays held, an open one stays open.
        return { charged: false, held: ids.current[kind]?.press === press };
      }
      const outcome = await chargePartyOnPlatform({
        party,
        kind,
        items,
        total: chargeTotal,
        stationId: station?.stationId,
        ids: idsFor(kind, press),
      });
      settled(kind, outcome, 'Not charged to the party', PARTY_CHARGE_NOT_CONFIRMED);
      return partyChargeConfirmationOf(outcome);
    };

  const saving = useRef(false);
  const handleSaveEdit = async (patch: PartyEditPatch) => {
    if (!operator || saving.current) return;
    // Only what changed is sent, and only what the OTO App holds; the rest of
    // the form is the OTO App's to change, and the till says so.
    const { fields, keptInOtoApp } = partyEditOf(party, patch);
    const kept = keptInOtoApp.length > 0
      ? `${listOf(keptInOtoApp)} ${keptInOtoApp.length === 1 ? 'is' : 'are'} kept in the OTO App — change ${keptInOtoApp.length === 1 ? 'it' : 'them'} there.`
      : null;
    if (Object.keys(fields).length === 0) {
      if (kept) toast({ title: 'Not saved here', description: kept });
      else setEditing(false);
      return;
    }
    const blocked = blockerOf();
    if (blocked) {
      toast(blocked);
      return;
    }
    saving.current = true;
    try {
      const outcome = await updatePartyOnPlatform({ party, fields, stationId: station?.stationId, ids: idsFor('edit') });
      if (!settled('edit', outcome, 'Party not saved') || !outcome.ok) return;
      setEditing(false);
      const sync = outcome.answer.edit;
      if (sync?.syncState === 'failed') {
        toast({
          title: 'Saved here — the OTO App refused it',
          description: sync.syncError ?? 'Fix the cause, then retry it from Failures.',
          variant: 'destructive',
        });
      } else if (sync?.syncState === 'pending') {
        toast({
          title: 'Saved — not in the OTO App yet',
          description: `The OTO App has not confirmed this edit; it is retried from Failures.${kept ? ` ${kept}` : ''}`,
        });
      } else if (kept) {
        toast({ title: 'Saved', description: kept });
      }
    } finally {
      saving.current = false;
    }
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
            {((party.lastEditedBy && party.lastEditedAt) || party.editSync) && (
              <div className="inline-flex items-center gap-1.5 mt-2 text-xs text-muted-foreground">
                {party.lastEditedBy && party.lastEditedAt && (
                  <>
                    <Pencil className="w-3 h-3" />
                    Last edited by {party.lastEditedBy} · {fmtTimestamp(party.lastEditedAt)}
                  </>
                )}
                {/* S2-20 E4 — a till's edit the OTO App has not taken: Pending
                    waits on an answer (shown meanwhile); Refused is the app
                    saying no (not shown), retried from Failures once fixed. */}
                {party.editSync && (
                  <span
                    className={`text-[10px] font-bold uppercase tracking-wide rounded-full px-2 py-0.5 ${
                      party.editSync.state === 'failed' ? 'bg-red-500/15 text-red-400' : 'bg-amber-500/15 text-amber-400'
                    }`}
                    title={
                      party.editSync.state === 'failed'
                        ? `The OTO App refused the last edit${party.editSync.error ? ` — ${party.editSync.error}` : ''}. Fix the cause, then retry from Failures`
                        : 'The last edit is not yet confirmed by the OTO App — retried from Failures'
                    }
                  >
                    {party.editSync.state === 'failed' ? 'Refused' : 'Pending'}
                  </span>
                )}
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
              onClick={() => openUnlessBlocked(() => setEditing(true))}
            >
              <Pencil className="w-5 h-5" />
              Edit party
            </Button>
            <Button
              variant="outline"
              size="lg"
              className="gap-2 h-12"
              onClick={() => openUnlessBlocked(() => setShowTickets(true))}
            >
              <Ticket className="w-5 h-5" />
              Add tickets
            </Button>
            <Button
              variant="outline"
              size="lg"
              className="gap-2 h-12"
              onClick={() => openUnlessBlocked(() => setShowFnb(true))}
            >
              <GlassWater className="w-5 h-5" />
              Add F&amp;B to party
            </Button>
            <Button
              size="lg"
              className="gap-2 h-12"
              disabled={outstanding <= 0}
              onClick={() => openUnlessBlocked(() => setShowBalance(true), true)}
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
