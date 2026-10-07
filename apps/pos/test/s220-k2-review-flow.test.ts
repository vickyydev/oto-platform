import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  KIOSK_DESK_STATES,
  KIOSK_REASONS,
  KioskDeskAnswerSchema,
  KioskRedeemAnswerSchema,
  type KioskRedeemAnswer,
} from '@oto/shared';
import { renderHook, type RenderedHook } from './support/hooks';
import { KioskError, kioskApi, type KioskApi } from '@/api/kiosk';
import { kioskScreenOf, useKioskFlow, type KioskFlow, type KioskScreenKind } from '@/lib/kiosk';

/**
 * S2-20 K2 (SCRUM-217) — FOCUSED REVIEW OF THE KIOSK SURFACE, the screen's
 * flow (`lib/kiosk.ts`), driven on the hooks harness with fake timers.
 *
 *   1. every failure ending reaches its own screen and always finds its way
 *      back to attract — by Done, and by 60 quiet seconds — and none of them
 *      is ever reported as walked away from;
 *   2. Q9: a scan mid-flow resets the clock, a touch on a result keeps it,
 *      the next guest is a new session, and a session the platform never
 *      held is never abandoned;
 *   3. privacy: an answer carrying a field outside the kiosk's contract is
 *      never parsed into the screen, through the kiosk's real client.
 */
vi.mock('react', () => import('./support/hooks'));

const STATION = '01a22222-0000-7000-8000-00000000000a';
const BEARER = 'c'.repeat(64);

let counter = 0;
const mintId = () => {
  counter += 1;
  return `01a22222-0000-7000-8000-${String(counter).padStart(12, '0')}`;
};

function answer(overrides: Partial<KioskRedeemAnswer> = {}): KioskRedeemAnswer {
  return KioskRedeemAnswerSchema.parse({
    sessionId: '01a22222-0000-7000-8000-0000000000ff',
    outcome: 'issued',
    reason: null,
    replay: false,
    booking: { reference: 'OTO-REVW-0001', kids: 1, adults: 1 },
    bands: [
      { kind: 'kid', shortCode: 'K1-AAAA' },
      { kind: 'adult', shortCode: 'K1-BBBB' },
    ],
    walletCreditSatang: 20_000,
    desk: { required: false, supervisedChildren: 0 },
    alreadyRedeemed: null,
    ...overrides,
  });
}

const failed = (reason: string, extra: Partial<KioskRedeemAnswer> = {}) =>
  answer({ outcome: 'failed', reason, bands: [], walletCreditSatang: 0, desk: { required: true, supervisedChildren: 0 }, ...extra });

/** Every ending the API review drove against the virtual kiosk box, with the screen each must reach. */
const ENDINGS: Array<{ what: string; answer: KioskRedeemAnswer; screen: KioskScreenKind }> = [
  { what: 'printer offline', answer: failed('PRINTER_UNREACHABLE'), screen: 'printer' },
  { what: 'paper out', answer: failed('PRINTER_PAPER_OUT'), screen: 'printer' },
  { what: 'box offline', answer: failed(KIOSK_REASONS.boxOffline), screen: 'offline' },
  {
    what: 'already redeemed',
    answer: failed('BOOKING_ALREADY_REDEEMED', {
      alreadyRedeemed: { at: '2026-10-07T03:00:00.000Z', branchName: 'Central', stationName: 'Kiosk 1' },
    }),
    screen: 'already',
  },
  { what: 'not paid', answer: failed('BOOKING_NOT_REDEEMABLE'), screen: 'not_paid' },
  { what: 'not a booking', answer: failed(KIOSK_REASONS.notABookingQr, { booking: null }), screen: 'unrecognised' },
  { what: 'not signed here', answer: failed('BOOKING_QR_SIGNATURE_INVALID', { booking: null }), screen: 'unrecognised' },
  { what: 'another park', answer: failed(KIOSK_REASONS.otherBranch), screen: 'other_branch' },
  { what: 'interrupted', answer: failed(KIOSK_REASONS.interrupted), screen: 'desk' },
  { what: 'internal', answer: failed(KIOSK_REASONS.internal), screen: 'desk' },
  {
    what: 'drop-off only',
    answer: answer({
      outcome: 'handed_off',
      reason: KIOSK_REASONS.supervised,
      bands: [],
      walletCreditSatang: 0,
      desk: { required: true, supervisedChildren: 1 },
    }),
    screen: 'desk_supervised',
  },
  {
    what: 'mixed',
    answer: answer({ outcome: 'handed_off', reason: KIOSK_REASONS.supervisedRest, desk: { required: true, supervisedChildren: 1 } }),
    screen: 'done_desk',
  },
  { what: 'issued', answer: answer(), screen: 'done' },
];

