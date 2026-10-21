import { describe, expect, it } from 'vitest';
import { createAppIdentitiesApi, isMissingRoute } from '../src/api/app-identities';
import type { AdminApi } from '../src/api/admin-api';

describe('the lifted app identity transport', () => {
  it('keeps genuine resource 404s distinct from an undeployed route', () => {
    expect(isMissingRoute({ status: 404, code: 'NOT_FOUND' })).toBe(false);
    expect(isMissingRoute({ status: 404, code: 'ACCOUNT_NOT_FOUND' })).toBe(false);
    expect(isMissingRoute({ status: 404, code: 'UNKNOWN' })).toBe(true);
    expect(isMissingRoute({ status: 403, code: 'UNKNOWN' })).toBe(false);
    expect(isMissingRoute({ status: 404 })).toBe(false);
    expect(isMissingRoute(null)).toBe(false);
  });

  it('sends branch replacement and unlink through the injected host with independent idempotency keys', async () => {
    const calls: Array<{ method: string; path: string; body?: unknown; key?: string }> = [];
    const invoke = async <T>(method: string, path: string, body?: unknown, options?: { idempotencyKey?: string }): Promise<T> => {
      calls.push({ method, path, body, key: options?.idempotencyKey });
      return {} as T;
    };
    const host: AdminApi = {
      get: path => invoke('GET', path), post: (path, body, options) => invoke('POST', path, body, options),
      patch: (path, body, options) => invoke('PATCH', path, body, options),
      put: (path, body, options) => invoke('PUT', path, body, options),
      delete: (path, options) => invoke('DELETE', path, undefined, options),
    };
    const apps = createAppIdentitiesApi(host);
    await apps.setOtoAppBranches('account/with space', null);
    await apps.unlink('oto_app', 'account/with space');
    expect(calls).toMatchObject([
      { method: 'PUT', path: '/admin/apps/oto_app/users/account%2Fwith%20space/branches', body: { branchIds: null } },
      { method: 'DELETE', path: '/admin/apps/oto_app/users/account%2Fwith%20space' },
    ]);
    expect(calls.every(call => typeof call.key === 'string' && /^[a-f0-9-]{36}$/.test(call.key))).toBe(true);
    expect(calls[0]?.key).not.toBe(calls[1]?.key);
  });
});
