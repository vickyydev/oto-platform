import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, NetworkError, isMissingRoute } from '@/api/client';
import {
  bookingsApi,
  redemptionFromConflict,
  type BookingRedeemResult,
  type RedeemOutcome,
} from '@/api/bookings';
import type { ApiSalePrintJob } from '@/api/history';
import { dispatchPlatformPrinting } from '@/lib/printRouting';
import { toast } from '@/hooks/use-toast';
import {
  announceBookingRedemption,
  redeemBookingOnPlatform,
  redeemedOutcome,
  type RedeemKeyHolder,
} from '@/lib/bookingRedemption';

/**
 * SCRUM-494 gate — phone till Confirm & Issue.
 *
 * (1) the phone's redeem path calls nothing from the in-memory store;
 * (2) the bands and the print failure the till shows are the platform's;
 * (3) the counter till's handling is the one it had before the move.
 */

vi.mock('@/lib/printRouting', () => ({ dispatchPlatformPrinting: vi.fn() }));
vi.mock('@/hooks/use-toast', () => ({ toast: vi.fn() }));

const dispatched = vi.mocked(dispatchPlatformPrinting);
const toasted = vi.mocked(toast);

const BOOKING = '018f0000-0000-7000-8000-0000000b0494';
const STATION = '018f0000-0000-7000-8000-0000000057a1';

const src = (rel: string) => readFileSync(path.resolve(import.meta.dirname, '..', 'src', rel), 'utf8');
const handlerOf = (file: string): string => {
  const start = file.indexOf('const handleRedeemConfirm = async');
  expect(start).toBeGreaterThan(-1);
  return file.slice(start, file.indexOf('\n  const ', start + 1));
};

function job(over: Partial<ApiSalePrintJob>): ApiSalePrintJob {
  return {
    id: 'job',
    kind: 'receipt',
    role: 'receipt',
    status: 'queued',
    stationId: STATION,
    deviceId: 'dev-1',
    deviceLabel: 'Receipt printer',
    subjectType: 'sale',
    subjectId: 'sale-1',
    reprintOf: null,
    reprintReason: null,
    requestedByName: null,
    ...over,
  } as ApiSalePrintJob;
}

const BANDS = [
  { id: 'b1', kind: 'kid', shortCode: 'T1-REAL01', childName: 'Ploy', printedJobId: 'job-band' },
  { id: 'b2', kind: 'kid', shortCode: 'T1-REAL02', childName: 'Mew', printedJobId: null },
  { id: 'b3', kind: 'adult', shortCode: 'T1-REAL03', childName: null, printedJobId: null },
] as unknown as NonNullable<BookingRedeemResult['bands']>;

function answer(over: Partial<BookingRedeemResult> = {}): BookingRedeemResult {
  return {
    booking: { id: BOOKING, reference: 'OTO-GATE-0494' } as BookingRedeemResult['booking'],
    sale: { id: 'sale-1', receiptNumber: 'T1-000777', totals: { grossSatang: 120_000 } },
    bands: BANDS,
    printing: { jobs: [job({ id: 'r' })], notes: [], failed: null },
    box: null,
    ...over,
  } as BookingRedeemResult;
}

