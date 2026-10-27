import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Router } from 'wouter';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SuiteApps, SuiteFlagPreview, SuiteFlags, SuiteReleases } from '@/api/suite-controls';
import {
  BlastRadius, FeatureFlagsCard, KillSwitchCard, MaintenanceClearForm, MaintenanceSetForm, PendingApprovalCard, ReviewForm,
  SwitchOffForm, SwitchOnForm, type SwitchOnFormProps,
} from '@/components/suite/SuiteControlViews';
import {
  approvalStep, choiceOfOperation, maintenanceClearGate, maintenanceSetGate, operationOf, previewMatches, reviewGate,
  switchOffGate, switchOnGate, type SwitchChoice,
} from '@/lib/suiteControlRules';
import { DeployHistoryBody, SuiteControls } from '@/pages/SuiteControls';

/**
 * SCRUM-643 Release controls (S2-23, planner ruling Q24): the three safety
 * rules, dual control and the honest read states, pinned on the native markup
 * the page renders. The page's own reads and writes are the end-to-end set's.
 */

const session = vi.hoisted(() => ({ value: null as unknown }));
vi.mock('@/auth/SessionContext', () => ({ useSession: () => session.value }));

const ME = '01964300-0000-7000-8000-0000000000a1';
const OTHER = '01964300-0000-7000-8000-0000000000a2';
const THIRD = '01964300-0000-7000-8000-0000000000a3';
const OPERATOR = '01964300-0000-7000-8000-0000000000b1';
const BRANCH = '01964300-0000-7000-8000-0000000000c1';
const NOW = Date.parse('2026-10-28T03:00:00.000Z');
const LATER = '2026-10-28T03:08:00.000Z';
const PAUSE = 'messaging.outbound_paused';
const noop = () => undefined;

const sha = 'a'.repeat(64);
const operation = (overrides: Record<string, unknown> = {}) => ({
  schemaVersion: 1, action: 'kill_switch.set', key: PAUSE, targetApp: 'inbox', scopeType: 'platform', scopeId: null,
  operatorId: null, expectedRevision: 0, value: true, expiresAt: '2026-10-28T04:00:00.000Z', reason: 'ZZ TEST provider outage',
  ...overrides,
});
type Approval = SuiteFlags['approvals'][number];
const approval = (overrides: Partial<Approval> = {}): Approval => ({
  id: '01964300-0000-7000-8000-0000000000d1', state: 'pending', payloadSha256: sha, requesterAccountId: OTHER,
  approverAccountId: null, operation: operation(), createdAt: '2026-10-28T02:58:00.000Z', requestExpiresAt: LATER, ...overrides,
});

const flags = (overrides: Partial<SuiteFlags> = {}): SuiteFlags => ({
  generatedAt: '2026-10-28T03:00:00.000Z', maxTtlMinutes: 1440, defaultTtlMinutes: 60, killSwitchDualControl: true,
  catalogue: [
    { flagKey: PAUSE, kind: 'kill_switch', targetApp: 'inbox', label: 'Pause outbound messaging',
      effect: 'ZZ TEST queued replies stay queued.', valueType: 'boolean', values: null, defaultValue: false,
      scopes: ['platform', 'operator', 'branch'], supported: true },
    { flagKey: 'signin.blocked.pos', kind: 'kill_switch', targetApp: 'pos', label: 'Block new sign-ins to POS',
      effect: 'ZZ TEST new hand-offs into POS are refused.', valueType: 'boolean', values: null, defaultValue: false,
      scopes: ['platform', 'operator', 'branch', 'station'], supported: true },
    { flagKey: 'payments.qr_tender_disabled', kind: 'kill_switch', targetApp: 'pos', label: 'Disable QR tender',
      effect: 'Not integrated: the till does not read this switch yet.', valueType: 'boolean', values: null, defaultValue: false,
      scopes: ['platform', 'operator', 'branch', 'station'], supported: false },
    { flagKey: 'gate.closed', kind: 'kill_switch', targetApp: 'pos', label: 'Close the gate',
      effect: 'Not integrated: gates and boxes do not read this switch yet.', valueType: 'enum', values: ['open', 'deny_all', 'exit_only'],
      defaultValue: 'open', scopes: ['platform', 'operator', 'branch', 'station'], supported: false },
  ],
  overrides: [{ id: '01964300-0000-7000-8000-0000000000e1', flagKey: PAUSE, kind: 'kill_switch', targetApp: 'inbox',
    scopeType: 'branch', scopeId: BRANCH, operatorId: OPERATOR, value: true, expiresAt: '2026-10-28T03:45:00.000Z',
    reason: 'ZZ TEST stuck provider', updatedBy: OTHER, revision: 2, updatedAt: '2026-10-28T02:45:00.000Z', expired: false }],
  approvals: [],
  ...overrides,
});

