import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Router } from 'wouter';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AnalyticsDrift, ConfigurationEntry, ConfigurationIndex } from '@/api/consoleConfiguration';
import { sectionForPath } from '@/components/consoleSections';
import { AnalyticsSources, DriftPanel } from '@/pages/AnalyticsSources';
import { Configuration, ConfigurationContent } from '@/pages/Configuration';

const session = vi.hoisted(() => ({ allowed: new Set<string>() }));
vi.mock('@/auth/SessionContext', () => ({ useSession: () => ({
  state: 'signed-in', authorityEpoch: 1, refreshing: false, isCurrentAuthority: (epoch: number) => epoch === 1,
  me: { isPlatformAdmin: false, branch: null, sessionLocked: false,
    account: { id: 'caller', operatorId: 'operator', status: 'active', mustChangePassword: false },
    operatorContext: { sessionId: '01964600-0000-7000-8000-000000000009', homeOperatorId: 'operator',
      effectiveOperatorId: 'operator', operatorOverride: null, branchId: null, stationId: null, revision: 0 } },
  permissions: [...session.allowed].map(permission => ({ permission, scopeType: 'operator', scopeId: null })),
  has: (permission: string) => session.allowed.has(permission),
}) }));
vi.mock('@/components/redesign/CommandBar', () => ({ CommandBar: ({ sectionId }: { sectionId: string }) => createElement('h1', null, sectionId) }));
beforeEach(() => { session.allowed = new Set(); });

const PARK_A = '01964600-0000-7000-8000-00000000000a';
const PARK_B = '01964600-0000-7000-8000-00000000000b';
const CHANGED = '2026-10-20T03:04:05.000Z';
const entry = (over: Partial<ConfigurationEntry> & Pick<ConfigurationEntry, 'key' | 'label'>): ConfigurationEntry => ({
  id: `01964600-0000-7000-8000-0000000001${String(over.key.length).padStart(2, '0')}`,
  appOwner: 'platform', editableHere: true, requiredPermission: 'admin:branch:read', url: null, openInApp: null,
  supported: true, scope: 'operator', branchIds: [], lastChangedAt: null, lastChangedAvailability: 'unsupported', ...over,
});
const index: ConfigurationIndex = {
  generatedAt: '2026-10-27T10:00:00.000Z', operatorId: '01964600-0000-7000-8000-000000000001',
  branches: [{ id: PARK_A, name: 'ZZ TEST Park A' }, { id: PARK_B, name: 'ZZ TEST Park B' }],
  selectedBranchId: null,
  entries: [
    entry({ key: 'assistant_settings', label: 'Assistant settings', url: '/channels/assistant-settings',
      lastChangedAt: CHANGED, lastChangedAvailability: 'available' }),
    entry({ key: 'tenders', label: 'Tenders', url: '/catalogue/tenders' }),
    entry({ key: 'branch_tax', label: 'Tax', url: '/catalogue/tax', scope: 'branch', branchIds: [PARK_A, PARK_B] }),
    entry({ key: 'inbox_templates', label: 'Message templates', appOwner: 'inbox', editableHere: false,
      openInApp: { app: 'inbox', path: '/?settings=templates' } }),
    entry({ key: 'zz_unknown_setting', label: 'ZZ unknown setting', supported: false }),
    entry({ key: 'zz_bad_target', label: 'ZZ bad target', url: '//evil.example/settings' }),
  ],
};
const render = (data: ConfigurationIndex | null, options: { error?: string; allowed?: string[] } = {}) =>
  renderToStaticMarkup(createElement(Router, { ssrPath: '/organisation/configuration', children: createElement(ConfigurationContent, {
    data, error: options.error ?? null, onRetry: () => undefined, onSelectPark: () => undefined,
    has: permission => (options.allowed ?? []).includes(permission), opening: null, onOpenInApp: () => undefined,
  }) }));
/** One entry's card markup, by its data-setting-key. */
const card = (html: string, key: string) => {
  const start = html.indexOf(`data-setting-key="${key}"`);
  expect(start, key).toBeGreaterThan(-1);
  const next = html.indexOf('data-setting-key="', start + 1);
  return html.slice(start, next === -1 ? undefined : next);
};

