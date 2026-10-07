import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  KIOSK_IDLE_TIMEOUT_MS,
  KIOSK_PRIVATE_FIELD,
  KIOSK_REASONS,
  KioskRedeemAnswerSchema,
  type KioskRedeemAnswer,
} from '@oto/shared';
import { renderHook, type RenderedHook } from './support/hooks';
import { KioskError, type KioskApi } from '@/api/kiosk';
import {
  calledOffBandsOf,
  deskReasonOf,
  kioskScreenOf,
  useKioskFlow,
  useKioskPairing,
  type KioskFlow,
  type KioskPairing,
} from '@/lib/kiosk';

/**
 * S2-20 K2 (SCRUM-217) — THE SELF-SERVICE KIOSK'S SCREEN, driven without a
 * browser: `lib/kiosk.ts` is the whole of the flow the `/kiosk` page draws.
 *
 * QA steps 5 and 6 from the kiosk's side: each ending K1 answers becomes its
 * own guest-readable screen (bands and credit, already redeemed, the staff
 * desk for a drop-off booking and for the rest of a mixed one, and the abort
 * on a printer offline, paper out or box offline). Q9: 60 seconds of no touch
 * or scan returns to attract, abandoning a session that scanned nothing and
 * never timing out a press in flight. And the pairing a kiosk does the way a
 * display does.
 *
 * The API is a stub with the kiosk's exact calls; the hooks run on the
 * harness in place of React (support/hooks.ts), on fake timers.
 */
vi.mock('react', () => import('./support/hooks'));

const STATION = '01a11111-0000-7000-8000-00000000000a';
const BEARER = 'a'.repeat(64);

let counter = 0;
const mintId = () => {
  counter += 1;
  return `01a11111-0000-7000-8000-${String(counter).padStart(12, '0')}`;
};

function answer(overrides: Partial<KioskRedeemAnswer> = {}): KioskRedeemAnswer {
  return KioskRedeemAnswerSchema.parse({
    sessionId: '01a11111-0000-7000-8000-0000000000ff',
    outcome: 'issued',
    reason: null,
    replay: false,
    booking: { reference: 'OTO-ABCD-1234', kids: 2, adults: 1 },
    bands: [
      { kind: 'kid', shortCode: 'K1-AAAA' },
      { kind: 'kid', shortCode: 'K1-BBBB' },
      { kind: 'adult', shortCode: 'K1-CCCC' },
    ],
    walletCreditSatang: 50_000,
    desk: { required: false, supervisedChildren: 0 },
    alreadyRedeemed: null,
    ...overrides,
  });
}

const failed = (reason: string, extra: Partial<KioskRedeemAnswer> = {}) =>
  answer({ outcome: 'failed', reason, bands: [], walletCreditSatang: 0, desk: { required: true, supervisedChildren: 0 }, ...extra });

function stubApi(redeem: KioskApi['redeem']): KioskApi & { calls: Record<string, unknown[][]> } {
  const calls: Record<string, unknown[][]> = { startSession: [], abandon: [], redeem: [] };
  return {
    calls,
    pairingStatus: vi.fn(),
    startPairing: vi.fn(),
    expirePairing: vi.fn(),
    state: vi.fn(),
    startSession: vi.fn(async (...args: unknown[]) => {
      calls.startSession!.push(args);
      return { sessionId: args[2] as string, startedAt: new Date().toISOString(), endedAt: null, outcome: null };
    }),
    abandon: vi.fn(async (...args: unknown[]) => {
      calls.abandon!.push(args);
      return {
        sessionId: args[2] as string,
        startedAt: new Date().toISOString(),
        endedAt: new Date().toISOString(),
        outcome: 'abandoned' as const,
        abandoned: true,
      };
    }),
    redeem: vi.fn(async (...args: Parameters<KioskApi['redeem']>) => {
      calls.redeem!.push(args);
      return redeem(...args);
    }),
  } as unknown as KioskApi & { calls: Record<string, unknown[][]> };
}

