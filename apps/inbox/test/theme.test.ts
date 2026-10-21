// SCRUM-653 — the dark theme's plumbing, pinned without a browser: the
// controller against a fake root and media query, and the header toggle
// rendered to markup. What is pinned: light when nothing is saved, the saved
// preference applied on init, `set` applying at once and writing back when
// the preferences route exists, a 404 from a not-yet-landed route held in
// memory, and `system` following the device through its change listener.
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ApiError } from '@/api/client';
import { ThemeToggle } from '@/components/Workspace';
import { createThemeController, nextTheme, resolvedDark, themeFromMe, themeTitle, type Theme, type ThemeEnv } from '@/lib/theme';

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

describe('the header toggle', () => {
  const render = (theme: Theme) => renderToStaticMarkup(createElement(ThemeToggle, { theme, onTheme: () => undefined }));

  it('renders one compact control naming the current theme and the next', () => {
    expect(render('light')).toContain(themeTitle('light'));
    expect(render('light')).toContain('switch to dark');
    expect(render('dark')).toContain('switch to system');
    expect(render('system')).toContain('switch to light');
  });

  it('is a button with the theme-appropriate icon', () => {
    for (const theme of ['light', 'dark', 'system'] as const) {
      const html = render(theme);
      expect(html).toContain('<button');
      expect(html).toContain('lucide');
    }
  });
});
