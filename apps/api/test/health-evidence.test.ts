import { describe, expect, it } from 'vitest';
import { evidenceIncomplete, evidenceOf, readEvidence } from '../src/services/health-evidence';

/**
 * SCRUM-645 / Q26 — the read-availability verdicts, without a database.
 * The refusal case against a real role lives in
 * `health-read-availability-review.test.ts`; this pins the classification.
 */
describe('readEvidence (Q26)', () => {
  it('answers the value when the read answers', async () => {
    expect(await readEvidence(async () => [1, 2])).toEqual({ ok: true, value: [1, 2] });
  });

  it('an empty answer is still an answer, not a failure', async () => {
    expect(await readEvidence(async () => [])).toEqual({ ok: true, value: [] });
  });

  it('a privilege refusal (42501), even wrapped as the driver wraps it, is denied', async () => {
    const pgError = Object.assign(new Error('permission denied for table alert'), {
      code: '42501', severity: 'ERROR', routine: 'aclcheck_error',
    });
    const wrapped = Object.assign(new Error('Failed query: select …'), { cause: pgError });
    expect(await readEvidence(() => Promise.reject(wrapped))).toEqual({
      ok: false, availability: 'denied', detail: 'the database refused this read',
    });
  });

  it('any other error is failed, and its message never leaves', async () => {
    const read = await readEvidence(() => Promise.reject(new Error('ZZ TEST secret-bearing message')));
    expect(read).toEqual({ ok: false, availability: 'failed', detail: 'the read failed' });
    expect(JSON.stringify(read)).not.toContain('ZZ TEST');
  });

  it('a read past its deadline is failed, said as a timeout', async () => {
    const read = await readEvidence(() => new Promise<never>(() => undefined), 20);
    expect(read).toEqual({ ok: false, availability: 'failed', detail: 'the read did not answer in time' });
  });

  it('evidence verdicts: only a fully read set is complete', () => {
    const ok = evidenceOf('alerts', { ok: true, value: [] });
    const denied = evidenceOf('jobs', { ok: false, availability: 'denied', detail: 'the database refused this read' });
    expect(ok).toEqual({ source: 'alerts', label: 'The open alerts', availability: 'ok', detail: null });
    expect(evidenceIncomplete([ok])).toBe(false);
    expect(evidenceIncomplete([ok, denied])).toBe(true);
    expect(evidenceIncomplete([])).toBe(false);
  });
});
