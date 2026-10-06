import { describe, expect, it } from 'vitest';
import { SQL } from 'drizzle-orm';
import { getTableConfig, PgTable } from 'drizzle-orm/pg-core';
import * as schema from '../src/schema/index';

/**
 * SCRUM-292 — the schema's own shape, asserted rather than remembered.
 *
 * Four decisions held here by discipline alone until this file existed: row
 * scoping by `operator_id`, `timestamptz` everywhere, soft deletion that
 * actually frees a business key again, and phone numbers stored in one
 * format. Nothing failed when one of them slipped — which is the pattern
 * behind every ticket this file cites: the decisions that were given a check
 * have held, and the decisions that were not have drifted somewhere.
 *
 * It reads the Drizzle table objects and touches no database, so it runs in
 * milliseconds and cannot be made to pass by editing a snapshot. The
 * complement is `pnpm --filter @oto/db verify-schema`, which compares a live
 * catalogue against a committed snapshot: that catches a column that drifted
 * FROM the snapshot, and this catches a column that is wrong in both.
 *
 * **How an exception is taken.** Every list below is read by the assertions
 * as data, so a table that does not conform has to be named in one of them,
 * in a diff somebody reviews, with a reason next to it. Three kinds of list,
 * and the difference between them matters:
 *
 *   - `PLATFORM_OWNED` / `SCOPED_BY_PARENT` / `PARTIAL_UNIQUE_EXEMPT` —
 *     settled exceptions. The shape is deliberate and stays.
 *   - `UNTENANTED_DEBT` / `UNGUARDED_PHONE` / `UNIQUE_NOT_PARTIAL` — known
 *     failures. The shape is wrong, the ticket is named, and the entry is
 *     here so the debt is visible on every run rather than discovered by the
 *     next sweep.
 *
 * A known-failure list is asserted for EXACT equality, in both directions: a
 * new violation fails because it is not on the list, and a fixed one fails
 * because it still is. So the day somebody lands the migration, this file
 * tells them to delete the line rather than quietly keeping a stale one.
 */

interface Table {
  /** The export name, so a failure says which symbol to open. */
  key: string;
  cfg: ReturnType<typeof getTableConfig>;
  /** `schema.table`, the name a migration and a psql session both use. */
  name: string;
  columns: Set<string>;
}

const tableName = (cfg: { schema?: string; name: string }): string =>
  `${cfg.schema ?? 'public'}.${cfg.name}`;

const TABLES: Table[] = Object.entries(schema)
  .filter(([, value]) => value instanceof PgTable)
  .map(([key, value]) => {
    const cfg = getTableConfig(value as PgTable);
    return {
      key,
      cfg,
      name: tableName(cfg),
      columns: new Set(cfg.columns.map((c) => c.name)),
    };
  });

const byName = new Map(TABLES.map((t) => [t.name, t]));

it('retains one scoped display response per credential with restrictive history references (SCRUM-201)', () => {
  const table = byName.get('core.display_response_snapshot')!;
  expect(table).toBeDefined();
  expect(table.cfg.columns.find(column => column.name === 'credential_id')?.primary).toBe(true);
  expect(table.cfg.foreignKeys.map(key => key.reference().columns[0]!.name).sort())
    .toEqual(['box_id', 'branch_id', 'credential_id', 'operator_id', 'station_id']);
  expect(table.cfg.foreignKeys.every(key => key.onDelete === 'restrict')).toBe(true);
  expect(table.cfg.checks.map(check => check.name).sort()).toEqual([
    'display_response_snapshot_document_check', 'display_response_snapshot_epoch_check',
    'display_response_snapshot_kind_check', 'display_response_snapshot_status_check',
  ]);
});

/** The text of a `sql` fragment — a check's predicate, an index's WHERE. */
function sqlToText(value: unknown): string {
  if (!(value instanceof SQL)) return '';
  const chunks = (value as unknown as { queryChunks: unknown[] }).queryChunks;
  return chunks.map(chunkToText).join(' ').replace(/\s+/g, ' ').trim();
}

function chunkToText(chunk: unknown): string {
  if (typeof chunk === 'string') return chunk;
  if (chunk instanceof SQL) return sqlToText(chunk);
  if (chunk && typeof chunk === 'object') {
    const bag = chunk as Record<string, unknown>;
    if (Array.isArray(bag.value)) return bag.value.map(chunkToText).join('');
    if (typeof bag.value === 'string') return bag.value;
    // A column interpolated into the fragment carries its own name.
    if (typeof bag.name === 'string') return bag.name;
  }
  return '';
}

