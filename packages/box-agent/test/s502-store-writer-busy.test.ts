import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import { sqliteWriterBusy } from '../src/store-sqlite';

/**
 * SCRUM-502 — what a Pi's store says when a write met another writer, read
 * from SQLite's own errors rather than from a hand-made one: only that is
 * waited out by a prepaid press, never a damaged file or a broken statement.
 */

function errorOf(run: () => void): unknown {
  try {
    run();
  } catch (err) {
    return err;
  }
  assert.fail('expected SQLite to refuse');
}

test('SCRUM-502 — a second transaction on the box’s one connection is the store being busy', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('begin immediate');
    const err = errorOf(() => db.exec('begin immediate'));
    assert.equal(sqliteWriterBusy(err), true, String(err));
    db.exec('rollback');
  } finally {
    db.close();
  }
});

test('SCRUM-502 — a statement SQLite cannot run, a damaged file and a non-SQLite error are not', () => {
  const db = new DatabaseSync(':memory:');
  try {
    assert.equal(sqliteWriterBusy(errorOf(() => db.exec('select * from no_such_table'))), false);
  } finally {
    db.close();
  }
  const damaged = Object.assign(new Error('database disk image is malformed'), { code: 'ERR_SQLITE_ERROR', errcode: 11 });
  assert.equal(sqliteWriterBusy(damaged), false);
  assert.equal(sqliteWriterBusy(new Error('cannot start a transaction within a transaction')), false);
  assert.equal(sqliteWriterBusy(null), false);
  const locked = Object.assign(new Error('database is locked'), { code: 'ERR_SQLITE_ERROR', errcode: 5 });
  assert.equal(sqliteWriterBusy(locked), true);
});