const choice: SwitchChoice = { key: PAUSE, scopeType: 'branch', scopeId: BRANCH, operatorId: OPERATOR, value: 'true' };
const preview = (overrides: Partial<SuiteFlagPreview> = {}): SuiteFlagPreview => ({
  generatedAt: '2026-10-28T03:00:00.000Z', flagKey: PAUSE, label: 'Pause outbound messaging', effect: 'ZZ TEST queued replies stay queued.',
  targetApp: 'inbox', scopeType: 'branch', scopeId: BRANCH, operatorId: OPERATOR, value: true,
  branches: [{ branchId: BRANCH, name: 'ZZ TEST Park', operatorId: OPERATOR, current: false, after: true }],
  stations: [], openSessions: 7, changes: 1, ...overrides,
});

const html = (element: ReturnType<typeof createElement>) => renderToStaticMarkup(element);
/** The one native button carrying this marker, or the test fails for its absence. */
function button(markup: string, marker: string) {
  const tag = markup.match(new RegExp(`<button\\b[^>]*data-confirm="${marker}"[^>]*>`));
  expect(tag, `the ${marker} confirm button must render`).not.toBeNull();
  return tag![0];
}
const disabled = (tag: string) => /\bdisabled=""/.test(tag);
function buttonNamed(markup: string, name: string) {
  return [...markup.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)].find(([, , text]) => text === name)?.[1] ?? null;
}

function onForm(overrides: Partial<SwitchOnFormProps> & { reason?: string; confirmation?: string } = {}) {
  const entry = flags().catalogue[0]!;
  const state = { preview: null as SuiteFlagPreview | null, reason: 'ZZ TEST provider outage', confirmation: PAUSE, minutes: 60 as number | null,
    choice, ...overrides };
  const gate = switchOnGate({ choice: state.choice, preview: state.preview, minutes: state.minutes, maxTtlMinutes: 1440,
    reason: state.reason, confirmation: state.confirmation, busy: false });
  const props: SwitchOnFormProps = {
    entry, dualControl: true, defaultTtlMinutes: 60, maxTtlMinutes: 1440, scopeType: 'branch', onScopeType: noop,
    branches: [{ id: BRANCH, name: 'ZZ TEST Park' }], branchesError: null, branchId: BRANCH, onBranch: noop,
    stations: null, stationsError: null, stationId: '', onStation: noop, minutes: state.minutes, onMinutes: noop, nowMs: NOW,
    choice: state.choice, preview: state.preview, previewBusy: false, previewError: null, onPreview: noop,
    reason: state.reason, onReason: noop, confirmation: state.confirmation, onConfirmation: noop, gate, busy: false, error: null,
    onSubmit: noop, ...overrides,
  };
  return { markup: html(createElement(SwitchOnForm, props)), gate };
}

