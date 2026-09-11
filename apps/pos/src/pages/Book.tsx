import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { AddOn, Booking, CartLine, ContactChannel, CustomerTier, Member, OtoEvent, SelectedAddOn, TicketType } from '@/types';
import {
  getMemberById,
  addSavedChild,
  updateSavedChild,
  removeSavedChild,
  createBooking,
  getDropOffPricing,
  getActiveEventPasses,
  getActiveBranch,
  checkNannyAvailability,
  updateMember,
} from '@/mockApi';
import { resolveAutoTier } from '@/lib/membership';
import { computeLineTotal } from '@/lib/pricing';
import { computeTotals } from '@/lib/sale';
import { resolveRequirement, resolveSupervisionOutcome, confirmationsSatisfied, buildAcknowledgedConfirmations } from '@/lib/supervision';
import { dropOffServiceFee, normalizeDropOffFees, resolveDropOffPricing, type DropOffPricing as ResolvedDropOffPricing } from '@/lib/dropoff';
import { getSupervisionPolicy, wwp, subscribeCatalog } from '@/store/catalogStore';
import { resolveRateToday } from '@/lib/pricingMode';
import { slotAge, type SupervisedSlot } from '@/components/till/SupervisionGate';
import { SavedChildrenReview } from '@/components/shared/SavedChildrenReview';
import { slotPatchFromSavedChild, savedChildInputFromSlot } from '@/lib/savedChildren';
import type { SavedChild } from '@/types';
import { ConsentCapture } from '@/components/till/ConsentCapture';
import { BookIdentify } from '@/components/book/BookIdentify';
import { BookTickets } from '@/components/book/BookTickets';
import { BookPayment } from '@/components/book/BookPayment';
import { BookConfirmation } from '@/components/book/BookConfirmation';
import { BookEventPassForm, type PassSelection } from '@/components/book/BookEventPasses';
import {
  emptyAttendeeForm,
  buildAttendeeInput,
  type AttendeeForm,
} from '@/components/shared/AttendeeFormFields';
import { Button } from '@/components/ui/button';
import { ArrowLeft, ArrowRight } from 'lucide-react';
import { LanguageSwitcher } from '@/components/shared/LanguageSwitcher';
import { useLanguage } from '@/i18n/LanguageContext';
import { publicApi } from '@/api/platform';
import { loadPublicCatalog } from '@/api/catalogBridge';
import { toast } from '@/hooks/use-toast';

type Stage = 'identify' | 'tickets' | 'pass' | 'savedChildren' | 'supervise' | 'pay' | 'confirmation';

// A synthetic kid-ticket line modelling one event pass, used ONLY for the running
// total + tax (NEVER stored in booking.lines). The flat entryPriceTHB is placed
// in prices[tier] so computeLineBreakdown taxes it as a ticket — avoiding the
// "fee in lineTotal only -> 0 in computeTotals" gotcha.
function buildPassLine(pass: PassSelection, tier: CustomerTier): CartLine {
  const fee = resolveRateToday(pass.event.entryPriceTHB);
  const ticketType: TicketType = {
    id: `pass-${pass.event.id}`,
    name: pass.event.title,
    durationLabel: 'Event pass',
    hours: 0,
    prices: { [tier]: wwp(fee) },
  };
  return {
    id: `passline-${pass.id}`,
    ticketType,
    tier,
    kids: 1,
    adults: 0,
    socks: 0,
    addOns: [],
    lineTotal: fee,
  };
}

type DropOffPricing = ResolvedDropOffPricing;

const withQty = (addOns: AddOn[]): SelectedAddOn[] =>
  addOns.map((a) => ({ ...a, price: resolveRateToday(a.price), quantity: 1 }));

