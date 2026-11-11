import * as React from 'react';
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { formatStoredPhone, storedPhoneHint, composePhone } from '@/lib/phoneUtils';
import { DEFAULT_COUNTRY } from '@/data/countries';
import { PublicConsentCapture } from '@/components/till/PublicConsentCapture';
import { StepAwaitCustomer } from '@/components/till/StepAwaitCustomer';
import { StepIdentify } from '@/components/till/StepIdentify';
import type { ConsentPrompt } from '@oto/shared';
import { renderHook } from './support/hooks';

vi.mock('react', async (original) => ({ ...(await original<typeof import('react')>()), ...(await import('./support/hooks')) }));
vi.mock('@/i18n/LanguageContext', () => ({ useLanguage: () => ({ lang: 'en', t: (key: string) => key }) }));
beforeEach(() => vi.stubGlobal('React', React));

type Element = React.ReactElement<Record<string, unknown>>;
const elements = (node: unknown): Element[] => Array.isArray(node) ? node.flatMap(elements) :
  React.isValidElement<Record<string, unknown>>(node) ? [node, ...elements(node.props.children)] : [];
const words = (node: unknown): string => typeof node === 'string' || typeof node === 'number' ? String(node) :
  Array.isArray(node) ? node.map(words).join('') : React.isValidElement<Record<string, unknown>>(node) ? words(node.props.children) : '';

describe('SCRUM-783 display-only phone correction', () => {
  const local = '0898020001'; // ZZ TEST number used only by this fixture.
  const raw = '+660898020001';
  it('staff mirrors format the entered number while keeping the empty phone placeholder', () => {
    for (const render of [
      (phone: string) => StepAwaitCustomer({ phone, nickname: 'ZZ TEST guardian', onBack: vi.fn() }),
      (phone: string) => StepIdentify({ phone, nickname: 'ZZ TEST guardian', member: null }),
    ]) {
      expect(words(render(raw))).toContain('+66 89 802 0001');
      expect(words(render(raw))).not.toContain(raw);
      expect(words(render(''))).toContain('—');
    }
  });

  it('uses the stored normalization and international grouping without changing input composition', () => {
    expect(composePhone(DEFAULT_COUNTRY, local)).toBe(raw);
    expect(storedPhoneHint(raw)).toBe('+66898020001');
    for (const input of [raw, local, '+66898020001']) expect(formatStoredPhone(input)).toBe('+66 89 802 0001');
    expect(formatStoredPhone('')).toBe('');
    expect(formatStoredPhone('unfinished')).toBe('unfinished');
  });

  it('the New member offer uses this formatter on the raw number', () => {
    const till = readFileSync(new URL('../src/pages/Till.tsx', import.meta.url), 'utf8');
    expect(till).toContain('{formatStoredPhone(customerPhone)}</span>. Create one');
    expect(till).not.toContain('{customerPhone.trim()}</span>. Create one');
  });

  // SCRUM-863 — this is the form from a till that sends no channel with it (an
  // older till): the number stays fixed there. A form with the channel asks for
  // the number again; that one is in s863-dropoff-number-display.test.ts.
  it('the paired display agreement shows the same formatted number and does not rewrite it', () => {
    const prompt: ConsentPrompt = { kind: 'consent', requestId: 'zz-test-request', visitorId: 'zz-test-visitor',
      slots: [{ id: 'zz-test-child', name: 'ZZ TEST child', ageYears: 6, requirement: 'drop_off' }],
      guardianName: 'ZZ TEST guardian', guardianPhone: raw, consentRequired: true,
      consentAcknowledged: false, confirmations: [], staffReady: false, canContinue: false, completed: false };
    const action = vi.fn();
    const view = renderHook(() => PublicConsentCapture({ prompt, busy: false, onAction: action }));
    for (let step = 0; step < 2; step++) {
      const next = elements(view.result.current).find(node => words(node.props.children) === 'common.continue' && typeof node.props.onClick === 'function')!;
      (next.props.onClick as () => void)();
    }
    const kept = elements(view.result.current).find(node => node.props['data-testid'] === 'consent-kept-phone');
    expect(words(kept)).toContain('+66 89 802 0001');
    expect(words(kept)).not.toContain(raw);
    expect(prompt.guardianPhone).toBe(raw);
    expect(action).not.toHaveBeenCalled();
    view.unmount();
  });
});
