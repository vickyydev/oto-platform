import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EventAttendeeView, EventAttendeeWriteAnswer, EventView } from '@oto/shared';
import { api, ApiError, NetworkError } from '@/api/client';
import {
  EVENTS_NOT_LINKED,
  eventWriteBlocker,
  sellOnPlatform,
  toAttendeeInput,
  toEventAttendee,
  toOtoEvent,
  walkUpChargeToExtra,
} from '@/api/events';
import { adminNav } from '@/components/admin/adminSections';
import { computePartyOutstanding, computePartyTotal, partyExtraChargeGroups } from '@/lib/party';
import type { OtoEvent, PartyBooking } from '@/types';

/**
 * S2-20 E2 — the till's side of the attendee create and the pass sale
 * (SCRUM-217; events-kiosk PLAN, the E2 row of §9):
 *
 *  - a party walk-up's charge reaches the prototype's party bill as the
 *    "Walk-up guest — name" ticket charge, and the balance counts it;
 *  - a child the OTO App has not confirmed yet carries its sync state;
 *  - what the till can know before the form opens refuses there (E1 review,
 *    finding 2) — the pass card and the board's Add attendee alike;
 *  - the sell goes to /passes with its tender, or /attendees with none, under
 *    the ids the form was opened with;
 *  - the approved words of the pass flow, the name capture and the member
 *    pre-fill are the prototype's.
 */

const HKT_CENTRAL = '0190a0a0-0000-7000-8000-00000000b001';

vi.mock('@/api/catalogBridge', () => ({
  apiBranchIdForSlug: (slug: string) => (slug === 'hkt-central' ? HKT_CENTRAL : null),
}));
vi.mock('@/api/client', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/api/client')>();
  return { ...original, api: { ...original.api, get: vi.fn(), post: vi.fn(), put: vi.fn() } };
});
vi.mock('@/lib/lane', () => ({ currentLane: () => 'platform' }));

const postMock = vi.mocked(api.post);

beforeEach(() => {
  postMock.mockReset();
});

const T = '2026-11-04';

const baseEvent = (over: Partial<OtoEvent>): OtoEvent => ({
  id: '0190a0a0-0000-7000-8000-0000000e0001',
  branchId: 'hkt-central',
  type: 'event',
  status: 'upcoming',
  title: 'Slime workshop',
  date: T,
  startTime: '14:00',
  endTime: '16:00',
  location: 'Studio',
  expectedKids: 10,
  expectedAdults: 2,
  entryPriceTHB: { weekday: 350, weekend: 400 },
  ...over,
});

const attendeeView = (over: Partial<EventAttendeeView>): EventAttendeeView => ({
  id: 'a1',
  childId: 'a1',
  recordKind: 'event_attendee',
  name: 'Ton',
  age: 6,
  dateOfBirth: null,
  language: null,
  allergy: null,
  dietary: null,
  parentName: 'May',
  parentPhone: null,
  parentAttending: false,
  attendanceDays: [],
  attendsAllDays: false,
  attendsOnDate: true,
  notes: 'Walk-up added by Som (today only)',
  isOneTime: true,
  source: 'pos',
  checkins: [],
  bucket: 'outstanding',
  syncState: null,
  ...over,
});

