import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { AccountsTable } from '@oto/admin-screens';
import { findSection, visibleNavigation } from '@/components/consoleSections';

describe('App access', () => {
  it('puts app access under People and keeps its account-read page gate', () => {
    expect(findSection('app-access')).toMatchObject({ path: '/people/app-access', permission: 'admin:account:read' });
    const navigation = visibleNavigation((permission) => permission === 'admin:account:read', false);
    expect(navigation.find((area) => area.id === 'people')?.sections.some((section) => section.id === 'app-access')).toBe(true);
    expect(visibleNavigation(() => false, false).some((area) => area.id === 'people')).toBe(false);
  });

  it('reuses the approved table with only the supplied Apps action', () => {
    const html = renderToStaticMarkup(createElement(AccountsTable, {
      accounts: [{ id: 'person', phone: '+66000000000', status: 'active', mustChangePassword: false,
        employee: { id: 'employee', name: 'ZZ TEST Person' } }], loading: false, error: null,
      onRetry: () => undefined, onApps: () => undefined,
    }));
    expect(html).toContain('<table');
    expect(html).toContain('ZZ TEST Person');
    expect(html).toContain('title="Apps"');
    for (const action of ['Change phone', 'Sessions', 'Sign out everywhere', 'Temporary password', 'Deactivate', 'Effective permissions']) {
      expect(html).not.toContain(`title="${action}"`);
    }
  });
});
