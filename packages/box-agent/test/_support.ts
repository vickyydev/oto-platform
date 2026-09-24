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

/**
 * A seeded source of indices in `[0, maxExclusive)`, for a booth under test.
 *
 * Deterministic, so a failing run replays, and VARYING, as the box's own
 * source (`crypto.randomInt`) is. A constant source such as `() => 0` is not a
 * booth: every code it mints is the same, so a test cannot tell one voucher
 * from the next, and code minting that draws again when a draw will not do —
 * a check character that cannot be printed, say — waits for an answer a
 * constant source never gives, and gives up. mulberry32, as in
 * `spin-distribution.test.ts`: uniform enough that a failure is the booth's,
 * not the generator's.
 */
export function seededIndex(seed: number): (maxExclusive: number) => number {
  let state = seed >>> 0;
  return (maxExclusive) => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return Math.floor((((t ^ (t >>> 14)) >>> 0) / 4294967296) * maxExclusive);
  };
}