describe("a party walk-up on the prototype's party bill", () => {
  it('is the "Walk-up guest — name" ticket charge, grouped as extra tickets, and the balance counts it', () => {
    const party: EventView = {
      id: 'party',
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
      startTime: '11:00',
      endTime: '13:00',
      location: 'Party room',
      expectedKids: 12,
      expectedAdults: 10,
      entryPrice: null,
      party: {
        childName: 'Mali',
        kidTurningAge: 6,
        bookingName: null,
        parentName: 'Nok',
        parentPhone: null,
        activities: null,
        decoration: null,
        totalValueSatang: 1_200_000,
        depositSatang: 300_000,
        depositDate: null,
        walkUpCharges: [
          { id: 'w1', name: 'Ton', amountSatang: 45_000, chargedBy: 'Som', chargedById: 'acc', chargedAt: `${T}T04:00:00.000Z` },
        ],
      },
      attendeeCount: 1,
      attendees: [attendeeView({})],
      roster: { arrived: 0, expected: 1, currentlyIn: 0, outstanding: 1, all: 1 },
    };
    const mapped = toOtoEvent(party, 'hkt-central') as OtoEvent & PartyBooking;
    expect(mapped.partyExtraCharges).toEqual([
      {
        id: 'w1',
        kind: 'ticket',
        items: [{ name: 'Walk-up guest — Ton', qty: 1, lineTotal: 450 }],
        total: 450,
        chargedBy: 'Som',
        chargedById: 'acc',
        chargedAt: `${T}T04:00:00.000Z`,
      },
    ]);
    expect(computePartyTotal(mapped)).toBe(12_000 + 450);
    expect(computePartyOutstanding(mapped)).toBe(12_000 + 450 - 3_000);
    expect(partyExtraChargeGroups(mapped).map((g) => g.kind)).toEqual(['ticket']);
  });

  it('a charge with nobody named still reads, and a child added at the till carries its sync state', () => {
    expect(walkUpChargeToExtra({ id: 'w', name: 'X', amountSatang: 0, chargedBy: null, chargedById: null, chargedAt: T }).chargedBy).toBe('—');
    expect(toEventAttendee(attendeeView({ syncState: 'pending' }), 'event').syncState).toBe('pending');
    expect(toEventAttendee(attendeeView({ syncState: null }), 'event')).not.toHaveProperty('syncState');
  });
});

describe('what stops a walk-up or a pass before its form opens (E1 review, finding 2)', () => {
  const ctx = { branchSlug: 'hkt-central', stationId: 'st-1', capabilities: [], today: T, online: true };

  it('a till with no platform branch, or no connection, opens nothing', () => {
    expect(eventWriteBlocker(baseEvent({}), { ...ctx, branchSlug: 'nowhere' })).toEqual({
      title: 'Not linked to the platform',
      description: EVENTS_NOT_LINKED,
    });
    expect(eventWriteBlocker(baseEvent({}), { ...ctx, online: false })?.title).toBe('No connection');
  });

  it('a camp not running today, and an event with no entry price, open nothing', () => {
    const camp = baseEvent({ type: 'camp', date: '2026-11-06', dateRange: { start: '2026-11-06', end: '2026-11-09' } });
    expect(eventWriteBlocker(camp, ctx)?.title).toBe('Camp not running today');
    expect(eventWriteBlocker({ ...camp, dateRange: { start: '2026-11-01', end: '2026-11-09' } }, ctx)).toBeNull();
    expect(eventWriteBlocker(baseEvent({ entryPriceTHB: undefined }), ctx)?.title).toBe('No entry price');
  });

  it('a paid pass needs a ticket till; a party walk-up and a free event take no payment and do not', () => {
    expect(eventWriteBlocker(baseEvent({}), { ...ctx, stationId: null })?.title).toBe('Not a ticket till');
    expect(eventWriteBlocker(baseEvent({}), { ...ctx, capabilities: ['fnb'] })?.title).toBe('Not a ticket till');
    expect(eventWriteBlocker(baseEvent({}), { ...ctx, capabilities: ['tickets'] })).toBeNull();
    expect(eventWriteBlocker(baseEvent({ type: 'party', entryPriceTHB: undefined }), { ...ctx, stationId: null })).toBeNull();
    expect(eventWriteBlocker(baseEvent({ entryPriceTHB: { weekday: 0, weekend: 0 } }), { ...ctx, stationId: null })).toBeNull();
  });
});

