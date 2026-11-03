import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OfflineSignInBanner } from '@/components/auth/OfflineSignInBanner';
import { useOperator } from '@/auth/OperatorContext';
vi.mock('@/auth/OperatorContext', () => ({ useOperator: vi.fn() }));
afterEach(() => vi.resetAllMocks());

describe('OD-6 sign-in notice', () => {
  it.each([
    { method: 'offline_sign_in', operator: true, locked: false, visible: true },
    { method: 'offline_token', operator: true, locked: false, visible: false },
    { method: 'offline_sign_in', operator: true, locked: true, visible: false },
    { method: 'offline_sign_in', operator: false, locked: false, visible: false },
    { method: null, operator: true, locked: false, visible: false },
  ])('the notice follows $method, signed-in=$operator, locked=$locked', row => {
    vi.mocked(useOperator).mockReturnValue({ operator: row.operator ? { id: 'zz-test' } : null, locked: row.locked,
      offlineUnlock: row.method ? { method: row.method, cacheAgeSeconds: 1 } : null } as ReturnType<typeof useOperator>);
    const html = renderToStaticMarkup(createElement(OfflineSignInBanner));
    if (row.visible) { expect(html).toContain('Offline sign-in'); expect(html).toContain('role="status"'); }
    else expect(html).toBe('');
  });
});
