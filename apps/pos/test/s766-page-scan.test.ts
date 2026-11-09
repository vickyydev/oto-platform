import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bandShortCode, mintBandCode, mintBookingQr, mintBoothCode } from '@oto/shared';
import { renderHook, type RenderedHook } from './support/hooks';
import {
  SCAN_PACE_GAP_MS,
  SCAN_PACE_QUIET_MS,
  classifyScannedCode,
  createPageScanner,
  currentPageScanRoute,
  planPageScan,
  registerPageScanRoute,
  scanFocusOf,
  tabScanOfScannedCode,
  usePageScanRoute,
  usePageScanShell,
  type PageScanCommit,
  type PageScanRoute,
  type ScanFocus,
} from '@/lib/pageScan';
import { decideHistoryTabScan, ticketTillTabScanWords, useCounterTabScan, type CounterStage } from '@/lib/tabScan';
import { parseHistorySearch } from '@/api/history';
import { toast } from '@/hooks/use-toast';

/**
 * SCRUM-766 — a wristband scanned from anywhere on the screen, with the
 * scanner's cradle in the iPad.
 *
 * The scanner types as a keyboard. A band used to be caught only by the
 * wristband box, so a scan made with the box not selected went nowhere. The
 * staff app now has one listener at its shell: it tells a scanner's pace from a
 * person's with the box's own rule (SCRUM-790), says what the code is, and hands
 * it to the screen on show, which does what the counter box's scan of the same
 * band does (SCRUM-731). These pin the pace rule, the classification, the
 * routing per screen, the rule for a selected field and that nothing is acted on
 * twice.
 */
vi.mock('react', () => import('./support/hooks'));
vi.mock('@/hooks/use-toast', () => ({ toast: vi.fn() }));

const KEY = 'zz-test-band-key-for-scrum-766-only';
/** A band this park's till T1 printed: its signed code, as the scanner reads the QR. */
const SIGNED = mintBandCode('T1', '01JCZZTEST766BAND0000000QX', KEY);
/** The short code printed under its QR. */
const SHORT = bandShortCode(SIGNED)!;
const WALLET = `QR-${'7KMQ4X'.repeat(4)}`;
let ordinal = 0;
const VOUCHER = mintBoothCode('B1', (max) => ordinal++ % max);
const BOOKING = mintBookingQr('0192f3a4-5b6c-7d8e-9fa0-b1c2d3e4f766', KEY);

/** A code typed key by key at `gap` ms, from `at`. */
function keys(code: string, gap: number, focus: ScanFocus = 'none', at = 1_000) {
  return [...code].map((key, i) => ({ key, at: at + i * gap, focus }));
}

describe('the codes this test types are what they say', () => {
  it('a real band, voucher and booking QR', () => {
    expect(SIGNED).toContain('.');
    expect(SHORT).toMatch(/^T1-[0-9A-Z]{6}$/);
    expect(SIGNED.length).toBeGreaterThan(40);
    expect(VOUCHER).toHaveLength(11);
    expect(BOOKING.startsWith('BK1:')).toBe(true);
  });
});

