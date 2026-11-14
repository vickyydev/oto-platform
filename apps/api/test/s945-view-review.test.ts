import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const dir = new URL('../../oto-app/migrations/', import.meta.url);
const read = (name: string) => readFileSync(new URL(name, dir), 'utf8').replace(/\r\n/g, '\n');
const sha = (text: string | Buffer) => createHash('sha256').update(text).digest('hex');
const applied = read('0050_otoapp_v_event_packages_kitchen_plan.sql');
const fixed = read('0051_otoapp_set_audience_provenance.sql');
const journal: { entries: Array<{ idx: number; tag: string; when: number }> } = JSON.parse(read('meta/_journal.json'));
const priorEntries = journal.entries.filter(entry => entry.idx <= 50);
const repair = journal.entries.find(entry => entry.tag === '0051_otoapp_set_audience_provenance');

describe('SCRUM-945 view migration adversarial release contracts', () => {
  it('CRITICAL fixed: applied 0050 is immutable; the repair is forward-only', () => {
    expect(sha(applied)).toBe('f91b889772809a6e74529f0367086e59df1b143e8524c337da94c499bdb2fb9e');
    expect(sha(JSON.stringify(priorEntries))).toBe('dd0d0a66c8c11c03c0318bcad713308df446c5156a61216de9ef46d756043707');
    expect(repair).toMatchObject({ idx: 51, tag: '0051_otoapp_set_audience_provenance' });
    expect(repair!.when).toBeGreaterThan(priorEntries.at(-1)!.when);
  });
  it('HIGH fixed: the SQL-only view snapshot retains every schema object', () => {
    const before = JSON.parse(read('meta/0050_snapshot.json'));
    const after = JSON.parse(read('meta/0051_snapshot.json'));
    expect(after.prevId).toBe(before.id);expect(after.id).not.toBe(before.id);
    delete before.id;delete before.prevId;delete after.id;delete after.prevId;
    expect(after).toEqual(before);
  });
  it('HIGH fixed: the legacy first-thirteen column expressions are untouched', () => {
    const prefix = (sql: string) => sql.slice(sql.indexOf('CREATE OR REPLACE VIEW otoapp_v.event_packages AS'), sql.indexOf('  -- SCRUM-906: the whole kitchen plan'));
    expect(prefix(fixed)).toBe(prefix(applied));
  });
  it('CRITICAL control: the migration cannot rewrite BEO data or drop the granted view', () => {
    const executable = fixed.replace(/^\s*--.*$/gm, '');
    expect(executable.match(/CREATE OR REPLACE VIEW/g)).toHaveLength(1);
    expect(executable).not.toMatch(/\b(?:UPDATE|DELETE|INSERT|DROP|ALTER|TRUNCATE|GRANT|REVOKE)\b/i);
  });
});