/** The counter till's handling as it stood on origin/main before the move, copied. */
async function originalDesktop(
  keys: RedeemKeyHolder,
  body: { stationId?: string; visitId?: string },
  reference: string,
): Promise<RedeemOutcome> {
  if (keys.current?.bookingId !== BOOKING) keys.current = { bookingId: BOOKING, key: bookingsApi.newRedeemKey() };
  let redeemed: BookingRedeemResult;
  try {
    redeemed = await bookingsApi.redeem(
      BOOKING,
      { ...(body.stationId ? { stationId: body.stationId } : {}), ...(body.visitId ? { visitId: body.visitId } : {}) },
      keys.current.key,
    );
  } catch (err) {
    if (!(err instanceof NetworkError)) keys.current = null;
    const first = redemptionFromConflict(err);
    if (first) return { ok: false, redemption: first };
    if (err instanceof NetworkError) {
      return { ok: false, message: 'No connection to the platform, so this booking cannot be redeemed here. Nothing has been issued.' };
    }
    if (isMissingRoute(err)) {
      return { ok: false, message: 'This deployment cannot record a booking redemption yet (SCRUM-234). Nothing has been issued.' };
    }
    return { ok: false, message: err instanceof ApiError ? err.message : 'The booking could not be redeemed. Nothing has been issued.' };
  }
  const printing = redeemed.printing;
  if (printing) {
    dispatchPlatformPrinting(
      printing.jobs.filter((j) => j.reprintOf === null),
      printing.failed ? [...printing.notes, printing.failed.message] : printing.notes,
    );
  }
  for (const note of redeemed.box?.notes ?? []) toast({ title: 'Not printed', description: note, variant: 'destructive' });
  toast({
    title: redeemed.box ? 'Booking redeemed offline' : 'Booking redeemed',
    description: `${reference} — ${(redeemed.bands ?? []).length} wristband(s) issued.`,
  });
  return redeemed.box
    ? { ok: true, issued: { receiptNumber: redeemed.sale?.receiptNumber ?? null, bands: redeemed.bands ?? [], notes: redeemed.box.notes } }
    : { ok: true };
}

async function viaHelper(keys: RedeemKeyHolder, body: { stationId?: string; visitId?: string }, reference: string) {
  const claimed = await redeemBookingOnPlatform(BOOKING, body, keys);
  if (!claimed.ok) return claimed;
  announceBookingRedemption(reference, claimed.redeemed);
  return redeemedOutcome(claimed.redeemed);
}

beforeEach(() => {
  dispatched.mockReset();
  toasted.mockReset();
});
afterEach(() => vi.restoreAllMocks());

describe('s494-phone-till-gate (1): no browser sale, band, wallet or print on the phone path', () => {
  it('the phone handler calls nothing imported from the in-memory store', () => {
    const file = src('components/mobile/MobileTill.tsx');
    const block = /import\s*\{([^}]*)\}\s*from\s*'@\/mockApi'/.exec(file);
    expect(block).not.toBeNull();
    const names = block![1]!
      .split(',')
      .map((n) => n.replace(/\btype\b/, '').trim())
      .filter(Boolean);
    expect(names.length).toBeGreaterThan(5);
    const handler = handlerOf(file);
    for (const n of names) expect(handler, n).not.toMatch(new RegExp(`\\b${n}\\b`));
    for (const local of ['buildSale', 'dispatchPrintJobs', 'ticketPrintJobs', 'bookingsApi', 'toast(']) {
      expect(handler, local).not.toContain(local);
    }
  });

  it('the shared helper imports nothing from the in-memory store', () => {
    const helper = src('lib/bookingRedemption.ts');
    expect(helper).not.toMatch(/mockApi/);
    expect(helper).not.toMatch(/recordSale|issueBookingBands|ensureSaleGrantWallet|dispatchPrintJobs|ticketPrintJobs/);
  });

  it('the phone clears its key when the dialog closes, as the counter does', () => {
    const file = src('components/mobile/MobileTill.tsx');
    expect(file).toMatch(/setShowRedeemModal\(next\);\s*if \(!next\) redeemKeyRef\.current = null;/);
  });

  it('one press is one platform call', async () => {
    const redeem = vi.spyOn(bookingsApi, 'redeem').mockResolvedValue(answer());
    await viaHelper({ current: null }, { stationId: STATION }, 'OTO-GATE-0494');
    expect(redeem).toHaveBeenCalledTimes(1);
  });
});

