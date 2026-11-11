// SCRUM-819: preserve the original receipt and explain a concurrent API rollout.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const root = resolve(import.meta.dirname, '../../../../..');
const { service, render } = await import(pathToFileURL('C:/Users/waqar/OneDrive/Desktop/Projects/oto-pos/scripts/agent/render.mjs'));
const receipt = JSON.parse(readFileSync(resolve(import.meta.dirname, 'receipt.json')));
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
assert.equal(receipt.sha, 'bfd04cd2fc9387a61c13eb822978ba40bd0a7cb0');
assert.equal(receipt.checks.firstSighting.pairedAt, receipt.checks.firstSighting.lastSeenAt);
assert.ok(receipt.checks.onlineWindow.elapsedMs >= 600000);
assert.equal(receipt.checks.onlineWindow.alerts, 0);
assert.ok(receipt.checks.realSilence.alertId);
assert.equal(receipt.checks.repeatedSweepSameAlert, true);
assert.equal(receipt.cleanupFailures?.length ?? 0, 0);
assert.ok(receipt.cleanup.some(x => x.kind === 'display' && x.revoked));
assert.ok(receipt.cleanup.some(x => x.kind === 'station' && x.archived && x.devices === 0));
assert.ok(receipt.cleanup.some(x => x.kind === 'alert' && x.closed));
assert.ok(receipt.cleanup.some(x => x.kind === 'admin-session' && x.me === 401));
const live = {};
for (const name of ['oto-api-staging', 'oto-console-staging', 'oto-pos-web-staging']) {
  const s = await service(name);
  const d = (await render('GET', `/services/${s.id}/deploys?limit=10`)).map(x => x.deploy).find(x => x.status === 'live');
  assert.ok(d);
  live[name] = { id: d.id, sha: d.commit.id, status: d.status };
}
const actual = live['oto-api-staging'].sha;
git('merge-base', '--is-ancestor', receipt.sha, actual);
const changed = git('diff', '--name-only', receipt.sha, actual, '--',
  'apps/api/src', 'apps/api/package.json', 'packages/db/src', 'packages/db/migrations',
  'packages/shared/src', 'packages/box-agent/src', 'packages/telemetry/src', 'pnpm-lock.yaml', 'render.yaml')
  .split('\n').filter(Boolean);
// Explicitly reviewed SCRUM-820 changes. Any other runtime change needs review.
const reviewed = new Set([
  'apps/api/src/routes/inbox-actions.ts', 'apps/api/src/services/inbox/book-date.ts',
  'apps/api/src/services/otoapp-events.ts', 'packages/shared/src/inbox-actions.ts', 'packages/shared/src/inbox.ts',
  // SCRUM-825: the added public-address fallback is used only for deposit links.
  'apps/api/src/env.ts', 'apps/api/src/services/party-deposit.ts',
]);
assert.ok(changed.every(path => reviewed.has(path)), 'Unreviewed runtime change during the observation');
const unchanged = ['apps/api/src/services/display.ts', 'apps/api/src/services/screen-presence.ts',
  'apps/api/src/services/jobs.ts', 'apps/api/src/services/ops.ts', 'apps/api/src/services/alert-routing.ts',
  'apps/api/src/services/device-credential.ts', 'apps/api/src/routes/display.ts', 'apps/api/src/routes/ops.ts',
  'packages/shared/src/screen-presence.ts'];
const blobs = unchanged.map(path => {
  const before = git('rev-parse', `${receipt.sha}:${path}`), after = git('rev-parse', `${actual}:${path}`);
  assert.equal(after, before);
  return { path, before, after };
});
const clients = [];
for (const [name, path] of [['oto-console-staging', 'apps/console'], ['oto-pos-web-staging', 'apps/pos']]) {
  const before = receipt.deployments[name].sha, after = live[name].sha;
  const beforeTree = git('rev-parse', `${before}:${path}`), afterTree = git('rev-parse', `${after}:${path}`);
  assert.equal(afterTree, beforeTree);
  assert.equal(git('diff', '--name-only', before, after, '--', 'pnpm-lock.yaml', 'packages/shared/src/screen-presence.ts'), '');
  clients.push({ service: name, before, after, sourceTree: afterTree, sourceUnchanged: true });
}
writeFileSync(resolve(import.meta.dirname, 'runtime-comparison.json'), JSON.stringify({
  checkedAt: new Date().toISOString(), source: receipt.sha, live, changedRuntimeFiles: changed,
  unchangedDisplayAndAlertBlobs: blobs, clients, checksPassed: true, cleanupPassed: true,
  originalReceiptPassed: receipt.passed, originalFailure: receipt.failure,
  limit: 'The API changed during the observation. The recorded display, presence, watchdog and alert code is identical; other API behavior is not claimed identical.',
}, null, 2) + '\n');
console.log('Display/alert code comparison and completed cleanup verified; original receipt unchanged.');
