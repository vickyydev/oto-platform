import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { readDenials } from '../src/api/accounts';
import { PhoneInput } from '../src/accounts/PhoneInput';
import { DEFAULT_COUNTRY } from '../src/data/countries';
import { composePhone, parseInternationalPhone, storedPhoneHint } from '../src/lib/phone-utils';
import { staffTokenRowState, staffTokenSettingsWords } from '../src/accounts/staff-token-words';

describe('lifted account source controls', () => {
  it('keeps Thailand and the existing staff country picker without a POS language context', () => {
    expect(DEFAULT_COUNTRY.iso2).toBe('TH');
    const parsed = parseInternationalPhone('0811111111');
    expect(parsed.country.iso2).toBe('TH');
    expect(parsed.nationalNumber).toBe('811111111');
    expect(composePhone(parsed.country, parsed.nationalNumber)).toBe('+66811111111');
    expect(storedPhoneHint('+660811111111')).toBe('+66811111111');
    const html = renderToStaticMarkup(createElement(PhoneInput, { value: '', onChange: () => undefined }));
    expect(html).toContain('Select country code');
    expect(html).toContain('+66');
    expect(html).toContain('type="tel"');
    expect(html).not.toContain('Clear');
  });

  it('never treats an unreadable audit response as a successful empty denial list', () => {
    expect(() => readDenials(null)).toThrow('readable entries');
    expect(() => readDenials({ entries: [{ id: 'bad' }] })).toThrow('unreadable entry');
    expect(readDenials({ entries: [] })).toEqual([]);
    expect(readDenials({ entries: [{
      id: 'entry', createdAt: '2026-10-22T06:00:00Z', actorAccountId: null,
      after: { code: 'DENIED', message: 'Not permitted', method: 'POST', url: '/accounts', extra: 'discarded' },
    }] })[0]).toEqual({ id: 'entry', createdAt: '2026-10-22T06:00:00Z', actorAccountId: null, requestId: null,
      after: { code: 'DENIED', message: 'Not permitted', method: 'POST', url: '/accounts' } });
  });

  it('retains shift-token expiry and ended-token priority without storing any token', () => {
    const now = Date.parse('2026-10-22T06:00:00Z');
    expect(staffTokenRowState({ expiresAt: '2026-10-22T07:00:00Z', revokedAt: null }, now)).toBe('live');
    expect(staffTokenRowState({ expiresAt: '2026-10-22T05:00:00Z', revokedAt: '2026-10-22T04:00:00Z' }, now)).toBe('ended');
    expect(staffTokenRowState({ expiresAt: 'not a timestamp', revokedAt: null }, now)).toBe('expired');
    expect(staffTokenSettingsWords({ available: false, ttlSeconds: null, offlineSignIn: false })).toContain('issues no shift tokens');
  });
});
