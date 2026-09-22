/**
 * DOES THE COUNTER ACTUALLY READ A BOOKING THAT EXISTS? — SCRUM-234.
 *
 * `driveSaleLedger.ts` drives the till's money path against a running api. This
 * drives the till's BOOKING path — `api/bookings.ts`, the platform→till mapper,
 * the conflict reader and the claim-before-mint order — against a stand-in for
 * `GET /bookings`, `GET /bookings/by-reference/:reference` and
 * `POST /bookings/:id/redeem`, which is not in the tree yet.
 *
 * WHY A STAND-IN AND NOT THE REAL API. The route is being built alongside this.
 * What is provable now is the half the counter owns: that the reads go to the
 * platform and nowhere else, that a reference nobody has heard of says so, that
 * a booking someone already redeemed reports when and where, and that a refused
 * claim leaves nothing minted. The stand-in answers exactly the shapes
 * `api/bookings.ts` documents, so when the route lands, a disagreement between
 * the two is a disagreement about the contract and shows up here.
 *
 * HOW TO RUN IT:
 *   cd apps/pos && node_modules/.bin/tsx src/dev/driveBookingRedemption.ts
 *
 * IT IS NOT IN CI, for the reason `driveSaleLedger.ts` gives: `apps/pos` has no
 * test runner yet.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

// --- The stand-in ------------------------------------------------------------

interface Row {
  id: string;
  reference: string;
  branchId: string;
  branchName: string;
  memberId: string | null;
  bookingDate: string;
  createdAt: string;
  status: string;
  totalSatang: number;
  tier: string;
  rateMode: string;
  parentName: string;
  phone: string | null;
  paymentMethod: string | null;
  lines: Array<Record<string, unknown>>;
  redemption: Record<string, unknown> | null;
}

const BRANCH = '11111111-1111-7111-8111-111111111111';

/** Set by the drive once the catalogue is loaded, so one booking maps and one does not. */
let knownPackageId = 'pkg-known';
const UNKNOWN_PACKAGE = '99999999-9999-7999-8999-999999999999';

function line(packageId: string, name: string, kids: number, adults: number, totalSatang: number) {
  return {
    packageId,
    name,
    kids,
    adults,
    kidUnitSatang: kids > 0 ? Math.round(totalSatang / kids) : 0,
    adultsFree: adults,
    adultUnitSatang: 0,
    lineTotalSatang: totalSatang,
  };
}

let rows: Row[] = [];
let claimCount = 0;

function reset() {
  claimCount = 0;
  rows = [
    {
      id: 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa',
      reference: 'OTO-0001-1111',
      branchId: BRANCH,
      branchName: 'HKT Central',
      memberId: null,
      bookingDate: '2026-09-22',
      createdAt: '2026-09-21T04:00:00.000Z',
      status: 'paid',
      totalSatang: 96000,
      tier: 'tourist',
      rateMode: 'weekday',
      parentName: 'Areeya',
      phone: '+66812345678',
      paymentMethod: 'promptpay',
      lines: [line(knownPackageId, 'All-Day Play', 2, 2, 96000)],
      redemption: null,
    },
    {
      id: 'bbbbbbbb-bbbb-7bbb-8bbb-bbbbbbbbbbbb',
      reference: 'OTO-0002-2222',
      branchId: BRANCH,
      branchName: 'HKT Central',
      memberId: null,
      bookingDate: '2026-09-22',
      createdAt: '2026-09-20T04:00:00.000Z',
      status: 'redeemed',
      totalSatang: 48000,
      tier: 'tourist',
      rateMode: 'weekday',
      parentName: 'Somchai',
      phone: null,
      paymentMethod: 'card',
      lines: [line(knownPackageId, 'All-Day Play', 1, 1, 48000)],
      redemption: {
        at: '2026-09-22T02:15:00.000Z',
        branchName: 'HKT Central',
        stationName: 'Till 2',
        staffName: 'Ploy',
        bandCodes: ['BK00001K0', 'BK00001A0'],
      },
    },
    {
      id: 'cccccccc-cccc-7ccc-8ccc-cccccccccccc',
      reference: 'OTO-0003-3333',
      branchId: BRANCH,
      branchName: 'HKT Central',
      memberId: null,
      bookingDate: '2026-09-22',
      createdAt: '2026-09-21T06:00:00.000Z',
      status: 'paid',
      totalSatang: 24000,
      tier: 'tourist',
      rateMode: 'weekday',
      parentName: 'Nok',
      phone: null,
      paymentMethod: 'card',
      lines: [line(UNKNOWN_PACKAGE, 'Retired Summer Pass', 1, 0, 24000)],
      redemption: null,
    },
  ];
}

