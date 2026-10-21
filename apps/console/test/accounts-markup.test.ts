import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { AccountsTable, type AccountRow } from '@oto/admin-screens';
import { findSection, visibleNavigation } from '@/components/consoleSections';

const noop = () => undefined;
const account: AccountRow = { id: 'fixture', phone: '+66000000000', status: 'active', mustChangePassword: false,
  employee: { id: 'employee-fixture', name: 'ZZ TEST Account' } };

function table(options: { accounts?: AccountRow[]; loading?: boolean; error?: string | null } = {}) {
  return renderToStaticMarkup(createElement(AccountsTable, {
    accounts: options.accounts ?? [account], loading: options.loading ?? false, error: options.error ?? null,
    onRetry: noop, onPhone: noop, onSessions: noop, onRevoke: noop, onTemporaryPassword: noop, onStatus: noop,
  }));
}

describe('Accounts lift', () => {
  it('places Accounts in People with the existing account-read permission', () => {
    expect(findSection('accounts')).toMatchObject({ path: '/people/accounts', permission: 'admin:account:read' });
    const allowed = visibleNavigation((permission) => permission === 'admin:account:read', false);
    expect(allowed.find((area) => area.id === 'people')?.sections.some((page) => page.id === 'accounts')).toBe(true);
    expect(visibleNavigation(() => false, false).some((area) => area.id === 'people')).toBe(false);
  });

  it('retains the account table and approved account actions without later-ticket dead controls', () => {
    const html = table();
    expect(html).toContain('<table');
    expect(html).toContain('ZZ TEST Account');
    expect(html).toContain('+66000000000');
    for (const action of ['Change phone', 'Sessions', 'Sign out everywhere', 'Temporary password', 'Deactivate']) {
      expect(html).toContain(`title="${action}"`);
    }
    expect(html).not.toContain('title="Apps"');
    expect(html).not.toContain('Effective permissions');
    expect(table({ accounts: [{ ...account, status: 'inactive' }] })).toContain('title="Activate"');
  });

  it('distinguishes loading, source failure and an honestly empty search', () => {
    const loading = table({ loading: true, accounts: [] });
    expect(loading).toContain('Loading accounts');
    expect(loading).not.toContain('No accounts match');
    const failed = table({ accounts: [], error: 'The source did not answer.' });
    expect(failed).toContain('Accounts could not be read.');
    expect(failed).toContain('The source did not answer.');
    expect(failed).not.toContain('No accounts match');
    expect(table({ accounts: [] })).toContain('No accounts match this search.');
  });
});
