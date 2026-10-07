import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EventAttendeeWriteAnswer } from '@oto/shared';
import { api, ApiError } from '@/api/client';
import { eventWriteBlocker, sellOnPlatform } from '@/api/events';
import { EventsPanel } from '@/components/admin/events/EventsPanel';
import type { OtoEvent } from '@/types';

/**
 * S2-20 E2 — REVIEW of the till's side (SCRUM-217; events-kiosk PLAN, the E2
 * row of §9, §3, §7, Q5 and Q8). Written against the lane, not beside it:
 * nothing here is taken from `s220-e2-events.test.ts`.
 *
 *  - REFUSED BEFORE MONEY. What the till can know is refused before the pass
 *    form — before a name, before a tender — at the pass card and the board's
 *    Add attendee alike, and the refusal is asked FIRST in each opener.
 *  - THE GATES. E1's "Not on the platform yet" is gone exactly where E2
 *    builds the real write (selling a pass, adding a walk-up) and still stands
 *    where it does not (check-in, check-out, reprint, the party tab, the
 *    mobile board and party screens, the redemption-time pass check-in).
 *  - THE WORDS. The pass flow, the name capture and the member pre-fill are
 *    the prototype's; the only new words are the listed UI additions.
 *  - Q8. The Admin Events panel shows all three walk-up prices.
 */

const lane = vi.hoisted(() => ({ current: 'platform' as 'platform' | 'box' }));
const HKT_CENTRAL = '0190a0a0-0000-7000-8000-00000000b001';

vi.mock('@/api/catalogBridge', () => ({
  apiBranchIdForSlug: (slug: string) => (slug === 'hkt-central' ? HKT_CENTRAL : null),
}));
vi.mock('@/lib/lane', () => ({ currentLane: () => lane.current }));
vi.mock('@/api/client', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/api/client')>();
  return { ...original, api: { ...original.api, get: vi.fn(), post: vi.fn(), put: vi.fn() } };
});
vi.mock('@/store/catalogStore', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/store/catalogStore')>();
  return { ...original, getActiveBranch: () => ({ ...original.getActiveBranch(), id: 'hkt-central' }) };
});

// The node runner compiles the components' JSX to `React.createElement` (vitest.config.ts).
Object.assign(globalThis, { React });

const postMock = vi.mocked(api.post);
beforeEach(() => {
  postMock.mockReset();
  lane.current = 'platform';
});

const TODAY = '2026-11-10';
const event = (over: Partial<OtoEvent>): OtoEvent => ({
  id: '0190a0a0-0000-7000-8000-0000000e0101',
  branchId: 'hkt-central',
  type: 'event',
  status: 'upcoming',
  title: 'Clay workshop',
  date: TODAY,
  startTime: '10:00',
  endTime: '12:00',
  location: 'Studio',
  expectedKids: 8,
  expectedAdults: 2,
  entryPriceTHB: { weekday: 350, weekend: 400 },
  ...over,
});
const ticketTill = { branchSlug: 'hkt-central', stationId: 'st-t1', capabilities: ['tickets'], today: TODAY, online: true };

const source = (rel: string) => readFileSync(fileURLToPath(new URL(`../src/${rel}`, import.meta.url)), 'utf8');
/** The body of the function a source declares as `const <name> = …`, up to the next top-level `const` of the component. */
const fnBody = (src: string, name: string) => {
  const start = src.indexOf(`const ${name}`);
  expect(start, name).toBeGreaterThan(-1);
  const next = src.indexOf('\n  const ', start + 10);
  return src.slice(start, next === -1 ? undefined : next);
};

// =============================================================================
// Refused before the money
// =============================================================================