function send(res: ServerResponse, status: number, body: unknown) {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(text);
}

const server = createServer((req: IncomingMessage, res: ServerResponse) => {
  const url = new URL(req.url ?? '/', 'http://x');
  const path = url.pathname;

  if (req.method === 'GET' && path === '/bookings') {
    const branchId = url.searchParams.get('branchId');
    return send(res, 200, {
      bookings: rows.filter((r) => r.branchId === branchId && r.status === 'paid'),
    });
  }

  if (req.method === 'GET' && path.startsWith('/bookings/by-reference/')) {
    const ref = decodeURIComponent(path.slice('/bookings/by-reference/'.length));
    const row = rows.find((r) => r.reference === ref);
    if (!row) {
      return send(res, 404, { error: { code: 'NOT_FOUND', message: 'No such booking' } });
    }
    return send(res, 200, row);
  }

  const claim = /^\/bookings\/([^/]+)\/redeem$/.exec(path);
  if (req.method === 'POST' && claim) {
    const row = rows.find((r) => r.id === claim[1]);
    if (!row) return send(res, 404, { error: { code: 'NOT_FOUND', message: 'No such booking' } });
    if (row.redemption) {
      return send(res, 409, {
        error: {
          code: 'BOOKING_ALREADY_REDEEMED',
          message: 'That booking has already been redeemed.',
          details: { redemption: row.redemption },
        },
      });
    }
    claimCount += 1;
    row.redemption = {
      at: '2026-09-22T03:00:00.000Z',
      branchName: row.branchName,
      stationName: 'Till 1',
      staffName: 'Reception',
      bandCodes: [],
    };
    row.status = 'redeemed';
    return send(res, 200, { booking: row });
  }

  return send(res, 404, { message: 'Route POST:' + path + ' not found', statusCode: 404 });
});

// --- The till's own fetch, pointed at the stand-in ---------------------------

await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = (server.address() as AddressInfo).port;
const API = `http://127.0.0.1:${port}`;
const realFetch = globalThis.fetch.bind(globalThis);
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const path = typeof input === 'string' ? input : input.toString();
  const url = path.startsWith('/api') ? `${API}${path.slice(4)}` : path;
  return realFetch(url, init);
}) as typeof fetch;

// The till dispatches window events on 401/423; there is no window here.
(globalThis as { window?: unknown }).window ??= {
  dispatchEvent: () => true,
  CustomEvent: class {},
};
(globalThis as { CustomEvent?: unknown }).CustomEvent ??= class {
  constructor(
    public type: string,
    public init?: unknown,
  ) {}
};

const { bookingsApi, toPosBooking, redemptionFromConflict, describeRedemption } = await import(
  '@/api/bookings'
);
const { ApiError, isMissingRoute } = await import('@/api/client');
const { getTicketTypes } = await import('@/store/catalogStore');

knownPackageId = getTicketTypes()[0]?.id ?? 'pkg-known';
reset();

// --- What is driven ----------------------------------------------------------

