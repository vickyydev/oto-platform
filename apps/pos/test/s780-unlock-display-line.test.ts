import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from './support/hooks';

/**
 * SCRUM-780 — the Tickets screen said "Unlock this till on its box first"
 * right after the till was unlocked on its box.
 *
 * Nothing here stands in for the till's own code: the operator's unlock
 * (`OperatorContext`), the bridge client (`api/bridge`) and the display
 * publisher behind every till screen (`lib/displaySession`) are the real
 * ones. Only the counter's box is a fake, and it keeps the box's contract
 * (`packages/box-agent/src/runner/bridge-server.ts`, pinned there by
 * `test/display-channel.test.ts`): the presence read answers 401
 * BOX_SESSION_REQUIRED without the session an unlock issued, and 200 with it.
 */

const STATION = '018f0000-0000-7000-8000-000000000780';
const ORIGIN = 'https://counter.example.test';
const UNLOCK_LINE = 'Unlock this till on its box first';

const seam = vi.hoisted(() => {
  const browser = Object.assign(new EventTarget(), {
    location: { hash: '', pathname: '/', search: '' },
    setTimeout, clearTimeout, setInterval, clearInterval,
  });
  vi.stubGlobal('window', browser);
  // Stable setters, as the real hooks give: a new one each render would read the session again for ever.
  return { browser, setLang: vi.fn(), setTheme: vi.fn() };
});
vi.mock('react', async original => ({ ...await original<typeof import('react')>(), ...await import('./support/hooks') }));
vi.mock('@/mockApi', () => ({ getOperatorThemePref: () => null }));
vi.mock('@/lib/themePref', () => ({ staffThemeController: { adopt: vi.fn(), release: vi.fn() }, useCustomerTheme: () => ['light', seam.setTheme] }));
vi.mock('@/i18n/LanguageContext', () => ({ useLanguage: () => ({ setLang: seam.setLang }) }));
vi.mock('@/api/platform', () => ({ membersApi: {}, authApi: {
  me: async () => ({ account: { id: 'zz-test-person', phone: 'ZZ TEST', mustChangePassword: false }, employee: { name: 'ZZ TEST person' }, sessionLocked: false }),
  permissions: async () => ({ permissions: [] }), signIn: async () => ({}), lock: async () => ({}),
  // The platform is online and accepts the password: the unlock under test is the online one.
  unlock: async () => ({}),
} }));
vi.mock('@/auth/staffToken', () => ({ readStaffToken: () => ({ token: 'ZZ TEST shift token' }), staffTokenLive: () => true, forgetStaffToken: vi.fn() }));
vi.mock('@/lib/lane', () => ({ currentLane: () => 'platform', laneStation: () => STATION, isBoxLaneTrigger: () => false,
  noteLaneFailure: vi.fn(), platformNeedsUnlock: () => false, platformUnlocked: vi.fn(), refreshLane: async () => 'platform' }));
vi.mock('@/api/catalogBridge', () => ({ loadCatalogFromApi: async () => undefined, restorePreparedCatalog: () => false }));

import { OperatorProvider, type useOperator } from '@/auth/OperatorContext';
import { holdBoxSession, setBridgeOrigin } from '@/api/bridge';
import { useStationDisplay, useTicketDisplay, type TicketDisplayState } from '@/lib/displaySession';
import { useTenderDisplay } from '@/lib/tenderDisplay';

Object.assign(globalThis, { React });