/**
 * Both halves of a known-failure list, said once.
 *
 * `label` is what the failure message calls the thing, and `ticket` is where
 * the fix lives. The stale half is the half that keeps the list honest: a
 * list that only ever grows is a list nobody trusts.
 */
function expectKnownFailures(actual: string[], known: string[], label: string, ticket: string): void {
  const seen = new Set(actual);
  const expected = new Set(known);
  expect(
    actual.filter((v) => !expected.has(v)).sort(),
    `NEW ${label}. Fix it, or add it to the list in this file with the ticket that will.`,
  ).toEqual([]);
  expect(
    known.filter((v) => !seen.has(v)).sort(),
    `FIXED ${label} — ${ticket} landed for these. Delete them from the list in this file.`,
  ).toEqual([]);
}

// --- 1 · Row-scoped tenancy --------------------------------------------------

/**
 * Tables that belong to the platform rather than to any operator. A tenancy
 * column on one of these would have nothing to point at.
 */
const PLATFORM_OWNED: Record<string, string> = {
  'core.operator': 'The tenant itself. A row here IS an operator.',
  'core.auth_throttle':
    'Keyed on a hashed phone or an IP and written before anybody is identified — at the moment it is written there is no account, so there is no operator to attribute it to.',
  'core.display_pairing_request':
    'SCRUM-201: an anonymous screen has no operator or park until a manager claims its short code. Claiming links the request to an operator/park/station-scoped device credential atomically; unclaimed rows have no tenant parent.',
  'core.idempotency_key':
    'Its primary key is (account_id, key) and an account belongs to exactly one operator, so a cross-operator replay is not possible to express. The one exception here that is settled rather than owed.',
  'core.ops_expectation':
    "The watchdog's own configuration: which platform jobs must run and how often. Not an operator's data.",
  'core.ops_last':
    'The last outcome of one of those platform jobs, keyed by the job name.',
};

/**
 * Tables scoped by a parent row rather than by a column of their own, with
 * the column that does it.
 *
 * The test resolves each parent and fails if the named column is not there,
 * or if the parent is not itself scoped — so an entry cannot name a table
 * that does not exist, a column that was renamed, or a parent that is as
 * unscoped as the child. What it does NOT do is make the join mandatory in a
 * handler: `crm.child` is the honest example, where `routes/members.ts` loads
 * the guardian inside the caller's operator first and says why. That is a
 * habit, and a habit is what SCRUM-290 is for.
 */
const SCOPED_BY_PARENT: Record<string, { column: string; parent: string }> = {
  'core.app_identity': { column: 'account_id', parent: 'core.account' },
  'core.handoff_token': { column: 'account_id', parent: 'core.account' },
  'core.role_assignment': { column: 'account_id', parent: 'core.account' },
  'core.role_permission': { column: 'role_id', parent: 'core.role' },
  'core.session': { column: 'account_id', parent: 'core.account' },
  'core.verification_code': { column: 'account_id', parent: 'core.account' },
  'core.box_sync_key': { column: 'box_id', parent: 'core.box' },
  'core.station_device': { column: 'station_id', parent: 'core.station' },
  'core.station_staff': { column: 'station_id', parent: 'core.station' },
  'core.alert_delivery': { column: 'alert_id', parent: 'core.alert' },
  'crm.child': { column: 'member_id', parent: 'crm.member' },
  'crm.member_tier_verification': { column: 'member_id', parent: 'crm.member' },
  'crm.visit_child': { column: 'visit_id', parent: 'crm.visit' },
  'pos.branch_holiday': { column: 'branch_id', parent: 'core.branch' },
  'pos.branch_tax_config': { column: 'branch_id', parent: 'core.branch' },
  'pos.tax_override': { column: 'branch_id', parent: 'core.branch' },
  'pos.stock_location': { column: 'branch_id', parent: 'core.branch' },
  'pos.stock_level': { column: 'stock_location_id', parent: 'pos.stock_location' },
  'pos.attendee': { column: 'booking_id', parent: 'pos.booking' },
  'pos.wallet_entry': { column: 'wallet_id', parent: 'pos.wallet' },
  // S2-11: an append-only event on a band, reached through the band it happened to.
  'pos.band_event': { column: 'band_id', parent: 'pos.band' },
  // `pos.payment_attempt` was here until S2-10a, scoped through its sale. It
  // now carries its own `operator_id` and `branch_id` — it has to, because an
  // attempt can exist before there is a sale to reach them through — so the
  // rules below hold it directly and the entry would only have hidden it from
  // them. A list that only ever grows is a list nobody trusts.
  'booth.booth_staff_assignment': { column: 'station_id', parent: 'core.station' },
};

