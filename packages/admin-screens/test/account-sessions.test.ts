// SCRUM-793 — the Login Users "Sessions" dialog a page at a time. The api
// answers ten sessions unless asked for more, newest sign-in first, with the
// total; the dialog asks for a page by limit and offset, says which rows of
// how many it shows, offers Previous / Next, and reads a session past its end
// as ended, never as one still signed in.
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { AdminApi } from '../src/api/admin-api';
import { SESSIONS_PAGE_SIZE, createAccountsApi, type SessionRow, type SessionsPage } from '../src/api/accounts';
import { AccountSessionsList, sessionEndWords, sessionsCountLine } from '../src/accounts/AccountSessionsList';

const HOUR = 3600_000;
const NOW = Date.parse('2026-11-09T05:00:00Z');
const when = (iso: string) => `at ${iso}`;

function row(n: number, over: Partial<SessionRow> = {}): SessionRow {
  const created = new Date(NOW - n * HOUR).toISOString();
  return {
    id: `01964800-0000-7000-8000-${String(n).padStart(12, '0')}`,
    branchId: null, stationId: null, lockedAt: null,
    lastSeenAt: created, expiresAt: new Date(NOW + 12 * HOUR).toISOString(), createdAt: created,
    status: 'active', endedAt: null, current: false,
    ...over,
  };
}

/** 23 sessions, newest first; the oldest ended on 7 November. */
const ALL: SessionRow[] = Array.from({ length: 23 }, (_, i) => row(i + 1));
ALL[1] = row(2, { status: 'locked', lockedAt: new Date(NOW - HOUR).toISOString() });
ALL[22] = row(60, { status: 'ended', expiresAt: '2026-11-07T10:00:00.000Z', endedAt: '2026-11-07T10:00:00.000Z' });

const pageAt = (offset: number, limit = SESSIONS_PAGE_SIZE): SessionsPage =>
  ({ sessions: ALL.slice(offset, offset + limit), total: ALL.length, limit, offset });

const html = (page: SessionsPage, loading = false) =>
  renderToStaticMarkup(createElement(AccountSessionsList, { page, loading, onPage: () => undefined, when }));
const rowsIn = (markup: string) => markup.match(/data-status="[a-z]+"/g) ?? [];
const button = (markup: string, label: string) => markup.match(new RegExp(`<button\\b[^>]*>(?:(?!</button>)[\\s\\S])*${label}(?:(?!</button>)[\\s\\S])*</button>`))?.[0];

describe('the Sessions dialog asks the api for one page', () => {
  it('sends a limit and an offset, ten from the newest unless told otherwise', async () => {
    const paths: string[] = [];
    const host: AdminApi = {
      get: async <T>(path: string) => { paths.push(path); return pageAt(0) as T; },
      post: async <T>() => ({}) as T, patch: async <T>() => ({}) as T, put: async <T>() => ({}) as T, delete: async <T>() => ({}) as T,
    };
    const accounts = createAccountsApi(host);
    await accounts.accountSessions('account/with space');
    await accounts.accountSessions('account/with space', { limit: SESSIONS_PAGE_SIZE, offset: 20 });
    expect(SESSIONS_PAGE_SIZE).toBe(10);
    expect(paths).toEqual([
      '/accounts/account%2Fwith%20space/sessions?limit=10&offset=0',
      '/accounts/account%2Fwith%20space/sessions?limit=10&offset=20',
    ]);
  });
});

describe('the Sessions dialog list, more than ten sessions', () => {
  it('shows the newest ten with the count line, and Next but no Previous', () => {
    const first = html(pageAt(0));
    expect(rowsIn(first)).toHaveLength(10);
    expect(first).toContain('Showing 1–10 of 23');
    expect(first).toContain(`last seen ${when(ALL[0]!.lastSeenAt)}`);
    expect(first).not.toContain(`last seen ${when(ALL[10]!.lastSeenAt)}`);
    expect(button(first, 'Previous')).toContain('disabled=""');
    expect(button(first, 'Next')).not.toContain('disabled=""');
  });

  it('shows the middle and the last page with both or only Previous', () => {
    const middle = html(pageAt(10));
    expect(rowsIn(middle)).toHaveLength(10);
    expect(middle).toContain('Showing 11–20 of 23');
    expect(button(middle, 'Previous')).not.toContain('disabled=""');
    expect(button(middle, 'Next')).not.toContain('disabled=""');
    const last = html(pageAt(20));
    expect(rowsIn(last)).toHaveLength(3);
    expect(last).toContain('Showing 21–23 of 23');
    expect(button(last, 'Previous')).not.toContain('disabled=""');
    expect(button(last, 'Next')).toContain('disabled=""');
  });

  it('holds both controls while the page asked for is on its way', () => {
    const waiting = html(pageAt(10), true);
    expect(button(waiting, 'Previous')).toContain('disabled=""');
    expect(button(waiting, 'Next')).toContain('disabled=""');
  });

  it('reads a session past its end as ended, with when, and a locked one as locked', () => {
    const last = html(pageAt(20));
    expect(last).toContain('data-status="ended"');
    expect(last).toMatch(/>ended<\/span>/);
    expect(last).toContain(`ended ${when('2026-11-07T10:00:00.000Z')}`);
    expect(last).not.toContain(`expires ${when('2026-11-07T10:00:00.000Z')}`);
    expect(sessionEndWords(ALL[22]!, when)).toBe(`ended ${when('2026-11-07T10:00:00.000Z')}`);
    expect(sessionEndWords(ALL[0]!, when)).toBe(`expires ${when(ALL[0]!.expiresAt)}`);

    const first = html(pageAt(0));
    expect(first).toContain('data-status="locked"');
    expect(first).toMatch(/>locked<\/span>/);
    expect(first).not.toMatch(/>ended<\/span>/);
    // A locked session whose end has passed is over, not waiting for a password.
    const over = html({ sessions: [row(1, { status: 'ended', lockedAt: new Date(NOW - HOUR).toISOString(), endedAt: new Date(NOW - HOUR).toISOString() })], total: 1, limit: 10, offset: 0 });
    expect(over).toMatch(/>ended<\/span>/);
    expect(over).not.toMatch(/>locked<\/span>/);
  });
});

describe('the Sessions dialog list, ten or fewer', () => {
  it('shows every one with the count and no controls', () => {
    const few = html({ sessions: ALL.slice(0, 3), total: 3, limit: 10, offset: 0 });
    expect(rowsIn(few)).toHaveLength(3);
    expect(few).toContain('Showing 1–3 of 3');
    expect(few).not.toContain('Previous');
    expect(few).not.toContain('Next');
  });

  it('says there are none when there are none', () => {
    const none = html({ sessions: [], total: 0, limit: 10, offset: 0 });
    expect(none).toContain('No sessions on record.');
    expect(none).not.toContain('Showing');
  });

  it('counts a page past the end as nothing of the total', () => {
    expect(sessionsCountLine({ offset: 30, total: 23, shown: 0 })).toBe('Showing 0 of 23');
    expect(sessionsCountLine({ offset: 0, total: 1, shown: 1 })).toBe('Showing 1 of 1');
  });
});
