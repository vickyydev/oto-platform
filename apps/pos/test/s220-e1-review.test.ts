import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EventDayAnswer, EventPassesAnswer, EventView } from '@oto/shared';
import { renderHook } from './support/hooks';
import { api, ApiError } from '@/api/client';
import { EVENTS_NOT_LINKED, EVENT_WRITE_PENDING, useEventPasses, useEventsForDate } from '@/api/events';

/**
 * S2-20 E1 — REVIEW of the screens' side (SCRUM-217; events-kiosk PLAN §9 E1).
 *
 * Two things, written from outside the builder's own `events-mapping.test.ts`:
 *
 *  1. THE READ the screens are built on (`useEventsForDate`, `useEventPasses`):
 *     an empty day is never claimed before the platform answered it; a refusal
 *     is said rather than shown as "no events"; a till with no platform branch
 *     asks nothing; an answer for a day the screen has left is dropped; a
 *     same-day refresh keeps the list on screen; a failed pass read keeps the
 *     cards it had.
 *  2. THE APPROVED WORDS. The header Events tab, the Check-in board's Events
 *     tab (desktop and mobile), the mobile Events list and the till's pass card
 *     keep the prototype's labels and read no in-memory event list any more —
 *     only the data source changed.
 */

const HKT_CENTRAL = '0190a0a0-0000-7000-8000-00000000b001';

vi.mock('react', () => import('./support/hooks'));
vi.mock('@/api/catalogBridge', () => ({
  apiBranchIdForSlug: (slug: string) => (slug === 'hkt-central' ? HKT_CENTRAL : null),
}));
vi.mock('@/api/client', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/api/client')>();
  return { ...original, api: { ...original.api, get: vi.fn() } };
});

const getMock = vi.mocked(api.get);

async function settle(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
}

const event = (id: string, title: string, date: string): EventView => ({
  id,
  branchId: HKT_CENTRAL,
  type: 'event',
  appEventType: 'workshop',
  status: 'upcoming',
  appStatus: 'upcoming',
  archived: false,
  title,
  startDate: date,
  endDate: date,
  cancelledDays: [],
  startTime: '14:00',
  endTime: '16:00',
  location: 'Studio',
  expectedKids: 10,
  expectedAdults: 2,
  entryPrice: { weekdaySatang: 35_000, weekendSatang: 40_000 },
  party: null,
  attendeeCount: 0,
  attendees: [],
  roster: { arrived: 0, expected: 0, currentlyIn: 0, outstanding: 0, all: 0 },
});

const day = (date: string, events: EventView[]): EventDayAnswer => ({ branchId: HKT_CENTRAL, date, events });

beforeEach(() => {
  getMock.mockReset();
});

describe('useEventsForDate — the read under every Events screen', () => {
  it('claims nothing before the answer, then shows the day in the prototype shape, read by the platform branch id', async () => {
    getMock.mockResolvedValueOnce(day('2026-11-04', [event('e1', 'Slime workshop', '2026-11-04')]));
    const hook = renderHook(() => useEventsForDate('hkt-central', '2026-11-04'));
    expect(hook.result.current).toEqual({ events: [], loaded: false, error: null });
    await settle();
    expect(getMock).toHaveBeenCalledWith(`/events?branchId=${HKT_CENTRAL}&date=2026-11-04`);
    expect(hook.result.current.loaded).toBe(true);
    expect(hook.result.current.error).toBeNull();
    expect(hook.result.current.events.map((e) => [e.title, e.branchId, e.date])).toEqual([
      ['Slime workshop', 'hkt-central', '2026-11-04'],
    ]);
  });

  it('a refusal is said in the counter\'s words, never shown as an empty day', async () => {
    getMock.mockRejectedValueOnce(new ApiError(503, 'EVENTS_SEAM_NOT_GRANTED', 'The OTO App events seam is installed but…'));
    const hook = renderHook(() => useEventsForDate('hkt-central', '2026-11-04'));
    await settle();
    expect(hook.result.current).toMatchObject({ events: [], loaded: true });
    expect(hook.result.current.error).toMatch(/OTO App events seam/);
  });

  it('a till with no platform branch asks nothing and says why', async () => {
    const hook = renderHook(() => useEventsForDate('nowhere', '2026-11-04'));
    await settle();
    expect(getMock).not.toHaveBeenCalled();
    expect(hook.result.current).toEqual({ events: [], loaded: true, error: EVENTS_NOT_LINKED });
  });

  it("an answer for a day the screen has left is dropped; the new day's is shown", async () => {
    let releaseOld: (v: EventDayAnswer) => void = () => undefined;
    getMock.mockImplementationOnce(() => new Promise((resolve) => (releaseOld = resolve as typeof releaseOld)));
    getMock.mockResolvedValueOnce(day('2026-11-05', [event('e2', 'Tomorrow', '2026-11-05')]));
    const hook = renderHook((date: string) => useEventsForDate('hkt-central', date), '2026-11-04' as string);
    hook.rerender('2026-11-05');
    await settle();
    expect(hook.result.current.events.map((e) => e.id)).toEqual(['e2']);
    releaseOld(day('2026-11-04', [event('e1', 'Today', '2026-11-04')]));
    await settle();
    expect(hook.result.current.events.map((e) => e.id)).toEqual(['e2']);
  });

  it('a same-day refresh keeps the list on screen while it reloads; another day starts empty', async () => {
    getMock.mockResolvedValueOnce(day('2026-11-04', [event('e1', 'Today', '2026-11-04')]));
    const hook = renderHook((key: number) => useEventsForDate('hkt-central', '2026-11-04', key), 0 as number);
    await settle();
    getMock.mockImplementationOnce(() => new Promise(() => undefined));
    hook.rerender(1);
    expect(hook.result.current).toMatchObject({ loaded: true, error: null });
    expect(hook.result.current.events.map((e) => e.id)).toEqual(['e1']);
  });
});