describe('what the till can know is refused before a name or a tender is asked', () => {
  it('a camp on either side of its range, and an event with no entry price, never open the form', () => {
    const camp = event({ type: 'camp', date: '2026-11-08', dateRange: { start: '2026-11-08', end: '2026-11-12' } });
    expect(eventWriteBlocker(camp, ticketTill)).toBeNull();
    expect(eventWriteBlocker({ ...camp, dateRange: { start: '2026-11-11', end: '2026-11-12' } }, ticketTill)).toEqual({
      title: 'Camp not running today',
      description: 'This camp is not running today, so nobody can be added to it here.',
    });
    expect(eventWriteBlocker({ ...camp, dateRange: { start: '2026-11-01', end: '2026-11-09' } }, ticketTill)?.title).toBe(
      'Camp not running today',
    );
    // First and last day both run.
    expect(eventWriteBlocker({ ...camp, dateRange: { start: TODAY, end: '2026-11-12' } }, ticketTill)).toBeNull();
    expect(eventWriteBlocker({ ...camp, dateRange: { start: '2026-11-01', end: TODAY } }, ticketTill)).toBeNull();
    expect(eventWriteBlocker(event({ entryPriceTHB: undefined }), ticketTill)).toEqual({
      title: 'No entry price',
      description: 'This event has no entry price in the OTO App yet, so nobody can be added to it at the till.',
    });
  });

  it('the box lane is "No connection": a pass is a cloud write', () => {
    lane.current = 'box';
    expect(eventWriteBlocker(event({}), ticketTill)?.title).toBe('No connection');
    expect(eventWriteBlocker(event({ type: 'party', entryPriceTHB: undefined }), ticketTill)?.title).toBe('No connection');
  });

  it('a paid pass needs a ticket till; a party walk-up does not, at any price', () => {
    expect(eventWriteBlocker(event({}), { ...ticketTill, capabilities: ['fnb', 'shop'] })?.title).toBe('Not a ticket till');
    expect(eventWriteBlocker(event({}), { ...ticketTill, stationId: undefined })?.title).toBe('Not a ticket till');
    expect(eventWriteBlocker(event({ type: 'party', entryPriceTHB: undefined }), { ...ticketTill, stationId: undefined, capabilities: ['fnb'] })).toBeNull();
  });

  it("the till's pass card asks the blocker FIRST — before the member lookup, the name capture and the form", () => {
    const step1 = fnBody(source('pages/Till.tsx'), 'handleSellEventPassFromStep1');
    const blocker = step1.indexOf('eventWriteBlocker(');
    expect(blocker).toBeGreaterThan(-1);
    for (const later of ['membersApi.lookup(', 'setCaptureNameFor(', 'setEventPassFor(']) {
      expect(step1.indexOf(later), later).toBeGreaterThan(blocker);
    }
    expect(step1.slice(blocker, step1.indexOf('const phone'))).toMatch(/if \(blocked\) \{\s*toast\(blocked\);\s*return;/);
  });

  it("the board's Add attendee asks it before the form opens, and the ids of a refused press are dropped", () => {
    const board = source('pages/DropOff.tsx');
    const opener = fnBody(board, 'openAddAttendee');
    expect(opener.indexOf('eventWriteBlocker(')).toBeLessThan(opener.indexOf('setShowAddAttendee(true)'));
    const sell = fnBody(board, 'handleAddAttendeeSell');
    expect(sell).toContain('if (!sold.retryable) addAttendeeIdsRef.current = null;');
    const till = fnBody(source('pages/Till.tsx'), 'handleEventPassSell');
    expect(till).toContain('if (!sold.retryable) eventPassIdsRef.current = null;');
    // Minted once per form, so a lost answer is retried as the same pass.
    expect(till).toContain('eventPassIdsRef.current ??= { attendeeId: newId(), saleId: newId(), actionId: newId() }');
  });
});

// =============================================================================
// The sell, as the till sends it
// =============================================================================

describe('the sell, as the till sends it', () => {
  const ids = {
    attendeeId: '0190a0a0-0000-7000-8000-0000000a0101',
    saleId: '0190a0a0-0000-7000-8000-0000000a0102',
    actionId: '0190a0a0-0000-7000-8000-0000000a0103',
  };
  const answer: EventAttendeeWriteAnswer = {
    attendee: {
      id: ids.attendeeId,
      eventId: 'camp',
      eventType: 'camp',
      otoappAttendeeId: null,
      merged: false,
      billing: 'sale',
      priceSatang: 60_000,
      attendanceDays: [TODAY, '2026-11-11', '2026-11-12'],
      parentAttending: true,
      syncState: 'pending',
      syncError: 'OTOAPP_DIRECTORY_UNREACHABLE: The OTO App did not answer',
      createdAt: `${TODAY}T03:00:00.000Z`,
    },
    replayed: false,
    sale: { id: ids.saleId, receiptNumber: 'T1-000042', grossSatang: 60_000, status: 'finalised' },
    printingNotes: [],
  };
  const input = { name: 'Fern', parentName: 'Ann', parentPhone: '0812345678', parentAttending: true };

  it('a full-camp pass carries the switch, the fee shown in satang, and the platform\'s days come back onto the attendee', async () => {
    postMock.mockResolvedValueOnce(answer);
    const camp = event({ type: 'camp', dateRange: { start: '2026-11-08', end: '2026-11-12' }, entryPriceTHB: { weekday: 600, weekend: 700 } });
    const out = await sellOnPlatform({
      event: camp,
      branchSlug: 'hkt-central',
      stationId: 'st-t1',
      input,
      registerProperly: true,
      paymentMethod: 'card',
      doorFeeTHB: 600,
      ids,
    });
    const [path, body, opts] = postMock.mock.calls[0]!;
    expect(path).toBe(`/events/${camp.id}/passes`);
    expect(body).toMatchObject({ registerProperly: true, expectedTotalSatang: 60_000, tender: { method: 'card' }, saleId: ids.saleId });
    expect(opts).toMatchObject({ idempotencyKey: `event-pass:${ids.attendeeId}:card:` });
    expect(out).toMatchObject({ ok: true, attendee: { id: ids.attendeeId, attendanceDays: answer.attendee.attendanceDays, syncState: 'pending' } });
  });

  it('a free event goes to /attendees under its own key, with no tender and no sale id', async () => {
    postMock.mockResolvedValueOnce({ ...answer, attendee: { ...answer.attendee, billing: 'free', priceSatang: 0 }, sale: null });
    await sellOnPlatform({
      event: event({ entryPriceTHB: { weekday: 0, weekend: 0 } }),
      branchSlug: 'hkt-central',
      stationId: undefined,
      input,
      registerProperly: true,
      doorFeeTHB: 0,
      ids,
    });
    const [path, body, opts] = postMock.mock.calls[0]!;
    expect(path).toMatch(/\/attendees$/);
    expect(body).not.toHaveProperty('tender');
    expect(body).not.toHaveProperty('saleId');
    // Only a camp registers for days.
    expect(body).toMatchObject({ registerProperly: false });
    expect(opts).toMatchObject({ idempotencyKey: `event-attendee:${ids.attendeeId}` });
  });

  it('a 5xx keeps the ids for the retry; a 4xx drops them', async () => {
    postMock.mockRejectedValueOnce(new ApiError(503, 'EVENTS_SEAM_NOT_GRANTED', 'down'));
    const fault = await sellOnPlatform({ event: event({}), branchSlug: 'hkt-central', stationId: 's', input, registerProperly: false, paymentMethod: 'cash', doorFeeTHB: 350, ids });
    expect(fault).toMatchObject({ ok: false, retryable: true });
    postMock.mockRejectedValueOnce(new ApiError(409, 'CAMP_NOT_RUNNING_TODAY', 'This camp is not running today'));
    const refusal = await sellOnPlatform({ event: event({}), branchSlug: 'hkt-central', stationId: 's', input, registerProperly: false, paymentMethod: 'cash', doorFeeTHB: 350, ids });
    expect(refusal).toMatchObject({ ok: false, retryable: false });
  });
});

// =============================================================================
// The E1 gates: gone where E2 writes, standing where it does not
// =============================================================================

describe('"Not on the platform yet" — gone exactly where E2 builds the write, standing everywhere else', () => {
  it('gone: selling a pass at the till and adding a walk-up at the board', () => {
    const till = source('pages/Till.tsx');
    expect(fnBody(till, 'handleSellEventPassFromStep1')).not.toContain('EVENT_WRITE_PENDING');
    expect(fnBody(till, 'handleEventPassSell')).toContain('sellOnPlatform(');
    const board = source('pages/DropOff.tsx');
    expect(fnBody(board, 'handleAddAttendeeSell')).not.toContain('writePending');
    expect(fnBody(board, 'openAddAttendee')).not.toContain('writePending');
  });

  it('standing: check-in, check-out and reprint on the board (E3)', () => {
    const board = source('pages/DropOff.tsx');
    expect(fnBody(board, 'writePending')).toContain('toast(EVENT_WRITE_PENDING)');
    for (const handler of ['handleEventCheckIn', 'handleEventCheckOut', 'handleEventReprint']) {
      expect(fnBody(board, handler), handler).toMatch(/if \(writePending\(eventId\)\) return;/);
    }
  });

  it('standing: the mobile board and the mobile check-ins (E3); gone from the party tab, which E4 put on the platform', () => {
    const mobileBoard = source('components/mobile/dropoff/MobileDropOffBoard.tsx');
    expect(mobileBoard.match(/if \(writePending\(eventId\)\) return;/g)?.length).toBe(3);
    const mobileParties = source('components/mobile/parties/MobileParties.tsx');
    expect(mobileParties).toContain('toast(EVENT_WRITE_PENDING)');
    // Check-in, reprint and check-out still wait for E3; the payment and the F&B do not.
    expect(mobileParties.match(/if \(writePending\(eventId\)\) return;/g)?.length).toBe(3);
    expect(fnBody(mobileParties, 'handleTakePayment')).not.toContain('writePending');
    expect(fnBody(mobileParties, 'handleChargeExtra')).not.toContain('writePending');
    const partyDetail = source('components/parties/PartyDetail.tsx');
    expect(partyDetail).not.toContain('EVENT_WRITE_PENDING');
  });

  it('the words of that gate are unchanged', () => {
    expect(source('api/events.ts')).toContain(
      "title: 'Not on the platform yet',\n  description: 'This event comes from the OTO App, and the till cannot change it here yet. Use the OTO App for now.',",
    );
  });
});

// =============================================================================
// The prototype's words
// =============================================================================

describe("the pass flow's words are the prototype's", () => {
  it('the till: the pass toasts, the name capture, the pre-fill', () => {
    const till = source('pages/Till.tsx');
    for (const words of [
      "toast({ title: 'Could not sell pass', description: sold.message, variant: 'destructive' });",
      "title: 'Pass sold — left as booked',",
      'description: `${attendee.name} added to ${ev.title}. Check in later from the roster.${notYetInApp}`,',
      // E2 fix round (finding 10): "Check in now" says the child is NOT checked
      // in, with the gate's instruction — not the prototype's words for a
      // check-in that ran and minted no band.
      "title: 'Pass sold — not checked in',",
      'description: `${attendee.name} is on the ${ev.title} roster. ${EVENT_CHECKIN_NOT_YET}${notYetInApp}`,',
      'New guest — enter name',
      "recognised. Enter the guest's name to register them so they're remembered next time.",
      'Name / nickname',
      'placeholder="e.g. Mama, John"',
      'Register &amp; continue',
      'prefillSavedChildren={',
    ]) {
      expect(till, words).toContain(words);
    }
    // The one addition to those toasts, said only when the app has not confirmed the child.
    expect(till).toContain("? ' The OTO App has not confirmed them yet.'");
  });

  it('the board: the walk-up toasts', () => {
    const board = source('pages/DropOff.tsx');
    for (const words of [
      "toast({ title: 'Could not add attendee', description: sold.message, variant: 'destructive' });",
      "title: 'Added — not checked in',",
      'description: `${attendee.name} is on the ${ev.title} roster. ${EVENT_CHECKIN_NOT_YET}${notYetInApp}`,',
      "title: 'Pass sold — left as booked',",
    ]) {
      expect(board, words).toContain(words);
    }
  });

  it("the attendee modal's labels and the party-guest tab label are the prototype's", () => {
    const modal = source('components/parties/AddAttendeeModal.tsx');
    for (const words of [
      "? `Add & check in${tabChargeTHB ? ` · ฿${tabChargeTHB} to tab` : ''}`",
      '? `Continue to payment · ฿${doorFeeTHB}`',
      ": 'Continue to check-in';",
      "{doorFeeTHB > 0 ? 'Pass paid — check in now?' : 'Check in now?'}",
      "'Please complete payment with our staff.'",
      "{doorFeeTHB > 0 ? 'Payment complete' : \"You're all set\"}",
    ]) {
      expect(modal, words).toContain(words);
    }
    expect(source('api/events.ts')).toContain("items: [{ name: `Walk-up guest — ${c.name}`, qty: 1, lineTotal: amount }],");
  });

  it('the roster marks a child the app has not confirmed: "Pending" while it waits, "Refused" when the app said no (finding 9)', () => {
    const list = source('components/parties/EventAttendeeList.tsx');
    expect(list).toMatch(/attendee\.syncState && attendee\.syncState !== 'synced' && \(/);
    expect(list).toContain("{attendee.syncState === 'failed' ? 'Refused' : 'Pending'}");
  });

  it("“Check in now” keeps the gate's instruction for the check-in it cannot do yet (finding 10)", () => {
    expect(source('api/events.ts')).toContain(
      "export const EVENT_CHECKIN_NOT_YET = 'Checking in is not on the platform yet — use the OTO App for now.';",
    );
  });
});

// =============================================================================
// Q8 — the Admin Events panel
// =============================================================================

describe('Q8 — the Admin Events panel shows all three walk-up prices', () => {
  const html = (el: React.ReactElement) =>
    renderToStaticMarkup(el).replace(/&#x27;/g, "'").replace(/&amp;/g, '&').replace(/&quot;/g, '"');

  it('Camp day, Event day and Party guest, each a weekday/weekend pair, and only the party guest said to be charged', () => {
    const page = html(React.createElement(EventsPanel));
    expect(page).toContain('Walk-up prices');
    const at = (words: string) => page.indexOf(words);
    expect(at('Camp day')).toBeGreaterThan(-1);
    expect(at('Event day')).toBeGreaterThan(at('Camp day'));
    expect(at('Party guest')).toBeGreaterThan(at('Event day'));
    expect(page).toContain("Added to the party's tab for each walk-up guest — no door payment.");
    expect(page).toContain("A camp pass at the till is priced from the camp's own entry price.");
    expect(page).toContain("An event pass at the till is priced from the event's own entry price.");
    // Save waits for the platform's answer.
    expect(page).toMatch(/<button[^>]*disabled[^>]*>[\s\S]*?Save changes/);
  });
});
