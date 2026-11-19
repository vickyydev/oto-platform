import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Router } from 'wouter';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SuiteFlagPreview, SuiteFlags } from '@/api/suite-controls';
import {
  FeatureFlagsCard, FeatureSetForm, KillSwitchCard, SwitchOffForm, type FeatureSetFormProps,
} from '@/components/suite/SuiteControlViews';
import {
  choiceAt, featureSetGate, featureValueChoices, isActionableSwitch, isSettableFeature, switchOffGate, type CatalogueEntry,
  type SwitchChoice,
} from '@/lib/suiteControlRules';
import { SuiteControls } from '@/pages/SuiteControls';

/**
 * SCRUM-1024 (family profiles, plan step F3): the Release controls page
 * offers a supported feature switch with named values (`crm.family_profiles`)
 * to a platform administrator holding `console:release:flag_manage`
 * platform-wide: a value at a place, kept with no expiry, after a preview of
 * exactly that choice, a reason and the typed key; and "Switch off…" (the
 * clear route) back to the default. The server refuses `on` at the preview
 * (FLAG_VALUE_UNSUPPORTED), so the confirm stays closed for it. The server
 * side is pinned in apps/api/test/s1024-family-readers.test.ts.
 */

const session = vi.hoisted(() => ({ value: null as unknown }));
vi.mock('@/auth/SessionContext', () => ({ useSession: () => session.value }));

const ME = '01964300-0000-7000-8000-0000000000a1';
const OTHER = '01964300-0000-7000-8000-0000000000a2';
const OPERATOR = '01964300-0000-7000-8000-0000000000b1';
const BRANCH = '01964300-0000-7000-8000-0000000000c1';
const NOW = Date.parse('2026-11-19T03:00:00.000Z');
const FAMILY = 'crm.family_profiles';
const PAUSE = 'messaging.outbound_paused';
const REFUSED = 'This value of the switch is not connected to anything yet, so it cannot be set.';
const noop = () => undefined;

const familyEntry: CatalogueEntry = {
  flagKey: FAMILY, kind: 'feature', targetApp: 'pos', label: 'Family profiles',
  effect: 'ZZ TEST readers find a member\'s children through the family.', valueType: 'enum', values: ['off', 'read', 'on'],
  defaultValue: 'off', scopes: ['operator'], supported: true,
};
const pauseEntry: CatalogueEntry = {
  flagKey: PAUSE, kind: 'kill_switch', targetApp: 'inbox', label: 'Pause outbound messaging',
  effect: 'ZZ TEST queued replies stay queued.', valueType: 'boolean', values: null, defaultValue: false,
  scopes: ['platform', 'operator', 'branch'], supported: true,
};
type Override = SuiteFlags['overrides'][number];
const readOverride: Override = {
  id: '01964300-0000-7000-8000-0000000000e2', flagKey: FAMILY, kind: 'feature', targetApp: 'pos', scopeType: 'operator',
  scopeId: OPERATOR, operatorId: OPERATOR, value: 'read', expiresAt: null, reason: 'ZZ TEST family readers',
  updatedBy: OTHER, revision: 1, updatedAt: '2026-11-19T02:00:00.000Z', expired: false,
};
const flags = (overrides: Partial<SuiteFlags> = {}): SuiteFlags => ({
  generatedAt: '2026-11-19T03:00:00.000Z', maxTtlMinutes: 1440, defaultTtlMinutes: 60, killSwitchDualControl: true,
  catalogue: [pauseEntry, familyEntry], overrides: [], approvals: [], ...overrides,
});

const html = (element: ReturnType<typeof createElement>) => renderToStaticMarkup(element);
function confirmButton(markup: string, marker: string) {
  const tag = markup.match(new RegExp(`<button\\b[^>]*data-confirm="${marker}"[^>]*>`));
  expect(tag, `the ${marker} confirm button must render`).not.toBeNull();
  return tag![0];
}
const disabled = (tag: string) => /\bdisabled=""/.test(tag);
const buttonsNamed = (markup: string, name: string) =>
  [...markup.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)].filter(([, , text]) => text === name);

const readChoice: SwitchChoice = { key: FAMILY, scopeType: 'operator', scopeId: OPERATOR, operatorId: OPERATOR, value: 'read' };
const preview = (overrides: Partial<SuiteFlagPreview> = {}): SuiteFlagPreview => ({
  generatedAt: '2026-11-19T03:00:00.000Z', flagKey: FAMILY, label: 'Family profiles', effect: familyEntry.effect,
  targetApp: 'pos', scopeType: 'operator', scopeId: OPERATOR, operatorId: OPERATOR, value: 'read',
  branches: [{ branchId: BRANCH, name: 'ZZ TEST Park', operatorId: OPERATOR, current: 'off', after: 'read' }],
  stations: [], openSessions: 3, changes: 1, ...overrides,
});