describe('the sell, on the platform', () => {
  const ids = {
    attendeeId: '0190a0a0-0000-7000-8000-0000000a0001',
    saleId: '0190a0a0-0000-7000-8000-0000000a0002',
    actionId: '0190a0a0-0000-7000-8000-0000000a0003',
  };
  const input = {
    name: ' Lin ',
    parentName: 'May',
    parentPhone: '',
    allergyFlag: true,
    allergyDetail: 'Peanuts',
    emergencyContact: 'Joe — 081',
    parentAttending: false,
  };
  const answer = (over: Partial<EventAttendeeWriteAnswer['attendee']> = {}): EventAttendeeWriteAnswer => ({
    attendee: {
      id: ids.attendeeId,
      eventId: 'e',
      eventType: 'event',
      otoappAttendeeId: ids.attendeeId,
      merged: false,
      billing: 'sale',
      priceSatang: 35_000,
      attendanceDays: [],
      parentAttending: false,
      syncState: 'synced',
      syncError: null,
      createdAt: `${T}T04:00:00.000Z`,
      ...over,
    },
    replayed: false,
    sale: { id: ids.saleId, receiptNumber: 'T1-000001', grossSatang: 35_000, status: 'finalised' },
    printingNotes: [],
  });

  it('the captured child goes as it was typed, with nothing empty sent', () => {
    expect(toAttendeeInput(input)).toEqual({
      name: 'Lin',
      parentName: 'May',
      allergyFlag: true,
      allergyDetail: 'Peanuts',
      emergencyContact: 'Joe — 081',
    });
  });

  it('a paid pass goes to /passes with its tender, the fee shown and the ids the form opened with', async () => {
    postMock.mockResolvedValueOnce(answer());
    const event = baseEvent({});
    const out = await sellOnPlatform({
      event,
      branchSlug: 'hkt-central',
      stationId: 'station-1',
      input,
      registerProperly: true,
      paymentMethod: 'cash',
      doorFeeTHB: 350,
      ids,
      memberId: 'not-a-platform-id',
      childId: 'c1',
    });
    expect(out.ok).toBe(true);
    const [path, body, opts] = postMock.mock.calls[0]!;
    expect(path).toBe(`/events/${event.id}/passes`);
    expect(body).toMatchObject({
      branchId: HKT_CENTRAL,
      stationId: 'station-1',
      attendeeId: ids.attendeeId,
      saleId: ids.saleId,
      actionId: ids.actionId,
      // Only a camp registers for days.
      registerProperly: false,
      tender: { method: 'cash', kind: 'cash' },
      expectedTotalSatang: 35_000,
    });
    // A member from the prototype's own store is not named to the platform.
    expect(body).not.toHaveProperty('memberId');
    expect(body).not.toHaveProperty('childId');
    expect(opts).toMatchObject({ idempotencyKey: `event-pass:${ids.attendeeId}:cash:`, headers: { 'x-oto-action-id': ids.actionId } });
    if (out.ok) expect(out.attendee).toMatchObject({ id: ids.attendeeId, name: ' Lin ', syncState: 'synced' });
  });

  it('a party walk-up goes to /attendees with no tender, a platform member named', async () => {
    postMock.mockResolvedValueOnce(answer({ billing: 'party_tab', syncState: 'pending' }));
    const memberId = '0190a0a0-0000-7000-8000-0000000c0001';
    const childId = '0190a0a0-0000-7000-8000-0000000c0002';
    const out = await sellOnPlatform({
      event: baseEvent({ type: 'party', entryPriceTHB: undefined }),
      branchSlug: 'hkt-central',
      stationId: null,
      input,
      registerProperly: false,
      doorFeeTHB: 0,
      ids,
      memberId,
      childId,
    });
    const [path, body] = postMock.mock.calls[0]!;
    expect(path).toMatch(/\/attendees$/);
    expect(body).not.toHaveProperty('tender');
    expect(body).toMatchObject({ memberId, childId });
    expect(out.ok && out.attendee.syncState).toBe('pending');
  });

  it('a refusal is final for these ids; no answer at all may be sent again under them', async () => {
    postMock.mockRejectedValueOnce(new ApiError(409, 'SALE_TOTAL_MISMATCH', 'The till and the platform priced this cart differently — nothing was saved'));
    const refused = await sellOnPlatform({ event: baseEvent({}), branchSlug: 'hkt-central', stationId: 's', input, registerProperly: false, paymentMethod: 'cash', doorFeeTHB: 350, ids });
    expect(refused).toEqual({ ok: false, retryable: false, message: expect.stringMatching(/priced this cart differently/) });
    postMock.mockRejectedValueOnce(new NetworkError());
    const lost = await sellOnPlatform({ event: baseEvent({}), branchSlug: 'hkt-central', stationId: 's', input, registerProperly: false, paymentMethod: 'cash', doorFeeTHB: 350, ids });
    expect(lost).toMatchObject({ ok: false, retryable: true });
    const unlinked = await sellOnPlatform({ event: baseEvent({}), branchSlug: 'nowhere', stationId: 's', input, registerProperly: false, paymentMethod: 'cash', doorFeeTHB: 350, ids });
    expect(unlinked).toEqual({ ok: false, retryable: false, message: EVENTS_NOT_LINKED });
  });
});

