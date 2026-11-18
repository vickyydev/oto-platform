import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * SCRUM-1010 — THE GUARD. The park's day runs midnight to midnight, and the
 * hour lives in one place: each park's `business_day_start`, read through
 * `businessDate()`. No source file may hold 05:00 as a day start of its own —
 * as a literal next to a day-start name, or as a `5 * 60` given to one — so a
 * later change cannot quietly bring the retired 05:00 day back. Test files and
 * fixtures are data and are not scanned.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const SOURCE_ROOTS = ['apps', 'packages'];
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'test', 'tests', 'e2e', 'fixtures', '__tests__', 'oto-app', 'coverage', '.turbo']);
const SOURCE = /\.(ts|tsx|mts|cts|js|mjs)$/;
const TEST_FILE = /\.(test|spec)\.[a-z]+$/;

function* sourceFiles(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      if (!SKIP_DIRS.has(name) && !name.startsWith('.')) yield* sourceFiles(path);
    } else if (SOURCE.test(name) && !TEST_FILE.test(name)) {
      yield path;
    }
  }
}

const DAY_START_NAME = /business_?day_?start|dayStart|DAY_START/i;
const FIVE_LITERAL = /['"`]05:00(:00)?['"`]/;
const FIVE_MINUTES = /(?:DAY_START|[dD]ayStart)\w*\s*(?::\s*number\s*)?=\s*5\s*\*\s*60\b/;

describe('SCRUM-1010 — no source holds 05:00 as a day start', () => {
  it('finds no 05:00 day-start literal or 5 * 60 day start in apps/*/src and packages/*/src', () => {
    const offenders: string[] = [];
    let scanned = 0;
    for (const top of SOURCE_ROOTS) {
      for (const pkg of readdirSync(join(ROOT, top))) {
        if (SKIP_DIRS.has(pkg)) continue;
        for (const sub of ['src', 'server']) {
          const dir = join(ROOT, top, pkg, sub);
          let isDir = false;
          try {
            isDir = statSync(dir).isDirectory();
          } catch {
            isDir = false;
          }
          if (!isDir) continue;
          for (const file of sourceFiles(dir)) {
            scanned += 1;
            const text = readFileSync(file, 'utf8');
            text.split('\n').forEach((line, index) => {
              const code = line.replace(/\/\/.*$/, '');
              if ((FIVE_LITERAL.test(code) && DAY_START_NAME.test(text)) || FIVE_MINUTES.test(code)) {
                offenders.push(`${relative(ROOT, file)}:${index + 1}: ${line.trim()}`);
              }
            });
          }
        }
      }
    }
    expect(scanned, 'the scan reached the source tree').toBeGreaterThan(200);
    expect(offenders).toEqual([]);
  });
});