describe('which switches the page offers to set (SCRUM-1024)', () => {
  it('offers the family switch\'s values other than the default, and no kill switch or boolean feature through this path', () => {
    expect(featureValueChoices(familyEntry)).toEqual(['read', 'on']);
    expect(isSettableFeature(familyEntry)).toBe(true);
    expect(isActionableSwitch(familyEntry)).toBe(false);
    expect(isSettableFeature(pauseEntry)).toBe(false);
    expect(isSettableFeature({ ...familyEntry, supported: false })).toBe(false);
    expect(isSettableFeature({ ...familyEntry, valueType: 'boolean', values: null, defaultValue: false })).toBe(false);
    expect(isSettableFeature({ ...familyEntry, values: ['off'] })).toBe(false);
  });

  it('names a park group\'s own place for an operator-scoped switch', () => {
    expect(choiceAt({ key: FAMILY, scopeType: 'operator', operatorId: OPERATOR, branchId: '', stationId: '', value: 'read' }))
      .toEqual(readChoice);
    expect(choiceAt({ key: PAUSE, scopeType: 'platform', operatorId: OPERATOR, branchId: BRANCH, stationId: '', value: 'true' }))
      .toEqual({ key: PAUSE, scopeType: 'platform', scopeId: null, operatorId: null, value: 'true' });
    expect(choiceAt({ key: PAUSE, scopeType: 'branch', operatorId: OPERATOR, branchId: '', stationId: '', value: 'true' }).scopeId)
      .toBeNull();
  });
});

describe('the feature flags card', () => {
  it('lists the family switch read only, naming the grant, to anyone without the platform-wide flag grant', () => {
    const markup = html(createElement(FeatureFlagsCard, { flags: flags(), me: ME, canWrite: false, nowMs: NOW, onSet: noop, onSwitchOff: noop }));
    expect(markup).toContain('Family profiles');
    expect(markup).toContain('console:release:flag_manage');
    expect(markup).toContain('Values offered');
    expect(markup).not.toContain('<button');
    expect(markup).not.toContain('Changing a feature flag is not offered on this page yet.');
  });

  it('offers Set… to a holder, and Switch off… only on a place that is set', () => {
    const unset = html(createElement(FeatureFlagsCard, { flags: flags(), me: ME, canWrite: true, nowMs: NOW, onSet: noop, onSwitchOff: noop }));
    expect(buttonsNamed(unset, 'Set…')).toHaveLength(1);
    expect(buttonsNamed(unset, 'Switch off…')).toHaveLength(0);
    expect(unset).toContain('Supported');
    expect(unset).not.toContain('console:release:flag_manage</code> held by');

    const set = html(createElement(FeatureFlagsCard, { flags: flags({ overrides: [readOverride] }), me: ME, canWrite: true, nowMs: NOW,
      onSet: noop, onSwitchOff: noop }));
    expect(set).toContain('Set at 1 place');
    expect(set).toContain('This park group');
    expect(set).toContain('ZZ TEST family readers');
    expect(set).toContain('Never: it stays until it is cleared');
    expect(set).not.toContain('Auto-reverts at');
    expect(buttonsNamed(set, 'Switch off…')).toHaveLength(1);
    expect(buttonsNamed(set, 'Set…')).toHaveLength(1);
  });

  it('offers nothing for an unsupported feature or a boolean one, even to a holder', () => {
    const others = flags({ catalogue: [pauseEntry,
      { ...familyEntry, flagKey: 'zz.test_unsupported', label: 'ZZ TEST unsupported', supported: false },
      { ...familyEntry, flagKey: 'zz.test_boolean', label: 'ZZ TEST boolean', valueType: 'boolean', values: null, defaultValue: false }] });
    const markup = html(createElement(FeatureFlagsCard, { flags: others, me: ME, canWrite: true, nowMs: NOW, onSet: noop, onSwitchOff: noop }));
    expect(markup).toContain('ZZ TEST unsupported');
    expect(markup).toContain('ZZ TEST boolean');
    expect(markup).toContain('Changing a feature flag is not offered on this page yet.');
    expect(markup).not.toContain('<button');
  });

  it('keeps the family switch off the kill switch card', () => {
    const markup = html(createElement(KillSwitchCard, { flags: flags({ overrides: [readOverride] }), me: ME, canWrite: true, nowMs: NOW,
      onSwitchOn: noop, onSwitchOff: noop, onReview: noop }));
    expect(markup).not.toContain('Family profiles');
    expect(markup).not.toContain(FAMILY);
  });
});

