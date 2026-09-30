import { useMemo, useState } from 'react';
import { AddOn, CartLine, CustomerTier, TicketType } from '@/types';
import { getTicketTypes, getAddOns, checkNannyAvailability } from '@/mockApi';
import { tierLabel, isDefaultTier } from '@/lib/membership';
import { computeLineTotal, computeLineBreakdown, priceForTier, type LineBreakdownKind } from '@/lib/pricing';
import { resolveRateToday, todayRateMode } from '@/lib/pricingMode';
import { dropOffServiceFee, type DropOffPricing as ResolvedDropOffPricing } from '@/lib/dropoff';
import { resolveRequirement } from '@/lib/supervision';
import { parseAge, slotAge, type SupervisedSlot } from '@/components/till/SupervisionGate';
import { ChildDobPicker } from '@/components/shared/ChildDobPicker';
import { TicketCard } from '@/components/till/TicketCard';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { StepRow, AddOnToggles, VisitDateRow } from '@/components/book/BookExtras';
import { EventPassSection, type PassSelection } from '@/components/book/BookEventPasses';
import { useLanguage } from '@/i18n/LanguageContext';
import { resolveName } from '@/i18n/resolveTranslation';
import type { OtoEvent } from '@/types';
import {
  ArrowLeft,
  ArrowRight,
  Baby,
  User,
  Footprints,
  Trash2,
  BadgeCheck,
  Info,
  Plus,
  Pencil,
  Sparkles,
  HeartHandshake,
  AlertTriangle,
  Check,
  ShieldAlert,
  ShieldCheck,
  UserCheck,
  Clock,
  type LucideIcon,
} from 'lucide-react';

type DropOffPricing = ResolvedDropOffPricing;

interface BookTicketsProps {
  tier: CustomerTier;
  memberName: string | null;
  lines: CartLine[];
  total: number;
  hasAdults: boolean;
  // One slot per unaccompanied kid (the kid tickets ARE the children). Empty when
  // adults are present, since adults waive the mandatory supervision floor.
  superSlots: SupervisedSlot[];
  acceptedIds: string[];
  dropOffPricing: DropOffPricing;
  // Active events sellable as online passes (flat entryPriceTHB), plus the passes
  // the customer has added. Adding/editing a pass routes through the orchestrator
  // so the attendee form runs as its own step (handled in Book.tsx).
  eventPasses: OtoEvent[];
  passes: PassSelection[];
  onAddPass: (event: OtoEvent) => void;
  onEditPass: (pass: PassSelection) => void;
  onRemovePass: (id: string) => void;
  // Computed by the orchestrator: the basket may be left only when every child is
  // named + aged, every mandatory service accepted, and every nanny time valid.
  canContinue: boolean;
  onUpdateSlot: (id: string, patch: Partial<SupervisedSlot>) => void;
  onAcceptSlot: (id: string) => void;
  onAddLine: (
    ticket: TicketType,
    config: { kids: number; adults: number; socks: number; addOns: AddOn[] }
  ) => void;
  onUpdateLine: (
    id: string,
    ticket: TicketType,
    config: { kids: number; adults: number; socks: number; addOns: AddOn[] }
  ) => void;
  onRemoveLine: (id: string) => void;
  onContinue: () => void;
  /**
   * The visit date (S2-12 fix round 2): every price on this step is that
   * day's, and changing it re-prices the basket (`Book.tsx`).
   */
  visitDate: string;
  minVisitDate: string;
  maxVisitDate: string;
  onVisitDateChange: (date: string) => void;
}

interface Draft {
  id?: string;
  ticket: TicketType;
  kids: number;
  adults: number;
  socks: number;
  addOns: AddOn[];
}

const BREAKDOWN_ICONS: Record<LineBreakdownKind, LucideIcon> = {
  kids: Baby,
  adults: User,
  socks: Footprints,
  addon: Sparkles,
};