describe('the pace rule is the wristband box’s (SCRUM-790)', () => {
  it('shares its numbers', () => {
    expect(SCAN_PACE_GAP_MS).toBe(80);
    expect(SCAN_PACE_QUIET_MS).toBe(150);
    const box = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'components', 'fnb', 'ScanWristband.tsx'), 'utf8');
    expect(box).toContain('export const FIELD_SCAN_GAP_MS = SCAN_PACE_GAP_MS;');
    expect(box).toContain('export const FIELD_SCAN_QUIET_MS = SCAN_PACE_QUIET_MS;');
  });

  it('a scan ended by its Enter is one code', () => {
    const scanner = createPageScanner();
    const typed = keys(SIGNED, 15);
    const steps = typed.map((k) => scanner.push(k));
    expect(steps.every((s) => s.commit === null)).toBe(true);
    expect(steps[0]!.started).toBe(true);
    expect(steps.slice(1).some((s) => s.started)).toBe(false);
    const end = scanner.push({ key: 'Enter', at: typed.at(-1)!.at + 15, focus: 'none' });
    expect(end.commit).toEqual({ code: SIGNED, focus: 'none', byEnter: true });
  });

  it('a scan with no Enter is one code once 150 ms pass with nothing more', () => {
    const scanner = createPageScanner();
    const steps = keys(SIGNED, 15).map((k) => scanner.push(k));
    // Nothing to wait for until six characters have come at a scanner's pace.
    expect(steps.slice(0, 5).map((s) => s.settleInMs)).toEqual([null, null, null, null, null]);
    expect(steps.slice(5).every((s) => s.settleInMs === SCAN_PACE_QUIET_MS)).toBe(true);
    expect(scanner.settle()).toEqual({ code: SIGNED, focus: 'none', byEnter: false });
    expect(scanner.settle()).toBeNull();
  });

  it('a person typing is never a scan, with or without Enter', () => {
    const scanner = createPageScanner();
    const typed = keys(SIGNED, 140);
    expect(typed.map((k) => scanner.push(k)).every((s) => s.commit === null && s.settleInMs === null)).toBe(true);
    expect(scanner.push({ key: 'Enter', at: typed.at(-1)!.at + 100, focus: 'none' }).commit).toBeNull();
    expect(scanner.settle()).toBeNull();
  });

  it('80 ms apart is still the scanner; 81 ms ends the run and drops it', () => {
    const steady = createPageScanner();
    const typed = keys('T1-0000QX', SCAN_PACE_GAP_MS);
    typed.forEach((k) => steady.push(k));
    expect(steady.push({ key: 'Enter', at: typed.at(-1)!.at + SCAN_PACE_GAP_MS, focus: 'none' }).commit?.code).toBe('T1-0000QX');

    const broken = createPageScanner();
    keys('T1-000', 15).forEach((k) => broken.push(k));
    const late = 1_000 + 5 * 15 + SCAN_PACE_GAP_MS + 1;
    keys('0QX', 15, 'none', late).forEach((k) => broken.push(k));
    expect(broken.push({ key: 'Enter', at: late + 3 * 15, focus: 'none' }).commit).toBeNull();
  });

  it('a late Enter is a person pressing Enter', () => {
    const scanner = createPageScanner();
    const typed = keys(SIGNED, 15);
    typed.forEach((k) => scanner.push(k));
    expect(scanner.push({ key: 'Enter', at: typed.at(-1)!.at + 200, focus: 'none' }).commit).toBeNull();
  });

  it('fewer than six characters are nothing', () => {
    const scanner = createPageScanner();
    keys('T1-00', 10).forEach((k) => scanner.push(k));
    expect(scanner.push({ key: 'Enter', at: 1_100, focus: 'none' }).commit).toBeNull();
  });

  it('Shift for a capital does not break a run; a shortcut or an editing key ends it', () => {
    const withShift = createPageScanner();
    let at = 1_000;
    for (const ch of SHORT) {
      withShift.push({ key: 'Shift', at, focus: 'none' });
      withShift.push({ key: ch, at: at + 2, focus: 'none' });
      at += 15;
    }
    expect(withShift.push({ key: 'Enter', at, focus: 'none' }).commit?.code).toBe(SHORT);

    for (const interrupt of [{ key: 'v', withCommand: true }, { key: 'Backspace' }, { key: 'Tab' }, { key: 'ArrowLeft' }]) {
      const scanner = createPageScanner();
      keys('T1-000', 10).forEach((k) => scanner.push(k));
      scanner.push({ ...interrupt, at: 1_060, focus: 'none' });
      keys('0QX', 10, 'none', 1_070).forEach((k) => scanner.push(k));
      expect(scanner.push({ key: 'Enter', at: 1_100, focus: 'none' }).commit, interrupt.key).toBeNull();
    }
  });

  it('something leaning on a key is never a code', () => {
    const scanner = createPageScanner();
    keys('A'.repeat(70), 5).forEach((k) => scanner.push(k));
    const end = scanner.push({ key: 'Enter', at: 1_000 + 70 * 5, focus: 'none' });
    expect(end.commit).toBeNull();
  });

  it('keys going into a field that reads codes itself are that field’s alone', () => {
    const scanner = createPageScanner();
    const steps = keys(SIGNED, 15, 'own').map((k) => scanner.push(k));
    expect(steps.every((s) => s.commit === null && s.settleInMs === null && !s.started)).toBe(true);
    expect(scanner.push({ key: 'Enter', at: 2_000, focus: 'own' }).commit).toBeNull();
    expect(scanner.settle()).toBeNull();
  });

  it('a run in another field says so, and one whose focus moves starts again where it went', () => {
    const scanner = createPageScanner();
    keys(SIGNED, 15, 'field').forEach((k) => scanner.push(k));
    expect(scanner.settle()).toEqual({ code: SIGNED, focus: 'field', byEnter: false });

    const moved = createPageScanner();
    keys('T1-0', 10).forEach((k) => moved.push(k));
    const restart = moved.push({ key: '0', at: 1_040, focus: 'field' });
    expect(restart.commit).toBeNull();
    expect(restart.started).toBe(true);
    keys('0QX', 10, 'field', 1_050).forEach((k) => moved.push(k));
    expect(moved.push({ key: 'Enter', at: 1_080, focus: 'field' }).commit).toBeNull();
  });
});

