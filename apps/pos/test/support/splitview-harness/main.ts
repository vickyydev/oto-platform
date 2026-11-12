import { createElement as h, useEffect, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { StepAddTicket } from '@/components/till/StepAddTicket';
import { StepCustomerType } from '@/components/till/StepCustomerType';
import { StepPayment } from '@/components/till/StepPayment';
import { HoldSaleButtons } from '@/components/till/HeldSales';
import { FamilyCheckInCard } from '@/components/dropoff/FamilyCheckInCard';
import { MobileChildDetail } from '@/components/mobile/dropoff/MobileChildDetail';
import { MobileRefundFlow } from '@/components/mobile/history/MobileRefundFlow';
import { SupervisionGate, type SupervisedSlot } from '@/components/till/SupervisionGate';
import { loadSellableStock } from '@/api/stock';
import { getTicketTypes } from '@/mockApi';
import { usePaymentStage } from '@/lib/usePaymentStage';
import { partPaidShown } from '@/lib/heldSales';
import type { CartLine, CheckIn, Member, SupervisionPolicy } from '@/types';
import { readSplitView } from './measure';
import '@/fonts.css';
import '@/index.css';

/**
 * SCRUM-884 / SCRUM-918 / SCRUM-901 — the page the split view measurement
 * drives (`test/s884-split-view-measured.test.ts` serves it).
 *
 * A TILL SCREEN (`screen=configure|tickets|tiers-*|payment`) is drawn in the
 * counter till's own frame, copied class for class from `pages/Till.tsx` (the
 * test pins those classes against that file): the staff half — the whole
 * width, or `w-1/2` beside the customer display when `split=1` — holding the
 * wizard column (`flex-1 ... p-6`, the region read) and the 360px order
 * column. Above it stands the till's chrome at the height staging measured on
 * 12 November at 1440x900 and 1680x1050 (the harness banner, the station
 * header, the out-of-stock strip and the overdue banner: 206px); the order
 * column and the customer half are left empty, as their widths are all the
 * staff column depends on. The step components are the till's own, fed the
 * branch catalogue the till seeds, with the add-ons out of stock as staging's
 * were and a member named as staging's ZZ TEST members are.
 *
 * THE PARTY PAYMENT (`screen=party-payment`) draws the same payment step as the
 * party modals hold it (`PartySettleModal` "Take the balance", and
 * `AddAttendeeModal`): their full-screen frame, copied class for class (pinned
 * by the test), the step in its `max-w-md` pane (the region read) with
 * `stickyFoot={false}` as they pass it, beside the customer half when
 * `split=1`. The step is under @xl there at every window, so it is the screen
 * that proves the counter till's split-view footer stays the till's own.
 *
 * A BOARD SCREEN (`screen=card|card-single`) draws the Check-in board's family
 * card at `w=` px wide; `screen=phone-card` the phone's family screen. Their
 * family is SCRUM-886 picture 07a's: one child paid for, three long-named
 * siblings to pay, Cancel booking beside them.
 *
 * SCRUM-956 / SCRUM-953 / SCRUM-954 — three more phone screens:
 * `screen=phone-card-long` the family screen with a child whose name is
 * long (an allergy, a dietary note, WhatsApp confirmed, food not allowed);
 * `screen=phone-refund` the phone's refund, whose By item rows carry long
 * names; `screen=phone-gate` the phone till's supervision gate in its step's
 * frame (`MobileTill.tsx`, `h-full overflow-y-auto p-4`).
 */
const params = new URLSearchParams(window.location.search);
const screen = params.get('screen') ?? 'configure';
const split = params.get('split') === '1';

// --- The platform's answers ----------------------------------------------------

/** Staging's shelf on 12 November: four add-ons out, Grip Socks in sizes. */
const SELLABLE = {
  branchId: 'harness-branch',
  products: [
    { productId: 'inv-a-socks', name: 'Regular Socks', sizes: [{ variantId: null, label: null, available: 0, lowStockThreshold: null }] },
    { productId: 'inv-a-locker', name: 'Locker Rental', sizes: [{ variantId: null, label: null, available: 0, lowStockThreshold: null }] },
    { productId: 'inv-a-cup', name: 'Refillable Drink Cup', sizes: [{ variantId: null, label: null, available: 0, lowStockThreshold: null }] },
    { productId: 'inv-a-glow', name: 'Glow Band', sizes: [{ variantId: null, label: null, available: 0, lowStockThreshold: null }] },
    {
      productId: 'inv-a-grip-socks', name: 'Grip Socks', sizes: [
        { variantId: 'grip-s', label: 'S', available: 12, lowStockThreshold: null },
        { variantId: 'grip-m', label: 'M', available: 9, lowStockThreshold: null },
      ],
    },
  ],
};

const realFetch = window.fetch.bind(window);
window.fetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, window.location.href);
  if (!url.pathname.startsWith('/api/')) return realFetch(input, init);
  const body = /\/stock\/sellable$/.test(url.pathname) ? SELLABLE : undefined;
  return Promise.resolve(
    body === undefined
      ? new Response(JSON.stringify({ error: { code: 'NOT_FOUND', message: 'Not found' } }), { status: 404 })
      : new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } }),
  );
};