// --- The approved words, and where the refusal now sits ------------------------------

const source = (rel: string) => readFileSync(fileURLToPath(new URL(`../src/${rel}`, import.meta.url)), 'utf8');

describe("the pass flow keeps the prototype's words and sells on the platform", () => {
  it('the attendee modal keeps its steps and labels', () => {
    const src = source('components/parties/AddAttendeeModal.tsx');
    for (const words of [
      "'Add party guest'",
      "'Sell event pass'",
      "'Take entry payment'",
      '`Continue to payment · ฿${doorFeeTHB}`',
      "'Continue to check-in'",
      "'Pass paid — check in now?'",
      'Check in now',
      'Leave as booked',
      'Who is attending?',
      'Pre-fill from a saved child or start fresh.',
      "'s profile — confirm or edit below.",
      'Tell us about your child',
    ]) {
      expect(src, words).toContain(words);
    }
  });

  it("the till's name capture and member pre-fill are the prototype's, and the pass card is no longer refused as pending", () => {
    const till = source('pages/Till.tsx');
    for (const words of [
      'New guest — enter name',
      'recognised. Enter the guest\'s name to register them so they\'re remembered next time.',
      'Name / nickname',
      'placeholder="e.g. Mama, John"',
      'Register &amp; continue',
      'prefillMember={eventPassPrefilledMember}',
      "'Could not sell pass'",
      "'Pass sold — left as booked'",
    ]) {
      expect(till, words).toContain(words);
    }
    expect(till).toContain('sellOnPlatform(');
    expect(till).not.toMatch(/sellEventPass\(/);
    expect(till).not.toContain('EVENT_WRITE_PENDING');
  });

  it("the board's Add attendee is refused before its form, never after the money (finding 2)", () => {
    const board = source('pages/DropOff.tsx');
    expect(board).toContain('onAddAttendee={openAddAttendee}');
    const opener = board.slice(board.indexOf('const openAddAttendee'), board.indexOf('setShowAddAttendee(true);', board.indexOf('const openAddAttendee')));
    expect(opener).toContain('eventWriteBlocker(');
    expect(opener).toContain('return;');
    // The sell itself no longer refuses as "not on the platform yet".
    const sell = board.slice(board.indexOf('const handleAddAttendeeSell'), board.indexOf('const handleAddAttendeeCheckIn'));
    expect(sell).not.toContain('writePending');
    expect(sell).toContain('sellOnPlatform(');
    // The party-guest price is the platform's now, never the in-memory store's.
    expect(board).not.toMatch(/import [^;]*getEventDropInPricing/);
    expect(board).toContain('useEventDropInPricing(branchId)');
    expect(board).toContain("'Could not add attendee'");
  });

  it('the Admin Events panel sits under Operations, for whoever may set the walk-up prices', () => {
    const operations = adminNav.find((e) => e.kind === 'group' && e.id === 'operations');
    const panel = operations?.kind === 'group' ? operations.panels.find((p) => p.id === 'events') : undefined;
    expect(panel).toMatchObject({ label: 'Events', permission: 'admin:event_pricing:manage' });
    const src = source('components/admin/events/EventsPanel.tsx');
    for (const words of ['Camp day', 'Event day', 'Party guest', 'Walk-up / drop-in day pricing for camps, one-off events and party additions.']) {
      expect(src, words).toContain(words);
    }
  });
});