describe('Release controls: preview before confirm (rule b)', () => {
  it('keeps the confirm button off until a preview of this exact choice is on screen', () => {
    const none = onForm();
    expect(disabled(button(none.markup, 'switch-on'))).toBe(true);
    expect(none.gate.missing).toContain('Preview the blast radius of exactly this choice.');
    expect(none.markup).toContain('No preview yet.');

    const shown = onForm({ preview: preview() });
    expect(shown.gate.ready).toBe(true);
    expect(disabled(button(shown.markup, 'switch-on'))).toBe(false);
    expect(shown.markup).toContain('Staff sessions open there');
    expect(shown.markup).toContain('ZZ TEST Park: Off → On');
    expect(shown.markup).toContain('Ask a second administrator');
  });

  it.each([
    ['another park', { scopeId: '01964300-0000-7000-8000-0000000000c2' }],
    ['another scope', { scopeType: 'operator' as const, scopeId: OPERATOR }],
    ['another switch', { flagKey: 'signin.blocked.pos' }],
    ['another value', { value: false }],
    ['another park group', { operatorId: '01964300-0000-7000-8000-0000000000b2' }],
  ])('treats a preview of %s as no preview', (_label, change) => {
    const stale = preview(change as Partial<SuiteFlagPreview>);
    expect(previewMatches(stale, choice)).toBe(false);
    const form = onForm({ preview: stale });
    expect(disabled(button(form.markup, 'switch-on'))).toBe(true);
    expect(form.markup).toContain('The preview on record was for a different choice.');
    expect(form.markup).not.toContain('Staff sessions open there');
  });

  it('cannot preview or confirm a place that is not chosen yet', () => {
    const open = { ...choice, scopeId: null };
    expect(previewMatches(preview({ scopeId: null }), open)).toBe(false);
    const form = onForm({ choice: open, branchId: '' });
    expect(form.gate.missing).toContain('Choose where the switch applies.');
    expect(disabled(button(form.markup, 'switch-on'))).toBe(true);
  });

  it('also gates approving and applying on the preview of the exact reviewed operation', () => {
    const op = operationOf(approval())!;
    const reviewed = choiceOfOperation(op);
    expect(reviewGate({ choice: reviewed, preview: null, confirmation: PAUSE, busy: false }).ready).toBe(false);
    expect(reviewGate({ choice: reviewed, preview: preview(), confirmation: PAUSE, busy: false }).ready).toBe(false);
    const platform = preview({ scopeType: 'platform', scopeId: null, operatorId: null });
    expect(reviewGate({ choice: reviewed, preview: platform, confirmation: PAUSE, busy: false }).ready).toBe(true);
    const step = approvalStep(approval(), ME, true, NOW);
    const markup = (shown: SuiteFlagPreview | null) => html(createElement(ReviewForm, {
      entry: flags().catalogue[0]!, approval: approval(), op, step, choice: reviewed, preview: shown, previewBusy: false,
      previewError: null, onPreview: noop, confirmation: PAUSE, onConfirmation: noop, busy: false, error: null, onSubmit: noop, me: ME,
      gate: reviewGate({ choice: reviewed, preview: shown, confirmation: PAUSE, busy: false }),
    }));
    expect(disabled(button(markup(null), 'approve'))).toBe(true);
    expect(disabled(button(markup(platform), 'approve'))).toBe(false);
  });

  it('shows the blast radius it was given, with no park or station change said plainly', () => {
    const markup = html(createElement(BlastRadius, { preview: preview({ branches: [], changes: 0, openSessions: 0 }), choice,
      busy: false, error: null, onPreview: noop, canPreview: true }));
    expect(markup).toContain('ZZ TEST queued replies stay queued.');
    expect(markup).toContain('No park changes');
    expect(markup).toContain('No station changes.');
    const failed = html(createElement(BlastRadius, { preview: null, choice, busy: false, error: 'ZZ TEST That switch is not in the catalogue.',
      onPreview: noop, canPreview: true }));
    expect(failed).toContain('ZZ TEST That switch is not in the catalogue.');
  });
});