describe('useEventPasses — the till pass cards', () => {
  it("reads today's passes from the platform and keeps the last cards when a read fails", async () => {
    const passes: EventPassesAnswer = {
      branchId: HKT_CENTRAL,
      date: '2026-11-04',
      passes: [{ ...event('p1', 'Ocean camp', '2026-11-02'), attendees: undefined, attendeeCount: null, roster: null }],
    };
    getMock.mockResolvedValueOnce(passes);
    const hook = renderHook((tick: number) => useEventPasses('hkt-central', tick), 0 as number);
    await settle();
    expect(getMock).toHaveBeenCalledWith(`/events/passes?branchId=${HKT_CENTRAL}`);
    expect(hook.result.current.map((p) => [p.title, p.entryPriceTHB])).toEqual([
      ['Ocean camp', { weekday: 350, weekend: 400 }],
    ]);
    getMock.mockRejectedValueOnce(new Error('offline'));
    hook.rerender(1);
    await settle();
    expect(hook.result.current.map((p) => p.id)).toEqual(['p1']);
  });
});

// --- The approved words -------------------------------------------------------------

const source = (rel: string) => readFileSync(fileURLToPath(new URL(`../src/${rel}`, import.meta.url)), 'utf8');

describe("the screens keep the prototype's words and read the platform", () => {
  const SCREENS: Record<string, string[]> = {
    'pages/Events.tsx': [
      'No events booked for this day.',
      'aria-label="Previous day"',
      'aria-label="Next day"',
      'Today',
      "{allEvents.length === 1 ? 'event' : 'events'}",
      'Outstanding',
      'Paid',
      '`${attendeeCount} registered`',
      '`${ev.expectedKids} kids · ${ev.expectedAdults} adults`',
    ],
    'components/mobile/parties/MobileEventsList.tsx': ['No events for this day.'],
    'pages/DropOff.tsx': ['No events today', 'Events with registered attendees appear here.'],
    'components/mobile/dropoff/MobileDropOffBoard.tsx': ['No events today', 'Events with registered attendees appear here.'],
    'components/till/EventPassCard.tsx': ['Sell pass', 'per day', "{event.type === 'camp' ? 'Camp' : 'Event'}"],
  };

  for (const [rel, words] of Object.entries(SCREENS)) {
    it(`${rel} keeps its labels`, () => {
      const src = source(rel);
      for (const w of words) expect(src, w).toContain(w);
    });
  }

  it('no Events screen reads the in-memory event lists any more', () => {
    for (const rel of [
      'pages/Events.tsx',
      'pages/DropOff.tsx',
      'pages/Till.tsx',
      'components/mobile/parties/MobileEventsList.tsx',
      'components/mobile/parties/MobileParties.tsx',
      'components/mobile/dropoff/MobileDropOffBoard.tsx',
    ]) {
      const src = source(rel);
      expect(src, rel).not.toMatch(/\bgetEventsForDate\b|\bgetActiveEventPasses\b/);
    }
  });

  it('the one temporary sentence is the stated one, and only the boards add "could not be loaded"', () => {
    expect(EVENT_WRITE_PENDING).toEqual({
      title: 'Not on the platform yet',
      description: 'This event comes from the OTO App, and the till cannot change it here yet. Use the OTO App for now.',
    });
    expect(source('pages/DropOff.tsx')).toContain('Events could not be loaded');
    expect(source('components/mobile/dropoff/MobileDropOffBoard.tsx')).toContain('Events could not be loaded');
    expect(source('pages/Events.tsx')).not.toContain('could not be loaded');
  });
});
