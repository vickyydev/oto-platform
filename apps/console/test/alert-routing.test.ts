import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { MuteForm, MutedBadge } from '@/components/failures/MuteControls';
import {
  MUTE_MAX_MINUTES,
  canExportActivity,
  muteDurations,
  muteFormProblem,
  recipientAddressWords,
  recipientFormProblem,
} from '@/lib/alertRouting';

/** SCRUM-644 (Q25): the console half of the export, mute and recipient rules. */
describe('SCRUM-644 console rules', () => {
  it('offers the export only for an operator-wide console:activity:export grant', () => {
    expect(canExportActivity([{ permission: 'admin:audit:read', scopeType: 'operator' }])).toBe(false);
    expect(canExportActivity([{ permission: 'console:activity:export', scopeType: 'branch' }])).toBe(false);
    expect(canExportActivity([{ permission: 'console:activity:export', scopeType: 'operator' }])).toBe(true);
  });

  it('requires a reason and caps a mute at 24 hours', () => {
    expect(muteFormProblem({ reason: '', minutes: 60 })).toMatch(/why/i);
    expect(muteFormProblem({ reason: '   ', minutes: 60 })).toMatch(/why/i);
    expect(muteFormProblem({ reason: 'ZZ TEST', minutes: MUTE_MAX_MINUTES + 1 })).toMatch(/24 hours/);
    expect(muteFormProblem({ reason: 'ZZ TEST', minutes: MUTE_MAX_MINUTES })).toBeNull();
    expect(Math.max(...muteDurations().map((d) => d.minutes))).toBe(MUTE_MAX_MINUTES);
    // A server that answers a smaller maximum is never offered more.
    expect(Math.max(...muteDurations(240).map((d) => d.minutes))).toBe(240);
    expect(Math.max(...muteDurations(10_000).map((d) => d.minutes))).toBe(MUTE_MAX_MINUTES);
  });

  it('renders the mute form with the one-hour default and no option past a day', () => {
    const html = renderToStaticMarkup(createElement(MuteForm, { fingerprint: 'zz', maxMinutes: MUTE_MAX_MINUTES, onDone: () => {}, onCancel: () => {} }));
    const values = [...html.matchAll(/<option value="(\d+)"/g)].map((m) => Number(m[1]));
    expect(Math.max(...values)).toBe(1440);
    expect(html).toMatch(/<option value="60" selected="">/);
    expect(html).toContain('A mute lasts at most 24 hours.');
  });

  it('marks a muted group with its end, reason and held-back count', () => {
    const html = renderToStaticMarkup(createElement(MutedBadge, { mute: { id: 'zz', fingerprint: 'zz', scope: 'operator',
      reason: 'ZZ TEST swap', startsAt: '2026-10-27T04:00:00.000Z', mutedUntil: '2026-10-27T05:00:00.000Z',
      createdByAccountId: 'zz', createdByName: null, heldBack: 3 }, timezone: 'Asia/Bangkok' }));
    expect(html).toContain('Muted until');
    expect(html).toContain('ZZ TEST swap');
    expect(html).toContain('3 held back');
  });

  it('names the environment variable and whether it is set, never an address', () => {
    expect(recipientAddressWords({ channel: 'email', addressRef: 'ALERT_ONCALL_EMAIL', addressConfigured: true }))
      .toBe('Reads ALERT_ONCALL_EMAIL (set on this deployment)');
    expect(recipientAddressWords({ channel: 'webhook', addressRef: 'ALERT_HOOK', addressConfigured: false }))
      .toBe('Reads ALERT_HOOK (not set on this deployment)');
    expect(recipientAddressWords({ channel: 'console', addressRef: null, addressConfigured: null })).toMatch(/console log/);
  });

  it('refuses an address typed where a variable name belongs', () => {
    expect(recipientFormProblem({ category: 'ops.failing', channel: 'email', addressRef: 'oncall@example.test' })).toMatch(/never the address/);
    expect(recipientFormProblem({ category: 'ops.failing', channel: 'webhook', addressRef: 'https://hooks.example.test' })).toMatch(/never the address/);
    expect(recipientFormProblem({ category: 'ops.failing', channel: 'email', addressRef: 'DATABASE_URL' })).toMatch(/ALERT_/);
    expect(recipientFormProblem({ category: 'ops.failing', channel: 'email', addressRef: 'ALERT_ONCALL_EMAIL' })).toBeNull();
    expect(recipientFormProblem({ category: 'ops.failing', channel: 'console', addressRef: 'ALERT_X' })).toMatch(/no address/);
    expect(recipientFormProblem({ category: 'Not valid', channel: 'console', addressRef: '' })).toMatch(/alert family/);
  });
});