describe('Release controls: typed confirmation, reason and expiry (rules a and c)', () => {
  it('requires the reason and the exact typed phrase before the confirm button enables', () => {
    const noReason = onForm({ preview: preview(), reason: '   ' });
    expect(noReason.gate.missing).toEqual(['Give a reason.']);
    expect(disabled(button(noReason.markup, 'switch-on'))).toBe(true);
    const wrongPhrase = onForm({ preview: preview(), confirmation: 'messaging' });
    expect(wrongPhrase.gate.missing).toEqual([`Type ${PAUSE} exactly to confirm.`]);
    expect(disabled(button(wrongPhrase.markup, 'switch-on'))).toBe(true);
    expect(wrongPhrase.markup).toContain(`<code class="font-mono break-all">${PAUSE}</code>`);
  });

  it('carries an expiry within the server maximum and says when the switch reverts', () => {
    expect(onForm({ preview: preview(), minutes: null }).gate.missing).toEqual(['Choose how many minutes it lasts (at least 1).']);
    expect(onForm({ preview: preview(), minutes: 0 }).gate.ready).toBe(false);
    const tooLong = onForm({ preview: preview(), minutes: 1441 });
    expect(tooLong.gate.missing).toEqual(['The server allows at most 1440 minutes.']);
    expect(disabled(button(tooLong.markup, 'switch-on'))).toBe(true);
    const ok = onForm({ preview: preview(), minutes: 60 });
    expect(ok.markup).toContain('Default 60, at most 1440.');
    expect(ok.markup).toContain('auto-reverts at <time dateTime="2026-10-28T04:00:00.000Z"');
  });

  it('switching off restores service with one administrator, a reason and the phrase, and no second approval', () => {
    const entry = flags().catalogue[0]!, override = flags().overrides[0]!;
    const form = (reason: string, confirmation: string) => html(createElement(SwitchOffForm, { entry, override, reason, onReason: noop,
      confirmation, onConfirmation: noop, busy: false, error: null, onSubmit: noop,
      gate: switchOffGate({ key: PAUSE, reason, confirmation, busy: false }) }));
    expect(disabled(button(form('', PAUSE), 'switch-off'))).toBe(true);
    expect(disabled(button(form('ZZ TEST provider back', 'wrong'), 'switch-off'))).toBe(true);
    const ready = form('ZZ TEST provider back', PAUSE);
    expect(disabled(button(ready, 'switch-off'))).toBe(false);
    expect(ready).toContain('One administrator is enough.');
    expect(ready).not.toContain('second administrator');
  });

  it('shows the server refusal message verbatim', () => {
    const refused = onForm({ preview: preview(), error: 'A kill switch must expire within 1440 minutes.' });
    expect(refused.markup).toContain('A kill switch must expire within 1440 minutes.');
  });
});

describe('Release controls: only integrated switches are actionable (Q24)', () => {
  const card = (canWrite: boolean, overrides: Partial<SuiteFlags> = {}) => html(createElement(KillSwitchCard, {
    flags: flags(overrides), me: ME, canWrite, nowMs: NOW, onSwitchOn: noop, onSwitchOff: noop, onReview: noop }));
  const row = (markup: string, key: string) => {
    const found = markup.match(new RegExp(`<article\\b[^>]*data-flag="${key.replace(/\./g, '\\.')}"[^>]*>[\\s\\S]*?</article>`));
    expect(found, `${key} must be listed`).not.toBeNull();
    return found![0];
  };

  it('lists the unsupported switches as not wired, with no control at all', () => {
    const markup = card(true);
    for (const key of ['payments.qr_tender_disabled', 'gate.closed']) {
      const unsupported = row(markup, key);
      expect(unsupported).toContain('Not wired to its consumer yet');
      expect(unsupported).not.toContain('<button');
      expect(unsupported).not.toContain('<input');
    }
  });

  it('offers switch-on for the two integrated switches and switch-off for what is on, with who, why and when it reverts', () => {
    const markup = card(true);
    const pause = row(markup, PAUSE);
    expect(buttonNamed(pause, 'Switch on…')).not.toBeNull();
    expect(buttonNamed(pause, 'Switch off…')).not.toBeNull();
    expect(pause).toContain('On at 1 place');
    expect(pause).toContain(`Account ${OTHER}`);
    expect(pause).toContain('ZZ TEST stuck provider');
    expect(pause).toContain('Auto-reverts at');
    expect(pause).toContain('2026-10-28T03:45:00.000Z');
    const signIn = row(markup, 'signin.blocked.pos');
    expect(buttonNamed(signIn, 'Switch on…')).not.toBeNull();
    expect(signIn).toContain('Not set anywhere');
    expect(markup).toContain('at most 1440 minutes');
  });

  it('does not offer switch-off for an expired record, which already reads as normal', () => {
    const expired = { ...flags().overrides[0]!, expiresAt: '2026-10-28T02:59:00.000Z', expired: true };
    const pause = row(card(true, { overrides: [expired] }), PAUSE);
    expect(buttonNamed(pause, 'Switch off…')).toBeNull();
    expect(pause).toContain('Expired at');
    expect(pause).toContain('Not set anywhere');
  });

  it('shows a reader without the platform grant every switch and no control', () => {
    const markup = card(false, { approvals: [approval()] });
    expect(markup).toContain('console:release:kill_switch');
    expect(markup).not.toContain('Switch on…');
    expect(markup).not.toContain('Switch off…');
    const approve = buttonNamed(markup, 'Approve…');
    expect(approve).not.toBeNull();
    expect(disabled(approve!)).toBe(true);
    expect(markup).toContain('Approving needs a platform administrator.');
  });
});