const flush = () => vi.advanceTimersByTimeAsync(0);

describe('one guest-readable screen per ending (QA steps 5 and 6, from the kiosk)', () => {
  it('maps every ending K1 answers to its own screen', () => {
    expect(kioskScreenOf(answer()).kind).toBe('done');
    expect(
      kioskScreenOf(
        answer({ outcome: 'handed_off', reason: KIOSK_REASONS.supervisedRest, desk: { required: true, supervisedChildren: 1 } }),
      ).kind,
    ).toBe('done_desk');
    expect(
      kioskScreenOf(
        answer({
          outcome: 'handed_off',
          reason: KIOSK_REASONS.supervised,
          bands: [],
          walletCreditSatang: 0,
          desk: { required: true, supervisedChildren: 1 },
        }),
      ).kind,
    ).toBe('desk_supervised');
    expect(
      kioskScreenOf(failed('BOOKING_ALREADY_REDEEMED', { alreadyRedeemed: { at: '2026-10-07T03:00:00Z', branchName: 'HKT', stationName: 'Kiosk 1' } })).kind,
    ).toBe('already');
    expect(kioskScreenOf(failed('BOOKING_NOT_REDEEMABLE')).kind).toBe('not_paid');
    expect(kioskScreenOf(failed(KIOSK_REASONS.boxOffline)).kind).toBe('offline');
    expect(kioskScreenOf(failed('PRINTER_UNREACHABLE'))).toMatchObject({ kind: 'printer', paperOut: false });
    expect(kioskScreenOf(failed('PRINTER_PAPER_OUT'))).toMatchObject({ kind: 'printer', paperOut: true });
    expect(kioskScreenOf(failed('PRINTER_COVER_OPEN')).kind).toBe('printer');
    expect(kioskScreenOf(failed(KIOSK_REASONS.noBandPrinter)).kind).toBe('printer');
    expect(kioskScreenOf(failed(KIOSK_REASONS.notABookingQr, { booking: null })).kind).toBe('unrecognised');
    expect(kioskScreenOf(failed('BOOKING_QR_SIGNATURE_INVALID', { booking: null })).kind).toBe('unrecognised');
    expect(kioskScreenOf(failed(KIOSK_REASONS.otherBranch)).kind).toBe('other_branch');
    expect(kioskScreenOf(failed(KIOSK_REASONS.internal)).kind).toBe('desk');
    expect(kioskScreenOf(failed(KIOSK_REASONS.interrupted)).kind).toBe('desk');
  });

  it('gives each screen nothing but the strict answer — no private field can be drawn', () => {
    const keys = (value: unknown, into: string[] = []): string[] => {
      if (Array.isArray(value)) value.forEach((v) => keys(v, into));
      else if (value && typeof value === 'object') {
        for (const [k, v] of Object.entries(value)) {
          into.push(k);
          keys(v, into);
        }
      }
      return into;
    };
    const screen = kioskScreenOf(answer());
    expect(keys(screen).filter((k) => KIOSK_PRIVATE_FIELD.test(k))).toEqual([]);
  });

  it('tells the desk, in its own words, why the kiosk sent the family over', () => {
    const base = { outcome: 'failed' as const, supervisedChildren: 0, bandsIssued: 0 };
    expect(deskReasonOf({ ...base, reason: 'PRINTER_UNREACHABLE' })).toMatch(/printer was offline/);
    expect(deskReasonOf({ ...base, reason: 'PRINTER_PAPER_OUT' })).toMatch(/out of paper/);
    expect(deskReasonOf({ ...base, reason: KIOSK_REASONS.boxOffline })).toMatch(/box was offline/);
    expect(deskReasonOf({ ...base, reason: 'BOOKING_NOT_REDEEMABLE' })).toMatch(/Not paid/);
    expect(
      deskReasonOf({ outcome: 'handed_off', reason: KIOSK_REASONS.supervised, supervisedChildren: 2, bandsIssued: 0 }),
    ).toMatch(/2 supervised children\): nothing was issued/);
    expect(
      deskReasonOf({ outcome: 'handed_off', reason: KIOSK_REASONS.supervisedRest, supervisedChildren: 1, bandsIssued: 2 }),
    ).toMatch(/1 supervised child to check in here/);
  });

  it('SCRUM-504: tells the desk when wristbands came out of a set the kiosk called off, and to take them back', () => {
    const base = { outcome: 'failed' as const, supervisedChildren: 0, bandsIssued: 0 };
    const two = deskReasonOf({ ...base, reason: 'PRINTER_UNREACHABLE', calledOffBands: 2 });
    expect(two).toMatch(/printer was offline: nothing was issued/);
    expect(two).toMatch(/2 wristbands may have come out at the kiosk/);
    expect(two).toMatch(/take them back from the family; they open nothing at the gate/);
    expect(deskReasonOf({ ...base, reason: KIOSK_REASONS.printTimeout, calledOffBands: 1 })).toMatch(
      /took too long: nothing was issued\. 1 wristband may have come out at the kiosk — take it back from the family; it opens nothing at the gate/,
    );
    expect(deskReasonOf({ ...base, reason: KIOSK_REASONS.printHoldLost, calledOffBands: 1 })).toMatch(/lost its connection/);
    // None out: the line is as it was.
    expect(deskReasonOf({ ...base, reason: 'PRINTER_UNREACHABLE', calledOffBands: 0 })).toBe(
      'The kiosk printer was offline: nothing was issued.',
    );
    // The guest's screen reads the same count off the answer, on a failed ending only.
    expect(calledOffBandsOf(failed('PRINTER_UNREACHABLE', { calledOffBands: 2 }))).toBe(2);
    expect(calledOffBandsOf(failed('PRINTER_UNREACHABLE'))).toBe(0);
    expect(calledOffBandsOf(answer({ calledOffBands: 3 }))).toBe(0);
    expect(kioskScreenOf(failed(KIOSK_REASONS.printTimeout)).kind).toBe('printer');
    expect(kioskScreenOf(failed(KIOSK_REASONS.printHoldLost)).kind).toBe('printer');
  });
});

