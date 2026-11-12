import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StationSessionDocument } from '@oto/shared';
vi.mock('react', () => import('./support/hooks'));
const mock = vi.hoisted(() => ({ lease: vi.fn(), renew: vi.fn(), session: vi.fn(), publish: vi.fn(), release: vi.fn(), watch: vi.fn(), get: vi.fn() }));
const lane = vi.hoisted(() => ({ current: 'platform' as 'platform' | 'box' }));
vi.mock('@/api/bridge', () => ({ bridgeApi: mock, watchBridgeSnapshots: mock.watch, hasBridgeOrigin: () => false }));
vi.mock('@/api/client', async () => ({ ...await vi.importActual('@/api/client'), api: { get: mock.get } }));
vi.mock('@/lib/lane', () => ({ currentLane: () => lane.current, isBoxLaneTrigger: () => false }));
import { useStationDisplay, useTicketDisplay, type StationDisplayState, type TicketDisplayState } from '@/lib/displaySession';
import { customerDisplayTheme } from '@/lib/displayTheme';
import { renderHook } from './support/hooks';
import { settle } from './support/fixtures';

/**
 * SCRUM-929 — THE TILL'S DISPLAY SWITCH REACHES A PAIRED DISPLAY.
 *
 * Every screen that drives a paired display (tickets, F&B, shop, the party
 * windows' tender) publishes through `useStationDisplay`, so the look rides
 * there: a press of Display is published at once, even when nothing on the
 * order moved; nothing else is (a reload or a sign-in is nobody telling the
 * display anything); and a box from before the field is never sent it, since
 * an older box refuses a publication with a field it does not know.
 */

let doc: StationSessionDocument;
const ticketState = (): TicketDisplayState => ({ stage: 'welcome', step: 2, sessionKey: 'visitor', tier: 'tourist', phone: '',
  nickname: '', contactChannel: 'whatsapp', member: null, online: true });
const published = () => mock.publish.mock.calls.map(call => call[1].payload as Record<string, unknown>);
const withoutTheme = (payload: Record<string, unknown>) => Object.fromEntries(Object.entries(payload).filter(([key]) => key !== 'theme'));

beforeEach(() => {
  vi.useFakeTimers(); vi.clearAllMocks();
  lane.current = 'platform';
  customerDisplayTheme.restore('light');
  doc = { stationId: 'station', boxId: 'box', schemaVersion: 1, sequence: 0, stage: 'identify', language: 'en', theme: null,
    lease: null, takeoverCount: 0, updatedAt: new Date().toISOString() };
  mock.get.mockResolvedValue({ displays: [{ id: 'display', name: 'ZZ TEST', connected: true }] });
  mock.lease.mockImplementation(async () => ({ lease: { leaseId: 'lease' }, document: doc }));
  mock.session.mockImplementation(async () => ({ document: doc }));
  mock.renew.mockImplementation(async () => ({ document: doc }));
  // The box keeps what a publication carries, and leaves what it does not, as `session.publish_display` does.
  mock.publish.mockImplementation(async (_station, intent) => { doc = { ...doc, ...intent.payload, sequence: doc.sequence + 1 }; return { document: doc }; });
  mock.release.mockResolvedValue({ released: true });
  mock.watch.mockImplementation(() => vi.fn());
});
afterEach(() => { vi.useRealTimers(); customerDisplayTheme.restore('light'); });

