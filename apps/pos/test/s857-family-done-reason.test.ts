import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ApiError, NetworkError } from '@/api/client';
import {
  GATE_CONNECTION_DROPPED,
  GATE_NOTHING_TAKEN,
  gateFailureCause,
  gateFailureDescription,
} from '@/lib/gateOnline';

/**
 * SCRUM-857 with SCRUM-887 — WHY THE FAMILY'S DONE COULD NOT BE SAVED.
 *
 * When the family's Done runs the gate and the write fails, the till keeps
 * the reason for the staff line under the form ("The family pressed Done, but
 * it could not be saved: …") while the toast says the same thing with its
 * tail. Since SCRUM-887 the toast gives its own words for a gate that started
 * online: a connection that dropped and did not come back, or a counter box
 * that has not pulled the family yet (never "Member not found"). The staff
 * line now gives those same words, not the raw error. (The box's own case is
 * driven through the fake box in s887-gate-online-retry.)
 */
describe('the reason the staff line gives for a Done that was not saved', () => {
  it('is the toast’s own cause, without the “nobody has been charged” tail', () => {
    const cases: [unknown, boolean][] = [
      [new NetworkError(), true],
      [new NetworkError(), false],
      [new ApiError(409, 'CONSENT_REQUIRED', 'Consent first.'), true],
      [new ApiError(404, 'NOT_FOUND', 'Member not found'), false],
      [new Error('Add the parent’s name.'), true],
      ['odd', false],
    ];
    for (const [err, startedOnline] of cases) {
      expect(gateFailureDescription(err, startedOnline)).toBe(`${gateFailureCause(err, startedOnline)} ${GATE_NOTHING_TAKEN}`);
      expect(gateFailureCause(err, startedOnline)).not.toContain(GATE_NOTHING_TAKEN);
    }
  });

  it('says the connection dropped for a gate that started online, and keeps every other error’s own words', () => {
    expect(gateFailureCause(new NetworkError(), true)).toBe(GATE_CONNECTION_DROPPED);
    expect(gateFailureCause(new NetworkError(), false)).toBe(new NetworkError().message);
    expect(gateFailureCause(new ApiError(409, 'CONSENT_REQUIRED', 'Consent first.'), true)).toBe('Consent first.');
    expect(gateFailureCause('odd', true)).toBe('Unknown error');
  });

  it('is what both of the gate’s failures hand the family’s Done, and the staff line quotes it', () => {
    const till = readFileSync(resolve(import.meta.dirname, '../src/pages/Till.tsx'), 'utf8');
    const gate = till.slice(till.indexOf('const resolveSupervisionGate'), till.indexOf('const runSupervisionGate'));
    expect(gate.match(/\} catch \(err\) \{\s*if \(!ownSale\(\)\) return \{ ok: false, message: SALE_MOVED_ON \};\s*toast\(\{[\s\S]*?description: gateFailureDescription\(err, gateOnline\.startedOnline\),[\s\S]*?\}\);\s*return \{ ok: false, message: gateFailureCause\(err, gateOnline\.startedOnline\) \};/g)).toHaveLength(2);
    expect(gate).not.toMatch(/message: err instanceof Error \? err\.message/);
    expect(till).toMatch(/The family pressed Done, but it could not be saved: \$\{consentNotSaved\}/);
  });
});
