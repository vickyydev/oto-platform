import { describe, expect, it } from 'vitest';
import { isPgError, scrubPgError, scrubUrl, uniqueViolationInfo } from '../src/index';
import { phoneHash } from '../src/node';

/**
 * The S2-01a behaviours, asserted here so the move out of
 * `apps/api/src/lib/scrub.ts` cannot quietly change one of them.
 */

const pgUniqueViolation = Object.assign(
  new Error('duplicate key value violates unique constraint "member_phone_unique"'),
  {
    code: '23505',
    severity: 'ERROR',
    detail: 'Key (operator_id, phone)=(0199-…, +66811111111) already exists.',
    hint: 'Try +66811111111 instead.',
    where: 'SQL statement "insert into crm.member … +66811111111"',
    schema: 'crm',
    table: 'member',
    constraint: 'member_phone_unique',
    routine: '_bt_check_unique',
    parameters: ['+66811111111'],
  },
);

describe('scrubUrl', () => {
  it('keeps the path and drops the query string', () => {
    expect(scrubUrl('/members/lookup?phone=%2B66811111111')).toBe('/members/lookup?[redacted]');
    expect(scrubUrl('/members/lookup')).toBe('/members/lookup');
    expect(scrubUrl('/auth/sign-in?')).toBe('/auth/sign-in?[redacted]');
  });
});

describe('phoneHash', () => {
  it('is stable, non-reversible and free of the number', () => {
    const hashed = phoneHash('+66811111111');
    expect(hashed).toBe(phoneHash('+66811111111'));
    expect(hashed).not.toContain('66811111111');
    expect(hashed).toMatch(/^ph_[0-9a-f]{12}$/);
    expect(phoneHash('+66811111112')).not.toBe(hashed);
  });
});

describe('scrubPgError', () => {
  it('recognises a pg error and keeps only the structural fields', () => {
    expect(isPgError(pgUniqueViolation)).toBe(true);
    expect(isPgError(new Error('plain'))).toBe(false);
    expect(isPgError(null)).toBe(false);

    const scrubbed = scrubPgError(pgUniqueViolation);
    expect(scrubbed).toMatchObject({
      pgCode: '23505',
      constraint: 'member_phone_unique',
      table: 'member',
    });
    expect(JSON.stringify(scrubbed)).not.toContain('66811111111');
    for (const dropped of ['detail', 'hint', 'where', 'parameters']) {
      expect(scrubbed).not.toHaveProperty(dropped);
    }
  });
});

describe('uniqueViolationInfo', () => {
  it('maps a known constraint to its business code and names nothing else', () => {
    const info = uniqueViolationInfo(pgUniqueViolation);
    expect(info?.statusCode).toBe(409);
    expect(info?.code).toBe('MEMBER_PHONE_EXISTS');
    expect(info?.details).toEqual({ constraint: 'member_phone_unique' });
    expect(JSON.stringify(info)).not.toContain('66811111111');
  });

  it('falls back to DUPLICATE for a constraint nobody has named yet', () => {
    const info = uniqueViolationInfo(
      Object.assign(new Error('dupe'), {
        code: '23505',
        severity: 'ERROR',
        constraint: 'some_future_unique',
      }),
    );
    expect(info?.code).toBe('DUPLICATE');
  });

  it('ignores anything that is not a 23505', () => {
    expect(uniqueViolationInfo(new Error('not a pg error'))).toBeNull();
    expect(
      uniqueViolationInfo(Object.assign(new Error('fk'), { code: '23503', severity: 'ERROR' })),
    ).toBeNull();
  });
});
