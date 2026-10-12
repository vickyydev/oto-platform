import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { compareDiagnostics, parseDiagnostics } from '../../oto-app/script/typecheck-ratchet.mjs';
import {
  compareCounts,
  databaseUrl,
  quoteIdentifier,
  runCommand,
} from '../../oto-app/script/restore-rehearsal-lib.mjs';

/**
 * S2-17b round 8 (SCRUM-191): restore and compiler checks under attack.
 * Passing pins exercise count loss, a replay, another file's diagnostics and
 * a connection outside the generated database family. The real dump/restore
 * runs in the app CI job with all committed migrations and the sample seed.
 * Findings below name severity and the prescribed fix before their pins flip.
 */
const appDir = fileURLToPath(new URL('../../oto-app/', import.meta.url));
const source = (name: string) => readFileSync(`${appDir}script/${name}`, 'utf8');
const baseline = { version: 1, errors: 2, counts: { 'server/a.ts|TS2322': 2 } };

describe('S2-17b round 8 — restore and compiler review', () => {
  it('counts every diagnostic in complete multiline compiler output', () => {
    expect(
      parseDiagnostics(
        'server/a.ts(1,2): error TS2322: Type does not match.\r\n  Details.\r\nserver/a.ts(9,3): error TS2322: Another type.\n',
      ),
    ).toEqual({ errors: 2, counts: baseline.counts });
    expect(compareDiagnostics({ errors: 2, counts: baseline.counts }, baseline).ok).toBe(true);
  });

  it('FINDING 1 (high, fixed): a moved diagnostic cannot borrow another file’s allowance; prescribed fix: compare each file/code ceiling before accepting the total', () => {
    expect(
      compareDiagnostics(
        { errors: 2, counts: { 'server/a.ts|TS2322': 1, 'server/b.ts|TS2322': 1 } },
        baseline,
      ).ok,
    ).toBe(false);
  });

  it('FINDING 2 (high, fixed): a count reduction cannot mask a new diagnostic code; prescribed fix: refuse every new file/code key even below the inherited total', () => {
    expect(
      compareDiagnostics({ errors: 1, counts: { 'server/a.ts|TS9999': 1 } }, baseline).ok,
    ).toBe(false);
  });

  it('a reduction is reported without rewriting the baseline', () => {
    const copy = structuredClone(baseline);
    const result = compareDiagnostics({ errors: 1, counts: { 'server/a.ts|TS2322': 1 } }, baseline);
    expect(result).toEqual({
      ok: true,
      increased: [],
      reduced: [{ key: 'server/a.ts|TS2322', before: 2, after: 1 }],
    });
    expect(baseline).toEqual(copy);
  });

  it('compiler boot errors and a malformed baseline never pass as zero diagnostics', () => {
    expect(() => parseDiagnostics('error TS6053: File was not found.')).toThrow('unclassified');
    expect(() => parseDiagnostics('/other/park/a.ts(1,2): error TS2322: Outside.')).toThrow(
      'outside',
    );
    expect(() => compareDiagnostics({ errors: 0, counts: {} }, { ...baseline, errors: 3 })).toThrow(
      'inconsistent',
    );
  });

  it('each original table count must survive, including an empty table and a missing table', () => {
    const before = { employees: '37', templates: '0' };
    expect(compareCounts(before, { ...before, event_registrations: '0' })).toEqual([]);
    expect(compareCounts(before, { employees: '36', templates: '0' })).toEqual([
      { table: 'employees', before: '37', after: '36' },
    ]);
    expect(compareCounts(before, { employees: '37' })).toEqual([
      { table: 'templates', before: '0', after: null },
    ]);
    expect(compareCounts(before, before)).toEqual([]);
  });

  it('a scratch destination never keeps the caller’s database name', () => {
    const result = new URL(
      databaseUrl('postgresql://localhost/park_other', 'oto_rehearsal_a123_0'),
    );
    expect(result.pathname).toBe('/oto_rehearsal_a123_0');
    expect(() => databaseUrl('postgresql://localhost/park_other', 'park_other')).toThrow('outside');
    expect(() => databaseUrl('https://localhost/park_other', 'oto_rehearsal_a123_0')).toThrow(
      'PostgreSQL',
    );
    expect(quoteIdentifier('a"; drop schema core;--')).toBe('"a""; drop schema core;--"');
  });

  it('FINDING 3 (high, fixed): failed child output stays private; prescribed fix: pipe both output streams explicitly and publish only the named step', () => {
    const module = new URL('../../oto-app/script/restore-rehearsal-lib.mjs', import.meta.url).href;
    const code = `import {runCommand} from ${JSON.stringify(module)}; try { runCommand(process.execPath, ['-e', 'process.stderr.write("ZZ TEST private child output");process.exit(1)'], process.env, 'sample seed'); } catch(e) { console.log(e.message); }`;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', code], {
      encoding: 'utf8',
    });
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toContain('stopped at sample seed');
    expect(result.stdout).not.toContain('ZZ TEST private child output');
    expect(
      runCommand(
        process.execPath,
        ['-e', 'process.stdout.write("counts only")'],
        process.env,
        'safe step',
      ),
    ).toBe('counts only');
  });

  it('replays use the real migrator twice and baseline bookkeeping precedes both', () => {
    const code = source('restore-rehearsal.mjs');
    expect(code).toContain('await markBaseline(urls[2], journal)');
    expect(code).toContain('run <= 2');
    expect(code).toContain('applyApp(urls[2])');
    expect(code).toContain('JSON.stringify(runs[0].migrations)');
    expect(code).toContain(
      'REHEARSAL_DATABASE_URL is required; DATABASE_URL is never used as a fallback.',
    );
    expect(code).toContain('for (const name of created.reverse())');
    expect(code).toContain('ALTER SCHEMA public RENAME TO otoapp');
  });
});
