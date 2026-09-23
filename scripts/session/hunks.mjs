// Split `git diff -- <file>` into hunks. `node hunks.mjs list <file>` prints each
// hunk's index and its added lines (first 6). `node hunks.mjs pick <file> 1,3 > out.patch`
// writes a patch holding only those hunks, for `git apply --cached`.
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const [mode, file, pick] = process.argv.slice(2);
// Repo root, derived from this file's location (scripts/session/ -> ../../).
const ROOT = fileURLToPath(new URL('../../', import.meta.url)).replace(/[\\/]$/, '');
const diff = execSync(`git diff -U3 -- "${file}"`, { cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 26 });
const lines = diff.split('\n');
const headerEnd = lines.findIndex((l) => l.startsWith('@@'));
const header = lines.slice(0, headerEnd);
const hunks = [];
for (let i = headerEnd; i < lines.length; i += 1) {
  if (lines[i].startsWith('@@')) hunks.push([lines[i]]);
  else if (hunks.length) hunks[hunks.length - 1].push(lines[i]);
}
if (mode === 'list') {
  hunks.forEach((h, i) => {
    console.log(`#${i + 1} ${h[0]}`);
    for (const l of h.filter((l) => l.startsWith('+') || l.startsWith('-')).slice(0, 6)) console.log('    ' + l.slice(0, 110));
  });
} else if (mode === 'pick') {
  const want = new Set(pick.split(',').map((n) => Number(n) - 1));
  const out = [...header];
  hunks.forEach((h, i) => { if (want.has(i)) out.push(...h); });
  // drop a trailing empty element so the patch ends with one newline
  while (out.length && out[out.length - 1] === '') out.pop();
  process.stdout.write(out.join('\n') + '\n');
}
