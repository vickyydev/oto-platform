// @vitest-environment jsdom
//
// SCRUM-1016 — the app bar's controls in a DOM: the account menu opens with
// focus on its first entry, moves with the arrow keys, Home and End, closes
// on Escape, Tab, a choice or a press outside and gives focus back to its
// button; a theme choice keeps it open; the simulator panel's way back is
// offered only where the panel shows. The figures' "More figures" panel opens
// from the row, takes focus, and Escape returns it. On a phone the search is
// a button that opens a field, and closing it clears the search.
//
// FICTIONAL TEST DATA: the viewer is "ZZ TEST".
import { act, createElement, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Dashboard as DashboardData, InboxMe } from '@/api/inbox';
import { AccountMenu, AppBar, type AccountMenuProps } from '@/components/AppBar';
import { StatsRow } from '@/components/StatsRow';

const me: InboxMe = {
  accountId: '018f0000-0000-7000-8000-000000000001',
  name: 'ZZ TEST viewer',
  roles: ['owner'],
  tabs: ['team', 'handled'],
  teams: [],
  people: [],
  defaultReceptionBranchId: null,
  simulator: { channelAccounts: [] },
  capabilities: { writes: true, dashboard: true, assign: true, move: true, reopen: true, templates: true, kb: true, ai: false },
};

const data: DashboardData = {
  scope: 'mine', newToday: 2, unanswered: 4, handledToday: 6, active: 9, averageFirstResponseSeconds: 90, population: 'active',
  byCategory: { birthdays: 3, general: 4, marketing: 1, gm: 1 }, day: '2026-11-19', beosThisWeek: 1, weekStart: '2026-11-16',
};

let host: HTMLDivElement;
let root: Root | null = null;
let wide = true;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  wide = true;
  vi.stubGlobal('matchMedia', (query: string) => ({ matches: wide && query.includes('1280'), addEventListener: vi.fn(), removeEventListener: vi.fn() }));
  host = document.createElement('div');
  document.body.appendChild(host);
});
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null;
  host.remove();
  vi.unstubAllGlobals();
});

async function mount(el: ReactElement) {
  root = createRoot(host);
  await act(async () => root!.render(el));
}
const key = async (target: Element, k: string) =>
  act(async () => {
    target.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
  });
const click = async (target: Element) =>
  act(async () => {
    (target as HTMLElement).click();
  });
const focusedText = () => document.activeElement?.textContent?.trim();

function menuProps(over: Partial<AccountMenuProps> = {}): AccountMenuProps {
  return {
    me, theme: 'light', onTheme: vi.fn(), settings: null, onSettings: vi.fn(), showSimulator: true, onShowSimulator: vi.fn(),
    launcherUrl: 'https://suite.example.invalid/', onSignOut: vi.fn(), ...over,
  };
}
const accountButton = () => host.querySelector<HTMLButtonElement>('button[aria-haspopup="menu"]')!;
const menu = () => host.querySelector('[role="menu"]');

