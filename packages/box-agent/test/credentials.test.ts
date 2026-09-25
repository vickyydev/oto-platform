import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { fileCredentialStore } from '../src/credentials';

/**
 * SCRUM-418 (closing audit L23) — the credential file is written whole or not
 * at all.
 *
 * It was written in place: a power cut between the truncate and the last byte
 * left a file that parses as nothing, and the box came back asking for a claim
 * code it had already spent. It now goes the way every other file in the box's
 * home goes — a temporary beside the target, flushed, renamed over it — so what
 * is on the card is the old credential or the new one.
 */

function home(): string {
  return mkdtempSync(join(tmpdir(), 'oto-box-credential-'));
}

test('the credential lands owner-only, in a folder made on the way, with nothing left beside it', async () => {
  const dir = join(home(), 'nested');
  const path = join(dir, 'credential.json');
  const store = fileCredentialStore(path);
  assert.equal(await store.read(), null, 'nothing yet');

  await store.write({ boxId: 'box-1', secret: 'first-secret', syncPrivateKeyPem: 'PEM-1' });
  assert.deepEqual(await store.read(), {
    boxId: 'box-1',
    secret: 'first-secret',
    syncPrivateKeyPem: 'PEM-1',
  });
  assert.deepEqual(readdirSync(dir), ['credential.json'], 'the temporary file is gone');
  if (process.platform !== 'win32') {
    assert.equal(statSync(path).mode & 0o777, 0o600);
  }

  // A second write replaces the first whole, and still leaves one file.
  await store.write({ boxId: 'box-2', secret: 'second-secret' });
  assert.deepEqual(await store.read(), { boxId: 'box-2', secret: 'second-secret' });
  assert.deepEqual(readdirSync(dir), ['credential.json']);

  // Read back field by field: a key somebody added by hand is not the box's.
  writeFileSync(path, JSON.stringify({ boxId: 'box-3', secret: 'typed', role: 'admin' }));
  assert.deepEqual(await store.read(), { boxId: 'box-3', secret: 'typed' });

  await store.clear();
  assert.equal(await store.read(), null);
  assert.equal(readFileSync(path, 'utf8'), '', 'cleared, not deleted: the file stays the box’s');
});

test('a write that cannot replace the target leaves it as it was and no temporary behind', async () => {
  const dir = home();
  const path = join(dir, 'credential.json');
  // A directory where the file should be: the rename cannot land, on any platform.
  mkdirSync(path);
  const store = fileCredentialStore(path);
  await assert.rejects(() => store.write({ boxId: 'box-1', secret: 'secret' }));
  assert.ok(statSync(path).isDirectory(), 'the target was not touched');
  assert.deepEqual(readdirSync(dir), ['credential.json'], 'the temporary was cleaned up');
  assert.equal(existsSync(join(dir, 'credential.json.tmp')), false);
});
