import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { BridgeCheckinUpdateSchema, CheckInNowSchema } from '@oto/shared';

/**
 * SCRUM-494 gate (check-in) — reproductions.
 *
 * `it.fails` marks a reproduction of a gap still open at the gate: the body
 * asserts the required behaviour and fails today, so the suite stays green
 * while the gap is visible. When the gap is closed, the `it.fails` turns red
 * and is changed to `it`.
 */

const src = (rel: string): string => readFileSync(fileURLToPath(new URL(`../src/${rel}`, import.meta.url)), 'utf8');

const mockImportsOf = (file: string): string[] => {
  const found: string[] = [];
  for (const m of file.matchAll(/import\s*\{([^}]*)\}\s*from\s*['"]@\/mockApi['"]/g)) {
    for (const name of m[1]!.split(',')) {
      const clean = name.replace(/^\s*type\s+/, '').trim();
      if (clean) found.push(clean);
    }
  }
  return found;
};

const SALE = '0190a0a0-0000-7000-8000-00000000b001';
const STAY = '0190a0a0-0000-7000-8000-00000000c001';

describe('s494-checkin gate: the paid service on the box lane', () => {
  it('the platform lane keeps the entry service', () => {
    const parsed = CheckInNowSchema.parse({ saleId: SALE, entries: [{ checkinId: STAY, nannyId: null, service: 'nanny' }] });
    expect(parsed.entries[0]!.service).toBe('nanny');
  });

  // checkinApi.checkInNow sends `entries` unchanged to the box intent; the
  // box's bridge schema keeps each entry's `service`, the box checks in on it
  // (packages/box-agent/test/s494-checkin-box.test.ts) and its fact carries
  // it to the platform (apps/api/test/s494-checkin-sync.test.ts).
  it('the box lane keeps the entry service (paid Nanny line on a Drop-Off stay)', () => {
    const parsed = BridgeCheckinUpdateSchema.parse({
      event: 'check_in_now',
      saleId: SALE,
      entries: [{ checkinId: STAY, nannyId: null, service: 'nanny' }],
    });
    expect(parsed.event).toBe('check_in_now');
    if (parsed.event !== 'check_in_now') return;
    expect(parsed.entries[0]!.service).toBe('nanny');
  });

  it('the box lane refuses an entry field it does not know rather than dropping it', () => {
    const parsed = BridgeCheckinUpdateSchema.safeParse({
      event: 'check_in_now',
      saleId: SALE,
      entries: [{ checkinId: STAY, nannyId: null, serviceType: 'nanny' }],
    });
    expect(parsed.success).toBe(false);
  });
});

describe('s494-checkin gate: the phone shell has no in-memory check-in left', () => {
  const MOCK_CHECKIN_WRITES = [
    'registerWalkInChildren',
    'recordSupervisionWaiver',
    'checkInFamilyWithPayment',
    'linkCheckInSaleId',
    'getCheckInsByRegistration',
    'markCheckInsBooked',
    'getCheckIns',
  ];

  it('the phone till registers, waives and checks in through the platform', () => {
    const imported = mockImportsOf(src('components/mobile/MobileTill.tsx'));
    expect(imported.filter((n) => MOCK_CHECKIN_WRITES.includes(n))).toEqual([]);
  });

  it("the phone board's Check in hands the platform registration to the phone till", () => {
    const board = src('components/mobile/dropoff/MobileDropOffBoard.tsx');
    expect(board).toMatch(/setDropOffHandoff\(c\.registrationId\)/);
    expect(board).toMatch(/navigate\('\/'\)/);
    expect(src('components/mobile/MobileShell.tsx')).toMatch(/<Route path="\/" component=\{MobileTill\} \/>/);
    expect(src('components/mobile/MobileTill.tsx')).toMatch(/takeDropOffHandoff\(\)/);
  });

  // The board lists platform registrations; the phone till it hands over to
  // reads the same registration back from the platform.
  it('the phone till loads the handed-over registration from the platform', () => {
    const till = src('components/mobile/MobileTill.tsx');
    const at = till.indexOf('const loadDropOffRegistration');
    const load = till.slice(at, at + 1200);
    expect(load).not.toMatch(/getCheckInsByRegistration\(/);
    expect(load).toMatch(/waitingStaysOf\(/);
  });

  it('the phone till registers, waives and checks in with the counter till calls', () => {
    const till = src('components/mobile/MobileTill.tsx');
    expect(till).toMatch(/checkinApi\.createRegistration\(/);
    expect(till).toMatch(/checkinApi\.recordWaiver\(/);
    expect(till).toMatch(/checkinApi\s*\.checkInNow\(/);
    // Each drop-off line is the stay's id, so the paid sale line names the stay.
    expect(till).toMatch(/id: args\.ci\.id/);
    // The paid line's service travels with the entry.
    expect(till).toMatch(/service: d\.service/);
  });
});