describe('Configuration index markup (SCRUM-646)', () => {
  it('refuses the page without console:config:read and never shows the index', () => {
    const html = renderToStaticMarkup(createElement(Configuration));
    expect(html).toContain('This page is not on your access');
    expect(html).toContain('console:config:read');
    expect(html).not.toContain('Loading configuration index');
    session.allowed.add('console:config:read');
    const allowed = renderToStaticMarkup(createElement(Configuration));
    expect(allowed).not.toContain('This page is not on your access');
    expect(allowed).toContain('Loading configuration index');
  });

  it('links each supported Admin entry to its one real editor through the router', () => {
    const html = render(index);
    for (const [key, url] of [['assistant_settings', '/channels/assistant-settings'], ['tenders', '/catalogue/tenders'], ['branch_tax', '/catalogue/tax']]) {
      const markup = card(html, key!);
      expect(markup).toContain(`href="${url}"`);
      expect(markup).toContain('Open settings');
      expect(sectionForPath(url!), url).toBeDefined();
    }
  });

  it('offers an app-owned entry only as a handoff, and only to holders of that app', () => {
    const without = card(render(index), 'inbox_templates');
    expect(without).not.toContain('<a ');
    expect(without).not.toContain('Open in Inbox');
    expect(without).toContain('Opening it needs access to Inbox');
    const withAccess = card(render(index, { allowed: ['app:inbox:access'] }), 'inbox_templates');
    expect(withAccess).toContain('Open in Inbox');
    expect(withAccess).not.toContain('<a ');
  });

  it('gives an unsupported entry no link and no edit offer', () => {
    const markup = card(render(index, { allowed: ['app:inbox:access'] }), 'zz_unknown_setting');
    expect(markup).toContain('Not supported here');
    expect(markup).not.toContain('<a ');
    expect(markup).not.toContain('<button');
    expect(markup).not.toContain('Open settings');
  });

  it('never navigates to an address that is not a Console page', () => {
    const markup = card(render(index), 'zz_bad_target');
    expect(markup).not.toContain('evil.example');
    expect(markup).not.toContain('<a ');
  });

  it('names the parks a branch-scoped entry applies to and keeps operator entries operator-wide', () => {
    const html = render(index);
    expect(card(html, 'branch_tax')).toContain('ZZ TEST Park A, ZZ TEST Park B');
    expect(card(html, 'tenders')).toContain('All parks (operator-wide)');
  });

  it('shows the real assistant change time and no time for any other entry', () => {
    const html = render(index);
    expect(card(html, 'assistant_settings')).toContain(`dateTime="${CHANGED}"`);
    expect(card(html, 'assistant_settings')).toContain('Last changed');
    for (const key of ['tenders', 'branch_tax', 'inbox_templates', 'zz_unknown_setting']) {
      expect(card(html, key), key).not.toContain('Last changed');
    }
    const notRecorded = render({ ...index, entries: [entry({ key: 'assistant_settings', label: 'Assistant settings',
      url: '/channels/assistant-settings', lastChangedAvailability: 'not-recorded' })] });
    expect(card(notRecorded, 'assistant_settings')).not.toContain('Last changed');
  });

  it('drives the park picker from the envelope branches and selected park', () => {
    const html = render({ ...index, selectedBranchId: PARK_B });
    expect(html).toContain(`<option value="${PARK_A}">ZZ TEST Park A</option>`);
    expect(html).toMatch(new RegExp(`<option value="${PARK_B}" selected="">ZZ TEST Park B</option>`));
    expect(html).toContain('All parks in your reach');
  });

  it('keeps a failed read distinct from an empty index', () => {
    const failed = render(null, { error: 'ZZ TEST read failed' });
    expect(failed).toContain('ZZ TEST read failed');
    expect(failed).not.toContain('No settings in this reading');
    const empty = render({ ...index, entries: [] });
    expect(empty).toContain('No settings in this reading');
  });
});

const comparison = (over: Partial<AnalyticsDrift['comparisons'][number]> & Pick<AnalyticsDrift['comparisons'][number], 'key' | 'status'>):
  AnalyticsDrift['comparisons'][number] => ({
  master: over.key === 'employees' ? 'oto_app' : 'platform', reason: null, requiredPermission: null,
  compared: 0, ambiguous: 0, withheld: 0, items: [], ...over,
});
const drift = (comparisons: AnalyticsDrift['comparisons']): AnalyticsDrift => ({
  generatedAt: '2026-10-27T10:00:00.000Z', basis: 'read-only-comparison', branchIds: [PARK_A], omitted: [], comparisons,
});
const panel = (data: AnalyticsDrift | null, error: string | null = null) => renderToStaticMarkup(createElement(DriftPanel, {
  drift: data, error, parks: [{ branchId: PARK_A, name: 'ZZ TEST Park A' }], onRetry: () => undefined,
}));
const row = (html: string, key: string) => {
  const start = html.indexOf(`data-drift-key="${key}"`);
  expect(start, key).toBeGreaterThan(-1);
  const next = html.indexOf('data-drift-key="', start + 1);
  return html.slice(start, next === -1 ? undefined : next);
};