// --- The fixtures --------------------------------------------------------------

const verifiedMember: Member = {
  id: '01990000-0000-7000-8000-000000000884',
  phone: '+66898580021',
  nickname: 'ZZ TEST 858 Expat',
  tierVerification: {
    tier: 'expat', proofType: 'Passport', verifiedAt: '2026-11-12T03:00:00.000Z',
    verifiedBy: 'Som', verifiedById: 'account-1', expiresAt: '2030-01-01',
  },
};
const unverifiedMember: Member = { id: '01990000-0000-7000-8000-000000000885', phone: '+66898580022', nickname: 'ZZ TEST 885 split 1440 r01' };

function configureLine(): CartLine {
  const ticket = getTicketTypes()[0]!;
  return { id: 'line-1', ticketType: ticket, tier: 'tourist', kids: 1, adults: 1, socks: 0, addOns: [], lineTotal: 1040 };
}

const noop = () => undefined;

function PaymentScreen() {
  const stage = usePaymentStage({
    scope: 'harness', isCurrentScope: () => true, active: true, totalSatang: 104_000,
    prepareSale: () => new Promise(() => undefined),
    finaliseSale: () => new Promise(() => undefined),
    onComplete: noop,
  });
  return h(StepPayment, {
    total: 1040, selectedMethod: stage.state.method, onSelectMethod: noop, onComplete: noop, onBack: noop,
    paymentStage: stage,
    // As the counter till passes them (`pages/Till.tsx`): Save as partly paid once Partial payment is on.
    holdControls: h(HoldSaleButtons, { holdReason: null, partPaidReason: null, showPartPaid: partPaidShown(stage.state.partial, 0), onHold: noop, onSavePartPaid: noop }),
  });
}

/** The party modals' payment step: no held sales, Back and Confirm in the prototype's row. */
function PartyPaymentStep() {
  const stage = usePaymentStage({
    scope: 'harness-party', isCurrentScope: () => true, active: true, totalSatang: 150_000,
    prepareSale: () => new Promise(() => undefined),
    finaliseSale: () => new Promise(() => undefined),
    onComplete: noop,
  });
  return h(StepPayment, {
    total: 1500, selectedMethod: stage.state.method, onSelectMethod: noop, onComplete: noop, onBack: noop,
    paymentStage: stage, stickyFoot: false,
  });
}

/** `PartySettleModal`'s frame at its payment phase (classes pinned by the test). */
function PartyFrame() {
  return h('div', { className: 'fixed inset-0 z-50 bg-background text-foreground flex flex-col' },
    h('div', { className: 'shrink-0 flex items-center justify-between gap-3 px-5 h-14 border-b border-white/10' }, 'Take the balance'),
    h('div', { className: 'flex-1 flex min-h-0' },
      h('div', { className: `${split ? 'w-1/2 border-r border-white/10' : 'w-full'} h-full min-w-0` },
        h('div', { className: 'h-full p-6' },
          h('div', { id: 'region', className: 'mx-auto w-full max-w-md h-full' }, h(PartyPaymentStep)))),
      split ? h('div', { className: 'w-1/2 h-full min-w-0' }) : null));
}

