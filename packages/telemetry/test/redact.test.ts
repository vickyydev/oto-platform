import { describe, expect, it } from 'vitest';
import { isSensitiveKey, redact, redactBindings, scrubText } from '../src/index';

/**
 * S2-03 dev evidence. Two halves, and both matter:
 *
 *   - the five fixtures the ticket names, each asserted absent from the
 *     output — a Thai local phone, an E.164 phone, a child record, a pg
 *     unique violation and a terminal response;
 *   - the structural cases, because a redactor that throws or hangs takes the
 *     log line and the request down with it, which is strictly worse than
 *     having no redactor at all.
 */

/** Everything written down as one string, which is what a log line is. */
function written(value: unknown): string {
  return JSON.stringify(redact(value));
}

const THAI_LOCAL = '0811111111';
const E164 = '+66811111111';

describe('the fixtures the ticket names', () => {
  it('drops a Thai local phone, whatever key it arrives under', () => {
    expect(written({ phone: THAI_LOCAL })).not.toContain(THAI_LOCAL);
    expect(written({ contactPhone: THAI_LOCAL })).not.toContain(THAI_LOCAL);
    // The key nobody put on a list — this is what the shape rules are for.
    expect(written({ detail: `looked up ${THAI_LOCAL}` })).not.toContain(THAI_LOCAL);
    expect(written([THAI_LOCAL])).not.toContain(THAI_LOCAL);
  });

  it('drops an E.164 phone in a key, in prose and in a URL', () => {
    expect(written({ phone: E164 })).not.toContain('66811111111');
    expect(written(`no account for ${E164} after 5 tries`)).not.toContain('66811111111');
    expect(written({ note: `/members/lookup?phone=${E164}` })).not.toContain('66811111111');
    // The country code with no plus is still the same number.
    expect(written({ msg: 'ref 66811111111' })).not.toContain('66811111111');
  });

  it('drops a child record entirely — name, birth date, allergies, notes', () => {
    const child = {
      id: '01993f2a-7c11-7000-8000-0000000000aa',
      memberId: '01993f2a-7c11-7000-8000-0000000000ab',
      name: 'Mali Srisai',
      dateOfBirth: '2019-04-02',
      allergies: ['peanut', 'shellfish'],
      medicalNotes: 'Carries an EpiPen in the blue bag.',
      medicalAlert: true,
      notes: 'Shy with new staff.',
      lastConfirmedAt: '2026-09-20T03:00:00.000Z',
    };
    const out = written(child);
    for (const secret of ['Mali', 'Srisai', '2019-04-02', 'peanut', 'shellfish', 'EpiPen', 'Shy']) {
      expect(out).not.toContain(secret);
    }
    // `medicalAlert` goes too, boolean though it is: "this child has a medical
    // condition", written next to the child's id, is health data about a named
    // person however few bits it takes.
    expect(out).not.toContain('"medicalAlert":true');
    // What survives is what makes the line useful — the ids and the times.
    expect(out).toContain('01993f2a-7c11-7000-8000-0000000000aa');
    expect(out).toContain('2026-09-20T03:00:00.000Z');
  });

  it('reduces a pg unique violation to its structural fields', () => {
    const err = Object.assign(
      new Error('duplicate key value violates unique constraint "member_phone_unique"'),
      {
        code: '23505',
        severity: 'ERROR',
        detail: `Key (operator_id, phone)=(01993f2a-7c11-7000-8000-00000000000a, ${E164}) already exists.`,
        hint: `Try ${THAI_LOCAL} instead.`,
        where: `SQL statement "insert into crm.member … ${E164}"`,
        schema: 'crm',
        table: 'member',
        constraint: 'member_phone_unique',
        routine: '_bt_check_unique',
        parameters: [E164],
      },
    );
    const out = redact(err) as Record<string, unknown>;
    expect(out).toMatchObject({ pgCode: '23505', constraint: 'member_phone_unique', table: 'member' });
    for (const dropped of ['detail', 'hint', 'where', 'parameters']) {
      expect(out).not.toHaveProperty(dropped);
    }
    expect(JSON.stringify(out)).not.toContain('66811111111');
    // Nested under a binding, as an error handler would pass it.
    expect(written({ err, reqId: 'abc' })).not.toContain('66811111111');
  });

  it('drops a card and an approval code from a terminal response', () => {
    const terminalResponse = {
      terminalId: 'TID-0001',
      outcome: 'approved',
      approvalCode: '482913',
      authCode: '482913',
      rrn: '626300123456',
      amountSatang: 45000,
      // The two shapes a PAN reaches a log in: named, and buried in raw text.
      pan: '4111111111111111',
      raw: ';4111111111111111=25121010000012300000?',
      printLine: 'CARD 4111 1111 1111 1111',
      cardholderName: 'SOMCHAI PRASERT',
    };
    const out = written(terminalResponse);
    for (const secret of ['4111111111111111', '4111 1111 1111 1111', '482913', 'SOMCHAI']) {
      expect(out).not.toContain(secret);
    }
    // The fields reconciliation needs are still there.
    expect(out).toContain('TID-0001');
    expect(out).toContain('approved');
    expect(out).toContain('45000');
  });
});