describe('what a code is: the shared shape tests the rest of the till uses', () => {
  it('a band, by its signed code or the short code printed under it', () => {
    for (const code of [SIGNED, SIGNED.toLowerCase(), ` ${SIGNED} `, SHORT, SHORT.toLowerCase(), SHORT.replace('-', ' ')]) {
      expect(classifyScannedCode(code), code).toBe('band');
    }
  });

  it('a printed band wins over the voucher shape its prefix can take (SCRUM-746)', () => {
    expect(classifyScannedCode('ZI7C-QV8QZ8')).toBe('band');
    expect(classifyScannedCode('ZZAGY-T25K59')).toBe('band');
  });

  it('a credit voucher, a Lucky Wheel voucher and a booking QR', () => {
    expect(classifyScannedCode(WALLET)).toBe('wallet');
    expect(classifyScannedCode(VOUCHER)).toBe('voucher');
    expect(classifyScannedCode('B1ABCDEFGH')).toBe('voucher');
    expect(classifyScannedCode(BOOKING)).toBe('booking');
  });

  it('nothing else: a retail barcode, a code of no known shape', () => {
    for (const code of ['8850000000017', 'ZZ-NOT-A-BAND-9', 'hello world', '']) {
      expect(classifyScannedCode(code), code).toBeNull();
    }
  });

  it('a band is named by its short code and handed on as read; the signed code is never the name', () => {
    expect(tabScanOfScannedCode(SIGNED.toLowerCase())).toEqual({ ok: true, what: 'band', key: SHORT, code: SIGNED });
    expect(tabScanOfScannedCode(SHORT.toLowerCase().replace('-', ' '))).toEqual({ ok: true, what: 'band', key: SHORT, code: SHORT });
    expect(tabScanOfScannedCode(WALLET.toLowerCase())).toEqual({ ok: true, what: 'wallet', key: WALLET });
    expect(tabScanOfScannedCode(VOUCHER)).toBeNull();
  });
});

