import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Router } from 'wouter';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ImpersonationApproval, SupportLookup, SupportTrace } from '@/api/support';
import { readFileSync } from 'node:fs';
import { ImpersonationBanner, markViewAsOffset, VIEW_AS_ACTIVE } from '@/components/ImpersonationBanner';
import {
  ApprovalCards, ImpersonationStartForm, LookupResults, RefusalNote, TraceView,
} from '@/components/support/SupportViews';
import { consoleNav, findSection, sectionForPath, visibleNavigation } from '@/components/consoleSections';
import {
  IMPERSONATION_REFUSALS, groupByApp, startGate, traceFromSearch, type StartDraft,
} from '@/lib/supportRules';

/**
 * SCRUM-648 Support tools (S2-23 P5-6), pinned on the markup the page
 * renders: grouped and denied lookup sections with masked values, trace gaps,
 * every impersonation refusal in words, the write approval the start needs,
 * and the banner in the console shell for the whole window.
 */

const session = vi.hoisted(() => ({ value: null as unknown }));
vi.mock('@/auth/SessionContext', () => ({
  useSession: () => session.value,
  displayName: () => 'ZZ Admin',
}));
vi.mock('@/lib/platformStatus', () => ({
  usePlatformStatus: () => ({ snapshot: null, ready: null }),
  unacknowledgedAlerts: () => 0,
}));

const ME = '01964800-0000-7000-8000-0000000000a1';
const SUBJECT = '01964800-0000-7000-8000-0000000000a2';
const OTHER = '01964800-0000-7000-8000-0000000000a3';
const OPERATOR = '01964800-0000-7000-8000-0000000000b1';
const WINDOW = '01964800-0000-7000-8000-0000000000c1';
const NOW = Date.parse('2026-10-28T03:00:00.000Z');
const noop = () => undefined;
const html = (element: ReturnType<typeof createElement>) => renderToStaticMarkup(element);

const lookup: SupportLookup = {
  generatedAt: '2026-10-28T03:00:00.000Z', kinds: ['phone'], detected: true, masked: true,
  sections: [
    { key: 'pos.sales', app: 'pos', kind: 'phone', label: 'Sales and payments', status: 'denied', permission: 'pos:sale:read',
      rowCount: 0, masked: false, rows: [], note: 'Missing permission pos:sale:read' },
    { key: 'crm.member', app: 'crm', kind: 'phone', label: 'Member and children', status: 'found', permission: 'pos:member:read',
      rowCount: 1, masked: true, rows: [{ id: SUBJECT, phone: '[redacted]', nickname: '[redacted]', tierCode: 'tourist' }], note: null },
    { key: 'inbox.conversations', app: 'inbox', kind: 'phone', label: 'Inbox conversations', status: 'unavailable',
      permission: 'inbox:conversation:read', rowCount: 0, masked: false, rows: [], note: 'The owning service answered 500.' },
    { key: 'oto_app.records', app: 'oto_app', kind: 'phone', label: 'OTO App records', status: 'not_built', permission: null,
      rowCount: 0, masked: false, rows: [], note: 'The OTO App offers no reader that finds a person by phone.' },
  ],
};

const step = (over: Partial<SupportTrace['steps'][number]>): SupportTrace['steps'][number] => ({
  stage: 'cloud_apply', label: 'Cloud apply', status: 'recorded', at: '2026-10-28T02:59:00.000Z', source: 'pos.sale', recordId: 'r1',
  opsRunId: null, requestId: null, actionId: 'act-1', latencyMs: 120, sincePreviousMs: null, outOfOrder: false, detail: { status: 'finalised' },
  traceUrl: null, note: null, ...over,
});
const trace: SupportTrace = {
  generatedAt: '2026-10-28T03:00:00.000Z',
  anchor: { kind: 'sale', id: SUBJECT, branchId: null, saleId: SUBJECT, walletId: null, receiptNumber: 'ZZT-000001', actionIds: ['act-1'], alsoMatched: 0 },
  steps: [
    step({ stage: 'till_intent', label: 'Till intent', status: 'gap', at: null, source: null, recordId: null, latencyMs: null, detail: {},
      note: 'No till intent was recorded for this action.' }),
    step({ stage: 'device_call', label: 'Device adapter call', source: 'core.ops_run', opsRunId: OTHER, requestId: 'req-1',
      traceUrl: 'https://observability.test/trace?request=req-1', detail: { run: 'device:printer.ok' } }),
    step({ stage: 'outbox', label: 'Outbox event', status: 'gap', at: null, source: null, recordId: null, latencyMs: null, detail: {},
      note: 'No outbox event: the sale was not carried by a box journal.' }),
    step({}),
  ],
  gaps: ['till_intent', 'outbox'],
};