describe('Analytics drift markup (SCRUM-646)', () => {
  it('refuses the page without either Analytics read door', () => {
    expect(renderToStaticMarkup(createElement(AnalyticsSources))).toContain('console:analytics:read');
    session.allowed.add('console:analytics:read');
    const html = renderToStaticMarkup(createElement(AnalyticsSources));
    expect(html).toContain('This page is not on your access');
    expect(html).toContain('analytics:read');
    session.allowed.add('analytics:read');
    expect(renderToStaticMarkup(createElement(AnalyticsSources))).not.toContain('This page is not on your access');
  });

  it('renders each state distinctly and never calls an unread source clean', () => {
    const html = panel(drift([
      comparison({ key: 'branch_names', status: 'clean', compared: 2 }),
      comparison({ key: 'employees', status: 'absent', reason: 'seam_absent' }),
      comparison({ key: 'app_accounts', status: 'denied', reason: 'permission', requiredPermission: 'admin:role:read' }),
    ]));
    expect(row(html, 'branch_names')).toContain('data-drift-status="clean"');
    expect(row(html, 'branch_names')).toContain('No drift found');
    expect(row(html, 'branch_names')).toContain('2 compared');
    expect(row(html, 'employees')).toContain('Source not installed');
    expect(row(html, 'employees')).toContain('nothing was compared');
    expect(row(html, 'app_accounts')).toContain('Not readable');
    expect(row(html, 'app_accounts')).toContain('admin:role:read');
    for (const key of ['employees', 'app_accounts']) {
      expect(row(html, key), key).not.toContain('No drift found');
      expect(row(html, key), key).not.toMatch(/\d+ compared/);
    }
  });

  it('shows an unsettled owner and a refused seam as their own states', () => {
    const html = panel(drift([
      comparison({ key: 'branch_names', status: 'denied', reason: 'seam_not_granted' }),
      comparison({ key: 'employees', status: 'ambiguous', reason: 'anchor_ambiguous', ambiguous: 3 }),
      comparison({ key: 'app_accounts', status: 'clean', compared: 1, withheld: 2 }),
    ]));
    expect(row(html, 'branch_names')).toContain('does not let the platform read this source');
    expect(row(html, 'employees')).toContain('Owner unclear');
    expect(row(html, 'employees')).toContain('3 with an unsettled owner');
    expect(row(html, 'employees')).not.toContain('No drift found');
    expect(row(html, 'app_accounts')).toContain('2 outside what you may inspect');
    const statuses = [...html.matchAll(/data-drift-status="([a-z]+)"/g)].map(match => match[1]);
    expect(statuses).toEqual(['denied', 'ambiguous', 'clean']);
  });

  it('lists drifted records by field name and park, with the ids and no values', () => {
    const html = panel(drift([
      comparison({ key: 'branch_names', status: 'clean', compared: 1 }),
      comparison({ key: 'employees', status: 'drift', compared: 4, items: [
        { entity: 'employee', platformId: '01964600-0000-7000-8000-0000000000e1', externalId: 'zz-app-employee', branchId: PARK_A, kind: 'changed', fields: ['nickname', 'phone'] },
        { entity: 'employee', platformId: null, externalId: 'zz-app-missing', branchId: PARK_A, kind: 'missing', fields: [] },
      ] }),
      comparison({ key: 'app_accounts', status: 'clean' }),
    ]));
    const staff = row(html, 'employees');
    expect(staff).toContain('Drift found');
    expect(staff).toContain('Nickname');
    expect(staff).toContain('Phone');
    expect(staff).toContain('ZZ TEST Park A');
    expect(staff).toContain('No copy of the master record');
    expect(staff).toContain('zz-app-employee');
    expect(staff).not.toContain('No drift found');
  });

  it('keeps a failed drift read distinct from no drift', () => {
    const failed = panel(null, 'ZZ TEST drift failed');
    expect(failed).toContain('ZZ TEST drift failed');
    expect(failed).not.toContain('No drift found');
    expect(failed).not.toContain('data-drift-status');
    expect(panel(null)).toContain('Loading drift comparison');
  });
});