describe('who takes it', () => {
  const commit = (code: string, focus: 'none' | 'field' = 'none'): PageScanCommit => ({ code, focus, byEnter: true });
  const routes = () => ({ tab: vi.fn(), voucher: vi.fn(), booking: vi.fn() });

  it('nobody, when no screen took scans', () => {
    expect(planPageScan(commit(SIGNED), null)).toBeNull();
  });

  it('a band or a credit voucher goes to the screen’s tab route, from anywhere', () => {
    for (const focus of ['none', 'field'] as const) {
      const route = routes();
      planPageScan(commit(SIGNED, focus), route)!();
      planPageScan(commit(WALLET, focus), route)!();
      expect(route.tab.mock.calls.map(([scan]) => scan)).toEqual([
        { ok: true, what: 'band', key: SHORT, code: SIGNED },
        { ok: true, what: 'wallet', key: WALLET },
      ]);
      expect(route.voucher).not.toHaveBeenCalled();
    }
  });

  it('a band’s printed short code goes to the tab route from no field only: in a field it is two words typed quickly', () => {
    const route = routes();
    planPageScan(commit(SHORT), route)!();
    expect(route.tab).toHaveBeenCalledWith({ ok: true, what: 'band', key: SHORT, code: SHORT });
    expect(planPageScan(commit(SHORT, 'field'), route)).toBeNull();
    // What a kitchen note or a child's name can be, and why: each has the printed code's shape.
    for (const typed of ['extra cheese', 'no cheese', 'no pepper', 'Mali Seeker']) {
      expect(classifyScannedCode(typed), typed).toBe('band');
      expect(planPageScan(commit(typed, 'field'), route), typed).toBeNull();
    }
    expect(route.tab).toHaveBeenCalledTimes(1);
  });

  it('a voucher and a booking QR as before: from no field only, and only where a screen takes them', () => {
    const route = routes();
    planPageScan(commit(VOUCHER), route)!();
    planPageScan(commit(BOOKING), route)!();
    expect(route.voucher).toHaveBeenCalledWith(VOUCHER);
    expect(route.booking).toHaveBeenCalledWith(BOOKING);
    // A field that has focus gets them, as it always did: the promo box, Redeem voucher.
    expect(planPageScan(commit(VOUCHER, 'field'), route)).toBeNull();
    expect(planPageScan(commit(BOOKING, 'field'), route)).toBeNull();
  });

  it('a kind the screen does not take is nobody’s', () => {
    const shop: PageScanRoute = { tab: vi.fn() };
    expect(planPageScan(commit(VOUCHER), shop)).toBeNull();
    expect(planPageScan(commit(BOOKING), shop)).toBeNull();
    expect(planPageScan(commit(SIGNED), { voucher: vi.fn() })).toBeNull();
    expect(planPageScan(commit('8850000000017'), routes())).toBeNull();
  });

  it('the screen on show is the newest to register, and leaving gives the screen back', () => {
    const first = { tab: vi.fn() };
    const second = { tab: vi.fn() };
    const leaveFirst = registerPageScanRoute(() => first);
    const leaveSecond = registerPageScanRoute(() => second);
    expect(currentPageScanRoute()).toBe(second);
    leaveSecond();
    expect(currentPageScanRoute()).toBe(first);
    leaveFirst();
    expect(currentPageScanRoute()).toBeNull();
  });
});

describe('usePageScanRoute', () => {
  type Props = { route: PageScanRoute; enabled: boolean };

  it('registers while enabled, reads the newest closures, and leaves when locked or gone', () => {
    const one: PageScanRoute = { tab: vi.fn() };
    const two: PageScanRoute = { tab: vi.fn() };
    const start: Props = { route: one, enabled: false };
    const hook = renderHook<Props, void>((p) => usePageScanRoute(p.route, p.enabled), start);
    try {
      expect(currentPageScanRoute()).toBeNull();
      hook.rerender({ route: one, enabled: true });
      expect(currentPageScanRoute()).toBe(one);
      hook.rerender({ route: two, enabled: true });
      expect(currentPageScanRoute()).toBe(two);
      hook.rerender({ route: two, enabled: false });
      expect(currentPageScanRoute()).toBeNull();
      hook.rerender({ route: two, enabled: true });
    } finally {
      hook.unmount();
    }
    expect(currentPageScanRoute()).toBeNull();
  });
});