const approval = (over: Partial<ImpersonationApproval> = {}): ImpersonationApproval => ({
  id: WINDOW, state: 'pending', payloadSha256: 'a'.repeat(64), requesterAccountId: ME, requesterName: 'ZZ Admin', approverAccountId: null,
  subjectAccountId: SUBJECT, subjectName: 'ZZ Reception', targetApp: 'pos', reason: 'ZZ fix a member', reference: 'SCRUM-648',
  mine: true, createdAt: '2026-10-28T02:58:00.000Z', requestExpiresAt: '2026-10-28T03:08:00.000Z', ...over,
});
const draft = (over: Partial<StartDraft> = {}): StartDraft => ({
  subjectAccountId: SUBJECT, targetApp: 'pos', mode: 'read_only', reason: '', reference: '', ...over,
});

describe('SCRUM-648 lookup results', () => {
  it('groups sections by app in a fixed order and states denied, unavailable and unbuilt sections instead of hiding them', () => {
    expect(groupByApp(lookup.sections).map(g => g.app)).toEqual(['crm', 'pos', 'inbox', 'oto_app']);
    const out = html(createElement(LookupResults, { answer: lookup }));
    expect(out.indexOf('Members (CRM)')).toBeLessThan(out.indexOf('>POS<'));
    expect(out).toContain('data-section="pos.sales" data-status="denied"');
    expect(out).toContain('Not on your access (pos:sale:read)');
    expect(out).toContain('data-status="unavailable"');
    expect(out).toContain('Could not be read');
    expect(out).toContain('data-status="not_built"');
    expect(out).toContain('No reader yet');
  });

  it('renders masked values as masked, never as the redaction marker or the value', () => {
    const out = html(createElement(LookupResults, { answer: lookup }));
    expect(out).toContain('Personal details are masked');
    expect((out.match(/data-masked="true"/g) ?? []).length).toBe(2);
    expect(out).not.toContain('[redacted]');
    expect(out).toContain('tourist');
  });
});

describe('SCRUM-648 trace', () => {
  it('draws every gap in its place with its reason, and links the external trace only where one exists', () => {
    const out = html(createElement(TraceView, { trace }));
    expect(out).toContain('2 gaps');
    const stages = [...out.matchAll(/data-stage="([a-z_]+)" data-status="([a-z]+)"/g)].map(m => [m[1], m[2]]);
    expect(stages).toEqual([['till_intent', 'gap'], ['device_call', 'recorded'], ['outbox', 'gap'], ['cloud_apply', 'recorded']]);
    expect((out.match(/Gap — no record/g) ?? []).length).toBe(2);
    expect(out).toContain('No till intent was recorded for this action.');
    expect(out).toContain('href="https://observability.test/trace?request=req-1"');
    expect((out.match(/External trace/g) ?? []).length).toBe(1);
  });

  it('opens exactly the Money oversight link shape and nothing else', () => {
    expect(traceFromSearch('?trace=abc&kind=sale')).toEqual({ id: 'abc', kind: 'sale' });
    for (const kind of ['refund', 'payment_attempt', 'receipt', 'wallet'] as const) {
      expect(traceFromSearch(`trace=x1&kind=${kind}`)).toEqual({ id: 'x1', kind });
    }
    expect(traceFromSearch('trace=act-9')).toEqual({ id: 'act-9', kind: 'action' });
    expect(traceFromSearch('trace=x&kind=member')).toBeNull();
    expect(traceFromSearch('kind=sale')).toBeNull();
  });
});