describe('Release controls: dual control', () => {
  const pending = (item: Approval, me = ME, canWrite = true) => html(createElement(PendingApprovalCard, {
    approval: item, me, canWrite, nowMs: NOW, onReview: noop }));

  it('shows my own pending request with approve disabled and the reason why', () => {
    const markup = pending(approval({ requesterAccountId: ME }));
    expect(markup).toContain('Waiting for a second administrator');
    expect(markup).toContain('Requested by');
    expect(markup).toContain('>You<');
    expect(markup).toContain('ZZ TEST provider outage');
    expect(markup).toContain('Request expires');
    expect(markup).toContain(LATER);
    expect(disabled(buttonNamed(markup, 'Approve…')!)).toBe(true);
    expect(markup).toContain('You asked for this switch. A different platform administrator must approve it.');
  });

  it('lets a different administrator approve, then the requester or approver apply', () => {
    expect(disabled(buttonNamed(pending(approval()), 'Approve…')!)).toBe(false);
    const approved = approval({ state: 'approved', requesterAccountId: OTHER, approverAccountId: ME });
    expect(disabled(buttonNamed(pending(approved), 'Apply…')!)).toBe(false);
    expect(disabled(buttonNamed(pending(approved, OTHER), 'Apply…')!)).toBe(false);
    const bystander = pending(approved, THIRD);
    expect(disabled(buttonNamed(bystander, 'Apply…')!)).toBe(true);
    expect(bystander).toContain('Only the administrator who asked or the one who approved can apply it.');
  });

  it('offers nothing on a request whose ten minutes have passed', () => {
    const markup = html(createElement(PendingApprovalCard, { approval: approval(), me: ME, canWrite: true,
      nowMs: Date.parse(LATER), onReview: noop }));
    expect(markup).not.toContain('<button');
    expect(markup).toContain('This request was not approved within ten minutes; ask again.');
  });

  it('does not offer a request whose stored operation cannot be read', () => {
    const broken = approval({ operation: { key: PAUSE } });
    expect(operationOf(broken)).toBeNull();
    const markup = pending(broken);
    expect(markup).toContain('could not be read');
    expect(markup).not.toContain('<button');
  });
});

describe('Release controls: feature flags', () => {
  it('says plainly that no flag can be changed while none is supported, and offers no control', () => {
    const markup = html(createElement(FeatureFlagsCard, { flags: flags() }));
    expect(markup).toContain('No feature flag can be changed yet.');
    expect(markup).not.toContain('<button');
    const unsupported = flags();
    unsupported.catalogue.push({ flagKey: 'zz.test_feature', kind: 'feature', targetApp: 'pos', label: 'ZZ TEST feature',
      effect: 'ZZ TEST effect', valueType: 'boolean', values: null, defaultValue: false, scopes: ['platform'], supported: false });
    const listed = html(createElement(FeatureFlagsCard, { flags: unsupported }));
    expect(listed).toContain('ZZ TEST feature');
    expect(listed).toContain('Not wired to its consumer yet');
    expect(listed).not.toContain('<button');
  });
});