describe('each screen does what the counter box’s scan of the same band does (SCRUM-731)', () => {
  const band = tabScanOfScannedCode(SIGNED)!;
  beforeEach(() => vi.mocked(toast).mockClear());

  describe('F&B and the shop', () => {
    type Props = { stage: CounterStage; locked: boolean; held: { code: string } | null };
    let hook: RenderedHook<Props, ReturnType<typeof useCounterTabScan>>;
    const start = (props: Partial<Props> = {}) => {
      hook = renderHook(
        (p: Props) => useCounterTabScan({ stage: p.stage, held: p.held, locked: p.locked, noun: 'order' }),
        { stage: 'scan', locked: false, held: null, ...props },
      );
    };
    afterEach(() => hook.unmount());

    it('the first screen hands the wristband box the code as read, as if it had been typed there', () => {
      start();
      hook.result.current.take(band);
      expect(hook.result.current.scanned).toBe(SIGNED);
      expect(toast).not.toHaveBeenCalled();
    });

    it('a credit voucher is handed over by its key', () => {
      start();
      hook.result.current.take(tabScanOfScannedCode(WALLET)!);
      expect(hook.result.current.scanned).toBe(WALLET);
    });

    it('an open order is not changed, and the words name the band by its short code', () => {
      start({ stage: 'order', held: { code: 'T2-AAAAAA' } });
      hook.result.current.take(band);
      expect(hook.result.current.scanned).toBeNull();
      expect(vi.mocked(toast).mock.calls[0]![0]).toMatchObject({ title: `Wristband ${SHORT} not opened` });
      expect(JSON.stringify(vi.mocked(toast).mock.calls)).not.toContain(SIGNED);
    });

    it('the band already on the order is already open', () => {
      start({ stage: 'order', held: { code: SIGNED } });
      hook.result.current.take(band);
      expect(vi.mocked(toast).mock.calls[0]![0]).toMatchObject({ title: 'This wristband is already open' });
    });

    it('a locked station takes nothing and says nothing', () => {
      start({ locked: true });
      hook.result.current.take(band);
      expect(hook.result.current.scanned).toBeNull();
      expect(toast).not.toHaveBeenCalled();
    });
  });

  it('History opens the band’s orders with the code as read, and Add time takes its short code', () => {
    const open = decideHistoryTabScan(band, false);
    expect(open).toEqual({ kind: 'open', key: SHORT });
    expect(parseHistorySearch(band.ok ? band.code! : '')).toEqual({ kind: 'band', code: SIGNED, label: SHORT });
    expect(decideHistoryTabScan(band, true, true)).toEqual({ kind: 'add-time', key: SHORT });
    expect(decideHistoryTabScan(band, true)).toMatchObject({ kind: 'say', title: `Bracelet ${SHORT} not opened` });
  });

  it('the ticket till says where the band opens, by its short code', () => {
    const words = ticketTillTabScanWords(band);
    expect(words.title).toBe(`That is wristband ${SHORT}`);
    expect(words.description).toContain('F&B, the shop or History');
    expect(JSON.stringify(words)).not.toContain(SIGNED);
  });
});

// --- The page's events --------------------------------------------------------

type Listener = (event: unknown) => void;

/** A stand-in for the page: its listeners, and what has focus. */
function stubPage() {
  const listeners = new Map<string, Set<Listener>>();
  const page = {
    addEventListener: (type: string, fn: Listener) => {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(fn);
    },
    removeEventListener: (type: string, fn: Listener) => listeners.get(type)?.delete(fn),
  };
  const doc = { activeElement: null as unknown, visibilityState: 'visible' };
  vi.stubGlobal('window', page);
  vi.stubGlobal('document', doc);
  const fire = (type: string, event: unknown) => {
    for (const fn of [...(listeners.get(type) ?? [])]) fn(event);
  };
  return { listeners, doc, fire };
}