describe('SCRUM-648 impersonation', () => {
  it('renders every refusal the server gives in its own words', () => {
    for (const code of ['IMPERSONATION_SELF', 'IMPERSONATION_SUBJECT_PRIVILEGED', 'IMPERSONATION_NESTED', 'IMPERSONATION_READ_ONLY',
      'SECOND_APPROVAL_REQUIRED', 'IMPERSONATION_REASON_REQUIRED']) {
      const out = html(createElement(RefusalNote, { code, message: 'server words' }));
      expect(out, code).toContain(`data-refusal="${code}"`);
      expect(out, code).toContain(IMPERSONATION_REFUSALS[code]!.replace(/'/g, '&#x27;'));
      expect(out, code).toContain('role="alert"');
    }
    expect(html(createElement(RefusalNote, { code: 'SOMETHING_NEW', message: 'server words' }))).toContain('server words');
  });

  it('opens read-only at once, but a write window needs a reason, a reference and a second administrator', () => {
    expect(startGate(draft(), { dualControl: true, approvals: [] })).toEqual({ kind: 'start', ready: true, missing: [] });
    const bare = startGate(draft({ mode: 'write_allowed' }), { dualControl: true, approvals: [] });
    expect(bare).toMatchObject({ kind: 'request', ready: false });
    expect(bare.missing).toEqual(['A reason', 'A reference (ticket or incident)']);
    const write = draft({ mode: 'write_allowed', reason: 'ZZ fix a member', reference: 'SCRUM-648' });
    expect(startGate(write, { dualControl: true, approvals: [] })).toEqual({ kind: 'request', ready: true, missing: [] });
    expect(startGate(write, { dualControl: true, approvals: [approval()] })).toMatchObject({ kind: 'waiting', ready: false });
    // Somebody else's approval, or one for a different reason, is not this window's.
    expect(startGate(write, { dualControl: true, approvals: [approval({ state: 'approved', mine: false })] }).kind).toBe('request');
    expect(startGate({ ...write, reason: 'other' }, { dualControl: true, approvals: [approval({ state: 'approved' })] }).kind).toBe('request');
    expect(startGate(write, { dualControl: true, approvals: [approval({ state: 'approved', approverAccountId: OTHER })] }))
      .toEqual({ kind: 'start', ready: true, missing: [] });
    expect(startGate(write, { dualControl: false, approvals: [] })).toEqual({ kind: 'start', ready: true, missing: [] });

    const form = (d: StartDraft, approvals: ImpersonationApproval[] = []) => html(createElement(ImpersonationStartForm, {
      draft: d, onDraft: noop, gate: startGate(d, { dualControl: true, approvals }), maxMinutes: 15, dualControl: true, busy: false,
      onStart: noop, onRequest: noop }));
    const readOnly = form(draft());
    expect(readOnly).toContain('data-action="start"');
    expect(readOnly).toContain('Open a read-only window');
    expect(readOnly).not.toContain('needs-approval');
    const asking = form(write);
    expect(asking).toContain('data-testid="needs-approval"');
    expect(asking).toContain('data-action="request"');
    expect(asking).not.toContain('data-action="start"');
    const waiting = form(write, [approval()]);
    expect(waiting).toMatch(/<button[^>]*disabled=""[^>]*data-action="start"|<button[^>]*data-action="start"[^>]*disabled=""/);
    expect(waiting).toContain('approval');
  });

  it('offers Approve only on another administrator’s pending request', () => {
    const out = html(createElement(ApprovalCards, { approvals: [approval(), approval({ id: OTHER, mine: false, requesterAccountId: OTHER })],
      now: NOW, busy: false, onApprove: noop }));
    expect((out.match(/>Approve</g) ?? []).length).toBe(1);
    expect(out).toContain('Waiting · 8:00 left');
  });
});

describe('SCRUM-648 banner and navigation', () => {
  const banner = (impersonation: unknown, impersonating: unknown[]) => html(createElement(ImpersonationBanner, {
    me: { impersonation, impersonating } as never, now: NOW }));
  const win = { id: WINDOW, actor: { accountId: ME, name: 'ZZ Admin' }, subject: { accountId: SUBJECT, name: 'ZZ Reception' },
    targetApp: 'pos' as const, mode: 'read_only' as const, expiresAt: '2026-10-28T03:12:30.000Z' };

  it('names both people for the whole window, with no way to dismiss it', () => {
    expect(banner(null, [])).toBe('');
    const actor = banner(null, [win]);
    expect(actor).toContain('You (ZZ Admin) are viewing POS as ZZ Reception');
    expect(actor).toContain('ends in 12:30');
    const inWindow = banner(win, []);
    expect(inWindow).toContain('ZZ Admin is viewing POS as ZZ Reception');
    for (const out of [actor, inWindow]) {
      expect(out).toContain('data-testid="impersonation-banner"');
      expect(out).not.toMatch(/<button/);
      expect(out).toContain('fixed inset-x-0 top-0');
      expect(out).toContain('h-9');
    }
    expect(banner(null, [win, { ...win, id: SUBJECT }])).toContain('1 more open');
  });

  it('moves the page and the sticky header and rail below the banner, so it covers no header control', () => {
    const tokens = new Set<string>();
    const root = { classList: { toggle: (token: string, on?: boolean) => { if (on) tokens.add(token); else tokens.delete(token); } } };
    markViewAsOffset(root, true);
    expect([...tokens]).toEqual([VIEW_AS_ACTIVE]);
    markViewAsOffset(root, false);
    expect([...tokens]).toEqual([]);
    const css = readFileSync(new URL('../src/index.css', import.meta.url), 'utf8');
    expect(css).toContain('html.view-as-active { --view-as-offset: 2.25rem; }');
    expect(css).toContain('html.view-as-active body { padding-top: var(--view-as-offset); }');
    expect(css).toContain(String.raw`html.view-as-active .h-\[100dvh\] { height: calc(100dvh - var(--view-as-offset)); }`);
    const layout = readFileSync(new URL('../src/components/ConsoleLayout.tsx', import.meta.url), 'utf8');
    // Both sticky regions (the phone header and the rail) stick below the banner, never under it.
    expect(layout.match(/sticky top-\[var\(--view-as-offset,0px\)\]/g)?.length).toBe(2);
    expect(layout).not.toMatch(/sticky top-0/);
  });

  it('renders the banner in the console shell while a window is open', async () => {
    const { ConsoleLayout } = await import('@/components/ConsoleLayout');
    const shell = (impersonating: unknown[]) => {
      session.value = {
        has: () => false, permissions: [], authorityEpoch: 1, operatorChoices: [], operatorLoading: false, operatorSwitching: false,
        operatorError: null, switchOperator: noop, refreshSession: async () => undefined, signOut: noop,
        operatorContext: { effectiveOperatorId: OPERATOR, homeOperatorId: OPERATOR, operatorOverride: null, revision: 0 },
        me: { account: { id: ME, phone: '+66800000000', status: 'active', mustChangePassword: false, operatorId: OPERATOR },
          employee: null, branch: null, isPlatformAdmin: true, sessionLocked: false,
          operatorContext: { effectiveOperatorId: OPERATOR, homeOperatorId: OPERATOR, operatorOverride: null, revision: 0 },
          impersonation: null, impersonating },
      };
      return html(createElement(Router, { ssrPath: '/watch/support', children: createElement(ConsoleLayout, null, createElement('p', null, 'page')) }));
    };
    expect(shell([win])).toContain('data-testid="impersonation-banner"');
    expect(shell([])).not.toContain('data-testid="impersonation-banner"');
  });

  it('puts Support under Watch at /watch/support with the /support alias the trace links use', () => {
    expect(findSection('support')).toMatchObject({ path: '/watch/support', permission: 'console:support:lookup' });
    expect(sectionForPath('/support')).toEqual(findSection('support'));
    const groups = visibleNavigation(permission => permission === 'console:support:lookup', false);
    expect(groups.map(g => g.id)).toEqual(['watch']);
    expect(groups[0]?.sections.map(page => page.id)).toEqual(['support']);
    expect(consoleNav).toHaveLength(10);
  });
});

beforeEach(() => { session.value = null; });
