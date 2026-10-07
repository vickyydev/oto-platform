import { describe, expect, it } from 'vitest';
import {
  CAMP_MAX_DAYS,
  attendanceDaysOf,
  attendsOn,
  eventAllergyOf,
} from '../src/events';
import {
  BridgeEventCheckinSchema,
  EVENT_CHECKIN_REFUSALS,
  EventCheckinBodySchema,
  OfflineEventCheckedInSchema,
  eventBandDocument,
} from '../src/event-checkin';
import { addDaysToIsoDate } from '../src/business-date';

/**
 * S2-20 E3 — the rules a check-in reads, ported from the prototype
 * (`checkInEventAttendee`, mockApi.ts:3785; `eventBraceletPrintJobs`,
 * lib/printRouting.tsx; EventAttendeeList's "Not registered for today"), with
 * the E1 review's finding 1 fixed: whether a camp child attends a day is
 * computed from the camp's range, never from the bounded day list.
 */

const camp = { type: 'camp' as const, startDate: '2026-11-02', endDate: '2026-11-06' };
const everyDay = { attendsAllDays: true, attendanceDays: [] as string[] };

describe('attendsOn — from the camp’s range', () => {
  it('a one-off event or a party: always (one day, already on the list)', () => {
    expect(attendsOn({ type: 'event', startDate: '2026-11-02', endDate: '2026-11-02' }, everyDay, '2026-11-02')).toBe(true);
    expect(attendsOn({ type: 'party', startDate: '2026-11-02', endDate: '2026-11-02' }, everyDay, '2026-11-02')).toBe(true);
  });

  it('an every-day registration: each day the camp runs, and no other', () => {
    expect(attendsOn(camp, everyDay, '2026-11-01')).toBe(false);
    expect(attendsOn(camp, everyDay, '2026-11-02')).toBe(true);
    expect(attendsOn(camp, everyDay, '2026-11-06')).toBe(true);
    expect(attendsOn(camp, everyDay, '2026-11-07')).toBe(false);
  });

  it('a registration that names its days: those days only', () => {
    const named = { attendsAllDays: false, attendanceDays: ['2026-11-02', '2026-11-06'] };
    expect(attendsOn(camp, named, '2026-11-02')).toBe(true);
    expect(attendsOn(camp, named, '2026-11-04')).toBe(false);
  });

  it('an open-ended camp that began more than a year ago still runs today (E1 review, finding 1)', () => {
    const club = { type: 'camp' as const, startDate: '2025-08-01', endDate: null };
    expect(attendsOn(club, everyDay, '2026-11-04')).toBe(true);
    expect(attendsOn(club, everyDay, '2025-07-31')).toBe(false);
  });
});

describe('attendanceDaysOf — bounded, and holding the day asked about', () => {
  it('a camp shorter than the bound is written out whole, as before', () => {
    expect(attendanceDaysOf(camp, everyDay, '2026-11-04')).toEqual([
      '2026-11-02',
      '2026-11-03',
      '2026-11-04',
      '2026-11-05',
      '2026-11-06',
    ]);
  });

  it('an open-ended camp over a year old: the bounded window ends at the day asked about', () => {
    const club = { type: 'camp' as const, startDate: '2025-08-01', endDate: null };
    const days = attendanceDaysOf(club, everyDay, '2026-11-04');
    expect(days).toHaveLength(CAMP_MAX_DAYS);
    expect(days[days.length - 1]).toBe('2026-11-04');
    expect(days[0]).toBe(addDaysToIsoDate('2026-11-04', -(CAMP_MAX_DAYS - 1)));
  });

  it('a camp longer than the bound with its end ahead: the window still holds the day asked about', () => {
    const long = { type: 'camp' as const, startDate: '2025-01-01', endDate: '2027-12-31' };
    const days = attendanceDaysOf(long, everyDay, '2026-06-15');
    expect(days).toContain('2026-06-15');
    expect(days.length).toBeLessThanOrEqual(CAMP_MAX_DAYS);
    // Early in the camp the window is its first days, as it always was.
    expect(attendanceDaysOf(long, everyDay, '2025-01-10')[0]).toBe('2025-01-01');
  });
});

describe('the allergy line (Q13: the OTO App’s any-text rule)', () => {
  it('any text in either field, both kept, the same text once', () => {
    expect(eventAllergyOf('Peanuts', null)).toBe('Peanuts');
    expect(eventAllergyOf('Peanuts', 'EpiPen in bag')).toBe('Peanuts — EpiPen in bag');
    expect(eventAllergyOf('None', '  ')).toBe('None');
    expect(eventAllergyOf('Egg', 'Egg')).toBe('Egg');
    expect(eventAllergyOf(null, '')).toBeNull();
  });
});

describe("the event band's paper (`eventBraceletPrintJobs`)", () => {
  const facts = {
    eventTitle: 'Ocean camp',
    date: '2026-11-04',
    startTime: '09:00',
    endTime: '15:00',
    childName: 'Lin',
    parentName: 'May',
    allergy: 'Peanuts',
    dietary: 'Vegetarian',
  };

  it('the kid band: the child, the event, the day and its times, the allergy and diet lines', () => {
    expect(eventBandDocument({ ...facts, kind: 'kid', code: 'not-a-code' })).toEqual({
      holderName: 'Lin',
      startEndTime: '09:00 – 15:00',
      duration: '2026-11-04',
      partyName: 'Ocean camp',
      dietaryRequirement: 'Vegetarian',
      allergy: 'Peanuts',
      bandCode: 'not-a-code',
      shortCode: undefined,
    });
  });

  it('the parent band: the parent, the event and the day — never the child’s allergy or diet', () => {
    const doc = eventBandDocument({ ...facts, kind: 'adult', code: 'x' });
    expect(doc).toMatchObject({ holderName: 'May', partyName: 'Ocean camp', duration: '2026-11-04' });
    expect(doc.allergy).toBeUndefined();
    expect(doc.dietaryRequirement).toBeUndefined();
  });

  it('a kid band with no allergy or diet prints neither line', () => {
    const doc = eventBandDocument({ ...facts, allergy: null, dietary: '  ', kind: 'kid', code: 'x' });
    expect(doc.allergy).toBeUndefined();
    expect(doc.dietaryRequirement).toBeUndefined();
  });
});

describe('the wire', () => {
  it("the refusals are the prototype's words", () => {
    expect(EVENT_CHECKIN_REFUSALS.alreadyIn).toMatchObject({ title: 'Already checked in', message: 'This child is already checked in for today.' });
    expect(EVENT_CHECKIN_REFUSALS.notRegistered.message).toBe('Not registered for today');
  });

  it('a check-in names its own id; the box lane takes the same id', () => {
    const id = '0190a0a0-0000-7000-8000-00000000e301';
    expect(EventCheckinBodySchema.safeParse({ branchId: id, checkinId: id }).success).toBe(true);
    expect(EventCheckinBodySchema.safeParse({ branchId: id }).success).toBe(false);
    expect(BridgeEventCheckinSchema.safeParse({ eventId: id, attendeeId: id, checkinId: id }).success).toBe(true);
    expect(
      OfflineEventCheckedInSchema.safeParse({
        checkinId: id,
        eventId: id,
        attendeeId: id,
        eventType: 'camp',
        date: '2026-11-04',
        at: '2026-11-04T03:00:00.000Z',
        childName: 'Lin',
        parentAttending: true,
        eventTitle: 'Ocean camp',
      }).success,
    ).toBe(true);
  });
});
