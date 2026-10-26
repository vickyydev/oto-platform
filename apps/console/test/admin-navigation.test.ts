import { describe, expect, it } from 'vitest';
import { PERMISSIONS, ROLE_BUNDLES, type Permission } from '@oto/shared/permissions';
import {
  consoleNav, DEFAULT_SECTION, findSection, sectionForPath, visibleNavigation,
} from '@/components/consoleSections';

const has = (...permissions: Permission[]) => (permission: Permission) => permissions.includes(permission);
const ids = (permissions: Permission[], platform = false) =>
  visibleNavigation(has(...permissions), platform).map((area) => area.id);

describe('SCRUM-609 Admin navigation', () => {
  it('opens on Overview and names the ten approved areas in order', () => {
    expect(DEFAULT_SECTION).toBe('overview');
    expect(consoleNav.map((area) => [area.id, area.label])).toEqual([
      ['overview', 'Overview'], ['people', 'People & access'], ['organisation', 'Organisation'],
      ['catalogue', 'Catalogue & money'], ['devices', 'Devices & places'],
      ['channels', 'Channels & assistant'], ['staff', 'Staff & HR'], ['reports', 'Reports'],
      ['watch', 'Watch'], ['platform', 'Platform'],
    ]);
  });

  it('offers no areas without their gates, even to a platform-wide account', () => {
    expect(ids([])).toEqual([]);
    expect(ids([], true)).toEqual(['platform']);
  });

  it.each([
    ['console:overview:read', ['overview']], ['admin:account:read', ['people']],
    ['admin:branch:read', ['organisation']], ['catalog:package:read', ['catalogue']],
    ['catalog:menu:read', ['catalogue']], ['admin:station:read', ['devices']],
    ['inbox:channel:manage', ['channels']], ['inbox:kb:manage', ['channels']],
    ['inbox:ai:manage', ['channels']], ['analytics:read', ['reports']],
    ['admin:health:read', ['watch']], ['admin:audit:read', ['watch']],
  ] as [Permission, string[]][])('uses the section gate %s', (permission, expected) => {
    expect(ids([permission])).toEqual(expected);
  });

  it('requires both staff gates, and platform-wide scope for Platform', () => {
    expect(ids(['app:oto_app:access'])).not.toContain('staff');
    expect(ids(['admin:account:read'])).not.toContain('staff');
    expect(ids(['app:oto_app:access', 'admin:account:read'])).toContain('staff');
    expect(ids(ROLE_BUNDLES.operator_admin)).not.toContain('platform');
    expect(ids(ROLE_BUNDLES.operator_admin, true)).toContain('platform');
  });

  it('keeps the approved Channels gate and the routing page permission independent', () => {
    expect(ids(['inbox:routing:manage'])).toEqual([]);
    expect(ids(['inbox:template:manage'])).toEqual([]);
    const withoutRouting = visibleNavigation(has('inbox:channel:manage'), false).find(area => area.id === 'channels');
    expect(withoutRouting?.sections).toEqual([]);
    const withRouting = visibleNavigation(has('inbox:channel:manage', 'inbox:routing:manage'), false).find(area => area.id === 'channels');
    expect(withRouting?.sections.map(page => page.id)).toEqual(['teams-routing']);
    expect(findSection('teams-routing')).toMatchObject({ path: '/channels/teams-routing', permission: 'inbox:routing:manage' });
    expect(sectionForPath('/teams-routing')).toEqual(findSection('teams-routing'));
    expect(sectionForPath('/channels/teams-routing')).toEqual(findSection('teams-routing'));
  });

  it('filters child links by their own permissions inside an allowed area', () => {
    const watch = visibleNavigation(has('admin:audit:read'), false).find((area) => area.id === 'watch');
    expect(watch?.sections.map((page) => page.id)).toEqual(['activity']);
    expect(visibleNavigation(has('admin:booth:read'), false)).toEqual([]);
  });

  it('offers the settings index without widening native panel gates and keeps both analytics read doors', () => {
    const configuration = visibleNavigation(has('console:config:read'), false);
    expect(configuration.map(area => area.id)).toEqual(['organisation']);
    expect(configuration[0]?.sections.map(page => page.id)).toEqual(['config']);
    expect(sectionForPath('/config')).toEqual(sectionForPath('/organisation/configuration'));
    expect(ids(['console:analytics:read'])).toEqual([]);
    expect(visibleNavigation(has('analytics:read'), false)[0]?.sections.map(page => page.id)).not.toContain('analytics');
    expect(visibleNavigation(has('analytics:read', 'console:analytics:read'), false)[0]?.sections.map(page => page.id)).toContain('analytics');
    expect(sectionForPath('/analytics')).toEqual(sectionForPath('/reports/analytics'));
  });

  it('keeps every old page address and permission alongside its new area address', () => {
    const pages: [string, string, Permission][] = [
      ['health', '/watch/health', 'admin:health:read'],
      ['failures', '/watch/failures', 'admin:health:read'],
      ['activity', '/watch/activity', 'admin:audit:read'],
      ['integrations', '/watch/integrations', 'admin:health:read'],
      ['devices', '/devices', 'admin:station:read'],
      ['booths', '/devices/booths', 'admin:booth:read'],
      ['branches', '/organisation/branches', 'admin:branch:read'],
      ['bookings', '/reports/bookings', 'pos:booking:read'],
      ['booth-report', '/reports/booths', 'analytics:read'],
      ['vouchers', '/catalogue/vouchers', 'admin:booth:read'],
      ['voucher-types', '/catalogue/voucher-types', 'admin:booth:read'],
    ];
    for (const [id, path, permission] of pages) {
      expect(findSection(id)).toMatchObject({ id, path, permission });
      expect(sectionForPath(`/${id}`)).toEqual(findSection(id));
      expect(sectionForPath(path)).toEqual(findSection(id));
    }
    expect(sectionForPath('/watch/unknown')).toBeUndefined();
  });

  it('grants Overview to managers and administrators, leaving counter bundles alone', () => {
    expect(PERMISSIONS).toContain('console:overview:read');
    for (const role of ['branch_manager', 'operator_admin', 'platform_admin'] as const) {
      expect(ROLE_BUNDLES[role]).toContain('console:overview:read');
    }
    expect(ROLE_BUNDLES.reception).not.toContain('console:overview:read');
    expect(ROLE_BUNDLES.staff).not.toContain('console:overview:read');
  });

  it('offers Organisation Operators only to a platform-wide account, even when an operator administrator holds the named read permission', () => {
    const operatorPages = visibleNavigation(has(...ROLE_BUNDLES.operator_admin), false).find(area => area.id === 'organisation')?.sections.map(page => page.id) ?? [];
    expect(operatorPages).not.toContain('operators');
    const platformPages = visibleNavigation(has(...ROLE_BUNDLES.platform_admin), true).find(area => area.id === 'organisation')?.sections.map(page => page.id) ?? [];
    expect(platformPages).toContain('operators');
    expect(findSection('operators')).toMatchObject({ path: '/organisation/operators', permission: 'admin:operator:read' });
  });

  it('keeps Holidays on its own pricing permission while retaining the old Branches address', () => {
    const pagesFor = (...permissions: Permission[]) => visibleNavigation(has('admin:branch:read', ...permissions), false).find(area => area.id === 'organisation')?.sections.map(page => page.id) ?? [];
    expect(pagesFor()).not.toContain('holidays');
    expect(pagesFor('catalog:holiday:manage')).toContain('holidays');
    expect(findSection('holidays')).toMatchObject({ path: '/organisation/holidays', permission: 'catalog:holiday:manage' });
    expect(sectionForPath('/branches')).toEqual(findSection('branches'));
    expect(sectionForPath('/organisation/branches')).toEqual(findSection('branches'));
  });
});