// One editable child pulled out of a kid-ticket line. Mirrors the reception door
// flow's expand-to-named-children pattern: the kid tickets already in the basket
// ARE the children, so we collect each one's name + age in place (no separate
// "supervised child" path). Reuses the shared SupervisedSlot shape so the same
// ConsentCapture screen can collect photo / allergies / food authorization.
function makeSlot(line: CartLine): SupervisedSlot {
  return {
    id: `slot-${Math.random().toString(36).substring(2, 9)}`,
    sourceLineId: line.id,
    ticketType: line.ticketType,
    name: '',
    age: '',
    waived: false,
    // No-adult registrations always run the full supervised flow online, just
    // like the door (Till) and customer display — there is no online opt-in
    // toggle. A genuinely no-fee (9+) child is still registered at ฿0.
    optIn: true,
    allergiesMedical: '',
    foodRestrictions: '',
    // Mirror the door's consent defaults (Till.tsx): food ordering is OFF until the
    // parent makes an explicit prepaid choice in the picker, which carries the only
    // permission. mayOrderFood is derived from foodProvision.mode at booking.
    mayOrderFood: false,
    foodProvision: { mode: 'none', paidTHB: 0 },
    childPhotoUrl: undefined,
    nannyStartTime: undefined,
  };
}

// Keep one slot per kid across every regular (non-drop-off) ticket line, but only
// when the basket is unaccompanied — adults anywhere waive the supervision floor,
// so no per-child capture is needed. Existing slots are preserved by source line +
// index so editing ticket numbers never wipes already-entered child details.
function reconcileSlots(
  prev: SupervisedSlot[],
  lines: CartLine[],
  hasAdults: boolean,
): SupervisedSlot[] {
  if (hasAdults) return [];
  const out: SupervisedSlot[] = [];
  for (const l of lines) {
    if (l.dropOff || l.kids <= 0) continue;
    const existing = prev.filter((s) => s.sourceLineId === l.id);
    for (let i = 0; i < l.kids; i++) {
      const e = existing[i];
      if (e) {
        out.push(e.ticketType.id === l.ticketType.id ? e : { ...e, ticketType: l.ticketType });
      } else {
        out.push(makeSlot(l));
      }
    }
  }
  return out;
}

// Turn the basket's regular kid lines into the cart the till would build: each
// child who needs supervision becomes a drop-off line (its age-derived service +
// fee), each child who needs none stays a plain ticket. Socks / add-ons on a
// fully-converted source line carry onto its first drop-off line so they're never
// dropped. This is the cart used for totals + createBooking; normalizeDropOffFees
// then bills the shared nanny once at the longest duration (same as the POS).
function buildEffectiveLines(
  lines: CartLine[],
  slots: SupervisedSlot[],
  tier: CustomerTier,
  pricing: DropOffPricing,
): CartLine[] {
  if (slots.length === 0) return lines;
  const bySource = new Map<string, SupervisedSlot[]>();
  for (const s of slots) {
    const arr = bySource.get(s.sourceLineId);
    if (arr) arr.push(s);
    else bySource.set(s.sourceLineId, [s]);
  }

  const out: CartLine[] = [];
  for (const l of lines) {
    const ls = bySource.get(l.id);
    if (!ls || ls.length === 0) {
      out.push(l);
      continue;
    }

    const supervised: { slot: SupervisedSlot; service: 'nanny' | 'drop_off' | 'none' }[] = [];
    let plainKids = 0;
    for (const s of ls) {
      const age = slotAge(s);
      const req = age == null ? 'none' : resolveRequirement(age);
      const outcome = resolveSupervisionOutcome(req, s.waived, s.optIn);
      if (outcome.service !== null) supervised.push({ slot: s, service: outcome.service });
      else plainKids++;
    }
    const fullyConverted = supervised.length > 0 && plainKids === 0 && l.adults === 0;

    // Residual plain line: any 9+ / not-yet-aged kids (and adults). Keeps the
    // source line's socks + add-ons unless the line fully converts to drop-off.
    if (plainKids > 0 || l.adults > 0) {
      const base = {
        ticketType: l.ticketType,
        tier,
        kids: plainKids,
        adults: l.adults,
        socks: l.socks,
        addOns: l.addOns,
      };
      if (base.kids + base.adults > 0) {
        out.push({ id: l.id, ...base, lineTotal: computeLineTotal(base) });
      }
    }

    supervised.forEach(({ slot, service }, i) => {
      const carry = fullyConverted && i === 0;
      const base = {
        ticketType: l.ticketType,
        tier,
        kids: 1,
        adults: 0,
        socks: carry ? l.socks : 0,
        addOns: carry ? l.addOns : [],
      };
      const serviceFeeTHB = dropOffServiceFee(service, l.ticketType.hours, pricing);
      out.push({
        id: slot.id,
        ...base,
        lineTotal: computeLineTotal({ ...base, serviceFeeTHB }),
        dropOff: {
          registrationId: '',
          checkInId: '',
          childName: slot.name.trim(),
          childAge: slotAge(slot) ?? 0,
          dateOfBirth: slot.dateOfBirth,
          allergiesMedical: slot.allergiesMedical || undefined,
          mayOrderFood: slot.mayOrderFood,
          // Carry the parent's prepaid food choice onto the drop-off line so its
          // paidTHB flows into the cart total + tax engine (tillTaxInputs routes
          // prepaid_items → fnb, prepaid_credit → stored_value), exactly as the
          // door flow does via makeDropOffLine. createBooking then persists it on
          // the registration; the band is loaded at check-in (not at booking).
          foodProvision: slot.foodProvision,
          foodRestrictions: slot.foodRestrictions || undefined,
          childPhotoUrl: slot.childPhotoUrl,
          service,
          // All online nanny children share this sentinel so normalizeDropOffFees
          // groups them as one nanny (the park assigns a single nanny per family).
          nannyId: service === 'nanny' ? 'online-pending' : undefined,
          hours: l.ticketType.hours,
          lengthChosen: true,
          serviceFeeTHB,
          nannyStartTime: service === 'nanny' ? slot.nannyStartTime : undefined,
        },
      });
    });
  }
  return out;
}

