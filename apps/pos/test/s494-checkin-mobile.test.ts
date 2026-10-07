import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { checkinApi, waitingStaysOf, type ApiNanny } from '@/api/checkin';

/**
 * SCRUM-494 (check-in) — the till's half.
 *
 *   1. The Drop-Off / Nanny switch on the till's cart line travels with
 *      "Check in now" (`entries[].service`), so the platform applies it.
 *   2. On a phone (under 768 px) the board, the hand-over, the booked check-in
 *      and the release call the same platform wrappers as the desktop
 *      (`boardApi`, `checkinApi`, `releaseApi`): no screen of the phone
 *      check-in shell writes to the in-memory store any more.
 *   3. The board's "Check in" hand-over to the till reads the registration
 *      back from the platform, never the in-memory store, and never loads a
 *      child already paid for onto a second sale.
 *
 * `fetch` is stubbed at the boundary, so every request asserted is one the
 * till would send.
 */

const BRANCH = '0190a0a0-0000-7000-8000-0000000000b1';
const REG = '0190a0a0-0000-7000-8000-00000000a001';
const OTHER_REG = '0190a0a0-0000-7000-8000-00000000a002';
const SALE = '0190a0a0-0000-7000-8000-00000000b001';
const PIM = '0190a0a0-0000-7000-8000-00000000d001';

type Call = { url: string; method: string; body: unknown };
let calls: Call[];
let answers: Array<(call: Call) => Response>;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

beforeEach(() => {
  calls = [];
  answers = [];
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    const call: Call = {
      url,
      method: init.method ?? 'GET',
      body: typeof init.body === 'string' ? JSON.parse(init.body) : (init.body ?? null),
    };
    calls.push(call);
    const next = answers.shift();
    if (!next) throw new Error(`unexpected request ${call.method} ${url}`);
    return next(call);
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const stay = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  registrationId: REG,
  childId: null,
  childName: 'Mint',
  childAgeYears: 6,
  dateOfBirth: null,
  allergies: 'Peanuts',
  foodRestrictions: null,
  mayOrderFood: false,
  foodProvision: null,
  service: 'drop_off',
  status: 'registered',
  scheduledFor: null,
  bookedMinutes: null,
  nannyId: null,
  checkedInAt: null,
  saleId: null,
  bandId: null,
  visitId: null,
  photoFileId: null,
  ...over,
});

const registration = (id: string, children: unknown[]) => ({
  id,
  branchId: BRANCH,
  memberId: null,
  guardianName: 'Ploy',
  guardianPhone: '+66812345678',
  contactChannel: 'whatsapp',
  consentRecordedAt: '2026-10-02T09:00:00.000Z',
  acknowledgedConfirmations: [],
  source: 'walk_in',
  photoFileId: null,
  createdAt: '2026-10-02T09:00:00.000Z',
  children,
});

