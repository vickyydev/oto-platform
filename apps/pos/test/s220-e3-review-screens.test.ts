import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { EventCheckinAnswer, EventCheckinView } from '@oto/shared';
import { bandLineOf, toEventCheckin } from '@/api/events';

/**
 * S2-20 E3 — REVIEW of the screens (SCRUM-217; events-kiosk PLAN, the E3 row
 * of §9; CLAUDE.md §7 "Do not change the design"). Written against the lane,
 * not beside it: nothing here is taken from `s220-e3-events.test.ts`.
 *
 *  - THE PROTOTYPE'S WORDS, word for word, where E3 builds the action: the
 *    Check-in board's Events tab (DropOff.tsx), the mobile board
 *    (MobileDropOffBoard.tsx) and the till's "Check in now" (Till.tsx). The
 *    sentences below were copied from the prototype's own files
 *    (imports/oto-pos/artifacts/oto-till/src/pages/DropOff.tsx 152-216 and
 *    265-279, Till.tsx 160-186, components/mobile/dropoff/MobileDropOffBoard.tsx
 *    270-345), not from the lane.
 *  - THE E1/E2 GATES GONE EXACTLY THERE: no "Not on the platform yet", no
 *    in-memory mutator, no "not checked in" interim words on those three
 *    handlers — and the interim constant gone from the app.
 *  - THE BADGE AND THE TOAST LINE in the prototype's shape, with the short code
 *    under the QR and never the signed code.
 */

const SRC = fileURLToPath(new URL('../src', import.meta.url));
const read = (rel: string) => readFileSync(join(SRC, rel), 'utf8');
const board = read('pages/DropOff.tsx');
const mobile = read('components/mobile/dropoff/MobileDropOffBoard.tsx');
const till = read('pages/Till.tsx');

/** The body of one handler, from its declaration to the next top-level `const` in the component. */
function handler(source: string, name: string): string {
  const start = source.indexOf(`const ${name} = `);
  expect(start, name).toBeGreaterThan(-1);
  const rest = source.slice(start + 1);
  const next = rest.search(/\n {2}const [A-Za-z]+ = /);
  return next === -1 ? rest : rest.slice(0, next);
}

describe("the prototype's words where E3 builds the action", () => {
  it('the Check-in board, Events tab: check-in, check-out, reprint, and the walk-up "check in now"', () => {
    const checkIn = handler(board, 'handleEventCheckIn');
    expect(checkIn).toContain("{ title: 'Already checked in', description: 'This child is already checked in for today.' }");
    expect(checkIn).toContain("title: 'Checked in — no printer'");
    expect(checkIn).toContain("description: 'Check-in recorded. No station configured — bracelet not printed.'");
    expect(checkIn).toContain("title: 'Checked in'");

    const checkOut = handler(board, 'handleEventCheckOut');
    expect(checkOut).toContain("title: 'Checked out'");
    expect(checkOut).toContain('has been checked out.`');

    const reprint = handler(board, 'handleEventReprint');
    expect(reprint).toContain("title: 'No printer'");
    expect(reprint).toContain("description: 'No station configured — band not reprinted.'");
    expect(reprint).toContain("title: 'Band reprinted'");
    // Only while in and not out — the prototype's guard, kept.
    expect(reprint).toContain('if (!ev || !attendee || !record?.checkedInAt || record.checkedOutAt) return;');

    const walkUp = handler(board, 'handleAddAttendeeCheckIn');
    expect(walkUp).toContain("title: 'Checked in'");
    expect(walkUp).toContain("' · no printer — band not printed'");
    expect(walkUp).toContain("title: 'Added'");
    expect(walkUp).toContain('is on the ${ev.title} roster.');
    expect(walkUp).toContain("title: 'Pass sold — left as booked'");
    expect(walkUp).toContain('added to ${ev.title}. Check in later from the roster.');
  });

  it('the mobile board: the same check-in and check-out, its own reprint words', () => {
    const checkIn = handler(mobile, 'handleEventCheckIn');
    expect(checkIn).toContain("{ title: 'Already checked in', description: 'This child is already checked in for today.' }");
    expect(checkIn).toContain("title: 'Checked in — no printer'");
    expect(checkIn).toContain("title: 'Checked in'");
    expect(handler(mobile, 'handleEventCheckOut')).toContain("title: 'Checked out'");
    const reprint = handler(mobile, 'handleEventReprint');
    expect(reprint).toContain("{ title: 'No printer configured', description: 'Set up this station before reprinting a band.' }");
    expect(reprint).toContain("title: 'Reprinting band'");
  });

  it("the till's pass: \"Pass sold — checked in\", the no-printer tail, \"Pass sold\" when it could not, \"left as booked\"", () => {
    const pass = handler(till, 'handleEventPassCheckIn');
    expect(pass).toContain("title: 'Pass sold — checked in'");
    expect(pass).toContain("' · no printer — band not printed'");
    expect(pass).toContain("title: 'Pass sold'");
    expect(pass).toContain('is on the ${ev.title} roster.');
    expect(pass).toContain("title: 'Pass sold — left as booked'");
    expect(pass).toContain('added to ${ev.title}. Check in later from the roster.');
  });
});