describe('the account menu', () => {
  it('opens on the first entry, moves with the arrows, Home and End, and wraps', async () => {
    await mount(createElement(AccountMenu, menuProps()));
    expect(accountButton().getAttribute('aria-label')).toBe('Your account: ZZ TEST viewer, Owner view');
    expect(menu()).toBeNull();
    await click(accountButton());
    expect(accountButton().getAttribute('aria-expanded')).toBe('true');
    expect(focusedText()).toBe('Templates');
    await key(document.activeElement!, 'ArrowDown');
    expect(focusedText()).toBe('Assistant');
    await key(document.activeElement!, 'End');
    expect(focusedText()).toBe('Sign out');
    await key(document.activeElement!, 'ArrowDown');
    expect(focusedText()).toBe('Templates');
    await key(document.activeElement!, 'ArrowUp');
    expect(focusedText()).toBe('Sign out');
    await key(document.activeElement!, 'Home');
    expect(focusedText()).toBe('Templates');
  });

  it('closes on Escape and on Tab, giving focus back to its button', async () => {
    await mount(createElement(AccountMenu, menuProps()));
    for (const k of ['Escape', 'Tab']) {
      await click(accountButton());
      expect(menu()).not.toBeNull();
      await key(document.activeElement!, k);
      expect(menu()).toBeNull();
      expect(document.activeElement).toBe(accountButton());
    }
  });

  it('opens from the keyboard with ArrowDown', async () => {
    await mount(createElement(AccountMenu, menuProps()));
    await key(accountButton(), 'ArrowDown');
    expect(menu()).not.toBeNull();
    expect(focusedText()).toBe('Templates');
  });

  it('a choice closes the menu, focus back on the button, then acts', async () => {
    const props = menuProps();
    await mount(createElement(AccountMenu, props));
    await click(accountButton());
    const templates = [...host.querySelectorAll('[role="menuitem"]')].find((b) => b.textContent === 'Templates')!;
    await click(templates);
    expect(props.onSettings).toHaveBeenCalledWith('templates');
    expect(menu()).toBeNull();
    expect(document.activeElement).toBe(accountButton());
    await click(accountButton());
    await click([...host.querySelectorAll('[role="menuitem"]')].find((b) => b.textContent === 'Sign out')!);
    expect(props.onSignOut).toHaveBeenCalledTimes(1);
    expect(menu()).toBeNull();
  });

  it('a theme choice keeps the menu open, so the change is seen', async () => {
    const props = menuProps();
    await mount(createElement(AccountMenu, props));
    await click(accountButton());
    await click([...host.querySelectorAll('[role="menuitemradio"]')].find((b) => b.textContent === 'Dark')!);
    expect(props.onTheme).toHaveBeenCalledWith('dark');
    expect(menu()).not.toBeNull();
  });

  it('closes on a press outside', async () => {
    await mount(createElement(AccountMenu, menuProps()));
    await click(accountButton());
    await act(async () => {
      document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    });
    expect(menu()).toBeNull();
  });

  it('offers the simulator panel’s way back only where the panel shows (1280 px and wider)', async () => {
    const props = menuProps();
    await mount(createElement(AccountMenu, props));
    await click(accountButton());
    const back = [...host.querySelectorAll('[role="menuitem"]')].find((b) => b.textContent === 'Show simulator')!;
    expect(back).toBeTruthy();
    await click(back);
    expect(props.onShowSimulator).toHaveBeenCalledTimes(1);
    await act(async () => root!.unmount());
    wide = false;
    root = createRoot(host);
    await act(async () => root!.render(createElement(AccountMenu, menuProps())));
    await click(accountButton());
    expect(host.textContent).not.toContain('Show simulator');
    // Every entry rendered is one the arrows reach.
    await key(document.activeElement!, 'End');
    expect(focusedText()).toBe('Sign out');
  });
});

describe('the figures’ "More figures" panel', () => {
  it('opens from the row with focus inside, and Escape closes it, focus back on the row', async () => {
    await mount(createElement(StatsRow, { variant: 'card', data, error: null, unansweredOnly: false, onToggleUnanswered: vi.fn() }));
    const row = host.querySelector<HTMLButtonElement>('button[aria-haspopup="dialog"]')!;
    await click(row);
    const panel = host.querySelector<HTMLElement>('[role="dialog"]')!;
    expect(panel.getAttribute('aria-label')).toBe('More figures');
    expect(row.getAttribute('aria-expanded')).toBe('true');
    expect(document.activeElement).toBe(panel);
    expect(panel.textContent).toContain('your average');
    await key(panel, 'Escape');
    expect(host.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(row);
  });

  it('the Needs reply figure is the toggle', async () => {
    const toggle = vi.fn();
    await mount(createElement(StatsRow, { variant: 'bar', data, error: null, unansweredOnly: true, onToggleUnanswered: toggle }));
    const needs = host.querySelector<HTMLButtonElement>('button[aria-pressed]')!;
    expect(needs.textContent).toBe('4Needs reply');
    expect(needs.getAttribute('aria-pressed')).toBe('true');
    await click(needs);
    expect(toggle).toHaveBeenCalledTimes(1);
  });
});

describe('the phone search', () => {
  it('a button opens the field; closing it clears the search', async () => {
    const onSearch = vi.fn();
    await mount(createElement(AppBar, { search: '', onSearch, account: null }));
    const open = host.querySelector<HTMLButtonElement>('button[aria-label="Open search"]')!;
    expect(host.querySelectorAll('input[aria-label="Search"]')).toHaveLength(1); // the 768 px and wider field
    await click(open);
    expect(host.querySelectorAll('input[aria-label="Search"]')).toHaveLength(2);
    expect(host.querySelector('button[aria-label="Open search"]')).toBeNull();
    await click(host.querySelector('button[aria-label="Close search"]')!);
    expect(onSearch).toHaveBeenCalledWith('');
    expect(host.querySelectorAll('input[aria-label="Search"]')).toHaveLength(1);
  });

  it('stays open while a search is applied', async () => {
    await mount(createElement(AppBar, { search: 'ZZ TEST', onSearch: vi.fn(), account: null }));
    expect(host.querySelector('button[aria-label="Close search"]')).not.toBeNull();
  });
});