describe('s494-phone-till-gate (2): the platform’s bands and print failure are what is shown', () => {
  it('the band count is the platform’s minted bands, and the box lane shows its real codes', async () => {
    vi.spyOn(bookingsApi, 'redeem').mockResolvedValue(answer({ printing: null, box: { notes: [] } }));
    const out = await viaHelper({ current: null }, {}, 'OTO-GATE-0494');
    expect(toasted).toHaveBeenCalledWith({ title: 'Booking redeemed offline', description: 'OTO-GATE-0494 — 3 wristband(s) issued.' });
    expect(out).toEqual({ ok: true, issued: { receiptNumber: 'T1-000777', bands: BANDS, notes: [] } });
  });

  it('a print failure with no notes still reaches the printing announcement', async () => {
    vi.spyOn(bookingsApi, 'redeem').mockResolvedValue(
      answer({ printing: { jobs: [], notes: [], failed: { code: 'PRINT_QUEUE_FAILED', message: 'Queue down.' } } } as Partial<BookingRedeemResult>),
    );
    await viaHelper({ current: null }, {}, 'OTO-GATE-0494');
    expect(dispatched).toHaveBeenCalledWith([], ['Queue down.']);
  });

  it('a deployment answering the claim alone announces no paper and no bands', async () => {
    vi.spyOn(bookingsApi, 'redeem').mockResolvedValue(answer({ printing: null, bands: undefined } as Partial<BookingRedeemResult>));
    const out = await viaHelper({ current: null }, {}, 'OTO-GATE-0494');
    expect(dispatched).not.toHaveBeenCalled();
    expect(toasted).toHaveBeenCalledWith({ title: 'Booking redeemed', description: 'OTO-GATE-0494 — 0 wristband(s) issued.' });
    expect(out).toEqual({ ok: true });
  });
});

describe('s494-phone-till-gate (3): the counter till’s handling is unchanged', () => {
  const scenarios: Array<[string, () => Promise<BookingRedeemResult>]> = [
    ['online with failure', async () => answer({ printing: { jobs: [job({ id: 'a' }), job({ id: 'b', reprintOf: 'a' })], notes: ['n1'], failed: { code: 'X', message: 'f' } } } as Partial<BookingRedeemResult>)],
    ['box lane', async () => answer({ printing: null, box: { notes: ['n2', 'n3'] } })],
    ['claim only', async () => answer({ printing: null, bands: undefined, sale: undefined } as Partial<BookingRedeemResult>)],
    ['lost answer', async () => { throw new NetworkError(); }],
    ['refusal', async () => { throw new ApiError(422, 'BOOKING_NOT_PAID', 'not paid'); }],
    ['missing route', async () => { throw new ApiError(404, 'UNKNOWN', 'Not Found'); }],
    ['conflict', async () => {
      throw new ApiError(409, 'BOOKING_ALREADY_REDEEMED', 'x', {
        redemption: { at: '2026-10-01T03:05:00.000Z', branchName: 'HKT Central', stationName: 'Till 1', staffName: 'Nok', bandCodes: ['T1-REAL01'] },
      });
    }],
    ['other error', async () => { throw new Error('boom'); }],
  ];

  for (const [name, reply] of scenarios) {
    it(`same outcome, calls, toasts and key as before: ${name}`, async () => {
      const body = { stationId: STATION, visitId: 'visit-1' };
      const run = async (fn: typeof viaHelper) => {
        dispatched.mockReset();
        toasted.mockReset();
        vi.restoreAllMocks();
        let n = 0;
        vi.spyOn(bookingsApi, 'newRedeemKey').mockImplementation(() => `key-${++n}`);
        const redeem = vi.spyOn(bookingsApi, 'redeem').mockImplementation(reply);
        const keys: RedeemKeyHolder = { current: { bookingId: 'other', key: 'stale' } };
        const outcome = await fn(keys, body, 'OTO-GATE-0494');
        return {
          outcome,
          calls: redeem.mock.calls,
          dispatched: dispatched.mock.calls,
          toasts: toasted.mock.calls,
          key: keys.current,
        };
      };
      const before = await run(originalDesktop);
      const after = await run(viaHelper);
      expect(after).toEqual(before);
    });
  }

  it('the counter still passes its confirmed visit and station, and clears the key on close', () => {
    const file = src('pages/Till.tsx');
    const handler = handlerOf(file);
    expect(handler).toMatch(/\.\.\.\(visitId \? \{ visitId \} : \{\}\)/);
    expect(handler).toMatch(/redeemKeyRef,/);
    expect(file).toMatch(/redeemKeyRef\.current = null;/);
  });
});