function stubApi(redeem: KioskApi['redeem'], start?: KioskApi['startSession']) {
  const calls = { startSession: [] as unknown[][], abandon: [] as unknown[][], redeem: [] as unknown[][] };
  const api: KioskApi = {
    pairingStatus: vi.fn(),
    startPairing: vi.fn(),
    expirePairing: vi.fn(),
    state: vi.fn(),
    startSession: async (...args) => {
      calls.startSession.push(args);
      if (start) return start(...args);
      return { sessionId: args[2], startedAt: new Date().toISOString(), endedAt: null, outcome: null };
    },
    abandon: async (...args) => {
      calls.abandon.push(args);
      return {
        sessionId: args[2],
        startedAt: new Date().toISOString(),
        endedAt: new Date().toISOString(),
        outcome: 'abandoned' as const,
        abandoned: true,
      };
    },
    redeem: async (...args) => {
      calls.redeem.push(args);
      return redeem(...args);
    },
  };
  return { api, calls };
}

const flush = () => vi.advanceTimersByTimeAsync(0);

describe('the kiosk flow under review', () => {
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
  const stageOf = () => hook!.result.current.stage;
  const screenOf = () => {
    const s = stageOf();
    return s.kind === 'result' ? s.screen.kind : null;
  };

  // --- 1 -----------------------------------------------------------------------

  it('every ending has its own screen, and the reasons a guest is shown are never the same screen by accident', () => {
    for (const e of ENDINGS) expect(kioskScreenOf(e.answer).kind, e.what).toBe(e.screen);
    expect(kioskScreenOf(failed('PRINTER_PAPER_OUT')).paperOut).toBe(true);
    expect(kioskScreenOf(failed('PRINTER_UNREACHABLE')).paperOut).toBe(false);
  });

  for (const e of ENDINGS) {
    it(`${e.what}: Done returns to attract, and so do 60 quiet seconds; nothing is reported abandoned`, async () => {
      const { api, calls } = stubApi(async () => e.answer);
      mount(api);
      hook!.result.current.begin();
      hook!.result.current.scanned('BK1:REVIEW');
      await flush();
      expect(screenOf()).toBe(e.screen);
      hook!.result.current.finish();
      expect(stageOf().kind).toBe('attract');

      // The next guest, left on the same ending with nobody touching it.
      hook!.result.current.scanned('BK1:REVIEW-2');
      await flush();
      expect(screenOf()).toBe(e.screen);
      await vi.advanceTimersByTimeAsync(59_000);
      expect(stageOf().kind).toBe('result');
      await vi.advanceTimersByTimeAsync(1_000);
      expect(stageOf().kind).toBe('attract');
      await flush();
      // A result's session was ended by its press: walking away from it is never written down.
      expect(calls.abandon).toEqual([]);
      // Two guests, two sessions, each press on its own.
      expect(new Set(calls.startSession.map((c) => c[2])).size).toBe(2);
      expect(new Set(calls.redeem.map((c) => (c[2] as { actionId: string }).actionId)).size).toBe(2);
    });
  }

  // --- 2 -----------------------------------------------------------------------

  it('a scan 50 seconds in resets the clock: the result gets its own full minute', async () => {
    const { api, calls } = stubApi(async () => failed('PRINTER_UNREACHABLE'));
    mount(api);
    hook!.result.current.begin();
    await vi.advanceTimersByTimeAsync(50_000);
    hook!.result.current.scanned('BK1:LATE');
    await flush();
    expect(screenOf()).toBe('printer');
    await vi.advanceTimersByTimeAsync(59_000);
    expect(stageOf().kind).toBe('result');
    // A touch on the result at 59 s keeps it up another minute.
    hook!.result.current.activity();
    await vi.advanceTimersByTimeAsync(59_000);
    expect(stageOf().kind).toBe('result');
    await vi.advanceTimersByTimeAsync(1_000);
    expect(stageOf().kind).toBe('attract');
    await flush();
    expect(calls.abandon).toEqual([]);
  });

  it('a slow press from the scan step is never timed out, and its session is never abandoned behind it', async () => {
    let release: (a: KioskRedeemAnswer) => void = () => undefined;
    const { api, calls } = stubApi(() => new Promise<KioskRedeemAnswer>((resolve) => (release = resolve)));
    mount(api);
    hook!.result.current.begin();
    await vi.advanceTimersByTimeAsync(58_000);
    hook!.result.current.scanned('BK1:SLOW');
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(stageOf().kind).toBe('working');
    // Start over is not offered mid-print, and does nothing if pressed.
    hook!.result.current.startOver();
    expect(stageOf().kind).toBe('working');
    release(answer());
    await flush();
    expect(screenOf()).toBe('done');
    expect(calls.abandon).toEqual([]);
  });

  it('after the timeout the next guest is a new session, and the walked-away one is reported once', async () => {
    const { api, calls } = stubApi(async () => answer());
    mount(api);
    hook!.result.current.begin();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(stageOf().kind).toBe('attract');
    await flush();
    expect(calls.abandon).toEqual([[BEARER, STATION, calls.startSession[0]![2], 'idle']]);
    // Sitting on attract writes nothing more.
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(calls.abandon).toHaveLength(1);
    hook!.result.current.begin();
    expect(calls.startSession).toHaveLength(2);
    expect(calls.startSession[1]![2]).not.toBe(calls.startSession[0]![2]);
    hook!.result.current.scanned('BK1:NEXT');
    await flush();
    expect((calls.redeem[0]![2] as { sessionId?: string }).sessionId).toBe(calls.startSession[1]![2]);
  });

  it('a session the platform never held is never abandoned, and the press goes without it', async () => {
    const { api, calls } = stubApi(
      async () => answer(),
      async () => {
        throw new KioskError(0, 'KIOSK_UNREACHABLE', 'no answer');
      },
    );
    mount(api);
    hook!.result.current.begin();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(stageOf().kind).toBe('attract');
    await flush();
    expect(calls.abandon).toEqual([]);
    hook!.result.current.begin();
    hook!.result.current.scanned('BK1:NO-SESSION');
    await flush();
    expect(calls.redeem[0]![2]).not.toHaveProperty('sessionId');
    expect(screenOf()).toBe('done');
  });

  // --- 3 -----------------------------------------------------------------------

  it("an answer carrying a field outside the kiosk's contract is never drawn: the real client refuses it", async () => {
    const leaky = { ...answer(), allergies: 'Peanuts', guardianPhone: '+66812345678' };
    const fetchStub = vi.fn(async () => new Response(JSON.stringify(leaky), { status: 200, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchStub);
    await expect(kioskApi.redeem(BEARER, STATION, { actionId: mintId(), qr: 'BK1:LEAK' })).rejects.toMatchObject({
      code: 'KIOSK_ANSWER_UNREADABLE',
    });

    // Through the flow: retried (it may be a garbled answer), then the guest is sent to the desk with nothing drawn.
    mount({ ...kioskApi, startSession: async (_b, _s, id) => ({ sessionId: id, startedAt: '', endedAt: null, outcome: null }) });
    hook!.result.current.scanned('BK1:LEAK');
    await vi.advanceTimersByTimeAsync(20_000);
    const s = stageOf();
    expect(s.kind).toBe('result');
    expect(s.kind === 'result' && s.screen).toEqual({ kind: 'offline', answer: null, paperOut: false });
    expect(JSON.stringify(s)).not.toContain('Peanuts');
  });

  it("the desk's list refuses a family entry carrying a child's name or an allergy", () => {
    const entry = {
      sessionId: '01a22222-0000-7000-8000-000000000101',
      stationId: STATION,
      stationName: 'Kiosk 1',
      endedAt: '2026-10-07T03:00:00.000Z',
      outcome: 'handed_off',
      reason: KIOSK_REASONS.supervised,
      booking: { id: '01a22222-0000-7000-8000-000000000102', reference: 'OTO-REVW-0002', kids: 1, adults: 0, status: 'paid' },
      supervisedChildren: 1,
      bandsIssued: 0,
      state: KIOSK_DESK_STATES[0],
    };
    expect(() => KioskDeskAnswerSchema.parse({ businessDate: '2026-10-07', entries: [entry] })).not.toThrow();
    for (const extra of [{ childName: 'Ploy' }, { allergies: 'Peanuts' }, { phone: '+66812345678' }]) {
      expect(() => KioskDeskAnswerSchema.parse({ businessDate: '2026-10-07', entries: [{ ...entry, ...extra }] })).toThrow();
      expect(() =>
        KioskDeskAnswerSchema.parse({
          businessDate: '2026-10-07',
          entries: [{ ...entry, booking: { ...entry.booking, ...extra } }],
        }),
      ).toThrow();
    }
  });
});
