import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiCheckinToCheckIn, waitingStaysOf, type ApiCheckin, type ApiNanny, type ApiRegistration } from '@/api/checkin';

/**
 * SCRUM-873 — A NANNY ASSIGNED ON THE BOARD BEFORE PAYMENT KEEPS HER NAME.
 *
 * The board lets staff assign a nanny to a registered child before the family
 * pays. Two paths then load that child onto a sale, and both lost her:
 *
 *   1. Board → "Check in": `loadDropOffRegistration` runs from the till's
 *      first render, where the roster is still empty, so `waitingStaysOf`
 *      found no name and the order summary read "Nanny · " with nothing after
 *      it. The reader now fetches the roster itself when the roster it was
 *      handed does not name an assigned nanny.
 *   2. Ticket grid → Add drop-off child → Add to sale: the picker's rows come
 *      through `apiCheckinToCheckIn`, which never carried `nannyId`, so the
 *      assignment itself was dropped and staff had to pick her again. The
 *      mapping now carries the id, and the till names her from its roster.
 *
 * `fetch` is stubbed at the boundary, so every request asserted is one the
 * till would send.
 */

const BRANCH = '0190a0a0-0000-7000-8000-0000000000b1';
const REG = '0190a0a0-0000-7000-8000-00000000a001';
const PLOY = '0190a0a0-0000-7000-8000-00000000d002';

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

const stay = (id: string, over: Partial<ApiCheckin> = {}): ApiCheckin => ({
  id,
  registrationId: REG,
  childId: null,
  childName: 'Kai',
  childAgeYears: 3,
  dateOfBirth: null,
  allergies: null,
  foodRestrictions: null,
  mayOrderFood: false,
  foodProvision: null,
  service: 'nanny',
  status: 'registered',
  scheduledFor: null,
  bookedMinutes: null,
  nannyId: PLOY,
  checkedInAt: null,
  saleId: null,
  bandId: null,
  visitId: null,
  photoFileId: null,
  ...over,
});

const registration = (children: ApiCheckin[]): ApiRegistration => ({
  id: REG,
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
} as unknown as ApiRegistration);

const roster = (): ApiNanny[] => [{ id: PLOY, name: 'Ploy', onShift: true, load: 0, coveredNames: [] }];

const config = () => json({ policy: {}, pricing: {}, photoRetentionDays: 7, nannies: roster() });

describe('SCRUM-873: the Add drop-off picker keeps the assignment', () => {
  it("apiCheckinToCheckIn carries the assigned nanny's id", () => {
    const ci = apiCheckinToCheckIn(stay('0190a0a0-0000-7000-8000-00000000c001'), registration([]));
    expect(ci.assignedNannyId).toBe(PLOY);
  });

  it('a child with no nanny carries no assignment', () => {
    const ci = apiCheckinToCheckIn(stay('0190a0a0-0000-7000-8000-00000000c001', { nannyId: null }), registration([]));
    expect(ci.assignedNannyId).toBeUndefined();
    expect('assignedNannyId' in ci).toBe(false);
  });

  it("the till's picker hand-over names the nanny from the roster it holds", () => {
    const src = readFileSync(fileURLToPath(new URL('../src/pages/Till.tsx', import.meta.url)), 'utf8');
    const attach = src.slice(src.indexOf('const handleAttachDropOff'), src.indexOf('const cartNannyLoadsFor'));
    expect(attach).toMatch(/nannyName:\s*ci\.assignedNannyName\s*\?\?\s*nannyRoster\.find\(/);
  });

  it("the phone till's picker hand-over names her the same way", () => {
    const src = readFileSync(fileURLToPath(new URL('../src/components/mobile/MobileTill.tsx', import.meta.url)), 'utf8');
    const start = src.indexOf('const handleAttachDropOff');
    expect(start).toBeGreaterThan(-1);
    const attach = src.slice(start, src.indexOf("setMStep('dropoff-config')", start));
    expect(attach).toMatch(/nannyId:\s*ci\.assignedNannyId/);
    expect(attach).toMatch(/nannyName:\s*ci\.assignedNannyName\s*\?\?\s*nannyRoster\.find\(\(n\) => n\.id === ci\.assignedNannyId\)\?\.name/);
  });
});

describe("SCRUM-873: the board's Check in names the nanny", () => {
  it('reads the roster itself when the one it was handed does not name her', async () => {
    answers.push(() => json({ registrations: [registration([stay('0190a0a0-0000-7000-8000-00000000c001')])] }));
    answers.push(config);
    const stays = await waitingStaysOf(BRANCH, REG, []);
    expect(calls.map((c) => c.url.split('?')[0])).toEqual(['/api/checkin/registrations', '/api/checkin/config']);
    expect(stays).toHaveLength(1);
    expect(stays[0]).toMatchObject({ assignedNannyId: PLOY, assignedNannyName: 'Ploy' });
  });

  it('asks nothing more when the roster it was handed names her', async () => {
    answers.push(() => json({ registrations: [registration([stay('0190a0a0-0000-7000-8000-00000000c001')])] }));
    const stays = await waitingStaysOf(BRANCH, REG, roster());
    expect(calls).toHaveLength(1);
    expect(stays[0]).toMatchObject({ assignedNannyId: PLOY, assignedNannyName: 'Ploy' });
  });

  it('asks nothing more when no waiting child has a nanny', async () => {
    answers.push(() => json({ registrations: [registration([stay('0190a0a0-0000-7000-8000-00000000c001', { nannyId: null, service: 'drop_off' })])] }));
    const stays = await waitingStaysOf(BRANCH, REG, []);
    expect(calls).toHaveLength(1);
    expect(stays[0]!.assignedNannyId).toBeUndefined();
  });

  it('still keeps the assignment when the roster cannot be read', async () => {
    answers.push(() => json({ registrations: [registration([stay('0190a0a0-0000-7000-8000-00000000c001')])] }));
    answers.push(() => json({ error: { code: 'INTERNAL', message: 'down' } }, 500));
    const stays = await waitingStaysOf(BRANCH, REG, []);
    expect(stays[0]).toMatchObject({ assignedNannyId: PLOY });
    expect(stays[0]!.assignedNannyName).toBeUndefined();
  });

  it('reads the roster once for a family with two nanny children', async () => {
    answers.push(() =>
      json({
        registrations: [
          registration([
            stay('0190a0a0-0000-7000-8000-00000000c001'),
            stay('0190a0a0-0000-7000-8000-00000000c002', { childName: 'Nok' }),
          ]),
        ],
      }),
    );
    answers.push(config);
    const stays = await waitingStaysOf(BRANCH, REG);
    expect(calls).toHaveLength(2);
    expect(stays.map((s) => s.assignedNannyName)).toEqual(['Ploy', 'Ploy']);
  });
});
