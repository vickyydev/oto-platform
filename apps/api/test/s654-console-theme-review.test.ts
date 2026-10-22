import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ThemeController } from '@oto/shared/ui-preferences';

const client = vi.hoisted(() => ({ put: vi.fn() }));
vi.mock('../../console/src/api/client', () => ({ api: { put: client.put } }));

// Runtime import keeps the Console's browser types out of the API compiler.
// The actual Console theme and preferences adapter run; only fetch is replaced.
const modulePath = fileURLToPath(new URL('../../console/src/lib/theme.ts', import.meta.url));
let exports: Record<string, unknown>;
const classes = new Set<string>();
const changes = new Set<() => void>();
const scheme = { matches: false,
  addEventListener: (_name: string, callback: () => void) => { changes.add(callback); },
  removeEventListener: (_name: string, callback: () => void) => { changes.delete(callback); },
};

function controller(): ThemeController {
  expect(exports.accountTheme, 'Console must expose the account-bound master wiring').toBeDefined();
  return exports.accountTheme as ThemeController;
}

beforeAll(async () => {
  vi.stubGlobal('document', { documentElement: { classList: { toggle: (name: string, force: boolean) => {
    if (force) classes.add(name); else classes.delete(name);
    return force;
  } } } });
  vi.stubGlobal('window', { matchMedia: () => scheme });
  exports = await import(modulePath) as Record<string, unknown>;
});

beforeEach(() => {
  scheme.matches = false; classes.clear(); changes.clear();
  const existing = exports.accountTheme as ThemeController | undefined;
  existing?.release(); existing?.set('light');
  client.put.mockReset().mockResolvedValue({ preferences: { theme: 'dark', language: 'th' } });
});

afterEach(() => {
  (exports.accountTheme as ThemeController | undefined)?.release();
  vi.clearAllTimers(); vi.useRealTimers();
});

describe('SCRUM-654 independent Console account-theme wiring', () => {
  it('R1 [high] adopts the account choice without an implicit save; fix: bind the master controller to Console preferences', () => {
    const theme = controller();
    theme.adopt({ theme: 'dark' });
    expect(theme.preference()).toBe('dark');
    expect(theme.resolved()).toBe('dark');
    expect(classes.has('dark')).toBe(true);
    expect(classes.has('light')).toBe(false);
    expect(client.put).not.toHaveBeenCalled();
  });

  it('R2 [high] follows device changes only while System is chosen; fix: start the real Console media listener', () => {
    const theme = controller(), stop = theme.start();
    theme.adopt({ theme: 'system' });
    expect(theme.preference()).toBe('system');
    expect(theme.resolved()).toBe('light');
    scheme.matches = true; changes.forEach(listener => listener());
    expect(theme.resolved()).toBe('dark');
    expect(classes.has('dark')).toBe(true);
    expect(client.put).not.toHaveBeenCalled();
    stop();
    expect(changes.size).toBe(0);
  });

  it('R3 [high] writes theme only with fresh action keys and a same-key retry; fix: use Console PUT without overwriting language', async () => {
    vi.useFakeTimers();
    const theme = controller();
    client.put.mockRejectedValueOnce(new Error('Synthetic connection failure.'));
    theme.adopt({ theme: 'light' }); theme.set('dark');
    await Promise.resolve(); await vi.advanceTimersByTimeAsync(1500);
    expect(client.put).toHaveBeenCalledTimes(2);
    const first = client.put.mock.calls[0]!, retry = client.put.mock.calls[1]!;
    expect(first[0]).toBe('/me/preferences');
    expect(first[1]).toEqual({ theme: 'dark' });
    expect(first[2]).toEqual({ idempotencyKey: expect.any(String) });
    expect(first[2].idempotencyKey.length).toBeGreaterThan(0);
    expect(retry).toEqual(first);
    theme.set('system');
    const next = client.put.mock.calls[2]!;
    expect(next[1]).toEqual({ theme: 'system' });
    expect(next[2].idempotencyKey).not.toBe(first[2].idempotencyKey);
  });

  it('R4 [high] releases the account before later toggles or queued retries; fix: stop signed-out preference writes while retaining paint', async () => {
    vi.useFakeTimers();
    const theme = controller();
    client.put.mockRejectedValueOnce(new Error('Synthetic connection failure.'));
    theme.adopt({ theme: 'light' }); theme.set('dark');
    await Promise.resolve(); theme.release(); theme.set('system');
    await vi.advanceTimersByTimeAsync(1500);
    expect(theme.bound()).toBe(false);
    expect(theme.preference()).toBe('system');
    expect(client.put).toHaveBeenCalledTimes(1);
  });
});
