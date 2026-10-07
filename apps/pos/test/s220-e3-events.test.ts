import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EventCheckinAnswer, EventCheckinView, EventsCacheItem } from '@oto/shared';
import { api, ApiError, NetworkError } from '@/api/client';
import { bridgeApi } from '@/api/bridge';
import {
  bandLineOf,
  checkInOnPlatform,
  checkOutOnPlatform,
  dayAnswerOfCacheItem,
  reprintOnPlatform,
  toEventCheckin,
  toOtoEvent,
} from '@/api/events';
import { bucketAttendee } from '@/lib/eventRoster';

/**
 * S2-20 E3 — the till's side of check-in, check-out and reprint (SCRUM-217;
 * events-kiosk PLAN, the E3 row of §9):
 *
 *  - the roster's badge reads the short codes of the bands the platform
 *    printed ("Band T1-7KMQ4X · Parent T1-…"), never the signed code;
 *  - a check-in goes to the platform under the till's check-in id — the same
 *    id again on a retry — and to the counter's BOX with the link down, where
 *    today's events are read from the box's copy too;
 *  - a refusal arrives in the prototype's words ("Already checked in");
 *  - the board, the mobile board and the till's "Check in now" call the
 *    platform and keep the prototype's toasts.
 */

const HKT_CENTRAL = '0190a0a0-0000-7000-8000-00000000b001';
const lane = vi.hoisted(() => ({ current: 'platform' as 'platform' | 'box' }));

vi.mock('@/api/catalogBridge', () => ({
  apiBranchIdForSlug: (slug: string) => (slug === 'hkt-central' ? HKT_CENTRAL : null),
}));
vi.mock('@/api/client', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/api/client')>();
  return { ...original, api: { ...original.api, get: vi.fn(), post: vi.fn(), put: vi.fn() } };
});
vi.mock('@/api/bridge', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/api/bridge')>();
  return { ...original, bridgeApi: { ...original.bridgeApi, intent: vi.fn() }, bridgeStaffName: () => 'Nok' };
});
vi.mock('@/lib/lane', () => ({
  currentLane: () => lane.current,
  viaLane: <T,>(onPlatform: () => Promise<T>, onBox: (stationId: string) => Promise<T>) =>
    lane.current === 'box' ? onBox('st-till-1') : onPlatform(),
}));

const postMock = vi.mocked(api.post);
const intentMock = vi.mocked(bridgeApi.intent);

beforeEach(() => {
  postMock.mockReset();
  intentMock.mockReset();
  lane.current = 'platform';
});

const T = '2026-11-04';
const EVENT = '0190a0a0-0000-7000-8000-0000000e0001';
const KID = '0190a0a0-0000-7000-8000-0000000e0002';

const answer = (over: Partial<EventCheckinAnswer['checkin']> = {}): EventCheckinAnswer => ({
  checkin: {
    id: 'c1',
    eventId: EVENT,
    attendeeId: KID,
    date: T,
    status: 'checked_in',
    checkedInAt: `${T}T03:00:00.000Z`,
    checkedInBy: 'Nok',
    checkedOutAt: null,
    checkedOutBy: null,
    kidBand: { id: 'b1', kind: 'kid', shortCode: 'T1-7KMQ4X' },
    parentBand: { id: 'b2', kind: 'adult', shortCode: 'T1-9QW2ZD' },
    origin: 'till',
    syncState: 'synced',
    syncError: null,
    ...over,
  },
  replayed: false,
  printJobs: [],
  notes: [],
});

describe("the roster's badge", () => {
  it('reads the short codes of the bands the platform printed', () => {
    const view: EventCheckinView = {
      date: T,
      status: 'checked_in',
      checkedInAt: `${T}T03:00:00.000Z`,
      checkedInBy: 'Nok',
      checkedOutAt: null,
      checkedOutBy: null,
      checkinRef: 'c1',
      posCheckinId: 'c1',
      kidBandShortCode: 'T1-7KMQ4X',
      parentBandShortCode: 'T1-9QW2ZD',
      syncState: 'synced',
    };
    expect(toEventCheckin(view)).toMatchObject({
      wristbandCode: 'T1-7KMQ4X',
      parentWristbandCode: 'T1-9QW2ZD',
      operatorName: 'Nok',
    });
    // A check-in made in the OTO App alone has no band the POS printed.
    expect(toEventCheckin({ ...view, kidBandShortCode: null, parentBandShortCode: null })).toMatchObject({ wristbandCode: '—' });
    expect(toEventCheckin({ ...view, kidBandShortCode: null, parentBandShortCode: null }).parentWristbandCode).toBeUndefined();
  });

  it("says the bands the prototype's toast names", () => {
    expect(bandLineOf(answer())).toBe('band T1-7KMQ4X · parent T1-9QW2ZD');
    expect(bandLineOf(answer({ parentBand: null }))).toBe('band T1-7KMQ4X');
  });
});