/**
 * The edge family — known failure, SCRUM-292's own follow-up.
 *
 * These are not in `SCOPED_BY_PARENT`, and the difference is deliberate
 * rather than an oversight: every one of them does carry `box_id`, and
 * `core.box` is scoped, so they would pass that rule. They are held to the
 * stricter one because of what they are. They are the highest-volume tables
 * in the system and they are what a box in a mall writes, so adding
 * `operator_id` after the boxes are in the field is a column plus a backfill
 * running against rows that are still arriving. Doing it while the only
 * writer is the virtual box inside the api process costs a migration.
 */
const UNTENANTED_DEBT = [
  'edge.box_command',
  'edge.box_counter',
  'edge.box_heartbeat',
  'edge.box_outbox',
  'edge.box_print_job',
  'edge.box_runtime',
  'edge.box_staff_session',
  'edge.box_state',
  'edge.box_throttle',
  'edge.station_event',
  'edge.sync_anomaly',
  'edge.sync_cursor',
  'edge.sync_quarantine',
];

describe('tenancy columns (SCRUM-292)', () => {
  it('reads every table in the schema', () => {
    // A guard on the walk itself: an import that stops resolving, or a schema
    // file dropped from the barrel, would otherwise make every list below
    // pass by finding nothing to check.
    expect(TABLES.length).toBeGreaterThan(80);
    expect(new Set(TABLES.map((t) => t.cfg.schema))).toEqual(
      // `analytics` since S2-12 round 4: `fact_occupancy_15min`, the first fact table.
      new Set(['core', 'crm', 'pos', 'promo', 'booth', 'edge', 'analytics']),
    );
  });

  it('every table declares operator_id, names its scoped parent, or is a listed exception', () => {
    const unscoped = TABLES.filter(
      (t) =>
        !t.columns.has('operator_id') &&
        !(t.name in PLATFORM_OWNED) &&
        !(t.name in SCOPED_BY_PARENT),
    ).map((t) => t.name);
    expectKnownFailures(
      unscoped,
      UNTENANTED_DEBT,
      'table with no tenancy column and no named parent',
      "SCRUM-292's follow-up",
    );
  });

  it('every claimed parent exists, is joined by a real foreign key, and is itself scoped', () => {
    const broken: string[] = [];
    for (const [name, { column, parent }] of Object.entries(SCOPED_BY_PARENT)) {
      const table = byName.get(name);
      if (!table) {
        broken.push(`${name}: no such table`);
        continue;
      }
      if (!table.columns.has(column)) {
        broken.push(`${name}: has no column ${column}`);
        continue;
      }
      const joined = table.cfg.foreignKeys.some((fk) => {
        const ref = fk.reference();
        return (
          ref.columns.some((c) => c.name === column) &&
          tableName(getTableConfig(ref.foreignTable)) === parent
        );
      });
      if (!joined) broken.push(`${name}.${column} has no foreign key to ${parent}`);
      const parentTable = byName.get(parent);
      if (!parentTable) {
        broken.push(`${name}: parent ${parent} does not exist`);
      } else if (!parentTable.columns.has('operator_id') && !(parent in SCOPED_BY_PARENT)) {
        broken.push(`${name}: parent ${parent} is not itself scoped`);
      }
    }
    expect(broken.sort(), 'a SCOPED_BY_PARENT entry that does not describe the schema').toEqual([]);
  });

  it('the edge family really is reachable through its box, which is why it is debt and not a hole', () => {
    // The comment above `UNTENANTED_DEBT` says these all carry `box_id` and
    // would pass the parent rule if they were allowed to. Asserted rather than
    // claimed: if one of them ever stops carrying it, "safe today, expensive
    // later" stops being true and the entry needs a different reading.
    const adrift = UNTENANTED_DEBT.filter((name) => !byName.get(name)?.columns.has('box_id'));
    expect(adrift.sort(), 'listed as edge debt but not even reachable through a box').toEqual([]);
  });

  it('every listed exception is still a table, so the lists cannot rot', () => {
    const missing = [...Object.keys(PLATFORM_OWNED), ...UNTENANTED_DEBT].filter(
      (name) => !byName.has(name),
    );
    expect(missing.sort(), 'listed in this file but no longer in the schema — delete the line').toEqual(
      [],
    );
  });

  it('a branch-scoped row is an operator-scoped row: branch_id implies operator_id or a named parent', () => {
    const loose = TABLES.filter(
      (t) =>
        t.columns.has('branch_id') &&
        !t.columns.has('operator_id') &&
        !(t.name in SCOPED_BY_PARENT) &&
        !(t.name in PLATFORM_OWNED),
    ).map((t) => t.name);
    expect(
      loose.sort(),
      'a table keyed on a branch but not on an operator, and not scoped through a named parent',
    ).toEqual([]);
  });

  it('every tenancy column is a real foreign key, not a loose uuid', () => {
    const loose: string[] = [];
    for (const t of TABLES) {
      for (const [column, parent] of [
        ['operator_id', 'core.operator'],
        ['branch_id', 'core.branch'],
      ] as const) {
        if (!t.columns.has(column)) continue;
        const joined = t.cfg.foreignKeys.some((fk) => {
          const ref = fk.reference();
          return (
            ref.columns.some((c) => c.name === column) &&
            tableName(getTableConfig(ref.foreignTable)) === parent
          );
        });
        if (!joined) loose.push(`${t.name}.${column}`);
      }
    }
    expect(loose.sort(), 'a tenancy column with no foreign key behind it').toEqual([]);
  });
});

