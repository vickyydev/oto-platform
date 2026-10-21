import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { PermissionDiffView, type PermissionHolders, type RoleCatalogue } from '@oto/admin-screens';
import { RoleCatalogueContent, PermissionHoldersContent } from '@/pages/Roles';
import { findSection, visibleNavigation } from '@/components/consoleSections';

describe('Roles & scopes', () => {
  it('places the role catalogue under People with the existing role-read guard', () => {
    expect(findSection('roles')).toMatchObject({ path: '/people/roles', permission: 'admin:role:read' });
    const available = visibleNavigation((permission) => ['admin:account:read', 'admin:role:read'].includes(permission), false);
    expect(available.find((area) => area.id === 'people')?.sections.some((page) => page.id === 'roles')).toBe(true);
    const accountsOnly = visibleNavigation((permission) => permission === 'admin:account:read', false);
    expect(accountsOnly.find((area) => area.id === 'people')?.sections.some((page) => page.id === 'roles')).toBe(false);
  });

  it('shows the server’s permission sentences and scope names without computing a different policy', () => {
    const catalogue: RoleCatalogue = { roles: [{ id: 'role', name: 'reception', system: true, description: null,
      permissions: [{ permission: 'pos:sale:read', words: 'Read the park’s sales.' }] }],
    permissions: [{ permission: 'pos:sale:read', words: 'Read the park’s sales.' }] };
    const html = renderToStaticMarkup(createElement(RoleCatalogueContent, { catalogue, error: null, onRetry: () => undefined }));
    expect(html).toContain('Read the park’s sales.');
    expect(html).toContain('System role');
    const holders: PermissionHolders = { permission: 'pos:sale:read', words: 'Read sales.', holders: [{
      accountId: 'person', phone: '+66000000000', status: 'active', employee: { id: 'employee', name: 'ZZ TEST Person' },
      assignments: [{ id: 'assignment', roleName: 'reception', scopeType: 'branch', scopeId: 'park', scopeName: 'ZZ TEST Park' }],
    }] };
    const list = renderToStaticMarkup(createElement(PermissionHoldersContent, { result: holders, onPermissions: () => undefined }));
    expect(list).toContain('ZZ TEST Person');
    expect(list).toContain('ZZ TEST Park');
  });

  it('renders canonical added/removed scope rows including a real no-change preview', () => {
    const html = renderToStaticMarkup(createElement(PermissionDiffView, {
      added: [{ permission: 'pos:sale:read', words: 'Server says this access is added.', scopeType: 'branch', scopeId: 'park' }],
      removed: [{ permission: 'pos:sale:read', words: 'Server says this scope is removed.', scopeType: 'operator', scopeId: null }],
      branches: [{ id: 'park', apiId: 'park', name: 'ZZ TEST Park' }],
    }));
    expect(html).toContain('Server says this access is added.');
    expect(html).toContain('Server says this scope is removed.');
    expect(html).toContain('branch: ZZ TEST Park');
    expect(html).toContain('platform-wide');
    const empty = renderToStaticMarkup(createElement(PermissionDiffView, { added: [], removed: [], branches: [] }));
    expect(empty).toContain('Added access (0)');
    expect(empty).toContain('Removed access (0)');
    expect(empty).not.toContain('pos:sale:read');
  });

  it('keeps failed catalogue reads and genuinely empty holder results distinct', () => {
    const failed = renderToStaticMarkup(createElement(RoleCatalogueContent, { catalogue: null, error: 'Role source unavailable.', onRetry: () => undefined }));
    expect(failed).toContain('Role source unavailable.');
    expect(failed).not.toContain('No matching roles');
    const empty = renderToStaticMarkup(createElement(PermissionHoldersContent, {
      result: { permission: 'pos:sale:read', words: 'Read sales.', holders: [] }, onPermissions: () => undefined,
    }));
    expect(empty).toContain('No holders in your reach');
  });
});
