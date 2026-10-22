import { beforeEach, describe, expect, it, vi } from 'vitest';
import { branchAppApi, authApi } from '@/api/platform';

const seam = vi.hoisted(() => ({ post: vi.fn(async () => ({ ok: true })), put: vi.fn(async () => ({ ok: true })) }));
vi.mock('@/api/client', async original => ({ ...await original<typeof import('@/api/client')>(), api: { post: seam.post, put: seam.put } }));
beforeEach(() => { seam.post.mockClear(); seam.put.mockClear(); });

describe('Organisation Console mutations', () => {
  it('keys each explicit reconcile request without changing its existing body or path', async () => {
    await branchAppApi.reconcile(); await branchAppApi.reconcile();
    expect(seam.post).toHaveBeenCalledTimes(2);
    const keys: unknown[] = [];
    for (const call of seam.post.mock.calls as unknown[][]) {
      expect(call[0]).toBe('/branches/oto-app/reconcile'); expect(call[1]).toBeUndefined();
      const options = call[2] as { idempotencyKey?: string }; expect(options.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/i); keys.push(options.idempotencyKey);
    }
    expect(new Set(keys).size).toBe(2);
  });

  it('sends the selected platform branch UUID and the supplied action key through the existing session route', async () => {
    const branchId = '01900000-0000-7000-8000-000000000001', key = '01900000-0000-7000-8000-000000000002';
    await authApi.switchBranch(branchId, key);
    expect(seam.put).toHaveBeenCalledExactlyOnceWith('/me/session/branch', { branchId }, { idempotencyKey: key });
  });
});