// --- 2 · timestamptz ---------------------------------------------------------

describe('timestamps (SCRUM-292)', () => {
  /**
   * No exception list, because there is no exception. This one conforms
   * everywhere today — all of it through the shared `timestamps` and
   * `archivedAt` spreads in `schema/helpers.ts` — and the only thing that was
   * ever holding it was that everybody used those spreads. A column declared
   * by hand is where it would go wrong, and that is what this catches.
   *
   * It covers this package's own schema. The OTO App's tables are declared in
   * `schema/otoapp.ts`, which is deliberately not exported from the barrel so
   * that a Drizzle diff can never meet them; their naive timestamps are
   * SCRUM-274 and are not in reach of this walk.
   */
  it('every timestamp column carries a timezone', () => {
    const naive: string[] = [];
    for (const t of TABLES) {
      for (const column of t.cfg.columns) {
        const col = column as unknown as { columnType: string; withTimezone?: boolean };
        if (col.columnType === 'PgTimestamp' && col.withTimezone !== true) {
          naive.push(`${t.name}.${column.name}`);
        }
      }
    }
    expect(
      naive.sort(),
      'timestamp without time zone — use the timestamps/archivedAt spread in schema/helpers.ts',
    ).toEqual([]);
  });

  it('is actually looking at timestamp columns', () => {
    // Without this the assertion above passes just as happily on a walk that
    // found no timestamps at all.
    const timestamps = TABLES.flatMap((t) =>
      t.cfg.columns.filter(
        (c) => (c as unknown as { columnType: string }).columnType === 'PgTimestamp',
      ),
    );
    expect(timestamps.length).toBeGreaterThan(100);
  });
});

// --- 3 · Archivable tables and their unique keys -----------------------------

/**
 * A unique index on an archivable table that is deliberately not partial on
 * `archived_at`.
 */
const PARTIAL_UNIQUE_EXEMPT: Record<string, string> = {
  'core.box.box_claim_code_unique':
    'A claim code is a single-use credential with a life of minutes, not a business key somebody re-uses. Its predicate is that the code exists at all, which is the narrower window.',
};

/**
 * Known failures — SCRUM-273, and SCRUM-253 for the branch.
 *
 * Each of these makes a business key unreusable for ever: archive the row and
 * the name, code or phone number it held can never be taken again. The sharp
 * one is `crm.member.member_phone_unique`, which sits on the park's primary
 * customer key — reception archives a mistyped duplicate and the real person
 * can no longer be created.
 *
 * The fix is a migration per index, and it is cheap now and dear later,
 * because each one has to run against rows that may already have collided
 * into a workaround a person invented at a counter.
 */
