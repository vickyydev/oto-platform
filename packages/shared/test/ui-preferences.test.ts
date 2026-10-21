import { describe, expect, it, vi } from 'vitest';
import {
  createThemeController,
  nextThemePreference,
  readUiPreferences,
  resolveTheme,
  uiPreferencesUpdateSchema,
  type ColorSchemeQuery,
  type ThemePreference,
} from '../src/ui-preferences';

/**
 * SCRUM-653 — theme and language on the account. The rule every staff app
 * shares: the body the api takes, 'system' resolved at apply time, the
 * toggle's cycle, and the controller's write-back with one retry.
 */

function fakeRoot() {
  const classes = new Set<string>();
  return {
    classes,
    classList: {
      toggle(token: string, force?: boolean) {
        const on = force ?? !classes.has(token);
        if (on) classes.add(token);
        else classes.delete(token);
        return on;
      },
    },
  };
}

function fakeScheme(dark: boolean) {
  const listeners = new Set<() => void>();
  const query: ColorSchemeQuery & { flip(next: boolean): void; listeners: Set<() => void> } = {
    matches: dark,
    listeners,
    addEventListener: (_type, l) => void listeners.add(l),
    removeEventListener: (_type, l) => void listeners.delete(l),
    flip(next) {
      query.matches = next;
      listeners.forEach((l) => l());
    },
  };
  return query;
}

function controllerWith(opts: { dark?: boolean; write?: (body: { theme: ThemePreference }, key: string) => Promise<unknown> } = {}) {
  const root = fakeRoot();
  const scheme = fakeScheme(opts.dark ?? false);
  const timers: Array<() => void> = [];
  const write = vi.fn(opts.write ?? (async () => ({})));
  let n = 0;
  const controller = createThemeController({
    initial: 'light',
    root: () => root,
    colorScheme: () => scheme,
    write,
    newKey: () => `key-${++n}`,
    setTimeout: (fn) => timers.push(fn),
  });
  return { controller, root, scheme, write, timers };
}

describe('the request body', () => {
  it('takes a theme, a language or both, and nothing else', () => {
    expect(uiPreferencesUpdateSchema.safeParse({ theme: 'dark' }).success).toBe(true);
    expect(uiPreferencesUpdateSchema.safeParse({ language: 'th' }).success).toBe(true);
    expect(uiPreferencesUpdateSchema.safeParse({ theme: 'system', language: 'en' }).success).toBe(true);
    expect(uiPreferencesUpdateSchema.safeParse({}).success).toBe(false);
    expect(uiPreferencesUpdateSchema.safeParse({ theme: 'blue' }).success).toBe(false);
    expect(uiPreferencesUpdateSchema.safeParse({ language: 'fr' }).success).toBe(false);
    expect(uiPreferencesUpdateSchema.safeParse({ theme: 'dark', accountId: 'x' }).success).toBe(false);
  });
});

describe('reading /me', () => {
  it('reads preferences, and an answer without them as nothing', () => {
    expect(readUiPreferences({ preferences: { theme: 'dark', language: 'th' } })).toEqual({ theme: 'dark', language: 'th' });
    expect(readUiPreferences({ account: {} })).toBeNull();
    expect(readUiPreferences({ preferences: { theme: 'neon', language: 'en' } })).toBeNull();
    expect(readUiPreferences(null)).toBeNull();
  });
});

describe('resolving and cycling', () => {
  it("maps 'system' to the device's scheme and leaves an explicit choice alone", () => {
    expect(resolveTheme('system', true)).toBe('dark');
    expect(resolveTheme('system', false)).toBe('light');
    expect(resolveTheme('light', true)).toBe('light');
    expect(resolveTheme('dark', false)).toBe('dark');
  });

  it('cycles light → dark → system → light', () => {
    expect(nextThemePreference('light')).toBe('dark');
    expect(nextThemePreference('dark')).toBe('system');
    expect(nextThemePreference('system')).toBe('light');
  });
});

describe('the controller', () => {
  it('paints the pre-sign-in default and writes nothing for a signed-out toggle', () => {
    const { controller, root, write } = controllerWith();
    expect(root.classes.has('light')).toBe(true);
    controller.set('dark');
    expect(root.classes.has('dark')).toBe(true);
    expect(root.classes.has('light')).toBe(false);
    expect(write).not.toHaveBeenCalled();
  });

  it("adopts the account's choice from /me and follows the device under 'system'", () => {
    const { controller, root, scheme } = controllerWith({ dark: true });
    const stop = controller.start();
    controller.adopt({ theme: 'system' });
    expect(controller.preference()).toBe('system');
    expect(controller.resolved()).toBe('dark');
    expect(root.classes.has('dark')).toBe(true);
    const seen = vi.fn();
    controller.subscribe(seen);
    scheme.flip(false);
    expect(controller.resolved()).toBe('light');
    expect(root.classes.has('light')).toBe(true);
    expect(seen).toHaveBeenCalledTimes(1);
    controller.set('dark');
    scheme.flip(true);
    scheme.flip(false);
    // An explicit choice ignores the device.
    expect(controller.resolved()).toBe('dark');
    stop();
    expect(scheme.listeners.size).toBe(0);
  });

  it('keeps what is painted when /me carries no preferences', () => {
    const { controller } = controllerWith();
    controller.set('dark');
    controller.adopt(null);
    expect(controller.preference()).toBe('dark');
    expect(controller.bound()).toBe(true);
  });

  it('writes a signed-in toggle back, once, with a replay key', () => {
    const { controller, write } = controllerWith();
    controller.adopt({ theme: 'light' });
    controller.set('dark');
    expect(write).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledWith({ theme: 'dark' }, 'key-1');
  });

  it('retries a failed write once with the same key, then gives up', async () => {
    const failed = vi.fn();
    const root = fakeRoot();
    const timers: Array<() => void> = [];
    const write = vi.fn(async () => {
      throw new Error('offline');
    });
    const controller = createThemeController({
      initial: 'light',
      root: () => root,
      colorScheme: () => null,
      write,
      newKey: () => 'k',
      onWriteFailed: failed,
      setTimeout: (fn) => timers.push(fn),
    });
    controller.adopt({ theme: 'light' });
    controller.set('system');
    await vi.waitFor(() => expect(timers).toHaveLength(1));
    timers[0]!();
    await vi.waitFor(() => expect(failed).toHaveBeenCalledTimes(1));
    expect(write).toHaveBeenCalledTimes(2);
    expect(write.mock.calls.map((c) => (c as unknown[])[1])).toEqual(['k', 'k']);
    // The screen keeps the choice.
    expect(controller.preference()).toBe('system');
  });

  it('drops the retry of a choice already replaced, or after sign-out', async () => {
    let calls = 0;
    const { controller, write, timers } = controllerWith({
      write: async () => {
        calls++;
        if (calls === 1) throw new Error('offline');
        return {};
      },
    });
    controller.adopt({ theme: 'light' });
    controller.set('dark');
    controller.set('system');
    await vi.waitFor(() => expect(timers).toHaveLength(1));
    timers[0]!();
    expect(write).toHaveBeenCalledTimes(2);
    expect(write.mock.calls[1]![0]).toEqual({ theme: 'system' });

    controller.release();
    controller.set('light');
    expect(write).toHaveBeenCalledTimes(2);
  });
});