describe('a box that keeps a display look (SCRUM-929)', () => {
  it('publishes a press of Display within 50ms with nothing else on the screen changed', async () => {
    const hook = renderHook(() => useTicketDisplay('station', ticketState(), vi.fn()));
    await settle();
    expect(mock.publish).toHaveBeenCalledOnce();
    expect('theme' in published()[0]!).toBe(false);

    customerDisplayTheme.choose('light');
    await vi.advanceTimersByTimeAsync(50);
    expect(mock.publish).toHaveBeenCalledTimes(2);
    expect(published()[1]!.theme).toBe('light');
    expect(withoutTheme(published()[1]!)).toEqual(published()[0]);
    expect(doc.theme).toBe('light');

    customerDisplayTheme.choose('dark');
    await vi.advanceTimersByTimeAsync(50);
    expect(mock.publish).toHaveBeenCalledTimes(3);
    expect(published()[2]!.theme).toBe('dark');
    hook.unmount();
  });

  it('keeps sending the pressed look with each later publication, so a box that lost it is told again', async () => {
    const hook = renderHook((value: TicketDisplayState) => useTicketDisplay('station', value, vi.fn()), ticketState());
    await settle();
    customerDisplayTheme.choose('light');
    await vi.advanceTimersByTimeAsync(50);
    hook.rerender({ ...ticketState(), stage: 'identify', step: 1 });
    await vi.advanceTimersByTimeAsync(50);
    expect(published().at(-1)!.stage).toBe('identify');
    expect(published().at(-1)!.theme).toBe('light');
    hook.unmount();
  });

  it('before anybody presses Display, shows what the paired display shows and publishes no look', async () => {
    doc = { ...doc, theme: 'light' };
    customerDisplayTheme.restore('dark');
    const hook = renderHook(() => useTicketDisplay('station', ticketState(), vi.fn()));
    await settle();
    expect(customerDisplayTheme.get()).toBe('light');
    expect(customerDisplayTheme.toTell()).toBeNull();
    // A sign-in restoring another choice is not a press either: the display keeps its look.
    customerDisplayTheme.restore('dark');
    await vi.advanceTimersByTimeAsync(2_000);
    expect(customerDisplayTheme.get()).toBe('light');
    expect(published().every(payload => !('theme' in payload))).toBe(true);
    expect(doc.theme).toBe('light');
    hook.unmount();
  });

  it('takes a display the box never told as dark while one is watching, so the first press changes it', async () => {
    const hook = renderHook(() => useTicketDisplay('station', ticketState(), vi.fn()));
    await settle();
    expect(customerDisplayTheme.get()).toBe('dark');
    customerDisplayTheme.choose(customerDisplayTheme.get() === 'dark' ? 'light' : 'dark');
    await vi.advanceTimersByTimeAsync(50);
    expect(published().at(-1)!.theme).toBe('light');
    hook.unmount();
  });

  it('does not guess a never-told display when it cannot see whether one is watching', async () => {
    lane.current = 'box';
    const hook = renderHook(() => useTicketDisplay('station', ticketState(), vi.fn()));
    await settle();
    expect(mock.publish).toHaveBeenCalled();
    expect(customerDisplayTheme.get()).toBe('light');
    hook.unmount();
  });

  it('after a press the till stands by its own look rather than taking the box’s', async () => {
    const hook = renderHook(() => useTicketDisplay('station', ticketState(), vi.fn()));
    await settle();
    customerDisplayTheme.choose('light');
    await vi.advanceTimersByTimeAsync(50);
    // Another till held the station meanwhile and told it dark.
    doc = { ...doc, theme: 'dark', sequence: doc.sequence + 1 };
    await vi.advanceTimersByTimeAsync(2_000);
    expect(customerDisplayTheme.get()).toBe('light');
    hook.unmount();
  });

  it('goes the same way from any screen that publishes through the station display (F&B, shop, tender)', async () => {
    const state: StationDisplayState = { key: 'fnb:welcome', supported: true, presentation: () => ({ stage: 'welcome', step: null,
      cart: { kind: 'fnb', supported: true, lines: [], orderNote: '', manualDiscounts: [], completion: null },
      member: null, totals: null, payment: null, prompt: null }) };
    const hook = renderHook(() => useStationDisplay('station', state));
    await settle();
    customerDisplayTheme.choose('light');
    await vi.advanceTimersByTimeAsync(50);
    expect(published().at(-1)!.theme).toBe('light');
    expect((published().at(-1)!.cart as { kind: string }).kind).toBe('fnb');
    hook.unmount();
  });
});

describe('a box from before the field (SCRUM-929)', () => {
  it('is never sent a look, and the till keeps its own switch', async () => {
    doc = withoutTheme(doc as unknown as Record<string, unknown>) as unknown as StationSessionDocument;
    expect('theme' in doc).toBe(false);
    const hook = renderHook(() => useTicketDisplay('station', ticketState(), vi.fn()));
    await settle();
    expect(customerDisplayTheme.get()).toBe('light');
    customerDisplayTheme.choose('dark');
    await vi.advanceTimersByTimeAsync(2_000);
    expect(mock.publish).toHaveBeenCalled();
    expect(published().every(payload => !('theme' in payload))).toBe(true);
    expect(customerDisplayTheme.get()).toBe('dark');
    hook.unmount();
  });
});

describe('the Theme menu (SCRUM-929)', () => {
  const menu = readFileSync(path.resolve(import.meta.dirname, '..', 'src', 'components', 'shared', 'ThemeMenu.tsx'), 'utf8');

  it('tells a paired display on a press of Display, and says so under the switches', () => {
    expect(menu).toContain('customerDisplayTheme.choose(customerNext);');
    expect(menu).toContain("Staff follows your account. Display: this till's customer screen, and a paired display keeps it.");
    expect(menu).not.toContain('this device only, until reload');
  });
});
