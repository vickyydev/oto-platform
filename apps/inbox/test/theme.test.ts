// SCRUM-653 — the dark theme's plumbing, pinned without a browser: the
// controller against a fake root and media query, and the theme control
// rendered to markup. What is pinned: light when nothing is saved, the saved
// preference applied on init, `set` applying at once and writing back when
// the preferences route exists, a 404 from a not-yet-landed route held in
// memory, and `system` following the device through its change listener.
// SCRUM-1016 moved the control from the header's cycling icon into the
// account menu as three choices; its pins at the end follow it there.
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ApiError } from '@/api/client';
import { AccountMenuItems } from '@/components/AppBar';
import { createThemeController, nextTheme, resolvedDark, themeFromMe, type Theme, type ThemeEnv } from '@/lib/theme';

/** A fake `<html>` + `(prefers-color-scheme: dark)` + api, all observable. */
function env(overrides: Partial<ThemeEnv> & { systemDark?: boolean } = {}) {
  const classes = new Set<string>();
  const mediaListeners = new Set<() => void>();
  const written: Theme[] = [];
  const media = {
    matches: overrides.systemDark ?? false,
    addEventListener: (_: 'change', l: () => void) => void mediaListeners.add(l),
    removeEventListener: (_: 'change', l: () => void) => void mediaListeners.delete(l),
  };
  const e: ThemeEnv = {
    root: { classList: { toggle: (name, force) => void (force ? classes.add(name) : classes.delete(name)) } },
    media,
    readMe: overrides.readMe ?? (() => Promise.resolve({})),
    writePreference: overrides.writePreference ?? ((t) => (written.push(t), Promise.resolve())),
  };
  const flipSystem = (dark: boolean) => {
    media.matches = dark;
    for (const l of mediaListeners) l();
  };
  return { e, dark: () => classes.has('dark'), written, flipSystem, listeners: mediaListeners };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('the saved preference out of GET /me', () => {
  it('reads preferences.theme and nothing else', () => {
    expect(themeFromMe({ preferences: { theme: 'dark' } })).toBe('dark');
    expect(themeFromMe({ preferences: { theme: 'system' } })).toBe('system');
    expect(themeFromMe({ preferences: { theme: 'mauve' } })).toBeNull();
    expect(themeFromMe({ preferences: {} })).toBeNull();
    expect(themeFromMe({})).toBeNull();
    expect(themeFromMe(null)).toBeNull();
  });
});

describe('init', () => {
  it('starts light when the profile carries no preference', async () => {
    const { e, dark } = env();
    const c = createThemeController(e);
    await c.init();
    expect(c.theme()).toBe('light');
    expect(dark()).toBe(false);
  });

  it('applies the saved dark preference', async () => {
    const { e, dark } = env({ readMe: () => Promise.resolve({ preferences: { theme: 'dark' } }) });
    const c = createThemeController(e);
    await c.init();
    expect(c.theme()).toBe('dark');
    expect(dark()).toBe(true);
  });

  it('falls back to light when the read itself refuses', async () => {
    const { e, dark } = env({ readMe: () => Promise.reject(new ApiError(404, 'NOT_FOUND', 'No such route')) });
    const c = createThemeController(e);
    await c.init();
    expect(c.theme()).toBe('light');
    expect(dark()).toBe(false);
  });
});

describe('set', () => {
  it('applies at once and writes the preference back', async () => {
    const { e, dark, written } = env();
    const c = createThemeController(e);
    await c.init();
    c.set('dark');
    expect(dark()).toBe(true);
    await tick();
    expect(written).toEqual(['dark']);
  });

  it('holds in memory when the preferences route does not exist yet (404)', async () => {
    const { e, dark } = env({
      writePreference: () => Promise.reject(new ApiError(404, 'NOT_FOUND', 'No such route')),
    });
    const c = createThemeController(e);
    await c.init();
    c.set('dark');
    await tick();
    expect(c.theme()).toBe('dark');
    expect(dark()).toBe(true);
  });
});

describe('system', () => {
  it('maps to the device and follows its changes, only while chosen', async () => {
    const { e, dark, flipSystem } = env({ systemDark: true });
    const c = createThemeController(e);
    await c.init();
    c.set('system');
    expect(dark()).toBe(true);
    flipSystem(false);
    expect(dark()).toBe(false);
    flipSystem(true);
    expect(dark()).toBe(true);
    c.set('light');
    flipSystem(false);
    expect(dark()).toBe(false);
    flipSystem(true);
    // The device changing its mind no longer matters: the preference is light.
    expect(dark()).toBe(false);
  });

  it('dispose drops the device listener', () => {
    const { e, listeners } = env();
    const c = createThemeController(e);
    expect(listeners.size).toBe(1);
    c.dispose();
    expect(listeners.size).toBe(0);
  });
});

describe('the cycle and its words', () => {
  it('cycles light → dark → system → light', () => {
    expect(nextTheme('light')).toBe('dark');
    expect(nextTheme('dark')).toBe('system');
    expect(nextTheme('system')).toBe('light');
  });

  it('resolves what shows', () => {
    expect(resolvedDark('light', true)).toBe(false);
    expect(resolvedDark('dark', false)).toBe(true);
    expect(resolvedDark('system', true)).toBe(true);
    expect(resolvedDark('system', false)).toBe(false);
  });
});

describe('the theme in the account menu (SCRUM-1016)', () => {
  const me = {
    accountId: '018f0000-0000-7000-8000-000000000001',
    name: 'ZZ TEST viewer',
    roles: ['owner'],
    tabs: ['team', 'handled'],
    teams: [],
    people: [],
    defaultReceptionBranchId: null,
    simulator: null,
    capabilities: { writes: true, dashboard: true, assign: false, move: false, reopen: false, templates: false, kb: false, ai: false },
  } satisfies Parameters<typeof AccountMenuItems>[0]['me'];
  const props = (theme: Theme, onTheme: (t: Theme) => void = () => undefined): Parameters<typeof AccountMenuItems>[0] => ({
    me,
    theme,
    onTheme,
    settings: null,
    onSettings: () => undefined,
    showSimulator: false,
    onShowSimulator: () => undefined,
    onSignOut: () => undefined,
  });
  const render = (theme: Theme) => renderToStaticMarkup(createElement(AccountMenuItems, props(theme)));
  const LABEL: Record<Theme, string> = { light: 'Light', dark: 'Dark', system: 'System' };

  it('offers light, dark and system as one group, the current one checked', () => {
    for (const theme of ['light', 'dark', 'system'] as const) {
      const html = render(theme);
      expect(html).toContain('role="group" aria-label="Theme"');
      expect(html.match(/role="menuitemradio"/g)).toHaveLength(3);
      expect(html.match(/aria-checked="true"/g)).toHaveLength(1);
      const checked = html.match(/role="menuitemradio" aria-checked="true"[^>]*>([\s\S]*?)<\/button>/)![1]!;
      expect(checked).toContain(`>${LABEL[theme]}</span>`);
    }
  });

  it('is a button per theme with the theme-appropriate icon', () => {
    const items = render('light').match(/<button type="button" role="menuitemradio"[\s\S]*?<\/button>/g) ?? [];
    expect(items).toHaveLength(3);
    items.forEach((item, i) => {
      expect(item).toContain('lucide');
      expect(item).toContain(`>${LABEL[(['light', 'dark', 'system'] as const)[i]!]}</span>`);
    });
  });

  it('a press sets that theme, which the controller then applies and saves (see set, above)', () => {
    const chosen: Theme[] = [];
    const radios: Array<() => void> = [];
    const walk = (node: unknown): void => {
      if (Array.isArray(node)) return node.forEach(walk);
      if (!node || typeof node !== 'object' || !('props' in node)) return;
      const p = (node as { props: { role?: string; onClick?: () => void; children?: unknown } }).props;
      if (p.role === 'menuitemradio' && p.onClick) radios.push(p.onClick);
      walk(p.children);
    };
    walk(AccountMenuItems(props('light', (t) => chosen.push(t))));
    radios.forEach((press) => press());
    expect(chosen).toEqual(['light', 'dark', 'system']);
  });
});