describe('keys the park cannot afford to lose', () => {
  it('keeps a phone hash, an op name and a qualified name', () => {
    const out = redact({
      phoneHash: 'ph_9f1c2b3d4e5a',
      op: 'member.create',
      branchName: 'HKT Central',
      jobName: 'job:watchdog',
      stationName: 'Till 1',
    }) as Record<string, unknown>;
    expect(out.phoneHash).toBe('ph_9f1c2b3d4e5a');
    expect(out.op).toBe('member.create');
    expect(out.branchName).toBe('HKT Central');
    expect(out.jobName).toBe('job:watchdog');
    expect(out.stationName).toBe('Till 1');
  });

  it('keeps an error code but not a verification code under the same key', () => {
    expect(redact({ code: 'MEMBER_PHONE_EXISTS' })).toEqual({ code: 'MEMBER_PHONE_EXISTS' });
    expect(redact({ code: 'ECONNREFUSED' })).toEqual({ code: 'ECONNREFUSED' });
    expect(redact({ code: '482913' })).toEqual({ code: '[redacted]' });
    expect(redact({ code: 404 })).toEqual({ code: 404 });
    expect(isSensitiveKey('code', '482913')).toBe(true);
    expect(isSensitiveKey('code', 'MEMBER_PHONE_EXISTS')).toBe(false);
  });

  it('leaves ids, dates, money and statuses alone', () => {
    const line = {
      requestId: 'req-0199abcd',
      accountId: '01993f2a-7c11-7000-8000-0000000000ac',
      branchId: '01993f2a-7c11-7000-8000-0000000000ad',
      statusCode: 200,
      ms: 34,
      businessDate: '2026-09-20',
      totalSatang: 129900,
      occurredAt: new Date('2026-09-20T03:00:00.000Z'),
    };
    expect(redact(line)).toEqual({ ...line, occurredAt: '2026-09-20T03:00:00.000Z' });
  });

  it('scrubs a key that is itself a value', () => {
    expect(written({ [E164]: { visits: 3 } })).not.toContain('66811111111');
  });
});

