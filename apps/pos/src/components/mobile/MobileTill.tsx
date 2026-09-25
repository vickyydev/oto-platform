import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { useLocation } from 'wouter';
import {
  CustomerTier, CartLine, CheckIn, ContactChannel, Discount, ManualDiscount, Sale,
  SaleQuotedPricing, TicketType,
  Member, TierVerification, DropOffServiceType, SelectedAddOn, Booking,
} from '@/types';
import type { DiscountComponentOption } from '@/components/shared/ManualDiscountModal';
import { useStation } from '@/station/StationContext';
import { dispatchPrintJobs, promptSetupStation, ticketPrintJobs } from '@/lib/printRouting';
import { takeCorrectedOrder } from '@/lib/correctedOrder';
import { takeDropOffHandoff } from '@/lib/dropoffHandoff';
import {
  computeLineTotal,
  computeLineBreakdown,
  isTierPriced,
  priceForTier,
  unpricedCartLines,
  unpricedLineReason,
  unpricedReason,
} from '@/lib/pricing';
import { makeDropOffLine, normalizeDropOffFees, resolveDropOffPricing } from '@/lib/dropoff';
import { resolveGroupRequirements, resolveSupervisionOutcome, confirmationsSatisfied, buildAcknowledgedConfirmations } from '@/lib/supervision';
import { buildSale, computeTotals } from '@/lib/sale';
import { dropOrphanedDiscounts } from '@/lib/manualDiscount';
import { resolveAutoTier, tierLabel } from '@/lib/membership';
import { saveDeferredVerification } from '@/lib/deferredTierVerification';
import {
  getDiscountReasons,
  recordSale, getTicketTypes, getDropOffPricing,
  getCheckInsByRegistration, checkInFamilyWithPayment, linkCheckInSaleId, getDefaultTier,
  getSupervisionPolicy, registerWalkInChildren, recordSupervisionWaiver,
  getPrintTemplate, ensureSaleGrantWallet, issueWalkInBands, issueBookingBands, getDiscountByCode, incrementPromoUsage,
  type CheckInPaymentInput,
} from '@/mockApi';
import { validatePromoCode, resolveFreeItem } from '@/lib/promoVoucher';
import { paymentMethodKind, paymentMethodLabel } from '@/lib/payments';
import { summarizeTax, roundTHB } from '@/lib/tax';
import { subscribeCatalog } from '@/store/catalogStore';

import { useOperator } from '@/auth/OperatorContext';
import { useBranch } from '@/branch/BranchContext';
import { apiBranchIdForSlug } from '@/api/catalogBridge';
import { ApiError, NetworkError, isMissingRoute } from '@/api/client';
import { membersApi } from '@/api/platform';
import { lookupMember } from '@/api/members';
import {
  bookingsApi,
  redemptionFromConflict,
  type PlatformBooking,
  type RedeemOutcome,
} from '@/api/bookings';
import {
  buildCartPayload,
  claimVerifiedTier,
  promoChargeSatang,
  quotedPricing,
  refusedPromoCodes,
  type ApiSale,
  type CartIdentity,
  type SaleCartPayload,
} from '@/api/sales';
import { useCartQuote } from '@/lib/cartQuote';
import { useSaleWriter } from '@/lib/saleWriter';
import { PriceSourceNote, SaleNotSavedNotice, SaleWriteFailure } from '@/components/till/SaleWriteStatus';
import { QuoteRefusalNote } from '@/components/fnb/QuoteRefusalNote';
import { QuoteFaultNote } from '@/components/fnb/QuoteFaultNote';
import { saleNumberLabel, type SaleNumber } from '@/components/till/StepConfirmation';
import { toast } from '@/hooks/use-toast';
import { useLanguage } from '@/i18n/LanguageContext';

import { StepCustomerType } from '@/components/till/StepCustomerType';
import { StepAddTicket } from '@/components/till/StepAddTicket';
import { DropOffLineConfig, type DropOffLineUpdate } from '@/components/till/DropOffLineConfig';
import { AddDropOffModal } from '@/components/till/AddDropOffModal';
import { StepPayment } from '@/components/till/StepPayment';
import { SupervisionGate, slotAge, type SupervisedSlot } from '@/components/till/SupervisionGate';
import { ConsentCapture } from '@/components/till/ConsentCapture';
import { CustomerDisplay } from '@/components/till/CustomerDisplay';
import { OrderSummary } from '@/components/till/OrderSummary';
import { ManualDiscountModal } from '@/components/shared/ManualDiscountModal';
import { VerifyTierModal } from '@/components/shared/VerifyTierModal';
import { QrCode } from '@/components/till/QrCode';
import { RedeemBookingModal } from '@/components/till/RedeemBookingModal';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from '@/components/ui/dialog';

import { HandToCustomer } from './HandToCustomer';
import { MobileCartSheet } from './MobileCartSheet';

import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { ArrowLeft, CheckCircle2, Baby, User, UtensilsCrossed, Printer, QrCode as QrCodeIcon } from 'lucide-react';
import { cn } from '@/lib/utils';

// ─── Mobile step types ────────────────────────────────────────────────────────

type MobileStep =
  | 'tier'
  | 'tickets'
  | 'configure'
  | 'dropoff-config'
  | 'supervision'
  | 'review'
  | 'payment'
  | 'done';

/** Which customer-facing content to show in the hand-to-customer overlay. */
type HandoffMode = 'input' | 'consent' | 'qr' | null;

// ─── Mobile confirmation screen ───────────────────────────────────────────────