describe('the E1 and E2 gates are gone exactly where E3 builds the action', () => {
  const gates = [
    /EVENT_WRITE_PENDING/,
    /writePending\(/,
    /EVENT_CHECKIN_NOT_YET/,
    /checkInEventAttendee\(/,
    /checkOutEventAttendee\(/,
    /checkInSoldPass\(/,
    /dispatchEventBracelets\(/,
    /not checked in'/,
  ];

  it('no handler of the board, the mobile board or the till pass says "not on the platform yet" or runs the in-memory mutator', () => {
    const handlers = [
      handler(board, 'handleEventCheckIn'),
      handler(board, 'handleEventCheckOut'),
      handler(board, 'handleEventReprint'),
      handler(board, 'handleAddAttendeeCheckIn'),
      handler(mobile, 'handleEventCheckIn'),
      handler(mobile, 'handleEventCheckOut'),
      handler(mobile, 'handleEventReprint'),
      handler(till, 'handleEventPassCheckIn'),
    ];
    for (const h of handlers) for (const g of gates) expect(h, `${g} in ${h.slice(0, 40)}`).not.toMatch(g);
    // Each calls the platform's own write.
    expect(handler(board, 'handleEventCheckOut')).toContain('checkOutOnPlatform(');
    expect(handler(board, 'handleEventReprint')).toContain('reprintOnPlatform(');
    expect(handler(mobile, 'handleEventCheckIn')).toContain('checkInOnPlatform(');
    expect(handler(till, 'handleEventPassCheckIn')).toContain('checkInOnPlatform(');
  });

  it('the board and the mobile board import no event mutator from the in-memory store any more', () => {
    for (const source of [board, mobile]) {
      const fromMock = [...source.matchAll(/import\s*\{([^}]*)\}\s*from\s*'@\/mockApi'/g)].map((m) => m[1]!);
      for (const names of fromMock) {
        expect(names).not.toMatch(/\b(checkInEventAttendee|checkOutEventAttendee|getEventById)\b/);
      }
    }
  });

  it("E2's interim words and constant are gone from the whole app", () => {
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.(ts|tsx)$/.test(name)) files.push(p);
      }
    };
    walk(SRC);
    for (const f of files) {
      const text = readFileSync(f, 'utf8');
      expect(text, f).not.toMatch(/EVENT_CHECKIN_NOT_YET|Pass sold — not checked in|Added — not checked in/);
    }
  });
});

describe('the badge and the toast line, in the prototype shape', () => {
  const view = (over: Partial<EventCheckinView>): EventCheckinView => ({
    date: '2026-11-04',
    status: 'checked_in',
    checkedInAt: '2026-11-04T03:00:00.000Z',
    checkedInBy: 'Nok',
    checkedOutAt: null,
    checkedOutBy: null,
    checkinRef: null,
    ...over,
  });

  it('the badge reads the short codes, "—" for a check-in the OTO App made alone, and no parent when none was printed', () => {
    expect(toEventCheckin(view({ kidBandShortCode: 'T1-7KMQ4X', parentBandShortCode: 'T1-9QW2ZD' }))).toMatchObject({
      wristbandCode: 'T1-7KMQ4X',
      parentWristbandCode: 'T1-9QW2ZD',
    });
    const appOnly = toEventCheckin(view({}));
    expect(appOnly.wristbandCode).toBe('—');
    expect(appOnly).not.toHaveProperty('parentWristbandCode');
    const out = toEventCheckin(view({ status: 'checked_out', checkedOutAt: '2026-11-04T08:00:00.000Z', kidBandShortCode: 'T1-AAAAAA' }));
    expect(out.checkedOutAt).toBe('2026-11-04T08:00:00.000Z');
  });

  it('the toast line is "band <code> · parent <code>", the short code and never the signed one', () => {
    const answer = (kid: string | null, parent: string | null): EventCheckinAnswer => ({
      checkin: {
        id: 'c',
        eventId: 'e',
        attendeeId: 'a',
        date: '2026-11-04',
        status: 'checked_in',
        checkedInAt: '2026-11-04T03:00:00.000Z',
        checkedInBy: null,
        checkedOutAt: null,
        checkedOutBy: null,
        kidBand: kid ? { id: 'k', kind: 'kid', shortCode: kid } : null,
        parentBand: parent ? { id: 'p', kind: 'adult', shortCode: parent } : null,
        origin: 'till',
        syncState: 'synced',
        syncError: null,
      },
      replayed: false,
      printJobs: [],
      notes: [],
    });
    expect(bandLineOf(answer('T1-7KMQ4X', 'T1-9QW2ZD'))).toBe('band T1-7KMQ4X · parent T1-9QW2ZD');
    expect(bandLineOf(answer('T1-7KMQ4X', null))).toBe('band T1-7KMQ4X');
    expect(bandLineOf(answer(null, null))).toBe('band —');
    expect(bandLineOf(answer('T1-7KMQ4X', null))).not.toMatch(/\./);
  });
});
