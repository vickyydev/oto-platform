import { describe, expect, it } from 'vitest';
import { errorView, retryAfterSeconds, supportReference } from '../src/lib/errorView';

const fields = { '/rates/0/name': { label: 'Rate name', id: 'rate-name-0' }, '/categoryRules/0/serviceChargePercent': { label: 'F&B service charge', id: 'tax-svc-fnb' } };
const validation = (path: string, issue: unknown) => ({ instancePath: path, params: { issue }, message: 'private-canary-detail' });

describe('safe structural public error projection', () => {
  for (const [code, reason] of [
    ['BOOTH_NOT_ON_THIS_BOX', 'This booth is not running on this service.'],
    ['STORAGE_NOT_CONFIGURED', 'File storage is not configured.'],
    ['EVENTS_SEAM_NOT_GRANTED', 'Event data cannot be read because the service is missing required access.'],
    ['EMPLOYEES_SEAM_NOT_GRANTED', 'Employee data cannot be read because the service is missing required access.'],
  ]) for (const operation of ['read', 'write'] as const) it(`keeps native503 ${code} as a definite ${operation} refusal`, () => {
    const view = errorView({ status: 503, code, message: 'ZZ TEST private-canary internal detail', requestId: 'zz-test-ref-682' }, { operation });
    expect(view.message).toContain(reason);
    expect(view.message).not.toContain('private-canary');
    expect(view.supportReference).toBe('zz-test-ref-682');
    expect(view.uncertain).toBe(false);
    expect(view.requiresFreshRead).toBe(false);
  });
  it('names native storage failure without claiming that an interrupted write did not happen', () => {
    const read = errorView({ status: 503, code: 'STORAGE_UNAVAILABLE', message: 'private-canary' });
    expect(read.message).toContain('File storage is unavailable.');
    expect(read.uncertain).toBe(false);
    const write = errorView({ status: 503, code: 'STORAGE_UNAVAILABLE', message: 'private-canary' }, { operation: 'write' });
    expect(write.message).toContain('File storage is unavailable.');
    expect(write.message).toContain('may have been saved');
    expect(write.uncertain).toBe(true);
    expect(write.requiresFreshRead).toBe(true);
    expect(write.message).not.toContain('private-canary');
  });
  it('does not trust another service code or a known refusal code at an unexpected status', () => {
    for (const [status, code] of [[503, 'UNRECOGNISED_SERVICE_CODE'], [500, 'STORAGE_NOT_CONFIGURED'], [502, 'BOOTH_NOT_ON_THIS_BOX']] as const) {
      const view = errorView({ status, code, message: 'ZZ TEST private-canary detail' }, { operation: 'write' });
      expect(view.uncertain).toBe(true);
      expect(view.requiresFreshRead).toBe(true);
      expect(view.message).toContain('may have been saved');
      expect(view.message).not.toContain('private-canary');
    }
  });
  for (const [code, reason, uncertainWrite] of [
    ['DISPLAY_PAIRING_BUSY', 'Screen pairing is busy.', true],
    ['KIOSK_PAIRING_BUSY', 'Kiosk pairing is busy.', true],
    ['OTO_APP_NOT_CONFIGURED', 'The OTO App connection is not configured.', false],
    ['OTO_APP_UNAVAILABLE', 'The OTO App is unavailable.', true],
  ] as const) for (const operation of ['read', 'write'] as const) it(`keeps fixed503 ${code} guidance for a ${operation}`, () => {
    const view = errorView({ status: 503, code, message: 'private-canary', requestId: 'zz-test-ref-682' }, { operation });
    expect(view.message).toContain(reason);
    expect(view.message).not.toContain('private-canary');
    expect(view.supportReference).toBe('zz-test-ref-682');
    expect(view.uncertain).toBe(operation === 'write' && uncertainWrite);
    expect(view.requiresFreshRead).toBe(operation === 'write' && uncertainWrite);
  });
  for (const operation of ['read', 'write'] as const) {
    it(`preserves the native password403 refusal for a ${operation}`, () => {
      const view = errorView({ status: 403, code: 'MUST_CHANGE_PASSWORD', message: 'Password change required before continuing' }, { operation });
      expect(view.message).toContain('Password change required before continuing');
      expect(view.uncertain).toBe(false);
      expect(view.message).not.toContain('service had a problem');
      expect(view.message).not.toContain('may have been saved');
    });
    for (const status of [400, 403]) it(`does not turn a diagnostic-looking answered${status} into an uncertain ${operation}`, () => {
      const view = errorView({ status, code: 'REFUSED', message: 'SQL SELECT private-canary FROM provider_secret' }, { operation });
      expect(view.uncertain).toBe(false);
      expect(view.message).not.toContain('service had a problem');
      expect(view.message).not.toContain('may have been saved');
      expect(view.message).not.toContain('private-canary');
    });
  }
  it('projects only known fields and constraints, without submitted values or free-form issue text', () => {
    const view = errorView({ status: 400, code: 'VALIDATION', message: 'Request does not match the schema', details: [
      validation('/rates/0/name', { code: 'too_small', origin: 'string', minimum: 1, message: 'private-canary', received: 'private-canary' }),
      validation('/categoryRules/0/serviceChargePercent', { code: 'too_big', origin: 'number', maximum: 100, inclusive: true }),
      validation('/password/private-canary', { code: 'invalid_type', expected: 'string' }),
    ] }, { operation: 'write', fields });
    expect(view.fieldIssues).toEqual([{ path: '/rates/0/name', ...fields['/rates/0/name'], message: 'Enter at least 1 character.' },
      { path: '/categoryRules/0/serviceChargePercent', ...fields['/categoryRules/0/serviceChargePercent'], message: 'Use 100 or less.' }]);
    expect(JSON.stringify(view)).not.toContain('private-canary');
  });
  it('does not invent field guidance for an unknown issue or path', () => {
    const view = errorView({ status: 400, code: 'VALIDATION', details: [validation('/rates/0/name', { code: 'custom', message: 'private-canary' }),
      validation('/private-canary', { code: 'too_small', minimum: 1 })] }, { fields });
    expect(view.fieldIssues).toEqual([]);
    expect(view.message).toContain('Check the entered values');
    expect(JSON.stringify(view)).not.toContain('private-canary');
  });
  it('preserves inclusive and exclusive numeric bounds accurately', () => {
    for (const [code, value, inclusive, text] of [['too_small', 0, true, 'Use 0 or more.'], ['too_small', 0, false, 'Use more than 0.'],
      ['too_big', 100, true, 'Use 100 or less.'], ['too_big', 100, false, 'Use less than 100.']] as const) {
      const view = errorView({ status: 400, details: [validation('/categoryRules/0/serviceChargePercent', { code, [code === 'too_small' ? 'minimum' : 'maximum']: value, inclusive })] }, { fields });
      expect(view.fieldIssues[0]?.message).toBe(text);
    }
  });
  it('ignores malformed details and unsafe numeric or type metadata', () => {
    for (const details of [null, 'private-canary', { password: 'private-canary' }, [validation('/rates/0/name', { code: 'too_small', minimum: 'private-canary' })],
      [validation('/rates/0/name', { code: 'invalid_type', expected: 'private-canary' })]]) {
      const view = errorView({ status: 400, code: 'VALIDATION', details }, { fields });
      expect(view.fieldIssues).toEqual([]);
      expect(JSON.stringify(view)).not.toContain('private-canary');
    }
  });
  it('never exposes an unexpected server message, stack, SQL or arbitrary details', () => {
    const view = errorView({ status: 500, code: 'INTERNAL', message: 'SQL SELECT private-canary FROM provider_secret', details: { secret: 'private-canary' }, requestId: 'zz-test-ref-682' });
    expect(view.message).toContain('Try reading it again');
    expect(view.supportReference).toBe('zz-test-ref-682');
    expect(JSON.stringify(view)).not.toContain('private-canary');
    expect(JSON.stringify(view)).not.toContain('SELECT');
  });
  it('keeps a named record refusal distinct from an absent route', () => {
    expect(errorView({ status: 404, code: 'BOOTH_NOT_FOUND', message: 'No booth with that id' }).message).toContain('No booth with that id');
    expect(errorView({ status: 404, code: 'BOOTH_NOT_FOUND', message: 'No booth with that id' }).message).not.toContain('deployment');
    expect(errorView({ status: 404, code: 'ROUTE_NOT_FOUND' }).message).toContain('deployment');
  });
  it('requires a fresh read after conflict and keeps its safe native reason', () => {
    const view = errorView({ status: 409, code: 'CONFLICT', message: 'Another change was recorded.' }, { operation: 'write' });
    expect(view.requiresFreshRead).toBe(true);
    expect(view.uncertain).toBe(false);
    expect(view.message).toContain('Another change was recorded.');
  });
  it('never declares an uncertain write not saved or safe to repeat', () => {
    for (const error of [new TypeError('Failed to fetch'), { status: 500, message: 'private-canary' }]) {
      const view = errorView(error, { operation: 'write' });
      expect(view.uncertain).toBe(true);
      expect(view.requiresFreshRead).toBe(true);
      expect(view.message).toContain('may have been saved');
      expect(view.message).not.toContain('not saved');
    }
  });
  it('uses actual rate-limit seconds without substituting zero for an invalid header', () => {
    expect(errorView({ status: 429, retryAfterSeconds: 3 }).message).toContain('Wait 3 seconds');
    expect(errorView({ status: 429, retryAfterSeconds: -1 }).retryAfterSeconds).toBeUndefined();
    expect(errorView({ status: 429, retryAfterSeconds: 'private-canary' }).message).not.toContain('private-canary');
  });
  it('validates correlation references without alternate or private values', () => {
    expect(supportReference('zz-test-ref-682')).toBe('zz-test-ref-682');
    for (const value of [undefined, null, 1, '', 'short', 'private/canary', 'with space', 'x'.repeat(65)]) expect(supportReference(value)).toBeUndefined();
    expect(errorView({ requestId: 'invalid/private-canary', sessionId: 'private-canary' }).supportReference).toBeUndefined();
  });
  it('accepts only safe integer retry seconds', () => {
    expect(retryAfterSeconds('0')).toBe(0);
    expect(retryAfterSeconds('12')).toBe(12);
    for (const value of [null, undefined, '', '1.5', '-1', 'private-canary', Infinity, NaN, -1, 1.5]) expect(retryAfterSeconds(value)).toBeUndefined();
  });
  it('keeps safe existing domain-specific messages while removing diagnostic strings', () => {
    expect(errorView('No booth with that id').message).toBe('No booth with that id');
    expect(errorView('SQL SELECT private-canary FROM provider_secret').message).not.toContain('private-canary');
    expect(errorView('Request does not match the schema').message).toContain('Check the entered values');
  });
});
