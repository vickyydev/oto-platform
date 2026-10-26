import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
const root = 'C:/w/admin-operator-switch';
const hash = value => createHash('sha256').update(value).digest('hex');
const git = args => execFileSync('git', args, { cwd: root, windowsHide: true, maxBuffer: 8_000_000 });
const base = '544cd736598640a240faf6c2584c344de1f811ec';
const beforeHead = '7ef1b5effa2b5b39935e17f699cda7fe3040e03c';
const head = git(['rev-parse', 'HEAD']).toString().trim();
assert.equal(git(['status', '--porcelain']).toString(), '');
assert.equal(git(['branch', '--show-current']).toString().trim(), 'lane/admin-operator-switch');
const commits = git(['log', '--reverse', '--format=%H%x09%s', base + '..HEAD']).toString().trim().split('\n')
  .map(line => { const [sha, subject] = line.split('\t'); return { sha, subject }; });
const old = git(['log', '--reverse', '--format=%H%x09%s', '0aff040be10fb1622bfcddfeb0343ff8846f541e..' + beforeHead])
  .toString().trim().split('\n').map(line => { const [sha, subject] = line.split('\t'); return { sha, subject }; });
assert.equal(commits.length, 7);
assert.deepEqual(commits.map(row => row.subject), old.map(row => row.subject));
const expected = ['apps/console/src/components/booth/PrizeEditor.tsx', 'apps/console/src/lib/readState.ts',
  'apps/console/test/prize-editor-validation.test.ts'].sort();
const delta = git(['diff', '--name-only', '-z', beforeHead, head, '--', 'apps', 'packages',
  'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'package.json', 'turbo.json', '.github'])
  .toString().split('\0').filter(Boolean).sort();
assert.deepEqual(delta, expected);
const mainFiles = expected.map(name => {
  const current = fs.readFileSync(root + '/' + name), canonical = git(['show', base + ':' + name]);
  assert.equal(hash(current), hash(canonical));
  return { path: name, sha256: hash(current), exactMainBytes: true };
});
const frames = ['admin640-q22-broad-green-v1', 'admin640-final-scoped-v6'].map(name => {
  const inputs = JSON.parse(fs.readFileSync('C:/w/' + name + '.inputs.json'));
  assert.deepEqual(inputs.before, inputs.after);
  let count = 0;
  for (const [file, digest] of Object.entries(inputs.after)) {
    assert.equal(hash(fs.readFileSync(root + '/' + file)), digest); count++;
  }
  return { attempt: name, inputCount: count, sourceManifestSha256: hash(JSON.stringify(inputs.after)),
    inputsUnchangedAcrossRebase: true };
});
const result = { ticket: 'SCRUM-640', checkedAt: new Date().toISOString(), beforeHead, head, base,
  preservedCommits: commits.map((row, index) => ({ before: old[index].sha, after: row.sha, subject: row.subject })),
  skippedCommits: 0, conflict: 'Only STATUS; latest Q22 then planner661 then historical blocks retained.',
  exactSourceDelta: mainFiles, frames, sourceEditsDuringRebase: false,
  release: false, deployed: false, remaining: 'Complete combined release still requires planner ask pinning and the 638 landing.' };
fs.writeFileSync('C:/w/admin640-post-rebase-bridge-20261026.json', JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
process.stdout.write(JSON.stringify({ head, ownCommits: commits.length, skipped: 0, exactMainConsoleDelta: 3,
  frames, release: false }) + '\n');
