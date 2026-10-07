import { describe, expect, it } from 'vitest';
import {
  EventAttendeeCreateBodySchema,
  EventDropInPricingSchema,
  EventPassSellBodySchema,
  eventPassService,
  walkUpAttendanceDays,
  walkUpBillingOf,
  walkUpNotes,
  walkUpStamp,
} from '../src/events';

/**
 * S2-20 E2 — the walk-up rules ported from the prototype's `addEventAttendee`
 * (mockApi.ts:3726) and `sellEventPass` (lib/eventPass.ts), with Q5's default
 * for the full-camp switch.
 */

const camp = { type: 'camp' as const, startDate: '2026-11-02', endDate: '2026-11-06' };

describe('the note stamp', () => {
  it("says who added the child and how, in the prototype's words", () => {
    expect(walkUpStamp('Som', false)).toBe('Walk-up added by Som (today only)');
    expect(walkUpStamp('Som', true)).toBe('Walk-up added by Som (registered for full range)');
  });

  it("follows staff's own note, or stands alone", () => {
    expect(walkUpNotes('Shy', 'Walk-up added by Som (today only)')).toBe('Shy — Walk-up added by Som (today only)');
    expect(walkUpNotes('   ', 'X')).toBe('X');
    expect(walkUpNotes(undefined, 'X')).toBe('X');
  });
});

describe('the days a walk-up is registered for', () => {
  it('a camp, switch off: today only', () => {
    expect(walkUpAttendanceDays(camp, false, '2026-11-04')).toEqual(['2026-11-04']);
  });

  it('a camp, switch on: every remaining day, today to the last (Q5) — not the days already gone', () => {
    expect(walkUpAttendanceDays(camp, true, '2026-11-04')).toEqual(['2026-11-04', '2026-11-05', '2026-11-06']);
    expect(walkUpAttendanceDays(camp, true, '2026-11-02')).toEqual([
      '2026-11-02',
      '2026-11-03',
      '2026-11-04',
      '2026-11-05',
      '2026-11-06',
    ]);
  });

  it('an open-ended camp can only be added for today, as the prototype could', () => {
    expect(walkUpAttendanceDays({ ...camp, endDate: null }, true, '2026-11-04')).toEqual(['2026-11-04']);
  });

  it('a one-off event or a party carries no days', () => {
    expect(walkUpAttendanceDays({ type: 'event', startDate: '2026-11-04', endDate: '2026-11-04' }, true, '2026-11-04')).toEqual([]);
    expect(walkUpAttendanceDays({ type: 'party', startDate: '2026-11-04', endDate: '2026-11-04' }, false, '2026-11-04')).toEqual([]);
  });
});

describe('how a walk-up is paid for', () => {
  it('a party rides the tab whatever the price; a camp or event is a sale, or free at ฿0', () => {
    expect(walkUpBillingOf('party', 45_000)).toBe('party_tab');
    expect(walkUpBillingOf('party', 0)).toBe('party_tab');
    expect(walkUpBillingOf('camp', 60_000)).toBe('sale');
    expect(walkUpBillingOf('event', 0)).toBe('free');
  });

  it('a pass is sold under the svc ids and names the prototype gave it', () => {
    expect(eventPassService('camp')).toEqual({ serviceId: 'svc-camp-pass', label: 'Camp day pass' });
    expect(eventPassService('event')).toEqual({ serviceId: 'svc-event-pass', label: 'Event entry pass' });
  });
});

describe('the write bodies', () => {
  const base = {
    branchId: '0190a0a0-0000-7000-8000-00000000b001',
    attendeeId: '0190a0a0-0000-7000-8000-00000000a001',
    attendee: { name: 'Lin', parentName: 'May' },
  };

  it("a child's and a guardian's name are the two the form insists on", () => {
    expect(EventAttendeeCreateBodySchema.safeParse(base).success).toBe(true);
    expect(EventAttendeeCreateBodySchema.safeParse({ ...base, attendee: { name: ' ', parentName: 'May' } }).success).toBe(false);
    expect(EventAttendeeCreateBodySchema.safeParse({ ...base, attendee: { name: 'Lin' } }).success).toBe(false);
    expect(EventAttendeeCreateBodySchema.parse(base).registerProperly).toBe(false);
  });

  it('a pass needs its station, its sale id and a tender', () => {
    const pass = { ...base, stationId: base.branchId, saleId: base.attendeeId, tender: { method: 'cash' } };
    expect(EventPassSellBodySchema.safeParse(pass).success).toBe(true);
    const { tender: _tender, ...noTender } = pass;
    expect(EventPassSellBodySchema.safeParse(noTender).success).toBe(false);
    const { stationId: _station, ...noStation } = pass;
    expect(EventPassSellBodySchema.safeParse(noStation).success).toBe(false);
  });

  it('walk-up prices are three whole-satang pairs, never negative', () => {
    const pair = { weekday: 45_000, weekend: 45_000 };
    expect(EventDropInPricingSchema.safeParse({ campDay: pair, eventDay: pair, partyGuest: pair }).success).toBe(true);
    expect(
      EventDropInPricingSchema.safeParse({ campDay: pair, eventDay: pair, partyGuest: { weekday: -1, weekend: 0 } }).success,
    ).toBe(false);
    expect(EventDropInPricingSchema.safeParse({ campDay: pair, eventDay: pair }).success).toBe(false);
  });
});
