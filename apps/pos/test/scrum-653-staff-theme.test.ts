// SCRUM-653 — the till's STAFF theme follows the account; the DISPLAY theme
// stays this device's. The controller's own rules are pinned in
// packages/shared/test/ui-preferences.test.ts; this pins the till's wiring of
// it (adopted from /me, painted on the root, 'system' resolved against the
// device, a toggle written to PUT /me/preferences, nothing in browser
// storage) and the staff toggle's three states, rendered to markup.
import * as React from 'react';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ThemePreference } from '@oto/shared/ui-preferences';

// The till compiles JSX with the classic runtime (`jsx: preserve`), as eod-r1 does.
Object.assign(globalThis, { React });

const put = vi.fn(async (..._args: unknown[]) => ({ preferences: { theme: 'dark', language: 'en' } }));
vi.mock('@/api/client', () => ({
  api: { put: (...args: unknown[]) => put(...args), get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
  idemKey: () => 'k',
  ApiError: class extends Error {},
}));

const { createStaffTheme } = await import('@/lib/themePref');
const { preferencesApi } = await import('@/api/platform');
const { ThemeToggle } = await import('@/components/shared/ThemeToggle');

function fakeRoot() {
  const classes = new Set<string>();
  return {
    classes,
    classList: {
      toggle(token: string, force?: boolean) {
        if (force) classes.add(token);
        else classes.delete(token);
        return Boolean(force);
      },
    },
  };
}

function build(dark: boolean) {
  const root = fakeRoot();
  let n = 0;
  const controller = createStaffTheme({
    root: () => root,
    colorScheme: () => ({ matches: dark }),
    write: (body, key) => preferencesApi.put(body, key),
    newKey: () => `key-${++n}`,
  });
  return { controller, root };
}

beforeEach(() => put.mockClear());

describe('the staff theme on the till (SCRUM-653)', () => {
  it('shows light at the lock screen, before anyone is known', () => {
    const { controller, root } = build(true);
    expect(controller.resolved()).toBe('light');
    expect(root.classes.has('light')).toBe(true);
  });

  it("adopts the account's choice at sign-in and maps 'system' to the device", () => {
    const { controller, root } = build(true);
    controller.adopt({ theme: 'system' });
    expect(controller.preference()).toBe('system');
    expect(root.classes.has('dark')).toBe(true);
    controller.adopt({ theme: 'light' });
    expect(root.classes.has('light')).toBe(true);
    expect(root.classes.has('dark')).toBe(false);
  });

  it('writes the staff toggle to PUT /me/preferences, and nothing after the shift ends', () => {
    const { controller } = build(false);
    controller.adopt({ theme: 'light' });
    controller.set('dark');
    expect(put).toHaveBeenCalledWith('/me/preferences', { theme: 'dark' }, { idempotencyKey: 'key-1' });
    controller.release();
    controller.set('system');
    expect(put).toHaveBeenCalledTimes(1);
  });

  it('puts nothing in browser storage', () => {
    const setItem = vi.fn();
    vi.stubGlobal('localStorage', { setItem, getItem: vi.fn(), removeItem: vi.fn() });
    vi.stubGlobal('sessionStorage', { setItem, getItem: vi.fn(), removeItem: vi.fn() });
    const { controller } = build(false);
    controller.adopt({ theme: 'dark' });
    controller.set('system');
    expect(setItem).not.toHaveBeenCalled();
  });
});

describe("the staff row's toggle, in each of its three states", () => {
  const cases: Array<[ThemePreference, ThemePreference, string]> = [
    ['light', 'dark', 'lucide-sun'],
    ['dark', 'system', 'lucide-moon'],
    ['system', 'light', 'lucide-monitor'],
  ];
  for (const [theme, next, icon] of cases) {
    it(`shows ${theme} and offers ${next}`, () => {
      const html = renderToStaticMarkup(
        createElement(ThemeToggle, { theme, next, onToggle: () => {}, label: 'Staff' }),
      );
      expect(html).toContain(`title="Staff theme: ${theme} — tap for ${next}"`);
      expect(html).toContain(`aria-label="Switch staff theme to ${next}"`);
      expect(html).toContain(`data-theme-preference="${theme}"`);
      expect(html).toContain(icon);
    });
  }
});
