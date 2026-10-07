import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EventView, PartyWriteAnswer } from '@oto/shared';
import { api, ApiError, NetworkError } from '@/api/client';
import { EVENTS_NOT_LINKED, toOtoEvent } from '@/api/events';
import {
  chargePartyOnPlatform,
  partyEditOf,
  partyWriteBlocker,
  payPartyOnPlatform,
  updatePartyOnPlatform,
} from '@/api/parties';
import type { PartyEditPatch } from '@/components/parties/PartyEditForm';
import {
  computePartyOutstanding,
  computePartyTotal,
  partyExtraChargeGroups,
  partyPaymentsTotal,
} from '@/lib/party';
import type { PartyBooking } from '@/types';

/**
 * S2-20 E4 — the till's side of the party tab (SCRUM-217; events-kiosk PLAN,
 * the E4 row of §9, check 3):
 *
 *  - the platform's tab reaches the prototype's PartyBooking whole: the base
 *    price and deposit, the walk-ups and the till's charges in one ledger in
 *    the order they were made, the payments, the edit stamp, and the bill
 *    `lib/party.ts` works out matches the platform's;
 *  - an edit sends only what changed, in the platform's words, and names what
 *    the OTO App keeps;
 *  - a charge and a payment go to the platform under the ids the form opened
 *    with, the payment with the balance the till showed;
 *  - the screens keep the prototype's words and are wired to the platform.
 */

const HKT_CENTRAL = '0190a0a0-0000-7000-8000-00000000b001';
const PARTY = '0190a0a0-0000-7000-8000-0000000e0e04';
const TILL = '0190a0a0-0000-7000-8000-00000000c001';

vi.mock('@/api/catalogBridge', () => ({
  apiBranchIdForSlug: (slug: string) => (slug === 'hkt-central' ? HKT_CENTRAL : null),
}));
vi.mock('@/api/client', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/api/client')>();
  return { ...original, api: { ...original.api, get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn() } };
});
const lane = vi.hoisted(() => ({ current: 'platform' as 'platform' | 'box' }));
vi.mock('@/lib/lane', () => ({ currentLane: () => lane.current }));

const postMock = vi.mocked(api.post);
const patchMock = vi.mocked(api.patch);

beforeEach(() => {
  postMock.mockReset();
  patchMock.mockReset();
  lane.current = 'platform';
});

const T = '2026-11-04';

/** The party as `GET /parties/:id` answers it: check 3's numbers. */
const partyView = (over: Partial<NonNullable<EventView['party']>> = {}): EventView => ({
  id: PARTY,
  branchId: HKT_CENTRAL,
  type: 'party',
  appEventType: 'birthday',
  status: 'upcoming',
  appStatus: 'upcoming',
  archived: false,
  title: "Mali's 6th",
  startDate: T,
  endDate: T,
  cancelledDays: [],
  startTime: '13:00',
  endTime: '16:00',
  location: 'Party room 1',
  expectedKids: 15,
  expectedAdults: 12,
  entryPrice: null,
  party: {
    childName: 'Mali',
    kidTurningAge: 6,
    bookingName: null,
    parentName: 'Nok',
    parentPhone: '+66812345678',
    activities: null,
    decoration: 'Ocean',
    totalValueSatang: 1_200_000,
    depositSatang: 300_000,
    depositDate: T,
    walkUpCharges: [
      { id: 'w1', name: 'Guest', amountSatang: 45_000, chargedBy: 'Som', chargedById: 'acc', chargedAt: `${T}T05:00:00.000Z` },
    ],
    charges: [
      {
        id: 'c2',
        kind: 'ticket',
        items: [{ name: '1 Hour Play · Kids', qty: 2, lineTotalSatang: 40_000 }],
        totalSatang: 40_000,
        chargedBy: 'Som',
        chargedById: 'acc',
        chargedAt: `${T}T06:00:00.000Z`,
      },
      {
        id: 'c1',
        kind: 'fnb',
        items: [
          { name: 'Pad Thai', qty: 2, lineTotalSatang: 30_000 },
          { name: 'Mango smoothie', qty: 2, lineTotalSatang: 24_000 },
        ],
        totalSatang: 52_000,
        chargedBy: 'Som',
        chargedById: 'acc',
        chargedAt: `${T}T04:00:00.000Z`,
      },
    ],
    payments: [
      {
        id: 'p1',
        amountSatang: 500_000,
        method: 'card',
        kind: 'card',
        takenBy: 'Som',
        takenById: 'acc',
        takenAt: `${T}T07:00:00.000Z`,
        businessDate: T,
        attemptId: 'att',
      },
    ],
    lastEdited: { by: 'Som', byId: 'acc', at: `${T}T03:00:00.000Z` },
    editSync: { editId: 'e1', state: 'pending', error: null, at: `${T}T03:00:00.000Z` },
    bill: {
      baseSatang: 1_200_000,
      chargesSatang: 137_000,
      totalSatang: 1_337_000,
      depositSatang: 300_000,
      paidSatang: 500_000,
      outstandingSatang: 537_000,
    },
    ...over,
  },
  attendeeCount: 0,
  attendees: [],
  roster: { arrived: 0, expected: 0, currentlyIn: 0, outstanding: 0, all: 0 },
});

