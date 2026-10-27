import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AnalyticsParkSource, AnalyticsSourceChoice, AnalyticsSourcePreview, AnalyticsSources } from '@/api/consoleConfiguration';
import { RERUN_COPY, RerunView, SourceParkCard, SourceSwitchView, SourcesPanel } from '@/pages/AnalyticsSourcesPanel';

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
const ALL = ['console:analytics:read', 'analytics:read', 'console:analytics:manage_source', 'console:analytics:rerun'];
beforeEach(() => { session.allowed = new Set(ALL); });

const EDITED = '2026-10-20T08:00:00.000Z';
const pos: AnalyticsParkSource = {
  branchId: '01964600-0000-7000-8000-0000000000a1', name: 'ZZ TEST POS park', source: 'oto_pos', preference: 'oto_pos',
  lastEditedAt: null, lastEditedBy: null, mayManageSource: true, mayRerun: true,
};
const legacy: AnalyticsParkSource = {
  ...pos, branchId: '01964600-0000-7000-8000-0000000000a2', name: 'ZZ TEST legacy park', source: 'pisell', preference: 'legacy',
  lastEditedAt: EDITED, lastEditedBy: '01964600-0000-7000-8000-0000000000b1',
};
const sources: AnalyticsSources = { generatedAt: '2026-10-28T01:00:00.000Z', basis: 'whole-branch-switch', branches: [legacy, pos], omitted: [] };
const preview: AnalyticsSourcePreview = {
  branchId: pos.branchId, currentSource: 'oto_pos', proposedSource: 'pisell', unchanged: false, effect: 'whole-branch',
  from: '2026-09-01', to: '2026-09-30', days: 30, servedDays: 21, emptyDays: 9, servesFrozenOnly: true,
  firstServedDate: '2026-09-01', lastServedDate: '2026-09-21', newestWrittenAt: '2026-09-22T01:00:00.000Z',
};
const noop = () => undefined;
const panel = (data: AnalyticsSources | null, error: string | null = null) =>
  renderToStaticMarkup(createElement(SourcesPanel, { sources: data, error, onRetry: noop, onChanged: noop }));
const parkMarkup = (html: string, park: AnalyticsParkSource) => {
  const start = html.indexOf(`data-source-park="${park.branchId}"`);
  expect(start, park.name).toBeGreaterThan(-1);
  const next = html.indexOf('data-source-park="', start + 1);
  return html.slice(start, next === -1 ? undefined : next);
};
const switchView = (shown: AnalyticsSourcePreview | null, draft: AnalyticsSourceChoice = { source: 'pisell', preference: 'oto_pos' }) =>
  renderToStaticMarkup(createElement(SourceSwitchView, {
    park: pos, draft, preview: shown, previewError: null, saveError: null, busy: null,
    onDraft: noop, onPreview: noop, onConfirm: noop, onCancel: noop,
  }));

describe('Analytics sources panel markup (SCRUM-646 Q27 Stage 1)', () => {
  it('renders each park\'s stored switch with the edit time named as an edit, never an effective date', () => {
    const html = panel(sources);
    const old = parkMarkup(html, legacy);
    expect(old).toContain('Pisell');
    expect(old).toContain('Legacy');
    expect(old).toContain('Setting last edited');
    expect(old).toContain(`dateTime="${EDITED}"`);
    expect(old).toContain('not a date it takes effect from');
    expect(parkMarkup(html, pos)).toContain('Never edited (OTO POS by default)');
    expect(html).not.toMatch(/effective from|cutover date/i);
  });

  it('offers no save before a preview, and shows the preview with an explicit confirm before saving', () => {
    const before = switchView(null);
    expect(before).toContain('Preview this switch');
    expect(before).not.toContain('Confirm switch');
    expect(before).not.toContain('data-preview');
    const shown = switchView(preview);
    expect(shown).toContain('data-preview="shown"');
    expect(shown).toContain('<strong>21</strong> stored days that would be served');
    expect(shown).toContain('its frozen, imported days only');
    expect(shown).toContain('<strong>9</strong> days have no stored Pisell row and will show empty');
    expect(shown).toContain('dateTime="2026-09-22T01:00:00.000Z"');
    expect(shown).toContain('not a dated cutover');
    expect(shown).toContain('Confirm switch');
    expect(shown).toContain('Cancel');
  });

  it('cannot preview a switch to what the park already has', () => {
    const html = switchView(null, { source: 'oto_pos', preference: 'oto_pos' });
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Preview this switch/);
  });

  it('refuses a re-run for a park serving a legacy source with the ruling\'s words, and offers it for our own days', () => {
    const html = panel(sources);
    const old = parkMarkup(html, legacy);
    expect(old).toContain('data-control="rerun-refused"');
    expect(old).toContain(RERUN_COPY);
    expect(old).not.toContain('Queue re-run');
    const own = parkMarkup(html, pos);
    expect(own).toContain('data-control="rerun"');
    expect(own).toContain('recomputes our POS figures from our own records');
    expect(own).toContain('Queue re-run');
    expect(RERUN_COPY).toContain('cannot rebuild a day from Pisell or Papaya');
  });

  it('shows a refused re-run reply rather than a queued one', () => {
    const html = renderToStaticMarkup(createElement(RerunView, {
      park: pos, from: '2026-09-04', to: '2026-09-05', busy: false, result: null,
      error: 'Some days in this range are frozen and are never recomputed.', onRange: noop, onRerun: noop,
    }));
    expect(html).toContain('never recomputed');
    expect(html).not.toContain('Queued');
  });

  it('shows the missing permission instead of a control, per park and per session', () => {
    const noDoors = { ...pos, mayManageSource: false, mayRerun: false };
    const denied = renderToStaticMarkup(createElement(SourceParkCard, { park: noDoors, onChanged: noop }));
    expect(denied).toContain('data-control="switch-unavailable"');
    expect(denied).toContain('console:analytics:manage_source');
    expect(denied).toContain('data-control="rerun-unavailable"');
    expect(denied).toContain('console:analytics:rerun');
    expect(denied).not.toContain('Preview this switch');
    expect(denied).not.toContain('Queue re-run');
    session.allowed = new Set(['console:analytics:read', 'analytics:read']);
    const sessionDenied = renderToStaticMarkup(createElement(SourceParkCard, { park: pos, onChanged: noop }));
    expect(sessionDenied).not.toContain('Preview this switch');
    expect(sessionDenied).not.toContain('Queue re-run');
    expect(sessionDenied).toContain('switch-unavailable');
  });

  it('never offers an unfreeze, and keeps a failed read distinct', () => {
    expect(panel(sources)).not.toMatch(/unfreeze/i);
    expect(switchView(preview)).not.toMatch(/unfreeze/i);
    const failed = panel(null, 'ZZ TEST sources failed');
    expect(failed).toContain('ZZ TEST sources failed');
    expect(failed).not.toContain('data-source-park');
    expect(panel(null)).toContain('Loading report sources');
  });
});
