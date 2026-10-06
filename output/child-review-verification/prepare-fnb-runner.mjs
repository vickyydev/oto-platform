import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
const from = resolve('output/child-review-verification');
const target = resolve('output/fnb-display-verification');
if (existsSync(resolve(target, 'pos-run.mjs'))) throw new Error('F&B runner already exists; do not overwrite it.');
mkdirSync(target, { recursive: true });
for (const name of ['pos-run.mjs', 'pos-native.config.mts', 'safe-output.mjs', 'safe-reporter.mjs']) {
  let text = readFileSync(resolve(from, name), 'utf8');
  if (name === 'pos-run.mjs') text = text.replaceAll('oto_child_review_', 'oto_fnb_display_')
    .replaceAll('child-review-pos', 'fnb-display-pos')
    .replace('record.tests.length !== 3', 'record.tests.length !== 4')
    .replace('exactly three passing existing POS cases', 'exactly four passing existing POS cases')
    .replace('Three existing POS cases passed.', 'Four existing POS cases passed.');
  writeFileSync(resolve(target, name), text);
}
console.log('F&B runner prepared with unique explicit artifact directories.');
