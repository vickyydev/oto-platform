import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { CredentialExpiryList, IntegrationTests } from '@/api/observability';
import { CredentialExpiryCard, IntegrationTestsCard } from '@/components/integrations/IntegrationControls';
import { expiryWords, integrationReadNote, unreadEvidenceProblems } from '@/lib/readAvailability';

/**
 * SCRUM-645 / planner ruling Q26 — what the Console says about a read that did
 * not answer, the owner's credential expiry dates and the fake test seams.
 */
const credentials = (over: Partial<CredentialExpiryList> = {}): CredentialExpiryList => ({
  visible: true,
  canManage: true,
  availability: 'ok',
  detail: null,
  credentials: [
    { integration: 'meta_channel_token', name: 'Meta channel tokens', purpose: 'Inbox tokens.', expiresOn: '2026-11-17', daysLeft: 20, window: '30_days', setAt: '2026-10-28T00:00:00.000Z' },
    { integration: 'pgw_maintenance_key', name: '2C2P maintenance keys', purpose: 'Refunds.', expiresOn: null, daysLeft: null, window: 'not_set', setAt: null },
    { integration: 'otoapp_directory_key', name: 'OTO App Directory API key', purpose: 'Staff copy.', expiresOn: '2026-10-26', daysLeft: -2, window: 'expired', setAt: null },
  ],
  ...over,
});

const tests = (over: Partial<IntegrationTests> = {}): IntegrationTests => ({
  available: true,
  adapter: 'fake',
  availability: 'ok',
  tests: [
    { integration: 'gateway', label: 'Payment gateway: mint and cancel a token', description: 'Mints and cancels.', lastRunAt: null, lastOutcome: null, lastOkAt: null, lastFailedAt: null },
    { integration: 'sms', label: 'SMS: send a test message to me', description: 'One message.', lastRunAt: '2026-10-27T10:00:00.000Z', lastOutcome: 'failed', lastOkAt: null, lastFailedAt: '2026-10-27T10:00:00.000Z' },
  ],
  ...over,
});

const noop = () => undefined;

describe('read availability words (Q26)', () => {
  it('names each unread evidence read, and says nothing for a fully read set', () => {
    expect(unreadEvidenceProblems([{ label: 'The open alerts', availability: 'ok' }])).toEqual([]);
    expect(unreadEvidenceProblems(undefined)).toEqual([]);
    expect(unreadEvidenceProblems([
      { label: 'The open alerts', availability: 'denied' },
      { label: 'The job register', availability: 'failed' },
    ])).toEqual([
      'The open alerts could not be read (refused), so nothing below can be called healthy.',
      'The job register could not be read (failed), so nothing below can be called healthy.',
    ]);
  });

  it('an Integrations row that was not read says so, and a read one says nothing', () => {
    expect(integrationReadNote('ok')).toBeNull();
    expect(integrationReadNote(undefined)).toBeNull();
    expect(integrationReadNote('denied')).toContain('not a confirmation that it works');
  });

  it('expiry words', () => {
    expect(expiryWords('not_set', null, null)).toBe('No expiry date recorded');
    expect(expiryWords('expired', -2, '2026-10-26')).toBe('Expired on 2026-10-26');
    expect(expiryWords('7_days', 0, '2026-10-28')).toBe('Expires today (2026-10-28)');
    expect(expiryWords('30_days', 20, '2026-11-17')).toBe('Expires on 2026-11-17, in 20 days');
  });
});

describe('credential expiry card (Q26)', () => {
  it('shows each date and, for a permitted caller, the date control', () => {
    const html = renderToStaticMarkup(createElement(CredentialExpiryCard, { data: credentials(), error: null, busyKey: null, onSave: noop }));
    expect(html).toContain('Credential expiry');
    expect(html).toContain('Expires on 2026-11-17, in 20 days');
    expect(html).toContain('No expiry date recorded');
    expect(html).toContain('Expired on 2026-10-26');
    expect(html).toContain('never asks a provider');
    expect(html).toContain('Save date');
    expect(html).toContain('Clear date');
  });

  it('offers no control to a caller who may only read', () => {
    const html = renderToStaticMarkup(createElement(CredentialExpiryCard, { data: credentials({ canManage: false }), error: null, busyKey: null, onSave: noop }));
    expect(html).toContain('Expires on 2026-11-17, in 20 days');
    expect(html).not.toContain('Save date');
    expect(html).not.toContain('type="date"');
  });

  it('a refused read is not "no dates recorded"', () => {
    const html = renderToStaticMarkup(createElement(CredentialExpiryCard, {
      data: credentials({ availability: 'denied', detail: 'the database refused this read', credentials: [] }), error: null, busyKey: null, onSave: noop,
    }));
    expect(html).not.toContain('No expiry date recorded');
    expect(html).toContain('refused');
  });

  it('renders nothing for a park reader, who is answered with visible false', () => {
    expect(renderToStaticMarkup(createElement(CredentialExpiryCard, {
      data: credentials({ visible: false, credentials: [] }), error: null, busyKey: null, onSave: noop,
    }))).toBe('');
  });
});

describe('integration tests card (Q26)', () => {
  it('says every adapter is a fake, and offers Run only where the api says the caller may', () => {
    const html = renderToStaticMarkup(createElement(IntegrationTestsCard, { data: tests(), error: null, running: null, results: {}, onRun: noop }));
    expect(html).toContain('no real provider is called');
    expect(html).toContain('fake adapter');
    expect(html).toContain('Run test');
    expect(html).toContain('never run here');
    const refused = renderToStaticMarkup(createElement(IntegrationTestsCard, { data: tests({ available: false }), error: null, running: null, results: {}, onRun: noop }));
    expect(refused).not.toContain('Run test');
    expect(refused).toContain('console:integration:test');
  });

  it('shows a pressed result with its steps', () => {
    const html = renderToStaticMarkup(createElement(IntegrationTestsCard, {
      data: tests(), error: null, running: null, onRun: noop,
      results: { gateway: { integration: 'gateway', runId: '01964000-0000-7000-8000-000000000001', outcome: 'ok', adapter: 'fake',
        steps: [{ step: 'mint', outcome: 'ok' }, { step: 'cancel', outcome: 'ok' }], message: 'No real provider was called.' } },
    }));
    expect(html).toContain('Passed');
    expect(html).toContain('mint ok, cancel ok');
  });
});
