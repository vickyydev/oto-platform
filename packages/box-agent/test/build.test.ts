import assert from 'node:assert/strict';
import { test } from 'node:test';

import { BOX_AGENT_BUILD, describeBuild, parseBuildId } from '../src/build';
import { BOX_AGENT_VERSION, BoxHeartbeatRequestSchema, BoxRegisterRequestSchema } from '../src/protocol';

/**
 * The release's build id — `<version>-<YYYYMMDD>-<commit>` — is one string
 * that names the tarball, the release folder on the Pi, the `VERSION` file,
 * `oto-box status` and the heartbeat's `agentVersion`. These pin the parse
 * and the line a person reads, so the packer and the command cannot drift.
 */

test('a build id reads apart into version, date and commit', () => {
  const build = parseBuildId('0.1.0-20261029-b25b644', '2026-10-29T05:38:23.000Z');
  assert.deepEqual(build, {
    id: '0.1.0-20261029-b25b644',
    version: '0.1.0',
    date: '2026-10-29',
    commit: 'b25b644',
    builtAt: '2026-10-29T05:38:23.000Z',
  });
  assert.equal(describeBuild(build), 'oto-box 0.1.0 build 2026-10-29 b25b644 (2026-10-29T05:38:23.000Z)');
});

test('a build from a dirty tree keeps its +local mark on the commit', () => {
  const build = parseBuildId('0.1.0-20261029-b25b644+local');
  assert.equal(build.version, '0.1.0');
  assert.equal(build.date, '2026-10-29');
  assert.equal(build.commit, 'b25b644+local');
  assert.equal(describeBuild(build), 'oto-box 0.1.0 build 2026-10-29 b25b644+local');
});

test('a bare version is not a packed release', () => {
  const build = parseBuildId('0.1.0');
  assert.deepEqual(build, { id: '0.1.0', version: '0.1.0', date: null, commit: null, builtAt: null });
  assert.equal(describeBuild(build), 'oto-box 0.1.0 (run from source, not a packed release)');
  // An old-format id (no date) is not mistaken for one either.
  assert.equal(parseBuildId('0.1.0-b25b644').date, null);
});

test('run from source, this process is the bare version', () => {
  assert.equal(BOX_AGENT_BUILD.version, BOX_AGENT_VERSION);
  assert.equal(BOX_AGENT_BUILD.id, BOX_AGENT_VERSION);
});

test('the longest build id a release can carry fits the wire', () => {
  // `agentVersion` is `z.string().max(32)` on register and heartbeat; a
  // build id from a dirty tree is the longest a release names itself with.
  const id = `${BOX_AGENT_VERSION}-20261029-b25b644+local`;
  assert.ok(id.length <= 32, `${id} is ${id.length} characters`);
  assert.ok(BoxRegisterRequestSchema.safeParse({ claimCode: 'ABCDE-FGHIJ', agentVersion: id }).success);
  assert.ok(
    BoxHeartbeatRequestSchema.safeParse({ reportedAt: new Date().toISOString(), agentVersion: id }).success,
  );
});
