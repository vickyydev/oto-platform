import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { copyFile, mkdir, open, rename, rm, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { TERMINAL_REF_COUNTER_SCOPE } from '@oto/shared';
import { JOURNAL_EPOCH_KEY, STORE_RESTORED_KEY, awaitingEpochNote } from '../agent';
import { fileCredentialStore } from '../credentials';
import {
  RECEIPT_RESTORE_MARGIN,
  RECEIPT_SEQ_SCOPE,
  RECEIPT_SERIES,
  RECEIPT_SERIES_DAY,
  observedKey,
  receiptCounterKey,
} from '../sale-queue';
import { prepareSqliteBoxStore, type SqliteDatabaseLike } from '../store-sqlite';
import { TERMINAL_REF_MAX_SEQ } from '../terminal/counter';
import { runnerPaths } from './home';
import { holdStoreLock } from './store-lock';

export { RECEIPT_RESTORE_MARGIN };
/**
 * The same as `RECEIPT_RESTORE_MARGIN`, for a card terminal's reference, which must not repeat within a trading
 * day (`terminal/counter.ts`) and has only four digits: one tender every thirty
 * seconds for a twelve-hour day (1,440), rounded up. It starts again tomorrow.
 */
export const TERMINAL_REF_RESTORE_MARGIN = 2_000;

export type RestoreRefusalCode =
  | 'source_unreadable'
  | 'source_damaged'
  | 'not_a_mirror'
  | 'same_file'
  | 'claim_under_way'
  | 'other_box'
  | 'epoch_passed';

/** A restore that did not happen, in the words of why. Nothing has been moved. */
export class RestoreRefusal extends Error {
  constructor(
    readonly code: RestoreRefusalCode,
    message: string,
  ) {
    super(message);
    this.name = 'RestoreRefusal';
  }
}

export interface RestoreOptions {
  /** A copy of another box, into a home that names a different one. Said out loud. */
  allowOtherBox?: boolean;
  /** Go ahead although the platform has moved past the copy's journal. */
  acceptRefused?: boolean;
  now?: () => Date;
}

export interface RestoreResult {
  unsent: number;
  replaced: string[];
  /** The boxes whose journals the copy holds; the first is the one it came from. */
  boxIds: string[];
  /** When the copy's store last changed, as far as the copy can say. */
  copyAt: string | null;
  /** How far every receipt series moved on, and how many series it was. */
  receiptMargin: number;
  receiptSeries: number;
  /** Print jobs in the copy that will not print again by themselves. */
  printJobsHeld: number;
}

/** Also refuse an older installed service which does not hold our kernel lock. */
async function serviceStopped(): Promise<void> {
  if (process.platform !== 'linux') return;
  try {
    const { stdout } = await promisify(execFile)('systemctl', [
      'show',
      'oto-box.service',
      '--property=ActiveState',
      '--value',
    ]);
    if (!['inactive', 'failed', ''].includes(stdout.trim()))
      throw new Error('Stop the oto-box service before restoring.');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    // A development machine may have systemctl installed without systemd.
    if (
      String((error as { stderr?: string }).stderr).includes(
        'System has not been booted with systemd',
      )
    )
      return;
    throw error;
  }
}

async function openSqlite(file: string, readOnly: boolean): Promise<SqliteDatabaseLike> {
  const { DatabaseSync } = await import('node:sqlite');
  return new DatabaseSync(file, { readOnly }) as unknown as SqliteDatabaseLike;
}

function selected<T>(db: SqliteDatabaseLike, sql: string, ...params: unknown[]): T[] {
  return db.prepare(sql).all(...params) as T[];
}

const hasTable = (db: SqliteDatabaseLike, name: string): boolean =>
  selected(db, 'select 1 from sqlite_master where type = ? and name = ?', 'table', name).length > 0;

/** Who a store's journals belong to, and how far along they are. Most recently used first. */
function journalsOf(db: SqliteDatabaseLike): Array<{ box_id: string; journal_epoch: number }> {
  if (!hasTable(db, 'box_state')) return [];
  return selected(db, 'select box_id, journal_epoch from box_state order by updated_at desc');
}

/** What the home already says it is. A replaced drive says nothing. */
async function homeIdentity(
  paths: ReturnType<typeof runnerPaths>,
): Promise<{ credential: string | null; journals: Array<{ box_id: string; journal_epoch: number }> }> {
  const credential = (await fileCredentialStore(paths.credential)
    .read()
    .catch(() => null))?.boxId ?? null;
  const found = await stat(paths.database).catch(() => null);
  if (!found) return { credential, journals: [] };
  let db: SqliteDatabaseLike | null = null;
  try {
    db = await openSqlite(paths.database, true);
    return { credential, journals: journalsOf(db) };
  } catch {
    // A store that cannot be read names nobody, and is what is being replaced.
    return { credential, journals: [] };
  } finally {
    try {
      db?.close();
    } catch {
      /* nothing opened */
    }
  }
}

/**
 * Move every receipt series on by the margin, from the highest number the copy
 * knows of, the same reckoning `mintReceipt` makes. Series the store has only been
 * told about get a counter too: their next sale would otherwise start at the mark,
 * and the sale a guest holds may be the first one after it.
 */
function moveReceiptsOn(db: SqliteDatabaseLike, boxId: string, at: string): number {
  const read = (key: string): number =>
    Number(
      selected<{ v: number }>(
        db,
        'select counter_value as v from box_counter where box_id = ? and scope = ? and counter_key = ? and business_date = ?',
        boxId,
        RECEIPT_SEQ_SCOPE,
        key,
        RECEIPT_SERIES_DAY,
      )[0]?.v ?? 0,
    );
  const moved = new Map<string, number>();
  const held = selected<{ payload: string }>(
    db,
    'select payload from box_cache where box_id = ? and scope = ?',
    boxId,
    RECEIPT_SERIES,
  )[0];
  let items: unknown[] = [];
  try {
    const parsed = held ? (JSON.parse(held.payload) as { items?: unknown[] }) : null;
    items = Array.isArray(parsed?.items) ? parsed.items : [];
  } catch {
    /* an unreadable mark names no series; the counters below still move */
  }
  for (const raw of items) {
    const mark = raw as { stationId?: unknown; prefix?: unknown; highWaterMark?: unknown };
    if (typeof mark.stationId !== 'string' || typeof mark.prefix !== 'string' || !mark.prefix) continue;
    const highWater = typeof mark.highWaterMark === 'number' ? mark.highWaterMark : 0;
    let observed = 0;
    try {
      const said = JSON.parse(
        selected<{ value: string }>(
          db,
          'select value from box_runtime where box_id = ? and runtime_key = ?',
          boxId,
          observedKey(mark.stationId),
        )[0]?.value ?? 'null',
      ) as { prefix?: unknown; seq?: unknown } | null;
      if (said?.prefix === mark.prefix && typeof said.seq === 'number') observed = said.seq;
    } catch {
      /* a value that cannot be read says nothing */
    }
    const key = receiptCounterKey(mark.stationId, mark.prefix);
    // A box upgraded mid-outage counted since the mark, under its older key.
    const legacy = read(`${mark.stationId}:${mark.prefix}:${highWater}`);
    moved.set(key, Math.max(highWater, observed, read(key), legacy > 0 ? highWater + legacy : 0));
  }
  for (const row of selected<{ counter_key: string; counter_value: number }>(
    db,
    "select counter_key, counter_value from box_counter where box_id = ? and scope = ? and business_date = ? and counter_key like 'last:%'",
    boxId,
    RECEIPT_SEQ_SCOPE,
    RECEIPT_SERIES_DAY,
  )) {
    if (!moved.has(row.counter_key)) moved.set(row.counter_key, Number(row.counter_value));
  }
  const write = db.prepare(`insert into box_counter (box_id, scope, counter_key, business_date, counter_value, updated_at)
    values (?, ?, ?, ?, ?, ?)
    on conflict (box_id, scope, counter_key, business_date) do update
      set counter_value = excluded.counter_value, updated_at = excluded.updated_at`);
  for (const [key, last] of moved) {
    write.run(boxId, RECEIPT_SEQ_SCOPE, key, RECEIPT_SERIES_DAY, last + RECEIPT_RESTORE_MARGIN, at);
  }
  return moved.size;
}

/**
 * Each terminal's reference counter for the newest trading day the copy knows of:
 * an older day's references are not in play. A first tender of the day made after
 * the copy has no row to move, and that one reference can repeat.
 */
function moveTerminalRefsOn(db: SqliteDatabaseLike, boxId: string, at: string): void {
  const write = db.prepare(
    'update box_counter set counter_value = ?, updated_at = ? where box_id = ? and scope = ? and counter_key = ? and business_date = ?',
  );
  for (const row of selected<{ counter_key: string; business_date: string; counter_value: number }>(
    db,
    `select c.counter_key, c.business_date, c.counter_value from box_counter c
      where c.box_id = ? and c.scope = ?
        and c.business_date = (select max(n.business_date) from box_counter n
                                where n.box_id = c.box_id and n.scope = c.scope and n.counter_key = c.counter_key)`,
    boxId,
    TERMINAL_REF_COUNTER_SCOPE,
  )) {
    write.run(
      Math.min(TERMINAL_REF_MAX_SEQ, Number(row.counter_value) + TERMINAL_REF_RESTORE_MARGIN),
      at,
      boxId,
      TERMINAL_REF_COUNTER_SCOPE,
      row.counter_key,
      row.business_date,
    );
  }
}

/**
 * Everything the restored file must say before it can be installed, in one
 * transaction on the temporary copy, so the store is never in place without it:
 *
 *  - the journal waits (`awaitingEpochNote`), because its next address is one the
 *    platform may already hold;
 *  - receipt and terminal numbers move on, because a guest may hold the next ones;
 *  - print jobs do not run again by themselves, because any of them may have come
 *    out of the printer after the copy. They take the road a job cut off mid-print
 *    takes (`interrupted`): reported failed with these words and deleted, and a
 *    person reprints from History the slip a guest does not have.
 */
function prepareRestoredFile(
  db: SqliteDatabaseLike,
  boxIds: readonly string[],
  summary: { unsent: number; copyAt: string | null },
  at: string,
): { receiptSeries: number; printJobsHeld: number } {
  prepareSqliteBoxStore(db);
  db.exec('begin immediate');
  try {
    let receiptSeries = 0;
    const note = db.prepare(`insert into box_runtime (box_id, runtime_key, value, updated_at) values (?, ?, ?, ?)
      on conflict (box_id, runtime_key) do update set value = excluded.value, updated_at = excluded.updated_at`);
    for (const boxId of boxIds) {
      note.run(boxId, JOURNAL_EPOCH_KEY, awaitingEpochNote(at), at);
      note.run(boxId, STORE_RESTORED_KEY, JSON.stringify({ at, ...summary }), at);
      receiptSeries += moveReceiptsOn(db, boxId, at);
      moveTerminalRefsOn(db, boxId, at);
    }
    const held = Number(
      selected<{ n: number }>(db, "select count(*) as n from box_print_job where state in ('queued', 'sending')")[0]?.n ?? 0,
    );
    db.prepare(
      `update box_print_job set state = 'interrupted', last_error_code = 'PRINT_STORE_RESTORED',
         last_error_message = ?, updated_at = ? where state in ('queued', 'sending')`,
    ).run(
      'The store was restored from a copy, and this slip may already have printed, so it was not printed again. Reprint it from History if the guest does not have it.',
      at,
    );
    db.exec('commit');
    return { receiptSeries, printJobsHeld: held };
  } catch (error) {
    try {
      db.exec('rollback');
    } catch {
      /* the transaction is already gone */
    }
    throw error;
  }
}

function sqliteRefusal(error: unknown): RestoreRefusal | null {
  const primary = (error as { errcode?: unknown }).errcode;
  if (typeof primary === 'number' && [11, 26].includes(primary & 0xff)) {
    return new RestoreRefusal(
      'source_damaged',
      'That copy is damaged. Try the older ones beside it, .mirror.1 and then .mirror.2. The current store has not been moved.',
    );
  }
  return null;
}

export async function restoreStore(
  home: string,
  source: string,
  stopped = serviceStopped,
  options: RestoreOptions = {},
): Promise<RestoreResult> {
  const paths = runnerPaths(resolve(home));
  await mkdir(paths.home, { recursive: true, mode: 0o700 });
  await stopped();
  const release = await holdStoreLock(paths.home);
  const suffix = `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
  const temp = `${paths.database}.restore-${suffix}`;
  const moved: Array<{ from: string; to: string }> = [];
  try {
    await stopped();
    if (resolve(source) === resolve(paths.database))
      throw new RestoreRefusal('same_file', 'Choose a mirror file, not the current store.');
    const claiming = await stat(`${paths.home}/claiming.json`).catch(() => null);
    if (claiming && Date.now() - claiming.mtimeMs < 300_000)
      throw new RestoreRefusal('claim_under_way', 'A box registration is in progress; finish it before restoring.');
    await copyFile(source, temp, constants.COPYFILE_EXCL).catch((error: NodeJS.ErrnoException) => {
      throw new RestoreRefusal(
        'source_unreadable',
        `That file could not be read (${error.code ?? 'unknown error'}): ${source}. Check the path and that the mirror drive is attached. The current store has not been moved.`,
      );
    });

    let checked: SqliteDatabaseLike | null = null;
    let unsent: number;
    let journals: Array<{ box_id: string; journal_epoch: number }>;
    let copyAt: string | null = null;
    let unsentEpochs: number[] = [];
    try {
      checked = await openSqlite(temp, true);
      const rows = selected(checked, 'pragma quick_check');
      if (rows.length !== 1 || Object.values(rows[0] as object)[0] !== 'ok') {
        throw new RestoreRefusal(
          'source_damaged',
          'That copy is damaged. Try the older ones beside it, .mirror.1 and then .mirror.2. The current store has not been moved.',
        );
      }
      if (!hasTable(checked, 'box_outbox') || !hasTable(checked, 'box_state')) {
        throw new RestoreRefusal(
          'not_a_mirror',
          'That file is a database, but not a box mirror. Name a box.sqlite.mirror file. The current store has not been moved.',
        );
      }
      journals = journalsOf(checked);
      if (journals.length === 0) {
        throw new RestoreRefusal(
          'not_a_mirror',
          'That copy was taken from a box that was never registered, so there is nothing to restore. The current store has not been moved.',
        );
      }
      // Read the table, not an index; quarantined and acknowledged rows already reached the cloud.
      unsent = Number(
        selected<{ n: number }>(
          checked,
          "select count(*) as n from box_outbox not indexed where state in ('queued','sending','failed')",
        )[0]?.n ?? 0,
      );
      unsentEpochs = selected<{ e: number }>(
        checked,
        "select distinct journal_epoch as e from box_outbox not indexed where state in ('queued','sending','failed')",
      ).map((row) => Number(row.e));
      copyAt =
        selected<{ at: string | null }>(
          checked,
          "select max(at) as at from (select max(updated_at) as at from box_state union all select max(created_at) from box_outbox not indexed)",
        )[0]?.at ?? null;
    } catch (error) {
      throw sqliteRefusal(error) ?? error;
    } finally {
      try {
        checked?.close();
      } catch {
        /* nothing opened */
      }
    }
    const boxIds = journals.map((row) => row.box_id);

    /**
     * WHOSE IS THIS. A home that still names a box is held to it. A replaced drive
     * names nobody, so nothing can be compared here: the copy names the box instead
     * (`STORE_RESTORED_KEY`, printed by the command), and the claim that follows
     * tells the platform which box it must be for, which refuses any other code
     * without spending it (`expectedBoxId`).
     */
    const current = await homeIdentity(paths);
    const named = current.credential ?? current.journals[0]?.box_id ?? null;
    if (named && !boxIds.includes(named) && !options.allowOtherBox) {
      throw new RestoreRefusal(
        'other_box',
        `That copy belongs to box ${boxIds[0]}, and this home is box ${named}. Nothing has been moved. If you are sure, add --other-box.`,
      );
    }
    /**
     * CLAIMED FIRST. The store in place is on a later journal than the copy's unsent
     * records, because a blank drive was claimed before this restore and the
     * platform moved on. They would each come back refused and be left to record by
     * hand. Said before it happens, and only done when asked.
     */
    const ahead = current.journals.find(
      (row) => boxIds.includes(row.box_id) && unsentEpochs.some((epoch) => row.journal_epoch > epoch),
    );
    if (ahead && !options.acceptRefused) {
      throw new RestoreRefusal(
        'epoch_passed',
        `Box ${ahead.box_id} has been claimed on a later journal (${ahead.journal_epoch}) than the copy's ${unsent} unsent record(s), so the platform would refuse them and they would have to be recorded by hand. Nothing has been moved. To go ahead anyway, add --accept-refused.`,
      );
    }

    const at = (options.now?.() ?? new Date()).toISOString();
    const writing = await openSqlite(temp, false);
    let prepared: { receiptSeries: number; printJobsHeld: number };
    try {
      prepared = prepareRestoredFile(writing, boxIds, { unsent, copyAt }, at);
    } finally {
      writing.close();
    }
    const handle = await open(temp, 'r+');
    try {
      await handle.chmod(0o600);
      await handle.sync();
    } finally {
      await handle.close();
    }
    for (const tail of ['', '-wal', '-shm']) {
      const from = `${paths.database}${tail}`;
      const to = `${paths.database}.replaced-${suffix}${tail}`;
      try {
        await rename(from, to);
        moved.push({ from, to });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    await rename(temp, paths.database);
    if (process.platform !== 'win32') {
      const directory = await open(paths.home, 'r');
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    }
    return {
      unsent,
      replaced: moved.map(({ to }) => to),
      boxIds,
      copyAt,
      receiptMargin: RECEIPT_RESTORE_MARGIN,
      receiptSeries: prepared.receiptSeries,
      printJobsHeld: prepared.printJobsHeld,
    };
  } catch (error) {
    // Put the original family back if installation failed. A failed rollback
    // leaves the named aside intact for recovery, never deletes it.
    for (const { from, to } of moved.reverse()) await rename(to, from).catch(() => undefined);
    throw error;
  } finally {
    for (const tail of ['', '-wal', '-shm', '-journal']) await rm(`${temp}${tail}`, { force: true });
    await release();
  }
}

/** The box a restored store came back as, while its journal still waits. Null otherwise. */
export function restoredIdentity(
  db: SqliteDatabaseLike,
): { boxId: string; at: string | null; unsent: number } | null {
  if (!hasTable(db, 'box_runtime') || !hasTable(db, 'box_state')) return null;
  for (const { box_id: boxId } of journalsOf(db)) {
    const [restored, journal] = [STORE_RESTORED_KEY, JOURNAL_EPOCH_KEY].map(
      (key) =>
        selected<{ value: string }>(
          db,
          'select value from box_runtime where box_id = ? and runtime_key = ?',
          boxId,
          key,
        )[0]?.value ?? null,
    );
    if (!restored || !journal) continue;
    try {
      if ((JSON.parse(journal) as { state?: unknown }).state === 'taken') continue;
      const said = JSON.parse(restored) as { at?: unknown };
      const unsent = Number(
        selected<{ n: number }>(
          db,
          "select count(*) as n from box_outbox not indexed where box_id = ? and state in ('queued','sending','failed')",
          boxId,
        )[0]?.n ?? 0,
      );
      return { boxId, at: typeof said.at === 'string' ? said.at : null, unsent };
    } catch {
      /* a note that cannot be read names nobody */
    }
  }
  return null;
}