export default function Book() {
  // Subscribe to catalog mutations so live Admin edits to the supervision
  // policy (bands / confirmations) flow into this flow instead of freezing at
  // mount. getSupervisionPolicy() returns a stable reference until a mutation.
  useSyncExternalStore(subscribeCatalog, () => null);
  const policy = getSupervisionPolicy();
  const { t, lang } = useLanguage();

  const [stage, setStage] = useState<Stage>('identify');
  const [member, setMember] = useState<Member | null>(null);
  const [nickname, setNickname] = useState('');
  const [phone, setPhone] = useState('');
  const [contactChannel, setContactChannel] = useState<ContactChannel>('whatsapp');

  // Live catalog: /book is public (no session), so it hydrates the store from
  // the public endpoint itself — packages, tiers, holiday rate mode all come
  // from the database. If the API is unreachable the page still works on the
  // last seeds, with a visible notice (failing-case rule).
  const [liveCatalog, setLiveCatalog] = useState<'loading' | 'ready' | 'offline'>('loading');
  useEffect(() => {
    let cancelled = false;
    loadPublicCatalog(getActiveBranch().id)
      .then(() => {
        if (!cancelled) setLiveCatalog('ready');
      })
      .catch(() => {
        if (!cancelled) setLiveCatalog('offline');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Same "save per member" behaviour as the till: persist the new preference
  // immediately if this booking belongs to an already-identified member.
  const handleContactChannelChange = (channel: ContactChannel) => {
    setContactChannel(channel);
    if (member) updateMember(member.id, { preferredChannel: channel });
  };
  const [lines, setLines] = useState<CartLine[]>([]);
  const [passes, setPasses] = useState<PassSelection[]>([]);
  const [editingPass, setEditingPass] = useState<PassSelection | null>(null);
  const [booking, setBooking] = useState<Booking | null>(null);

  // Active events sellable as online passes (flat entryPriceTHB, parties excluded).
  const activeEvents = useMemo(() => {
    const today = new Date().toISOString().slice(0, 10);
    return getActiveEventPasses(today, getActiveBranch().id);
  }, []);

  // Lifted per-child supervision draft (mirrors the reception flow's superSlots),
  // plus the booking-level consent the customer gives on the ConsentCapture step.
  const [superSlots, setSuperSlots] = useState<SupervisedSlot[]>([]);
  const [acceptedIds, setAcceptedIds] = useState<string[]>([]);
  const [parentName, setParentName] = useState('');
  const [consentAck, setConsentAck] = useState(false);
  const [acknowledgedConfirmationIds, setAcknowledgedConfirmationIds] = useState<string[]>([]);
  // Slot ids the parent re-confirmed on the saved-children review stage.
  const [confirmedSavedIds, setConfirmedSavedIds] = useState<string[]>([]);

  const dropOffPricing = useMemo(() => resolveDropOffPricing(getDropOffPricing()), []);
  const tier = useMemo(() => resolveAutoTier(member), [member]);

  // Adults present anywhere waive the mandatory supervision floor for ALL children.
  const hasAdults = useMemo(() => lines.some((l) => l.adults > 0), [lines]);

  // Keep one child slot per unaccompanied kid in sync with the basket lines. For a
  // returning member, pre-fill each BRAND-NEW blank slot from their saved children
  // (by index) so the inline child form arrives pre-filled — text only, never the
  // photo. Existing slots (already edited / confirmed / explicitly marked new) are
  // preserved by reconcileSlots and never re-stamped, so inline edits stick.
  useEffect(() => {
    const saved = member?.savedChildren ?? [];
    setSuperSlots((prev) => {
      const reconciled = reconcileSlots(prev, lines, hasAdults);
      if (saved.length === 0) return reconciled;
      return reconciled.map((slot, i) => {
        const isBlankNew =
          !slot.savedChildId && slot.name.trim() === '' && slot.age.trim() === '';
        const child = saved[i];
        return isBlankNew && child ? { ...slot, ...slotPatchFromSavedChild(child) } : slot;
      });
    });
  }, [lines, hasAdults, member]);

  // Drop acceptances for slots that no longer exist (line removed / kids reduced).
  useEffect(() => {
    const ids = new Set(superSlots.map((s) => s.id));
    setAcceptedIds((a) => {
      const filtered = a.filter((id) => ids.has(id));
      return filtered.length === a.length ? a : filtered;
    });
  }, [superSlots]);

  // The cart the till would build, with shared-nanny fees normalized. Used for the
  // running total AND the eventual createBooking call.
  const normalizedLines = useMemo(
    () => normalizeDropOffFees(buildEffectiveLines(lines, superSlots, tier, dropOffPricing), dropOffPricing),
    [lines, superSlots, tier, dropOffPricing],
  );
  // Synthetic lines model each pass's flat fee so it taxes alongside the basket;
  // they are summed for the total only, never persisted on the booking.
  const passLines = useMemo(() => passes.map((p) => buildPassLine(p, tier)), [passes, tier]);
  const { total } = computeTotals([...normalizedLines, ...passLines]);

  // Per-child resolution for the basket gate.
  const supRows = useMemo(
    () =>
      superSlots.map((s) => {
        const age = slotAge(s);
        const req = age == null ? 'none' : resolveRequirement(age, policy);
        const outcome = resolveSupervisionOutcome(req, s.waived, s.optIn);
        // "mandatory" gates the paid Accept-service tap; opted-in 'none' kids
        // need the same consent flow but never a fee, so they never need Accept.
        return { slot: s, age, req, mandatory: req !== 'none', needsConsent: outcome.needsConsent };
      }),
    [superSlots, policy],
  );

  const needsSupervision = supRows.some((r) => r.needsConsent);
  const allNamedAged = supRows.every((r) => r.slot.name.trim() !== '' && r.age != null);
  const allAccepted = supRows.every((r) => !r.mandatory || acceptedIds.includes(r.slot.id));
  const nannyTimesOk = supRows.every(
    (r) =>
      r.req !== 'nanny' ||
      (!!r.slot.nannyStartTime && checkNannyAvailability(r.slot.nannyStartTime, r.slot.ticketType.hours)),
  );
  // Leaving the basket: every unaccompanied child named + aged, every mandatory
  // service acknowledged, and every nanny child has an available start time.
  const entryOk = superSlots.length === 0 || (allNamedAged && allAccepted && nannyTimesOk);

  // Leaving the consent step: photo + booking-level consent + a reachable phone
  // for every child who still needs the supervised flow (mandatory or opted in).
  // photosOk uses needsConsent so an opted-in 9+ kid still needs their photo.
  const photosOk = supRows.every((r) => !r.needsConsent || !!r.slot.childPhotoUrl);
  // Legacy consent fields (parent name / photo / phone / authorization) only
  // render when a child actually goes through the consent flow, so gate them on
  // needsSupervision — never on superSlots alone, or an all-9+ (no-consent)
  // group would be permanently blocked since those fields never show.
  const legacyConsentOk =
    !needsSupervision ||
    (parentName.trim() !== '' && consentAck && photosOk && phone.trim() !== '');
  // Confirmations are required for ANY unaccompanied registration, even one
  // where every child ends up needing no service (e.g. an all-9+ group).
  const confirmationsOk =
    superSlots.length === 0 || confirmationsSatisfied(policy, acknowledgedConfirmationIds);
  const consentOk = legacyConsentOk && confirmationsOk;

  const handleToggleConfirmation = (id: string) =>
    setAcknowledgedConfirmationIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    );

  // Customer self-identification against the platform API (public endpoint):
  // phone → nickname + verified tier ONLY (no PII). A found member's stored
  // tier drives the prices they see; lookup failures degrade to guest with a
  // visible notice — the flow never dead-ends on a network error.
  const handleIdentify = (enteredPhone: string, nick: string, channel: ContactChannel) => {
    const typed = enteredPhone.trim();
    void (async () => {
      let found: Member | null = null;
      if (typed) {
        try {
          const res = await publicApi.memberTier(typed);
          if (res.found) {
            found = {
              id: res.memberId,
              phone: typed,
              nickname: res.nickname,
              preferredChannel: res.preferredChannel ?? undefined,
              tierVerification:
                res.tierCode && res.tierCode !== 'tourist'
                  ? {
                      tier: res.tierCode,
                      proofType: 'Member record',
                      verifiedBy: 'OTO',
                      verifiedById: 'api',
                      verifiedAt: new Date().toISOString(),
                    }
                  : undefined,
            };
          }
        } catch {
          toast({
            title: 'Membership check unavailable',
            description: 'Continuing as a guest — standard rates apply.',
            variant: 'destructive',
          });
        }
      }
      setMember(found);
      const resolvedName = found?.nickname ?? nick.trim();
      setNickname(resolvedName);
      setParentName(resolvedName);
      setPhone(typed);
      // `channel` already reflects BookIdentify's pre-select-then-let-the-user-override
      // resolution — never re-overwrite it with the stored preference here, or a manual
      // change made right before tapping Continue would be silently discarded.
      setContactChannel(channel);
      setStage('tickets');
    })();
  };

  const handleAddLine = (
    ticket: TicketType,
    config: { kids: number; adults: number; socks: number; addOns: AddOn[] }
  ) => {
    const base = { ticketType: ticket, tier, ...config, addOns: withQty(config.addOns) };
    const line: CartLine = {
      id: Math.random().toString(36).substring(2, 9),
      ...base,
      lineTotal: computeLineTotal(base),
    };
    setLines((prev) => [...prev, line]);
  };

  const handleUpdateLine = (
    id: string,
    ticket: TicketType,
    config: { kids: number; adults: number; socks: number; addOns: AddOn[] }
  ) => {
    const base = { ticketType: ticket, tier, ...config, addOns: withQty(config.addOns) };
    setLines((prev) =>
      prev.map((l) =>
        l.id === id ? { ...l, ...base, lineTotal: computeLineTotal(base) } : l
      )
    );
  };

  const handleRemoveLine = (id: string) => {
    setLines((prev) => prev.filter((l) => l.id !== id));
  };

  const handleUpdateSlot = (id: string, patch: Partial<SupervisedSlot>) => {
    setSuperSlots((prev) => prev.map((s) => (s.id === id ? { ...s, ...patch } : s)));
    // Changing the age can change the required service (and its cost), so a prior
    // acceptance no longer applies — the parent must re-acknowledge.
    if (patch.age !== undefined) setAcceptedIds((a) => a.filter((x) => x !== id));
  };

  const handleAcceptSlot = (id: string) =>
    setAcceptedIds((a) => (a.includes(id) ? a : [...a, id]));

  // --- Saved-children review stage handlers --------------------------------
  // Editing name/age un-confirms the slot so the parent re-confirms the change.
  const handleReviewUpdateSlot = (id: string, patch: Partial<SupervisedSlot>) => {
    handleUpdateSlot(id, patch);
    setConfirmedSavedIds((prev) => prev.filter((x) => x !== id));
  };

  // "Still correct?" → write any edits back to the saved profile and mark done.
  const handleConfirmSlot = (id: string) => {
    const slot = superSlots.find((s) => s.id === id);
    const age = slot ? slotAge(slot) : null;
    if (member && slot?.savedChildId && age !== null) {
      updateSavedChild(member.id, slot.savedChildId, savedChildInputFromSlot(slot, age));
      setMember(getMemberById(member.id));
    }
    setConfirmedSavedIds((prev) => (prev.includes(id) ? prev : [...prev, id]));
  };

  const handleAssignSaved = (slotId: string, child: SavedChild) => {
    handleUpdateSlot(slotId, slotPatchFromSavedChild(child));
    setConfirmedSavedIds((prev) => prev.filter((x) => x !== slotId));
  };

  const handleMarkNew = (slotId: string) => {
    handleUpdateSlot(slotId, {
      savedChildId: undefined,
      name: '',
      age: '',
      dateOfBirth: undefined,
      allergiesMedical: '',
      foodRestrictions: '',
    });
    setConfirmedSavedIds((prev) => prev.filter((x) => x !== slotId));
  };

  const handleRemoveSaved = (slotId: string, childId: string) => {
    if (member) {
      removeSavedChild(member.id, childId);
      setMember(getMemberById(member.id));
    }
    handleMarkNew(slotId);
  };

  // Every slot must be named + aged; every still-linked saved child re-confirmed.
  const reviewCanContinue =
    superSlots.length > 0 &&
    superSlots.every(
      (s) =>
        s.name.trim().length > 0 &&
        slotAge(s) !== null &&
        (!s.savedChildId || confirmedSavedIds.includes(s.id)),
    );

  // A returning member with saved children re-confirms them first (details
  // pre-fill the slots, text only — never the photo). First-timers and bookings
  // with no supervision needed skip straight on.
  const handleContinueFromTickets = () => {
    if (superSlots.length === 0) {
      setStage('pay');
      return;
    }
    const saved = member?.savedChildren ?? [];
    if (saved.length > 0) {
      // Slots are already pre-filled at creation by the reconcile effect (which
      // preserves any inline edits); just open the per-child re-confirm step.
      setConfirmedSavedIds([]);
      setStage('savedChildren');
    } else {
      setStage('supervise');
    }
  };

  // Adding a pass: open the attendee step on a fresh draft, pre-filled with the
  // identify-step name/phone so the customer rarely re-types their own details.
  const handleAddPass = (event: OtoEvent) => {
    setEditingPass({
      id: Math.random().toString(36).substring(2, 9),
      event,
      form: {
        ...emptyAttendeeForm,
        parentName: parentName.trim() || nickname.trim(),
        parentPhone: phone.trim(),
      },
    });
    setStage('pass');
  };

  const handleEditPass = (pass: PassSelection) => {
    setEditingPass(pass);
    setStage('pass');
  };

  const handleChangePassForm: <K extends keyof AttendeeForm>(key: K, value: AttendeeForm[K]) => void = (
    key,
    value,
  ) => setEditingPass((p) => (p ? { ...p, form: { ...p.form, [key]: value } } : p));

  const handleSavePass = () => {
    if (!editingPass) return;
    setPasses((prev) => {
      const exists = prev.some((p) => p.id === editingPass.id);
      return exists ? prev.map((p) => (p.id === editingPass.id ? editingPass : p)) : [...prev, editingPass];
    });
    setEditingPass(null);
    setStage('tickets');
  };

  const handleCancelPass = () => {
    setEditingPass(null);
    setStage('tickets');
  };

  const handleRemovePass = (id: string) => setPasses((prev) => prev.filter((p) => p.id !== id));

  const [bookingBusy, setBookingBusy] = useState(false);

  const handlePay = (paymentMethod: 'card' | 'promptpay') => {
    if (bookingBusy) return; // double-submit guard
    setBookingBusy(true);
    void (async () => {
      // Persist the booking on the platform API FIRST — the server recomputes
      // the ticket total from the database packages (client figure untrusted)
      // and issues the canonical reference. Failure keeps the customer on the
      // payment step with a clear message instead of a phantom booking.
      const isUuid = (v: string) => /^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(v);
      const serverLines = normalizedLines
        .filter((l) => !l.promoItem && !l.dropOff && isUuid(l.ticketType.id) && (l.kids > 0 || l.adults > 0))
        .map((l) => ({ packageId: l.ticketType.id, kids: l.kids, adults: l.adults }));
      let serverReference: string | null = null;
      if (serverLines.length > 0) {
        try {
          const res = await publicApi.createBooking({
            branchCode: getActiveBranch().id,
            phone: phone || undefined,
            parentName: parentName.trim() || nickname.trim() || 'Guest',
            tier,
            lines: serverLines,
            contactChannel,
            locale: lang,
            clientSnapshot: { totalTHB: total, passCount: passes.length },
          });
          serverReference = res.reference;
        } catch (err) {
          setBookingBusy(false);
          toast({
            title: "We couldn't confirm your booking",
            description:
              err instanceof Error ? err.message : 'Please check your connection and try again.',
            variant: 'destructive',
          });
          return;
        }
      }
      finalizeBooking(paymentMethod, serverReference);
      setBookingBusy(false);
    })();
  };

  const finalizeBooking = (paymentMethod: 'card' | 'promptpay', serverReference: string | null) => {
    // Save / update each supervised child against the member's profile so they
    // pre-fill next time. Photo is never saved (re-taken each visit); a slot
    // linked to a saved child updates it, otherwise it's added new. Stamped as an
    // online booking. Guests without a member account are skipped.
    if (member) {
      for (const slot of superSlots) {
        const age = slotAge(slot);
        if (age === null || !slot.name.trim()) continue;
        const req = resolveRequirement(age);
        const outcome = resolveSupervisionOutcome(req, slot.waived, slot.optIn);
        if (outcome.service === null) continue;
        const input = savedChildInputFromSlot(slot, age);
        if (slot.savedChildId) {
          updateSavedChild(member.id, slot.savedChildId, input);
        } else {
          addSavedChild(member.id, input, 'Online booking');
        }
      }
    }
    const made = createBooking({
      memberId: member?.id,
      tier,
      lines: normalizedLines,
      total,
      paymentMethod,
      registrant: {
        parentName: parentName.trim() || nickname.trim() || 'Guest',
        phone,
        contactMethod: contactChannel,
        acknowledgedConfirmations: buildAcknowledgedConfirmations(policy, acknowledgedConfirmationIds),
      },
      eventPasses: passes.map((p) => ({
        eventId: p.event.id,
        input: buildAttendeeInput(p.form),
        priceTHB: resolveRateToday(p.event.entryPriceTHB),
      })),
    });
    // The database reference is the one printed on the QR / told to reception.
    if (serverReference) made.reference = serverReference;
    setBooking(made);
    setStage('confirmation');
  };

  const handleStartOver = () => {
    setStage('identify');
    setMember(null);
    setNickname('');
    setPhone('');
    setLines([]);
    setPasses([]);
    setEditingPass(null);
    setSuperSlots([]);
    setAcceptedIds([]);
    setParentName('');
    setConsentAck(false);
    setAcknowledgedConfirmationIds([]);
    setConfirmedSavedIds([]);
    setBooking(null);
  };

  return (
    <div className="light min-h-[100dvh] w-full bg-gradient-to-b from-sky-100 via-sky-50 to-sky-50 text-slate-900 relative">
      {liveCatalog === 'offline' && (
        <div className="sticky top-0 z-50 bg-amber-100 border-b border-amber-300 text-amber-900 text-xs font-semibold text-center px-4 py-2">
          Live prices are temporarily unavailable — showing standard rates. Bookings may not go
          through until the connection returns.
        </div>
      )}
      {stage !== 'supervise' && (
        <div className="absolute top-4 right-4 z-40">
          <LanguageSwitcher variant="light" />
        </div>
      )}
      <div className="mx-auto w-full max-w-md min-h-[100dvh] flex flex-col">
        {stage === 'identify' && <BookIdentify onContinue={handleIdentify} />}

        {stage === 'tickets' && (
          <BookTickets
            tier={tier}
            memberName={member ? nickname : null}
            lines={lines}
            total={total}
            hasAdults={hasAdults}
            superSlots={superSlots}
            acceptedIds={acceptedIds}
            dropOffPricing={dropOffPricing}
            eventPasses={activeEvents}
            passes={passes}
            onAddPass={handleAddPass}
            onEditPass={handleEditPass}
            onRemovePass={handleRemovePass}
            canContinue={(lines.length > 0 || passes.length > 0) && entryOk}
            onUpdateSlot={handleUpdateSlot}
            onAcceptSlot={handleAcceptSlot}
            onAddLine={handleAddLine}
            onUpdateLine={handleUpdateLine}
            onRemoveLine={handleRemoveLine}
            onContinue={handleContinueFromTickets}
          />
        )}

        {stage === 'pass' && editingPass && (
          <BookEventPassForm
            event={editingPass.event}
            form={editingPass.form}
            onChange={handleChangePassForm}
            onSave={handleSavePass}
            onCancel={handleCancelPass}
          />
        )}

        {stage === 'savedChildren' && (
          <div className="flex-1 min-h-0 animate-in fade-in duration-300">
            <SavedChildrenReview
              slots={superSlots}
              savedChildren={member?.savedChildren ?? []}
              confirmedIds={confirmedSavedIds}
              onUpdateSlot={handleReviewUpdateSlot}
              onConfirmSlot={handleConfirmSlot}
              onAssignSaved={handleAssignSaved}
              onMarkNew={handleMarkNew}
              onRemoveSaved={handleRemoveSaved}
              onBack={() => setStage('tickets')}
              onContinue={() => setStage('supervise')}
              canContinue={reviewCanContinue}
            />
          </div>
        )}

        {stage === 'supervise' && (
          <div className="flex-1 flex flex-col min-h-0 animate-in fade-in duration-300">
            <div className="flex-1 min-h-0">
              <ConsentCapture
                slots={superSlots}
                parentName={parentName}
                consentAck={consentAck}
                policy={policy}
                parentPhone={phone}
                parentContactMethod={contactChannel}
                onParentPhoneChange={setPhone}
                onParentContactMethodChange={handleContactChannelChange}
                onParentNameChange={setParentName}
                onConsentAckChange={setConsentAck}
                onUpdateChild={handleUpdateSlot}
                acknowledgedConfirmationIds={acknowledgedConfirmationIds}
                onToggleConfirmation={handleToggleConfirmation}
              />
            </div>
            <div className="shrink-0 border-t border-slate-200 bg-white/90 px-5 py-4 space-y-3">
              <div className="flex gap-3">
                <Button
                  variant="outline"
                  size="lg"
                  className="h-14 rounded-2xl border-slate-300 bg-white px-5 text-slate-900 hover:bg-slate-50"
                  onClick={() =>
                    setStage((member?.savedChildren?.length ?? 0) > 0 ? 'savedChildren' : 'tickets')
                  }
                >
                  <ArrowLeft className="mr-2 h-5 w-5" /> {t('common.back')}
                </Button>
                <Button
                  size="lg"
                  disabled={!consentOk}
                  className="h-14 flex-1 rounded-2xl text-lg font-bold gap-2"
                  onClick={() => setStage('pay')}
                >
                  {t('book.supervise.continueToPayment')}
                  <ArrowRight className="h-5 w-5" />
                </Button>
              </div>
            </div>
          </div>
        )}

        {stage === 'pay' && (
          <BookPayment
            total={total}
            onBack={() => setStage(superSlots.length > 0 ? 'supervise' : 'tickets')}
            onPay={handlePay}
          />
        )}

        {stage === 'confirmation' && booking && (
          <BookConfirmation
            booking={booking}
            name={nickname}
            onStartOver={handleStartOver}
          />
        )}
      </div>
    </div>
  );
}
