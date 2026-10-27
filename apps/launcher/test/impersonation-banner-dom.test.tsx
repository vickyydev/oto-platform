// @vitest-environment jsdom
//
// SCRUM-648 — the launcher's view-as banner in a DOM: mounted with a window it
// shows both names and the countdown and moves the page below itself (the
// header starts under the banner, never beneath it); with no window it draws
// nothing and leaves the page where it was; it goes, and gives the space back,
// when the window ends. jsdom lays nothing out, so "not covering" is checked
// the way the browser decides it: the banner is fixed at one height and the
// page's own stylesheet pads the body by exactly that height while it shows.
import { act } from 'react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const session = vi.hoisted(() => ({ value: { me: null as unknown } }));
vi.mock('@/auth/SessionContext', () => ({ useSession: () => session.value }));
const { ImpersonationBanner, VIEW_AS_ACTIVE } = await import('@/components/ImpersonationBanner');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const win = {
  id: '01964800-0000-7000-8000-0000000000c1',
  actor: { accountId: '01964800-0000-7000-8000-0000000000a1', name: 'ZZ Admin' },
  subject: { accountId: '01964800-0000-7000-8000-0000000000a2', name: 'ZZ Reception' },
  targetApp: 'pos' as const, mode: 'read_only' as const, expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
};

let host: HTMLDivElement, root: Root;
beforeEach(() => {
  const css = readFileSync(join(process.cwd(), 'src', 'index.css'), 'utf8');
  const style = document.createElement('style');
  // Only the plain-CSS block: jsdom cannot parse the Tailwind directives above it.
  style.textContent = css.slice(css.indexOf('html.view-as-active {'));
  document.head.replaceChildren(style);
  host = document.createElement('div');
  document.body.replaceChildren(host);
  root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); document.documentElement.className = ''; });

function mount(me: unknown) {
  session.value = { me };
  act(() => root.render(<><ImpersonationBanner /><header data-testid="header"><button>Account</button></header></>));
}

describe('the launcher banner in a DOM (SCRUM-648)', () => {
  it('draws nothing and leaves the page in place without a window', () => {
    mount({ impersonation: null, impersonating: [] });
    expect(document.querySelector('[data-testid="impersonation-banner"]')).toBeNull();
    expect(document.documentElement.classList.contains(VIEW_AS_ACTIVE)).toBe(false);
    expect(getComputedStyle(document.body).paddingTop).toBe('');
  });

  it('shows both names and the countdown, fixed above the page, and pads the page by its height', () => {
    mount({ impersonation: null, impersonating: [win] });
    const banner = document.querySelector('[data-testid="impersonation-banner"]')!;
    expect(banner.textContent).toContain('You (ZZ Admin) are viewing POS as ZZ Reception');
    expect(banner.textContent).toMatch(/ends in (10:00|9:5\d)/);
    expect(banner.querySelector('button')).toBeNull();
    expect(banner.className).toContain('fixed');
    expect(banner.className).toContain('h-9');
    expect(document.documentElement.classList.contains(VIEW_AS_ACTIVE)).toBe(true);
    // The body starts below the 2.25rem banner, so the header's first control sits under nothing.
    expect(getComputedStyle(document.body).paddingTop).toBe('var(--view-as-offset)');
    expect(getComputedStyle(document.documentElement).getPropertyValue('--view-as-offset').trim()).toBe('2.25rem');
    expect(banner.compareDocumentPosition(document.querySelector('[data-testid="header"]')!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('gives the space back when the window ends', () => {
    mount({ impersonation: null, impersonating: [win] });
    expect(document.documentElement.classList.contains(VIEW_AS_ACTIVE)).toBe(true);
    mount({ impersonation: null, impersonating: [] });
    expect(document.documentElement.classList.contains(VIEW_AS_ACTIVE)).toBe(false);
    expect(getComputedStyle(document.body).paddingTop).toBe('');
  });
});