describe('s494-checkin: the cart line service travels with "Check in now"', () => {
  it('sends each entry its service on the platform lane', async () => {
    answers.push(() => json({ saleId: SALE, children: [], bands: [], printJobs: [], notes: [] }));
    await checkinApi.checkInNow({
      saleId: SALE,
      entries: [
        { checkinId: '0190a0a0-0000-7000-8000-00000000c001', nannyId: PIM, service: 'nanny' },
        { checkinId: '0190a0a0-0000-7000-8000-00000000c002', nannyId: null, service: 'drop_off' },
      ],
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toContain('/checkin/check-in-now');
    expect(calls[0]!.method).toBe('POST');
    expect(calls[0]!.body).toEqual({
      saleId: SALE,
      entries: [
        { checkinId: '0190a0a0-0000-7000-8000-00000000c001', nannyId: PIM, service: 'nanny' },
        { checkinId: '0190a0a0-0000-7000-8000-00000000c002', nannyId: null, service: 'drop_off' },
      ],
    });
  });

  it("the till's check-in choice sends the paid line's service", () => {
    const src = readFileSync(fileURLToPath(new URL('../src/pages/Till.tsx', import.meta.url)), 'utf8');
    const press = src.slice(src.indexOf('const handleCheckInGroupNow'), src.indexOf('const handleLeaveGroupBooked'));
    expect(press).toMatch(/\.checkInNow\(/);
    expect(press).toMatch(/service: e\.input\.serviceType/);
  });
});

describe("s494-checkin: the board's hand-over reads the platform", () => {
  it('answers the waiting, unpaid children of that registration, with an assigned nanny named', async () => {
    answers.push(() =>
      json({
        registrations: [
          registration(OTHER_REG, [stay('0190a0a0-0000-7000-8000-00000000c009', { registrationId: OTHER_REG })]),
          registration(REG, [
            stay('0190a0a0-0000-7000-8000-00000000c001', { childName: 'Mint' }),
            stay('0190a0a0-0000-7000-8000-00000000c002', { childName: 'Kai', childAgeYears: 3, service: 'nanny', nannyId: PIM }),
            // Paid for and left as booked: checked in from the board, never charged again.
            stay('0190a0a0-0000-7000-8000-00000000c003', { childName: 'Booked', saleId: SALE, scheduledFor: '2026-10-02T10:00:00.000Z' }),
            stay('0190a0a0-0000-7000-8000-00000000c004', { childName: 'In', status: 'in_park', saleId: SALE }),
          ]),
        ],
      }),
    );
    const nannies: ApiNanny[] = [{ id: PIM, name: 'Pim', onShift: true, load: 0, coveredNames: [] }];
    const stays = await waitingStaysOf(BRANCH, REG, nannies);
    expect(calls[0]!.url).toContain(`/checkin/registrations?branchId=${BRANCH}`);
    expect(stays.map((s) => s.childName)).toEqual(['Mint', 'Kai']);
    expect(stays[0]).toMatchObject({ id: '0190a0a0-0000-7000-8000-00000000c001', registrationId: REG, serviceType: 'drop_off', phone: '+66812345678', allergiesMedical: 'Peanuts' });
    expect(stays[1]).toMatchObject({ serviceType: 'nanny', assignedNannyId: PIM, assignedNannyName: 'Pim' });
  });

  it('answers nothing for a registration that is not waiting', async () => {
    answers.push(() => json({ registrations: [] }));
    expect(await waitingStaysOf(BRANCH, REG)).toEqual([]);
  });

  it("the desktop till's hand-over no longer reads the in-memory store", () => {
    const src = readFileSync(fileURLToPath(new URL('../src/pages/Till.tsx', import.meta.url)), 'utf8');
    expect(src).not.toMatch(/getCheckInsByRegistration/);
    const load = src.slice(src.indexOf('const loadDropOffRegistration'), src.indexOf('const loadDropOffRegistration') + 1200);
    expect(load).toMatch(/waitingStaysOf\(/);
  });
});

describe('s494-checkin: the phone check-in shell writes nothing to the in-memory store', () => {
  /** Every in-memory check-in reader and writer the phone screens used to call. */
  const MOCK_CHECKIN_CALLS = [
    'getCheckIns',
    'getMockWristbands',
    'getDropOffPricing',
    'getNannyRoster',
    'assignNanny',
    'checkOut',
    'markArrived',
    'updateCheckIn',
    'resendWaConfirmation',
    'simulateWaConfirm',
    'markWaConnectionFailed',
    'applyCheckInPhotos',
    'addPickupFromChatPhoto',
    'getAuthorizedPickups',
    'addGuardianToRegistration',
  ];
  const mockImportsOf = (src: string): string[] => {
    const found: string[] = [];
    for (const m of src.matchAll(/import\s*\{([^}]*)\}\s*from\s*['"]@\/mockApi['"]/g)) {
      for (const name of m[1]!.split(',')) {
        const clean = name.replace(/^\s*type\s+/, '').trim();
        if (clean) found.push(clean);
      }
    }
    return found;
  };
  const files = [
    '../src/components/mobile/dropoff/MobileDropOffBoard.tsx',
    '../src/components/mobile/dropoff/MobileCheckOutView.tsx',
    '../src/components/mobile/dropoff/MobileChildDetail.tsx',
    '../src/components/mobile/dropoff/MobileChildCard.tsx',
    '../src/components/mobile/dropoff/MobileCheckInConsent.tsx',
  ];
  for (const rel of files) {
    it(`${rel.split('/').pop()} imports no in-memory check-in call`, () => {
      const src = readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
      const imported = mockImportsOf(src);
      expect(imported.filter((n) => MOCK_CHECKIN_CALLS.includes(n))).toEqual([]);
    });
  }

  it('the phone board reads and writes through the desktop wrappers', () => {
    const src = readFileSync(fileURLToPath(new URL('../src/components/mobile/dropoff/MobileDropOffBoard.tsx', import.meta.url)), 'utf8');
    for (const call of [
      'boardApi.board(',
      'boardApi.assignNanny(',
      'boardApi.edit(',
      'boardApi.checkInBooked(',
      'boardApi.contactTest(',
      'boardApi.contactStatus(',
      'checkinApi.uploadPhoto(',
      'releaseApi.promoteFromChat(',
    ]) {
      const [owner, method] = call.split('.');
      // A chained call may break the line before its dot.
      expect(src, call).toMatch(new RegExp(`${owner}\\s*\\.${method!.replace('(', '\\(')}`));
    }
    // Nothing stays on the in-memory store: since S2-20 E1 the day's events are
    // read from the platform, and since E3 the events tab's check-in,
    // check-out and reprint are written there too.
    expect(mockImportsOf(src).sort()).toEqual([]);
  });

  it('the phone release view releases through the platform', () => {
    const src = readFileSync(fileURLToPath(new URL('../src/components/mobile/dropoff/MobileCheckOutView.tsx', import.meta.url)), 'utf8');
    for (const call of ['releaseApi.context(', 'releaseApi.addGuardian(', 'releaseApi.uploadPhoto(', 'releaseApi.release(']) {
      expect(src, call).toContain(call);
    }
    expect(src).not.toMatch(/from ['"]@\/mockApi['"]/);
  });
});