describe('structure: it must not throw and must not hang', () => {
  it('bounds a very deep object', () => {
    type Nest = { level: number; next?: Nest; phone?: string };
    const deep: Nest = { level: 0 };
    let tip = deep;
    for (let i = 1; i < 500; i += 1) {
      tip.next = { level: i };
      tip = tip.next;
    }
    tip.phone = E164;
    const out = written(deep);
    expect(out).toContain('[truncated: depth]');
    // Safe by default: what is past the limit is replaced, never passed on.
    expect(out).not.toContain('66811111111');
  });

  it('survives a cycle and reports it once', () => {
    const a: Record<string, unknown> = { id: 'a' };
    const b: Record<string, unknown> = { id: 'b', a };
    a.b = b;
    a.self = a;
    const out = redact(a) as Record<string, unknown>;
    expect(JSON.stringify(out)).toContain('[circular]');
    expect(out.id).toBe('a');
  });

  it('does not call a shared branch a cycle', () => {
    const shared = { id: 'shared' };
    const out = redact({ first: shared, second: shared }) as Record<string, string>;
    expect(JSON.stringify(out)).not.toContain('[circular]');
  });

  it('bounds a very wide object and a very long array', () => {
    const wide: Record<string, unknown> = {};
    for (let i = 0; i < 5000; i += 1) wide[`k${i}`] = i;
    const wideOut = redact(wide) as Record<string, unknown>;
    expect(Object.keys(wideOut).length).toBeLessThanOrEqual(65);
    expect(JSON.stringify(wideOut)).toContain('keys');

    const long = Array.from({ length: 5000 }, () => THAI_LOCAL);
    const longOut = redact(long) as unknown[];
    expect(longOut.length).toBeLessThanOrEqual(65);
    expect(JSON.stringify(longOut)).not.toContain(THAI_LOCAL);
  });

  it('bounds a shared subtree that would otherwise expand exponentially', () => {
    // Cheap to build, ruinous to walk: every key at every level points at the
    // same child, so there is no cycle to detect and 30^6 paths to take. The
    // node budget is the only thing standing between this and a hung request.
    let level: Record<string, unknown> = { leaf: THAI_LOCAL };
    for (let d = 0; d < 6; d += 1) {
      const child = level;
      level = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`k${i}`, child]));
    }
    const started = Date.now();
    const out = written(level);
    expect(Date.now() - started).toBeLessThan(2000);
    expect(out).toContain('[truncated: size]');
    expect(out).not.toContain(THAI_LOCAL);
  });

  it('cuts a very long string before sweeping it', () => {
    const huge = `${'x'.repeat(500_000)} ${E164}`;
    const { blob } = redact({ blob: huge }) as { blob: string };
    expect(blob.length).toBeLessThan(2100);
    expect(blob).toContain('[truncated');
    expect(blob).not.toContain('66811111111');
  });

  it('walks an error and its cause chain', () => {
    const root = new Error(`cannot reach the terminal for ${E164}`);
    const middle = new Error('payment failed', { cause: root });
    const top = Object.assign(new Error('sale could not be recorded', { cause: middle }), {
      code: 'PAYMENT_FAILED',
      statusCode: 502,
    });
    const out = redact(top) as Record<string, unknown>;
    expect(out.type).toBe('Error');
    expect(out.code).toBe('PAYMENT_FAILED');
    expect(out.statusCode).toBe(502);
    expect(out.message).toBe('sale could not be recorded');
    expect(JSON.stringify(out)).toContain('payment failed');
    expect(JSON.stringify(out)).not.toContain('66811111111');
    expect(out).toHaveProperty('stack');
  });

  it('survives a cyclic cause chain', () => {
    const a = new Error('a');
    const b = new Error('b', { cause: a });
    (a as Error & { cause?: unknown }).cause = b;
    expect(() => redact(a)).not.toThrow();
    expect(JSON.stringify(redact(a))).toContain('[circular]');
  });

  it('survives a getter that throws, a proxy and an object with no prototype', () => {
    const hostile = {
      ok: 1,
      get boom(): string {
        throw new Error('nope');
      },
    };
    expect(redact(hostile)).toMatchObject({ ok: 1, boom: '[unreadable]' });

    const revoked = Proxy.revocable({ a: 1 }, {});
    revoked.revoke();
    expect(() => redact({ p: revoked.proxy })).not.toThrow();

    const bare = Object.create(null) as Record<string, unknown>;
    bare.phone = E164;
    bare.id = 'x';
    expect(written(bare)).not.toContain('66811111111');
  });

  it('summarises the types a log serialiser would otherwise mangle', () => {
    const out = redact({
      map: new Map([['phone', E164]]),
      set: new Set(['peanut']),
      buf: new Uint8Array([1, 2, 3, 4]),
      fn: () => undefined,
      big: 10n,
      sym: Symbol('s'),
      re: /^\d+$/,
      bad: new Date('nonsense'),
    }) as Record<string, unknown>;
    expect(out.map).toBe('[Map 1]');
    expect(out.set).toBe('[Set 1]');
    expect(out.buf).toBe('[binary 4 bytes]');
    expect(out.fn).toBe('[function]');
    expect(out.big).toBe('10n');
    expect(out.sym).toBe('Symbol(s)');
    expect(out.re).toBe('/^\\d+$/');
    expect(out.bad).toBe('[invalid date]');
    expect(JSON.stringify(out)).not.toContain('66811111111');
  });

  it('handles primitives, null and undefined at the top', () => {
    expect(redact(null)).toBeNull();
    expect(redact(undefined)).toBeUndefined();
    expect(redact(7)).toBe(7);
    expect(redact(false)).toBe(false);
    expect(redact(THAI_LOCAL)).toBe('[redacted:phone]');
    expect(redactBindings('hello')).toEqual({ value: 'hello' });
  });
});

describe('scrubText, on a message a caller already formatted', () => {
  it('replaces the value and keeps the sentence', () => {
    expect(scrubText('sent a code to +66811111111 at 03:00')).toBe(
      'sent a code to [redacted:phone] at 03:00',
    );
    expect(scrubText('mail to mali@example.co.th bounced')).toBe(
      'mail to [redacted:email] bounced',
    );
  });

  it('leaves an id, a timestamp and a money amount intact', () => {
    expect(scrubText('req 01993f2a-7c11-7000-8000-0000000000aa at 1758337200000 for 129900')).toBe(
      'req 01993f2a-7c11-7000-8000-0000000000aa at 1758337200000 for 129900',
    );
  });
});