const asParty = (v: EventView) => toOtoEvent(v, 'hkt-central') as unknown as PartyBooking;

const answer = (party: EventView, extra: Partial<PartyWriteAnswer> = {}): PartyWriteAnswer => ({
  replayed: false,
  party,
  ...extra,
});

describe('check 3 — the party tab on the prototype’s party bill', () => {
  it('shows the base price, the deposit, the POS charges and payments, and the platform’s balance', () => {
    const view = partyView();
    const party = asParty(view);
    expect(party).toMatchObject({ basePrice: 12_000, deposit: 3_000, lineItems: [], whatsapp: '+66812345678' });
    // One ledger, in the order things went on the tab: F&B, the walk-up, the tickets.
    expect(party.partyExtraCharges.map((c) => c.id)).toEqual(['c1', 'w1', 'c2']);
    expect(party.partyExtraCharges[0]).toMatchObject({
      kind: 'fnb',
      total: 520,
      items: [
        { name: 'Pad Thai', qty: 2, lineTotal: 300 },
        { name: 'Mango smoothie', qty: 2, lineTotal: 240 },
      ],
      chargedBy: 'Som',
    });
    expect(party.partyPayments).toEqual([
      { id: 'p1', amount: 5_000, method: 'card', takenBy: 'Som', takenById: 'acc', takenAt: `${T}T07:00:00.000Z` },
    ]);
    // lib/party.ts works out what the platform did.
    expect(computePartyTotal(party) * 100).toBe(view.party!.bill!.totalSatang);
    expect(computePartyOutstanding(party) * 100).toBe(view.party!.bill!.outstandingSatang);
    expect(partyPaymentsTotal(party)).toBe(5_000);
    expect(partyExtraChargeGroups(party).map((g) => [g.label, g.total])).toEqual([
      ['Extra tickets', 850],
      ['Extra F&B', 520],
    ]);
    // The updateParty stamp, and the edit the OTO App has not confirmed.
    expect(party).toMatchObject({
      lastEditedBy: 'Som',
      lastEditedAt: `${T}T03:00:00.000Z`,
      editSync: { state: 'pending', error: null },
    });
  });

  it('a party answered before the tab was on the platform still reads, with nothing on it', () => {
    const view = partyView({ charges: undefined, payments: undefined, lastEdited: undefined, editSync: undefined, walkUpCharges: [] });
    const party = asParty(view);
    expect(party.partyExtraCharges).toEqual([]);
    expect(party.partyPayments).toEqual([]);
    expect(party.lastEditedBy).toBeUndefined();
    expect(party.editSync).toBeUndefined();
    expect(computePartyOutstanding(party)).toBe(9_000);
  });
});