// Generate 30-minute nanny start-time slots from now+30min to 21:00.
function generateTimeSlots(): string[] {
  const start = new Date(Date.now() + 30 * 60_000);
  if (start.getMinutes() <= 30) start.setMinutes(30, 0, 0);
  else start.setHours(start.getHours() + 1, 0, 0, 0);
  const end = new Date();
  end.setHours(21, 0, 0, 0);
  const slots: string[] = [];
  while (start <= end) {
    slots.push(
      `${String(start.getHours()).padStart(2, '0')}:${String(start.getMinutes()).padStart(2, '0')}`,
    );
    start.setMinutes(start.getMinutes() + 30);
  }
  return slots;
}

export function BookTickets({
  tier,
  memberName,
  lines,
  total,
  hasAdults,
  superSlots,
  acceptedIds,
  dropOffPricing,
  eventPasses,
  passes,
  onAddPass,
  onEditPass,
  onRemovePass,
  canContinue,
  onUpdateSlot,
  onAcceptSlot,
  onAddLine,
  onUpdateLine,
  onRemoveLine,
  onContinue,
  visitDate,
  minVisitDate,
  maxVisitDate,
  onVisitDateChange,
}: BookTicketsProps) {
  const { t, lang } = useLanguage();
  const tickets = useMemo(() => getTicketTypes(), []);
  const allAddOns = useMemo(() => getAddOns(), []);

  // The rate the chosen day is priced at, in words, under the date.
  const rate = todayRateMode();
  const visitDateRow = (
    <VisitDateRow
      label={t('book.tickets.visitDate')}
      description={
        rate.overrideName
          ? t('book.tickets.visitDateHoliday', { name: rate.overrideName })
          : rate.mode === 'weekend'
            ? t('book.tickets.visitDateWeekend')
            : t('book.tickets.visitDateWeekday')
      }
      value={visitDate}
      min={minVisitDate}
      max={maxVisitDate}
      onChange={onVisitDateChange}
    />
  );

  const [draft, setDraft] = useState<Draft | null>(null);
  const [picking, setPicking] = useState(false);

  const tierBadge = (
    <div className="inline-flex items-center gap-2 self-start mt-2 px-3 py-1.5 rounded-full bg-emerald-500/15 text-emerald-700">
      <BadgeCheck className="w-4 h-4" />
      <span className="text-sm font-semibold">
        {memberName ? t('book.tickets.welcomeBackRate', { name: memberName }) : ''}
        {tierLabel(tier)}
      </span>
    </div>
  );

  // --- Draft config (tap a ticket / edit a line -> set who/how many) --------
  if (draft) {
    const editing = draft.id != null;
    const setKids = (kids: number) => setDraft((d) => (d ? { ...d, kids } : d));
    const setAdults = (adults: number) => setDraft((d) => (d ? { ...d, adults } : d));

    const draftTotal = computeLineTotal({
      ticketType: draft.ticket,
      tier,
      kids: draft.kids,
      adults: draft.adults,
      socks: 0,
      addOns: draft.addOns.map((a) => ({ ...a, price: resolveRateToday(a.price), quantity: 1 })),
    });
    const valid = draft.kids + draft.adults > 0;

    const toggleAddOn = (addOn: AddOn) => {
      setDraft((d) =>
        d
          ? {
              ...d,
              addOns: d.addOns.some((a) => a.id === addOn.id)
                ? d.addOns.filter((a) => a.id !== addOn.id)
                : [...d.addOns, addOn],
            }
          : d
      );
    };

    const save = () => {
      const config = {
        kids: draft.kids,
        adults: draft.adults,
        socks: draft.socks,
        addOns: draft.addOns,
      };
      if (draft.id != null) onUpdateLine(draft.id, draft.ticket, config);
      else onAddLine(draft.ticket, config);
      setDraft(null);
      setPicking(false);
    };

    return (
      <div className="flex-1 flex flex-col px-5 py-6 animate-in fade-in slide-in-from-right-4 duration-300">
        <button
          type="button"
          onClick={() => setDraft(null)}
          className="inline-flex items-center gap-2 text-slate-500 mb-5"
        >
          <ArrowLeft className="w-5 h-5" /> {t('common.back')}
        </button>

        <h2 className="text-3xl font-black leading-tight">{resolveName(draft.ticket, lang)}</h2>
        <p className="text-slate-500 mt-1">
          {t('book.tickets.perPersonRate', { price: String(priceForTier(draft.ticket, tier)), tier: tierLabel(tier) })}
        </p>

        <div className="mt-6 space-y-3">
          {visitDateRow}
          <StepRow
            icon={Baby}
            label={t('book.tickets.kids')}
            description={t('book.tickets.kidsDesc')}
            value={draft.kids}
            onChange={setKids}
          />
          <StepRow
            icon={User}
            label={t('book.tickets.adults')}
            description={t('book.tickets.adultsDesc')}
            value={draft.adults}
            onChange={setAdults}
          />
        </div>

        <p className="text-xs text-slate-400 mt-2">{t('book.tickets.useStepper')}</p>

        <h3 className="text-lg font-semibold mt-6 mb-3">{t('book.tickets.extrasAddOns')}</h3>
        <AddOnToggles addOns={allAddOns} selected={draft.addOns} onToggle={toggleAddOn} />

        <div className="sticky bottom-0 mt-auto pt-6 pb-2 bg-gradient-to-t from-sky-50 via-sky-50 to-transparent">
          {!valid && (
            <p className="text-amber-600 text-sm mb-2 text-center">{t('book.tickets.addAtLeastOne')}</p>
          )}
          <Button
            size="lg"
            disabled={!valid}
            className="w-full h-16 text-lg font-bold gap-2"
            onClick={save}
          >
            {editing ? t('book.tickets.saveChanges') : t('book.tickets.addToBooking')} · ฿{draftTotal}
          </Button>
        </div>
      </div>
    );
  }

  // --- Ticket picker (only when adding / empty basket) ----------------------
  if (picking || (lines.length === 0 && passes.length === 0)) {
    return (
      <div className="flex-1 flex flex-col px-5 py-6 animate-in fade-in duration-300">
        {(lines.length > 0 || passes.length > 0) && (
          <button
            type="button"
            onClick={() => setPicking(false)}
            className="inline-flex items-center gap-2 text-slate-500 mb-5"
          >
            <ArrowLeft className="w-5 h-5" /> {t('book.tickets.backToBooking')}
          </button>
        )}

        <h2 className="text-3xl font-black leading-tight">{t('book.tickets.chooseTicket')}</h2>
        {tierBadge}

        {isDefaultTier(tier) && (
          <div className="flex items-start gap-2 mt-3 p-3 rounded-xl bg-white border border-slate-200 text-slate-500 text-sm">
            <Info className="w-4 h-4 mt-0.5 shrink-0 text-slate-400" />
            <span>{t('book.tickets.residentHint')}</span>
          </div>
        )}

        <div className="grid grid-cols-1 gap-3 mt-5">
          {tickets.map((ticket) => (
            <TicketCard key={ticket.id} ticket={ticket} tier={tier} onClick={() => setDraft(makeDraft(ticket))} />
          ))}
        </div>

        <EventPassSection
          events={eventPasses}
          passes={passes}
          onAddPass={onAddPass}
          onEditPass={onEditPass}
          onRemovePass={onRemovePass}
        />
      </div>
    );
  }

  // --- Basket (main view once something is added) ---------------------------
  // Plain-language list of what still blocks payment (mirrors the door gate).
  const blockers: string[] = [];
  for (const slot of superSlots) {
    const who = slot.name.trim() || t('book.tickets.eachChild');
    const age = slotAge(slot);
    const req = age == null ? 'none' : resolveRequirement(age);
    if (!slot.name.trim()) blockers.push(t('book.tickets.blockerNeedsName'));
    else if (age == null) blockers.push(t('book.tickets.blockerNeedsAge', { who }));
    else if (req !== 'none' && !acceptedIds.includes(slot.id)) {
      blockers.push(t('book.tickets.blockerAcceptService', { who }));
    }
    if (
      req === 'nanny' &&
      age != null &&
      (!slot.nannyStartTime || !checkNannyAvailability(slot.nannyStartTime, slot.ticketType.hours))
    ) {
      blockers.push(t('book.tickets.blockerNannyTime', { who }));
    }
  }
  const uniqueBlockers = Array.from(new Set(blockers));

  return (
    <div className="flex-1 flex flex-col px-5 py-6 animate-in fade-in duration-300">
      <h2 className="text-3xl font-black leading-tight">{t('book.tickets.yourBooking')}</h2>
      {tierBadge}

      <div className="mt-5">{visitDateRow}</div>

      <div className="space-y-3 mt-3">
        {lines.map((line) => {
          const lineSlots = superSlots.filter((s) => s.sourceLineId === line.id);
          return (
            <div key={line.id} className="rounded-3xl bg-white border border-slate-200 p-5">
              <div className="flex items-start justify-between gap-3 mb-1">
                <div className="min-w-0">
                  <div className="text-xl font-bold truncate">{resolveName(line.ticketType, lang)}</div>
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  <span className="text-xl font-bold text-primary tabular-nums mr-1">
                    ฿{line.lineTotal}
                  </span>
                  <button
                    type="button"
                    onClick={() => setDraft(makeDraftFromLine(line))}
                    className="text-slate-400 hover:text-primary p-1.5"
                    aria-label="Edit"
                  >
                    <Pencil className="w-5 h-5" />
                  </button>
                  <button
                    type="button"
                    onClick={() => onRemoveLine(line.id)}
                    className="text-slate-400 hover:text-red-500 p-1.5"
                    aria-label="Remove"
                  >
                    <Trash2 className="w-5 h-5" />
                  </button>
                </div>
              </div>

              <div className="mt-1">
                {computeLineBreakdown(line).map((item) => {
                  const Icon = BREAKDOWN_ICONS[item.kind];
                  return (
                    <div
                      key={item.key}
                      className="flex items-center justify-between py-2 border-b border-slate-100 last:border-b-0"
                    >
                      <span className="flex items-center gap-2.5 text-slate-600">
                        <Icon className="w-5 h-5 text-slate-500 shrink-0" />
                        <span>
                          {item.label}
                          <span className="text-slate-400 text-sm ml-2">
                            {item.quantity} × ฿{item.unitPrice}
                          </span>
                        </span>
                      </span>
                      <span className="font-bold tabular-nums">฿{item.subtotal}</span>
                    </div>
                  );
                })}
              </div>

              <button
                type="button"
                onClick={() => setDraft(makeDraftFromLine(line))}
                className="mt-3 inline-flex items-center gap-1.5 text-sm font-semibold text-primary/90 hover:text-primary"
              >
                <Pencil className="w-4 h-4" />
                {t('book.tickets.editNumbers')}
              </button>

              {/* Each kid ticket IS a child — collect name + age inline (no adult
                  on the booking). Adults present => superSlots empty, no capture. */}
              {lineSlots.length > 0 && (
                <div className="mt-4 border-t border-slate-200 pt-4 space-y-3">
                  <div className="flex items-center gap-2 text-sm font-semibold text-pink-200">
                    <HeartHandshake className="w-4 h-4" />
                    {lineSlots.length === 1 ? t('book.tickets.whosPlaying') : t('book.tickets.whosPlayingEach')}
                  </div>
                  {lineSlots.map((slot) => (
                    <ChildSlotRow
                      key={slot.id}
                      slot={slot}
                      tier={tier}
                      dropOffPricing={dropOffPricing}
                      accepted={acceptedIds.includes(slot.id)}
                      onUpdate={onUpdateSlot}
                      onAccept={onAcceptSlot}
                    />
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>

      <button
        type="button"
        onClick={() => setPicking(true)}
        className="mt-4 inline-flex items-center justify-center gap-2 w-full h-14 rounded-2xl border border-dashed border-slate-300 text-slate-600 hover:text-slate-900 hover:border-primary/50 transition-colors font-semibold"
      >
        <Plus className="w-5 h-5" />
        {t('book.tickets.addMore')}
      </button>

      <EventPassSection
        events={eventPasses}
        passes={passes}
        onAddPass={onAddPass}
        onEditPass={onEditPass}
        onRemovePass={onRemovePass}
      />

      {!hasAdults && superSlots.length > 0 && (
        <div className="flex items-start gap-2 mt-4 p-3 rounded-xl bg-white border border-slate-200 text-slate-500 text-sm">
          <Info className="w-4 h-4 mt-0.5 shrink-0 text-slate-400" />
          <span>{t('book.tickets.noAdultHint')}</span>
        </div>
      )}

      <div className="sticky bottom-0 mt-auto pt-6 pb-2 bg-gradient-to-t from-sky-50 via-sky-50 to-transparent">
        <div className="flex items-baseline justify-between mb-3 px-1">
          <span className="text-slate-500">{t('common.total')}</span>
          <span className="text-3xl font-black text-primary tabular-nums">฿{total}</span>
        </div>

        {uniqueBlockers.length > 0 && (
          <div className="mb-3 p-3 rounded-xl bg-amber-500/10 border border-amber-300 text-amber-700 text-sm">
            <div className="flex items-center gap-2 font-semibold mb-1">
              <AlertTriangle className="w-4 h-4" /> {t('book.tickets.beforePayment')}
            </div>
            <ul className="space-y-0.5 text-amber-800">
              {uniqueBlockers.map((b, i) => (
                <li key={i}>• {b}</li>
              ))}
            </ul>
          </div>
        )}

        <Button
          size="lg"
          disabled={!canContinue}
          className="w-full h-16 text-lg font-bold gap-2"
          onClick={onContinue}
        >
          {superSlots.length > 0 ? t('book.tickets.continueChildDetails') : t('book.tickets.continuePayment')}
          <ArrowRight className="w-5 h-5" />
        </Button>
      </div>
    </div>
  );
}

const REQ_META = {
  nanny: { labelKey: 'book.tickets.nannyRequired', icon: UserCheck },
  drop_off: { labelKey: 'book.tickets.dropOffRequired', icon: ShieldAlert },
  none: { labelKey: 'book.tickets.readyToPlay', icon: ShieldCheck },
} as const;

// One named child on an unaccompanied kid line: name + age, then (once aged) the
// age-derived mandatory service + cost the parent must Accept. Nanny children also
// pick an available start time. Reuses the shared resolver + drop-off pricing.
function ChildSlotRow({
  slot,
  tier,
  dropOffPricing,
  accepted,
  onUpdate,
  onAccept,
}: {
  slot: SupervisedSlot;
  tier: CustomerTier;
  dropOffPricing: DropOffPricing;
  accepted: boolean;
  onUpdate: (id: string, patch: Partial<SupervisedSlot>) => void;
  onAccept: (id: string) => void;
}) {
  void tier;
  const { t } = useLanguage();
  const timeSlots = useMemo(generateTimeSlots, []);
  const age = slotAge(slot);
  const req = age == null ? 'none' : resolveRequirement(age);
  const meta = REQ_META[req];
  const Icon = meta.icon;
  const hours = slot.ticketType.hours;
  const fee = req === 'none' ? 0 : dropOffServiceFee(req, hours, dropOffPricing);
  const isNanny = req === 'nanny';
  const nannyAvailable = slot.nannyStartTime
    ? checkNannyAvailability(slot.nannyStartTime, hours)
    : null;

  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-4">
      <div className="flex gap-3">
        <Input
          value={slot.name}
          onChange={(e) => onUpdate(slot.id, { name: e.target.value })}
          placeholder={t('book.tickets.childName')}
          className="h-12 flex-1 border-slate-200 bg-white text-lg text-slate-900 placeholder:text-slate-400"
        />
        <div className="w-36 shrink-0">
          <ChildDobPicker
            dateOfBirth={slot.dateOfBirth}
            age={parseAge(slot.age)}
            childName={slot.name}
            onChange={({ dateOfBirth, age: a }) =>
              onUpdate(slot.id, { dateOfBirth, age: String(a) })
            }
          />
        </div>
      </div>

      {age != null && (
        <div className="mt-3 space-y-3">
          {req !== 'none' && (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
              <Badge variant="destructive" className="gap-1.5 px-2.5 py-1 text-sm">
                <Icon className="h-4 w-4" />
                {t(meta.labelKey)}
              </Badge>
              {fee > 0 && (
                <span className="text-sm font-medium text-slate-600">
                  {isNanny
                    ? t('book.tickets.perHour', { fee: String(fee), rate: String(dropOffPricing.nannyHourlyRateTHB) })
                    : t('book.tickets.oneTime', { fee: String(fee) })}
                </span>
              )}
            </div>
          )}

          {req !== 'none' && (
            <>
              {accepted ? (
                <div className="inline-flex items-center gap-1.5 text-sm font-semibold text-emerald-600">
                  <Check className="h-4 w-4" /> {t('book.tickets.serviceAccepted')}
                </div>
              ) : (
                <Button
                  size="sm"
                  className="h-10 rounded-xl px-4 text-sm font-bold"
                  onClick={() => onAccept(slot.id)}
                >
                  {isNanny
                    ? t('book.tickets.acceptNanny', { fee: String(fee) })
                    : t('book.tickets.acceptDropOff', { fee: String(fee) })}
                </Button>
              )}
            </>
          )}

          {req === 'none' && (
            <Badge variant="secondary" className="gap-1.5 px-2.5 py-1 text-sm text-emerald-600">
              <Check className="h-3.5 w-3.5" /> {t('book.tickets.registeredFree')}
            </Badge>
          )}

          {isNanny && (
            <div>
              <label className="flex items-center gap-1.5 text-sm text-slate-600">
                <Clock className="h-4 w-4" /> {t('book.tickets.nannyStartTime')}
              </label>
              <select
                value={slot.nannyStartTime ?? ''}
                onChange={(e) => onUpdate(slot.id, { nannyStartTime: e.target.value || undefined })}
                className="mt-1.5 h-12 w-full rounded-xl border border-slate-200 bg-white px-3 text-lg text-slate-900"
              >
                <option value="">{t('book.tickets.chooseStartTime')}</option>
                {timeSlots.map((slotTime) => (
                  <option key={slotTime} value={slotTime}>
                    {slotTime}
                  </option>
                ))}
              </select>
              {slot.nannyStartTime && nannyAvailable === false && (
                <p className="mt-1.5 text-sm text-amber-700">
                  {t('book.tickets.noNannyFree', { time: slot.nannyStartTime })}
                </p>
              )}
              {slot.nannyStartTime && nannyAvailable === true && (
                <p className="mt-1.5 text-sm text-emerald-600">
                  {t('book.tickets.nannyAvailableFrom', { time: slot.nannyStartTime })}
                </p>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function makeDraft(ticket: TicketType): Draft {
  return { ticket, kids: 1, adults: 1, socks: 0, addOns: [] };
}

// Reconciles a line's legacy `socks` quantity into the addOns draft (socks now
// sell exclusively through Extras & add-ons, like the till). Any prior socks
// count on the line just means "socks were selected" — carried over as the
// Regular Socks add-on so re-opening an existing line doesn't silently drop it.
function makeDraftFromLine(line: CartLine): Draft {
  const addOns: AddOn[] = line.addOns.map((a) => ({ ...a, price: { weekday: a.price, weekend: a.price } }));
  if (line.socks > 0 && !addOns.some((a) => a.id === 'a-socks')) {
    const socksItem = getAddOns().find((a) => a.id === 'a-socks');
    if (socksItem) addOns.push(socksItem);
  }
  return {
    id: line.id,
    ticket: line.ticketType,
    kids: line.kids,
    adults: line.adults,
    socks: 0,
    addOns,
  };
}
