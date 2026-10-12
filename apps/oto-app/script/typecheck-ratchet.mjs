/** Read the complete compiler output and hold every inherited file/code ceiling. */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const APP_DIR = resolve(SCRIPT_DIR, '..');

export function parseDiagnostics(output) {
  const counts = {};
  let errors = 0;
  for (const line of output.replace(/\r/g, '').split('\n')) {
    const match = line.match(/^(.+)\(\d+,\d+\): error (TS\d+): /);
    if (match) {
      const file = match[1].replace(/\\/g, '/');
      if (file.startsWith('/') || /^[A-Za-z]:/.test(file) || file.includes('../')) {
        throw new Error('Compiler returned a diagnostic outside the app-relative file list.');
      }
      const key = `${file}|${match[2]}`;
      counts[key] = (counts[key] ?? 0) + 1;
      errors += 1;
    } else if (/error TS\d+:/.test(line)) {
      throw new Error(
        'Compiler returned an unclassified diagnostic; inspect the complete output above.',
      );
    }
  }
  return { errors, counts };
}

export function compareDiagnostics(actual, baseline) {
  const entries = Object.entries(baseline.counts ?? {});
  if (
    baseline.version !== 1 ||
    !Number.isInteger(baseline.errors) ||
    baseline.errors < 0 ||
    entries.some(([, count]) => !Number.isInteger(count) || count < 1) ||
    entries.reduce((sum, [, count]) => sum + count, 0) !== baseline.errors
  ) {
    throw new Error('Typecheck baseline is inconsistent; no ceiling was accepted.');
  }
  const increased = Object.entries(actual.counts)
    .filter(([key, count]) => count > (baseline.counts[key] ?? 0))
    .map(([key, count]) => ({ key, before: baseline.counts[key] ?? 0, after: count }));
  const reduced = entries
    .filter(([key, count]) => (actual.counts[key] ?? 0) < count)
    .map(([key, count]) => ({ key, before: count, after: actual.counts[key] ?? 0 }));
  return { ok: actual.errors <= baseline.errors && increased.length === 0, increased, reduced };
}

export function runTypecheck() {
  const compiler = join(APP_DIR, 'node_modules', 'typescript', 'bin', 'tsc');
  const result = spawnSync(
    process.execPath,
    [compiler, '--project', 'tsconfig.json', '--pretty', 'false', '--incremental', 'false'],
    { cwd: APP_DIR, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 },
  );
  // Whole output, including multiline diagnostic details, is always available in CI.
  process.stdout.write(result.stdout ?? '');
  process.stderr.write(result.stderr ?? '');
  if (result.error || result.signal || ![0, 2].includes(result.status)) {
    throw new Error('TypeScript did not finish normally; the ratchet did not pass.');
  }
  const actual = parseDiagnostics(result.stdout ?? '');
  if ((result.status === 0) !== (actual.errors === 0)) {
    throw new Error('Compiler exit and diagnostic count disagree; the ratchet did not pass.');
  }
  const baseline = JSON.parse(readFileSync(join(SCRIPT_DIR, 'typecheck-baseline.json'), 'utf8'));
  const comparison = compareDiagnostics(actual, baseline);
  console.log(
    `typecheck: ${actual.errors}/${baseline.errors} errors in ${new Set(Object.keys(actual.counts).map((key) => key.split('|')[0])).size} files`,
  );
  for (const row of comparison.increased)
    console.error(`typecheck: increased ${row.key}: ${row.before} -> ${row.after}`);
  for (const row of comparison.reduced)
    console.log(
      `typecheck: reduced ${row.key}: ${row.before} -> ${row.after}; tighten the committed ceiling`,
    );
  if (!comparison.ok) throw new Error("The OTO App's diagnostic ceiling increased.");
  return { ...actual, ...comparison };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    runTypecheck();
  } catch (error) {
    console.error(`typecheck: ${error.message}`);
    process.exitCode = 1;
  }
}