let failures = 0;
function check(name: string, ok: boolean, detail?: string) {
  if (ok) {
    console.log(`  ok   ${name}`);
  } else {
    failures += 1;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

console.log('\n1. The waiting list comes from the platform, for this branch only');
const waiting = await bookingsApi.waiting(BRANCH);
check('two paid bookings listed', waiting.bookings.length === 2, `got ${waiting.bookings.length}`);
check(
  'the redeemed one is not in the list',
  !waiting.bookings.some((b) => b.reference === 'OTO-0002-2222'),
);
const other = await bookingsApi.waiting('00000000-0000-7000-8000-000000000000');
check('a different branch sees none of them', other.bookings.length === 0);

console.log('\n2. A reference nobody has heard of says so');
try {
  await bookingsApi.byReference('OTO-9999-9999', BRANCH);
  check('404 for an unknown reference', false, 'the lookup returned a booking');
} catch (err) {
  const is404 = err instanceof ApiError && err.status === 404 && !isMissingRoute(err);
  check('404 for an unknown reference, and not read as an undeployed route', is404);
}

console.log('\n3. A paid booking maps onto the shape the redemption flow speaks');
const paid = await bookingsApi.byReference('OTO-0001-1111', BRANCH);
const mapped = toPosBooking(paid);
check('one cart line rebuilt', mapped.booking.lines.length === 1);
check('nothing unmapped', mapped.unmapped.length === 0);
check('total converted to baht', mapped.booking.total === 960, `got ${mapped.booking.total}`);
check(
  'wristband counts come from the platform lines',
  mapped.booking.willIssue.childBracelets === 2 && mapped.booking.willIssue.adultBracelets === 2,
);
check('status is paid', mapped.booking.status === 'paid');

console.log('\n4. A booking already redeemed says when and where');
const done = await bookingsApi.byReference('OTO-0002-2222', BRANCH);
const doneMapped = toPosBooking(done);
check('status is redeemed', doneMapped.booking.status === 'redeemed');
check('the redemption came back', done.redemption !== null);
const sentence = done.redemption ? describeRedemption(done.redemption) : '';
check('the sentence names the branch and the till', sentence.includes('HKT Central (Till 2)'), sentence);
check('the sentence names who did it', sentence.includes('by Ploy'), sentence);
console.log(`       "Redeemed ${sentence}"`);

console.log('\n5. A ticket the branch no longer sells is named, not silently dropped');
const retired = toPosBooking(await bookingsApi.byReference('OTO-0003-3333', BRANCH));
check('no cart line invented for it', retired.booking.lines.length === 0);
check('the line is reported unmapped', retired.unmapped.length === 1);
check('by the name the family paid under', retired.unmapped[0]?.name === 'Retired Summer Pass');

console.log('\n6. The claim is once-only, and the loser is told by whom');
const first = await bookingsApi.redeem(paid.id, { stationId: 'till-1' }, bookingsApi.newRedeemKey());
check('the first claim succeeds', first.booking.redemption !== null);
try {
  await bookingsApi.redeem(paid.id, { stationId: 'till-2' }, bookingsApi.newRedeemKey());
  check('a second claim is refused', false, 'the second claim succeeded');
} catch (err) {
  const conflict = redemptionFromConflict(err);
  check('a second claim is refused with the first redemption', conflict !== null);
  if (conflict) {
    check('which names when and where', describeRedemption(conflict).includes('HKT Central (Till 1)'));
  }
}
check('the platform recorded exactly one claim', claimCount === 1, `got ${claimCount}`);

console.log('\n7. Where the routes are not deployed, nothing is invented');
server.removeAllListeners('request');
server.on('request', (_req, res) => send(res, 404, { message: 'not found', statusCode: 404 }));
try {
  await bookingsApi.byReference('OTO-0001-1111', BRANCH);
  check('an undeployed route is distinguishable', false, 'the lookup returned a booking');
} catch (err) {
  check('an undeployed route reads as undeployed, not as "no such booking"', isMissingRoute(err));
}

server.close();
console.log(failures === 0 ? '\nAll checks passed.\n' : `\n${failures} check(s) failed.\n`);
process.exit(failures === 0 ? 0 : 1);