describe('the calls', () => {
  it('a check-in goes to the platform under the till’s check-in id, as the idempotency key too', async () => {
    postMock.mockResolvedValueOnce(answer());
    const out = await checkInOnPlatform({
      event: { id: EVENT },
      attendeeId: KID,
      branchSlug: 'hkt-central',
      stationId: 'st-1',
      ids: { checkinId: 'ck-1', actionId: 'act-1' },
    });
    expect(out.ok).toBe(true);
    const [url, body, opts] = postMock.mock.calls[0]!;
    expect(url).toBe(`/events/${EVENT}/attendees/${KID}/checkin`);
    expect(body).toEqual({ branchId: HKT_CENTRAL, checkinId: 'ck-1', actionId: 'act-1', stationId: 'st-1' });
    expect(opts).toMatchObject({ idempotencyKey: 'event-checkin:ck-1', headers: { 'x-oto-action-id': 'act-1' } });
  });

  it('"Already checked in" comes back in the prototype’s words, and is not retried', async () => {
    postMock.mockRejectedValueOnce(new ApiError(409, 'EVENT_ALREADY_CHECKED_IN', 'This child is already checked in for today.'));
    const out = await checkInOnPlatform({
      event: { id: EVENT },
      attendeeId: KID,
      branchSlug: 'hkt-central',
      stationId: null,
      ids: { checkinId: 'ck-2', actionId: 'act-2' },
    });
    expect(out).toMatchObject({
      ok: false,
      code: 'EVENT_ALREADY_CHECKED_IN',
      retryable: false,
      toast: { title: 'Already checked in', description: 'This child is already checked in for today.' },
    });
  });

  it('"Not registered for today" is the platform’s refusal, said as the row says it', async () => {
    postMock.mockRejectedValueOnce(new ApiError(409, 'EVENT_NOT_REGISTERED_TODAY', 'Not registered for today'));
    const out = await checkInOnPlatform({
      event: { id: EVENT },
      attendeeId: KID,
      branchSlug: 'hkt-central',
      stationId: null,
      ids: { checkinId: 'ck-3', actionId: 'act-3' },
    });
    expect(out).toMatchObject({ ok: false, toast: { title: 'Not registered for today', description: 'Not registered for today' } });
  });

  it('a dropped connection may be sent again under the same ids', async () => {
    postMock.mockRejectedValueOnce(new NetworkError(new Error('offline')));
    const out = await checkInOnPlatform({
      event: { id: EVENT },
      attendeeId: KID,
      branchSlug: 'hkt-central',
      stationId: null,
      ids: { checkinId: 'ck-4', actionId: 'act-4' },
    });
    expect(out).toMatchObject({ ok: false, retryable: true });
  });

  it('with the link down the check-in, the check-out and the reprint go to the counter’s box', async () => {
    lane.current = 'box';
    intentMock.mockResolvedValue({ document: {} as never, result: answer({ origin: 'box' }) });
    const ids = { checkinId: 'ck-5', actionId: 'act-5' };
    expect((await checkInOnPlatform({ event: { id: EVENT }, attendeeId: KID, branchSlug: 'hkt-central', stationId: 'st-1', ids })).ok).toBe(true);
    expect(intentMock).toHaveBeenLastCalledWith(
      'st-till-1',
      'event.checkin',
      { eventId: EVENT, attendeeId: KID, checkinId: 'ck-5', staffName: 'Nok' },
      { actionId: 'act-5' },
    );
    await checkOutOnPlatform({ event: { id: EVENT }, attendeeId: KID, branchSlug: 'hkt-central', stationId: 'st-1' });
    expect(intentMock.mock.lastCall![1]).toBe('event.checkout');
    await reprintOnPlatform({ event: { id: EVENT }, attendeeId: KID, branchSlug: 'hkt-central', stationId: 'st-1' });
    expect(intentMock.mock.lastCall![1]).toBe('event.reprint');
    expect(postMock).not.toHaveBeenCalled();
  });
});

