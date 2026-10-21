// SCRUM-653 — the launcher's theme follows the account. The controller's own
// rules are pinned in packages/shared/test/ui-preferences.test.ts; this pins
// the launcher's wiring of it (adopted from /me, painted on the root, 'system'
// resolved against the device, a toggle written to PUT /me/preferences) and
// the toggle's three states, rendered with react-dom/server.
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ThemePreference } from '@oto/shared/ui-preferences';

const put = vi.fn(async (..._args: unknown[]) => ({ preferences: { theme: 'dark', language: 'en' } }));
vi.mock('@/api/client', () => ({
  api: { put: (...args: unknown[]) => put(...args), get: vi.fn(), post: vi.fn(), patch: vi.fn() },
  ApiError: class extends Error {},
}));

const { createAccountTheme } = await import('@/lib/accountTheme');
const { preferencesApi } = await import('@/api/platform');
const { ThemeCycleButtonView, themeButtonTitle } = await import('@/components/ThemeCycleButton');

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
  const scheme = { matches: dark, addEventListener: vi.fn(), removeEventListener: vi.fn() };
  let n = 0;
  const controller = createAccountTheme({
    root: () => root,
    colorScheme: () => scheme,
    write: (body, key) => preferencesApi.put(body, key),
    newKey: () => `key-${++n}`,
  });
  return { controller, root };
}

beforeEach(() => put.mockClear());

describe('the launcher theme (SCRUM-653)', () => {
  it('shows light before sign-in and writes nothing for a signed-out toggle', () => {
    const { controller, root } = build(true);
    expect(controller.preference()).toBe('light');
    expect(root.classes.has('light')).toBe(true);
    controller.set('dark');
    expect(put).not.toHaveBeenCalled();
  });

  it("adopts the account's choice from /me and maps 'system' to the device", () => {
    const { controller, root } = build(true);
    controller.adopt({ theme: 'system' });
    expect(controller.preference()).toBe('system');
    expect(controller.resolved()).toBe('dark');
    expect(root.classes.has('dark')).toBe(true);
    expect(root.classes.has('light')).toBe(false);
  });

  it('writes a signed-in toggle to PUT /me/preferences with a replay key', () => {
    const { controller, root } = build(false);
    controller.adopt({ theme: 'light' });
    controller.set('dark');
    expect(root.classes.has('dark')).toBe(true);
    expect(put).toHaveBeenCalledWith('/me/preferences', { theme: 'dark' }, { idempotencyKey: 'key-1' });
  });

  it('stops writing after sign-out', () => {
    const { controller } = build(false);
    controller.adopt({ theme: 'light' });
    controller.release();
    controller.set('system');
    expect(put).not.toHaveBeenCalled();
  });
});

describe("the header's toggle, in each of its three states", () => {
  const cases: Array<[ThemePreference, string, string]> = [
    ['light', 'Theme: Light — switch to dark', 'lucide-sun'],
    ['dark', 'Theme: Dark — switch to system', 'lucide-moon'],
    ['system', 'Theme: System — switch to light', 'lucide-monitor'],
  ];
  for (const [preference, title, icon] of cases) {
    it(`shows ${preference} as the current choice`, () => {
      const html = renderToStaticMarkup(<ThemeCycleButtonView preference={preference} onChange={() => {}} />);
      expect(themeButtonTitle(preference)).toBe(title);
      expect(html).toContain(`title="${title}"`);
      expect(html).toContain(`aria-label="${title}"`);
      expect(html).toContain(`data-theme-preference="${preference}"`);
      expect(html).toContain(icon);
    });
  }
});