const UNIQUE_NOT_PARTIAL = [
  'core.branch.branch_code_unique',
  'core.role_assignment.role_assignment_unique',
  'crm.member.member_phone_unique',
  'crm.tier.tier_code_unique',
  'pos.booking.booking_reference_unique',
  'pos.ticket_package.ticket_package_name_unique',
  'promo.voucher_definition.voucher_definition_code_unique',
];

describe('soft deletion (SCRUM-292)', () => {
  it('every unique key on an archivable table is partial on archived_at', () => {
    const violations: string[] = [];
    for (const t of TABLES) {
      if (!t.columns.has('archived_at')) continue;
      const uniques: Array<{ name: string; where: string }> = [
        ...t.cfg.indexes
          .filter((i) => i.config.unique)
          // An index declared without a name is named by Postgres, and one on
          // an archivable table is a violation either way — so it is reported
          // by position rather than dropped.
          .map((i) => ({
            name: i.config.name ?? '(unnamed index)',
            where: sqlToText(i.config.where),
          })),
        // A table-level unique CONSTRAINT can never carry a predicate, so on
        // an archivable table it is always this violation.
        ...t.cfg.uniqueConstraints.map((u) => ({
          name: u.name ?? '(unnamed constraint)',
          where: '',
        })),
      ];
      for (const u of uniques) {
        const id = `${t.name}.${u.name}`;
        if (id in PARTIAL_UNIQUE_EXEMPT) continue;
        if (!u.where.includes('archived_at')) violations.push(id);
      }
    }
    expectKnownFailures(
      violations,
      UNIQUE_NOT_PARTIAL,
      'unique key on an archivable table that is not partial on archived_at',
      'SCRUM-273',
    );
  });

  it('every exempt unique key still exists', () => {
    const live = new Set(
      TABLES.flatMap((t) => [
        ...t.cfg.indexes.map((i) => `${t.name}.${i.config.name}`),
        ...t.cfg.uniqueConstraints.map((u) => `${t.name}.${u.name}`),
      ]),
    );
    const stale = [...Object.keys(PARTIAL_UNIQUE_EXEMPT), ...UNIQUE_NOT_PARTIAL].filter(
      (id) => !live.has(id),
    );
    expect(stale.sort(), 'named in this file but no longer an index — delete the line').toEqual([]);
  });
});

// --- 4 · Phone numbers -------------------------------------------------------

/**
 * The opening of an E.164 pattern, as it would read inside the CHECK itself:
 * `phone ~ '^\+[1-9]\d{6,14}$'`. Matching on the start of the pattern rather
 * than the whole of it leaves room for a column that allows null without
 * leaving room for a constraint that checks something else entirely.
 */
const E164_PATTERN = '^\\+[1-9]';

/**
 * Known failure — SCRUM-292's own follow-up.
 *
 * Normalisation lives only at the route boundary today: every `normalizePhone`
 * call site is in `routes/*` plus two services. No service normalises on the
 * way in, and `member_phone_unique` is unique on whatever was stored — so a
 * job, a box path, or the next route written is one omission away from a
 * member nobody can find by their own number.
 *
 * SCRUM-201 retires the session mailbox from the application schema after the
 * independent display rollout. Its physical columns stay through this release
 * for the previous API; a later forward migration removes them.
 *
 * A database CHECK is what would make the format a property of the column
 * rather than a habit of the callers.
 */
const UNGUARDED_PHONE = [
  'core.account.phone',
  'core.employee.phone',
  'crm.member.phone',
];

describe('phone numbers (SCRUM-292)', () => {
  const phoneColumns = TABLES.flatMap((t) =>
    t.cfg.columns
      .filter((c) => c.name === 'phone' || c.name.endsWith('_phone'))
      .map((c) => ({ table: t, column: c.name })),
  );

  it('is actually looking at phone columns', () => {
    // `phone_verified_at` is a timestamp and is not one of these, which is why
    // the match is on the whole name rather than on the substring.
    expect(phoneColumns.length).toBeGreaterThanOrEqual(3);
  });

  it('every phone column is constrained to E.164 by the database', () => {
    const unguarded = phoneColumns
      .filter(({ table, column }) => {
        const checks = table.cfg.checks.map((c) => sqlToText(c.value));
        return !checks.some((text) => text.includes(column) && text.includes(E164_PATTERN));
      })
      .map(({ table, column }) => `${table.name}.${column}`);
    expectKnownFailures(
      unguarded,
      UNGUARDED_PHONE,
      'phone column with no E.164 CHECK behind it',
      "SCRUM-292's follow-up",
    );
  });
});