function tillScreen(): ReactNode {
  switch (screen) {
    case 'configure':
      return h(StepAddTicket, {
        tier: 'tourist', activeLine: configureLine(), hasLines: true, onSelectTicket: noop, onUpdateLine: noop,
        onAddDropOff: noop, onBackToGrid: noop, onDone: noop,
      });
    case 'tickets':
      return h(StepAddTicket, {
        tier: 'tourist', activeLine: null, hasLines: true, onSelectTicket: noop, onUpdateLine: noop,
        onAddDropOff: noop, onBackToGrid: noop, onDone: noop,
      });
    case 'tiers-walkin':
      return h(StepCustomerType, { member: null, selectedTier: 'tourist', onPickTier: noop, onRequestVerify: noop, onShowAllTiers: noop });
    case 'tiers-member':
      return h(StepCustomerType, { member: verifiedMember, selectedTier: 'expat', onPickTier: noop, onRequestVerify: noop, onShowAllTiers: noop });
    case 'tiers-member-all':
      return h(StepCustomerType, { member: verifiedMember, selectedTier: 'expat', onPickTier: noop, onRequestVerify: noop, onShowAllTiers: noop, showAllTiers: true });
    case 'tiers-unverified':
      return h(StepCustomerType, { member: unverifiedMember, selectedTier: 'tourist', onPickTier: noop, onRequestVerify: noop, onShowAllTiers: noop });
    case 'payment':
      return h(PaymentScreen);
    default:
      throw new Error(`no till screen "${screen}"`);
  }
}

/** The counter till's frame, as `pages/Till.tsx` draws it (classes pinned by the test). */
function TillFrame() {
  const staffTill = h('div', { className: 'flex h-full w-full bg-background text-foreground overflow-hidden' },
    h('div', { className: 'flex-1 flex flex-col border-r bg-card/30 min-w-0' },
      h('div', { id: 'region', className: 'flex-1 overflow-hidden relative p-6' }, tillScreen())),
    h('div', { className: 'w-[360px] min-w-0 bg-sidebar flex flex-col p-6 overflow-y-auto' }));
  return h('div', { className: 'h-[100dvh] w-full flex flex-col bg-background' },
    h('div', { className: 'shrink-0', style: { height: 206 }, 'data-chrome': 'staging' }),
    h('div', { className: 'flex-1 flex min-h-0' },
      h('div', { className: `${split ? 'w-1/2 border-r border-foreground/10' : 'w-full'} h-full min-w-0` }, staffTill),
      split ? h('div', { className: 'w-1/2 h-full min-w-0' }) : null));
}

// --- The board's family ----------------------------------------------------------

const familyBase = {
  registrationId: 'zz-test-496', parentName: 'ZZ TEST guardian 496', contactMethod: 'whatsapp' as const,
  phone: '+66898904960', mayOrderFood: false, confirmationsAccepted: true, serviceType: 'drop_off' as const,
  registeredAt: '2026-11-12T02:00:00.000Z',
  waConnection: { status: 'confirmed' as const },
};
const family496: CheckIn[] = [
  { ...familyBase, id: 'c-496', childName: 'ZZ TEST Child 496 C', childAge: 6, status: 'registered', paidAtTill: { saleId: 'sale-496', receiptNumber: 'R-496' } },
  { ...familyBase, id: 's-496-a', childName: 'ZZ TEST Sibling 496 age3', childAge: 3, status: 'registered' },
  { ...familyBase, id: 's-496-b', childName: 'ZZ TEST Sibling 496 age3', childAge: 3, status: 'registered' },
  { ...familyBase, id: 's-496-c', childName: 'ZZ TEST Sibling 496 age6 nanny', childAge: 6, status: 'registered', serviceType: 'nanny' },
] as CheckIn[];
// The phone names its Check In presses when a child was paid for online
// (`MobileChildDetail`'s split): the same family, the first child's booking online.
const family496Online: CheckIn[] = family496.map((c, i) => i === 0
  ? { ...c, paidAtTill: undefined, paidOnline: { bookingId: 'booking-496', reference: 'OTO-496', redeemed: false } }
  : c);
const familySingle: CheckIn[] = [
  { ...familyBase, id: 'one', registrationId: 'zz-test-one', childName: 'ZZ TEST Single', childAge: 5, status: 'registered' },
] as CheckIn[];

const cardHandlers = {
  onMessage: noop, onAssignNanny: noop, onCheckIn: noop, onCheckOut: noop, onCheckInBooked: noop,
  onRedeemBooking: noop, onEdit: noop, onResend: noop, onSimulateConfirm: noop, onMarkFailed: noop,
  onSaveAndResend: noop, onManagePickups: noop, onCancelBooking: noop,
};

function BoardCard() {
  const width = Number(params.get('w') ?? 560);
  const family = screen === 'card-single' ? familySingle : family496;
  return h('div', { className: 'p-4 bg-background min-h-[100dvh]' },
    h('div', { id: 'region', style: { width } }, h(FamilyCheckInCard, { family, ...cardHandlers })));
}