function MobileConfirmation({
  sale,
  saleNumber,
  onNewSale,
}: {
  sale: Sale;
  /** The platform's answer about this sale's number — see `SaleNumber`. */
  saleNumber: SaleNumber;
  onNewSale: () => void;
}) {
  const braceletRows = sale.lines.flatMap((line) => {
    const rows: { id: string; kind: 'child' | 'adult'; count: number; ticket: string; duration: string }[] = [];
    if (line.kids > 0)
      rows.push({ id: `${line.id}-c`, kind: 'child', count: line.kids, ticket: line.ticketType.name, duration: line.ticketType.durationLabel });
    if (line.adults > 0)
      rows.push({ id: `${line.id}-a`, kind: 'adult', count: line.adults, ticket: line.ticketType.name, duration: line.ticketType.durationLabel });
    return rows;
  });

  // The sale's own quoted figures where it has them (S2-09a) — the same rule as
  // the counter till's confirmation: one price, wherever a person reads one.
  const taxRows =
    sale.quoted?.taxRows ??
    summarizeTax(computeTotals(sale.lines, sale.discounts ?? [], sale.manualDiscounts).taxBreakdown);
  const receiptTpl = getPrintTemplate('receipt');
  const showCreditInfo = receiptTpl ? !!receiptTpl.fields.voucherInfo : true;

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div className="shrink-0 p-5 text-center border-b">
        <div className="w-14 h-14 bg-emerald-500/20 rounded-full flex items-center justify-center text-emerald-500 mx-auto mb-3">
          <CheckCircle2 className="w-8 h-8" />
        </div>
        <h2 className="text-xl font-bold tracking-tight">Payment Successful</h2>
        {/* The receipt number, never the internal id — SCRUM-203. */}
        <p className="text-muted-foreground mt-1 text-sm">
          {[saleNumberLabel(saleNumber), `฿${sale.total}`, paymentMethodLabel(sale.paymentMethod ?? '')]
            .filter(Boolean)
            .join(' · ')}
        </p>
        {taxRows.length > 0 && (
          <p className="text-muted-foreground/70 mt-0.5 text-[11px]">
            {taxRows.map((r) => `${r.label} ฿${roundTHB(r.amount)}`).join(' · ')}
          </p>
        )}
      </div>

      <ScrollArea className="flex-1">
        <div className="p-4 space-y-5">
          {/* Bracelets */}
          <div>
            <div className="flex items-center gap-2 mb-2">
              <Printer className="w-4 h-4 text-primary" />
              <h3 className="text-sm font-bold">Bracelets to Print</h3>
              <span className="ml-auto text-xs text-muted-foreground">
                {sale.bracelets.children + sale.bracelets.adults} total
              </span>
            </div>
            <div className="space-y-2">
              {braceletRows.map((row) => (
                <div key={row.id} className="flex items-center gap-3 bg-card border rounded-xl p-3">
                  <div
                    className={cn(
                      'w-9 h-9 rounded-full flex items-center justify-center shrink-0',
                      row.kind === 'child' ? 'bg-primary/15 text-primary' : 'bg-sky-500/15 text-sky-400',
                    )}
                  >
                    {row.kind === 'child' ? <Baby className="w-4.5 h-4.5" /> : <User className="w-4.5 h-4.5" />}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="font-bold text-sm">
                      {row.count}× {row.kind === 'child' ? 'Child' : 'Adult'} bracelet
                      {row.count !== 1 ? 's' : ''}
                    </div>
                    <div className="text-xs text-muted-foreground truncate">
                      {row.duration} · {row.ticket}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Credit grants */}
          {showCreditInfo && sale.creditGrants.length > 0 && (
            <div>
              <div className="flex items-center gap-2 mb-2">
                <UtensilsCrossed className="w-4 h-4 text-primary" />
                <h3 className="text-sm font-bold">Credit grants</h3>
                <span className="ml-auto text-xs text-muted-foreground">
                  {sale.creditGrants.length} total
                </span>
              </div>
              <div className="space-y-2">
                {sale.creditGrants.map((v, i) => (
                  <div key={v.id} className="flex items-center gap-3 bg-card border rounded-xl p-3">
                    <QrCode seed={v.id} className="w-10 h-10 shrink-0" />
                    <div className="min-w-0 flex-1">
                      <div className="text-xs text-muted-foreground truncate">{v.label}</div>
                      {v.type === 'fnb_credit' ? (
                        <div className="font-bold text-primary">฿{v.valueTHB} credit</div>
                      ) : (
                        <div className="font-bold">×{v.quantity}</div>
                      )}
                    </div>
                    <div className="text-[10px] text-muted-foreground shrink-0">#{i + 1}</div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </ScrollArea>

      <div className="shrink-0 p-4 border-t">
        <Button size="lg" className="w-full h-14 text-lg font-bold" onClick={onNewSale}>
          Start New Sale
        </Button>
      </div>
    </div>
  );
}

/**
 * What the platform calls a sale it holds: its receipt number once the tender
 * closed it, and plainly "no number yet" until then (SCRUM-203).
 */
function saleNumberOf(sale: ApiSale): SaleNumber {
  return sale.receiptNumber ? { kind: 'receipt', number: sale.receiptNumber } : { kind: 'recorded' };
}

// ─── Line discount components helper ─────────────────────────────────────────

function lineDiscountComponents(line: CartLine): DiscountComponentOption[] {
  return computeLineBreakdown(line).map((item) => ({
    target:
      item.kind === 'addon'
        ? { kind: 'addon' as const, addOnId: item.key }
        : { kind: item.kind as 'kids' | 'adults' | 'socks' },
    label: item.quantity > 1 ? `${item.label} × ${item.quantity}` : item.label,
    amount: item.subtotal,
  }));
}

// ─── Step titles ──────────────────────────────────────────────────────────────

const STEP_TITLE: Record<MobileStep, string> = {
  tier: 'Customer Type',
  tickets: 'Add to Sale',
  configure: 'Configure Ticket',
  'dropoff-config': 'Configure Drop-Off',
  supervision: 'Children Playing Alone',
  review: 'Review Order',
  payment: 'Payment',
  done: 'Sale Complete',
};

function getHandoffCfg(
  t: (key: string) => string,
): Record<NonNullable<HandoffMode>, { title: string; subtitle: string; handBackLabel: string }> {
  return {
    input: {
      title: t('handToCustomer.inputTitle'),
      subtitle: t('handToCustomer.inputSubtitle'),
      handBackLabel: t('handToCustomer.handBackDefault'),
    },
    consent: {
      title: t('handToCustomer.consentTitle'),
      subtitle: t('handToCustomer.consentSubtitle'),
      handBackLabel: t('handToCustomer.handBackDefault'),
    },
    qr: {
      title: t('handToCustomer.qrTitle'),
      subtitle: t('handToCustomer.qrSubtitle'),
      handBackLabel: t('handToCustomer.paymentConfirmedHandBack'),
    },
  };
}

// ─── MobileTill ───────────────────────────────────────────────────────────────

/**
 * Self-contained mobile Till page. Mirrors all state and business logic from
 * the iPad Till.tsx (same lib/ functions, same mockApi mutators, same types)
 * but renders a portrait single-column wizard instead of the split-screen layout.
 *
 * Customer-facing moments (contact input, consent capture, QR payment) become
 * "hand to customer" full-screen takeovers on the single device.
 */
export default function MobileTill() {
  const { operator } = useOperator();
  const { station } = useStation();
  const { branch } = useBranch();
  const { t } = useLanguage();
  const [, navigate] = useLocation();

  // ── Mobile-specific step & overlay state ──────────────────────────────────
  const [mStep, setMStep] = useState<MobileStep>('tier');
  const [handoffMode, setHandoffMode] = useState<HandoffMode>(null);
  const [showCartSheet, setShowCartSheet] = useState(false);

  // ── Sale state (same pattern as Till.tsx) ─────────────────────────────────
  const [tier, setTier] = useState<CustomerTier | null>(null);
  const [lines, setLines] = useState<CartLine[]>([]);
  const [discounts, setDiscounts] = useState<Discount[]>([]);
  const [manualDiscounts, setManualDiscounts] = useState<ManualDiscount[]>([]);
  const [customerPhone, setCustomerPhone] = useState('');
  const [customerNickname, setCustomerNickname] = useState('');
  const [customerContactChannel, setCustomerContactChannel] = useState<ContactChannel>('whatsapp');

  // Same "save per member" behaviour as Till.tsx: persist the new preference
  // on the member's platform profile (fire and forget) if the person is
  // already an identified member.
  const handleCustomerContactChannelChange = (channel: ContactChannel) => {
    setCustomerContactChannel(channel);
    if (member) void membersApi.update(member.id, { preferredChannel: channel }).catch(() => {});
  };
  const [activeLineId, setActiveLineId] = useState<string | null>(null);
  const [member, setMember] = useState<Member | null>(null);
  const [showVerifyModal, setShowVerifyModal] = useState(false);
  const [verifyTier, setVerifyTier] = useState<CustomerTier | null>(null);
  const [pendingVerification, setPendingVerification] = useState<TierVerification | null>(null);
  /**
   * SCRUM-307 — the document check this cart is priced under, when the visitor
   * has no member record yet. It is an action id, never a tier: the row it
   * names was written on the platform's side under a permission check.
   */
  const [tierClaimActionId, setTierClaimActionId] = useState<string | null>(null);
  /**
   * SCRUM-311 — why the discounted rate that was on this screen has gone.
   *
   * Held rather than read off the live quote: acting on the refusal is what
   * makes it disappear, so without somewhere to keep it the cart would revert
   * to the default total with nothing on screen to say why.
   */
  const [tierClaimRefusal, setTierClaimRefusal] = useState<string | null>(null);
  const [showManualDiscountModal, setShowManualDiscountModal] = useState(false);
  const [showAddDropOff, setShowAddDropOff] = useState(false);
  const [saleResult, setSaleResult] = useState<Sale | null>(null);
  /** What the platform calls the finished sale, for the confirmation (SCRUM-203). */
  const [saleNumber, setSaleNumber] = useState<SaleNumber>({ kind: 'unknown' });
  const [pendingPaymentMethod, setPendingPaymentMethod] = useState<string | null>(null);
  const [promoError, setPromoError] = useState<string>('');

  // ── Booking redemption flow ───────────────────────────────────────────────
  const [showRedeemModal, setShowRedeemModal] = useState(false);
  const [pendingDropOffRegistration, setPendingDropOffRegistration] = useState<{
    registrationId: string;
    childNames: string[];
  } | null>(null);

  // ── Supervision state ─────────────────────────────────────────────────────
  const [superSlots, setSuperSlots] = useState<SupervisedSlot[]>([]);
  const [superParentName, setSuperParentName] = useState('');
  const [superConsentAck, setSuperConsentAck] = useState(false);
  const [superAcknowledgedConfirmationIds, setSuperAcknowledgedConfirmationIds] = useState<string[]>([]);
  const [supervisionResolved, setSupervisionResolved] = useState(false);

  const dropOffPricing = useMemo(() => resolveDropOffPricing(getDropOffPricing()), []);
  // Subscribe to catalog mutations so live Admin edits to the supervision
  // policy flow into the mobile till instead of a stale mount-time snapshot.
  useSyncExternalStore(subscribeCatalog, () => null);
  const supervisionPolicy = getSupervisionPolicy();

  // ── Handoff corrections (same as Till.tsx) ────────────────────────────────

  useEffect(() => {
    const correction = takeCorrectedOrder();
    if (!correction || correction.kind !== 'ticket') return;
    setTier(correction.tier);
    setLines(
      correction.lines.map((l) => ({
        ...l,
        id: Math.random().toString(36).substring(7),
      })),
    );
    if (correction.customerPhone) setCustomerPhone(correction.customerPhone);
    if (correction.customerNickname) setCustomerNickname(correction.customerNickname);
    setMStep('tickets');
  }, []);

  // Shared helper: load a drop-off registration into the till as drop-off lines.
  // Used by both the handoff useEffect and the booking redemption "Check in now" flow.
  //
  // S2-09b (SCRUM-204): the parent is looked up on the platform — the member
  // the counter's membership check finds — not in this browser's fixtures. A
  // number the platform does not know loads at the default rate with no
  // member, as before; a lookup that fails says so and loads the same way,
  // as the counter's membership check does. A Cancel pressed while the lookup
  // is out wins (`saleEpochRef`).
  const loadDropOffRegistration = async (registrationId: string) => {
    const children = getCheckInsByRegistration(registrationId).filter(
      (c) => c.status === 'registered',
    );
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
    if (found?.preferredChannel) setCustomerContactChannel(found.preferredChannel);
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
    // Land on tier so staff confirm rate before configuring
    setMStep('tier');
  };

  useEffect(() => {
    const registrationId = takeDropOffHandoff();
    if (!registrationId) return;
    void loadDropOffRegistration(registrationId);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once on mount: a drop-off handoff is taken when the till opens, and loadDropOffRegistration is a new function every render
  }, []);

  // ── Handlers (same logic as Till.tsx, mobile-specific step transitions) ───

  /**
   * Which sale this till is on — see the same ref in `Till.tsx` for what it
   * stops: a deferred tier save that resolves after Cancel would otherwise
   * put the previous visitor on the next visitor's sale.
   */
  const saleEpochRef = useRef(0);

  /**
   * S2-09a (SCRUM-203). The phone-held till writes to the same ledger, through
   * the same writer, with the same guarantees — one sale per press, a visible
   * failure, and the platform's own price on the screen. A second till that
   * quietly kept selling into memory would be the same defect with a smaller
   * screen.
   */
  const saleWriter = useSaleWriter();
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

  const cart = useCartQuote({
    lines,
    discounts,
    manualDiscounts,
    identity: cartIdentity,
    enabled: saleResult === null,
  });

  const resetSale = () => {
    saleEpochRef.current += 1;
    saleWriter.reset();
    setMStep('tier');
    setHandoffMode(null);
    setTier(null);
    setLines([]);
    setDiscounts([]);
    setManualDiscounts([]);
    setCustomerPhone('');
    setCustomerNickname('');
    setCustomerContactChannel('whatsapp');
    setActiveLineId(null);
    setSaleResult(null);
    setSaleNumber({ kind: 'unknown' });
    setPendingPaymentMethod(null);
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
    setSupervisionResolved(false);
    setShowCartSheet(false);
  };

  // Staff confirmed a paid booking in the RedeemBookingModal. Claim the booking
  // on the platform, then build + record the regular-guest sale (drop-off lines
  // are excluded — they get their own check-in flow), issue wristbands, dispatch
  // print jobs, then offer to check in any drop-off children via the existing
  // registration flow. Mirrors handleRedeemConfirm in the iPad Till.tsx exactly,
  // claim first included (SCRUM-234).
  const handleRedeemConfirm = async (
    booking: Booking,
    platform: PlatformBooking,
  ): Promise<RedeemOutcome> => {
    if (!operator) {
      return { ok: false, message: 'No operator is signed in at this till.' };
    }

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

    // Mint every wristband for the booking from each ticket's own package
    // (mirrors Till.tsx): credit-earning persons get a scannable wallet band,
    // everyone else a 0-balance gate/plain band; gate access from the ticket.
    const mintedCodes = issueBookingBands(sale, operator?.name);

    if (station) {
      dispatchPrintJobs(ticketPrintJobs(station, sale));
    }

    toast({
      title: 'Booking redeemed',
      description: `${booking.reference} — ${mintedCodes.length} wristband(s) issued.`,
    });

    // If the booking has drop-off children, prompt staff to check them in now.
    if (booking.registrationId) {
      const dropOffNames = booking.lines.flatMap((l) => (l.dropOff ? [l.dropOff.childName] : []));
      setPendingDropOffRegistration({ registrationId: booking.registrationId, childNames: dropOffNames });
    }

    return { ok: true };
  };

  const restateLinesToTier = (t: CustomerTier) => {
    setLines((prev) =>
      normalizeDropOffFees(
        prev.map((l) => ({
          ...l,
          tier: t,
          lineTotal: l.dropOff ? l.lineTotal : computeLineTotal({ ...l, tier: t }),
        })),
        dropOffPricing,
      ),
    );
  };

  const handlePickTier = (t: CustomerTier) => {
    setTier(t);
    restateLinesToTier(t);
    setMStep('tickets');
  };

  const handleRequestVerify = (t: CustomerTier) => {
    setVerifyTier(t);
    setShowVerifyModal(true);
  };

  // Proof confirmed: apply the tier and go back to ticketing. Same handler as
  // the counter till's (`pages/Till.tsx`), including the claim below — a phone
  // held by the same member of staff sells to the same visitors.
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
     * fired off — a cart quoted before it lands is quoted at the tourist rate,
     * and the commit then refuses the difference as SALE_LINE_PRICE_MISMATCH.
     *
     * A refusal stops here with the reason on screen, because a discounted
     * rate the platform has not recorded is one it will not let anybody
     * charge. A deployment with no such route is the exception: there the till
     * prices the cart itself and already says so on the confirmation screen.
     */
    const apiBranchId = apiBranchIdForSlug(branch.id);
    // The sale this check belongs to (SCRUM-313). The modal closes before the
    // claim lands and Cancel is live for the round trip; a handler resuming
    // onto a fresh sale would set the tier and the claim id on a family that
    // showed no document. Same guard as handleCustomerDone.
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
    setMStep('tickets');
  };

  /**
   * THE DOCUMENT CHECK BEHIND THIS CART HAS ALREADY PAID FOR A SALE — SCRUM-311.
   *
   * The counter till's handler, for the same reason (`pages/Till.tsx`): a
   * claim prices one sale, and a second cart naming it is quoted at the
   * default tier with a refusal beside it. The phone showed none of that — the
   * corner still said EXPAT, the panel still showed the expat prices it had
   * worked out itself, and the first sign was a 409 at Pay. So the till stops
   * naming a claim that prices nothing, puts the tier back where the platform
   * has it, restates the lines at that rate, and leaves the reason on the
   * panel for the person holding the phone.
   *
   * The same caveat as the counter's, written out there in full: the
   * platform's line-price reconciliation refuses the quote before it answers
   * the refusal, so this fires only for a cart sent without the optional
   * `lineTotalSatang`. The reason is given to the REVIEW step's panel and to
   * `MobileCartSheet`, which hands it to the panel it renders (SCRUM-329).
   */
  useEffect(() => {
    const refusal = cart.quote.tierClaimRefusal;
    // Forgetting the claim is the first thing this does, so the same guard
    // that asks "was a claim named?" is what stops it running twice.
    if (!refusal || cart.quote.tierSource !== 'default' || !tierClaimActionId) return;
    const fallback = getDefaultTier().id;
    setTierClaimActionId(null);
    setTierClaimRefusal(refusal.message);
    if (tier && tier !== fallback) {
      setTier(fallback);
      restateLinesToTier(fallback);
    }
    // `restateLinesToTier` is redefined every render and closes over the cart
    // it restates; listing it would re-run this on every keystroke.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cart.quote.tierClaimRefusal, cart.quote.tierSource, tierClaimActionId, tier]);

  const handleRemoveLine = (id: string) => {
    setSupervisionResolved(false);
    setLines((prev) => {
      const next = normalizeDropOffFees(prev.filter((l) => l.id !== id), dropOffPricing);
      setManualDiscounts((mds) => dropOrphanedDiscounts(mds, next));
      return next;
    });
    setActiveLineId((prev) => (prev === id ? null : prev));
  };

  const handleApplyManualDiscount = (md: ManualDiscount) => {
    setManualDiscounts((prev) => [...prev, md]);
  };

  const handleRemoveManualDiscount = (id: string) => {
    setManualDiscounts((prev) => prev.filter((md) => md.id !== id));
  };

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
   * SCRUM-401 — A CODE THE PLATFORM REFUSED COMES OFF THE ORDER.
   *
   * The platform prices every code from the park's own definition, so a code
   * this till's copy still honours can come back refused on the quote. The
   * panel draws code badges from the platform's figures, which leaves a refused
   * code with no badge and no remove button. Kept, it would still count in this
   * till's own stacking check (`validatePromoCode`), refusing the next code
   * against one nobody can see, and typed again it would be "already applied".
   * So it is taken off as its remove button would take it — a free item's line
   * with it — and the platform's reason goes on the promo box's refusal line,
   * after the removal has cleared it (`refusedPromoCodes`).
   *
   * Keyed on the quote alone: the platform's answer replaces it only when it is
   * about the cart on screen, discounts included, and the removal changes the
   * cart, so each answer is acted on once.
   */
  useEffect(() => {
    const refused = refusedPromoCodes(cart.quote, discounts);
    if (refused.length === 0) return;
    for (const { code } of refused) handleRemoveDiscount(code);
    setPromoError(refused.map((rejected) => rejected.reason).join(' '));
    // `discounts` is read as it stands with this quote, which was answered for
    // it; `handleRemoveDiscount` is redefined every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cart.quote]);

  const handleSelectTicket = (ticket: TicketType) => {
    if (!tier) return;
    // The card for an unpriced tier does not answer a press (SCRUM-228); this
    // refuses the same choice arriving any other way, so a ฿0 line cannot be
    // built at all rather than being caught on the way to the money.
    if (!isTierPriced(ticket, tier)) {
      toast({
        title: 'This tier has no price',
        description: unpricedReason(ticket.name, tier),
        variant: 'destructive',
      });
      return;
    }
    const id = Math.random().toString(36).substring(7);
    const base = { ticketType: ticket, tier, kids: 1, adults: 1, socks: 0, addOns: [] };
    const line: CartLine = { id, ...base, lineTotal: computeLineTotal(base) };
    setLines((prev) => [...prev, line]);
    setActiveLineId(id);
    setSupervisionResolved(false);
    setMStep('configure');
  };

  const handleAttachDropOff = (
    children: CheckIn[],
    serviceOverride?: DropOffServiceType,
  ) => {
    const activeTier = tier ?? getDefaultTier().id;
    if (!tier) setTier(activeTier);
    const defaultTicket = getTicketTypes()[0];
    setLines((prev) => {
      const present = new Set(prev.filter((l) => l.dropOff).map((l) => l.dropOff!.checkInId));
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
    setMStep('dropoff-config');
  };

  const cartNannyLoadsFor = (lineId: string): Record<string, number> => {
    const loads: Record<string, number> = {};
    for (const l of lines) {
      if (l.id === lineId) continue;
      const nid = l.dropOff?.service === 'nanny' ? l.dropOff.nannyId : undefined;
      if (nid) loads[nid] = (loads[nid] ?? 0) + 1;
    }
    return loads;
  };

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

  const handleUpdateDropOffExtras = (
    id: string,
    updates: { socks?: number; addOns?: SelectedAddOn[] },
  ) => {
    setLines((prev) =>
      normalizeDropOffFees(
        prev.map((l) => (l.id === id && l.dropOff ? { ...l, ...updates } : l)),
        dropOffPricing,
      ),
    );
  };

  const handleConfigureLine = (id: string) => {
    const line = lines.find((l) => l.id === id);
    setActiveLineId(id);
    setMStep(line?.dropOff ? 'dropoff-config' : 'configure');
  };

  const siblingNannyFor = (lineId: string): { id: string; name: string } | undefined => {
    for (const l of lines) {
      if (l.id === lineId) continue;
      if (l.dropOff?.service === 'nanny' && l.dropOff.nannyId) {
        return { id: l.dropOff.nannyId, name: l.dropOff.nannyName ?? '' };
      }
    }
    return undefined;
  };

  const handleDropOffLineDone = () => {
    const nextUnconfigured = lines.find(
      (l) =>
        l.id !== activeLineId &&
        l.dropOff &&
        (!l.dropOff.lengthChosen || (l.dropOff.service === 'nanny' && !l.dropOff.nannyId)),
    );
    if (nextUnconfigured) {
      setActiveLineId(nextUnconfigured.id);
      return;
    }
    handleBackToGrid();
  };

  const handleUpdateLine = (
    id: string,
    updates: Partial<Pick<CartLine, 'kids' | 'adults' | 'socks' | 'addOns'>>,
  ) => {
    setSupervisionResolved(false);
    setLines((prev) => {
      const next = prev.flatMap((l) => {
        if (l.id !== id) return [l];
        const merged = { ...l, ...updates };
        if (merged.kids + merged.adults === 0) return [];
        return [{ ...merged, lineTotal: computeLineTotal(merged) }];
      });
      setManualDiscounts((mds) => dropOrphanedDiscounts(mds, next));
      return next;
    });
    setActiveLineId((prev) => {
      if (prev !== id) return prev;
      const target = lines.find((l) => l.id === id);
      if (!target) return prev;
      const kids = updates.kids ?? target.kids;
      const adults = updates.adults ?? target.adults;
      return kids + adults === 0 ? null : prev;
    });
  };

  const dropEmptyActiveLine = () => {
    setLines((prev) => {
      const next = prev.filter((l) => l.id !== activeLineId || l.kids + l.adults > 0);
      setManualDiscounts((mds) => dropOrphanedDiscounts(mds, next));
      return next;
    });
  };

  const handleBackToGrid = () => {
    dropEmptyActiveLine();
    setActiveLineId(null);
    setMStep('tickets');
  };

  const evaluateUnaccompanied = () =>
    lines.filter((l) => !l.dropOff).reduce((a, l) => a + l.adults, 0) === 0 &&
    lines.filter((l) => !l.dropOff).reduce((a, l) => a + l.kids, 0) > 0;

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
          allergiesMedical: '',
          foodRestrictions: '',
          // Default: food not authorized until the parent explicitly chooses a
          // prepaid mode. mayOrderFood is derived from foodProvision.mode at registration.
          mayOrderFood: false,
          foodProvision: { mode: 'none', paidTHB: 0 },
          childPhotoUrl: undefined,
          // Unaccompanied kids always run the full safety flow; a no-fee child
          // is auto-enrolled at ฿0 (no opt-in button). See Till.openSupervisionGate.
          optIn: true,
        });
      }
    }
    setSuperSlots(slots);
    setSuperParentName('');
    setSuperConsentAck(false);
    setSuperAcknowledgedConfirmationIds([]);
    setMStep('supervision');
  };

  const handleUpdateSlot = (id: string, patch: Partial<SupervisedSlot>) =>
    setSuperSlots((prev) => {
      const next = prev.map((s) => (s.id === id ? { ...s, ...patch } : s));
      const resolved = resolveGroupRequirements(
        next
          .filter((s) => slotAge(s) !== null)
          .map((s) => ({ id: s.id, age: slotAge(s)! })),
        supervisionPolicy,
      );
      const eligibleById = new Map(resolved.map((r) => [r.id, r.waiverEligible]));
      return next.map((s) =>
        s.waived && !eligibleById.get(s.id) ? { ...s, waived: false } : s,
      );
    });

  const handleToggleWaiver = (id: string) =>
    setSuperSlots((prev) => prev.map((s) => (s.id === id ? { ...s, waived: !s.waived } : s)));

  const handleToggleConfirmation = (id: string) =>
    setSuperAcknowledgedConfirmationIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    );

  /**
   * Mobile-specific supervision continue: redirects to the consent handoff if
   * any supervised child still needs photo + consent before resolving the gate.
   * After consent is captured, a second tap on "Continue" runs the full
   * handleSupervisionContinue logic with mobile-specific step transitions.
   */
  const handleMobileSupervisionContinue = () => {
    const resolvedReqs = resolveGroupRequirements(
      superSlots
        .filter((s) => slotAge(s) !== null)
        .map((s) => ({ id: s.id, age: slotAge(s)! })),
      supervisionPolicy,
    );
    const byId = new Map(resolvedReqs.map((r) => [r.id, r]));

    const needsConsentCapture = superSlots.some((s) => {
      if (slotAge(s) === null) return false;
      const r = byId.get(s.id);
      const outcome = resolveSupervisionOutcome(r?.requirement ?? 'none', s.waived, s.optIn);
      return (
        outcome.needsConsent &&
        (!s.childPhotoUrl || !superConsentAck || !superParentName.trim())
      );
    }) || (superSlots.length > 0 && !confirmationsSatisfied(supervisionPolicy, superAcknowledgedConfirmationIds));

    if (needsConsentCapture) {
      setHandoffMode('consent');
      return;
    }

    // All consent captured — resolve supervision (same logic as Till.tsx).
    if (!tier || !operator) return;
    const policy = supervisionPolicy;
    const resolved2 = resolveGroupRequirements(
      superSlots.map((s) => ({ id: s.id, age: slotAge(s) ?? -1 })),
      policy,
    );
    const reqById = new Map(resolved2.map((r) => [r.id, r.requirement]));

    const supervised: { slot: SupervisedSlot; service: DropOffServiceType }[] = [];
    const plainBySource = new Map<string, number>();
    const waiversToAudit: { slot: SupervisedSlot; covering: SupervisedSlot }[] = [];

    for (const slot of superSlots) {
      const base = reqById.get(slot.id) ?? 'none';
      const outcome = resolveSupervisionOutcome(base, slot.waived, slot.optIn);
      if (slot.waived && base !== 'none') {
        const covering = superSlots
          .filter(
            (o) =>
              o.id !== slot.id &&
              (slotAge(o) ?? -1) >= policy.siblingWaiver.guardianMinAge,
          )
          .sort((a, b) => (slotAge(b) ?? 0) - (slotAge(a) ?? 0))[0];
        if (covering) waiversToAudit.push({ slot, covering });
      }
      if (outcome.service !== null) {
        supervised.push({ slot, service: outcome.service });
      } else {
        plainBySource.set(slot.sourceLineId, (plainBySource.get(slot.sourceLineId) ?? 0) + 1);
      }
    }

    const created = registerWalkInChildren(
      supervised.map(({ slot, service }) => ({
        name: slot.name,
        age: slotAge(slot) ?? 0,
        dateOfBirth: slot.dateOfBirth,
        service,
        parentName: superParentName,
        allergiesMedical: slot.allergiesMedical,
        foodRestrictions: slot.foodRestrictions,
        mayOrderFood: slot.mayOrderFood,
        foodProvision: slot.foodProvision,
        childPhotoUrl: slot.childPhotoUrl,
      })),
      {
        operatorName: operator.name,
        acknowledgedConfirmations: buildAcknowledgedConfirmations(supervisionPolicy, superAcknowledgedConfirmationIds),
      },
    );

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
        line = {
          ...withExtras,
          lineTotal: computeLineTotal(withExtras) + line.dropOff!.serviceFeeTHB + foodTHB,
        };
      }
      return line;
    });

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

    const firstNanny = dropLines.find((d) => d.dropOff!.service === 'nanny' && !d.dropOff!.nannyId);
    if (firstNanny) {
      setActiveLineId(firstNanny.id);
      setMStep('dropoff-config');
    } else {
      setActiveLineId(null);
      setMStep('review');
    }
  };

  const handleDoneAdding = () => {
    dropEmptyActiveLine();
    setActiveLineId(null);

    if (!supervisionResolved && evaluateUnaccompanied()) {
      openSupervisionGate();
      return;
    }
    // Known member or supervision already resolved → skip contact handoff.
    if (member || supervisionResolved) {
      setMStep('review');
    } else {
      setHandoffMode('input');
    }
  };

  // A tier verified before the visitor gave their details is saved to their
  // profile here (SCRUM-227) — same path as the counter till.
  const handleCustomerDone = () => {
    if (pendingVerification && !member && customerPhone.trim()) {
      const verification = pendingVerification;
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
    setHandoffMode(null);
    setMStep('review');
  };

  /** Intercept payment method selection: QR triggers "show QR to customer" handoff. */
  const handleMobileSelectMethod = (method: string) => {
    setPendingPaymentMethod(method);
    if (paymentMethodKind(method) === 'qr') {
      setHandoffMode('qr');
    }
  };

  /**
   * Everything that must be true before this cart becomes a sale — the counter
   * till's `preflightSale`, on the handheld's own steps. It runs when the
   * payment screen opens, because that is where the sale is recorded now
   * (S2-09a), and again at the confirm press.
   */
  const preflightSale = (): boolean => {
    if (!supervisionResolved && evaluateUnaccompanied()) {
      openSupervisionGate();
      return false;
    }
    if (!tier || !operator) return false;

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
      setMStep('dropoff-config');
      return false;
    }
    // A tier nobody has priced on this ticket resolves to ฿0 and reads like a
    // free ticket rather than a missing setting — refuse it (SCRUM-228).
    const unpriced = unpricedCartLines(lines);
    if (unpriced.length > 0) {
      toast({
        title: 'This tier has no price',
        description: unpriced.map(unpricedLineReason).join(' · '),
        variant: 'destructive',
      });
      return false;
    }
    if (!station) {
      promptSetupStation(navigate);
      return false;
    }
    return true;
  };

  const handleCompletePayment = () => {
    if (!preflightSale()) return;
    if (!pendingPaymentMethod) return;
    // The sale reaches the platform before a child is checked in, a band is
    // minted or a receipt is printed (S2-09a). A refusal leaves the till on
    // this screen with the same sale waiting for Try again.
    void completeSale(saleEpochRef.current);
  };

  const commitPayload = (): SaleCartPayload | null => {
    if (!cartIdentity || !cart.quote.satang) return null;
    // SCRUM-401 — with a promo code on the cart the amount due is the
    // platform's quote, which priced the code from the park's own definition
    // (`promoChargeSatang`). The counter till does the same.
    const promoCharge = promoChargeSatang(cart.quote, discounts);
    return buildCartPayload(lines, discounts, manualDiscounts, cartIdentity, cart.quote.satang, {
      mode: cart.quote.pricingMode,
      modeReason: cart.quote.pricingModeReason,
      ...(promoCharge !== undefined ? { expectedTotalSatang: promoCharge } : {}),
    });
  };

  const unwritableReason = (): string =>
    !cartIdentity
      ? 'This device is not on a platform station, so there is nowhere to write the sale.'
      : `This cart could not be priced by the platform's engine: ${cart.quote.reason ?? 'unknown reason'}`;

  const noteSaleLeftBehind = (sale: ApiSale, saleId: string) => {
    toast({
      title: 'A sale was saved for the previous visitor',
      description: `This till moved on before it could finish. Sale ${sale.receiptNumber ?? saleId} is recorded and nothing was printed for it — find it in the sale list.`,
      variant: 'destructive',
    });
  };

  /**
   * Pay records the sale: reaching the payment screen writes the row in
   * `tendering`, with no receipt number, because no money has arrived yet. A ฿0
   * sale has nothing to tender and is closed in the same call. Same seam as the
   * counter till — see `pages/Till.tsx`.
   */
  const recordSaleOnPlatform = async (epoch: number): Promise<void> => {
    if (!preflightSale()) return;
    const payload = commitPayload();
    if (!payload) return;
    const outcome = await saleWriter.commit({
      cart: payload,
      finalise: cart.quote.satang?.total === 0,
    });
    if (saleEpochRef.current !== epoch) {
      if (outcome.ok && outcome.written) noteSaleLeftBehind(outcome.sale, outcome.saleId);
    }
  };

  useEffect(() => {
    if (mStep !== 'payment') return;
    void recordSaleOnPlatform(saleEpochRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once on reaching the payment step: recordSaleOnPlatform is a new function every render, so listing it would call it again on every render
  }, [mStep]);

  /** The money arrived: close the sale, then finish it on this device. */
  const completeSale = async (epoch: number) => {
    if (!tier || !pendingPaymentMethod || !operator || !station) return;

    const payload = commitPayload();
    if (!payload) {
      finalizeSale(saleWriter.declareUnwritten(unwritableReason()), quotedPricing(cart.quote));
      return;
    }
    const committed = await saleWriter.commit({
      cart: payload,
      finalise: cart.quote.satang?.total === 0,
    });
    // Cancelled, or already on the next visitor. The sale is written and safe,
    // and saying nothing would leave a sale nobody on this screen mentions
    // again (the same rule as `Till.tsx`).
    if (saleEpochRef.current !== epoch) {
      if (committed.ok && committed.written) noteSaleLeftBehind(committed.sale, committed.saleId);
      return;
    }
    if (!committed.ok) return;
    if (!committed.written) {
      finalizeSale(committed.saleId, quotedPricing(cart.quote));
      return;
    }

    let recorded = committed.sale;
    if (recorded.status !== 'finalised') {
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
    finalizeSale(committed.saleId, quotedPricing(cart.quote, recorded), saleNumberOf(recorded));
  };

  const handleRetrySaleWrite = () => {
    const epoch = saleEpochRef.current;
    if (!pendingPaymentMethod) {
      void recordSaleOnPlatform(epoch);
      return;
    }
    void completeSale(epoch);
  };

  /**
   * Check the drop-off children in, record the sale locally, mint and print.
   *
   * `quoted` is the money as the platform charged it, carried onto the sale so
   * nothing downstream re-totals it (S2-09a).
   *
   * `number` is what the platform calls it. It defaults to `unknown` for the
   * paths that never reached the platform, where the confirmation shows no
   * number at all and the notice above it says the sale was not saved there
   * (SCRUM-203).
   */
  const finalizeSale = (
    saleId: string,
    quoted: SaleQuotedPricing,
    number: SaleNumber = { kind: 'unknown' },
  ) => {
    if (!tier || !pendingPaymentMethod || !operator || !station) return;

    const dropOffLines = lines.filter((l) => l.dropOff);
    if (dropOffLines.length > 0) {
      const items = dropOffLines.map((l) => {
        const d = l.dropOff!;
        const input: CheckInPaymentInput = {
          ticketTypeId: l.ticketType.id,
          ticketName: l.ticketType.name,
          tier,
          ticketPriceTHB: priceForTier(l.ticketType, tier),
          serviceType: d.service,
          serviceFeeTHB: d.serviceFeeTHB,
          durationHours: l.ticketType.hours,
          totalTHB: l.lineTotal,
          paymentMethod: pendingPaymentMethod,
          nannyId: d.service === 'nanny' ? d.nannyId : undefined,
          foodProvision: d.foodProvision,
        };
        return { checkInId: d.checkInId, input };
      });
      const checkedIn = checkInFamilyWithPayment(items, {
        operatorName: operator.name,
        operatorId: operator.id,
      });
      if (!checkedIn) {
        toast({
          title: 'Could not check in',
          description:
            'A nanny is no longer available, or a child was already checked in.',
          variant: 'destructive',
        });
        return;
      }
    }

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
    // Stamp each drop-off child's checkInSale with the real sale ID so the
    // checkout flow can issue a deterministic refund via linkCheckInSaleId.
    for (const l of lines) {
      if (l.dropOff?.checkInId) linkCheckInSaleId(l.dropOff.checkInId, newSale.id);
    }
    // Walk-in F&B credit: mint ONE QR-keyed wallet per fnb_credit grant at sale time
    // (mirrors Till.tsx). The printed voucher is scannable at F&B immediately.
    newSale.creditGrants.forEach((grant, i) => {
      if (grant.type === 'fnb_credit' && (grant.valueTHB ?? 0) > 0) {
        ensureSaleGrantWallet(newSale.id, i, grant.valueTHB ?? 0, operator.name, grant.gateAccess ?? false);
      }
    });
    // Mint the sale's remaining gate bands (persons without a credit wallet) —
    // mirrors Till.tsx so mobile sales are gate-resolvable.
    issueWalkInBands(newSale);
    setSaleResult(newSale);
    setSaleNumber(number);
    setHandoffMode(null);
    setMStep('done');
    dispatchPrintJobs(ticketPrintJobs(station, newSale));
  };

  // ── Derived ───────────────────────────────────────────────────────────────

  // The amount due, as the platform quoted it (S2-09a).
  const total = cart.totals.total;
  const dropOffCartLines = lines.filter((l) => l.dropOff);
  const allLengthsChosen = dropOffCartLines.every((l) => l.dropOff!.lengthChosen);
  const nannyDropOffLines = lines.filter((l) => l.dropOff?.service === 'nanny');
  const allNanniesAssigned = nannyDropOffLines.every((l) => !!l.dropOff!.nannyId);
  const canPay =
    lines.some((l) => l.kids + l.adults > 0) && allLengthsChosen && allNanniesAssigned;

  /**
   * THE PLATFORM LOOKED AT THIS CART AND OBJECTED — SCRUM-366, the rule the
   * F&B and shop stations have carried since SCRUM-342/351/352
   * (`pages/OrderStation.tsx`, `pages/MerchStation.tsx`).
   *
   * `useCartQuote` has carried this all along and this screen never read it:
   * driven with a refusal in the platform's own envelope the phone showed no
   * refusal at all — only the amber "Priced on this till", which it shows for
   * every cart the platform did not price, the ordinary ones included — and
   * Pay ฿2,420 invited the press (SCRUM-352's evidence).
   *
   * While a refusal stands Pay is off. The rule that refused the quote is the
   * rule the commit meets, so the press could only carry the family to the
   * payment screen and fail there. It clears the moment a later quote answers
   * — the moved price re-read, the line taken off — and Pay comes back with it.
   *
   * A FAULT IS NOT THAT: the api breaking, or a proxy answering in its place.
   * Neither is a judgement on this cart, so Pay stays on and the phone sells
   * through the outage on this till's own figures — `QuoteFaultNote` says the
   * platform failed and `PriceSourceNote` beneath it says whose figures are on
   * the screen.
   *
   * A cart the platform was never asked about is a third thing and reaches
   * neither note: `quoteCart` answers that one with this till's figures and a
   * reason rather than rejecting (`api/sales.ts`), so `cart.error` is null and
   * only the source note is drawn.
   */
  const quoteError = cart.error;
  const quoteRefusal = quoteError && quoteError.kind === 'refusal' ? quoteError : null;
  const quoteFault = quoteError && quoteError.kind === 'fault' ? quoteError : null;

  /**
   * Whether Pay opens: a cart this till can complete, that the platform has not
   * refused.
   *
   * The counter stations hang the platform's own words on the disabled button
   * as its `title` (`chargeBlockedReason`, `components/fnb/FnbCart.tsx`). The
   * panel this screen draws with takes one boolean and no reason
   * (`components/till/OrderSummary.tsx`), so the refusal joins the drop-off
   * checks inside it instead; the blocking note directly above the button
   * carries the platform's sentence, which is the part a person at the counter
   * reads — a `title` never appears on a phone held in a hand.
   */
  const payEnabled = canPay && !quoteRefusal;

  /**
   * The notes under the total: the same three, in the same order, that the
   * counter's F&B and shop panels draw. One node given to both the Review step
   * and the cart sheet, because they are one tap apart and a refusal that
   * showed on one and not the other would read as two different carts
   * (SCRUM-329 settled the same thing for the tier-claim refusal).
   *
   * All three are drawn only with a cart on the screen. The hook stops asking
   * when the last line is removed and keeps the error it last had
   * (`lib/cartQuote.ts`), so an emptied cart would otherwise still be carrying
   * the refusal of a cart that no longer exists; and an empty cart is never
   * sent for pricing at all, so `PriceSourceNote` on it called the platform's
   * silence a refusal — "did not price this cart" under a ฿0 total (SCRUM-437,
   * the counter's `pages/Till.tsx` draws the same rule). Nothing at all, rather
   * than an empty wrapper, so the panel's spacing has nothing to space.
   */
  const priceNotes =
    lines.length > 0 ? (
      <div className="space-y-2">
        <QuoteRefusalNote error={quoteRefusal} blocking />
        <QuoteFaultNote error={quoteFault} />
        <PriceSourceNote quote={cart.quote} pending={cart.pending} />
      </div>
    ) : undefined;

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
      // What the visitor's screen shows while paying is the quoted figure
      // (S2-09a), not a second computation of it.
      total: cart.totals.total,
    };

  const displayName = customerNickname.trim() || member?.nickname || '';

  // Back-nav behaviour per step
  const canGoBack = (
    ['tickets', 'configure', 'dropoff-config', 'supervision', 'review', 'payment'] as MobileStep[]
  ).includes(mStep);

  const handleBack = () => {
    switch (mStep) {
      case 'tickets': setMStep('tier'); break;
      case 'configure': handleBackToGrid(); break;
      case 'dropoff-config': handleBackToGrid(); break;
      case 'supervision': setMStep('tickets'); break;
      case 'review': setMStep('tickets'); break;
      case 'payment': setPendingPaymentMethod(null); setMStep('review'); break;
    }
  };

  // Show the compact cart bar only while building the order
  const showCartBar = (
    ['tier', 'tickets', 'configure', 'dropoff-config', 'supervision'] as MobileStep[]
  ).includes(mStep);

  // ── Step renderers ────────────────────────────────────────────────────────

  const activeLine = lines.find((l) => l.id === activeLineId) ?? null;

  const renderStep = () => {
    switch (mStep) {
      case 'tier':
        return (
          <div className="h-full flex flex-col p-4">
            <div className="flex-1 min-h-0 overflow-y-auto">
              <StepCustomerType
                member={member}
                selectedTier={tier ?? getDefaultTier().id}
                onPickTier={handlePickTier}
                onRequestVerify={handleRequestVerify}
              />
            </div>
            {lines.length === 0 && (
              <Button
                variant="outline"
                size="lg"
                className="w-full mt-3 h-14 shrink-0 flex items-center justify-center gap-2 border-primary/40 text-primary hover:bg-primary/5 hover:text-primary"
                onClick={() => setShowRedeemModal(true)}
              >
                <QrCodeIcon className="w-5 h-5" />
                Redeem Online Booking
              </Button>
            )}
          </div>
        );

      case 'tickets':
        return (
          <div className="h-full overflow-y-auto p-4">
            <StepAddTicket
              tier={tier!}
              activeLine={null}
              hasLines={lines.length > 0}
              onSelectTicket={handleSelectTicket}
              onUpdateLine={handleUpdateLine}
              onAddDropOff={() => setShowAddDropOff(true)}
              onBackToGrid={handleBackToGrid}
              onDone={handleDoneAdding}
            />
          </div>
        );

      case 'configure':
        return (
          <div className="h-full overflow-y-auto p-4">
            <StepAddTicket
              tier={tier!}
              activeLine={activeLine}
              hasLines={lines.length > 0}
              onSelectTicket={handleSelectTicket}
              onUpdateLine={handleUpdateLine}
              onAddDropOff={() => setShowAddDropOff(true)}
              onBackToGrid={handleBackToGrid}
              onDone={handleDoneAdding}
            />
          </div>
        );

      case 'dropoff-config':
        if (!activeLine?.dropOff) return null;
        return (
          <div className="h-full overflow-y-auto p-4">
            <DropOffLineConfig
              line={activeLine}
              tier={tier!}
              cartNannyLoads={cartNannyLoadsFor(activeLine.id)}
              onUpdate={handleUpdateDropOffLine}
              onUpdateExtras={handleUpdateDropOffExtras}
              onAssignNannyToAll={handleAssignNannyToAll}
              siblingNanny={siblingNannyFor(activeLine.id)}
              onBackToGrid={handleBackToGrid}
              onDone={handleDropOffLineDone}
            />
          </div>
        );

      case 'supervision':
        return (
          <div className="h-full overflow-y-auto p-4">
            <SupervisionGate
              slots={superSlots}
              parentName={superParentName}
              consentAck={superConsentAck}
              policy={supervisionPolicy}
              acknowledgedConfirmationIds={superAcknowledgedConfirmationIds}
              onUpdateSlot={handleUpdateSlot}
              onToggleWaiver={handleToggleWaiver}
              onBack={() => setMStep('tickets')}
              onContinue={handleMobileSupervisionContinue}
            />
          </div>
        );

      case 'review':
        return (
          <div className="h-full overflow-y-auto p-4">
            <OrderSummary
              tier={tier}
              customerName={displayName}
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
              onPay={() => setMStep('payment')}
              onCancel={resetSale}
              canPay={payEnabled}
              totals={cart.totals}
              priceNote={priceNotes}
              tierClaimRefusal={tierClaimRefusal}
            />
          </div>
        );

      case 'payment':
        return (
          <div className="h-full overflow-y-auto p-4">
            <StepPayment
              total={total}
              unpriced={unpricedCartLines(lines).length > 0}
              selectedMethod={pendingPaymentMethod}
              onSelectMethod={handleMobileSelectMethod}
              onComplete={handleCompletePayment}
              onBack={() => { setPendingPaymentMethod(null); setMStep('review'); }}
              busy={saleWriter.state.kind === 'writing' || saleWriter.state.kind === 'finalising'}
              busyLabel={saleWriter.state.kind === 'finalising' ? 'Recording the payment…' : undefined}
              notice={
                <SaleWriteFailure
                  state={saleWriter.state}
                  onRetry={handleRetrySaleWrite}
                  onDismiss={() => { setPendingPaymentMethod(null); setMStep('review'); }}
                />
              }
            />
          </div>
        );

      case 'done':
        return saleResult ? (
          <div className="flex h-full min-h-0 flex-col">
            <SaleNotSavedNotice state={saleWriter.state} />
            <div className="min-h-0 flex-1">
              <MobileConfirmation sale={saleResult} saleNumber={saleNumber} onNewSale={resetSale} />
            </div>
          </div>
        ) : null;
    }
  };

  // ── Hand-to-customer overlay content ─────────────────────────────────────

  const renderHandoffContent = () => {
    switch (handoffMode) {
      case 'input':
        return (
          <CustomerDisplay
            stage="input"
            sale={liveSale}
            phone={customerPhone}
            nickname={customerNickname}
            member={member}
            onPhoneChange={setCustomerPhone}
            onNicknameChange={setCustomerNickname}
            onIdentify={() => {}}
            onSkipIdentify={() => {}}
            onCustomerDone={handleCustomerDone}
            contactChannel={customerContactChannel}
            onContactChannelChange={handleCustomerContactChannelChange}
          />
        );
      case 'consent':
        return (
          <ConsentCapture
            slots={superSlots}
            parentName={superParentName}
            consentAck={superConsentAck}
            policy={supervisionPolicy}
            parentPhone={customerPhone}
            parentContactMethod={customerContactChannel}
            onParentPhoneChange={setCustomerPhone}
            onParentContactMethodChange={handleCustomerContactChannelChange}
            onParentNameChange={setSuperParentName}
            onConsentAckChange={setSuperConsentAck}
            onUpdateChild={handleUpdateSlot}
            acknowledgedConfirmationIds={superAcknowledgedConfirmationIds}
            onToggleConfirmation={handleToggleConfirmation}
          />
        );
      case 'qr':
        return (
          <CustomerDisplay
            stage="payment"
            sale={liveSale}
            phone={customerPhone}
            nickname={customerNickname}
            member={member}
            onPhoneChange={() => {}}
            onNicknameChange={() => {}}
            onIdentify={() => {}}
            onSkipIdentify={() => {}}
            onCustomerDone={() => {}}
          />
        );
      default:
        return null;
    }
  };

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="h-full flex flex-col bg-background overflow-hidden">

      {/* Step nav bar (hidden on 'done' — the confirmation is full-page) */}
      {mStep !== 'done' && (
        <div className="shrink-0 flex items-center gap-2 px-3 py-2 border-b bg-card/20">
          {canGoBack ? (
            <button
              type="button"
              onClick={handleBack}
              className="w-9 h-9 rounded-xl flex items-center justify-center text-muted-foreground hover:bg-muted transition-colors shrink-0"
              aria-label="Back"
            >
              <ArrowLeft className="w-5 h-5" />
            </button>
          ) : (
            <div className="w-9 shrink-0" />
          )}

          <div className="flex-1 min-w-0">
            <div className="text-sm font-bold leading-tight truncate">
              {STEP_TITLE[mStep]}
            </div>
            {tier && mStep !== 'tier' && (
              <div className="text-[11px] text-muted-foreground leading-tight">
                {tierLabel(tier)}
              </div>
            )}
          </div>

          {mStep !== 'payment' && lines.length > 0 && (
            <button
              type="button"
              onClick={resetSale}
              className="text-xs text-muted-foreground hover:text-foreground px-2 py-1 rounded shrink-0"
            >
              Cancel
            </button>
          )}
        </div>
      )}

      {/* Step content */}
      <div className="flex-1 min-h-0">
        {renderStep()}
      </div>

      {/* Compact cart bar — shows during ticket-building steps */}
      {showCartBar && (
        <MobileCartSheet
          open={showCartSheet}
          onOpenChange={setShowCartSheet}
          tier={tier}
          customerName={displayName}
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
          onPay={() => {
            setShowCartSheet(false);
            handleDoneAdding();
          }}
          onCancel={() => {
            setShowCartSheet(false);
            resetSale();
          }}
          canPay={payEnabled}
          tierClaimRefusal={tierClaimRefusal}
          totals={cart.totals}
          priceNote={priceNotes}
        />
      )}

      {/* Hand-to-customer overlay */}
      {handoffMode !== null && (() => {
        const cfg = getHandoffCfg(t)[handoffMode];
        return (
          <HandToCustomer
            title={cfg.title}
            subtitle={cfg.subtitle}
            handBackLabel={cfg.handBackLabel}
            onDone={() => {
              // For QR: return to payment step so staff can confirm receipt.
              // For consent: return to supervision so staff can tap Continue.
              // For input: advance to review.
              if (handoffMode === 'input') {
                setHandoffMode(null);
                setMStep('review');
              } else {
                setHandoffMode(null);
              }
            }}
            onCancel={() => setHandoffMode(null)}
          >
            {renderHandoffContent()}
          </HandToCustomer>
        );
      })()}

      {/* ── Shared modals (dialogs rendered in portal, work on mobile) ── */}

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

      {operator && (
        <ManualDiscountModal
          open={showManualDiscountModal}
          onOpenChange={setShowManualDiscountModal}
          subtotal={lines.reduce((acc, l) => acc + l.lineTotal, 0)}
          lines={lines.map((l) => ({
            id: l.id,
            label: `${l.ticketType.name} · ${l.kids + l.adults} ppl`,
            amount: l.lineTotal,
            components: l.dropOff ? undefined : lineDiscountComponents(l),
          }))}
          reasons={getDiscountReasons()}
          operatorId={operator.id}
          operatorName={operator.name}
          onApply={handleApplyManualDiscount}
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
    </div>
  );
}
