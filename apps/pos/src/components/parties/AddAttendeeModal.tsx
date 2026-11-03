import { useState, useEffect, useRef, type MutableRefObject } from 'react';
import { newId } from '@oto/shared';
import { useOperator } from '@/auth/OperatorContext';
import { ApiError } from '@/api/client';
import { openPassOnPlatform, readPaidPass, type EventWriteIds } from '@/api/events';
import { finaliseSale, salesApi, type ApiSale } from '@/api/sales';
import { usePaymentStage, type PaymentDisplayState } from '@/lib/usePaymentStage';
import type { SaleWriteOutcome } from '@/lib/saleWriter';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { StepPayment } from '@/components/till/StepPayment';
import { PromptPayCustomerScreen } from '@/components/shared/PromptPayCustomerScreen';
import {
  AttendeeFormFields,
  buildAttendeeInput,
  emptyAttendeeForm,
  type AttendeeForm,
  type SetAttendeeField,
} from '@/components/shared/AttendeeFormFields';
import { useCustomerDisplayPref } from '@/lib/customerDisplayPref';
import { paymentMethodKind } from '@/lib/payments';
import { ageFromDob } from '@/lib/childDob';
import type { EventAttendee, OtoEvent, Member, SavedChild } from '@/types';
import type { NewEventAttendeeInput } from '@/mockApi';
import {
  Tent,
  Sparkles,
  PartyPopper,
  UserPlus,
  Smile,
  Wallet,
  CheckCircle2,
  CalendarClock,
  X,
  Baby,
  Check,
  User,
} from 'lucide-react';

interface AddAttendeeModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  event: OtoEvent;
  /** Door payment amount (camp/event). 0 = no door-payment step (party tab or free). */
  doorFeeTHB: number;
  /** Amount that lands on the party tab (party type only); shown for transparency. */
  tabChargeTHB?: number;
  isParty: boolean;
  /**
   * When set, the modal starts with a child-picker step and pre-fills the
   * attendee form from the identified member + chosen saved child.
   */
  prefillMember?: Member | null;
  /** Saved children belonging to the identified member. */
  prefillSavedChildren?: SavedChild[];
  /**
   * Persist the attendee + billing. Called the moment a paid camp/event pass is
   * paid (so a completed payment always lands a roster entry), or immediately for
   * a free event / party. Return false if the sale could not be persisted — the
   * modal then stays on its current step instead of advancing to the choice.
   *
   * S2-20 E2: on the platform this is a request, so it may answer later; the
   * modal waits for it, and its buttons do nothing more while it does.
   * `savedChildId` is the saved child the form was pre-filled from, if any.
   */
  onSell: (result: {
    input: NewEventAttendeeInput;
    registerProperly: boolean;
    paymentMethod?: string;
    savedChildId?: string;
  }) => boolean | Promise<boolean>;
  /**
   * Resolve the check-in choice for the already-persisted attendee: checkInNow
   * mints + prints the band, otherwise they stay booked. The parent closes the modal.
   */
  onCheckIn: (checkInNow: boolean) => void;
  /**
   * SCRUM-732 — what a pass paid by QR or card needs from its host: where it is
   * sold, the ids its one sale is made under (the host's, so a cash press after a
   * declined card goes against the same sale) and where the paid child goes.
   */
  routedPass: {
    branchSlug: string;
    stationId: string | null | undefined;
    idsRef: MutableRefObject<EventWriteIds | null>;
    memberId?: string | null;
    onAttendee: (attendee: EventAttendee) => void;
  };
}

/** Why a pass's sale is voided when staff leave it with no money taken, as the voids report reads it. */
const PASS_LEFT_UNPAID = 'Event pass left unpaid at the till';