describe('what stops a party write before its form opens', () => {
  it('a till with no platform branch, no connection, or on the box opens nothing', () => {
    expect(partyWriteBlocker({ branchSlug: 'nowhere' })).toEqual({ title: 'Not linked to the platform', description: EVENTS_NOT_LINKED });
    expect(partyWriteBlocker({ branchSlug: 'hkt-central', online: false })!.title).toBe('No connection');
    lane.current = 'box';
    expect(partyWriteBlocker({ branchSlug: 'hkt-central', online: true })!.title).toBe('No connection');
  });

  it('a payment needs a platform till; a charge and an edit do not', () => {
    expect(partyWriteBlocker({ branchSlug: 'hkt-central', online: true })).toBeNull();
    expect(partyWriteBlocker({ branchSlug: 'hkt-central', online: true, needsStation: true })!.title).toBe('Not a till');
    expect(partyWriteBlocker({ branchSlug: 'hkt-central', online: true, needsStation: true, stationId: 'st-local-1' })!.title).toBe('Not a till');
    expect(partyWriteBlocker({ branchSlug: 'hkt-central', online: true, needsStation: true, stationId: TILL })).toBeNull();
  });
});

describe('the party tab, on the platform', () => {
  const ids = { id: '0190a0a0-0000-7000-8000-0000000a0001', actionId: '0190a0a0-0000-7000-8000-0000000a0002' };

  it('a charge goes to /charges with the till’s items and total in satang, under the ids its form opened with', async () => {
    postMock.mockResolvedValueOnce(answer(partyView()));
    const out = await chargePartyOnPlatform({
      party: asParty(partyView()),
      kind: 'fnb',
      items: [{ name: 'Pad Thai', qty: 2, lineTotal: 300 }],
      total: 285.5,
      stationId: TILL,
      ids,
    });
    expect(out.ok).toBe(true);
    expect(postMock).toHaveBeenCalledWith(
      `/parties/${PARTY}/charges`,
      {
        branchId: HKT_CENTRAL,
        chargeId: ids.id,
        actionId: ids.actionId,
        kind: 'fnb',
        items: [{ name: 'Pad Thai', qty: 2, lineTotalSatang: 30_000 }],
        totalSatang: 28_550,
        stationId: TILL,
      },
      { idempotencyKey: `party-charge:${ids.id}`, headers: { 'x-oto-action-id': ids.actionId } },
    );
  });

  it('a payment goes to /payments with its tender and the balance the till showed', async () => {
    postMock.mockResolvedValueOnce(answer(partyView()));
    const out = await payPartyOnPlatform({
      party: asParty(partyView()),
      amount: 2_000,
      method: 'card',
      outstanding: 5_370,
      stationId: TILL,
      ids,
    });
    expect(out.ok && out.party.id).toBe(PARTY);
    expect(postMock).toHaveBeenCalledWith(
      `/parties/${PARTY}/payments`,
      {
        branchId: HKT_CENTRAL,
        stationId: TILL,
        paymentId: ids.id,
        actionId: ids.actionId,
        amountSatang: 200_000,
        tender: { method: 'card', kind: 'card' },
        expectedOutstandingSatang: 537_000,
      },
      { idempotencyKey: `party-payment:${ids.id}`, headers: { 'x-oto-action-id': ids.actionId } },
    );
  });

  it('a refusal is final for these ids; no answer at all may be sent again under them', async () => {
    postMock.mockRejectedValueOnce(new ApiError(409, 'PARTY_BALANCE_CHANGED', 'The balance changed'));
    const refused = await payPartyOnPlatform({ party: asParty(partyView()), amount: 100, method: 'cash', outstanding: 5_370, stationId: TILL, ids });
    expect(refused).toEqual({ ok: false, message: 'The balance changed', retryable: false });
    postMock.mockRejectedValueOnce(new NetworkError('offline'));
    const lost = await payPartyOnPlatform({ party: asParty(partyView()), amount: 100, method: 'cash', outstanding: 5_370, stationId: TILL, ids });
    expect(lost).toMatchObject({ ok: false, retryable: true });
  });

  it('an edit sends only what changed, in the platform’s words, and names what the OTO App keeps', async () => {
    const party = asParty(partyView());
    const patch: PartyEditPatch = {
      ...party,
      title: "Mali's 6th birthday",
      decoration: '',
      basePrice: 11_500,
      whatsapp: '081 234 5679',
      kitchen: { ...party.kitchen, needed: true },
      packageName: 'Gold',
    };
    const { fields, keptInOtoApp } = partyEditOf(party, patch);
    expect(fields).toEqual({
      title: "Mali's 6th birthday",
      decoration: null,
      basePriceSatang: 1_150_000,
      whatsapp: '081 234 5679',
    });
    expect(keptInOtoApp).toEqual(['package name', 'kitchen plan']);
    expect(partyEditOf(party, { ...party })).toEqual({ fields: {}, keptInOtoApp: [] });

    patchMock.mockResolvedValueOnce(answer(partyView(), { edit: { id: ids.id, syncState: 'synced', syncError: null, ignored: [] } }));
    const out = await updatePartyOnPlatform({ party, fields, stationId: TILL, ids });
    expect(out.ok).toBe(true);
    expect(patchMock).toHaveBeenCalledWith(
      `/parties/${PARTY}`,
      { branchId: HKT_CENTRAL, editId: ids.id, actionId: ids.actionId, stationId: TILL, ...fields },
      { idempotencyKey: `party-edit:${ids.id}` },
    );
  });
});

