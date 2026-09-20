import { DatabaseSync } from 'node:sqlite';

import { generateSyncKeyPair, sealEnvelope } from '../src/signing';
import { SqlBoxStore } from '../src/store-sql';
import { prepareSqliteBoxStore, sqliteBoxDriver } from '../src/store-sqlite';
import type { EnvelopeSealer } from '../src/store';

/**
 * A box store in memory, for tests.
 *
 * SQLite, not a hand-written fake: the point of these tests is that the SQL
 * the Pi runs does what the design says, and a fake would only prove the fake.
 * The Postgres dialect of the same statements is exercised from the api's
 * suite, which has a database.
 */
export const BOX_ID = '018f0000-0000-7000-8000-00000000b0c5';
export const STATION_ID = '018f0000-0000-7000-8000-0000000057a1';
export const OPERATOR_ID = '018f0000-0000-7000-8000-0000000000b1';
export const BRANCH_ID = '018f0000-0000-7000-8000-0000000000b2';

export interface TestStore {
  store: SqlBoxStore;
  keys: { privateKeyPem: string; publicKeyPem: string };
  seal: EnvelopeSealer;
  /** Moves the store's clock; every timestamp it writes follows this. */
  setNow(iso: string): void;
  now(): Date;
  close(): void;
}

export function openTestStore(startAt = '2026-09-20T03:00:00.000Z'): TestStore {
  const db = new DatabaseSync(':memory:');
  prepareSqliteBoxStore(db);
  let now = new Date(startAt);
  const store = new SqlBoxStore({ driver: sqliteBoxDriver(db), now: () => now });
  const keys = generateSyncKeyPair();
  return {
    store,
    keys,
    seal: (draft) => sealEnvelope(draft, BOX_ID, keys.privateKeyPem),
    setNow(iso) {
      now = new Date(iso);
    },
    now: () => now,
    close: () => db.close(),
  };
}

export function plus(iso: string, ms: number): string {
  return new Date(Date.parse(iso) + ms).toISOString();
}
