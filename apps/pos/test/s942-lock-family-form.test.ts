import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * SCRUM-942, FIRST PART — THE LOCK SCREEN SAYS A FAMILY IS FILLING THE FORM.
 *
 * A till nobody touches for two minutes locks while a family fills the
 * drop-off form on its paired display, and a Done pressed meanwhile waits with
 * no sign on the lock screen. While the till is locked with the form open on
 * the display, the lock screen now says so in one line, and once the family
 * has pressed Done, that an unlock carries on. The locked till learns it from
 * its station's status read (no personal data; a locked session may make it).
 * When the till locks is not changed: the owner has not chosen yet.
 */
const status = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock('@/api/bridge', () => ({ bridgeApi: { status: status.read } }));
vi.mock('react', async () => ({ ...await vi.importActual<typeof import('react')>('react'), ...await import('./support/hooks') }));

import { lockedFamilyForm, lockedFamilyFormLine, LOCKED_FORM_POLL_MS, useLockedFamilyFormWatch } from '@/lib/lockedFamilyForm';
import { INACTIVITY_TIMEOUT_MS } from '@/auth/timings';
import { renderHook } from './support/hooks';
import { settle } from './support/fixtures';

beforeEach(() => { vi.useFakeTimers(); status.read.mockReset(); lockedFamilyForm.set(null); });
afterEach(() => { vi.useRealTimers(); });

function watch(start: { locked: boolean; formOpen: boolean; stationId: string | null }) {
  return renderHook((props: typeof start) => useLockedFamilyFormWatch(props), start);
}

describe('the locked till watches the family’s form', () => {
  it('says nothing while the till is unlocked, or locked with no form on the display', async () => {
    const open = watch({ locked: false, formOpen: true, stationId: 'zz-station' });
    await settle();
    expect(lockedFamilyForm.get()).toBeNull();
    open.rerender({ locked: true, formOpen: false, stationId: 'zz-station' });
    await settle();
    expect(lockedFamilyForm.get()).toBeNull();
    expect(status.read).not.toHaveBeenCalled();
    open.unmount();
  });

  it('says a family is filling the form from the moment it locks, then that they pressed Done', async () => {
    status.read.mockResolvedValueOnce({ familyForm: 'filling' }).mockResolvedValue({ familyForm: 'done' });
    const till = watch({ locked: true, formOpen: true, stationId: 'zz-station' });
    expect(lockedFamilyForm.get()).toBe('filling');
    await settle();
    expect(status.read).toHaveBeenCalledWith('zz-station');
    expect(lockedFamilyForm.get()).toBe('filling');
    await vi.advanceTimersByTimeAsync(LOCKED_FORM_POLL_MS);
    expect(lockedFamilyForm.get()).toBe('done');
    // Unlocked: the lock screen is gone, and so is its line; the reads stop.
    till.rerender({ locked: false, formOpen: true, stationId: 'zz-station' });
    expect(lockedFamilyForm.get()).toBeNull();
    const reads = status.read.mock.calls.length;
    await vi.advanceTimersByTimeAsync(LOCKED_FORM_POLL_MS * 3);
    expect(status.read.mock.calls.length).toBe(reads);
    till.unmount();
  });

  it('keeps the line from the lock when the box says nothing about the form, or does not answer', async () => {
    status.read.mockResolvedValueOnce({ link: { lane: 'box' } }).mockRejectedValue(new Error('offline'));
    const till = watch({ locked: true, formOpen: true, stationId: 'zz-station' });
    await settle();
    expect(lockedFamilyForm.get()).toBe('filling');
    await vi.advanceTimersByTimeAsync(LOCKED_FORM_POLL_MS);
    expect(lockedFamilyForm.get()).toBe('filling');
    till.unmount();
    expect(lockedFamilyForm.get()).toBeNull();
  });

  it('drops the line when the station says the form is gone', async () => {
    status.read.mockResolvedValue({ familyForm: null });
    const till = watch({ locked: true, formOpen: true, stationId: 'zz-station' });
    await settle();
    expect(lockedFamilyForm.get()).toBeNull();
    till.unmount();
  });

  it('with no station to ask, says what it knew at the lock', async () => {
    const till = watch({ locked: true, formOpen: true, stationId: null });
    await settle();
    expect(lockedFamilyForm.get()).toBe('filling');
    expect(status.read).not.toHaveBeenCalled();
    till.unmount();
  });
});