describe("today's events from the box's copy", () => {
  const item: EventsCacheItem = {
    branchId: HKT_CENTRAL,
    date: T,
    version: 'v1',
    generatedAt: `${T}T01:00:00.000Z`,
    events: [
      {
        id: EVENT,
        type: 'camp',
        status: 'upcoming',
        title: 'Ocean camp',
        startDate: '2026-11-03',
        endDate: '2026-11-06',
        startTime: '09:00',
        endTime: '15:00',
        location: 'Studio',
        entryPrice: { weekdaySatang: 60_000, weekendSatang: 70_000 },
        attendees: [
          {
            id: KID,
            name: 'Lin',
            age: 7,
            allergy: 'Peanuts',
            dietary: 'Vegetarian',
            parentName: 'May',
            parentAttending: true,
            attendsOnDate: true,
            bucket: 'in',
            checkin: { status: 'checked_in', checkedInAt: `${T}T03:00:00.000Z`, checkedOutAt: null, posCheckinId: 'c1', kidBandId: 'b1', parentBandId: 'b2' },
          },
          {
            id: 'edge',
            name: 'Edge',
            age: 6,
            allergy: null,
            dietary: null,
            parentName: 'Ploy',
            parentAttending: false,
            attendsOnDate: false,
            attendanceDays: ['2026-11-03'],
            bucket: 'notToday',
            checkin: null,
          },
        ],
      },
    ],
  };

  it('renders through the same mapping: in, not today, the allergy and diet flags', () => {
    const day = dayAnswerOfCacheItem(item);
    const camp = toOtoEvent(day.events[0]!, 'hkt-central');
    const [lin, edge] = camp.attendees!;
    expect(lin).toMatchObject({ allergyFlag: true, allergyDetail: 'Peanuts', dietaryFlag: true, dietaryDetail: 'Vegetarian', attendanceDays: [T] });
    expect(lin!.checkinByDate?.[T]?.checkedInAt).toBe(`${T}T03:00:00.000Z`);
    expect(bucketAttendee(lin!, T, true)).toBe('in');
    expect(edge!.attendanceDays).toEqual(['2026-11-03']);
    expect(bucketAttendee(edge!, T, true)).toBe('notToday');
    expect(day.events[0]!.roster).toMatchObject({ currentlyIn: 1, all: 2 });
  });
});

// --- The screens --------------------------------------------------------------------

const source = (rel: string) => readFileSync(fileURLToPath(new URL(`../src/${rel}`, import.meta.url)), 'utf8');

describe("the screens call the platform and keep the prototype's words", () => {
  it('the board (DropOff.tsx)', () => {
    const board = source('pages/DropOff.tsx');
    for (const words of [
      "{ title: 'Already checked in', description: 'This child is already checked in for today.' }",
      "title: 'Checked in — no printer',",
      "description: 'Check-in recorded. No station configured — bracelet not printed.',",
      "title: 'Checked in',",
      "toast({ title: 'Checked out', description: `${name} has been checked out.` });",
      "title: 'No printer',",
      "description: 'No station configured — band not reprinted.',",
      "title: 'Band reprinted',",
    ]) {
      expect(board, words).toContain(words);
    }
    expect(board).not.toMatch(/from '@\/mockApi'.*checkInEventAttendee/s);
  });

  it('the mobile board', () => {
    const mobile = source('components/mobile/dropoff/MobileDropOffBoard.tsx');
    for (const words of [
      "{ title: 'Already checked in', description: 'This child is already checked in for today.' }",
      "toast({ title: 'No printer configured', description: 'Set up this station before reprinting a band.' });",
      "title: 'Reprinting band',",
    ]) {
      expect(mobile, words).toContain(words);
    }
  });

  it("the till's \"Check in now\" after a pass", () => {
    const till = source('pages/Till.tsx');
    expect(till).toContain('const outcome = await checkInOnPlatform({');
    expect(till).toContain("title: 'Pass sold — checked in',");
  });

  it('no supervision gate on an event check-in (H6): the event calls name no gate', () => {
    const api = source('api/events.ts');
    expect(api).not.toMatch(/supervision/i);
  });
});