describe('App maintenance set and clear', () => {
  const app: SuiteApps['apps'][number] = {
    id: '01964300-0000-7000-8000-0000000000f1', key: 'inbox', name: 'ZZ TEST Inbox', purpose: 'ZZ TEST purpose', origins: {},
    schemaName: 'inbox', owningService: 'api', healthUrl: null, versionSource: 'build_id', requiredPermission: 'app:inbox:access',
    sortOrder: 6, storedState: 'open', effectiveState: 'open', revision: 3, maintenance: null,
  };
  const setForm = (input: { message: string; minutes: number | null; reason: string; confirmation: string; max?: number | null }) =>
    html(createElement(MaintenanceSetForm, { app, message: input.message, onMessage: noop, minutes: input.minutes, onMinutes: noop,
      defaultMinutes: 60, maxTtlMinutes: input.max === undefined ? 1440 : input.max, nowMs: NOW, reason: input.reason, onReason: noop,
      confirmation: input.confirmation, onConfirmation: noop, busy: false, error: null, onSubmit: noop,
      gate: maintenanceSetGate({ appKey: 'inbox', message: input.message, minutes: input.minutes,
        maxTtlMinutes: input.max === undefined ? 1440 : input.max, reason: input.reason, confirmation: input.confirmation, busy: false }) }));

  it('sets maintenance only with a message, a bounded window, a reason and the app key typed', () => {
    const complete = { message: 'ZZ TEST back at noon', minutes: 60, reason: 'ZZ TEST upgrade', confirmation: 'inbox' };
    const ready = setForm(complete);
    expect(disabled(button(ready, 'maintenance-set'))).toBe(false);
    expect(ready).toContain('New hand-offs into ZZ TEST Inbox are refused, at every park.');
    expect(ready).toContain('Sessions already open in ZZ TEST Inbox, platform sign-in and every other app keep working.');
    expect(ready).toContain('ends at <time dateTime="2026-10-28T04:00:00.000Z"');
    for (const missing of [{ message: ' ' }, { minutes: null }, { minutes: 1441 }, { reason: '' }, { confirmation: 'Inbox' }]) {
      expect(disabled(button(setForm({ ...complete, ...missing }), 'maintenance-set'))).toBe(true);
    }
    expect(maintenanceSetGate({ appKey: 'inbox', ...complete, minutes: 1441, maxTtlMinutes: 1440, busy: false }).missing)
      .toEqual(['The server allows at most 1440 minutes.']);
    const unknownMax = setForm({ ...complete, minutes: 5000, max: null });
    expect(unknownMax).toContain('the server sets the maximum');
    expect(disabled(button(unknownMax, 'maintenance-set'))).toBe(false);
  });

  it('clears maintenance with a reason and the app key typed', () => {
    const inMaintenance = { ...app, storedState: 'maintenance' as const, effectiveState: 'maintenance' as const,
      maintenance: { message: 'ZZ TEST back at noon', expiresAt: '2026-10-28T04:00:00.000Z' } };
    const form = (reason: string, confirmation: string) => html(createElement(MaintenanceClearForm, { app: inMaintenance, reason,
      onReason: noop, confirmation, onConfirmation: noop, busy: false, error: null, onSubmit: noop,
      gate: maintenanceClearGate({ appKey: 'inbox', reason, confirmation, busy: false }) }));
    expect(disabled(button(form('', 'inbox'), 'maintenance-clear'))).toBe(true);
    expect(disabled(button(form('ZZ TEST done', 'pos'), 'maintenance-clear'))).toBe(true);
    const ready = form('ZZ TEST done', 'inbox');
    expect(disabled(button(ready, 'maintenance-clear'))).toBe(false);
    expect(ready).toContain('ZZ TEST back at noon');
    const refused = html(createElement(MaintenanceClearForm, { app: inMaintenance, reason: 'ZZ TEST done', onReason: noop,
      confirmation: 'inbox', onConfirmation: noop, busy: false, onSubmit: noop, error: 'This app is not in maintenance.',
      gate: maintenanceClearGate({ appKey: 'inbox', reason: 'ZZ TEST done', confirmation: 'inbox', busy: false }) }));
    expect(refused).toContain('This app is not in maintenance.');
  });
});

