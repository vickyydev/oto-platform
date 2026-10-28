import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { TeamsRoutingContent, missingTeamIdentities } from '@/pages/TeamsRouting';
import type { RoutingRules, RoutingTeams } from '@/api/inbox-routing';

const NOW = '2026-10-23T00:00:00.000Z';
const directory = (): RoutingTeams & RoutingRules => ({
  operatorWide: true,
  branches: [{ id: 'zz-park', name: 'ZZ TEST Park' }],
  departments: [{ id: 'zz-department', name: 'ZZ TEST Reception', branchId: 'zz-park' }],
  accounts: [{ id: 'zz-person', displayName: 'ZZ TEST Person', status: 'active' }],
  teamReferences: [
    { id: 'zz-reception', key: 'reception', name: 'ZZ TEST Reception', branchId: 'zz-park' },
    { id: 'zz-birthdays', key: 'birthdays', name: 'ZZ TEST Birthdays', branchId: null },
    { id: 'zz-marketing', key: 'marketing', name: 'ZZ TEST Marketing', branchId: null },
    { id: 'zz-gm', key: 'gm', name: 'ZZ TEST GM', branchId: null },
  ],
  teams: [{ id: 'zz-reception', key: 'reception', name: 'ZZ TEST Reception', branchId: 'zz-park', branchName: 'ZZ TEST Park',
    departmentId: 'zz-department', departmentName: 'ZZ TEST Reception department', colour: 'sky', sortOrder: -2, createdAt: NOW, updatedAt: NOW }],
  rules: [{ id: 'zz-rule', teamId: 'zz-birthdays', teamName: 'ZZ TEST Birthdays', category: 'birthdays', language: null,
    branchId: null, branchName: null, primaryKind: 'team', primaryAccountId: null, primaryAccountName: null,
    backupAccountId: 'zz-person', backupAccountName: 'ZZ TEST Person', autoAddBackup: true, priority: -10,
    active: true, archivedAt: null, createdAt: NOW, updatedAt: NOW }],
});
const render = (overrides: Partial<Parameters<typeof TeamsRoutingContent>[0]> = {}) => renderToStaticMarkup(createElement(TeamsRoutingContent, {
  data: directory(), error: null, scope: 'all', archived: false, canAt: () => true,
  onScope: () => undefined, onArchived: () => undefined, onRetry: () => undefined, onSelect: () => undefined, ...overrides,
}));

describe('Teams & routing read and offer states', () => {
  it('keeps unreadable and pending collections distinct from a genuinely empty result', () => {
    const pending = render({ data: null });
    expect(pending).toContain('Loading teams and routing');
    expect(pending).not.toContain('No teams in this scope');
    const refused = render({ data: null, error: 'ZZ TEST Routing read refused.' });
    expect(refused).toContain('role="alert"'); expect(refused).toContain('ZZ TEST Routing read refused.');
    expect(refused).not.toContain('No routing rules');
    const data = directory(); data.teams = []; data.rules = [];
    const empty = render({ data });
    expect(empty).toContain('No teams in this scope'); expect(empty).toContain('No routing rules in this scope');
    expect(empty).toContain('existing team fallback');
  });

  it('shows native wildcard, negative priority, backup and immutable-system meaning', () => {
    const html = render();
    expect(html).toContain('Any park'); expect(html).toContain('Any language'); expect(html).toContain('Priority -10');
    expect(html).toContain('The team'); expect(html).toContain('ZZ TEST Person');
    expect(html).toContain('added from the first message'); expect(html).toContain('teams cannot be deleted');
    expect(html).toContain('does not reassign existing conversations');
    expect(html).toContain('All system team identities in your reach already exist.');
    expect(html).not.toContain('Delete team');
  });

  it('preserves archived history while offering edits only on current rules', () => {
    const data = directory(); data.rules[0]!.archivedAt = NOW; data.rules[0]!.active = false;
    const current = render({ data }); expect(current).not.toContain('ZZ TEST Birthdays</h3>');
    const history = render({ data, archived: true });
    expect(history).toContain('Archived'); expect(history).toContain('Priority -10');
    expect(history).not.toContain('Edit rule'); expect(history).not.toContain('Archive rule');
  });

  it('offers only genuinely missing canonical team identities in authorized scopes', () => {
    const data = directory();
    expect(missingTeamIdentities(data)).toEqual([]);
    data.branches.push({ id: 'zz-new-park', name: 'ZZ TEST New park' });
    data.teamReferences = data.teamReferences.filter(team => team.key !== 'marketing');
    expect(missingTeamIdentities(data).map(identity => [identity.key, identity.branchId])).toEqual([
      ['marketing', null], ['reception', 'zz-new-park'],
    ]);
    data.operatorWide = false;
    expect(missingTeamIdentities(data).map(identity => [identity.key, identity.branchId])).toEqual([
      ['reception', 'zz-new-park'],
    ]);
  });

  it('offers the playbook GM team (SCRUM-220) as an operator-wide identity when it is missing', () => {
    const data = directory();
    data.teamReferences = data.teamReferences.filter(team => team.key !== 'gm');
    expect(missingTeamIdentities(data).map(identity => [identity.key, identity.branchId, identity.label])).toEqual([
      ['gm', null, 'GM · Operator-wide'],
    ]);
    data.operatorWide = false;
    expect(missingTeamIdentities(data)).toEqual([]);
  });

  it('filters display by selected scope without turning a park selection into a wildcard', () => {
    const byPark = render({ scope: 'zz-park' });
    expect(byPark).toContain('ZZ TEST Reception'); expect(byPark).toContain('No routing rules in this scope');
    expect(byPark).not.toContain('Priority -10');
    const operator = render({ scope: 'operator' });
    expect(operator).toContain('No teams in this scope'); expect(operator).toContain('Priority -10');
    const data = directory(); data.operatorWide = false;
    expect(render({ data })).not.toContain('value="operator"');
  });
});
