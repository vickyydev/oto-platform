import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import Admin from '@/pages/Admin';

const access = vi.hoisted(() => ({ allowed: true, resolved: true, switching: false }));
vi.mock('wouter', () => ({ useSearch: () => '?panel=login-users', useLocation: () => ['/admin', vi.fn()],
  Link: ({ href, children }: { href: string; children: React.ReactNode }) => React.createElement('a', { href }, children) }));
vi.mock('@/auth/OperatorContext', () => ({ useOperator: () => ({ operator: { id: 'actor', name: 'ZZ TEST Redirect' },
  can: (permission: string) => permission === 'app:console:access' && access.allowed,
  sessionResolved: access.resolved, locked: false, mustChangePassword: false, logout: vi.fn() }) }));
vi.mock('@/branch/BranchContext', () => ({ useBranch: () => ({ branch: { id: 'park' }, switching: access.switching }) }));
vi.mock('@/api/admin-entry', () => ({ adminDestination: vi.fn() }));
vi.mock('@/components/auth/LockScreen', () => ({ LockScreen: () => null }));
vi.mock('@/components/auth/ChangePasswordScreen', () => ({ ChangePasswordScreen: () => null }));
const markup = () => renderToStaticMarkup(React.createElement(Admin));

describe('the former POS back-office entry', () => {
  beforeEach(() => { access.allowed = true; access.resolved = true; access.switching = false; vi.stubGlobal('React', React); });

  it('names the move and current sign-in without rendering another admin form, table or issued address', () => {
    const html = markup();
    expect(html).toContain('Opening Admin'); expect(html).toContain('current sign-in'); expect(html).toContain('Back to POS');
    for (const absent of ['<input', '<form', '<table', 'https://', 'handoff=', 'Invite staff', 'Temporary password']) expect(html).not.toContain(absent);
  });

  it('honestly withholds the redirect for an account without Admin app access', () => {
    access.allowed = false; const html = markup();
    expect(html).toContain('Admin is not on your access'); expect(html).toContain('Sign in as a different user');
    expect(html).not.toContain('Opening your Admin page'); expect(html).not.toContain('<form');
  });

  it('waits for sign-in and a confirmed park without promising a destination early', () => {
    access.resolved = false; expect(markup()).toContain('Checking sign-in');
    access.resolved = true; access.switching = true; expect(markup()).toContain('Waiting for park selection');
  });
});