describe('the lock screen’s line', () => {
  it('names the family filling the form, and the Done that waits for the unlock', () => {
    expect(lockedFamilyFormLine('filling')).toBe('A family is filling in the drop-off form on the display.');
    expect(lockedFamilyFormLine('done')).toBe('The family has pressed Done: unlock to carry on.');
    expect(lockedFamilyFormLine(null)).toBeNull();
  });

  const src = (rel: string) => readFileSync(path.resolve(import.meta.dirname, '../src', rel), 'utf8').replace(/\r\n/g, '\n');

  it('is drawn on the locked screen above the password, in the screen’s own notice styles', () => {
    const lock = src('components/auth/LockScreen.tsx');
    const locked = lock.slice(lock.indexOf('if (locked && operator)'), lock.indexOf('<form onSubmit={doUnlock}'));
    expect(locked).toContain('data-testid="lock-family-form"');
    // The amber notice the offline unlock uses, for the Done; the dashed one for the form being filled.
    expect(locked).toContain('border-amber-500/30 bg-amber-400/10');
    expect(locked).toContain('border-dashed border-foreground/20');
  });

  it('the till watches only while its family form is on the display, and when it locks is not changed', () => {
    const till = src('pages/Till.tsx');
    expect(till).toContain('useLockedFamilyFormWatch({ locked, stationId: station?.stationId ?? null,');
    expect(till).toContain('formOpen: consentMirror && !consentCandidate.completed && !consentFinishing });');
    // The owner's open decision: the timer and what counts as activity stay as they were.
    expect(INACTIVITY_TIMEOUT_MS).toBe(120_000);
    expect(src('auth/OperatorContext.tsx')).toContain("const ACTIVITY_EVENTS = ['pointerdown', 'mousedown', 'keydown', 'touchstart'] as const;");
  });
});

describe('the lock screen draws it', () => {
  it('shows the line for a family filling the form and for their Done', async () => {
    vi.doMock('react', async () => vi.importActual('react'));
    vi.doMock('@/auth/OperatorContext', () => ({ useOperator: () => ({ locked: true, operator: { id: 'zz', name: 'ZZ TEST staff' },
      signIn: vi.fn(), unlock: vi.fn(), logout: vi.fn(), handoffError: null, offlineUnlock: null }) }));
    vi.doMock('wouter', () => ({ Link: () => null, useLocation: () => ['/', () => undefined] }));
    vi.resetModules();
    const ReactActual = await vi.importActual<typeof import('react')>('react');
    vi.stubGlobal('React', ReactActual);
    const { renderToStaticMarkup } = await import('react-dom/server');
    const { LockScreen } = await import('@/components/auth/LockScreen');
    const store = await import('@/lib/lockedFamilyForm');
    store.lockedFamilyForm.set('filling');
    const filling = renderToStaticMarkup(ReactActual.createElement(LockScreen));
    expect(filling).toContain('data-testid="lock-family-form"');
    expect(filling).toContain('A family is filling in the drop-off form on the display.');
    store.lockedFamilyForm.set('done');
    const done = renderToStaticMarkup(ReactActual.createElement(LockScreen));
    expect(done).toContain('The family has pressed Done: unlock to carry on.');
    store.lockedFamilyForm.set(null);
    expect(renderToStaticMarkup(ReactActual.createElement(LockScreen))).not.toContain('lock-family-form');
    vi.doUnmock('react');
    vi.doUnmock('@/auth/OperatorContext');
    vi.doUnmock('wouter');
    vi.unstubAllGlobals();
  });
});
