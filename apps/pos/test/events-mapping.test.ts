import { describe, expect, it } from 'vitest';
import type { EventAttendeeView, EventView } from '@oto/shared';
import { toOtoEvent } from '@/api/events';
import { computeRosterStats, groupAttendees } from '@/lib/eventRoster';
import { computePartyOutstanding, computePartyTotal } from '@/lib/party';
import type { PartyBooking } from '@/types';

/**
 * S2-20 E1 — the platform's events in the prototype's shapes.
 *
 * The Events tab, the Check-in board's Events tab, the mobile lists and the
 * till's pass cards render the prototype's `OtoEvent` and do their roster
 * arithmetic with the prototype's own `lib/eventRoster.ts`. These pin the
 * mapping those screens rely on: satang to baht, a camp's range, every day
 * written out for a child registered "every day", the day's check-in on the
 * prototype's key — and that the prototype's roster counts, run over the
 * mapped children, are the counts the platform worked out.
 */

const T = '2026-11-04';

function child(over: Partial<EventAttendeeView>): EventAttendeeView {
  return {
    id: 'a',
    childId: 'a',
    recordKind: 'camp_registration',
    name: 'Ploy',
    age: 7,
    dateOfBirth: '2019-04-01',
    language: 'Thai',
    allergy: null,
    dietary: null,
    parentName: 'Nok',
    parentPhone: '+66812345001',
    parentAttending: false,
    attendanceDays: ['2026-11-02', '2026-11-03', T, '2026-11-05', '2026-11-06'],
    attendsAllDays: true,
    attendsOnDate: true,
    notes: null,
    isOneTime: false,
    source: null,
    checkins: [],
    bucket: 'outstanding',
    ...over,
  };
}

const checkedIn = (date: string, out = false) => ({
  date,
  status: out ? ('checked_out' as const) : ('checked_in' as const),
  checkedInAt: `${date}T02:30:00.000Z`,
  checkedInBy: 'som',
  checkedOutAt: out ? `${date}T08:00:00.000Z` : null,
  checkedOutBy: out ? 'som' : null,
  checkinRef: null,
});

const camp: EventView = {
  id: 'camp',
  branchId: '0190a0a0-0000-7000-8000-000000000001',
  type: 'camp',
  appEventType: 'camp',
  status: 'in_progress',
  appStatus: 'in_progress',
  archived: false,
  title: 'Ocean camp',
  startDate: '2026-11-02',
  endDate: '2026-11-06',
  cancelledDays: [],
  startTime: '09:00',
  endTime: '15:00',
  location: 'Studio',
  expectedKids: 20,
  expectedAdults: null,
  entryPrice: { weekdaySatang: 60_000, weekendSatang: 70_000 },
  party: null,
  attendeeCount: 4,
  attendees: [
    child({ id: 'ploy', allergy: 'Peanuts', parentAttending: true, checkins: [checkedIn(T)], bucket: 'in' }),
    child({ id: 'win', dietary: 'No pork', checkins: [checkedIn(T, true)], bucket: 'out' }),
    child({ id: 'tee' }),
    child({ id: 'mali', attendsAllDays: false, attendanceDays: ['2026-11-02'], attendsOnDate: false, bucket: 'notToday' }),
  ],
  roster: { arrived: 2, expected: 3, currentlyIn: 1, outstanding: 1, all: 4 },
};

describe('a camp, in the shape the roster screens render', () => {
  const mapped = toOtoEvent(camp, 'hkt-central');

  it("keeps the till's own branch slug, the range and the flat price in baht", () => {
    expect(mapped).toMatchObject({
      branchId: 'hkt-central',
      type: 'camp',
      status: 'in_progress',
      date: '2026-11-02',
      dateRange: { start: '2026-11-02', end: '2026-11-06' },
      entryPriceTHB: { weekday: 600, weekend: 700 },
      location: 'Studio',
      expectedAdults: 0,
    });
  });

  it("raises the prototype's flags from the OTO App's text and keys the day's check-in by date", () => {
    const ploy = mapped.attendees!.find((a) => a.id === 'ploy')!;
    expect(ploy).toMatchObject({ allergyFlag: true, allergyDetail: 'Peanuts', dietaryFlag: false, parentAttending: true });
    expect(ploy.checkinByDate?.[T]).toMatchObject({ checkedInAt: `${T}T02:30:00.000Z`, operatorName: 'som' });
    expect(ploy.checkinByDate?.[T]?.checkedOutAt).toBeUndefined();
    const win = mapped.attendees!.find((a) => a.id === 'win')!;
    expect(win).toMatchObject({ dietaryFlag: true, dietaryDetail: 'No pork', allergyFlag: false });
    expect(win.checkinByDate?.[T]?.checkedOutAt).toBe(`${T}T08:00:00.000Z`);
  });

  it("gives the prototype's roster arithmetic the platform's counts and groups", () => {
    expect(computeRosterStats(mapped.attendees!, T, true)).toEqual(camp.roster);
    const groups = groupAttendees(mapped.attendees!, T, true);
    expect(groups.inList.map((a) => a.id)).toEqual(['ploy']);
    expect(groups.outList.map((a) => a.id)).toEqual(['win']);
    expect(groups.outstandingList.map((a) => a.id)).toEqual(['tee']);
    expect(groups.notTodayList.map((a) => a.id)).toEqual(['mali']);
  });
});

describe('a party and a one-off event', () => {
  it("a party carries the OTO App's bill: its total as the base and its deposit, with empty POS ledgers", () => {
    const party = toOtoEvent(
      {
        ...camp,
        id: 'party',
        type: 'party',
        appEventType: 'birthday',
        status: 'upcoming',
        startDate: T,
        endDate: T,
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
          depositDate: '2026-10-20',
        },
        attendees: [],
      },
      'hkt-central',
    );
    expect(party).toMatchObject({ childName: 'Mali', kidAge: 6, whatsapp: '+66812345678', decoration: 'Ocean' });
    expect(party.dateRange).toBeUndefined();
    expect(party.entryPriceTHB).toBeUndefined();
    const bill = party as unknown as PartyBooking;
    expect(computePartyTotal(bill)).toBe(12_000);
    expect(computePartyOutstanding(bill)).toBe(9_000);
    expect(bill.kitchen.cake.type).toBe('none');
  });

  it('a one-off event carries no attendance days, as in the prototype', () => {
    const event = toOtoEvent(
      {
        ...camp,
        id: 'workshop',
        type: 'event',
        endDate: T,
        startDate: T,
        attendees: [child({ id: 'walkup', attendanceDays: [], recordKind: 'event_attendee', parentName: null })],
      },
      'hkt-central',
    );
    expect(event.attendees![0]!.attendanceDays).toBeUndefined();
    expect(event.attendees![0]!.parentName).toBe('');
  });

  it("a pass card's event has no children read and no range when the camp is open-ended", () => {
    const pass = toOtoEvent({ ...camp, endDate: null, attendees: undefined, attendeeCount: null, roster: null }, 'hkt-central');
    expect(pass.attendees).toBeUndefined();
    expect(pass.dateRange).toBeUndefined();
  });
});