describe('the kiosk flow', () => {
  let hook: RenderedHook<void, KioskFlow> | undefined;
  const onUnpaired = vi.fn();

  beforeEach(() => {
    vi.useFakeTimers();
    counter = 0;
    onUnpaired.mockReset();
  });
  afterEach(() => {
    hook?.unmount();
    hook = undefined;
    vi.useRealTimers();
  });

  const mount = (api: KioskApi) => {
    hook = renderHook(() => useKioskFlow({ api, bearer: BEARER, stationId: STATION, onUnpaired, mintId }));
    return hook;
  };

  it('a touch opens the guest’s session; the scan takes it over and prints the bands', async () => {
    const api = stubApi(async () => answer());
    const flow = mount(api);
    expect(flow.result.current.stage.kind).toBe('attract');

    flow.result.current.begin();
    expect(flow.result.current.stage.kind).toBe('scan');
    expect(api.calls.startSession).toEqual([[BEARER, STATION, '01a11111-0000-7000-8000-000000000001']]);

    flow.result.current.scanned('BK1:SOMETHING');
    expect(flow.result.current.stage.kind).toBe('working');
    await flush();
    expect(api.calls.redeem).toHaveLength(1);
    expect(api.calls.redeem![0]![2]).toEqual({
      actionId: '01a11111-0000-7000-8000-000000000002',
      qr: 'BK1:SOMETHING',
      sessionId: '01a11111-0000-7000-8000-000000000001',
    });
    const stage = flow.result.current.stage;
    expect(stage.kind).toBe('result');
    expect(stage.kind === 'result' && stage.screen.kind).toBe('done');
  });

  it('a scan straight from the attract screen is a new guest: session first, then the press', async () => {
    const api = stubApi(async () => answer());
    const flow = mount(api);
    flow.result.current.scanned('BK1:STRAIGHT');
    await flush();
    expect(api.calls.startSession).toHaveLength(1);
    const press = api.calls.redeem![0]![2] as { sessionId: string };
    expect(press.sessionId).toBe(api.calls.startSession![0]![2]);
    expect(flow.result.current.stage.kind).toBe('result');
  });

  it('Q9 — 60 seconds of no touch or scan abandons the session and returns to attract', async () => {
    const api = stubApi(async () => answer());
    const flow = mount(api);
    expect(KIOSK_IDLE_TIMEOUT_MS).toBe(60_000);
    flow.result.current.begin();
    await vi.advanceTimersByTimeAsync(59_000);
    expect(flow.result.current.stage.kind).toBe('scan');
    // A touch at 59 s: the clock starts again.
    flow.result.current.activity();
    await vi.advanceTimersByTimeAsync(59_000);
    expect(flow.result.current.stage.kind).toBe('scan');
    expect(api.calls.abandon).toEqual([]);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(flow.result.current.stage.kind).toBe('attract');
    await flush();
    expect(api.calls.abandon).toEqual([[BEARER, STATION, '01a11111-0000-7000-8000-000000000001', 'idle']]);
  });

  it('a press in flight is never timed out: the guest is watching the printer', async () => {
    let release: (a: KioskRedeemAnswer) => void = () => undefined;
    const api = stubApi(() => new Promise<KioskRedeemAnswer>((resolve) => (release = resolve)));
    const flow = mount(api);
    flow.result.current.begin();
    flow.result.current.scanned('BK1:SLOW');
    await vi.advanceTimersByTimeAsync(180_000);
    expect(flow.result.current.stage.kind).toBe('working');
    expect(api.calls.abandon).toEqual([]);
    release(answer());
    await flush();
    expect(flow.result.current.stage.kind).toBe('result');
  });

  it('a result screen goes back to attract after 60 seconds, abandoning nothing — the press ended it', async () => {
    const api = stubApi(async () => failed('PRINTER_UNREACHABLE'));
    const flow = mount(api);
    flow.result.current.begin();
    flow.result.current.scanned('BK1:FAULT');
    await flush();
    const stage = flow.result.current.stage;
    expect(stage.kind === 'result' && stage.screen.kind).toBe('printer');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(flow.result.current.stage.kind).toBe('attract');
    expect(api.calls.abandon).toEqual([]);
  });

  it('"Start over" before a scan abandons the session as cancelled', async () => {
    const api = stubApi(async () => answer());
    const flow = mount(api);
    flow.result.current.begin();
    flow.result.current.startOver();
    expect(flow.result.current.stage.kind).toBe('attract');
    await flush();
    expect(api.calls.abandon![0]![3]).toBe('cancelled');
  });

  it('a lost answer is asked again under the same action id, and issues once', async () => {
    let attempts = 0;
    const api = stubApi(async () => {
      attempts += 1;
      if (attempts === 1) throw new KioskError(0, 'KIOSK_UNREACHABLE', 'no answer');
      if (attempts === 2) throw new KioskError(409, KIOSK_REASONS.inProgress, 'still printing');
      return answer({ replay: true });
    });
    const flow = mount(api);
    flow.result.current.begin();
    flow.result.current.scanned('BK1:FLAKY');
    await flush();
    expect(flow.result.current.stage.kind).toBe('working');
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(api.calls.redeem).toHaveLength(3);
    const ids = new Set(api.calls.redeem!.map((c) => (c[2] as { actionId: string }).actionId));
    expect(ids.size).toBe(1);
    const stage = flow.result.current.stage;
    expect(stage.kind === 'result' && stage.screen.kind).toBe('done');
  });

  it('a kiosk that never reaches the park says so, after its retries', async () => {
    const api = stubApi(async () => {
      throw new KioskError(0, 'KIOSK_UNREACHABLE', 'no answer');
    });
    const flow = mount(api);
    flow.result.current.scanned('BK1:NOWHERE');
    await vi.advanceTimersByTimeAsync(20_000);
    const stage = flow.result.current.stage;
    expect(stage.kind === 'result' && stage.screen.kind).toBe('offline');
  });

  it('a kiosk whose credential was revoked goes back to pairing', async () => {
    const api = stubApi(async () => {
      throw new KioskError(401, 'KIOSK_UNPAIRED', 'not paired');
    });
    const flow = mount(api);
    flow.result.current.scanned('BK1:REVOKED');
    await flush();
    expect(onUnpaired).toHaveBeenCalled();
  });

  it('"Scan again" after an unreadable code is a new session, straight to the scan step', async () => {
    const api = stubApi(async () => failed(KIOSK_REASONS.notABookingQr, { booking: null }));
    const flow = mount(api);
    flow.result.current.scanned('NOT-A-BOOKING');
    await flush();
    flow.result.current.tryAgain();
    expect(flow.result.current.stage.kind).toBe('scan');
    expect(api.calls.startSession).toHaveLength(2);
  });

  it('ignores a scan while a press is printing', async () => {
    let release: (a: KioskRedeemAnswer) => void = () => undefined;
    const api = stubApi(() => new Promise<KioskRedeemAnswer>((resolve) => (release = resolve)));
    const flow = mount(api);
    flow.result.current.scanned('BK1:ONE');
    await flush();
    flow.result.current.scanned('BK1:TWO');
    await flush();
    expect(api.calls.redeem).toHaveLength(1);
    release(answer());
    await flush();
  });
});

