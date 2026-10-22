import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ThemePreference } from '@oto/shared/ui-preferences';
import { SignInPanel } from '@/components/SignInPanel';

const state = vi.hoisted(() => ({ preference: 'light' as ThemePreference }));
vi.mock('@/auth/SessionContext', () => ({ useSession: () => ({ signIn: vi.fn(), handoffError: null }) }));
vi.mock('@/lib/theme', () => ({
  // Expose the old hook only inside this mock so the old screen fails on its
  // visible two-state behavior rather than on an import/setup error.
  useTheme: () => [state.preference, vi.fn()],
  useAccountTheme: () => ({ preference: state.preference, resolved: state.preference === 'dark' ? 'dark' : 'light', setPreference: vi.fn() }),
}));

describe('Console existing signed-out theme control', () => {
  beforeEach(() => { vi.stubGlobal('React', React); });
  const cases: Array<[ThemePreference, string, string]> = [
    ['light', 'Theme: Light — switch to dark', 'lucide-sun'],
    ['dark', 'Theme: Dark — switch to system', 'lucide-moon'],
    ['system', 'Theme: System — switch to light', 'lucide-monitor'],
  ];
  for (const [preference, title, icon] of cases) {
    it(`shows the existing control's current ${preference} choice and next action`, () => {
      state.preference = preference;
      const html = renderToStaticMarkup(React.createElement(SignInPanel));
      expect(html).toContain(`aria-label="${title}"`);
      expect(html).toContain(`data-theme-preference="${preference}"`);
      expect(html).toContain(icon);
      expect(html).toContain('Sign in');
    });
  }
});