/** The counter's box, as far as an unlock and a presence read go. */
interface BoxCall { rest: string; authorization: string | null; status: number | 'unreachable' | 'unanswered' }
const box = {
  session: null as string | null,
  issued: 0,
  /** How long the box takes to check the password (argon2 on a Pi is not instant). */
  unlockMs: 400,
  unlock: 'accepts' as 'accepts' | 'refuses' | 'never answers',
  /** The next presence reads that reach nothing at all. */
  unreachableReads: 0,
  calls: [] as BoxCall[],
};
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
const wait = (ms: number, signal?: AbortSignal | null) => new Promise<void>((resolve, reject) => {
  const timer = ms === Infinity ? undefined : setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => { clearTimeout(timer); reject(new DOMException('aborted', 'AbortError')); });
});
const boxFetch = vi.fn(async (url: string, init: RequestInit = {}): Promise<Response> => {
  const address = new URL(url);
  expect(address.origin).toBe(ORIGIN);
  const rest = address.pathname.replace(`/box/v1/station/${STATION}/`, '');
  const authorization = (init.headers as Record<string, string> | undefined)?.authorization ?? null;
  const call: BoxCall = { rest, authorization, status: 'unanswered' };
  box.calls.push(call);
  const answer = (status: number, body: unknown) => { call.status = status; return json(status, body); };
  if (rest === 'unlock') {
    await wait(box.unlock === 'never answers' ? Infinity : box.unlockMs, init.signal);
    if (box.unlock === 'refuses') return answer(401, { error: { code: 'STAFF_PASSWORD_WRONG', message: 'That password is not right' } });
    box.issued += 1;
    box.session = `bs_zz-test-${box.issued}`;
    return answer(200, { session: box.session, accountId: 'zz-test-person', method: 'offline_token', offlineFresh: false,
      expiresAt: '2026-11-12T00:00:00.000Z', cachedAt: null, cacheAgeSeconds: null, mustChangePassword: false, permissions: [] });
  }
  if (rest === 'lock') {
    if (authorization === `Bearer ${box.session}`) box.session = null;
    return answer(200, { ended: true });
  }
  if (rest === 'displays') {
    if (box.unreachableReads > 0) {
      box.unreachableReads -= 1;
      call.status = 'unreachable';
      throw new TypeError('Failed to fetch');
    }
    if (!box.session || authorization !== `Bearer ${box.session}`) {
      return answer(401, { error: { code: 'BOX_SESSION_REQUIRED', message: UNLOCK_LINE } });
    }
    // No display is paired to this till.
    return answer(200, { displays: [] });
  }
  return answer(404, { error: { code: 'NOT_FOUND', message: 'No such route' } });
});
const reads = () => box.calls.filter(call => call.rest === 'displays');

const ticket = (): TicketDisplayState => ({ stage: 'identify', step: 1, sessionKey: 'visitor', tier: 'tourist', phone: '',
  nickname: '', contactChannel: 'whatsapp', member: null, online: true });

type Operator = ReturnType<typeof useOperator>;
interface Screen { result: { current: { error: string | null; connected: unknown[] } }; rerender: (active: boolean) => void; unmount: () => void }
let unmounts: Array<() => void> = [];

/** A signed-in till on a counter box, as a reload leaves it: open, with no box session. */
async function till(): Promise<{ operator: () => Operator; tickets: Screen; show: (...screens: Screen[]) => void }> {
  const provider = renderHook(() => OperatorProvider({ children: null }));
  unmounts.push(provider.unmount);
  const operator = () => provider.result.current.props.value as Operator;
  await vi.advanceTimersByTimeAsync(0);
  expect(operator().operator?.id).toBe('zz-test-person');
  expect(operator().locked).toBe(false);
  // The Tickets screen: `Till.tsx` runs this publisher while the till is not locked.
  const tickets: Screen = renderHook((active: boolean) => useTicketDisplay(STATION, ticket(), vi.fn(), active), !operator().locked);
  unmounts.push(tickets.unmount);
  /** React renders the screens again when the lock changes; this harness is told to. */
  const show = (...screens: Screen[]) => { for (const screen of screens) screen.rerender(!operator().locked); };
  return { operator, tickets, show };
}

/** Every value the screen's line took while the clock moved on. */
async function lineOver(screen: Screen, ms: number): Promise<Array<string | null>> {
  const seen = new Set<string | null>([screen.result.current.error]);
  for (let elapsed = 0; elapsed < ms; elapsed += 25) {
    await vi.advanceTimersByTimeAsync(25);
    seen.add(screen.result.current.error);
  }
  return [...seen];
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('window', seam.browser);
  vi.stubGlobal('fetch', boxFetch);
  vi.stubEnv('VITE_BOX_BRIDGE_ZONE', 'example.test');
  Object.assign(box, { session: null, issued: 0, unlockMs: 400, unlock: 'accepts', unreachableReads: 0, calls: [] });
  // Choosing the station names its box and starts with no box session (`StationContext`).
  setBridgeOrigin(ORIGIN);
  holdBoxSession(null);
});
afterEach(() => {
  for (const unmount of unmounts.reverse()) unmount();
  unmounts = [];
  setBridgeOrigin(null);
  vi.clearAllMocks();
  vi.useRealTimers(); vi.unstubAllGlobals(); vi.unstubAllEnvs();
});

