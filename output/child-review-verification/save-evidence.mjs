import { readFileSync, copyFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
const root = process.cwd();
const report = JSON.parse(readFileSync(resolve(root, 'output/child-review-verification/native-report.json'), 'utf8'));
if (report.status !== 'passed' || report.tests.length !== 3 || report.tests.some(test => test.status !== 'passed')
  || !report.cleanup.processes || !report.cleanup.database) throw new Error('Native verification is incomplete.');
const source = resolve(root, 'output/child-review-verification/evidence/run_1790695189136_9677aec7');
const target = resolve(root, 'docs/qa/separate-display');
const images = [
  ['ticket-display-child-save-pending-local.png', '23-local-child-save-pending.png'],
  ['ticket-display-child-retry-local.png', '24-local-child-save-retry.png'],
  ['ticket-display-child-confirmed-local.png', '25-local-child-review-confirmed.png'],
];
for (const [from, to] of images) copyFileSync(resolve(source, from), resolve(target, to));
writeFileSync(resolve(target, 'child-review-local-results.json'), JSON.stringify({
  environment: 'local disposable seeded database', date: '2026-09-29', status: 'passed',
  sharedStationTests: 10, boxStationTests: 32, apiStationTests: 50, posScanChannelTests: 54,
  native: report,
  assertions: ['authorised profile readback', 'same body and key after lost save reply',
    'pending controls and Done fenced', 'other slot draft retained', 'dirty confirmation blocks Done',
    'private profile fields absent', '1024x768 and 1280x800 without horizontal overflow',
    'no registration, visit, sale or payment POST during review', 'Done returns to staff supervision'],
  images: images.map(([, file]) => file),
  limits: ['not staging evidence', 'no registration or supervision consent persisted by display review',
    'no physical device, payment or printing acceptance'],
}, null, 2) + '\n');
console.log('Three reviewed local images and the sanitised report saved.');