/** A field on the page, holding text. `reads` marks one that reads codes itself. */
function stubField(reads = false, value = '') {
  return {
    tagName: 'INPUT',
    type: 'text',
    value,
    isConnected: true,
    closest: (selector: string) => (reads && selector === '[data-reads-scans]' ? {} : null),
    dispatchEvent: vi.fn(() => true),
  };
}

function keyEvent(key: string, at: number, target: unknown) {
  return {
    key,
    timeStamp: at,
    target,
    isComposing: false,
    ctrlKey: false,
    altKey: false,
    metaKey: false,
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
  };
}

describe('usePageScanShell — the one listener', () => {
  let page: ReturnType<typeof stubPage>;
  let shell: RenderedHook<void, void>;
  let route: { tab: ReturnType<typeof vi.fn>; voucher: ReturnType<typeof vi.fn>; booking: ReturnType<typeof vi.fn> };
  let leave: () => void;

  beforeEach(() => {
    vi.useFakeTimers();
    page = stubPage();
    shell = renderHook(() => usePageScanShell());
    route = { tab: vi.fn(), voucher: vi.fn(), booking: vi.fn() };
    leave = registerPageScanRoute(() => route);
  });
  afterEach(() => {
    leave();
    shell.unmount();
    vi.useRealTimers();
  });

  /** Type `code` at `gap` ms a key into `target`, the way the page's keydown sees it; a field gets the character after. */
  const type = (code: string, gap: number, target: unknown, enter = true) => {
    const events: Array<ReturnType<typeof keyEvent>> = [];
    let at = 1_000;
    for (const ch of code) {
      const event = keyEvent(ch, at, target);
      page.fire('keydown', event);
      if (target && typeof (target as { value?: unknown }).value === 'string') (target as { value: string }).value += ch;
      events.push(event);
      at += gap;
    }
    if (enter) {
      const event = keyEvent('Enter', at, target);
      page.fire('keydown', event);
      events.push(event);
    }
    return events;
  };
  const body = { tagName: 'BODY', closest: () => null };

  it('listens once, on the page, and lets go when the shell goes', () => {
    expect(page.listeners.get('keydown')?.size).toBe(1);
    expect(page.listeners.get('paste')?.size).toBe(1);
    shell.unmount();
    expect(page.listeners.get('keydown')?.size).toBe(0);
    expect(page.listeners.get('paste')?.size).toBe(0);
    shell = renderHook(() => usePageScanShell());
  });

  it('a band scanned with nothing selected opens once, and its Enter presses nothing else', () => {
    page.doc.activeElement = body;
    const events = type(SIGNED, 15, body);
    expect(route.tab).toHaveBeenCalledTimes(1);
    expect(route.tab).toHaveBeenCalledWith({ ok: true, what: 'band', key: SHORT, code: SIGNED });
    expect(events.at(-1)!.preventDefault).toHaveBeenCalled();
    expect(events.at(-1)!.stopPropagation).toHaveBeenCalled();
    vi.advanceTimersByTime(500);
    expect(route.tab).toHaveBeenCalledTimes(1);
  });

  it('a band scanned with no Enter opens once the scanner goes quiet', () => {
    type(SIGNED, 15, body, false);
    vi.advanceTimersByTime(SCAN_PACE_QUIET_MS - 1);
    expect(route.tab).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(route.tab).toHaveBeenCalledTimes(1);
  });

  it('typed by hand with nothing selected, nothing happens', () => {
    const events = type(SIGNED, 140, body);
    vi.advanceTimersByTime(500);
    expect(route.tab).not.toHaveBeenCalled();
    expect(events.at(-1)!.preventDefault).not.toHaveBeenCalled();
  });

  it('with the wristband box selected the box alone acts: the shell does nothing, Enter included', () => {
    const box = stubField(true);
    page.doc.activeElement = box;
    const events = type(SIGNED, 15, box);
    vi.advanceTimersByTime(500);
    expect(route.tab).not.toHaveBeenCalled();
    expect(events.some((e) => e.preventDefault.mock.calls.length > 0)).toBe(false);
    expect(box.value).toBe(SIGNED);
    expect(box.dispatchEvent).not.toHaveBeenCalled();
  });

  it('a band scanned into another field is the scanner’s: the screen takes it and the field is put back', () => {
    const search = stubField(false, 'kha');
    page.doc.activeElement = search;
    const events = type(SIGNED, 15, search);
    expect(route.tab).toHaveBeenCalledTimes(1);
    expect(search.value).toBe('kha');
    expect(search.dispatchEvent).toHaveBeenCalledTimes(1);
    const changed = (search.dispatchEvent.mock.calls[0] as unknown[])[0] as Event;
    expect(changed.type).toBe('input');
    expect(changed.bubbles).toBe(true);
    // Its Enter does not submit the field's form.
    expect(events.at(-1)!.preventDefault).toHaveBeenCalled();
  });

  it('a band scanned into another field with no Enter is put back once the scanner goes quiet', () => {
    const field = stubField();
    type(SIGNED, 15, field, false);
    vi.advanceTimersByTime(SCAN_PACE_QUIET_MS);
    expect(route.tab).toHaveBeenCalledTimes(1);
    expect(field.value).toBe('');
  });

  it('typed by hand into a field, it is that field’s', () => {
    const field = stubField();
    const events = type(SHORT, 140, field);
    vi.advanceTimersByTime(500);
    expect(route.tab).not.toHaveBeenCalled();
    expect(field.value).toBe(SHORT);
    expect(field.dispatchEvent).not.toHaveBeenCalled();
    expect(events.at(-1)!.preventDefault).not.toHaveBeenCalled();
  });

  it('two words typed quickly into a field stay the field’s, though they have a printed band’s shape', () => {
    for (const enter of [true, false]) {
      const note = stubField();
      page.doc.activeElement = note;
      const events = type('extra cheese', 70, note, enter);
      vi.advanceTimersByTime(500);
      expect(route.tab, `enter: ${enter}`).not.toHaveBeenCalled();
      expect(note.value).toBe('extra cheese');
      expect(note.dispatchEvent).not.toHaveBeenCalled();
      expect(events.some((e) => e.preventDefault.mock.calls.length > 0)).toBe(false);
    }
  });

  it('a band’s printed short code at a scanner’s pace opens with nothing selected', () => {
    page.doc.activeElement = body;
    type(SHORT, 15, body);
    expect(route.tab).toHaveBeenCalledWith({ ok: true, what: 'band', key: SHORT, code: SHORT });
  });

  it('a voucher scanned into a field stays the field’s, as before; with nothing selected it is redeemed', () => {
    const promo = stubField();
    const inField = type(VOUCHER, 15, promo);
    expect(route.voucher).not.toHaveBeenCalled();
    expect(promo.value).toBe(VOUCHER);
    expect(inField.at(-1)!.preventDefault).not.toHaveBeenCalled();

    type(VOUCHER, 15, body);
    expect(route.voucher).toHaveBeenCalledWith(VOUCHER);
    type(BOOKING, 10, body);
    expect(route.booking).toHaveBeenCalledWith(BOOKING);
    expect(route.tab).not.toHaveBeenCalled();
  });

  it('a code no screen takes leaves its Enter alone', () => {
    const events = type('8850000000017', 15, body);
    expect(route.tab).not.toHaveBeenCalled();
    expect(route.voucher).not.toHaveBeenCalled();
    expect(events.at(-1)!.preventDefault).not.toHaveBeenCalled();
  });

  it('a locked or empty screen takes nothing', () => {
    leave();
    const events = type(SIGNED, 15, body);
    expect(route.tab).not.toHaveBeenCalled();
    expect(events.at(-1)!.preventDefault).not.toHaveBeenCalled();
    leave = registerPageScanRoute(() => route);
  });

  it('a paste with nothing selected is a whole code; a paste into a field is the field’s', () => {
    const paste = (target: unknown, text: string) => {
      const event = { target, clipboardData: { getData: () => text }, preventDefault: vi.fn() };
      page.fire('paste', event);
      return event;
    };
    const taken = paste(body, ` ${SIGNED} `);
    expect(route.tab).toHaveBeenCalledTimes(1);
    expect(taken.preventDefault).toHaveBeenCalled();
    const left = paste(stubField(), SIGNED);
    expect(route.tab).toHaveBeenCalledTimes(1);
    expect(left.preventDefault).not.toHaveBeenCalled();
    const own = paste(stubField(true), SIGNED);
    expect(route.tab).toHaveBeenCalledTimes(1);
    expect(own.preventDefault).not.toHaveBeenCalled();
  });

  it('where focus is: nothing, a field, or a field that reads codes itself', () => {
    expect(scanFocusOf(body as unknown as EventTarget)).toBe('none');
    expect(scanFocusOf(stubField() as unknown as EventTarget)).toBe('field');
    expect(scanFocusOf(stubField(true) as unknown as EventTarget)).toBe('own');
    expect(scanFocusOf({ tagName: 'TEXTAREA', closest: () => null } as unknown as EventTarget)).toBe('field');
    expect(scanFocusOf({ tagName: 'DIV', isContentEditable: true, closest: () => null } as unknown as EventTarget)).toBe('field');
    page.doc.activeElement = stubField(true);
    expect(scanFocusOf(null)).toBe('own');
  });
});