describe('SCRUM-780: the display line right after an unlock on the box', () => {
  it('HIGH: a till unlocked on its box a moment ago is never told to unlock on its box', async () => {
    const { operator, tickets, show } = await till();
    // Reloaded and not yet unlocked on the box: the line is the truth here.
    await vi.advanceTimersByTimeAsync(100);
    expect(tickets.result.current.error).toBe(UNLOCK_LINE);

    operator().lockNow();
    show(tickets);
    await vi.advanceTimersByTimeAsync(100);

    // The platform accepts the password and the till opens at once; the box is
    // asked beside it and is still checking the password when the screen is back.
    await operator().unlock('ZZ TEST synthetic input');
    expect(operator().locked).toBe(false);
    expect(box.calls.at(-1)).toMatchObject({ rest: 'unlock', status: 'unanswered' });
    const readsBefore = reads().length;
    show(tickets);

    expect(await lineOver(tickets, 6_000)).toEqual([null]);
    expect(tickets.result.current.connected).toEqual([]);
    // The box answered the unlock 200, and every read after it carried the session it issued.
    expect(box.calls.find(call => call.rest === 'unlock')).toMatchObject({ status: 200 });
    const after = reads().slice(readsBefore);
    expect(after.length).toBeGreaterThanOrEqual(3);
    expect(after.every(call => call.status === 200 && call.authorization === `Bearer ${box.session}`)).toBe(true);
  });

  it('HIGH: a read the box did not answer leaves no line once the next is answered with no display', async () => {
    const { operator, tickets, show } = await till();
    operator().lockNow();
    show(tickets);
    await operator().unlock('ZZ TEST synthetic input');
    show(tickets);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(tickets.result.current.error).toBeNull();

    box.unreachableReads = 1;
    await vi.advanceTimersByTimeAsync(1_500);
    expect(reads().at(-1)).toMatchObject({ status: 'unreachable' });
    expect(tickets.result.current.error).not.toBeNull();

    await vi.advanceTimersByTimeAsync(1_500);
    expect(reads().at(-1)).toMatchObject({ status: 200 });
    expect(tickets.result.current.error).toBeNull();
  });
});

describe('SCRUM-780: a till that is not unlocked on its box is still told so', () => {
  it('HIGH: no unlock at all — the line stays for as long as the box refuses', async () => {
    const { tickets } = await till();
    await vi.advanceTimersByTimeAsync(100);
    expect(await lineOver(tickets, 10_000)).toEqual([UNLOCK_LINE]);
    expect(reads().length).toBeGreaterThanOrEqual(6);
    expect(reads().every(call => call.status === 401 && call.authorization === null)).toBe(true);
  });

  it.each(['refuses', 'never answers'] as const)('HIGH: the box %s the unlock — the line comes back', async outcome => {
    const { operator, tickets, show } = await till();
    await vi.advanceTimersByTimeAsync(100);
    operator().lockNow();
    show(tickets);
    await vi.advanceTimersByTimeAsync(100);
    box.unlock = outcome;

    // The platform's answer opens the till whatever the box beside it says.
    await operator().unlock('ZZ TEST synthetic input');
    expect(operator().locked).toBe(false);
    show(tickets);

    // The unlock sent beside an online one is given two seconds, then the read goes and is refused.
    await vi.advanceTimersByTimeAsync(2_500);
    expect(box.session).toBeNull();
    expect(reads().at(-1)).toMatchObject({ status: 401, authorization: null });
    expect(tickets.result.current.error).toBe(UNLOCK_LINE);
    expect(await lineOver(tickets, 6_000)).toEqual([UNLOCK_LINE]);
  });
});

describe('SCRUM-780: no separate display reads the same on every till screen', () => {
  it('HIGH: after an unlock, Tickets and the other screens report no fault and no display', async () => {
    const { operator, tickets, show } = await till();
    // The other screens run the same publisher: History, drop-off and parties
    // through `useTenderDisplay`, F&B and Shop through `useStationDisplay`.
    const tender: Screen = renderHook((active: boolean) => useTenderDisplay(STATION, active), !operator().locked);
    const counter: Screen = renderHook((active: boolean) => useStationDisplay(STATION, { key: 'zz-test:welcome', supported: true,
      presentation: () => ({ stage: 'welcome', step: null, cart: null, member: null, totals: null, payment: null, prompt: null }) }, active), !operator().locked);
    unmounts.push(tender.unmount, counter.unmount);
    const screens = [tickets, tender, counter];
    await vi.advanceTimersByTimeAsync(100);
    // Not unlocked on the box yet: all three hold the box's refusal, which
    // F&B and Shop word as "Separate display unavailable" and Tickets quotes.
    expect(screens.map(screen => screen.result.current.error)).toEqual([UNLOCK_LINE, UNLOCK_LINE, UNLOCK_LINE]);

    operator().lockNow();
    show(...screens);
    await operator().unlock('ZZ TEST synthetic input');
    show(...screens);
    for (const screen of screens) expect(await lineOver(screen, 2_000)).toEqual([null]);
    expect(screens.map(screen => screen.result.current.connected)).toEqual([[], [], []]);
  });
});