/** Build a partial AttendeeForm from a known member + optional saved child. */
function buildPrefillForm(member: Member, child?: SavedChild | null): Partial<AttendeeForm> {
  const derivedAge = child?.dateOfBirth ? ageFromDob(child.dateOfBirth) : null;
  return {
    parentName: member.nickname || '',
    parentPhone: member.phone || '',
    ...(child
      ? {
          name: child.childName,
          age: String(derivedAge ?? child.childAge),
          dateOfBirth: child.dateOfBirth,
          allergyFlag: !!(child.allergiesMedical),
          allergyDetail: child.allergiesMedical ?? '',
          dietaryFlag: !!(child.foodRestrictions),
          dietaryDetail: child.foodRestrictions ?? '',
        }
      : {}),
  };
}

// Customer-facing payment pane shown opposite StepPayment. Mirrors what the
// customer sees while the door fee is taken: a Thai QR when a QR tender is
// selected, otherwise a "pay our staff" prompt.
function CustomerPaymentPane({
  amount,
  qr,
  note,
  paymentMethod,
}: {
  amount: number;
  /** What the payment stage holds: the code the payment route answered with, once it has. */
  qr: PaymentDisplayState;
  note?: string;
  paymentMethod: string | null;
}) {
  const isQr = !!paymentMethod && paymentMethodKind(paymentMethod) === 'qr';
  if (isQr) {
    return (
      <PromptPayCustomerScreen
        amount={amount}
        qrPayload={qr.qrPayload}
        qrImageUrl={qr.qrImageUrl}
        expiresAt={qr.expiresAt}
        {...(note ? { note } : {})}
      />
    );
  }
  return (
    <div className="h-full w-full bg-gradient-to-b from-sky-950 via-slate-950 to-slate-950 text-white flex flex-col items-center justify-center text-center px-10">
      <div className="h-16 w-16 rounded-full bg-white/10 flex items-center justify-center mb-5">
        <Wallet className="w-8 h-8 text-sky-300" />
      </div>
      <h2 className="text-3xl font-black mb-3">Amount due</h2>
      <div className="text-6xl font-black text-sky-300 tabular-nums">฿{amount}</div>
      {note && <p className="text-lg text-white/60 mt-3">{note}</p>}
      <p className="text-xl text-white/60 mt-6 max-w-md">
        {paymentMethod
          ? 'Please complete payment with our staff.'
          : 'Our staff will help you choose how to pay.'}
      </p>
    </div>
  );
}

type ModalPhase = 'childPicker' | 'form' | 'payment' | 'checkin';

function initialPhase(prefillMember?: Member | null, prefillSavedChildren?: SavedChild[]): ModalPhase {
  if (prefillMember && prefillSavedChildren && prefillSavedChildren.length > 0) {
    return 'childPicker';
  }
  return 'form';
}