const source = (rel: string) => readFileSync(fileURLToPath(new URL(`../src/${rel}`, import.meta.url)), 'utf8');

describe("the party screens keep the prototype's words and write to the platform", () => {
  it('PartyDetail charges, takes the balance and edits on the platform — no in-memory mutator, no pending refusal', () => {
    const detail = source('components/parties/PartyDetail.tsx');
    expect(detail).not.toMatch(/addPartyPayment|addPartyExtraCharge|updateParty\(|getEventById|EVENT_WRITE_PENDING/);
    expect(detail).toMatch(/payPartyOnPlatform/);
    expect(detail).toMatch(/chargePartyOnPlatform/);
    expect(detail).toMatch(/updatePartyOnPlatform/);
    for (const words of ['Edit party', 'Add tickets', 'Add F&amp;B to party', 'Take balance ฿', 'Fully paid', 'Party bill', 'Deposit paid', 'Payments taken', 'Outstanding', 'POS activity', 'Extra tickets', 'Extra F&B', 'Last edited by']) {
      expect(detail).toContain(words);
    }
  });

  it('the balance and the settlement customer screen keep their stages and words', () => {
    const balance = source('components/parties/PartyBalanceModal.tsx');
    for (const words of ['Take balance payment', 'How much to collect?', 'Partial amount', 'Payment method', 'Amount to collect', 'Payment received', 'Payment recorded', 'Collected now', 'This party is fully paid.']) {
      expect(balance).toContain(words);
    }
    // The thank-you follows a payment the platform recorded, never a refused one,
    // and thanks the guest for what it recorded; a definite no is back on the bill.
    expect(balance).toMatch(
      /await onConfirm\(collectAmount, collectMethod, collectOutstanding\);\s*if \(result && !result\.recorded\) \{\s*if \(!result\.retry\) setStage\('review'\);\s*return;\s*\}\s*if \(result\) setCollectAmount\(result\.amount\);\s*setStage\('done'\)/,
    );
    const settlement = source('components/parties/PartySettlementCustomerScreen.tsx');
    for (const key of ['party.review.yourBill', 'party.review.lessDeposit', 'party.review.outstandingDue', 'party.payment.pleasePay', 'party.thankyou.allSettled', 'party.thankyou.paymentReceived']) {
      expect(settlement).toContain(key);
    }
  });

  it('the mobile party screens take the payment and the F&B on the platform, and keep their words', () => {
    const mobile = source('components/mobile/parties/MobileParties.tsx');
    expect(mobile).not.toMatch(/addPartyPayment|addPartyExtraCharge/);
    expect(mobile).toMatch(/payPartyOnPlatform/);
    expect(mobile).toMatch(/chargePartyOnPlatform/);
    const payment = source('components/mobile/parties/MobilePartyPayment.tsx');
    for (const words of ['Take payment', 'Collect payment', 'Payment received', 'Payment recorded', 'Back to party', 'Show bill · ฿']) {
      expect(payment).toContain(words);
    }
    expect(payment).toMatch(
      /await onConfirm\(collectAmount, collectMethod, collectOutstanding\);\s*if \(result && !result\.recorded\) \{\s*if \(!result\.retry\) setStep\('pick'\);\s*return;\s*\}\s*if \(result\) setCollectAmount\(result\.amount\);\s*setStep\('done'\)/,
    );
    const detail = source('components/mobile/parties/MobilePartyDetail.tsx');
    for (const words of ['All parties', 'Party bill', 'Deposit paid', 'Outstanding', 'Fully paid']) {
      expect(detail).toContain(words);
    }
  });
});
