// @vitest-environment jsdom
//
// SCRUM-793 — "Sessions on this account" on the launcher's account page, in a
// DOM: the first page of ten, newest first, with the count line; Next asks the
// api for the following page and shows it; the words are Active, Locked and
// Ended (a session past its end reads Ended with when, never Active); and the
// row of the device the page is read on is marked.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AccountSessionRow, AccountSessionsPage } from '@/api/platform';

const ACCOUNT = '01964800-0000-7000-8000-0000000007a1';
const TZ = 'Asia/Bangkok';

const sessionsCall = vi.hoisted(() => vi.fn());
vi.mock('@/api/platform', async (load) => {
  const real = await load<typeof import('@/api/platform')>();
  return {
    ...real,
    accountApi: {
      ...real.accountApi,
      sessions: (...args: unknown[]) => sessionsCall(...args),
      impersonations: async () => ({ impersonations: [] }),
      handoffRejections: async () => ({ entries: [] }),
    },
  };
});
vi.mock('@/auth/SessionContext', () => ({
  useSession: () => ({
    me: {
      account: { id: ACCOUNT, phone: '+66999079301', status: 'active', mustChangePassword: false, operatorId: ACCOUNT },
      employee: { id: ACCOUNT, name: 'ZZ Owner', nickname: null },
      branch: { id: ACCOUNT, name: 'Central Floresta', code: 'hkt-central', timezone: TZ },
      isPlatformAdmin: false,
      photoFileId: null,
      sessionLocked: false,
    },
    has: () => true,
    signOut: vi.fn(),
    locked: false,
  }),
  displayName: () => 'ZZ Owner',
}));
vi.mock('@/components/SuiteHeader', () => ({ SuiteHeader: () => null }));

const { Account } = await import('@/pages/Account');
const { AccountSessionsList, sessionsCountLine } = await import('@/components/AccountSessions');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const NOW = Date.parse('2026-11-09T05:00:00Z');
const HOUR = 3600_000;

function row(n: number, over: Partial<AccountSessionRow> = {}): AccountSessionRow {
  const created = new Date(NOW - n * HOUR).toISOString();
  return {
    id: `01964800-0000-7000-8000-${String(n).padStart(12, '0')}`,
    branchId: null,
    stationId: null,
    lockedAt: null,
    lastSeenAt: created,
    expiresAt: new Date(NOW + 12 * HOUR).toISOString(),
    createdAt: created,
    status: 'active',
    endedAt: null,
    current: false,
    ...over,
  };
}

/** 23 sessions, newest first; the oldest ended on 7 November and must say so. */
const ALL: AccountSessionRow[] = Array.from({ length: 23 }, (_, i) => row(i + 1));
ALL[0] = row(1, { current: true });
ALL[1] = row(2, { status: 'locked', lockedAt: new Date(NOW - HOUR).toISOString() });
ALL[22] = row(60, {
  status: 'ended',
  expiresAt: '2026-11-07T10:00:00.000Z',
  endedAt: '2026-11-07T10:00:00.000Z',
});

function pageAt(offset: number, limit = 10): AccountSessionsPage {
  return { sessions: ALL.slice(offset, offset + limit), total: ALL.length, limit, offset };
}

let host: HTMLDivElement, root: Root;
beforeEach(() => {
  sessionsCall.mockReset();
  sessionsCall.mockImplementation(async (_id: string, page: { limit: number; offset: number }) =>
    pageAt(page.offset, page.limit),
  );
  host = document.createElement('div');
  document.body.replaceChildren(host);
  root = createRoot(host);
});
afterEach(() => act(() => root.unmount()));

const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });
const list = () => host.querySelector('[data-testid="account-sessions"]')!;
const count = () => host.querySelector('[data-testid="account-sessions-count"]')!.textContent;
const button = (name: string) =>
  [...host.querySelectorAll('button')].find((b) => b.textContent?.trim() === name) as HTMLButtonElement;

describe("the account page's sessions, a page at a time (SCRUM-793)", () => {
  it('asks for ten, shows the newest ten with the count, and Next shows the following page', async () => {
    act(() => root.render(<Account />));
    await flush();
    expect(sessionsCall).toHaveBeenCalledWith(ACCOUNT, { limit: 10, offset: 0 });
    expect(list().querySelectorAll('li')).toHaveLength(10);
    expect(count()).toBe('Showing 1–10 of 23');
    expect(button('Previous').disabled).toBe(true);
    expect(button('Next').disabled).toBe(false);

    act(() => button('Next').click());
    await flush();
    expect(sessionsCall).toHaveBeenLastCalledWith(ACCOUNT, { limit: 10, offset: 10 });
    expect(count()).toBe('Showing 11–20 of 23');
    expect(list().querySelector('li')!.getAttribute('data-status')).toBe('active');

    act(() => button('Next').click());
    await flush();
    expect(count()).toBe('Showing 21–23 of 23');
    expect(list().querySelectorAll('li')).toHaveLength(3);
    expect(button('Next').disabled).toBe(true);

    act(() => button('Previous').click());
    await flush();
    expect(sessionsCall).toHaveBeenLastCalledWith(ACCOUNT, { limit: 10, offset: 10 });
    expect(count()).toBe('Showing 11–20 of 23');
  });

  it('keeps the page on screen when the next one cannot be read', async () => {
    act(() => root.render(<Account />));
    await flush();
    sessionsCall.mockRejectedValueOnce(new Error('offline'));
    act(() => button('Next').click());
    await flush();
    expect(count()).toBe('Showing 1–10 of 23');
    expect(button('Next').disabled).toBe(false);
  });
});

describe('the status words and this device (SCRUM-793)', () => {
  const render = (page: AccountSessionsPage) =>
    act(() => root.render(<AccountSessionsList page={page} timezone={TZ} loading={false} onPage={() => {}} />));

  it('reads Active, Locked and Ended, and an ended session gives when it ended', () => {
    render({ sessions: [ALL[0]!, ALL[1]!, ALL[22]!], total: 3, limit: 10, offset: 0 });
    const rows = [...list().querySelectorAll('li')];
    expect(rows.map((li) => li.querySelector('span')!.textContent)).toEqual(['Active', 'Locked', 'Ended']);
    // In the branch's clock: 17:00 UTC on the 9th is midnight in Bangkok.
    expect(rows[0]!.textContent).toContain('ends 10 Nov, 00:00');
    expect(rows[2]!.textContent).toContain('ended 7 Nov, 17:00');
    expect(rows[2]!.textContent).not.toContain('Active');
    // One page only: the count, no controls.
    expect(count()).toBe('Showing 1–3 of 3');
    expect(host.querySelectorAll('button')).toHaveLength(0);
  });

  it("marks this device's row and no other", () => {
    render(pageAt(0));
    const marked = [...list().querySelectorAll('li')].filter((li) => li.textContent?.includes('This device'));
    expect(marked).toHaveLength(1);
    expect(marked[0]!.getAttribute('data-current')).toBe('true');
  });

  it('says which rows of how many a page is', () => {
    expect(sessionsCountLine({ offset: 0, total: 23, shown: 10 })).toBe('Showing 1–10 of 23');
    expect(sessionsCountLine({ offset: 20, total: 21, shown: 1 })).toBe('Showing 21 of 21');
    expect(sessionsCountLine({ offset: 30, total: 23, shown: 0 })).toBe('Showing 0 of 23');
  });
});