describe('the screens are wired to it', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const source = (path: string) => readFileSync(join(here, '..', 'src', path), 'utf8');

  it('the shell listens once, at the staff app', () => {
    const app = source('App.tsx');
    expect(app).toContain('usePageScanShell();');
    expect(app.match(/<PageScanShell \/>/g)).toHaveLength(1);
  });

  it('F&B, the shop, History and the ticket till each take scans while unlocked', () => {
    expect(source('pages/OrderStation.tsx')).toContain('usePageScanRoute({ tab: tabScan.take, voucher: redeemScannedVoucher }, !locked);');
    expect(source('pages/MerchStation.tsx')).toContain('usePageScanRoute({ tab: tabScan.take }, !locked);');
    expect(source('pages/History.tsx')).toContain('usePageScanRoute({ tab: hearTabScan }, !locked);');
    const till = source('pages/Till.tsx');
    expect(till).toContain('tab: (tabScan) => toast(ticketTillTabScanWords(tabScan)),');
    expect(till).toContain('voucher: redeemScannedVoucher,');
    expect(till).toMatch(/booking: showRedeemModal\s+\? undefined/);
  });

  it('no staff screen keeps a second keyboard listener of its own', () => {
    for (const path of ['pages/Till.tsx', 'pages/OrderStation.tsx', 'pages/MerchStation.tsx', 'pages/History.tsx']) {
      expect(source(path), path).not.toContain('useScannerBurst');
    }
  });

  it('the fields that read codes themselves say so, so a scan into them is acted on once', () => {
    expect(source('components/fnb/ScanWristband.tsx')).toContain('data-reads-scans=""');
    expect(source('pages/History.tsx').match(/data-reads-scans=""/g)).toHaveLength(2);
    expect(source('components/history/SaleExtensions.tsx')).toContain('data-reads-scans=""');
    expect(source('components/till/HeldSales.tsx')).toContain('data-reads-scans=""');
  });

  it('the wristband box shows a code handed to it before it looks it up', () => {
    const text = source('components/fnb/ScanWristband.tsx');
    expect(text.indexOf('setCode(scanned);')).toBeGreaterThan(-1);
    expect(text.indexOf('setCode(scanned);')).toBeLessThan(text.indexOf('void submit(scanned, true)'));
  });
});