describe('Deploy history', () => {
  const history = (overrides: Partial<SuiteReleases> = {}): SuiteReleases => ({
    generatedAt: '2026-10-28T03:00:00.000Z', total: 0, limit: 50, offset: 0, deployments: [], ...overrides });

  it('says nothing has been recorded yet rather than implying zero deploys', () => {
    const markup = html(createElement(DeployHistoryBody, { answer: history() }));
    expect(markup).toContain('No releases are recorded.');
    expect(markup).toContain('Nothing has reported a deploy to this history yet.');
    expect(markup).toContain('not a statement that nothing was deployed');
    expect(markup).not.toContain('<table');
    expect(markup).not.toContain('<article');
  });

  it('keeps an empty page distinct from an empty history, and null facts as not recorded', () => {
    expect(html(createElement(DeployHistoryBody, { answer: history({ total: 3, offset: 50 }) }))).toContain('No releases on this page.');
    const markup = html(createElement(DeployHistoryBody, { answer: history({ total: 1, deployments: [{
      id: '01964300-0000-7000-8000-000000000101', app: 'console', appName: 'ZZ TEST Admin', version: null, commit: null,
      actorAccountId: null, status: 'recorded', ciGreen: null, deployedAt: null, recordedAt: '2026-10-28T03:00:00.000Z' }] }) }));
    expect(markup.match(/Not recorded/g)).toHaveLength(5);
    expect(markup).not.toContain('Passed');
  });
});

describe('Suite control permission states', () => {
  const grant = (permission: string, scopeId: string | null = OPERATOR, scopeType = 'operator') => ({ permission, scopeType, scopeId });
  beforeEach(() => { session.value = null; });
  const signedIn = (permissions: ReturnType<typeof grant>[], isPlatformAdmin = false) => {
    session.value = {
      state: 'signed-in', refreshing: false, authorityEpoch: 1, isCurrentAuthority: () => true, permissions,
      me: { account: { id: ME, status: 'active', mustChangePassword: false }, sessionLocked: false, isPlatformAdmin,
        operatorContext: { effectiveOperatorId: OPERATOR } },
    };
  };
  const page = (which: 'apps' | 'releases') => renderToStaticMarkup(createElement(Router, {
    ssrPath: which === 'apps' ? '/organisation/apps' : '/watch/releases', children: createElement(SuiteControls, { page: which }) }));

  it('refuses both pages without the operator-wide read', () => {
    for (const permissions of [[], [grant('console:release:read', BRANCH, 'branch'), grant('console:app_registry:read', BRANCH, 'branch')]]) {
      signedIn(permissions);
      expect(page('releases')).toContain('This page is not on your access');
      expect(page('releases')).toContain('console:release:read');
      expect(page('apps')).toContain('console:app_registry:read');
    }
  });

  it('marks readers read only and names the platform grant a change needs', () => {
    signedIn([grant('console:release:read'), grant('console:app_registry:read'), grant('console:release:kill_switch'),
      grant('console:app_registry:manage')]);
    const releases = page('releases');
    expect(releases).not.toContain('This page is not on your access');
    expect(releases).toContain('Read only');
    expect(releases).not.toContain('Switch on…');
    const apps = page('apps');
    expect(apps).toContain('Read only');
    expect(apps).toContain('console:app_registry:manage');
    expect(apps).not.toContain('maintenance…');
  });

  it('offers platform controls only to a platform administrator holding the grant platform-wide', () => {
    signedIn([grant('console:release:read'), grant('console:app_registry:read'), grant('console:release:kill_switch', null),
      grant('console:app_registry:manage', null)], true);
    expect(page('releases')).toContain('Platform controls');
    const apps = page('apps');
    expect(apps).toContain('Platform controls');
    expect(apps).not.toContain('held by a platform administrator');
  });
});
