import { describe, expect, it } from 'vitest';
import type { Permission } from '@oto/shared/permissions';
import { consoleNav, findSection, sectionForPath, visibleNavigation } from '@/components/consoleSections';

const navigation = (...permissions: string[]) => visibleNavigation(
  (permission: Permission) => permissions.includes(permission), false,
);

describe('SCRUM-643 suite control navigation', () => {
  it('offers Apps to an operator reader without unrelated branch or platform access', () => {
    const groups = navigation('console:app_registry:read');
    expect(groups.map(group => group.id)).toEqual(['organisation']);
    expect(groups[0]?.sections.map(page => page.id)).toEqual(['apps']);
    expect(findSection('apps')).toMatchObject({ path: '/organisation/apps', permission: 'console:app_registry:read' });
  });

  it('offers Releases to an operator reader without unrelated health access', () => {
    const groups = navigation('console:release:read');
    expect(groups.map(group => group.id)).toEqual(['watch']);
    expect(groups[0]?.sections.map(page => page.id)).toEqual(['releases']);
    expect(findSection('releases')).toMatchObject({ path: '/watch/releases', permission: 'console:release:read' });
  });

  it('keeps both requested aliases and the ten existing areas', () => {
    for (const [id, path] of [['apps', '/organisation/apps'], ['releases', '/watch/releases']]) {
      expect(sectionForPath('/' + id)).toBeDefined();
      expect(sectionForPath('/' + id)).toEqual(sectionForPath(path!));
    }
    expect(consoleNav).toHaveLength(10);
    expect(consoleNav.find(group => group.id === 'platform')?.gate).toEqual({ platformWide: true });
    expect(navigation()).toEqual([]);
  });
});
