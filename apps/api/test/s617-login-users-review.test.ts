import { fileURLToPath } from 'node:url';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const client = vi.hoisted(() => ({ post: vi.fn(), idemKey: vi.fn() }));
vi.mock('../../pos/src/api/client', () => ({ api: { post: client.post }, idemKey: client.idemKey }));

// The API compiler has no browser library. A runtime module path keeps the
// existing POS fetch client's DOM declarations out of this test's type graph;
// the real helper still runs, with its sole network boundary replaced above.
const helperPath = fileURLToPath(new URL('../../pos/src/api/admin-entry.ts', import.meta.url));
let destination: () => Promise<string>;

beforeAll(async () => {
  const loaded: unknown = await import(helperPath);
  if (typeof loaded !== 'object' || loaded === null || !('adminAccountsDestination' in loaded) ||
    typeof loaded.adminAccountsDestination !== 'function') {
    throw new Error('The Admin account destination helper is not exported.');
  }
  destination = loaded.adminAccountsDestination as () => Promise<string>;
});

beforeEach(() => {
  client.post.mockReset();
  client.idemKey.mockReset();
  let action = 0;
  client.idemKey.mockImplementation(() => `00000000-0000-4000-8000-${String(++action).padStart(12, '0')}`);
});

async function rejectedDestination(): Promise<Error> {
  try {
    await destination();
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    return error as Error;
  }
  throw new Error('An unavailable Admin destination unexpectedly resolved.');
}

describe('SCRUM-617 independent review of the POS account-management entry', () => {
  it('R1 [high] keeps the issued origin, base, query and fragment; fix: append only the fixed Accounts fragment target', async () => {
    client.post.mockResolvedValueOnce({
      launchUrl: 'https://configured-admin.example.test/console/base/?deployment=blue#handoff=fixture-claim&issued=pos',
      token: 'unused-separate-fixture-field',
    });

    expect(await destination()).toBe(
      'https://configured-admin.example.test/console/base/?deployment=blue#handoff=fixture-claim&issued=pos&to=%2Fpeople%2Faccounts',
    );
  });

  it('R2 [high] sends only the console audience with a fresh action key; fix: keep the path and account data out of the handoff request', async () => {
    client.post.mockResolvedValue({ launchUrl: 'http://configured-admin.example.test/#handoff=fixture-claim' });

    await destination();
    await destination();

    expect(client.post.mock.calls).toEqual([
      ['/auth/handoff', { app: 'console' }, { idempotencyKey: '00000000-0000-4000-8000-000000000001' }],
      ['/auth/handoff', { app: 'console' }, { idempotencyKey: '00000000-0000-4000-8000-000000000002' }],
    ]);
    expect(client.idemKey).toHaveBeenCalledTimes(2);
  });

  it('R3 [high] refuses missing or malformed destinations despite a separate token; fix: never reconstruct or guess an app address', async () => {
    const responses: unknown[] = [undefined, null, 'unexpected', [], {},
      { token: 'unused-separate-fixture-field' },
      { launchUrl: null, token: 'unused-separate-fixture-field' },
      { launchUrl: 1 }, { launchUrl: {} }, { launchUrl: '' }, { launchUrl: '   ' }];

    for (const response of responses) {
      client.post.mockResolvedValueOnce(response);
      const error = await rejectedDestination();
      expect(error.message.trim()).not.toBe('');
      expect(`${error.message}${JSON.stringify(error)}`).not.toContain('unused-separate-fixture-field');
    }
    expect(client.post).toHaveBeenCalledTimes(responses.length);
  });

  it('R4 [high] refuses unsafe or credential-free launch URLs without exposing them; fix: validate HTTP origin and handoff then return a generic destination error', async () => {
    const launchUrls = [
      '/#handoff=fixture-claim',
      '//configured-admin.example.test/#handoff=fixture-claim',
      'javascript:alert(1)#handoff=fixture-claim',
      'data:text/plain,fixture#handoff=fixture-claim',
      'https://fixture-user@configured-admin.example.test/#handoff=fixture-claim',
      'https://configured-admin.example.test/',
      'https://configured-admin.example.test/?handoff=fixture-claim',
      'https://configured-admin.example.test/#other=fixture-claim',
      'https://configured-admin.example.test/#handoff=',
      'https://configured-admin.example.test/#handoff=&issued=pos',
      'https://configured-admin.example.test/#handoff=%20',
      'https://configured-admin.example.test/#handoff=fixture-claim&to=%2Fdevices',
      'https://configured-admin.example.test/#to=&handoff=fixture-claim',
      'https://configured-admin.example.test/#handoff=fixture-claim&%74o=%2Fdevices',
      'https://configured-admin.example.test/#handoff=fixture-claim&to=%2Fdevices&to=%2Fpeople%2Faccounts',
      'https://[invalid-host]/#handoff=fixture-claim',
    ];

    for (const launchUrl of launchUrls) {
      client.post.mockResolvedValueOnce({ launchUrl });
      const error = await rejectedDestination();
      const exposed = `${error.message}${JSON.stringify(error)}`;
      expect(error.message.trim()).not.toBe('');
      expect(exposed).not.toContain(launchUrl);
      expect(exposed).not.toContain('fixture-claim');
      expect(exposed).not.toContain('fixture-user');
    }
    expect(client.post).toHaveBeenCalledTimes(launchUrls.length);
  });

  it('R5 [high] preserves refusal and connection failures with no fallback request; fix: leave existing server authorization authoritative', async () => {
    const failures = [
      Object.assign(new Error('Sign in again.'), { status: 401, code: 'UNAUTHORIZED' }),
      Object.assign(new Error('This account cannot open Admin.'), { status: 403, code: 'FORBIDDEN' }),
      Object.assign(new Error('Admin is not configured here.'), { status: 400, code: 'HANDOFF_APP_UNKNOWN' }),
      new Error('No answer from the platform.'),
    ];
    for (const failure of failures) {
      client.post.mockRejectedValueOnce(failure);
      await expect(destination()).rejects.toBe(failure);
    }
    expect(client.post).toHaveBeenCalledTimes(failures.length);
  });

  it('R6 [medium] keeps overlapping replies attached to their own explicit action; fix: do not cache a prior claim or share mutable destination state', async () => {
    let finishFirst!: (value: { launchUrl: string }) => void;
    let finishSecond!: (value: { launchUrl: string }) => void;
    client.post.mockReturnValueOnce(new Promise<{ launchUrl: string }>(resolve => { finishFirst = resolve; }));
    client.post.mockReturnValueOnce(new Promise<{ launchUrl: string }>(resolve => { finishSecond = resolve; }));

    const first = destination(), second = destination();
    // Capture failures immediately so a missing implementation reports the
    // missing calls, rather than leaving rejected promises behind the pin.
    void first.catch(() => undefined);
    void second.catch(() => undefined);
    expect(client.post).toHaveBeenCalledTimes(2);
    finishSecond({ launchUrl: 'https://configured-admin.example.test/#handoff=second-fixture-claim' });
    expect(await second).toBe('https://configured-admin.example.test/#handoff=second-fixture-claim&to=%2Fpeople%2Faccounts');
    finishFirst({ launchUrl: 'https://configured-admin.example.test/#handoff=first-fixture-claim' });
    expect(await first).toBe('https://configured-admin.example.test/#handoff=first-fixture-claim&to=%2Fpeople%2Faccounts');
    expect(client.post).toHaveBeenCalledTimes(2);
  });
});