export function AddAttendeeModal({
  open,
  onOpenChange,
  event,
  doorFeeTHB,
  tabChargeTHB,
  isParty,
  prefillMember,
  prefillSavedChildren = [],
  onSell,
  onCheckIn,
  routedPass,
}: AddAttendeeModalProps) {
  const isCamp = event.type === 'camp';
  const { locked: operatorLocked } = useOperator();
  // Reuse the app-wide customer-display toggle (same one the Till split harness
  // uses) so it behaves like every other secondary screen.
  const [showCustomerDisplay, setShowCustomerDisplay] = useCustomerDisplayPref();
  const [phase, setPhase] = useState<ModalPhase>(() => initialPhase(prefillMember, prefillSavedChildren));
  const [form, setForm] = useState<AttendeeForm>(() => {
    if (prefillMember) {
      return { ...emptyAttendeeForm, ...buildPrefillForm(prefillMember) };
    }
    return { ...emptyAttendeeForm };
  });
  const [paymentMethod, setPaymentMethod] = useState<string | null>(null);
  // Child selected in the picker: a SavedChild id, or '__new__' for a new child.
  const [pickedChildId, setPickedChildId] = useState<string | '__new__'>('__new__');
  // S2-20 E2 — the sell request is on its way: nothing is pressed twice meanwhile.
  const [selling, setSelling] = useState(false);
  // SCRUM-732 — one opening of this form is one payment stage.
  const [session, setSession] = useState(0);
  const scope = `event-pass:${event.id}:${session}`;
  const scopeRef = useRef(scope);
  scopeRef.current = scope;
  // SCRUM-732 — the sale rung up for a QR or a card, while no money is on it.
  const heldSaleRef = useRef<ApiSale | null>(null);

  // Reinitialise when the modal (re)opens so stale state from a previous sale is cleared.
  useEffect(() => {
    if (!open) return;
    setSession((s) => s + 1);
    heldSaleRef.current = null;
    const p = initialPhase(prefillMember, prefillSavedChildren);
    setPhase(p);
    setPaymentMethod(null);
    setSelling(false);
    // Default picker to first saved child when there are any.
    const firstChild = prefillSavedChildren[0];
    setPickedChildId(firstChild ? firstChild.id : '__new__');
    if (prefillMember) {
      // Pre-fill guardian; child fields filled once picker confirms.
      const firstPrefill = p === 'form' ? buildPrefillForm(prefillMember) : buildPrefillForm(prefillMember);
      setForm({ ...emptyAttendeeForm, ...firstPrefill });
    } else {
      setForm({ ...emptyAttendeeForm });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // The saved child the form was pre-filled from, when it was.
  const savedChildId = prefillMember && pickedChildId !== '__new__' ? pickedChildId : undefined;

  /**
   * SCRUM-732 — A QR OR A CARD GOES THE WAY THE TICKET TILL'S DOES: this stage,
   * the station's routing, the real code on the customer's screen, and nothing
   * recorded until the payment confirms. Cash stays the one press it was
   * (`handleConfirmPayment`). Pressing its submit rings the pass up once.
   */
  const stage = usePaymentStage({
    scope,
    isCurrentScope: (s) => s === scopeRef.current,
    active: open && phase === 'payment',
    // A staff lock, as at the ticket till. An unlock taken through the box stands
    // long after the link is back; it does not freeze a screen that is working.
    paused: operatorLocked,
    // A child waits on the answer, and this form holds the counter until there is one.
    reviewGatewayQr: true,
    totalSatang: Math.round(doorFeeTHB * 100),
    prepareSale: async (): Promise<SaleWriteOutcome> => {
      const ids = (routedPass.idsRef.current ??= { attendeeId: newId(), saleId: newId(), actionId: newId() });
      const outcome = await openPassOnPlatform({
        event,
        branchSlug: routedPass.branchSlug,
        stationId: routedPass.stationId,
        input: buildAttendeeInput(form),
        registerProperly: form.registerProperly,
        doorFeeTHB,
        ids,
        memberId: routedPass.memberId ?? null,
        childId: savedChildId ?? null,
      });
      if (outcome.ok && outcome.written) heldSaleRef.current = outcome.sale;
      else if (!outcome.ok && !outcome.retryable) routedPass.idsRef.current = null;
      return outcome;
    },
    finaliseSale: async (tender, actionId): Promise<SaleWriteOutcome> => {
      const saleId = heldSaleRef.current?.id ?? routedPass.idsRef.current?.saleId;
      if (!saleId || !actionId) {
        return { ok: false, saleId: saleId ?? '', message: 'This pass has not been recorded.', retryable: true };
      }
      try {
        const answer = await finaliseSale(saleId, actionId, tender);
        return { ok: true, written: true, saleId, ...answer };
      } catch (err) {
        return {
          ok: false,
          saleId,
          message: err instanceof Error ? err.message : 'The payment could not be confirmed.',
          retryable: !(err instanceof ApiError) || err.status >= 500 || err.code === 'IDEMPOTENCY_IN_FLIGHT',
          ...(err instanceof ApiError ? { code: err.code } : {}),
        };
      }
    },
    onComplete: async () => {
      // Paid: the sale has closed and the child is on the roster, on the platform.
      heldSaleRef.current = null;
      const attendeeId = routedPass.idsRef.current?.attendeeId;
      if (!attendeeId) return;
      routedPass.onAttendee(
        await readPaidPass({ event, branchSlug: routedPass.branchSlug, attendeeId, input: buildAttendeeInput(form) }),
      );
      setPhase('checkin');
    },
    onTenderCancelled: () => setPaymentMethod(null),
  });

  /** The method on this screen: the stage's once it holds the tender, which it may have let go. */
  const electronic = !!paymentMethod && ['card', 'qr'].includes(paymentMethodKind(paymentMethod));
  const usesStage = electronic || stage.locked;
  const chosenMethod = usesStage ? stage.state.method : paymentMethod;

  /** A sale rung up with no money on it is not left open behind a closed form. */
  const releaseHeldSale = () => {
    const held = heldSaleRef.current;
    if (!held) return;
    heldSaleRef.current = null;
    routedPass.idsRef.current = null;
    // A refusal leaves it for the till's left-behind card, which offers the void.
    void salesApi.voidSale(held.id, PASS_LEFT_UNPAID).catch(() => undefined);
  };

  const close = () => {
    // A tender waiting for its answer holds the screen, as it holds the ticket till.
    if (phase === 'payment' && stage.locked) return;
    releaseHeldSale();
    onOpenChange(false);
  };
  const closeRef = useRef(close);
  closeRef.current = close;

  // Escape closes the takeover, matching the previous dialog behavior.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeRef.current();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  const set: SetAttendeeField = (key, value) => setForm((f) => ({ ...f, [key]: value }));

  const canSubmit = form.name.trim().length > 0 && form.parentName.trim().length > 0;

  /** Confirm child selection and pre-fill the form. */
  const handlePickerContinue = () => {
    if (!prefillMember) { setPhase('form'); return; }
    const child = prefillSavedChildren.find((c) => c.id === pickedChildId) ?? null;
    setForm({ ...emptyAttendeeForm, ...buildPrefillForm(prefillMember, child) });
    setPhase('form');
  };

  /** One sell request at a time; false when it could not be persisted. */
  const sell = async (paymentMethodUsed?: string): Promise<boolean> => {
    if (selling) return false;
    setSelling(true);
    try {
      return await onSell({
        input: buildAttendeeInput(form),
        registerProperly: form.registerProperly,
        ...(paymentMethodUsed ? { paymentMethod: paymentMethodUsed } : {}),
        ...(savedChildId ? { savedChildId } : {}),
      });
    } finally {
      setSelling(false);
    }
  };

  const handleSubmitForm = async () => {
    if (!canSubmit || selling) return;
    // Parties ride the tab and always check in (no separate door payment, no
    // check-in choice — adding a party guest at the door means they're here now).
    // Persist first, then check in; only close on success.
    if (isParty) {
      if (!(await sell())) return;
      onCheckIn(true);
      close();
      return;
    }
    // Paid camp / event pass: take the flat entry fee first, then offer the
    // check-in choice (the attendee is created once the payment is confirmed).
    if (doorFeeTHB > 0) {
      setPhase('payment');
      return;
    }
    // Free (฿0) event: persist the attendee now, then offer the check-in choice.
    if (!(await sell())) return;
    setPhase('checkin');
  };

  const handleConfirmPayment = async () => {
    if (!paymentMethod || selling) return;
    // Pass is paid — persist the attendee + sale immediately so a completed
    // payment always lands a roster entry, THEN let staff choose check-in.
    if (!(await sell(paymentMethod))) return;
    heldSaleRef.current = null;
    setPhase('checkin');
  };

  const handleCheckInChoice = (checkInNow: boolean) => {
    // Attendee is already persisted; this only resolves the band-now-or-later choice.
    onCheckIn(checkInNow);
    close();
  };

  if (!open) return null;

  const TypeIcon = isCamp ? Tent : isParty ? PartyPopper : Sparkles;

  const submitLabel = isParty
    ? `Add & check in${tabChargeTHB ? ` · ฿${tabChargeTHB} to tab` : ''}`
    : doorFeeTHB > 0
      ? `Continue to payment · ฿${doorFeeTHB}`
      : 'Continue to check-in';

  // ── Child picker ─────────────────────────────────────────────────────────────
  // Staff picks which saved child to pre-fill from (or "a new child").
  const childPickerPane = (
    <div className="h-full flex flex-col min-h-0">
      <ScrollArea className="flex-1 min-h-0">
        <div className="mx-auto w-full max-w-lg px-6 py-5 space-y-4">
          <div>
            <h3 className="text-lg font-bold">Who is attending?</h3>
            <p className="text-sm text-muted-foreground mt-0.5">
              Pre-fill from a saved child or start fresh.
            </p>
          </div>

          <div className="space-y-2">
            {prefillSavedChildren.map((child) => {
              const age = child.dateOfBirth ? ageFromDob(child.dateOfBirth) : child.childAge;
              const selected = pickedChildId === child.id;
              return (
                <button
                  key={child.id}
                  type="button"
                  onClick={() => setPickedChildId(child.id)}
                  className={`w-full flex items-center gap-4 rounded-2xl border p-4 text-left transition-colors ${
                    selected
                      ? 'border-primary/60 bg-primary/10'
                      : 'border-foreground/10 bg-foreground/5 hover:bg-foreground/10'
                  }`}
                >
                  <div
                    className={`h-10 w-10 rounded-full flex items-center justify-center shrink-0 ${
                      selected ? 'bg-primary/20 text-primary' : 'bg-muted text-muted-foreground'
                    }`}
                  >
                    <Baby className="w-5 h-5" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="font-bold truncate">{child.childName}</div>
                    <div className="text-sm text-muted-foreground">Age {age}</div>
                    {(child.allergiesMedical || child.foodRestrictions) && (
                      <div className="text-xs text-amber-400/80 mt-0.5 truncate">
                        {[child.allergiesMedical, child.foodRestrictions].filter(Boolean).join(' · ')}
                      </div>
                    )}
                  </div>
                  {selected && (
                    <div className="shrink-0 h-6 w-6 rounded-full bg-primary flex items-center justify-center">
                      <Check className="w-4 h-4 text-primary-foreground" />
                    </div>
                  )}
                </button>
              );
            })}

            {/* New child option */}
            <button
              type="button"
              onClick={() => setPickedChildId('__new__')}
              className={`w-full flex items-center gap-4 rounded-2xl border p-4 text-left transition-colors ${
                pickedChildId === '__new__'
                  ? 'border-primary/60 bg-primary/10'
                  : 'border-foreground/10 bg-foreground/5 hover:bg-foreground/10'
              }`}
            >
              <div
                className={`h-10 w-10 rounded-full flex items-center justify-center shrink-0 ${
                  pickedChildId === '__new__'
                    ? 'bg-primary/20 text-primary'
                    : 'bg-muted text-muted-foreground'
                }`}
              >
                <UserPlus className="w-5 h-5" />
              </div>
              <div className="flex-1 min-w-0">
                <div className="font-bold">A new child</div>
                <div className="text-sm text-muted-foreground">Enter details manually</div>
              </div>
              {pickedChildId === '__new__' && (
                <div className="shrink-0 h-6 w-6 rounded-full bg-primary flex items-center justify-center">
                  <Check className="w-4 h-4 text-primary-foreground" />
                </div>
              )}
            </button>
          </div>

          {/* Guardian reminder */}
          {prefillMember && (
            <div className="flex items-center gap-3 rounded-xl bg-muted/40 px-4 py-3 text-sm text-muted-foreground">
              <User className="w-4 h-4 shrink-0" />
              <span>
                Guardian: <span className="font-semibold text-foreground">{prefillMember.nickname}</span>
                {prefillMember.phone && (
                  <span className="ml-1 text-foreground/60">· {prefillMember.phone}</span>
                )}
              </span>
            </div>
          )}
        </div>
      </ScrollArea>

      <div className="shrink-0 flex items-center justify-between gap-3 px-6 py-4 border-t border-white/10 bg-card/40">
        <Button variant="outline" onClick={close}>
          Cancel
        </Button>
        <Button onClick={handlePickerContinue}>
          Continue
        </Button>
      </div>
    </div>
  );

  // ── Form pane ─────────────────────────────────────────────────────────────────
  const staffPane =
    phase === 'childPicker' ? childPickerPane
    : phase === 'form' ? (
      <div className="h-full flex flex-col min-h-0">
        <ScrollArea className="flex-1 min-h-0">
          <div className="mx-auto w-full max-w-lg">
            {prefillMember && (
              <div className="px-6 pt-5 pb-0">
                <div className="flex items-center gap-2 rounded-xl bg-emerald-500/10 border border-emerald-500/20 px-4 py-3 text-sm text-emerald-300">
                  <User className="w-4 h-4 shrink-0" />
                  <span>
                    Pre-filled from <span className="font-semibold">{prefillMember.nickname}</span>'s profile — confirm or edit below.
                  </span>
                </div>
              </div>
            )}
            <AttendeeFormFields
              form={form}
              set={set}
              isCamp={isCamp}
              idPrefix="staff"
              showStaffControls
            />
          </div>
        </ScrollArea>
        <div className="shrink-0 flex items-center justify-between gap-3 px-6 py-4 border-t border-white/10 bg-card/40">
          <Button variant="outline" onClick={phase === 'form' && prefillSavedChildren.length > 0 ? () => setPhase('childPicker') : close}>
            {phase === 'form' && prefillSavedChildren.length > 0 ? 'Back' : 'Cancel'}
          </Button>
          <Button disabled={!canSubmit || selling} onClick={() => void handleSubmitForm()}>
            {submitLabel}
          </Button>
        </div>
      </div>
    ) : phase === 'payment' ? (
      <div className="h-full p-6">
        <div className="mx-auto w-full max-w-md h-full">
          <StepPayment
            total={doorFeeTHB}
            selectedMethod={paymentMethod}
            onSelectMethod={(method) => {
              setPaymentMethod(method);
              stage.selectMethod(method);
            }}
            onComplete={() => void handleConfirmPayment()}
            onBack={() => {
              // Back to the form may change the child, so the sale rung up for them goes.
              releaseHeldSale();
              if (electronic) setPaymentMethod(null);
              setPhase('form');
            }}
            busy={selling}
            fixedAmount
            {...(usesStage ? { paymentStage: stage } : {})}
          />
        </div>
      </div>
    ) : (
      <div className="h-full flex flex-col min-h-0 p-6">
        <div className="mx-auto w-full max-w-md flex-1 flex flex-col justify-center">
          <div className="text-center mb-8">
            <div className="inline-flex h-12 w-12 rounded-full bg-emerald-500/15 items-center justify-center mb-3">
              <CheckCircle2 className="w-6 h-6 text-emerald-400" />
            </div>
            <h3 className="text-xl font-bold">
              {doorFeeTHB > 0 ? 'Pass paid — check in now?' : 'Check in now?'}
            </h3>
            <p className="text-muted-foreground mt-1 text-sm">
              {form.name.trim() || 'This attendee'} is on the {event.title} roster. Check them
              in now to print their band, or leave them booked for later.
            </p>
          </div>
          <div className="space-y-3">
            <Button
              className="w-full h-16 text-base"
              onClick={() => handleCheckInChoice(true)}
            >
              <CheckCircle2 className="w-5 h-5 mr-2" />
              Check in now
              {form.parentAttending && (
                <span className="ml-2 text-xs font-normal opacity-80">+ parent band</span>
              )}
            </Button>
            <Button
              variant="outline"
              className="w-full h-16 text-base"
              onClick={() => handleCheckInChoice(false)}
            >
              <CalendarClock className="w-5 h-5 mr-2" />
              Leave as booked
            </Button>
          </div>
        </div>
      </div>
    );

  // Customer-facing pane — full-height secondary screen bound to the SAME form
  // state, so the parent can read/fill the child's details and watch the payment.
  const customerPane =
    phase === 'childPicker' ? (
      <div className="h-full w-full bg-gradient-to-b from-sky-950 via-slate-950 to-slate-950 text-white flex flex-col items-center justify-center text-center px-10">
        <div className="h-16 w-16 rounded-full bg-white/10 flex items-center justify-center mb-5">
          <Smile className="w-8 h-8 text-sky-300" />
        </div>
        <h2 className="text-3xl font-black mb-3">Welcome back!</h2>
        <p className="text-xl text-white/60 max-w-md">
          Our staff are setting up your child's registration for {event.title}.
        </p>
      </div>
    )
    : phase === 'form' ? (
      <div className="h-full w-full bg-gradient-to-b from-sky-950 via-slate-950 to-slate-950 text-white flex flex-col min-h-0">
        <div className="shrink-0 px-8 py-6 text-center">
          <div className="inline-flex items-center gap-2 text-violet-300 mb-2">
            <Smile className="w-5 h-5" />
            <span className="uppercase tracking-widest text-xs font-bold">Check-in</span>
          </div>
          <h2 className="text-3xl font-black">Tell us about your child</h2>
          <p className="text-white/60 mt-1">{event.title}</p>
        </div>
        <ScrollArea className="flex-1 min-h-0">
          <div className="mx-auto w-full max-w-md">
            <AttendeeFormFields
              form={form}
              set={set}
              isCamp={isCamp}
              idPrefix="cust"
              showStaffControls={false}
            />
          </div>
        </ScrollArea>
        <div className="shrink-0 px-8 py-4 text-center text-white/50 text-sm border-t border-white/10">
          A staff member will review and complete your check-in.
        </div>
      </div>
    ) : phase === 'payment' ? (
      <CustomerPaymentPane
        amount={doorFeeTHB}
        qr={stage.display}
        note={event.title}
        paymentMethod={chosenMethod}
      />
    ) : (
      <div className="h-full w-full bg-gradient-to-b from-emerald-950 via-slate-950 to-slate-950 text-white flex flex-col items-center justify-center text-center px-10">
        <div className="h-16 w-16 rounded-full bg-white/10 flex items-center justify-center mb-5">
          <CheckCircle2 className="w-8 h-8 text-emerald-300" />
        </div>
        <h2 className="text-3xl font-black mb-3">
          {doorFeeTHB > 0 ? 'Payment complete' : "You're all set"}
        </h2>
        <p className="text-xl text-white/60 max-w-md">
          Welcome to {event.title}! Our staff will hand you your band.
        </p>
      </div>
    );

  const phaseTitle =
    phase === 'childPicker'
      ? 'Who is attending?'
      : phase === 'form'
        ? isParty
          ? 'Add party guest'
          : 'Sell event pass'
        : phase === 'payment'
          ? 'Take entry payment'
          : 'Check in';

  return (
    <div className="fixed inset-0 z-50 bg-background text-foreground flex flex-col">
      {/* Top bar — title + the customer-display toggle (mirrors the Till harness). */}
      <div className="shrink-0 flex items-center justify-between gap-3 px-5 h-14 border-b border-white/10">
        <div className="flex items-center gap-3 min-w-0">
          <div className="h-9 w-9 rounded-full bg-primary/15 flex items-center justify-center">
            <UserPlus className="w-5 h-5 text-primary" />
          </div>
          <div className="min-w-0">
            <h2 className="text-base font-bold leading-tight truncate">{phaseTitle}</h2>
            <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <TypeIcon className="w-3.5 h-3.5" />
              {event.title}
            </span>
          </div>
        </div>
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            className="h-8 text-amber-300 hover:text-amber-200 hover:bg-amber-500/20"
            onClick={() => setShowCustomerDisplay((v) => !v)}
          >
            {showCustomerDisplay ? 'Hide' : 'Show'} customer display
          </Button>
          <Button variant="ghost" size="icon" onClick={close} aria-label="Close">
            <X className="w-5 h-5" />
          </Button>
        </div>
      </div>

      {/* Split body — same sizing as the Till customer-display harness. */}
      <div className="flex-1 flex min-h-0">
        <div
          className={`${showCustomerDisplay ? 'w-1/2 border-r border-white/10' : 'w-full'} h-full min-w-0`}
        >
          {staffPane}
        </div>
        {showCustomerDisplay && <div className="w-1/2 h-full min-w-0">{customerPane}</div>}
      </div>
    </div>
  );
}