describe('setting the family switch', () => {
  function setForm(input: { choice?: SwitchChoice; value?: string; preview?: SuiteFlagPreview | null; previewError?: string | null;
    reason?: string; confirmation?: string } = {}) {
    const state = { choice: readChoice, value: 'read', preview: preview() as SuiteFlagPreview | null, previewError: null as string | null,
      reason: 'ZZ TEST readers through the family', confirmation: FAMILY, ...input };
    const gate = featureSetGate({ entry: familyEntry, choice: state.choice, preview: state.preview, reason: state.reason,
      confirmation: state.confirmation, busy: false });
    const props: FeatureSetFormProps = {
      entry: familyEntry, scopeType: 'operator', onScopeType: noop, branches: null, branchesError: null, branchId: '', onBranch: noop,
      stations: null, stationsError: null, stationId: '', onStation: noop, value: state.value, onValue: noop, choice: state.choice,
      preview: state.preview, previewBusy: false, previewError: state.previewError, onPreview: noop, reason: state.reason, onReason: noop,
      confirmation: state.confirmation, onConfirmation: noop, gate, busy: false, error: null, onSubmit: noop,
    };
    return { gate, markup: html(createElement(FeatureSetForm, props)) };
  }

  it('sets read only with the place, the value, a preview of exactly that, a reason and the key typed; no expiry is asked', () => {
    const { gate, markup } = setForm();
    expect(gate).toEqual({ ready: true, missing: [] });
    expect(disabled(confirmButton(markup, 'feature-set'))).toBe(false);
    expect(markup).toContain('What changes: ');
    expect(markup).not.toContain('What stops working');
    expect(markup).toContain('ZZ TEST Park');
    expect(markup).toContain('No expiry');
    expect(markup).not.toContain('Minutes until');
    expect(buttonsNamed(markup, 'read')).toHaveLength(1);
    expect(buttonsNamed(markup, 'on')).toHaveLength(1);
    expect(buttonsNamed(markup, 'off')).toHaveLength(0);
  });

  it('stays closed while anything is missing', () => {
    const cases: Array<[Parameters<typeof setForm>[0], string]> = [
      [{ choice: { ...readChoice, value: '' }, value: '' }, 'Choose a value.'],
      [{ choice: { ...readChoice, value: 'off' }, value: 'off' }, 'Choose a value.'],
      [{ preview: null }, 'Preview exactly what this choice changes.'],
      [{ preview: preview({ value: 'on' }) }, 'Preview exactly what this choice changes.'],
      [{ reason: '  ' }, 'Give a reason.'],
      [{ confirmation: 'crm.family' }, `Type ${FAMILY} exactly to confirm.`],
      [{ choice: { ...readChoice, scopeId: null } }, 'Choose where the switch applies.'],
    ];
    for (const [input, missing] of cases) {
      const { gate, markup } = setForm(input);
      expect(gate.ready).toBe(false);
      expect(gate.missing).toContain(missing);
      expect(disabled(confirmButton(markup, 'feature-set'))).toBe(true);
    }
  });

  it('keeps Set closed for on, which the server refuses at the preview', () => {
    const onChoice = { ...readChoice, value: 'on' };
    const { gate, markup } = setForm({ choice: onChoice, value: 'on', preview: null, previewError: REFUSED });
    expect(gate.missing).toEqual(['Preview exactly what this choice changes.']);
    expect(markup).toContain(REFUSED);
    expect(disabled(confirmButton(markup, 'feature-set'))).toBe(true);
    // A preview kept from read never opens the confirm for on.
    expect(setForm({ choice: onChoice, value: 'on', preview: preview() }).gate.ready).toBe(false);
  });
});

describe('switching the family switch off', () => {
  it('returns the place to the default with a reason and the key typed, and says the setting had no expiry', () => {
    const form = (reason: string, confirmation: string) => html(createElement(SwitchOffForm, { entry: familyEntry, override: readOverride,
      reason, onReason: noop, confirmation, onConfirmation: noop, busy: false, error: null, onSubmit: noop,
      gate: switchOffGate({ key: FAMILY, reason, confirmation, busy: false }) }));
    const ready = form('ZZ TEST back to off', FAMILY);
    expect(disabled(confirmButton(ready, 'switch-off'))).toBe(false);
    expect(ready).toContain('returns this place to the default (off)');
    expect(ready).not.toContain('restores service');
    expect(ready).toContain('Never: it stays until it is cleared');
    expect(ready).not.toContain('Would auto-revert at');
    expect(disabled(confirmButton(form('', FAMILY), 'switch-off'))).toBe(true);
    expect(disabled(confirmButton(form('ZZ TEST back to off', 'off'), 'switch-off'))).toBe(true);
  });
});

describe('the page\'s controls badge', () => {
  const grant = (permission: string, scopeId: string | null = OPERATOR) => ({ permission, scopeType: 'operator', scopeId });
  beforeEach(() => { session.value = null; });
  const releases = (permissions: ReturnType<typeof grant>[], isPlatformAdmin: boolean) => {
    session.value = {
      state: 'signed-in', refreshing: false, authorityEpoch: 1, isCurrentAuthority: () => true, permissions,
      me: { account: { id: ME, status: 'active', mustChangePassword: false }, sessionLocked: false, isPlatformAdmin,
        operatorContext: { effectiveOperatorId: OPERATOR } },
    };
    return renderToStaticMarkup(createElement(Router, { ssrPath: '/watch/releases', children: createElement(SuiteControls, { page: 'releases' }) }));
  };

  it('shows platform controls to a platform administrator holding only the flag grant platform-wide, and read only otherwise', () => {
    expect(releases([grant('console:release:read'), grant('console:release:flag_manage', null)], true)).toContain('Platform controls');
    expect(releases([grant('console:release:read'), grant('console:release:flag_manage')], true)).toContain('Read only');
    expect(releases([grant('console:release:read'), grant('console:release:flag_manage', null)], false)).toContain('Read only');
  });
});
