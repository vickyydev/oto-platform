import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LoginUsersPanel } from '@/components/admin/access/LoginUsersPanel';
import { adminPanelsById } from '@/components/admin/adminSections';

const access = vi.hoisted(() => ({ console: true }));
vi.mock('@/auth/OperatorContext', () => ({ useOperator: () => ({
  can: (permission: string) => permission === 'app:console:access' ? access.console : true,
}) }));
vi.mock('@/store/CatalogStoreContext', () => ({ useCatalogStore: () => ({ branches: [] }) }));
vi.mock('@/api/platform', () => ({ adminApi: {}, authApi: {} }));
vi.mock('@/components/admin/access/AccountAppsDialog', () => ({ AccountAppsDialog: () => null }));
vi.mock('@/components/admin/access/UnlinkedOtoAppUsers', () => ({ UnlinkedOtoAppUsers: () => null }));

const markup = () => renderToStaticMarkup(React.createElement(LoginUsersPanel));

describe('the former POS Login Users entry', () => {
  beforeEach(() => { access.console = true; vi.stubGlobal('React', React); });

  it('points to Admin > People > Accounts and contains no account-management form or list', () => {
    const html = markup();
    expect(html).toContain('Admin → People → Accounts');
    expect(html).toContain('Open Accounts in Admin');
    expect(html).not.toContain('<input');
    expect(html).not.toContain('<form');
    expect(html).not.toContain('<table');
    for (const oldControl of ['Invite staff', 'Recent denials', 'Temporary password', 'Sign out everywhere']) expect(html).not.toContain(oldControl);
    expect(html).not.toContain('https://');
  });

  it('honestly withholds the source action when Admin is not on the caller access', () => {
    access.console = false;
    const html = markup();
    expect(html).toContain('Admin is not on your access.');
    expect(html).not.toContain('Open Accounts in Admin');
    expect(html).not.toContain('<input');
  });

  it('keeps the existing account-read gate on the original Login Users navigation entry', () => {
    expect(adminPanelsById['login-users']?.permission).toBe('admin:account:read');
  });
});