describe('pairing a kiosk, as a display pairs', () => {
  let hook: RenderedHook<void, KioskPairing> | undefined;
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    hook?.unmount();
    hook = undefined;
    vi.useRealTimers();
  });

  it('shows a K code until a manager claims it, then hands over to the flow', async () => {
    let claimed = false;
    const api = {
      pairingStatus: vi.fn(async () =>
        claimed ? { status: 'paired' as const, station: { id: STATION, name: 'Kiosk 1' } } : { status: 'pending' as const },
      ),
      startPairing: vi.fn(async () => ({ pairingCode: 'K482913', expiresAt: '2026-10-07T03:10:00.000Z' })),
      expirePairing: vi.fn(async () => ({ expired: true as const })),
    } as unknown as KioskApi;
    const remember = vi.fn(() => true);
    hook = renderHook(() => useKioskPairing({ api, initialBearer: BEARER, remember, pollMs: 2_000 }));
    await flush();
    expect(hook.result.current.view).toEqual({
      kind: 'code',
      pairingCode: 'K482913',
      expiresAt: '2026-10-07T03:10:00.000Z',
    });
    expect(remember).toHaveBeenCalledWith(BEARER);
    claimed = true;
    await vi.advanceTimersByTimeAsync(2_000);
    expect(hook.result.current.view).toEqual({ kind: 'paired', stationId: STATION, stationName: 'Kiosk 1' });
    expect(api.startPairing).toHaveBeenCalledTimes(1);
  });

  it('a secret some device already holds is replaced by a new one', async () => {
    const api = {
      pairingStatus: vi.fn(async () => ({ status: 'expired' as const })),
      startPairing: vi.fn(async (bearer: string) => {
        if (bearer === BEARER) throw new KioskError(409, 'KIOSK_ALREADY_PAIRED', 'already');
        return { pairingCode: 'K000111', expiresAt: '2026-10-07T03:10:00.000Z' };
      }),
      expirePairing: vi.fn(),
    } as unknown as KioskApi;
    hook = renderHook(() =>
      useKioskPairing({ api, initialBearer: BEARER, remember: () => true, newBearer: () => 'b'.repeat(64) }),
    );
    await flush();
    await flush();
    expect(hook.result.current.bearer).toBe('b'.repeat(64));
    expect(hook.result.current.view).toMatchObject({ kind: 'code', pairingCode: 'K000111' });
  });
});
