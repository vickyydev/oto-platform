import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { inboxRoutingApi, openInboxSettings, type InboxSetting, type RuleCreate } from '@/api/inbox-routing';
import { readHandoffTarget } from '@oto/shared/handoff-target';

const fetcher = vi.fn<typeof fetch>();
const assign = vi.fn();
beforeEach(() => {
  fetcher.mockReset(); assign.mockReset();
  vi.stubGlobal('fetch', fetcher);
  vi.stubGlobal('window', { location: { assign }, dispatchEvent: vi.fn() });
});
afterEach(() => vi.unstubAllGlobals());
const answer = (body: unknown) => fetcher.mockResolvedValueOnce(new Response(JSON.stringify(body), { status: 200 }));

describe('Admin routing management transport', () => {
  it('reads routing-owned collections without unrelated account or park directories', async () => {
    answer({ teams: [], branches: [], departments: [], accounts: [], teamReferences: [], operatorWide: false });
    await inboxRoutingApi.teams();
    answer({ rules: [] }); await inboxRoutingApi.rules();
    expect(fetcher.mock.calls.map(([path]) => path)).toEqual(['/api/inbox/teams', '/api/inbox/routing-rules']);
    expect(fetcher.mock.calls.every(([, options]) => options?.method === 'GET')).toBe(true);
  });

  it('keeps nullable wildcard scopes, signed priority and a caller-owned retry key across writes', async () => {
    const body: RuleCreate = { teamId: 'zz-team', category: 'birthdays', language: 'custom-LANG', branchId: null,
      primaryKind: 'account', primaryAccountId: 'zz-primary', backupAccountId: 'zz-backup', autoAddBackup: true, priority: -10, active: true };
    answer({ rule: {} }); await inboxRoutingApi.createRule(body, 'zz-same-intent');
    answer({ rule: {} }); await inboxRoutingApi.createRule(body, 'zz-same-intent');
    for (const [path, options] of fetcher.mock.calls) {
      expect(path).toBe('/api/inbox/routing-rules');
      expect(options?.method).toBe('POST');
      expect(options?.headers).toHaveProperty('idempotency-key', 'zz-same-intent');
      expect(JSON.parse(String(options?.body))).toEqual(body);
    }
  });

  it('uses exact metadata/rule paths and archives through DELETE with a key', async () => {
    answer({ team: {} });
    await inboxRoutingApi.createTeam({ key: 'reception', branchId: 'zz-park', name: 'ZZ TEST Team', colour: 'sky', departmentId: null, sortOrder: -1 }, 'zz-create');
    answer({ team: {} }); await inboxRoutingApi.editTeam('zz/team', { name: 'ZZ TEST Renamed', departmentId: null }, 'zz-edit');
    answer({ rule: {} }); await inboxRoutingApi.editRule('zz/rule', { language: null, branchId: null, primaryKind: 'team', primaryAccountId: null }, 'zz-rule');
    answer({ ok: true }); await inboxRoutingApi.archiveRule('zz/rule', 'zz-archive');
    expect(fetcher.mock.calls.map(([path, options]) => [path, options?.method])).toEqual([
      ['/api/inbox/teams', 'POST'], ['/api/inbox/teams/zz%2Fteam', 'PATCH'],
      ['/api/inbox/routing-rules/zz%2Frule', 'PATCH'], ['/api/inbox/routing-rules/zz%2Frule', 'DELETE'],
    ]);
    expect(fetcher.mock.calls[3]![1]?.headers).toHaveProperty('idempotency-key', 'zz-archive');
    expect(fetcher.mock.calls[3]![1]?.body).toBeUndefined();
  });
});

describe('Admin acting-user Inbox settings links', () => {
  it.each([
    ['numbers', '/?settings=assistant&section=numbers'],
    ['templates', '/?settings=templates'],
    ['knowledge', '/?settings=assistant&section=knowledge'],
    ['examples', '/?settings=assistant&section=examples'],
  ] as [InboxSetting, string][])('hands off only the selected existing %s page', async (kind, target) => {
    expect(fetcher).not.toHaveBeenCalled();
    answer({ launchUrl: 'https://inbox.test/#handoff=ZZ-TEST-opaque' });
    await openInboxSettings(kind, () => true);
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, options] = fetcher.mock.calls[0]!;
    expect(url).toBe('/api/auth/handoff');
    expect(options?.method).toBe('POST');
    expect(JSON.parse(String(options?.body))).toEqual({ app: 'inbox' });
    expect(options?.headers).toHaveProperty('idempotency-key', expect.any(String));
    expect(assign).toHaveBeenCalledTimes(1);
    expect(readHandoffTarget(new URL(String(assign.mock.calls[0]![0])).hash)).toBe(target);
  });

  it('does not issue a handoff for an ended authority or navigate after a late reply', async () => {
    await openInboxSettings('templates', () => false);
    expect(fetcher).not.toHaveBeenCalled();
    let resolve!: (response: Response) => void;
    fetcher.mockReturnValueOnce(new Promise(done => { resolve = done; }));
    let current = true;
    const pending = openInboxSettings('knowledge', () => current);
    current = false;
    resolve(new Response(JSON.stringify({ launchUrl: 'https://inbox.test/#handoff=ZZ-TEST-opaque' }), { status: 200 }));
    await pending;
    expect(assign).not.toHaveBeenCalled();
  });

  it('shows a missing destination and sanitizes browser navigation errors', async () => {
    answer({});
    await expect(openInboxSettings('numbers', () => true)).rejects.toThrow('Inbox has no configured destination.');
    expect(assign).not.toHaveBeenCalled();
    assign.mockImplementationOnce(() => { throw new Error('ZZ TEST one-use destination'); });
    answer({ launchUrl: 'https://inbox.test/#handoff=ZZ-TEST-opaque' });
    await expect(openInboxSettings('numbers', () => true)).rejects.toThrow('Inbox settings could not be opened. Please try again.');
  });

  it('preserves a server refusal without trying to navigate', async () => {
    fetcher.mockResolvedValueOnce(new Response(JSON.stringify({ error: { code: 'PERMISSION_DENIED', message: 'ZZ TEST Inbox access refused.' } }), { status: 403 }));
    await expect(openInboxSettings('examples', () => true)).rejects.toThrow('ZZ TEST Inbox access refused.');
    expect(assign).not.toHaveBeenCalled();
  });
});