function PhoneCard() {
  return h('div', { id: 'region', className: 'min-h-[100dvh]' },
    h(MobileChildDetail, { family: family496Online, onBack: noop, onMarkArrived: noop, ...cardHandlers }));
}

// SCRUM-956 — a child whose name is long, in the park, as the proof's was.
const familyLong: CheckIn[] = [
  {
    ...familyBase, id: 'long-956', registrationId: 'zz-test-956', status: 'in_park', childAge: 7,
    childName: 'ZZ TEST Phongsakorn Wattanachaiyaphum Long Name 956',
    parentName: 'ZZ TEST guardian Chanthawongsakul Long Family 956',
    allergiesMedical: 'Peanuts and tree nuts, carries an EpiPen in the blue bag',
    foodRestrictions: 'No pork, no seafood',
    checkedInAt: '2026-11-12T03:00:00.000Z', bookedDurationMinutes: 60,
  },
] as CheckIn[];

function PhoneCardLong() {
  return h('div', { id: 'region', className: 'min-h-[100dvh]' },
    h(MobileChildDetail, { family: familyLong, onBack: noop, onMarkArrived: noop, ...cardHandlers }));
}

/** SCRUM-953 — the phone's refund, By item: each row a child's name and the ticket, as History builds them. */
function PhoneRefund() {
  return h('div', { id: 'region', className: 'h-[100dvh]' },
    h(MobileRefundFlow, {
      maxRefund: 1444.5, restorableCredit: 0, reasons: ['Service recovery'], operatorName: 'ZZ TEST manager',
      lines: [
        { id: 'r-1', label: 'ZZ TEST Phongsakorn Wattanachaiyaphum Long Name 956 · 2 Hours Play · 1 ppl', amount: 823.5 },
        { id: 'r-2', label: 'ZZ TEST Nok B 934 · 1 Hour Play · 1 ppl', amount: 621 },
      ],
      onConfirm: noop, onCancel: noop,
    }));
}

const gatePolicy: SupervisionPolicy = {
  bands: [
    { id: 'band-0-4', label: '0–4', minAge: 0, maxAge: 4, requirement: 'nanny' },
    { id: 'band-5-8', label: '5–8', minAge: 5, maxAge: 8, requirement: 'drop_off' },
    { id: 'band-9-up', label: '9+', minAge: 9, maxAge: null, requirement: 'none' },
  ],
  siblingWaiver: { enabled: true, guardianMinAge: 9, waivableRequirement: 'drop_off', staffOnly: true },
  confirmations: [{ id: 'confirm-15min', text: 'I will remain within 15 minutes of the venue', required: true, order: 0 }],
};
const gateSlot: SupervisedSlot = {
  id: 'zz-gate', sourceLineId: 'zz-line', ticketType: {} as SupervisedSlot['ticketType'],
  name: 'ZZ TEST PHONE', age: '6', waived: false, allergiesMedical: '', foodRestrictions: '', mayOrderFood: false, optIn: true,
};

/** SCRUM-954 — the phone till's gate, in its step's frame. */
function PhoneGate() {
  return h('div', { id: 'region', className: 'h-[100dvh] overflow-y-auto p-4' },
    h(SupervisionGate, {
      slots: [gateSlot], parentName: '', consentAck: false, policy: gatePolicy, acknowledgedConfirmationIds: [],
      onUpdateSlot: noop, onToggleWaiver: noop, onBack: noop, onContinue: noop, continueOpensForm: true,
      contactConfirmed: false, contactPhoneProblem: 'empty',
    }));
}

// --- The page ----------------------------------------------------------------------

function Page() {
  useEffect(() => {
    void loadSellableStock('harness-branch').then(() => {
      document.documentElement.dataset.ready = '1';
    });
  }, []);
  if (screen === 'card' || screen === 'card-single') return h(BoardCard);
  if (screen === 'phone-card') return h(PhoneCard);
  if (screen === 'phone-card-long') return h(PhoneCardLong);
  if (screen === 'phone-refund') return h(PhoneRefund);
  if (screen === 'phone-gate') return h(PhoneGate);
  if (screen === 'party-payment') return h(PartyFrame);
  return h(TillFrame);
}

window.__readSplitView = readSplitView;
document.documentElement.classList.add('light');
createRoot(document.getElementById('root')!).render(h(Page));
