import { useEffect, useMemo, useRef, useState } from 'react';
import { useLocation } from 'wouter';
import { CustomerTier, CartLine, CheckIn, ContactChannel, Discount, ManualDiscount, Sale, TicketType, Member, TierVerification, DropOffServiceType, AddOn, SelectedAddOn, INVENTORY_DEFAULT_VARIANT_ID } from '@/types';
import type { DiscountComponentOption } from '@/components/shared/ManualDiscountModal';
import { useStation } from '@/station/StationContext';
import { braceletPrintJobs, dispatchPrintJobs, promptSetupStation, ticketPrintJobs } from '@/lib/printRouting';
import { takeCorrectedOrder } from '@/lib/correctedOrder';
import { takeDropOffHandoff } from '@/lib/dropoffHandoff';
import { useCustomerDisplayPref } from '@/lib/customerDisplayPref';
import { useCustomerTheme } from '@/lib/themePref';
import { computeLineTotal, computeLineBreakdown, priceForTier } from '@/lib/pricing';
import { resolveRateToday } from '@/lib/pricingMode';
import { makeDropOffLine, normalizeDropOffFees, resolveDropOffPricing } from '@/lib/dropoff';
import { resolveGroupRequirements, effectiveRequirement, resolveSupervisionOutcome, buildAcknowledgedConfirmations } from '@/lib/supervision';
import { buildSale, computeTotals } from '@/lib/sale';
import { dropOrphanedDiscounts } from '@/lib/manualDiscount';
import { resolveAutoTier } from '@/lib/membership';
import { getInventoryItem, getAddOns } from '@/store/catalogStore';
import { getDiscountReasons, getMemberByPhone, getMemberById, createMember, updateMember, verifyMemberTier, recordSale, getTicketTypes, getDropOffPricing, getCheckInsByRegistration, checkInFamilyWithPayment, linkCheckInSaleId, getDefaultTier, getSupervisionPolicy, registerWalkInChildren, recordSupervisionWaiver, getAllBookings, redeemBooking, pushWristband, markCheckInsBooked, getActiveEventPasses, getEventById, addSavedChild, updateSavedChild, removeSavedChild, getDiscountByCode, incrementPromoUsage, initWalletLedger, ensureSaleGrantWallet, issueWalkInBands, issueBookingBands, type CheckInPaymentInput, type NewEventAttendeeInput } from '@/mockApi';
import { useBranch } from '@/branch/BranchContext';
import { validatePromoCode, resolveFreeItem } from '@/lib/promoVoucher';
import { SavedChildrenReview } from '@/components/shared/SavedChildrenReview';
import { prefillSlots, slotPatchFromSavedChild, savedChildInputFromSlot } from '@/lib/savedChildren';
import type { SavedChild } from '@/types';
import { sellEventPass, checkInSoldPass } from '@/lib/eventPass';
import { AddAttendeeModal } from '@/components/parties/AddAttendeeModal';
import type { OtoEvent, EventAttendee } from '@/types';
import { StationHeader } from '@/components/shared/StationHeader';
import { OverstayBanner } from '@/components/dropoff/OverstayBanner';
import { Button } from '@/components/ui/button';
import { Monitor, User } from 'lucide-react';

import { useOperator } from '@/auth/OperatorContext';
import { toast } from '@/hooks/use-toast';
import { authApi, membersApi } from '@/api/platform';
import { apiMemberToMember } from '@/api/mappers';
import { VisitChildrenModal } from '@/components/till/VisitChildrenModal';
import { OrderSummary } from '@/components/till/OrderSummary';
import { StepIdentify } from '@/components/till/StepIdentify';
import { StepCustomerType } from '@/components/till/StepCustomerType';
import { StepAddTicket } from '@/components/till/StepAddTicket';
import { DropOffLineConfig, type DropOffLineUpdate } from '@/components/till/DropOffLineConfig';
import { AddDropOffModal } from '@/components/till/AddDropOffModal';
import { StepAwaitCustomer } from '@/components/till/StepAwaitCustomer';
import { StepPayment } from '@/components/till/StepPayment';
import { StepConfirmation } from '@/components/till/StepConfirmation';
import { ManualDiscountModal } from '@/components/shared/ManualDiscountModal';
import { VerifyTierModal } from '@/components/shared/VerifyTierModal';
import { CustomerDisplay, CustomerStage } from '@/components/till/CustomerDisplay';
import { SupervisionGate, slotAge, type SupervisedSlot } from '@/components/till/SupervisionGate';
import { ConsentCapture } from '@/components/till/ConsentCapture';
import { RedeemBookingModal } from '@/components/till/RedeemBookingModal';
import { DoorCheckInChoiceModal, type DoorCheckInGroup } from '@/components/till/DoorCheckInChoiceModal';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Baby } from 'lucide-react';
import type { Booking } from '@/types';

// Break a ticket line into its discountable component rows (kids/adults/socks/
// each add-on) for the manual-discount picker. Mirrors computeLineBreakdown so
// each component's ฿ base matches what the customer sees on that row.
function lineDiscountComponents(line: CartLine): DiscountComponentOption[] {
  return computeLineBreakdown(line).map((item) => ({
    target:
      item.kind === 'addon'
        ? { kind: 'addon', addOnId: item.key }
        : { kind: item.kind },
    label: item.quantity > 1 ? `${item.label} × ${item.quantity}` : item.label,
    amount: item.subtotal,
  }));
}

