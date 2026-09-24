import { useEffect, useMemo, useRef, useState } from 'react';
import { useLocation } from 'wouter';
import { CustomerTier, CartLine, CheckIn, ContactChannel, Discount, ManualDiscount, Sale, SaleQuotedPricing, TicketType, Member, TierVerification, DropOffServiceType, AddOn, SelectedAddOn, INVENTORY_DEFAULT_VARIANT_ID } from '@/types';
import type { DiscountComponentOption } from '@/components/shared/ManualDiscountModal';
import { useStation } from '@/station/StationContext';
import { braceletPrintJobs, dispatchPrintJobs, promptSetupStation, ticketPrintJobs } from '@/lib/printRouting';
import { takeCorrectedOrder } from '@/lib/correctedOrder';
import { takeDropOffHandoff } from '@/lib/dropoffHandoff';
import { useCustomerDisplayPref } from '@/lib/customerDisplayPref';
import { useCustomerTheme } from '@/lib/themePref';
import { computeLineTotal, computeLineBreakdown, priceForTier, unpricedCartLines } from '@/lib/pricing';
import { resolveRateToday } from '@/lib/pricingMode';
import { makeDropOffLine, normalizeDropOffFees, resolveDropOffPricing } from '@/lib/dropoff';
import { resolveGroupRequirements, effectiveRequirement, resolveSupervisionOutcome, buildAcknowledgedConfirmations } from '@/lib/supervision';
import { buildSale, computeTotals } from '@/lib/sale';
import { dropOrphanedDiscounts } from '@/lib/manualDiscount';
import { resolveAutoTier, tierLabel } from '@/lib/membership';
import { saveDeferredVerification } from '@/lib/deferredTierVerification';
import { setSaleOpen } from '@/pwa/openSale';
import { getInventoryItem, getAddOns } from '@/store/catalogStore';
import { getDiscountReasons, recordSale, getTicketTypes, getDropOffPricing, getCheckInsByRegistration, checkInFamilyWithPayment, linkCheckInSaleId, getDefaultTier, getSupervisionPolicy, registerWalkInChildren, recordSupervisionWaiver, pushWristband, markCheckInsBooked, getActiveEventPasses, getEventById, getDiscountByCode, incrementPromoUsage, initWalletLedger, ensureSaleGrantWallet, issueWalkInBands, issueBookingBands, type CheckInPaymentInput, type NewEventAttendeeInput } from '@/mockApi';
import { useBranch } from '@/branch/BranchContext';
import { validatePromoCode, resolveFreeItem } from '@/lib/promoVoucher';
import { SavedChildrenReview } from '@/components/shared/SavedChildrenReview';
import { prefillSlots, slotPatchFromSavedChild } from '@/lib/savedChildren';
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
import { authApi, membersApi, visitsApi } from '@/api/platform';
import { childrenApi, lookupMember } from '@/api/members';
import { ApiError, NetworkError, isMissingRoute } from '@/api/client';
import {
  bookingsApi,
  redemptionFromConflict,
  type PlatformBooking,
  type RedeemOutcome,
} from '@/api/bookings';
import { apiBranchIdForSlug } from '@/api/catalogBridge';
import {
  buildCartPayload,
  claimVerifiedTier,
  quotedPricing,
  toSatang,
  type ApiSale,
  type CartIdentity,
  type SaleCartPayload,
} from '@/api/sales';
import { paymentMethodKind } from '@/lib/payments';
import { useCartQuote } from '@/lib/cartQuote';
import { useSaleWriter, type SaleWriteInput } from '@/lib/saleWriter';
import { readVoucherScan, useStationScans, type StationScanEvent } from '@/lib/scanChannel';
import { useScannerBurst } from '@/lib/scannerBurst';
import { vouchersApi } from '@/api/vouchers';
import {
  CANCELLED_AT_THE_TILL,
  VOUCHER_AFTER_PAY,
  VOUCHER_AFTER_SALE,
  VOUCHER_AT_THE_RESTAURANT,
  VOUCHER_BEING_PRICED,
  VOUCHER_NOT_COMBINABLE,
  isMenuItemVoucher,
  looksLikeVoucherCode,
  useTillVoucher,
  voucherUnpricedReason,
  type HeldVoucher,
} from '@/lib/tillVoucher';
import {
  RedeemVoucherEntry,
  TillRefusalNotice,
  VoucherCard,
  VoucherFreeItemLine,
  VoucherRefusalCard,
  VoucherUsedNote,
} from '@/components/till/RedeemVoucher';
import { PriceSourceNote, SaleNotSavedNotice, SaleWriteFailure } from '@/components/till/SaleWriteStatus';
import { apiChildToSavedChild, apiMemberToMember } from '@/api/mappers';
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
  const { operator, offlineUnlock } = useOperator();
  const { station } = useStation();
  const { branch } = useBranch();
  /**
   * S2-09a: the sale ledger writer, and the platform's price for this cart.
   * Declared here so `resetSale` can clear the writer and every screen below
   * reads one set of totals.
   */
  const saleWriter = useSaleWriter();
  /**
   * S2-10b (SCRUM-207) — the Lucky Wheel voucher on this cart: looked up and
   * held by the platform, priced by the quote, used up when the sale is paid
   * (`lib/tillVoucher.ts`). Online only: a till with no connection, or one its
   * box unlocked while the cloud was away, says so before asking anything.
   *
   * A free item off the MENU is the restaurant's: the kitchen makes it and the
   * F&B till's order is what sends the kitchen its ticket, which this counter
   * never sends. So this till says where to take it once the lookup has said
   * what it is, and holds nothing (`isMenuItemVoucher`). A shop product or a
   * ticket extra is handed over here.
   */
  const tillOffline = (): boolean =>
    (typeof navigator !== 'undefined' && navigator.onLine === false) || offlineUnlock !== null;
  const voucher = useTillVoucher({
    isOffline: tillOffline,
    refuseHere: (view) => (isMenuItemVoucher(view) ? VOUCHER_AT_THE_RESTAURANT : null),
  });
  /** The platform's words when the till's Cancel could not void the sale on screen. */
  const [cancelRefusal, setCancelRefusal] = useState<string | null>(null);
  /** The voucher the last sale used up, for its confirmation screen. */
  const [voucherUsed, setVoucherUsed] = useState<HeldVoucher | null>(null);
  /** The voucher's code as the cart carries it, one stable list per voucher. */
  const voucherCodes = useMemo(
    () => (voucher.held ? [voucher.held.code] : []),
    [voucher.held],
  );
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
  /**
   * SCRUM-307 — the platform's record of that same document check, by the
   * action id it was recorded under. The cart carries it so the PLATFORM
   * prices at the verified tier: with no member yet there is nothing for it to
   * read a tier from, and a tier sent in the cart is ignored by design, so
   * without this every Expat and Thai walk-in was quoted at the tourist rate
   * and refused at Pay as `SALE_LINE_PRICE_MISMATCH`.
   */
  const [tierClaimActionId, setTierClaimActionId] = useState<string | null>(null);

  /**
   * SCRUM-311 — why the discounted rate that was on this screen has gone.
   *
   * Held here rather than read straight off the live quote, because acting on
   * the refusal is what makes it disappear: the moment the till forgets the
   * claim, the next quote names none and answers no refusal. Staff would be
   * left with a cart that had silently reverted to the tourist total and
   * nothing on screen to say why. It clears when the sale does, and when a
   * fresh document check is recorded.
   */
  const [tierClaimRefusal, setTierClaimRefusal] = useState<string | null>(null);

  const [showManualDiscountModal, setShowManualDiscountModal] = useState(false);
  const [showAddDropOff, setShowAddDropOff] = useState(false);
  const [saleResult, setSaleResult] = useState<Sale | null>(null);
  const [promoError, setPromoError] = useState<string>('');

  /**
   * Tell the shell this till is mid-sale, so a new build is not swapped in
   * under the cart (S2-06; read by src/pwa/ServiceWorkerUpdater.tsx). A cart
   * with lines in it, or a finished sale still on screen waiting to be handed
   * over, both count. The cleanup clears the flag when this page unmounts,
   * which is what a lock does.
   */
  const saleOnScreen = lines.length > 0 || saleResult !== null || voucher.held !== null;
  useEffect(() => {
    setSaleOpen('till', saleOnScreen);
    return () => setSaleOpen('till', false);
  }, [saleOnScreen]);

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
  //
  // S2-09b (SCRUM-204): the parent is looked up on the platform — the member
  // the membership check finds — not in this browser's fixtures. A number the
  // platform does not know loads at the default rate with no member, as
  // before; a lookup that fails says so and loads the same way, as
  // `handleIdentify` does. A Cancel pressed while the lookup is out wins
  // (`saleEpochRef`).
  const loadDropOffRegistration = async (registrationId: string) => {
    const children = getCheckInsByRegistration(registrationId).filter((c) => c.status === 'registered');
    if (children.length === 0) return;
    const phone = children[0]?.phone ?? '';
    const epoch = saleEpochRef.current;
    let found: Member | null = null;
    if (phone) {
      try {
        found = await lookupMember(phone);
      } catch (err) {
        if (saleEpochRef.current !== epoch) return;
        toast({
          title: 'Membership lookup failed',
          description: err instanceof Error ? err.message : 'Unknown error',
          variant: 'destructive',
        });
      }
    }
    if (saleEpochRef.current !== epoch) return;
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
    void loadDropOffRegistration(registrationId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * Which sale the till is on. Bumped by every reset, and captured by anything
   * that goes away and comes back.
   *
   * Saving a tier verified before we knew who the visitor was takes three
   * round trips — look them up, create them, record the evidence — and it was
   * made asynchronous in the same change that made it real. A reviewer found
   * what that opened: staff hand over the display, the visitor keys their
   * number and presses Done, the visitor changes their mind, staff press
   * Cancel and start the next person, and the in-flight promise resolves onto
   * a blank till and sets `member`. The next sale is then built with
   * `memberId: member?.id` and the wallet grant follows that id — the previous
   * visitor's name on this visitor's sale. The price is right, because the
   * tier is re-resolved; the person on the record is wrong.
   */
  const saleEpochRef = useRef(0);

  /**
   * WHO THIS CART BELONGS TO, in the platform's own ids — S2-09a (SCRUM-203).
   *
   * Null when this deployment has no platform station or no platform branch for
   * the one on screen (a device still on the prototype's own station setup,
   * which is what a deployment without the fleet routes leaves it on). A sale
   * then cannot be written, and the till says so on the confirmation screen
   * rather than showing a saved-looking sale that only exists in this browser.
   */
  const cartIdentity: CartIdentity | null = useMemo(() => {
    const branchId = apiBranchIdForSlug(branch.id);
    if (!branchId || !station?.stationId || !operator || !tier) return null;
    return {
      branchId,
      stationId: station.stationId,
      tier,
      // SCRUM-307 — names the document check, so the platform prices the cart
      // at the tier that check supports. A member on the cart decides instead.
      tierClaimActionId,
      memberId: member?.id ?? null,
      customerPhone: customerPhone || member?.phone || null,
      customerNickname: customerNickname || member?.nickname || null,
      accountId: operator.id,
      accountName: operator.name,
    };
  }, [
    branch.id,
    station?.stationId,
    operator,
    tier,
    tierClaimActionId,
    member,
    customerPhone,
    customerNickname,
  ]);

  /**
   * THE PRICE THE PLATFORM QUOTES FOR THIS CART. Every figure the staff panel,
   * the customer display and the payment screen show comes from here; where the
   * platform could not be asked, `quote.source` says so and the note beside the
   * total says it on the screen.
   *
   * Switched off once the sale is committed: from step 6 the sale's own frozen
   * figures stand, and re-quoting a finished sale could only disagree with the
   * receipt in the visitor's hand.
   */
  const cart = useCartQuote({
    lines,
    discounts,
    manualDiscounts,
    identity: cartIdentity,
    enabled: saleResult === null,
    // S2-10b — the held voucher rides by its code; the platform prices it.
    promoCodes: voucherCodes,
  });

  const resetSale = () => {
    saleEpochRef.current += 1;
    saleWriter.reset();
    voucher.reset();
    setVoucherUsed(null);
    setCancelRefusal(null);
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
    // The next visitor is not the one whose document was checked (SCRUM-307).
    setTierClaimActionId(null);
    setTierClaimRefusal(null);
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

    // SCRUM-233: asked of the member API, not of this browser's copy of the
    // member list. The in-memory store holds the prototype's six demo
    // families and nobody else, so a real member standing at the counter was
    // answered "not recognised" here and offered registration they already
    // have — while the membership check one step away finds them.
    void (async () => {
      let found: Member | null = null;
      try {
        const res = await membersApi.lookup(phone);
        found = res.member ? apiMemberToMember(res.member) : null;
      } catch (err) {
        toast({
          title: 'Membership lookup failed',
          description: err instanceof Error ? err.message : 'Unknown error',
          variant: 'destructive',
        });
        return;
      }

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
      if (!name) {
        // No nickname yet — prompt staff for it.
        setCaptureNameInput('');
        setCaptureNameFor(event);
        return;
      }
      try {
        const created = apiMemberToMember((await membersApi.create({ phone, nickname: name })).member);
        setMember(created);
        setCustomerPhone(created.phone);
        setEventPassPrefilledMember(created);
        setEventPassFor(event);
      } catch (err) {
        toast({
          title: "Couldn't create the member",
          description: err instanceof Error ? err.message : 'Unknown error',
          variant: 'destructive',
        });
      }
    })();
  };

  /**
   * Register the guest whose name staff just typed, then open the pass form.
   *
   * SCRUM-233: the same `POST /members` the membership check makes. The
   * prototype wrote this one into browser memory, so "so they're remembered
   * next time" — what the dialog promises — lasted until the page reloaded.
   * A failure says so and keeps the dialog open with the name still in it.
   */
  const [captureNameBusy, setCaptureNameBusy] = useState(false);

  const registerEventPassGuest = () => {
    const event = captureNameFor;
    const name = captureNameInput.trim();
    if (!event || !name || captureNameBusy) return;
    setCaptureNameBusy(true);
    void membersApi
      .create({ phone: customerPhone.trim(), nickname: name, preferredChannel: customerContactChannel })
      .then((res) => {
        const created = apiMemberToMember(res.member);
        setMember(created);
        setCustomerPhone(created.phone);
        setCustomerNickname(name);
        setEventPassPrefilledMember(created);
        setEventPassFor(event);
        setCaptureNameFor(null);
        setCaptureNameInput('');
      })
      .catch((err: unknown) => {
        toast({
          title: "Couldn't register this guest",
          description: err instanceof Error ? err.message : 'Unknown error',
          variant: 'destructive',
        });
      })
      .finally(() => setCaptureNameBusy(false));
  };

  // Staff confirmed a paid booking in the RedeemBookingModal. Claim the booking
  // on the platform, then build + record the regular-guest sale (drop-off lines
  // are excluded — they get their own check-in flow), issue wristbands, dispatch
  // print jobs, then offer to check in any drop-off children via the existing
  // registration flow.
  //
  // THE CLAIM COMES FIRST — SCRUM-234. The prototype minted the bands and then
  // asked its in-memory store whether the booking was still unredeemed, which
  // left a losing race holding printed wristbands. `pos.booking` is now the
  // thing that decides, and it is asked before anything is minted or printed, so
  // the second counter to scan the same QR is told who redeemed it and when, and
  // has issued nothing.
  const handleRedeemConfirm = async (
    booking: Booking,
    platform: PlatformBooking,
  ): Promise<RedeemOutcome> => {
    if (!operator) {
      return { ok: false, message: 'No operator is signed in at this till.' };
    }

    // Regular-guest lines only (drop-off lines are checked in separately).
    const regularLines = booking.lines.filter((l) => !l.dropOff);
    if (regularLines.length === 0) {
      return {
        ok: false,
        message: 'None of this booking’s tickets are in this branch’s catalogue, so nothing can be issued here.',
      };
    }

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

    try {
      await bookingsApi.redeem(
        platform.id,
        { stationId: station?.stationId },
        bookingsApi.newRedeemKey(),
      );
    } catch (err) {
      const first = redemptionFromConflict(err);
      if (first) return { ok: false, redemption: first };
      if (err instanceof NetworkError) {
        return {
          ok: false,
          message: 'No connection to the platform, so this booking cannot be redeemed here. Nothing has been issued.',
        };
      }
      if (isMissingRoute(err)) {
        return {
          ok: false,
          message: 'This deployment cannot record a booking redemption yet (SCRUM-234). Nothing has been issued.',
        };
      }
      return {
        ok: false,
        message: err instanceof ApiError ? err.message : 'The booking could not be redeemed. Nothing has been issued.',
      };
    }

    recordSale(sale);
    // Track usage for promo codes embedded in the booking at redemption time.
    if (booking.promoDiscount) {
      incrementPromoUsage(booking.promoDiscount.code, customerPhone || member?.phone || undefined);
    }

    // Mint every wristband for the booking from each ticket's own package:
    // credit-earning persons (adults and/or kids per the ticket's credit rule)
    // get a scannable wallet band; everyone else gets a 0-balance gate/plain
    // band. Gate access comes purely from the ticket — not a park-wide config.
    const mintedCodes = issueBookingBands(sale, operator?.name);

    if (station) {
      dispatchPrintJobs(ticketPrintJobs(station, sale));
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

    return { ok: true };
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
  const handleVerified = async ({
    member: verified,
    verification,
  }: {
    member: Member | null;
    verification: TierVerification;
  }) => {
    /**
     * SCRUM-307 — nobody to hold the verification yet, so the platform records
     * the CLAIM before anything is priced: the tier this document supports,
     * stamped with the verifier and the branch from the session. Awaited, not
     * fired off — a cart quoted before it lands is quoted at the tourist rate.
     *
     * A refusal stops here with the reason on screen, because a discounted
     * rate the platform has not recorded is one it will not let anybody
     * charge. A deployment with no such route is the exception: there the till
     * prices the cart itself and already says so on the confirmation screen.
     */
    const apiBranchId = apiBranchIdForSlug(branch.id);
    // The sale this check belongs to (SCRUM-313). The modal closes before the
    // claim lands and the order panel's Cancel is live for the round trip; a
    // handler resuming onto a fresh sale would set the tier and the claim id
    // on a family that showed no document. Same guard as handleCustomerDone.
    const epoch = saleEpochRef.current;
    if (!verified && apiBranchId && verification.expiresAt) {
      try {
        const claimed = await claimVerifiedTier({
          branchId: apiBranchId,
          tier: verification.tier,
          proofType: verification.proofType,
          expiresAt: verification.expiresAt,
        });
        if (saleEpochRef.current !== epoch) return;
        setTierClaimActionId(claimed);
        // A fresh check answers the last one's refusal (SCRUM-311).
        setTierClaimRefusal(null);
      } catch (err) {
        if (saleEpochRef.current !== epoch) return;
        if (!isMissingRoute(err)) {
          toast({
            title: 'Discounted rate not recorded',
            description: err instanceof Error ? err.message : 'Unknown error',
            variant: 'destructive',
          });
          return;
        }
      }
    }
    if (saleEpochRef.current !== epoch) return;
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

  /**
   * THE DOCUMENT CHECK BEHIND THIS CART HAS ALREADY PAID FOR A SALE — SCRUM-311.
   *
   * The platform made a claim single-use: it prices one sale, and a second
   * cart naming it is answered with the default tier and a refusal beside the
   * quote. Until this, the till did nothing with that refusal. The screen went
   * on saying EXPAT in the corner and showing the expat prices it had worked
   * out itself, the platform's total quietly landed at the tourist figure, and
   * the first anyone knew was a 409 at Pay with the family already at the
   * counter — the exact shape of the bug SCRUM-307 was raised for, one layer
   * further in.
   *
   * So the till follows the platform: it stops naming a claim that prices
   * nothing, puts the tier back where the platform has it, restates the lines
   * at that rate so the panel's figures and the platform's agree again, and
   * leaves the reason on the panel. What it does NOT do is guess that the
   * document is still good — re-checking it is a decision for the person
   * holding it, and the modal is one press away.
   *
   * `getDefaultTier()` rather than the tier code on the answer: the lines have
   * to be re-priced from the catalogue this device holds, so the tier that
   * does it must be one that catalogue knows. `tierSource === 'default'` is
   * what the platform says it fell back to.
   *
   * WHAT STILL STANDS BETWEEN THIS AND THE COUNTER. The platform only reaches
   * the refusal (`priceCart`, sale.ts:748) if it gets past its line-price
   * reconciliation (sale.ts:682), and it cannot: a till holding the expat rate
   * necessarily disagrees with a platform that has just fallen back to the
   * default one, so the quote is refused 409 SALE_LINE_PRICE_MISMATCH and the
   * answer this reads never arrives. `lineTotalSatang` is optional in the API
   * and omitting it produces the refusal, but `buildCartPayload` always sends
   * it — rightly, it is what stops a stale price being charged. So this
   * handler is correct and driven (see the Jira evidence, which omits that one
   * optional field), and it is not yet what staff meet: until the platform
   * answers a spent claim ahead of the mismatch it raises, the counter keeps
   * the Expat chip and the expat figures, is told only "Priced on this till.
   * The platform did not price this cart.", and meets the 409 at Pay.
   */
  useEffect(() => {
    const refusal = cart.quote.tierClaimRefusal;
    // No claim on this cart means nothing was refused for it — and the guard
    // is also what stops this from running a second time, because forgetting
    // the claim is the first thing it does.
    if (!refusal || cart.quote.tierSource !== 'default' || !tierClaimActionId) return;
    const fallback = getDefaultTier().id;
    setTierClaimActionId(null);
    setTierClaimRefusal(refusal.message);
    if (tier && tier !== fallback) {
      setTier(fallback);
      restateLinesToTier(fallback);
    }
    // `restateLinesToTier` closes over the cart it restates and is redefined
    // every render; listing it would re-run this on every keystroke.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cart.quote.tierClaimRefusal, cart.quote.tierSource, tierClaimActionId, tier]);

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
    // S2-10b — no promo code beside a voucher: the platform's own rule, said
    // here before the code is taken rather than at Pay.
    if (voucher.held) {
      setPromoError(VOUCHER_NOT_COMBINABLE);
      return;
    }
    const promo = getDiscountByCode(code);
    if (!promo) {
      // A Lucky Wheel voucher typed or scanned into the promo box is never
      // taken as a discount code: its value is the platform's, and it goes on
      // the sale through Redeem voucher.
      setPromoError(
        looksLikeVoucherCode(code)
          ? `"${code.toUpperCase()}" is a Lucky Wheel voucher, not a promo code — use Redeem voucher`
          : `Code "${code.toUpperCase()}" was not found.`,
      );
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

  /**
   * S2-10b — A VOUCHER CODE, HOWEVER IT ARRIVED: the box's scanner through the
   * station channel, a USB scanner typing into this page, or Redeem voucher.
   * What the till knows before asking is said here, in one sentence; every
   * other answer is the platform's (`lib/tillVoucher.ts`).
   */
  const redeemVoucher = (raw: string): Promise<boolean> => {
    const typed = raw.trim().toUpperCase();
    // One of the park's own discount codes — some have a booth code's shape
    // (SONGKRAN25) — belongs in the promo box, and asking the platform about it
    // as a voucher would count a wrong code against this till.
    const blockedBy = getDiscountByCode(typed)
      ? `"${typed}" is a promo code — enter it in the promo code box`
      : step === 5
        ? VOUCHER_AFTER_PAY
        : discounts.length > 0
          ? VOUCHER_NOT_COMBINABLE
          : null;
    return voucher.redeem(typed, blockedBy);
  };

  /** A scan — from the box, or from a USB scanner on this computer. */
  const redeemScannedVoucher = (code: string) => {
    if (step === 6) {
      // The finished sale's screen has no cart to put it on.
      toast({ title: VOUCHER_AFTER_SALE, description: code, variant: 'destructive' });
      return;
    }
    void redeemVoucher(code).then((held) => {
      // The order panel is not on screen during the supervision gate.
      if (held && (step === 7 || step === 8)) {
        toast({ title: 'Voucher added to this sale', description: code });
      }
    });
  };
  useStationScans(station?.stationId, (event: StationScanEvent) => {
    const code = readVoucherScan(event);
    if (code) redeemScannedVoucher(code);
  });
  useScannerBurst(redeemScannedVoucher, { accept: looksLikeVoucherCode });

  /**
   * S2-10b — THE ORDER PANEL'S CANCEL.
   *
   * A SALE THIS TILL RANG UP THAT TOOK NO MONEY IS VOIDED, voucher or not and ฿0
   * included, with the reason "Cancelled at the till" (`saleWriter.cancel`): it
   * can never be paid, and a voucher it held is free again for the family's
   * next sale. Pay only rings a sale up — nothing is closed or used up until
   * Confirm Payment Received — so on the payment screen this is always a void,
   * never a sale thrown away after it was finished.
   *
   * A void the platform refuses — money taken, which is refunded (later), not
   * voided; a card still on the terminal — leaves the sale on screen with the
   * platform's words: throwing the cart away would leave a sale, and perhaps a
   * voucher, pinned to a screen that no longer mentions it. A sale that turns
   * out to be closed already (its confirm's answer was lost on the way back)
   * goes to its confirmation instead, the way Confirm would have taken it.
   *
   * A cart not rung up lets its voucher go (`DELETE`). Best effort: a hold this
   * till cannot release lapses, and this till takes it over on its next cart.
   * A void also leaves the sale's document check spent (sale-tier.ts), which
   * the next cart's quote says in its own words.
   */
  const handleCancel = async () => {
    // The money is being recorded: its answer decides what shows next.
    if (saleWriter.state.kind === 'finalising') return;
    const epoch = saleEpochRef.current;
    setCancelRefusal(null);
    const cancelled = await saleWriter.cancel(CANCELLED_AT_THE_TILL);
    if (saleEpochRef.current !== epoch) return;
    if (!cancelled.ok) {
      if (cancelled.closed && pendingPaymentMethod) {
        void completeSale(epoch);
        return;
      }
      setCancelRefusal(cancelled.message);
      return;
    }
    // A voucher still held for a cart that was never rung up is let go; one
    // the void has just freed answers that it is no longer held for it.
    if (voucher.current()) await voucher.release();
    resetSale();
  };

  /**
   * S2-10b — leaving the till with a voucher on a cart that was not rung up lets
   * it go, so a family's voucher is not left "in use" at a screen nobody is
   * looking at. A sale rung up with it keeps it until it is paid or voided.
   */
  const leaveTill = useRef<() => void>(() => undefined);
  leaveTill.current = () => {
    const held = voucher.current();
    if (!held || saleWriter.committed?.id === held.saleId) return;
    void vouchersApi.release(held.saleId, held.view.id).catch(() => undefined);
  };
  useEffect(() => () => leaveTill.current(), []);

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

  /**
   * SCRUM-233 — A CHILD AT THIS GATE IS THE MEMBER'S RECORD, NOT A DRAFT.
   *
   * The two screens that hold a child's allergies and medical notes wrote to
   * two different places: the membership check's confirm step saved through
   * the member API (SCRUM-32/231, audited, `last_confirmed_at` stamped) while
   * this gate — the one reception is standing on when a child is being left in
   * the park's care — pushed the same fields into the browser's copy of the
   * member, where they were gone on the next reload. Nothing on either screen
   * said which one you were on.
   *
   * These three helpers put the gate on the same route. Only what the gate
   * actually captures is sent: a name, an age (a real date of birth when the
   * picker was used), the allergy/medical line and the dietary restriction.
   * The medical ALERT is deliberately not sent — the gate has no switch for
   * it, and the API raises it from the allergy text, which is the answer the
   * counter wants when nobody chose otherwise (see ChildDetailsFields, where
   * the switch exists and is therefore sent).
   */
  const gateChildBody = (slot: SupervisedSlot, age: number): Record<string, unknown> => ({
    name: slot.name.trim(),
    dateOfBirth: slot.dateOfBirth ?? null,
    ageYears: age,
    allergies: slot.allergiesMedical.trim() || null,
    foodRestrictions: slot.foodRestrictions.trim() || null,
  });

  /**
   * What actually changed against the saved record — or null when nothing did.
   *
   * Only changed fields go in, for the reason `childDetailsPatch` gives: a
   * PATCH that names a field sets it, so re-sending the whole slot would
   * overwrite the medical notes and the staff notes this gate cannot even
   * show, and would fill the audit row's before/after with fields nobody
   * touched.
   */
  const gateChildPatch = (
    slot: SupervisedSlot,
    age: number,
    saved: SavedChild,
  ): Record<string, unknown> | null => {
    const patch: Record<string, unknown> = {};
    const name = slot.name.trim();
    if (name && name !== saved.childName.trim()) patch.name = name;
    if ((slot.dateOfBirth ?? '') !== (saved.dateOfBirth ?? '')) {
      patch.dateOfBirth = slot.dateOfBirth ?? null;
      patch.ageYears = age;
    } else if (age !== saved.childAge) {
      patch.ageYears = age;
    }
    const allergies = slot.allergiesMedical.trim();
    if (allergies !== (saved.allergiesMedical ?? '').trim()) patch.allergies = allergies || null;
    // The slot's dietary box is pre-filled from food restrictions FALLING BACK
    // to the dietary line (slotPatchFromSavedChild), so it is compared against
    // the same fallback — otherwise every confirm of an untouched child would
    // write a copy of their dietary line into their food restrictions.
    const food = slot.foodRestrictions.trim();
    if (food !== (saved.foodRestrictions ?? saved.dietary ?? '').trim()) {
      patch.foodRestrictions = food || null;
    }
    return Object.keys(patch).length > 0 ? patch : null;
  };

  /** Put a child the API has just answered with back onto the member in hand. */
  const applySavedChild = (child: SavedChild) =>
    setMember((m) => {
      if (!m) return m;
      const children = m.savedChildren ?? [];
      return {
        ...m,
        savedChildren: children.some((c) => c.id === child.id)
          ? children.map((c) => (c.id === child.id ? child : c))
          : [...children, child],
      };
    });

  /** The slot whose save is in flight, so a second press cannot double-write. */
  const [confirmingSlotId, setConfirmingSlotId] = useState<string | null>(null);

  // "Still correct?" → write any edits back to the saved profile and mark done.
  // The profile is the member's record on the platform; a correction here is
  // the same audited PATCH the membership check makes. A slot nobody edited
  // sends nothing. A failed write leaves the slot UNCONFIRMED and says why —
  // a green tick over a correction that did not land is the fake success this
  // ticket exists to remove.
  const handleConfirmSlot = (id: string) => {
    if (confirmingSlotId) return;
    const slot = superSlots.find((s) => s.id === id);
    const age = slot ? slotAge(slot) : null;
    const saved = slot?.savedChildId
      ? member?.savedChildren?.find((c) => c.id === slot.savedChildId)
      : undefined;
    const patch = slot && saved && age !== null ? gateChildPatch(slot, age, saved) : null;
    if (!patch || !slot?.savedChildId) {
      setConfirmedSavedIds((prev) => (prev.includes(id) ? prev : [...prev, id]));
      return;
    }
    setConfirmingSlotId(id);
    void membersApi
      .updateChild(slot.savedChildId, patch)
      .then((res) => {
        applySavedChild(apiChildToSavedChild(res.child));
        setConfirmedSavedIds((prev) => (prev.includes(id) ? prev : [...prev, id]));
      })
      .catch((err: unknown) => {
        toast({
          title: `Couldn't save ${slot.name.trim() || 'this child'}'s details`,
          description: `${err instanceof Error ? err.message : 'Unknown error'} The change is still on screen — try again.`,
          variant: 'destructive',
        });
      })
      .finally(() => setConfirmingSlotId(null));
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

  /**
   * SCRUM-337 — "Remove from saved" takes the child off the member's record.
   *
   * It used to call the prototype's in-memory removal and then re-read the
   * member from that same copy. For a member the API answered with, that copy
   * holds nothing: the read came back undefined, the till lost the member it
   * was holding mid-visit, and the child was never removed from anything. The
   * button said "removed" and the next lookup found the child still there.
   *
   * This is the audited archive route instead, and the member stays in hand
   * the way `handleConfirmSlot` keeps it — the child is dropped from the copy
   * on screen rather than re-fetched from a store that does not have it.
   *
   * A failed call changes nothing: the child stays in the list and in its
   * slot, and the toast says so. Blanking the slot over a removal that did not
   * land is the same fake success the Confirm button was fixed for.
   */
  const handleRemoveSaved = (slotId: string, childId: string) => {
    void childrenApi
      .archive(childId)
      .then(() => {
        setMember((m) =>
          m
            ? { ...m, savedChildren: (m.savedChildren ?? []).filter((c) => c.id !== childId) }
            : m,
        );
        handleMarkNew(slotId);
      })
      .catch((err: unknown) => {
        toast({
          title: "Couldn't remove this child",
          description: `${err instanceof Error ? err.message : 'Unknown error'} They are still on the member's saved list.`,
          variant: 'destructive',
        });
      });
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

  /** True while the gate's children are being written to the member's record. */
  const [gateSaving, setGateSaving] = useState(false);

  const resolveSupervisionGate = async () => {
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

    /**
     * SCRUM-233 — THE CHILDREN ARE SAVED BEFORE ANYTHING ELSE HAPPENS HERE.
     *
     * These are the records carrying the allergies and the medical notes for
     * children about to be left in the park's care, so they go to the member
     * API — the same `POST /members/:id/children` / `PATCH` the membership
     * check makes, both audited server-side — and they go FIRST: a failure
     * leaves the gate exactly as it was, with the form filled in, and nothing
     * registered, converted or charged behind a save that did not happen.
     *
     * A walk-in with no member yet is registered the way the deferred tier
     * verification registers one (lib/deferredTierVerification): find the
     * parent's number, or create the member from the number and the name the
     * consent form already required, then write the children against it. With
     * no phone on the consent form there is nothing to key a record against —
     * nothing is written and nothing is claimed.
     *
     * A failure part-way through a group leaves the children already written
     * standing: they are records on the member, each one audited, and the
     * retry finds them by their slot's `savedChildId` and corrects them rather
     * than entering them twice.
     */
    let guardian = member;
    try {
      const parentPhone = superParentPhone.trim();
      if (!guardian && parentPhone && supervised.length > 0) {
        guardian = await findOrCreateGateMember(parentPhone, superParentName.trim());
        setMember(guardian);
      }
      if (guardian) {
        const confirmedChildIds: string[] = [];
        for (const { slot } of supervised) {
          const age = slotAge(slot);
          if (age === null) continue;
          const saved = slot.savedChildId
            ? guardian.savedChildren?.find((c) => c.id === slot.savedChildId)
            : undefined;
          if (slot.savedChildId && saved) {
            const patch = gateChildPatch(slot, age, saved);
            const child = patch
              ? apiChildToSavedChild((await membersApi.updateChild(slot.savedChildId, patch)).child)
              : saved;
            applySavedChild(child);
            confirmedChildIds.push(child.id);
          } else {
            // The photo is deliberately NOT saved (re-taken each visit).
            const child = apiChildToSavedChild(
              (await membersApi.addChild(guardian.id, gateChildBody(slot, age))).child,
            );
            applySavedChild(child);
            // Linked to the record it just became, one child at a time: if the
            // next child's write fails, pressing Continue again corrects this
            // one instead of entering them a second time.
            setSuperSlots((prev) =>
              prev.map((s) => (s.id === slot.id ? { ...s, savedChildId: child.id } : s)),
            );
            confirmedChildIds.push(child.id);
          }
        }
        // The visit is what stamps each child as confirmed today — the same
        // step the membership check takes once its edits have landed.
        if (confirmedChildIds.length > 0) {
          await visitsApi.create({ memberId: guardian.id, childIds: confirmedChildIds });
        }
      }
    } catch (err) {
      toast({
        title: "Couldn't save these children",
        description: `${err instanceof Error ? err.message : 'Unknown error'} Nobody has been checked in or charged — the details are still on screen.`,
        variant: 'destructive',
      });
      return;
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

  // Resolving the gate now writes to the member API, so it is asynchronous and
  // can be pressed only once at a time; `gateSaving` also parks the Continue
  // button while the children are being saved.
  const handleSupervisionContinue = () => {
    if (gateSaving) return;
    setGateSaving(true);
    void resolveSupervisionGate().finally(() => setGateSaving(false));
  };

  /**
   * The parent's own record, found by their number or created from it.
   *
   * The same two steps `saveDeferredVerification` takes, and for the same
   * reason: a child's record has to belong to somebody, and the number on the
   * consent form is who. A create that races another counter comes back
   * naming the member that already exists, so the children still land on the
   * right profile rather than failing the gate.
   */
  const findOrCreateGateMember = async (phone: string, name: string): Promise<Member> => {
    const found = (await membersApi.lookup(phone)).member;
    if (found) return apiMemberToMember(found);
    if (!name) {
      throw new Error("Add the parent's name — a child's record has to belong to somebody.");
    }
    try {
      const created = await membersApi.create({
        phone,
        nickname: name,
        preferredChannel: superParentContactMethod,
      });
      return apiMemberToMember(created.member);
    } catch (err) {
      const existingId =
        err instanceof ApiError && err.code === 'MEMBER_PHONE_EXISTS'
          ? (err.details as { memberId?: string } | undefined)?.memberId
          : undefined;
      if (!existingId) throw err;
      return apiMemberToMember((await membersApi.get(existingId)).member);
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
  // A tier verified before we knew who they are is saved to their profile now
  // (SCRUM-227): find or create the member through the API, then record the
  // evidence against them. Staff carry on to payment while that lands; a
  // failure says so and leaves the verification pending, so Done retries it.
  const handleCustomerDone = () => {
    if (pendingVerification && !member && customerPhone.trim()) {
      const verification = pendingVerification;
      // The sale this belongs to. If the till has moved on by the time the
      // three round trips finish, the record was still written against the
      // right member — it is only this screen that must not be touched.
      const epoch = saleEpochRef.current;
      void saveDeferredVerification({
        phone: customerPhone,
        nickname: customerNickname,
        channel: customerContactChannel,
        verification,
      })
        .then((saved) => {
          if (saleEpochRef.current !== epoch) return;
          setMember(saved);
          setPendingVerification(null);
          toast({
            title: `${tierLabel(verification.tier)} rate saved to ${saved.nickname}`,
            description: `${verification.proofType} · valid until ${verification.expiresAt ?? '—'}`,
          });
        })
        .catch((err: unknown) => {
          if (saleEpochRef.current !== epoch) return;
          toast({
            title: "Couldn't save the verified rate to a profile",
            description: `${err instanceof Error ? err.message : 'Unknown error'} The discount stands on this sale — it is not recorded against a member.`,
            variant: 'destructive',
          });
        });
    }
    setStep(5);
  };

  /**
   * EVERYTHING THAT MUST BE TRUE BEFORE THIS CART BECOMES A SALE.
   *
   * Split out of the payment handler because the sale is now recorded when the
   * payment screen OPENS, not when the money is confirmed (S2-09a): a cart that
   * may not be sold must be refused before it is written, not after. Each
   * refusal says what to fix and, where there is somewhere to fix it, goes
   * there. Run again at the confirm press, because the order panel is still
   * live on the payment screen and the cart can change under it.
   */
  const preflightSale = (): boolean => {
    // Hard re-gate: if the cart was edited back into an unaccompanied state after
    // the supervision gate resolved (cart mutations clear supervisionResolved),
    // force it through step 7 again before any charge — never finalize an
    // age-unchecked kids-only sale via this back door.
    if (!supervisionResolved && evaluateUnaccompanied()) {
      openSupervisionGate();
      return false;
    }
    if (!tier || !operator) return false;
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
      return false;
    }
    // Hard preflight: a tier nobody has priced on this ticket resolves to ฿0
    // and reads like a free ticket rather than a missing setting (SCRUM-228).
    // Refuse the sale and name what is unpriced, so it gets fixed in Admin →
    // Tickets rather than given away at the counter.
    const unpriced = unpricedCartLines(lines);
    if (unpriced.length > 0) {
      toast({
        title: 'This tier has no price',
        description: `${unpriced
          .map(
            (u) =>
              `${u.ticketName} has no ${tierLabel(u.tier)} ${u.what === 'adult' ? 'adult' : ''} price`,
          )
          .join(' · ')}. Set it in Admin → Tickets before selling at this tier.`,
        variant: 'destructive',
      });
      return false;
    }
    // Can't issue bracelets/receipts until this iPad knows which devices it drives.
    if (!station) {
      promptSetupStation(navigate);
      return false;
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
        return false;
      }
    }
    return true;
  };

  const handleCompletePayment = () => {
    if (!preflightSale()) return;
    if (!pendingPaymentMethod) return;
    // NOTHING BELOW THE PLATFORM'S ANSWER RUNS UNTIL IT ANSWERS (S2-09a): no
    // receipt, no band, no wallet, no confirmation screen. A refusal leaves the
    // till on this screen with the failure panel and the same sale waiting, so
    // a second press finishes the sale that was started rather than starting a
    // second one.
    void completeSale(saleEpochRef.current);
  };

  /**
   * The cart as the platform receives it, or null when there is nothing to send
   * it to — no platform station for this device, or a cart the engine will not
   * price.
   */
  const commitPayload = (): SaleCartPayload | null => {
    if (!cartIdentity || !cart.quote.satang) return null;
    const held = voucher.held;
    return buildCartPayload(lines, discounts, manualDiscounts, cartIdentity, cart.quote.satang, {
      mode: cart.quote.pricingMode,
      modeReason: cart.quote.pricingModeReason,
      // S2-10b — the voucher rides by its code, and the amount due is the
      // platform's quote: only the platform knows what a voucher takes off, so
      // the figure on screen with one on the cart is its figure, not this till's.
      ...(held ? { promoCodes: [held.code], expectedTotalSatang: toSatang(cart.totals.total) } : {}),
    });
  };

  /**
   * S2-10b — the sale with the voucher on it, written only against the
   * platform's own price, and only under the id the voucher is held for.
   *
   * The id is decided first (`saleWriter.prepare`): a new cart takes the one
   * the voucher was held for, and one that cannot — its key spent on a refused
   * attempt — takes a fresh one, and the voucher is moved to it before the
   * commit goes out. False, with the reason on the voucher's card, when the
   * sale must not be written.
   */
  const voucherReadyFor = async (input: SaleWriteInput): Promise<boolean> => {
    if (!voucher.held) return true;
    if (cart.quote.source !== 'platform') {
      // Why, in the platform's words where it gave some — the card says the same.
      voucher.refuse(
        voucherUnpriced ?? VOUCHER_BEING_PRICED,
        voucher.held.code,
        cart.error?.code ?? 'VOUCHER_NOT_PRICED',
      );
      return false;
    }
    return voucher.moveTo(saleWriter.prepare(input));
  };

  /**
   * The commit's input, with the voucher's sale id when one is held.
   *
   * NEVER CLOSED AT PAY, ฿0 INCLUDED (S2-10b). Pay rings the sale up and opens
   * the payment screen; Confirm Payment Received closes it (`completeSale`),
   * through the finalise that takes no tender when nothing is owed. A ฿0 sale
   * closed at Pay was finished — its voucher used up — while the screen still
   * offered Cancel, and Cancel then threw the finished sale away.
   */
  const writeInput = (payload: SaleCartPayload): SaleWriteInput => ({
    cart: payload,
    finalise: false,
    ...(voucher.held ? { preferSaleId: voucher.held.saleId } : {}),
  });

  /** Why this sale cannot be offered to the ledger at all. */
  const unwritableReason = (): string =>
    !cartIdentity
      ? 'This device is not on a platform station, so there is nowhere to write the sale.'
      : `This cart could not be priced by the platform's engine: ${cart.quote.reason ?? 'unknown reason'}`;

  /** A sale finished after this till had moved on to somebody else. */
  const noteSaleLeftBehind = (sale: ApiSale, saleId: string) => {
    toast({
      title: 'A sale was saved for the previous visitor',
      description: `This till moved on before it could finish. Sale ${sale.receiptNumber ?? saleId} is recorded and nothing was printed for it — find it in the sale list.`,
      variant: 'destructive',
    });
  };

  /**
   * PAY RECORDS THE SALE. Reaching the payment screen writes the row — its
   * lines, its discounts, the tier, the trading day — in `tendering`, with no
   * receipt number, because no money has arrived yet. The screen then shows the
   * amount due for a sale the platform already holds.
   *
   * A ฿0 sale is no exception (S2-10b): it has nothing to tender, but it is
   * still only rung up here and closed by Confirm Payment Received, so the
   * screen's Cancel can void it and a voucher on it stays the family's until
   * then.
   *
   * Editing the order after this and paying commits the corrected cart as its
   * own sale; the one written here stays on the platform, unpaid and unnumbered
   * — which is what an order that was rung up and not paid for is. Voiding it
   * is S2-11.
   */
  const recordSaleOnPlatform = async (epoch: number): Promise<void> => {
    if (!preflightSale()) return;
    const payload = commitPayload();
    if (!payload) return; // said on the confirmation screen, not in a toast at the visitor
    const input = writeInput(payload);
    if (!(await voucherReadyFor(input))) return;
    if (saleEpochRef.current !== epoch) return;
    const outcome = await saleWriter.commit(input);
    if (saleEpochRef.current !== epoch) {
      if (outcome.ok && outcome.written) noteSaleLeftBehind(outcome.sale, outcome.saleId);
    }
  };

  // Entering the payment screen is the Pay press. Every route into it — a known
  // member, the customer-details handoff, the supervision gate — arrives here.
  useEffect(() => {
    if (step !== 5) return;
    void recordSaleOnPlatform(saleEpochRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step]);

  /**
   * The money arrived: close the sale, then do everything a finished sale does.
   *
   * The commit is asserted again first. It costs no round trip when the cart on
   * screen is the one already recorded — the writer answers from the sale it
   * holds — and when the order was corrected on this screen it is what records
   * the corrected cart instead of finalising the old one.
   */
  const completeSale = async (epoch: number) => {
    if (!tier || !pendingPaymentMethod || !operator || !station) return;

    const payload = commitPayload();
    if (!payload) {
      // A voucher is never honoured on a sale the platform does not write: it
      // is used up only by the platform, in the transaction that closes it. Why
      // this one cannot be written is said as it is — not as "offline".
      if (voucher.held) {
        voucher.refuse(unwritableReason(), voucher.held.code, 'SALE_NOT_WRITABLE');
        return;
      }
      // Nowhere to write it. Finish on the till and SAY SO, rather than show a
      // confirmation screen that looks like a saved sale.
      finalizeSale(saleWriter.declareUnwritten(unwritableReason()), quotedPricing(cart.quote));
      return;
    }

    const input = writeInput(payload);
    if (!(await voucherReadyFor(input))) return;
    if (saleEpochRef.current !== epoch) return;
    const committed = await saleWriter.commit(input);
    // The till has moved on — cancelled, or already serving the next visitor.
    // The sale itself is written and safe; what must not happen is this answer
    // printing a band for somebody else's child. It must not be silent either:
    // somebody pressed Cancel while a sale was being saved, and a sale now
    // exists that nothing on this screen will ever mention again.
    if (saleEpochRef.current !== epoch) {
      if (committed.ok && committed.written) noteSaleLeftBehind(committed.sale, committed.saleId);
      return;
    }
    if (!committed.ok) return; // the failure panel is showing; nothing is finalised
    if (!committed.written) {
      finalizeSale(committed.saleId, quotedPricing(cart.quote));
      return;
    }

    let recorded = committed.sale;
    if (recorded.status !== 'finalised') {
      // THE TENDER. One press, one method, and the amount due taken in full —
      // all this screen knows. S2-10a adds the cash keypad, the card terminal
      // and the QR result onto this same call.
      const closed = await saleWriter.finalise({
        method: pendingPaymentMethod,
        kind: paymentMethodKind(pendingPaymentMethod),
        amountSatang: recorded.totals.grossSatang,
        tenderedSatang: recorded.totals.grossSatang,
        changeSatang: 0,
      });
      if (saleEpochRef.current !== epoch) {
        if (closed.ok && closed.written) noteSaleLeftBehind(closed.sale, closed.saleId);
        return;
      }
      if (!closed.ok) return;
      if (closed.written) recorded = closed.sale;
    }
    /**
     * S2-10b — THE VOUCHER IS USED UP. A sale closed under the id the voucher
     * is held for, with its code on the cart, used it: the platform does that
     * in the transaction that closes the sale — this press's finalise, with the
     * tender, or with none for a sale the voucher took to ฿0 — and refuses the
     * close when it cannot (`consumeSaleVouchers`). From here it is the
     * confirmation's, and nothing may release it.
     */
    const held = voucher.current();
    if (held && recorded.status === 'finalised' && recorded.id === held.saleId) {
      setVoucherUsed(held);
      voucher.reset();
    }
    finalizeSale(committed.saleId, quotedPricing(cart.quote, recorded));
  };

  /**
   * Try again after a refusal. The same sale where the same cart is still on
   * screen; a new number where the cart was corrected, or where the platform
   * says this sale's number was already spent on a different body.
   */
  const handleRetrySaleWrite = () => {
    const epoch = saleEpochRef.current;
    // Before a method is chosen there is no tender to record, so a retry is the
    // record alone.
    if (!pendingPaymentMethod) {
      void recordSaleOnPlatform(epoch);
      return;
    }
    void completeSale(epoch);
  };

  /**
   * Everything a finished sale does: the local record the prototype's History,
   * Today and reporting screens still read (S2-11 moves them onto the API),
   * promo counters, wallets, bands and paper.
   *
   * `saleId` is the platform's own id for this sale, so the row in the ledger
   * and the record on this till are the same sale by number.
   *
   * `quoted` is the money, carried rather than recomputed: what the platform
   * charged is what the confirmation screen, the receipt lines and the history
   * detail read (S2-09a).
   */
  const finalizeSale = (saleId: string, quoted: SaleQuotedPricing) => {
    if (!tier || !pendingPaymentMethod || !operator || !station) return;
    const newSale = buildSale({
      id: saleId,
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
      quoted,
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

  // The amount due, as the platform quoted it (S2-09a). `cart.quote.source`
  // says whether that is what happened; the note under the total on the order
  // panel shows it when it is not.
  const total = cart.totals.total;

  // Pay is blocked until: at least one billable participant, every drop-off child
  // has a play-ticket length chosen, and every nanny drop-off line has a nanny
  // assigned. A nanny may cover several kids, so there's no uniqueness check.
  const dropOffCartLines = lines.filter((l) => l.dropOff);
  const allLengthsChosen = dropOffCartLines.every((l) => l.dropOff!.lengthChosen);
  const nannyDropOffLines = lines.filter((l) => l.dropOff?.service === 'nanny');
  const allNanniesAssigned = nannyDropOffLines.every((l) => !!l.dropOff!.nannyId);
  /**
   * S2-10b — THE VOUCHER ON THIS CART, AS THE PLATFORM PRICED IT, and whether
   * that holds Pay back. A voucher is charged only at the platform's own figure,
   * so Pay waits for the platform's quote; and a voucher the quote says has
   * nothing to come off — a THB voucher with no tickets, a 1+1 short of two kids
   * of its package — is shown with the platform's reason rather than carried to
   * a commit that would refuse it. A free-item voucher is a sale on its own: the
   * item is the line, and the platform puts it on the bill.
   */
  const voucherQuote =
    voucher.held && cart.quote.source === 'platform' ? (cart.quote.voucher ?? null) : null;
  /**
   * Why the platform's figure is missing, when it is: its refusal in its own
   * words (a lost hold answers VOUCHER_NOT_HELD), and "online only" only when
   * nothing answered (`voucherUnpricedReason`).
   */
  const voucherUnpriced = voucher.held
    ? voucherUnpricedReason({
        quote: cart.quote,
        pending: cart.pending,
        error: cart.error,
        offline: tillOffline(),
      })
    : null;
  const voucherHoldsPay =
    voucher.held !== null && (voucher.busy || voucherQuote === null || !voucherQuote.applicable);
  const voucherFreeItem = voucher.held?.view.effect.type === 'free_item';
  /** Rung up with the voucher: it goes only with a void now, which Cancel does. */
  const voucherRungUp =
    voucher.held !== null && saleWriter.committed?.id === voucher.held.saleId;
  const canPay =
    (lines.some((l) => l.kids + l.adults > 0) || voucherFreeItem) &&
    allLengthsChosen &&
    allNanniesAssigned &&
    !voucherHoldsPay;

  // Build a live, Sale-shaped view model for the customer display. Once the sale
  // is finalized (step 6) we use the locked-in result so credit grants/ids stay stable.
  const liveSale: Sale =
    saleResult ?? {
      ...buildSale({
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
      }),
      // The amount the visitor's own screen shows while paying is the quoted
      // one, not a second computation of it (S2-09a). `buildSale` prices the
      // preview from the prototype's arithmetic; everything else on the
      // preview — the lines, the grants — is unchanged.
      total: cart.totals.total,
    };

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
              unpriced={unpricedCartLines(lines).length > 0}
              selectedMethod={pendingPaymentMethod}
              onSelectMethod={setPendingPaymentMethod}
              onComplete={handleCompletePayment}
              onBack={handlePaymentBack}
              busy={saleWriter.state.kind === 'writing' || saleWriter.state.kind === 'finalising'}
              busyLabel={saleWriter.state.kind === 'finalising' ? 'Recording the payment…' : undefined}
              notice={
                <SaleWriteFailure
                  state={saleWriter.state}
                  onRetry={handleRetrySaleWrite}
                  onDismiss={handlePaymentBack}
                />
              }
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
              busy={gateSaving}
            />
          )}
          {step === 6 && saleResult && (
            <div className="flex h-full min-h-0 flex-col">
              <SaleNotSavedNotice state={saleWriter.state} />
              <div className="min-h-0 flex-1">
                <StepConfirmation
                  sale={saleResult}
                  onNewSale={resetSale}
                  note={voucherUsed ? <VoucherUsedNote held={voucherUsed} /> : undefined}
                />
              </div>
            </div>
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
            onCancel={() => void handleCancel()}
            canPay={canPay}
            // The voucher's own row is its card below, not a promo badge with
            // a promo's remove button.
            totals={
              voucher.held
                ? {
                    ...cart.totals,
                    scannedDiscounts: cart.totals.scannedDiscounts.filter(
                      (sd) => sd.code !== voucher.held?.code,
                    ),
                  }
                : cart.totals
            }
            priceNote={<PriceSourceNote quote={cart.quote} pending={cart.pending} />}
            tierClaimRefusal={tierClaimRefusal}
            voucherLine={voucher.held ? <VoucherFreeItemLine held={voucher.held} /> : undefined}
            voucher={
              <div className="space-y-2">
                {voucher.held && (
                  <VoucherCard
                    held={voucher.held}
                    quoted={voucherQuote}
                    busy={voucher.busy}
                    // The platform has not priced this cart: a voucher's value is
                    // only ever its, so the card says why, in its words.
                    note={voucherUnpriced}
                    {...(voucherRungUp ? {} : { onRemove: () => void voucher.release() })}
                  />
                )}
                <RedeemVoucherEntry
                  onRedeem={redeemVoucher}
                  busy={voucher.busy}
                  disabled={step === 5}
                />
                {voucher.refusal && (
                  <VoucherRefusalCard refusal={voucher.refusal} onDismiss={voucher.dismiss} />
                )}
                {cancelRefusal && (
                  <TillRefusalNotice
                    message={cancelRefusal}
                    onDismiss={() => setCancelRefusal(null)}
                    testId="cancel-refusal"
                  />
                )}
              </div>
            }
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
              totals={saleResult ? undefined : cart.totals}
              voucherPrize={voucher.held?.view.prize ?? null}
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
        branchId={apiBranchIdForSlug(branch.id)}
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
                  if (e.key === 'Enter') registerEventPassGuest();
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
                disabled={!captureNameInput.trim() || captureNameBusy}
                onClick={registerEventPassGuest}
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
                  void loadDropOffRegistration(pendingDropOffRegistration.registrationId);
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