export default function Till() {
  const { operator } = useOperator();
  const { station } = useStation();
  const { branch } = useBranch();
  const [, navigate] = useLocation();
  const [step, setStep] = useState<number>(1);
  const [tier, setTier] = useState<CustomerTier | null>(null);
  const [lines, setLines] = useState<CartLine[]>([]);
  const [discounts, setDiscounts] = useState<Discount[]>([]);
  const [manualDiscounts, setManualDiscounts] = useState<ManualDiscount[]>([]);
  const [customerPhone, setCustomerPhone] = useState<string>('');
  const [customerNickname, setCustomerNickname] = useState<string>('');
  const [customerContactChannel, setCustomerContactChannel] = useState<ContactChannel>('whatsapp');

  // Changing channel mid-flow both updates the live draft AND, if the person is
  // already an identified member, persists the new preference for next visit
  // (same "save per member" behaviour as saved tier / saved children).
  const handleCustomerContactChannelChange = (channel: ContactChannel) => {
    setCustomerContactChannel(channel);
    // Persist the preference on the API-backed member profile (fire and forget).
    if (member) void membersApi.update(member.id, { preferredChannel: channel }).catch(() => {});
  };
  const [activeLineId, setActiveLineId] = useState<string | null>(null);

  const [member, setMember] = useState<Member | null>(null);
  const [showVerifyModal, setShowVerifyModal] = useState(false);
  const [verifyTier, setVerifyTier] = useState<CustomerTier | null>(null);
  // A verification taken before the customer gave their details; saved to a
  // profile once they key in phone + nickname at the input step.
  const [pendingVerification, setPendingVerification] = useState<TierVerification | null>(null);

  const [showManualDiscountModal, setShowManualDiscountModal] = useState(false);
  const [showAddDropOff, setShowAddDropOff] = useState(false);
  const [saleResult, setSaleResult] = useState<Sale | null>(null);
  const [promoError, setPromoError] = useState<string>('');

  // Event-pass flow — selling a flat-priced camp/event entry is self-contained
  // (capture → pay → check-in choice) and never touches the tier cart, so it runs
  // through its own modal rather than the wizard step machine.
  const [eventPassFor, setEventPassFor] = useState<OtoEvent | null>(null);
  // The attendee persisted by the sell step, carried into the later check-in choice.
  const [eventPassAttendee, setEventPassAttendee] = useState<EventAttendee | null>(null);
  // Re-derive active passes whenever the till re-renders after a sale closes.
  const [eventPassesTick, setEventPassesTick] = useState(0);
  const activeEventPasses = useMemo<OtoEvent[]>(
    () => getActiveEventPasses(new Date().toISOString().slice(0, 10), branch.id),
    [eventPassesTick, branch.id],
  );

  // Member identified for the event-pass pre-fill flow (may differ from the
  // main sale member when selling an event at step 1 before the ticket cart opens).
  const [eventPassPrefilledMember, setEventPassPrefilledMember] = useState<Member | null>(null);

  // "Capture guest name" mini-flow: triggered when staff sell an event pass to an
  // unrecognised phone that has no nickname yet. We need at least a name to create
  // the member record so they're remembered next time.
  const [captureNameFor, setCaptureNameFor] = useState<OtoEvent | null>(null);
  const [captureNameInput, setCaptureNameInput] = useState<string>('');

  const closeEventPass = () => {
    setEventPassFor(null);
    setEventPassAttendee(null);
    setEventPassPrefilledMember(null);
    setEventPassesTick((t) => t + 1);
  };

  // Step 1 of the pass flow: create + bill the attendee (at payment confirmation).
  // Returns false so the modal stays put if the sale could not be persisted.
  const handleEventPassSell = (result: {
    input: NewEventAttendeeInput;
    registerProperly: boolean;
    paymentMethod?: string;
  }): boolean => {
    const ev = eventPassFor;
    if (!ev || !operator) return false;
    const attendee = sellEventPass({
      event: ev,
      input: result.input,
      registerProperly: result.registerProperly,
      paymentMethod: result.paymentMethod,
      today: new Date().toISOString().slice(0, 10),
      operator: { operatorName: operator.name, operatorId: operator.id },
    });
    if (!attendee) {
      toast({ title: 'Could not sell pass', description: 'Payment or event details missing.' });
      return false;
    }
    setEventPassAttendee(attendee);
    return true;
  };

  // Step 2: resolve the check-in choice for the already-persisted attendee.
  const handleEventPassCheckIn = (checkInNow: boolean) => {
    const ev = eventPassFor;
    const attendee = eventPassAttendee;
    if (!ev || !attendee || !operator) {
      closeEventPass();
      return;
    }
    if (checkInNow) {
      const res = checkInSoldPass(station, ev, attendee.id, new Date().toISOString().slice(0, 10), {
        operatorName: operator.name,
        operatorId: operator.id,
      });
      if (res) {
        toast({
          title: 'Pass sold — checked in',
          description: `${res.checkin.attendee.name} — band ${res.checkin.wristbandCode}${
            res.checkin.parentWristbandCode ? ` · parent ${res.checkin.parentWristbandCode}` : ''
          }${res.printed ? '' : ' · no printer — band not printed'}`,
        });
      } else {
        toast({ title: 'Pass sold', description: `${attendee.name} is on the ${ev.title} roster.` });
      }
    } else {
      toast({
        title: 'Pass sold — left as booked',
        description: `${attendee.name} added to ${ev.title}. Check in later from the roster.`,
      });
    }
    closeEventPass();
  };

  // Booking redemption flow
  const [showRedeemModal, setShowRedeemModal] = useState(false);
  // Holds a booking's registrationId after the regular guest sale is issued,
  // while waiting for the staff to confirm or skip the drop-off check-in.
  const [pendingDropOffRegistration, setPendingDropOffRegistration] = useState<{
    registrationId: string;
    childNames: string[];
  } | null>(null);
  const [showCustomerDisplay, setShowCustomerDisplay] = useCustomerDisplayPref();
  const [customerTheme] = useCustomerTheme();
  const [pendingPaymentMethod, setPendingPaymentMethod] = useState<string | null>(null);

  // Post-payment door check-in choice: drop-off / nanny registrations awaiting a
  // "check in now / leave as booked" decision. The booked play-start time chosen
  // at payment is held in a ref so each "leave as booked" entry records it.
  const [pendingCheckInChoices, setPendingCheckInChoices] = useState<DoorCheckInGroup[] | null>(null);
  const bookedScheduledForRef = useRef<string>('');

  // Door-flow supervision gate (step 7): when a ticket sale is unaccompanied
  // (no adults + anonymous kids) staff must name + age each child so the policy
  // can resolve who needs a nanny / drop-off, and the parent gives consent on
  // the customer screen. The whole draft is LIFTED here so both screens read it.
  const [superSlots, setSuperSlots] = useState<SupervisedSlot[]>([]);
  const [superParentName, setSuperParentName] = useState<string>('');
  const [superParentPhone, setSuperParentPhone] = useState<string>('');
  const [superParentContactMethod, setSuperParentContactMethod] = useState<ContactChannel>('whatsapp');
  const [superConsentAck, setSuperConsentAck] = useState<boolean>(false);
  // Confirmations checklist ticked on the customer screen (admin-configurable,
  // policy.confirmations) — required for ANY unaccompanied registration, not
  // just supervised ones (e.g. an all-9+ group still sees + ticks this).
  const [superAcknowledgedConfirmationIds, setSuperAcknowledgedConfirmationIds] = useState<string[]>([]);
  // Slot ids the parent re-confirmed on the saved-children review step (step 8).
  const [confirmedSavedIds, setConfirmedSavedIds] = useState<string[]>([]);
  // True once the gate has resolved + converted the anonymous kids, so re-pressing
  // Pay (e.g. after assigning a nanny at step 3) doesn't re-open the gate.
  const [supervisionResolved, setSupervisionResolved] = useState<boolean>(false);

  const dropOffPricing = useMemo(() => resolveDropOffPricing(getDropOffPricing()), []);

  // Consume a "start corrected order" handoff from the History screen (after a
  // refund). Preloads the tier + lines (with fresh ids) and drops staff at the
  // ticket step to review and re-charge. Runs once on mount.
  useEffect(() => {
    const correction = takeCorrectedOrder();
    if (!correction || correction.kind !== 'ticket') return;
    setTier(correction.tier);
    setLines(correction.lines.map((l) => ({ ...l, id: Math.random().toString(36).substring(7) })));
    if (correction.customerPhone) setCustomerPhone(correction.customerPhone);
    if (correction.customerNickname) setCustomerNickname(correction.customerNickname);
    setStep(3);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Shared helper: load a drop-off registration into the till as drop-off lines.
  // Used by both the handoff useEffect and the booking redemption "Check in now" flow.
  const loadDropOffRegistration = (registrationId: string) => {
    const children = getCheckInsByRegistration(registrationId).filter((c) => c.status === 'registered');
    if (children.length === 0) return;
    const phone = children[0]?.phone ?? '';
    const found = phone ? getMemberByPhone(phone) : null;
    const resolvedTier = found ? resolveAutoTier(found) : getDefaultTier().id;
    const defaultTicket = getTicketTypes()[0];
    setMember(found);
    if (phone) setCustomerPhone(phone);
    if (found?.nickname) setCustomerNickname(found.nickname);
    setTier(resolvedTier);
    const dropOffLines = normalizeDropOffFees(
      children.map((ci) =>
        makeDropOffLine({
          ci,
          ticket: defaultTicket,
          tier: resolvedTier,
          service: ci.serviceType,
          lengthChosen: false,
          nannyId: ci.assignedNannyId,
          nannyName: ci.assignedNannyName,
          pricing: dropOffPricing,
        }),
      ),
      dropOffPricing,
    );
    setLines(dropOffLines);
    setActiveLineId(dropOffLines[0].id);
    setStep(2);
  };

  // Consume a "Check in" handoff from the Drop-Off board (Direction 1). Preloads
  // the registration's registered children as drop-off lines, resolves the
  // parent's member tier by phone, and drops staff at the tier step so they
  // confirm the rate before configuring/paying. Runs once on mount.
  useEffect(() => {
    const registrationId = takeDropOffHandoff();
    if (!registrationId) return;
    loadDropOffRegistration(registrationId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const resetSale = () => {
    setStep(1);
    setTier(null);
    setLines([]);
    setDiscounts([]);
    setManualDiscounts([]);
    setCustomerPhone('');
    setCustomerNickname('');
    setCustomerContactChannel('whatsapp');
    setActiveLineId(null);
    setSaleResult(null);
    setPendingPaymentMethod(null);
    setPendingCheckInChoices(null);
    setMember(null);
    setShowVerifyModal(false);
    setVerifyTier(null);
    setPendingVerification(null);
    setSuperSlots([]);
    setSuperParentName('');
    setSuperConsentAck(false);
    setSuperAcknowledgedConfirmationIds([]);
    setConfirmedSavedIds([]);
    setSupervisionResolved(false);
  };

  // Customer entered their phone on their display — look up any verified rate.
  // SCRUM-30 (rebuild): the lookup typed on the customer display reaches the
  // till THROUGH THE API — staged as a short-lived pending lookup on the
  // session, consumed here, then resolved against /members/lookup. The
  // props link between the two panes remains only a render harness.
  const handleIdentify = () => {
    void (async () => {
      const typed = customerPhone.trim();
      try {
        let phone = typed;
        if (typed) {
          await authApi.stagePendingLookup(typed); // customer display → API
          const staged = await authApi.consumePendingLookup(); // API → till
          phone = staged.phone ?? typed;
        }
        const found = phone ? (await membersApi.lookup(phone)).member : null;
        const mapped = found ? apiMemberToMember(found) : null;
        setMember(mapped);
        if (mapped) {
          setTier(resolveAutoTier(mapped));
          if (mapped.preferredChannel) setCustomerContactChannel(mapped.preferredChannel);
          if ((mapped.savedChildren?.length ?? 0) > 0) setShowVisitChildren(true);
        } else if (phone) {
          // SCRUM-31: nobody found → offer the create-member path.
          setOfferCreateMember(true);
        }
      } catch (err) {
        toast({
          title: 'Membership lookup failed',
          description: err instanceof Error ? err.message : 'Unknown error',
          variant: 'destructive',
        });
        setMember(null);
      }
      setStep(2);
    })();
  };

  // Walk-in: no membership, default to Tourist.
  const handleSkipIdentify = () => {
    setMember(null);
    setStep(2);
  };

  // SCRUM-32 — children re-confirm modal state (opens after a lookup finds
  // saved children); SCRUM-31 — create-member offer when lookup finds nobody.
  const [showVisitChildren, setShowVisitChildren] = useState(false);
  const [offerCreateMember, setOfferCreateMember] = useState(false);
  const [createBusy, setCreateBusy] = useState(false);

  const handleCreateMember = () => {
    const phone = customerPhone.trim();
    const nickname = customerNickname.trim();
    if (!phone || !nickname || createBusy) return;
    setCreateBusy(true);
    void membersApi
      .create({ phone, nickname, preferredChannel: customerContactChannel })
      .then((res) => {
        const mapped = apiMemberToMember(res.member);
        setMember(mapped);
        setCustomerPhone(mapped.phone);
        setTier(resolveAutoTier(mapped));
        setOfferCreateMember(false);
        toast({ title: 'Member created', description: `${mapped.nickname} · ${mapped.phone}` });
      })
      .catch((err) => {
        toast({
          title: "Couldn't create the member",
          description: err instanceof Error ? err.message : 'Unknown error',
          variant: 'destructive',
        });
      })
      .finally(() => setCreateBusy(false));
  };

  /**
   * Sell an event pass from the identify step. We try to identify the customer
   * first so the attendee form can be pre-filled for returning customers:
   *
   *  - Known phone   → member found; carry it into AddAttendeeModal pre-fill.
   *  - Unknown phone + nickname available → create member on the spot, then pre-fill.
   *  - Unknown phone + no nickname yet    → show a mini "enter your name" dialog,
   *                                        then create the member and open the modal.
   *  - No phone at all → open the modal cold (walk-in, no pre-fill).
   */
  const handleSellEventPassFromStep1 = (event: OtoEvent) => {
    const phone = customerPhone.trim();
    if (!phone) {
      // No phone entered — open cold.
      setEventPassPrefilledMember(null);
      setEventPassFor(event);
      return;
    }

    const found = getMemberByPhone(phone);
    if (found) {
      // Recognised member — carry into pre-fill.
      setMember(found);
      setCustomerPhone(found.phone);
      if (found.nickname) setCustomerNickname(found.nickname);
      setEventPassPrefilledMember(found);
      setEventPassFor(event);
      return;
    }

    // Unknown phone — need a name to create the member record.
    const name = customerNickname.trim();
    if (name) {
      const newMember = createMember(phone, name);
      setMember(newMember);
      setEventPassPrefilledMember(newMember);
      setEventPassFor(event);
    } else {
      // No nickname yet — prompt staff for it.
      setCaptureNameInput('');
      setCaptureNameFor(event);
    }
  };

  // Staff confirmed a paid booking in the RedeemBookingModal. Build + record the
  // regular-guest sale (drop-off lines are excluded — they get their own check-in
  // flow), issue wristbands, dispatch print jobs, mark the booking as redeemed,
  // then offer to check in any drop-off children via the existing registration flow.
  const handleRedeemConfirm = (booking: Booking) => {
    if (!operator) return;

    // Regular-guest lines only (drop-off lines are checked in separately).
    const regularLines = booking.lines.filter((l) => !l.dropOff);
    // Derive counts directly from the lines we're about to issue — never from
    // booking.willIssue (which includes drop-off children) or sale.creditGrants
    // (which doesn't map 1:1 to wristbands across ticket configurations).
    const regularAdults = regularLines.reduce((s, l) => s + l.adults, 0);
    const regularKids = regularLines.reduce((s, l) => s + l.kids, 0);

    const mintedCodes: string[] = [];
    if (regularLines.length > 0) {
      const sale = buildSale({
        operatorId: operator.id,
        operatorName: operator.name,
        tier: booking.tier,
        lines: regularLines,
        discounts: booking.promoDiscount ? [booking.promoDiscount] : [],
        manualDiscounts: [],
        memberId: booking.memberId,
        customerPhone: '',
        customerNickname: '',
        paymentMethod: booking.paymentMethod,
        bookingReference: booking.reference,
      });
      recordSale(sale);
      // Track usage for promo codes embedded in the booking at redemption time.
      if (booking.promoDiscount) {
        incrementPromoUsage(booking.promoDiscount.code, customerPhone || member?.phone || undefined);
      }

      // Mint every wristband for the booking from each ticket's own package:
      // credit-earning persons (adults and/or kids per the ticket's credit rule)
      // get a scannable wallet band; everyone else gets a 0-balance gate/plain
      // band. Gate access comes purely from the ticket — not a park-wide config.
      mintedCodes.push(...issueBookingBands(sale, operator?.name));

      if (station) {
        dispatchPrintJobs(ticketPrintJobs(station, sale));
      }
    }

    // Atomic guard: redeemBooking returns null if the booking was already
    // redeemed by a concurrent confirmation (race condition). Abort before
    // showing a success toast — wristbands minted above won't cause double
    // credit because the sale was already recorded (it's in History).
    const redeemed = redeemBooking(booking.reference, mintedCodes);
    if (!redeemed) {
      toast({
        title: 'Already redeemed',
        description: `${booking.reference} was already redeemed. No additional wristbands issued.`,
        variant: 'destructive',
      });
      return;
    }

    toast({
      title: 'Booking redeemed',
      description: `${booking.reference} — ${mintedCodes.length} wristband(s) issued.`,
    });

    // Event passes sold online are registered (not checked in) attendees. On
    // redemption, check each one into its event — minting bracelets and marking
    // attended, with NO re-payment (already paid at booking). checkInSoldPass is
    // idempotent: an attendee already checked in returns null and is skipped, so
    // re-scanning a mixed booking won't double-issue event bracelets.
    if (booking.eventPasses && booking.eventPasses.length > 0) {
      const today = new Date().toISOString().slice(0, 10);
      let checkedIn = 0;
      for (const pass of booking.eventPasses) {
        const ev = getEventById(pass.eventId);
        if (!ev) continue;
        const res = checkInSoldPass(station, ev, pass.attendeeId, today, {
          operatorName: operator.name,
          operatorId: operator.id,
        });
        if (res) checkedIn++;
      }
      if (checkedIn > 0) {
        toast({
          title: 'Event passes checked in',
          description: `${checkedIn} attendee(s) checked into their event — bracelets printed.`,
        });
      }
    }

    // If the booking has drop-off children, prompt staff to check them in now.
    if (booking.registrationId) {
      const dropOffNames = booking.lines.flatMap((l) => l.dropOff ? [l.dropOff.childName] : []);
      setPendingDropOffRegistration({ registrationId: booking.registrationId, childNames: dropOffNames });
    }
  };

  // Re-price every line to a newly-picked tier. Normal lines recompute via
  // computeLineTotal; drop-off lines keep their (tier-independent) service fee
  // but re-price the play ticket. Keeps each line's stamped tier in sync.
  const restateLinesToTier = (t: CustomerTier) => {
    setLines((prev) =>
      normalizeDropOffFees(
        prev.map((l) => ({
          ...l,
          tier: t,
          // Drop-off lineTotals are re-derived by normalizeDropOffFees below.
          lineTotal: l.dropOff ? l.lineTotal : computeLineTotal({ ...l, tier: t }),
        })),
        dropOffPricing,
      ),
    );
  };

  // Pick a tier allowed without fresh proof (tourist or already-verified).
  const handlePickTier = (t: CustomerTier) => {
    setTier(t);
    restateLinesToTier(t);
    setStep(3);
  };

  // Discounted tier with no verification yet — open the proof modal.
  const handleRequestVerify = (t: CustomerTier) => {
    setVerifyTier(t);
    setShowVerifyModal(true);
  };

  // Proof confirmed: apply the tier and advance to ticketing. For an existing
  // member the verification was already stamped in the modal; for a new customer
  // we hold it until they enter their details at the input step.
  const handleVerified = ({
    member: verified,
    verification,
  }: {
    member: Member | null;
    verification: TierVerification;
  }) => {
    setTier(verification.tier);
    restateLinesToTier(verification.tier);
    if (verified) {
      setMember(verified);
      if (verified.phone) setCustomerPhone(verified.phone);
      if (verified.nickname) setCustomerNickname(verified.nickname);
    } else {
      setPendingVerification(verification);
    }
    setStep(3);
  };


  const handleRemoveLine = (id: string) => {
    // Removing a line changes the cart composition — re-run supervision if needed.
    setSupervisionResolved(false);
    // Re-normalize after removal: if the removed line was a nanny group's fee
    // owner, the shared fee must re-attach to a surviving sibling (or vanish if
    // the group is now empty) — never silently dropped.
    setLines(prev => {
      const next = normalizeDropOffFees(
        prev.filter(l => l.id !== id),
        dropOffPricing,
      );
      // Drop any manual discounts orphaned by the removal.
      setManualDiscounts(mds => dropOrphanedDiscounts(mds, next));
      return next;
    });
    setActiveLineId(prev => (prev === id ? null : prev));
  };

  const handleApplyManualDiscount = (md: ManualDiscount) => {
    setManualDiscounts(prev => [...prev, md]);
  };

  const handleRemoveManualDiscount = (id: string) => {
    setManualDiscounts(prev => prev.filter(md => md.id !== id));
  };

  /**
   * Validate and apply a promo code entered at the order summary. Rejects with
   * a specific reason (shown inline) if the code is unknown, expired, over limit,
   * inactive, or doesn't apply to anything in the current cart.
   */
  const handleApplyPromoCode = (code: string) => {
    const promo = getDiscountByCode(code);
    if (!promo) {
      setPromoError(`Code "${code.toUpperCase()}" was not found.`);
      return;
    }
    const today = new Date().toISOString().slice(0, 10);
    const custKey = customerPhone || member?.phone || undefined;
    const result = validatePromoCode(promo, lines, today, custKey, discounts);
    if (!result.ok) {
      setPromoError(result.reason);
      return;
    }
    setPromoError('');
    if (promo.type === 'free_item') {
      // Inject the item as a synthetic CartLine at its shelf price so that:
      //  subtotal  = ticket total + item.priceTHB
      //  discount  = item.priceTHB  (pre-resolved into discount.value)
      //  grandTotal = ticket total  (unchanged for the customer)
      // EOD markdown reporting records discountAmount = item.priceTHB.
      const item = resolveFreeItem(promo);
      if (!item) { setPromoError(`Code "${code.toUpperCase()}" item is no longer available.`); return; }
      const resolvedPromo = { ...promo, value: item.priceTHB };
      const stubTicketType = lines.find(l => !l.promoItem)!.ticketType;
      // Tie the synthetic line to its code so removing one of several stacked
      // promos drops exactly that promo's free-item line.
      const promoLine: CartLine = {
        id: `promo-${promo.code}`,
        ticketType: stubTicketType,
        tier: tier!,
        kids: 0, adults: 0, socks: 0, addOns: [],
        lineTotal: item.priceTHB,
        promoItem: { itemId: promo.freeItemId!, itemKind: promo.freeItemKind ?? 'menu', name: item.name, priceTHB: item.priceTHB },
      };
      setLines(prev => [...prev, promoLine]);
      setDiscounts(prev => [...prev, resolvedPromo]);
    } else {
      setDiscounts(prev => [...prev, promo]);
    }
  };

  /** Remove one applied promo code (and its free-item line, if any). */
  const handleRemoveDiscount = (code: string) => {
    setDiscounts(prev => prev.filter(d => d.code !== code));
    setLines(prev => prev.filter(l => l.id !== `promo-${code}`));
    setPromoError('');
  };

  const handleSelectTicket = (ticket: TicketType) => {
    if (!tier) return;
    const id = Math.random().toString(36).substring(7);
    const base = { ticketType: ticket, tier, kids: 1, adults: 1, socks: 0, addOns: [] };
    const line: CartLine = {
      id,
      ...base,
      lineTotal: computeLineTotal(base),
    };
    setLines(prev => [...prev, line]);
    setActiveLineId(id);
    // The anonymous-kid composition changed — any prior supervision resolution
    // is stale and must re-run before payment.
    setSupervisionResolved(false);
  };

  // Attach registered children (from the Add-drop-off picker) as drop-off lines,
  // skipping any already in the cart. New siblings inherit length + service from
  // the first already-configured drop-off child (editable); if none is configured
  // yet they start unconfigured so staff pick a length. `serviceOverride` lets the
  // add-sibling toggle force Drop-off vs Nanny for a freshly-added child.
  const handleAttachDropOff = (
    children: CheckIn[],
    serviceOverride?: DropOffServiceType,
  ) => {
    const activeTier = tier ?? getDefaultTier().id;
    if (!tier) setTier(activeTier);
    const defaultTicket = getTicketTypes()[0];
    setLines((prev) => {
      const present = new Set(
        prev.filter((l) => l.dropOff).map((l) => l.dropOff!.checkInId),
      );
      const template = prev.find((l) => l.dropOff?.lengthChosen);
      const additions = children
        .filter((ci) => !present.has(ci.id))
        .map((ci) =>
          makeDropOffLine({
            ci,
            ticket: template ? template.ticketType : defaultTicket,
            tier: activeTier,
            service: serviceOverride ?? template?.dropOff?.service ?? ci.serviceType,
            lengthChosen: !!template,
            nannyId: ci.assignedNannyId,
            nannyName: ci.assignedNannyName,
            pricing: dropOffPricing,
          }),
        );
      if (additions.length > 0) setActiveLineId(additions[0].id);
      return normalizeDropOffFees([...prev, ...additions], dropOffPricing);
    });
    setShowAddDropOff(false);
    setStep(3);
  };

  // Other drop-off nanny lines in THIS cart per nannyId (excludes the given line)
  // — feeds the picker's load badges. The 1:1 ratio is relaxed, so this is for
  // display/soft-warning only, never a hard block.
  const cartNannyLoadsFor = (lineId: string): Record<string, number> => {
    const loads: Record<string, number> = {};
    for (const l of lines) {
      if (l.id === lineId) continue;
      const nid = l.dropOff?.service === 'nanny' ? l.dropOff.nannyId : undefined;
      if (nid) loads[nid] = (loads[nid] ?? 0) + 1;
    }
    return loads;
  };

  // "Same nanny for all": assign the chosen nanny to every nanny drop-off line.
  const handleAssignNannyToAll = (nannyId: string, nannyName: string) => {
    setLines((prev) =>
      normalizeDropOffFees(
        prev.map((l) =>
          l.dropOff?.service === 'nanny'
            ? { ...l, dropOff: { ...l.dropOff, nannyId, nannyName } }
            : l,
        ),
        dropOffPricing,
      ),
    );
  };

  // Apply a semantic config change to a drop-off line, then re-derive every
  // drop-off line's shared fee + total across the cart. Picking a ticket marks
  // the length chosen; switching to plain drop-off releases any chosen nanny.
  const handleUpdateDropOffLine = (id: string, update: DropOffLineUpdate) => {
    setLines((prev) =>
      normalizeDropOffFees(
        prev.map((l) => {
          if (l.id !== id || !l.dropOff) return l;
          const ticketType = update.ticketType ?? l.ticketType;
          const lengthChosen = update.ticketType ? true : l.dropOff.lengthChosen;
          const service = update.service ?? l.dropOff.service;
          const nannyId =
            service === 'nanny' ? update.nannyId ?? l.dropOff.nannyId : undefined;
          const nannyName =
            service === 'nanny' ? update.nannyName ?? l.dropOff.nannyName : undefined;
          return {
            ...l,
            ticketType,
            dropOff: {
              ...l.dropOff,
              service,
              hours: ticketType.hours,
              lengthChosen,
              nannyId,
              nannyName,
            },
          };
        }),
        dropOffPricing,
      ),
    );
  };

  // A drop-off child's extras (socks / add-ons) change. Re-run normalizeDropOffFees
  // (not the plain per-line path) so the nested drop-off service fee is preserved
  // and re-priced into lineTotal alongside the new socks/add-ons.
  const handleUpdateDropOffExtras = (
    id: string,
    updates: { socks?: number; addOns?: SelectedAddOn[] }
  ) => {
    setLines((prev) =>
      normalizeDropOffFees(
        prev.map((l) => (l.id === id && l.dropOff ? { ...l, ...updates } : l)),
        dropOffPricing,
      ),
    );
  };

  const handleConfigureLine = (id: string) => {
    setActiveLineId(id);
    setStep(3);
  };

  // The nanny already assigned to another drop-off child in the cart (if any) —
  // lets DropOffLineConfig offer a one-tap "same nanny as the others" for a sibling.
  const siblingNannyFor = (lineId: string): { id: string; name: string } | undefined => {
    for (const l of lines) {
      if (l.id === lineId) continue;
      if (l.dropOff?.service === 'nanny' && l.dropOff.nannyId) {
        return { id: l.dropOff.nannyId, name: l.dropOff.nannyName ?? '' };
      }
    }
    return undefined;
  };

  // Finishing one drop-off child should flow straight into the next sibling that
  // still needs configuring (length not set, or nanny service without a nanny).
  // Once every drop-off child is configured, fall back to the ticket grid.
  const handleDropOffLineDone = () => {
    const nextUnconfigured = lines.find(
      (l) =>
        l.id !== activeLineId &&
        l.dropOff &&
        (!l.dropOff.lengthChosen ||
          (l.dropOff.service === 'nanny' && !l.dropOff.nannyId)),
    );
    if (nextUnconfigured) {
      setActiveLineId(nextUnconfigured.id);
      return;
    }
    handleBackToGrid();
  };

  const handleUpdateLine = (
    id: string,
    updates: Partial<Pick<CartLine, 'kids' | 'adults' | 'socks' | 'addOns'>>
  ) => {
    // Editing participants changes the cart composition — re-run supervision.
    setSupervisionResolved(false);
    setLines(prev => {
      const next = prev.flatMap(l => {
        if (l.id !== id) return [l];
        const merged = { ...l, ...updates };
        // A line with no participants is invalid — drop it.
        if (merged.kids + merged.adults === 0) return [];
        return [{ ...merged, lineTotal: computeLineTotal(merged) }];
      });
      // Drop manual discounts orphaned by this edit (removed line, or a
      // component-scoped discount whose component dropped to 0).
      setManualDiscounts(mds => dropOrphanedDiscounts(mds, next));
      return next;
    });
    setActiveLineId(prev => {
      if (prev !== id) return prev;
      const target = lines.find(l => l.id === id);
      if (!target) return prev;
      const kids = updates.kids ?? target.kids;
      const adults = updates.adults ?? target.adults;
      return kids + adults === 0 ? null : prev;
    });
  };

  const dropEmptyActiveLine = () => {
    setLines(prev => {
      const next = prev.filter(l => l.id !== activeLineId || l.kids + l.adults > 0);
      setManualDiscounts(mds => dropOrphanedDiscounts(mds, next));
      return next;
    });
  };

  const handleBackToGrid = () => {
    dropEmptyActiveLine();
    setActiveLineId(null);
  };

  // An unaccompanied ticket sale = no adults but at least one anonymous kid on a
  // regular (non-drop-off) line. Those kids haven't been age-checked, so the
  // supervision policy can't yet say who needs a nanny / drop-off.
  const evaluateUnaccompanied = () =>
    lines
      .filter((l) => !l.dropOff)
      .reduce((a, l) => a + l.adults, 0) === 0 &&
    lines.filter((l) => !l.dropOff).reduce((a, l) => a + l.kids, 0) > 0;

  // Open the door-flow supervision gate: one editable slot per anonymous kid,
  // remembering which cart line (and ticket) it came from for the conversion.
  const openSupervisionGate = () => {
    const slots: SupervisedSlot[] = [];
    for (const l of lines) {
      if (l.dropOff) continue;
      for (let i = 0; i < l.kids; i++) {
        slots.push({
          id: `slot-${Math.random().toString(36).substring(2, 9)}`,
          sourceLineId: l.id,
          ticketType: l.ticketType,
          name: '',
          age: '',
          waived: false,
          // Unaccompanied kids always run the full drop-off safety flow. For a
          // no-fee ('none') child this auto-enrolls them at ฿0 (no opt-in
          // button) so the "Tell us about your child" consent form appears
          // automatically; nanny/drop_off ignore this, waived-down kids stay
          // plain (resolveSupervisionOutcome keys opt-in off the BASE 'none').
          optIn: true,
          allergiesMedical: '',
          foodRestrictions: '',
          // Default: food not authorized until the parent explicitly chooses a
          // prepaid mode. The ConsentCapture picker enforces this on the customer
          // screen; mayOrderFood is derived from foodProvision.mode at registration.
          mayOrderFood: false,
          foodProvision: { mode: 'none', paidTHB: 0 },
          childPhotoUrl: undefined,
        });
      }
    }
    setSuperParentName('');
    setSuperParentPhone('');
    setSuperParentContactMethod('whatsapp');
    setSuperConsentAck(false);
    setSuperAcknowledgedConfirmationIds([]);
    setConfirmedSavedIds([]);
    // A returning member with saved children sees the re-confirm step first; their
    // details pre-fill the slots (text only, never the photo) but are applied only
    // after they confirm. First-timers / walk-ins skip straight to the gate.
    const saved = member?.savedChildren ?? [];
    if (saved.length > 0) {
      setSuperSlots(prefillSlots(slots, saved));
      setStep(8);
    } else {
      setSuperSlots(slots);
      setStep(7);
    }
  };

  const handleUpdateSlot = (id: string, patch: Partial<SupervisedSlot>) =>
    setSuperSlots((prev) => {
      const next = prev.map((s) => (s.id === id ? { ...s, ...patch } : s));
      // A waiver only holds while the child stays waiver-eligible. An age edit
      // (e.g. 6 → 3, which makes the child nanny-required) or losing the covering
      // sibling must auto-clear a now-stale waiver, or effectiveRequirement would
      // silently downgrade a mandatory requirement to 'none'.
      const resolved = resolveGroupRequirements(
        next
          .filter((s) => slotAge(s) !== null)
          .map((s) => ({ id: s.id, age: slotAge(s)! })),
        getSupervisionPolicy(),
      );
      const eligibleById = new Map(resolved.map((r) => [r.id, r.waiverEligible]));
      return next.map((s) =>
        s.waived && !eligibleById.get(s.id) ? { ...s, waived: false } : s,
      );
    });

  const handleToggleWaiver = (id: string) =>
    setSuperSlots((prev) => prev.map((s) => (s.id === id ? { ...s, waived: !s.waived } : s)));


  const handleSupervisionBack = () => {
    // Return to the ticket grid to edit the cart; the draft stays in memory and
    // is rebuilt fresh next time the gate opens (supervisionResolved is false).
    setStep(3);
  };

  // --- Saved-children review (step 8) handlers ------------------------------
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

  // Swap a different saved child into this slot (pre-fill, must re-confirm).
  const handleAssignSaved = (slotId: string, child: SavedChild) => {
    handleUpdateSlot(slotId, slotPatchFromSavedChild(child));
    setConfirmedSavedIds((prev) => prev.filter((x) => x !== slotId));
  };

  // Drop the saved-profile link and blank the slot — entered fresh as a new child.
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

  // Delete a saved child from the member's profile, then treat its slot as new.
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

  // Resolve the gate: convert each supervised kid into a drop-off line + walk-in
  // check-in, leave 'none'/waived kids as plain tickets, audit each waiver, then
  // route to nanny assignment (step 3) or straight to payment.
  const handleToggleConfirmation = (id: string) =>
    setSuperAcknowledgedConfirmationIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    );

  const handleSupervisionContinue = () => {
    if (!tier || !operator) return;
    const policy = getSupervisionPolicy();
    const resolved = resolveGroupRequirements(
      superSlots.map((s) => ({ id: s.id, age: slotAge(s) ?? -1 })),
      policy,
    );
    const reqById = new Map(resolved.map((r) => [r.id, r.requirement]));

    // Partition: supervised kids (nanny/drop-off) vs plain kids (none/waived).
    const supervised: { slot: SupervisedSlot; service: DropOffServiceType }[] = [];
    const plainBySource = new Map<string, number>();
    const waiversToAudit: { slot: SupervisedSlot; covering: SupervisedSlot }[] = [];

    for (const slot of superSlots) {
      const base = reqById.get(slot.id) ?? 'none';
      const outcome = resolveSupervisionOutcome(base, slot.waived, slot.optIn);
      if (slot.waived && base !== 'none') {
        // The covering sibling = the oldest OTHER child old enough to guardian.
        const covering = superSlots
          .filter(
            (o) =>
              o.id !== slot.id &&
              (slotAge(o) ?? -1) >= policy.siblingWaiver.guardianMinAge,
          )
          .sort((a, b) => (slotAge(b) ?? 0) - (slotAge(a) ?? 0))[0];
        if (covering) waiversToAudit.push({ slot, covering });
      }
      // outcome.service is 'nanny'/'drop_off' (mandatory) or 'none' (no-fee
      // opt-in) when the child should run the full flow, null when they stay a
      // plain ticket (unaffected 'none' or waived-down mandatory).
      if (outcome.service !== null) {
        supervised.push({ slot, service: outcome.service });
      } else {
        plainBySource.set(slot.sourceLineId, (plainBySource.get(slot.sourceLineId) ?? 0) + 1);
      }
    }

    // Register the supervised children as a walk-in group (consent already taken),
    // so checkInFamilyWithPayment can check them in atomically at payment.
    // Parent phone + contactMethod are shared across all siblings in the group —
    // autoSendWaConfirmation fires per child but only when phone is non-empty.
    const created = registerWalkInChildren(
      supervised.map(({ slot, service }) => ({
        name: slot.name,
        age: slotAge(slot) ?? 0,
        dateOfBirth: slot.dateOfBirth,
        service,
        parentName: superParentName,
        phone: superParentPhone,
        contactMethod: superParentContactMethod as ContactChannel,
        allergiesMedical: slot.allergiesMedical,
        foodRestrictions: slot.foodRestrictions,
        mayOrderFood: slot.mayOrderFood,
        foodProvision: slot.foodProvision,
        childPhotoUrl: slot.childPhotoUrl,
      })),
      {
        operatorName: operator.name,
        acknowledgedConfirmations: buildAcknowledgedConfirmations(policy, superAcknowledgedConfirmationIds),
      },
    );

    // Save / update each supervised child against the member's profile so they
    // pre-fill next visit. The photo is deliberately NOT saved (re-taken each
    // visit); a slot already linked to a saved child updates it, otherwise it's
    // added new. Walk-ins without a member are skipped (nothing to key against).
    if (member) {
      for (const { slot } of supervised) {
        const age = slotAge(slot);
        if (age === null) continue;
        const input = savedChildInputFromSlot(slot, age);
        if (slot.savedChildId) {
          updateSavedChild(member.id, slot.savedChildId, input);
        } else {
          addSavedChild(member.id, input, operator.name);
        }
      }
      setMember(getMemberById(member.id));
    }

    // Audit each staff-authorized sibling waiver.
    for (const { slot, covering } of waiversToAudit) {
      recordSupervisionWaiver(
        {
          childName: slot.name.trim() || 'Child',
          childAge: slotAge(slot) ?? 0,
          waivedRequirement: (reqById.get(slot.id) ?? 'drop_off') as 'drop_off' | 'nanny',
          coveringSiblingName: covering.name.trim() || 'Sibling',
          coveringSiblingAge: slotAge(covering) ?? 0,
        },
        { operatorName: operator.name, operatorId: operator.id },
      );
    }

    // A source line fully converts when no plain kid remains on it. Its socks /
    // add-ons must not be silently dropped, so carry them onto the FIRST drop-off
    // line built from that source. (Residual plain lines keep their own extras.)
    const sourceIds = new Set(superSlots.map((s) => s.sourceLineId));
    const carryExtras = new Map<string, { socks: number; addOns: SelectedAddOn[] }>();
    for (const l of lines) {
      if (l.dropOff || !sourceIds.has(l.id)) continue;
      if ((plainBySource.get(l.id) ?? 0) === 0 && (l.socks > 0 || l.addOns.length > 0)) {
        carryExtras.set(l.id, { socks: l.socks, addOns: l.addOns });
      }
    }

    const usedCarry = new Set<string>();
    const dropLines: CartLine[] = supervised.map(({ slot, service }, i) => {
      let line = makeDropOffLine({
        ci: created[i],
        ticket: slot.ticketType,
        tier,
        service,
        lengthChosen: true,
        pricing: dropOffPricing,
      });
      const carry = carryExtras.get(slot.sourceLineId);
      if (carry && !usedCarry.has(slot.sourceLineId)) {
        usedCarry.add(slot.sourceLineId);
        const withExtras = { ...line, socks: carry.socks, addOns: carry.addOns };
        // Must preserve the prepaid food charge — computeLineTotal only sees the
        // ticket + extras; food provision rides on top just like the service fee.
        const foodTHB = line.dropOff?.foodProvision?.paidTHB ?? 0;
        line = { ...withExtras, lineTotal: computeLineTotal(withExtras) + line.dropOff!.serviceFeeTHB + foodTHB };
      }
      return line;
    });

    // Rebuild the cart: pass through untouched lines, shrink source lines to their
    // residual plain kids (re-priced), drop fully-converted sources, append the
    // new drop-off lines, then re-derive shared nanny fees.
    const residual: CartLine[] = [];
    for (const l of lines) {
      if (l.dropOff || !sourceIds.has(l.id)) {
        residual.push(l);
        continue;
      }
      const plainCount = plainBySource.get(l.id) ?? 0;
      if (plainCount > 0) {
        const kept = { ...l, kids: plainCount };
        residual.push({ ...kept, lineTotal: computeLineTotal(kept) });
      }
    }
    setLines(normalizeDropOffFees([...residual, ...dropLines], dropOffPricing));
    setSupervisionResolved(true);

    // Nanny kids still need a nanny — reuse the existing step-3 config. Otherwise
    // go straight to payment (consent already replaces the customer input step).
    const firstNanny = dropLines.find((d) => d.dropOff!.service === 'nanny' && !d.dropOff!.nannyId);
    if (firstNanny) {
      setActiveLineId(firstNanny.id);
      setStep(3);
    } else {
      setActiveLineId(null);
      setStep(5);
    }
  };

  const handleDoneAdding = () => {
    dropEmptyActiveLine();
    setActiveLineId(null);
    if (!supervisionResolved && evaluateUnaccompanied()) {
      openSupervisionGate();
      return;
    }
    // A known member (or a resolved supervision flow) skips the customer input step.
    setStep(member || supervisionResolved ? 5 : 4);
  };

  const handlePay = () => {
    if (step < 4) {
      if (!supervisionResolved && evaluateUnaccompanied()) {
        openSupervisionGate();
        return;
      }
      // A known member (or a resolved supervision flow) skips the customer input step.
      setStep(member || supervisionResolved ? 5 : 4);
    }
  };

  // Customer finished entering their details — control returns to staff for payment.
  // If a tier was verified before we knew who they are, save it to their profile now.
  const handleCustomerDone = () => {
    if (pendingVerification && !member && customerPhone.trim()) {
      const target = getMemberByPhone(customerPhone, customerNickname)
        ?? createMember(customerPhone, customerNickname, customerContactChannel);
      verifyMemberTier(target.id, pendingVerification);
      setMember(target);
      setPendingVerification(null);
    }
    setStep(5);
  };

  const handleCompletePayment = () => {
    // Hard re-gate: if the cart was edited back into an unaccompanied state after
    // the supervision gate resolved (cart mutations clear supervisionResolved),
    // force it through step 7 again before any charge — never finalize an
    // age-unchecked kids-only sale via this back door.
    if (!supervisionResolved && evaluateUnaccompanied()) {
      openSupervisionGate();
      return;
    }
    if (!tier || !pendingPaymentMethod || !operator) return;
    // Hard preflight: never finalize while a drop-off child has no chosen play
    // length or a nanny child has no nanny — those would check in free/under-priced
    // (unconfigured lines carry lineTotal 0). The Pay button is already gated on
    // this, but back-door paths (e.g. "Done adding" → checkout) must not slip past.
    const dropOffs = lines.filter((l) => l.dropOff);
    const lengthsOk = dropOffs.every((l) => l.dropOff!.lengthChosen);
    const nanniesOk = dropOffs
      .filter((l) => l.dropOff!.service === 'nanny')
      .every((l) => !!l.dropOff!.nannyId);
    if (!lengthsOk || !nanniesOk) {
      toast({
        title: 'Finish drop-off setup',
        description:
          'Every drop-off child needs a play-ticket length, and each nanny child needs a nanny assigned.',
        variant: 'destructive',
      });
      setStep(3);
      return;
    }
    // Can't issue bracelets/receipts until this iPad knows which devices it drives.
    if (!station) {
      promptSetupStation(navigate);
      return;
    }

    // Pre-checkout stock guard: aggregate all stocked items in the cart and
    // compare against live inventory so an edge-case UI race can't oversell.
    {
      const stockViolations: string[] = [];
      const allAddOnsForCheck = getAddOns();
      const socksAddOn = allAddOnsForCheck.find((a) => a.id === 'a-socks');
      // Socks are tracked as a plain integer per line (CartLine.socks).
      if (socksAddOn?.inventoryItemId) {
        const totalSocks = lines.reduce((sum, l) => sum + l.socks, 0);
        const invItem = getInventoryItem(socksAddOn.inventoryItemId);
        const available = invItem?.variants[0]?.stock ?? Infinity;
        if (totalSocks > available) {
          stockViolations.push(`Regular Socks (need ${totalSocks}, have ${available})`);
        }
      }
      // Inventory-linked add-ons — aggregate by inventoryItemId + variantId.
      const needed = new Map<string, { name: string; qty: number }>();
      for (const line of lines) {
        for (const sa of line.addOns) {
          const ao = allAddOnsForCheck.find((a) => a.id === sa.id);
          if (!ao?.inventoryItemId) continue;
          const vid = sa.variantId ?? INVENTORY_DEFAULT_VARIANT_ID;
          const key = `${ao.inventoryItemId}:${vid}`;
          const prev = needed.get(key);
          if (prev) {
            prev.qty += sa.quantity;
          } else {
            needed.set(key, { name: sa.name, qty: sa.quantity });
          }
        }
      }
      for (const [key, { name, qty }] of needed) {
        const [itemId, variantId] = key.split(':');
        const invItem = getInventoryItem(itemId);
        const variant = invItem?.variants.find((v) => v.id === variantId);
        const available = variant?.stock ?? Infinity;
        if (qty > available) {
          stockViolations.push(`${name} (need ${qty}, have ${available})`);
        }
      }
      if (stockViolations.length > 0) {
        toast({
          title: 'Insufficient stock',
          description: `Cannot complete sale — stock too low: ${stockViolations.join(' · ')}`,
          variant: 'destructive',
        });
        return;
      }
    }

    // Record the sale FIRST so payment is captured for the whole cart (regular
    // guests + any drop-off / nanny charges). Drop-off children no longer check in
    // here — after payment, staff decide per registration whether to check each
    // child in now or leave them booked for later (handled by the choice modal).
    const newSale = buildSale({
      operatorId: operator.id,
      operatorName: operator.name,
      tier,
      lines,
      discounts,
      manualDiscounts,
      memberId: member?.id,
      customerPhone,
      customerNickname,
      paymentMethod: pendingPaymentMethod,
    });
    recordSale(newSale);
    // Increment each applied promo's usage counter after the sale is committed.
    // Use the same identity key as validatePromoCode for consistent per-customer tracking.
    discounts.forEach((d) =>
      incrementPromoUsage(d.code, customerPhone || member?.phone || undefined)
    );
    setSaleResult(newSale);
    setStep(6);

    // Finalization print: receipt + credit grants + adult bracelets + NON-drop-off kid
    // bracelets. Drop-off children's bands wait for the per-registration choice, so
    // exclude their kid count here (a mixed sale still issues the adult's band now).
    //
    // Walk-in F&B credit: mint ONE QR-keyed wallet per fnb_credit grant at sale time
    // so the printed voucher is scannable immediately at the F&B station. This is the
    // ONLY digital record for the grant — checkInFamilyWithPayment only creates child
    // food-provision bands, so no second balance-bearing wristband is created later.
    newSale.creditGrants.forEach((grant, i) => {
      if (grant.type === 'fnb_credit' && (grant.valueTHB ?? 0) > 0) {
        ensureSaleGrantWallet(newSale.id, i, grant.valueTHB ?? 0, operator.name, grant.gateAccess ?? false);
      }
    });
    // Mint the sale's remaining gate bands (persons without a credit wallet:
    // plain adults get their ticket's gate access, non-drop-off kids get a
    // no-gate band). Drop-off children's bands are minted at check-in instead.
    issueWalkInBands(newSale);
    // Non-drop-off kids get their bracelet printed now; drop-off children's bands
    // wait for the per-registration check-in choice below.
    const nonDropOffKids = lines
      .filter((l) => !l.dropOff)
      .reduce((s, l) => s + l.kids, 0);
    dispatchPrintJobs(
      ticketPrintJobs(station, {
        ...newSale,
        bracelets: { children: nonDropOffKids, adults: newSale.bracelets.adults },
      }),
    );

    // If the sale carries drop-off / nanny children, present the post-payment
    // check-in choice grouped per registration. The modal commits each group's
    // decision; nothing is checked in until staff choose.
    const dropOffLines = lines.filter((l) => l.dropOff);
    if (dropOffLines.length > 0) {
      const nowISO = new Date().toISOString();
      const byReg = new Map<string, DoorCheckInGroup>();
      for (const l of dropOffLines) {
        const d = l.dropOff!;
        // Supervised span always follows the chosen play ticket length.
        const durationHours = l.ticketType.hours;
        const input: CheckInPaymentInput = {
          ticketTypeId: l.ticketType.id,
          ticketName: l.ticketType.name,
          tier,
          ticketPriceTHB: priceForTier(l.ticketType, tier),
          serviceType: d.service,
          serviceFeeTHB: d.serviceFeeTHB,
          durationHours,
          totalTHB: l.lineTotal,
          paymentMethod: pendingPaymentMethod,
          nannyId: d.service === 'nanny' ? d.nannyId : undefined,
          foodProvision: d.foodProvision,
        };
        let g = byReg.get(d.registrationId);
        if (!g) {
          g = { registrationId: d.registrationId, entries: [] };
          byReg.set(d.registrationId, g);
        }
        g.entries.push({
          checkInId: d.checkInId,
          childName: d.childName,
          service: d.service,
          input,
        });
      }
      // Booked play-start time for the "leave as booked" path: now (the booking
      // moment), surfaced on the drop-off board's Schedule list.
      bookedScheduledForRef.current = nowISO;
      setPendingCheckInChoices([...byReg.values()]);
    }
  };

  // Commit a registration's "Check in now" decision: check the children into the
  // park (validates nanny availability all-or-nothing), link the originating sale
  // for deterministic refunds, then issue their bands (the receipt already printed).
  const handleCheckInGroupNow = (group: DoorCheckInGroup) => {
    if (!operator || !station) return;
    const checkedIn = checkInFamilyWithPayment(
      group.entries.map((e) => ({ checkInId: e.checkInId, input: e.input })),
      { operatorName: operator.name, operatorId: operator.id },
    );
    if (!checkedIn) {
      // Keep the group open so staff can retry or leave the children as booked.
      toast({
        title: 'Could not check in',
        description: 'A nanny is no longer available, or a child was already checked in.',
        variant: 'destructive',
      });
      return;
    }
    if (saleResult) {
      for (const e of group.entries) linkCheckInSaleId(e.checkInId, saleResult.id);
    }
    dispatchPrintJobs(braceletPrintJobs(station, { children: group.entries.length, adults: 0 }));
    toast({
      title: 'Checked in',
      description: `${group.entries.map((e) => e.childName).join(', ')} — band(s) issued.`,
    });
    resolveCheckInGroup(group.registrationId);
  };

  // Commit a registration's "Leave as booked" decision: keep the children
  // registered with the booked play-start time + length recorded (no band, no
  // timer). They surface in the drop-off board's Schedule list, checkable later.
  const handleLeaveGroupBooked = (group: DoorCheckInGroup) => {
    if (!operator) return;
    const booked = markCheckInsBooked(
      group.entries.map((e) => ({
        checkInId: e.checkInId,
        scheduledFor: bookedScheduledForRef.current,
        bookedDurationMinutes: Math.round(e.input.durationHours * 60),
      })),
      { operatorName: operator.name },
    );
    if (!booked) {
      toast({
        title: 'Could not leave as booked',
        description: 'A child was no longer in a bookable state.',
        variant: 'destructive',
      });
      return;
    }
    toast({
      title: 'Left as booked',
      description: `${group.entries.map((e) => e.childName).join(', ')} — checkable later from the Drop-Off board.`,
    });
    resolveCheckInGroup(group.registrationId);
  };

  // Remove a resolved registration from the pending list; close the modal when
  // every registration has a decision.
  const resolveCheckInGroup = (registrationId: string) => {
    setPendingCheckInChoices((prev) => {
      const next = (prev ?? []).filter((g) => g.registrationId !== registrationId);
      return next.length > 0 ? next : null;
    });
  };

  const handlePaymentBack = () => {
    setPendingPaymentMethod(null);
    setStep(4);
  };

  const { total } = computeTotals(lines, discounts, manualDiscounts);

  // Pay is blocked until: at least one billable participant, every drop-off child
  // has a play-ticket length chosen, and every nanny drop-off line has a nanny
  // assigned. A nanny may cover several kids, so there's no uniqueness check.
  const dropOffCartLines = lines.filter((l) => l.dropOff);
  const allLengthsChosen = dropOffCartLines.every((l) => l.dropOff!.lengthChosen);
  const nannyDropOffLines = lines.filter((l) => l.dropOff?.service === 'nanny');
  const allNanniesAssigned = nannyDropOffLines.every((l) => !!l.dropOff!.nannyId);
  const canPay =
    lines.some((l) => l.kids + l.adults > 0) && allLengthsChosen && allNanniesAssigned;

  // Build a live, Sale-shaped view model for the customer display. Once the sale
  // is finalized (step 6) we use the locked-in result so credit grants/ids stay stable.
  const liveSale: Sale =
    saleResult ??
    buildSale({
      id: 'PREVIEW',
      operatorId: operator?.id ?? '',
      operatorName: operator?.name ?? '',
      tier: tier ?? getDefaultTier().id,
      lines,
      discounts,
      manualDiscounts,
      memberId: member?.id,
      customerPhone,
      customerNickname,
      paymentMethod: pendingPaymentMethod ?? undefined,
    });

  // The supervision policy drives the step-7 gate (staff) and consent screen
  // (customer); both read the same lifted draft (superSlots).
  const supervisionPolicy = getSupervisionPolicy();

  let customerStage: CustomerStage;
  if (step === 6) customerStage = 'thankyou';
  else if (step === 5) customerStage = 'payment';
  else if (step === 4) customerStage = 'input';
  else if (step === 1) customerStage = 'identify';
  else if (lines.length > 0) customerStage = 'order';
  else customerStage = 'welcome';

  const staffTill = (
    <div className="flex h-full w-full bg-background text-foreground overflow-hidden">
      {/* LEFT AREA: MAIN WIZARD */}
      <div className="flex-1 flex flex-col border-r bg-card/30 min-w-0">
        <div className="flex-1 overflow-hidden relative p-6">
          {step === 1 && (
            <StepIdentify
              phone={customerPhone}
              nickname={customerNickname}
              member={member}
              onSkip={handleSkipIdentify}
              onRedeemBooking={() => setShowRedeemModal(true)}
              eventPasses={activeEventPasses}
              onSellEventPass={handleSellEventPassFromStep1}
            />
          )}
          {step === 2 && (
            <StepCustomerType
              member={member}
              selectedTier={tier ?? getDefaultTier().id}
              onPickTier={handlePickTier}
              onRequestVerify={handleRequestVerify}
              eventPasses={activeEventPasses}
              onSellEventPass={handleSellEventPassFromStep1}
            />
          )}
          {step === 3 && tier && (() => {
            const activeLine = lines.find(l => l.id === activeLineId) ?? null;
            // A drop-off line gets its dedicated config; everything else uses the
            // standard ticket grid / participant editor.
            if (activeLine?.dropOff) {
              return (
                <DropOffLineConfig
                  line={activeLine}
                  tier={tier}
                  cartNannyLoads={cartNannyLoadsFor(activeLine.id)}
                  onUpdate={handleUpdateDropOffLine}
                  onUpdateExtras={handleUpdateDropOffExtras}
                  onAssignNannyToAll={handleAssignNannyToAll}
                  siblingNanny={siblingNannyFor(activeLine.id)}
                  onBackToGrid={handleBackToGrid}
                  onDone={handleDropOffLineDone}
                />
              );
            }
            return (
              <StepAddTicket
                tier={tier}
                activeLine={activeLine}
                hasLines={lines.length > 0}
                onSelectTicket={handleSelectTicket}
                onUpdateLine={handleUpdateLine}
                onAddDropOff={() => setShowAddDropOff(true)}
                onBackToGrid={handleBackToGrid}
                onDone={handleDoneAdding}
              />
            );
          })()}
          {step === 4 && (
            <StepAwaitCustomer
              phone={customerPhone}
              nickname={customerNickname}
              onBack={() => setStep(3)}
            />
          )}
          {step === 5 && (
            <StepPayment
              total={total}
              selectedMethod={pendingPaymentMethod}
              onSelectMethod={setPendingPaymentMethod}
              onComplete={handleCompletePayment}
              onBack={handlePaymentBack}
            />
          )}
          {step === 8 && tier && (
            <SavedChildrenReview
              slots={superSlots}
              savedChildren={member?.savedChildren ?? []}
              confirmedIds={confirmedSavedIds}
              onUpdateSlot={handleReviewUpdateSlot}
              onConfirmSlot={handleConfirmSlot}
              onAssignSaved={handleAssignSaved}
              onMarkNew={handleMarkNew}
              onRemoveSaved={handleRemoveSaved}
              onBack={handleSupervisionBack}
              onContinue={() => setStep(7)}
              canContinue={reviewCanContinue}
            />
          )}
          {step === 7 && tier && (
            <SupervisionGate
              slots={superSlots}
              parentName={superParentName}
              consentAck={superConsentAck}
              policy={supervisionPolicy}
              acknowledgedConfirmationIds={superAcknowledgedConfirmationIds}
              onUpdateSlot={handleUpdateSlot}
              onToggleWaiver={handleToggleWaiver}
              onBack={handleSupervisionBack}
              onContinue={handleSupervisionContinue}
            />
          )}
          {step === 6 && saleResult && (
            <StepConfirmation sale={saleResult} onNewSale={resetSale} />
          )}
        </div>
      </div>

      {/* RIGHT AREA: ORDER SUMMARY */}
      {step < 6 && (
        <div className="w-[360px] min-w-0 bg-sidebar flex flex-col p-6">
          <OrderSummary
            tier={tier}
            customerName={customerNickname.trim() || member?.nickname || ''}
            lines={lines}
            activeLineId={activeLineId}
            discounts={discounts}
            manualDiscounts={manualDiscounts}
            onUpdateLine={handleUpdateLine}
            onConfigureLine={handleConfigureLine}
            onRemoveLine={handleRemoveLine}
            onRemoveDiscount={handleRemoveDiscount}
            onApplyPromoCode={handleApplyPromoCode}
            promoError={promoError}
            onAddManualDiscount={() => setShowManualDiscountModal(true)}
            onRemoveManualDiscount={handleRemoveManualDiscount}
            onPay={handlePay}
            onCancel={resetSale}
            canPay={canPay}
          />
        </div>
      )}
    </div>
  );

  return (
    <div className="h-[100dvh] w-full flex flex-col bg-background">
      {/* Test-harness banner */}
      <div className="shrink-0 flex items-center justify-between gap-4 px-4 py-2 bg-amber-500/10 border-b border-amber-500/30 text-amber-300 text-sm">
        <div className="flex items-center gap-2 min-w-0">
          <Monitor className="w-4 h-4 shrink-0" />
          <span className="truncate">
            Test harness — staff till (left) + customer display (right) share one live sale. In
            production the customer display runs on a separate device.
          </span>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <Button
            variant="ghost"
            size="sm"
            className="h-7 text-amber-300 hover:text-amber-200 hover:bg-amber-500/20"
            onClick={() => setShowCustomerDisplay(v => !v)}
          >
            {showCustomerDisplay ? 'Hide' : 'Show'} customer display
          </Button>
        </div>
      </div>

      <StationHeader active="tickets" />

      {/* Drop-off overstay alert mirrored onto the till so reception sees overdue
          / due-soon children without leaving the ticket screen. Tapping jumps to
          the Drop-Off In Park view filtered to due-only. */}
      <OverstayBanner onReview={() => navigate('/drop-off?due=1')} className="mx-4 mt-3" />

      <div className="flex-1 flex min-h-0">
        <div className={`${showCustomerDisplay ? 'w-1/2 border-r border-foreground/10' : 'w-full'} h-full min-w-0`}>
          {staffTill}
        </div>
        {showCustomerDisplay && step === 7 && (
          <div className={`w-1/2 h-full min-w-0 ${customerTheme === 'dark' ? 'dark' : 'light'}`}>
            <ConsentCapture
              slots={superSlots}
              parentName={superParentName}
              consentAck={superConsentAck}
              policy={supervisionPolicy}
              parentPhone={superParentPhone}
              parentContactMethod={superParentContactMethod}
              onParentNameChange={setSuperParentName}
              onParentPhoneChange={setSuperParentPhone}
              onParentContactMethodChange={setSuperParentContactMethod}
              onConsentAckChange={setSuperConsentAck}
              onUpdateChild={handleUpdateSlot}
              acknowledgedConfirmationIds={superAcknowledgedConfirmationIds}
              onToggleConfirmation={handleToggleConfirmation}
            />
          </div>
        )}
        {showCustomerDisplay && step === 8 && tier && (
          <div className={`w-1/2 h-full min-w-0 ${customerTheme === 'dark' ? 'dark' : 'light'}`}>
            <SavedChildrenReview
              slots={superSlots}
              savedChildren={member?.savedChildren ?? []}
              confirmedIds={confirmedSavedIds}
              onUpdateSlot={handleReviewUpdateSlot}
              onConfirmSlot={handleConfirmSlot}
              onAssignSaved={handleAssignSaved}
              onMarkNew={handleMarkNew}
              onRemoveSaved={handleRemoveSaved}
              onBack={handleSupervisionBack}
              onContinue={() => setStep(7)}
              canContinue={reviewCanContinue}
            />
          </div>
        )}
        {showCustomerDisplay && step !== 7 && step !== 8 && (
          <div className={`w-1/2 h-full min-w-0 ${customerTheme === 'dark' ? 'dark' : 'light'}`}>
            <CustomerDisplay
              stage={customerStage}
              sale={liveSale}
              phone={customerPhone}
              nickname={customerNickname}
              member={member}
              onPhoneChange={setCustomerPhone}
              onNicknameChange={setCustomerNickname}
              onIdentify={handleIdentify}
              onSkipIdentify={handleSkipIdentify}
              onCustomerDone={handleCustomerDone}
              contactChannel={customerContactChannel}
              onContactChannelChange={handleCustomerContactChannelChange}
            />
          </div>
        )}
      </div>

      {operator && (
        <ManualDiscountModal
          open={showManualDiscountModal}
          onOpenChange={setShowManualDiscountModal}
          subtotal={lines.reduce((acc, l) => acc + l.lineTotal, 0)}
          lines={lines.map((l) => ({
            id: l.id,
            label: `${l.ticketType.name} · ${l.kids + l.adults} ppl`,
            amount: l.lineTotal,
            // Ticket lines drill into their component rows; drop-off lines stay
            // whole-line only (no bundled components).
            components: l.dropOff ? undefined : lineDiscountComponents(l),
          }))}
          reasons={getDiscountReasons()}
          operatorId={operator.id}
          operatorName={operator.name}
          onApply={handleApplyManualDiscount}
        />
      )}

      {operator && verifyTier && (
        <VerifyTierModal
          open={showVerifyModal}
          onOpenChange={setShowVerifyModal}
          tier={verifyTier}
          member={member}
          operatorId={operator.id}
          operatorName={operator.name}
          onConfirm={handleVerified}
        />
      )}

      <AddDropOffModal
        open={showAddDropOff}
        onOpenChange={setShowAddDropOff}
        attachedCheckInIds={lines.filter((l) => l.dropOff).map((l) => l.dropOff!.checkInId)}
        onAttach={handleAttachDropOff}
      />

      <RedeemBookingModal
        open={showRedeemModal}
        onOpenChange={setShowRedeemModal}
        onConfirm={handleRedeemConfirm}
      />

      {/* Event-pass sell flow — flat-priced camp/event entry (non-party). */}
      {eventPassFor && (
        <AddAttendeeModal
          open={eventPassFor !== null}
          onOpenChange={(o) => { if (!o) closeEventPass(); }}
          event={eventPassFor}
          isParty={false}
          doorFeeTHB={resolveRateToday(eventPassFor.entryPriceTHB)}
          prefillMember={eventPassPrefilledMember}
          prefillSavedChildren={eventPassPrefilledMember?.savedChildren ?? []}
          onSell={handleEventPassSell}
          onCheckIn={handleEventPassCheckIn}
        />
      )}

      {/* Capture guest name — shown when staff sell an event pass to an unknown
          phone that has no nickname yet. Staff enter the guest's name so we can
          create the member record and pre-fill the attendee form. */}
      <Dialog
        open={captureNameFor !== null}
        onOpenChange={(o) => { if (!o) { setCaptureNameFor(null); setCaptureNameInput(''); } }}
      >
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <User className="w-5 h-5 text-primary" />
              New guest — enter name
            </DialogTitle>
            <DialogDescription>
              Phone <span className="font-medium text-foreground">{customerPhone}</span> is not
              recognised. Enter the guest's name to register them so they're remembered next time.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 pt-1">
            <div>
              <label className="text-sm font-medium text-foreground/80">Name / nickname</label>
              <input
                autoFocus
                value={captureNameInput}
                onChange={(e) => setCaptureNameInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && captureNameInput.trim() && captureNameFor) {
                    const newMember = createMember(customerPhone, captureNameInput.trim(), customerContactChannel);
                    setMember(newMember);
                    setCustomerNickname(captureNameInput.trim());
                    setEventPassPrefilledMember(newMember);
                    setEventPassFor(captureNameFor);
                    setCaptureNameFor(null);
                    setCaptureNameInput('');
                  }
                }}
                placeholder="e.g. Mama, John"
                className="mt-1 w-full h-12 rounded-lg border border-input bg-background px-3 text-base focus:outline-none focus:ring-2 focus:ring-ring"
              />
            </div>
            <div className="flex gap-3">
              <Button
                variant="outline"
                className="flex-1"
                onClick={() => { setCaptureNameFor(null); setCaptureNameInput(''); }}
              >
                Cancel
              </Button>
              <Button
                className="flex-1"
                disabled={!captureNameInput.trim()}
                onClick={() => {
                  if (!captureNameFor || !captureNameInput.trim()) return;
                  const newMember = createMember(customerPhone, captureNameInput.trim(), customerContactChannel);
                  setMember(newMember);
                  setCustomerNickname(captureNameInput.trim());
                  setEventPassPrefilledMember(newMember);
                  setEventPassFor(captureNameFor);
                  setCaptureNameFor(null);
                  setCaptureNameInput('');
                }}
              >
                Register &amp; continue
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Drop-off check-in proposal: shown after a booking with drop-off children is redeemed. */}
      <Dialog
        open={pendingDropOffRegistration !== null}
        onOpenChange={(o) => { if (!o) setPendingDropOffRegistration(null); }}
      >
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Baby className="w-5 h-5 text-primary" />
              Check in drop-off child{pendingDropOffRegistration && pendingDropOffRegistration.childNames.length > 1 ? 'ren' : ''}?
            </DialogTitle>
            <DialogDescription>
              This booking includes a registered drop-off:{' '}
              <span className="font-medium text-foreground">
                {pendingDropOffRegistration?.childNames.join(', ')}
              </span>
              . Load the registration into the till to complete check-in now.
            </DialogDescription>
          </DialogHeader>
          <div className="flex gap-3 pt-2">
            <Button
              variant="outline"
              className="flex-1"
              onClick={() => setPendingDropOffRegistration(null)}
            >
              Skip for now
            </Button>
            <Button
              className="flex-1"
              onClick={() => {
                if (pendingDropOffRegistration) {
                  loadDropOffRegistration(pendingDropOffRegistration.registrationId);
                  setPendingDropOffRegistration(null);
                }
              }}
            >
              Check in now
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Post-payment door choice: check the drop-off / nanny children in now, or
          leave them booked for later. Required per registration before the sale closes. */}
      <DoorCheckInChoiceModal
        groups={pendingCheckInChoices}
        onCheckInNow={handleCheckInGroupNow}
        onLeaveAsBooked={handleLeaveGroupBooked}
      />

      {/* SCRUM-32 — confirm which saved children are visiting (draft visit). */}
      <VisitChildrenModal
        open={showVisitChildren}
        member={member}
        onClose={() => setShowVisitChildren(false)}
        onConfirmed={(children) => {
          setMember((m) => (m ? { ...m, savedChildren: children } : m));
        }}
      />

      {/* SCRUM-31 — create-member path when the lookup finds nobody. */}
      <Dialog open={offerCreateMember} onOpenChange={(o) => { if (!o) setOfferCreateMember(false); }}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <User className="w-5 h-5 text-primary" />
              New member?
            </DialogTitle>
            <DialogDescription>
              No membership found for{' '}
              <span className="font-medium text-foreground">{customerPhone.trim()}</span>. Create one
              from just the phone and a name — details can be added later.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-3">
            <label className="text-sm font-semibold text-foreground/60">Name / nickname</label>
            <input
              value={customerNickname}
              onChange={(e) => setCustomerNickname(e.target.value)}
              placeholder="e.g. Mali"
              className="w-full h-12 rounded-lg border border-input bg-background px-3 text-base focus:outline-none focus:ring-2 focus:ring-ring"
            />
            <div className="flex gap-3 pt-1">
              <Button variant="outline" className="flex-1" onClick={() => setOfferCreateMember(false)}>
                Continue as walk-in
              </Button>
              <Button
                className="flex-1"
                disabled={!customerNickname.trim() || createBusy}
                onClick={handleCreateMember}
              >
                Create member
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
