import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import pg from 'pg';
import {
  newId,
  PAYMENT_ATTEMPT_STATUSES as SHARED_STATUSES,
  PAYMENT_METHOD_KINDS as SHARED_KINDS,
  PAYMENT_METHODS as SHARED_METHODS,
  PAYMENT_PROVIDERS as SHARED_PROVIDERS,
} from '@oto/shared';
import { BOX_COMMAND_KINDS } from '../src/schema/edge';
import {
  PAYMENT_ATTEMPT_STATUSES,
  PAYMENT_METHODS,
  PAYMENT_PROVIDERS,
} from '../src/schema/sales';
import { PAYMENT_METHOD_KINDS } from '../src/schema/catalog';
import { createTestDatabase, stopTestServer } from '../src/testing';

/**
 * SCRUM-206 (S2-10a) — the tender ledger, asserted against a live database
 * built from the committed migrations.
 *
 * TWO KINDS OF ASSERTION HERE, and they catch different mistakes.
 *
 * The first is cheap and needs no database: the vocabulary exists in two
 * places — `@oto/shared/payments.ts`, which the till, the Console and the box
 * agent read, and `packages/db/src/schema`, which is what the CHECK
 * constraints are generated from — and a word added to one and not the other
 * is a payment that is refused at a counter. They are compared here in the
 * order they are declared, because a CHECK is written from that order and a
 * reordered list is a diff somebody has to read.
 *
 * The second needs the database, because a constraint that exists in the
 * TypeScript and not in the migration protects nothing. These are the ticket's
 * own plants, run as tests rather than remembered as a screenshot: two
 * attempts with one invoice number, and a status word from the gateway's
 * vocabulary that is not in ours.
 */

let db: { url: string; drop: () => Promise<void> };
let client: pg.Client;

describe('anonymous display pairing constraints (SCRUM-201)', () => {
  it('keeps anonymous request tokens and outstanding codes unique and rejects half-claimed rows', async () => {
    const requestId = newId();
    const tokenHash = `fixture-token-${newId()}`;
    const codeHash = `fixture-code-${newId()}`;
    const insert = (id: string, token: string, code: string | null) => client.query(
      `insert into core.display_pairing_request (id, token_hash, pairing_code_hash, expires_at)
       values ($1, $2, $3, now() + interval '10 minutes')`, [id, token, code],
    );
    await insert(requestId, tokenHash, codeHash);
    await expect(insert(newId(), tokenHash, null)).rejects.toThrow(/display_pairing_request_token_unique/);
    await expect(insert(newId(), `fixture-token-${newId()}`, codeHash)).rejects.toThrow(/display_pairing_request_code_unique/);
    await expect(client.query(
      'update core.display_pairing_request set claimed_at = now() where id = $1', [requestId],
    )).rejects.toThrow(/display_pairing_request_claim_check/);
    await client.query('update core.display_pairing_request set pairing_code_hash = null where id = $1', [requestId]);
    await expect(insert(newId(), `fixture-token-${newId()}`, codeHash)).resolves.toBeDefined();
  });

  it('limits live paired displays while retaining revoked and unredeemed history', async () => {
    const { rows } = await client.query<{ id: string; operator_id: string; branch_id: string }>(
      `with o as (
         insert into core.operator (id, name) values (gen_random_uuid(), 'Display constraint op') returning id
       ), b as (
         insert into core.branch (id, operator_id, name, code)
         select gen_random_uuid(), o.id, 'Display constraint park', 'DP' from o returning id, operator_id
       )
       insert into core.station (id, operator_id, branch_id, name, kind)
       select gen_random_uuid(), b.operator_id, b.id, 'Display constraint station', 'till' from b
       returning id, operator_id, branch_id`,
    );
    const target = rows[0]!;
    const insert = (id: string, kind: 'display' | 'kiosk', paired: boolean) => client.query(
      `insert into core.device_credential (id, operator_id, branch_id, station_id, kind, paired_at, secret_hash)
       values ($1, $2, $3, $4, $5, case when $6 then now() else null end, $7)`,
      [id, target.operator_id, target.branch_id, target.id, kind, paired, paired ? `fixture-secret-hash-${newId()}` : null],
    );
    await insert(newId(), 'display', false);
    await insert(newId(), 'display', false);
    const first = newId();
    await insert(first, 'display', true);
    // Rehearse 0031 against conflicting historical rows without altering them.
    // Rolling back also restores the index removed only in this test database.
    await client.query('begin');
    try {
      await client.query('drop index core.device_credential_active_display_unique');
      await insert(newId(), 'display', true);
      const migration = readFileSync(new URL('../migrations/0031_active_station_display.sql', import.meta.url), 'utf8');
      await expect(client.query(migration)).rejects.toThrow(/1 station\(s\) have multiple live paired displays/);
    } finally {
      await client.query('rollback');
    }
    await expect(insert(newId(), 'display', true)).rejects.toThrow(/device_credential_active_display_unique/);
    await expect(insert(newId(), 'kiosk', true)).resolves.toBeDefined();
    await client.query('update core.device_credential set revoked_at = now(), secret_hash = null where id = $1', [first]);
    await expect(insert(newId(), 'display', true)).resolves.toBeDefined();
    const history = await client.query<{ count: number }>(
      "select count(*)::integer as count from core.device_credential where station_id = $1 and kind = 'display'", [target.id],
    );
    expect(history.rows[0]!.count).toBe(4);
  });
});

beforeAll(async () => {
  db = await createTestDatabase();
  client = new pg.Client({ connectionString: db.url });
  await client.connect();
}, 180_000);

afterAll(async () => {
  await client?.end();
  await db?.drop();
  await stopTestServer();
});

/** The `in (…)` list of a named check constraint, in the order it was written. */
async function checkWords(table: string, constraint: string): Promise<string[]> {
  const { rows } = await client.query<{ def: string }>(
    `select pg_get_constraintdef(c.oid) as def
       from pg_constraint c
       join pg_class t on t.oid = c.conrelid
       join pg_namespace n on n.oid = t.relnamespace
      where n.nspname || '.' || t.relname = $1 and c.conname = $2`,
    [table, constraint],
  );
  expect(rows[0]?.def, `no constraint ${constraint} on ${table}`).toBeDefined();
  return [...rows[0]!.def.matchAll(/'([^']*)'::text/g)].map((m) => m[1]!);
}

describe('the vocabulary is one list, spelled the same in every copy', () => {
  it.each([
    ['methods', PAYMENT_METHODS, SHARED_METHODS],
    ['providers', PAYMENT_PROVIDERS, SHARED_PROVIDERS],
    ['attempt statuses', PAYMENT_ATTEMPT_STATUSES, SHARED_STATUSES],
    ['method kinds', PAYMENT_METHOD_KINDS, SHARED_KINDS],
  ])('%s: @oto/db and @oto/shared agree word for word, in order', (_label, fromDb, fromShared) => {
    expect([...fromDb]).toEqual([...fromShared]);
  });

  it.each([
    ['pos.payment_attempt', 'payment_attempt_method_check', PAYMENT_METHODS],
    ['pos.payment_attempt', 'payment_attempt_provider_check', PAYMENT_PROVIDERS],
    ['pos.payment_attempt', 'payment_attempt_status_check', PAYMENT_ATTEMPT_STATUSES],
    ['pos.payment_method', 'payment_method_kind_check', PAYMENT_METHOD_KINDS],
  ])('%s / %s matches the TypeScript union character for character', async (table, constraint, list) => {
    expect(await checkWords(table, constraint)).toEqual([...list]);
  });

  it('box_command_kind_check carries the two S2-10a kinds, in the protocol s order', async () => {
    // The four-copy rule: `protocol.ts`, `schema/edge.ts`, `routes/fleet.ts`
    // and `apps/console/src/api/fleet.ts`. This is the copy the database
    // enforces — a kind the Console offers and the CHECK refuses is a 500 on a
    // button press.
    const words = await checkWords('edge.box_command', 'box_command_kind_check');
    expect(words).toEqual([...BOX_COMMAND_KINDS]);
    expect(words).toContain('terminal_sale');
    expect(words).toContain('drawer_kick');
  });
});

describe('what the database refuses', () => {
  /** A minimal tenant, so an attempt has an operator and a branch to belong to. */
  async function tenancy(): Promise<{ operatorId: string; branchId: string }> {
    const { rows } = await client.query<{ operator_id: string; branch_id: string }>(
      `with o as (
         insert into core.operator (id, name) values (gen_random_uuid(), 'Plant Op') returning id
       ), b as (
         insert into core.branch (id, operator_id, name, code)
         select gen_random_uuid(), o.id, 'Plant Park', 'PP' from o returning id, operator_id
       )
       select operator_id, id as branch_id from b`,
    );
    return { operatorId: rows[0]!.operator_id, branchId: rows[0]!.branch_id };
  }

  async function insertAttempt(
    at: { operatorId: string; branchId: string },
    values: Record<string, string | number> = {},
  ): Promise<void> {
    const row = {
      method: 'cash',
      status: 'approved',
      amount_satang: 45000,
      business_date: '2026-09-20',
      ...values,
    };
    const columns = Object.keys(row);
    await client.query(
      `insert into pos.payment_attempt (id, operator_id, branch_id, ${columns.join(', ')})
       values (gen_random_uuid(), $1, $2, ${columns.map((_c, i) => `$${i + 3}`).join(', ')})`,
      [at.operatorId, at.branchId, ...Object.values(row)],
    );
  }

  async function terminals(at: { operatorId: string; branchId: string }): Promise<[string, string]> {
    const { rows } = await client.query<{ id: string }>(
      `with b as (
         insert into core.box (id, operator_id, branch_id, name, slot)
         values (gen_random_uuid(), $1, $2, 'Plant box', 'plant-terminals') returning id
       )
       insert into core.device (id, operator_id, branch_id, box_id, kind, label, transport)
       select gen_random_uuid(), $1, $2, b.id, 'terminal', labels.label, 'simulated'
         from b cross join (values ('Terminal 1'), ('Terminal 2')) as labels(label)
       returning id`,
      [at.operatorId, at.branchId],
    );
    return [rows[0]!.id, rows[1]!.id];
  }

  it.each(['2c2p', 'simulator'])('PLANT — a second gateway %s attempt on one invoice number', async (provider) => {
    // 2C2P refuses a reused invoice number (`5005`, `9015`), so the reuse has
    // to be impossible on our side rather than discovered at the counter. The
    // gateway index is unique FOR EVER, not per day, station or operator. The
    // gateway simulator observes the same namespace as the real gateway.
    const at = await tenancy();
    const other = await tenancy();
    const invoiceNo = provider === '2c2p' ? 'T01260920000147' : 'T01260920000151';
    await insertAttempt(at, { invoice_no: invoiceNo, method: 'qr', provider });
    await expect(
      insertAttempt(other, {
        invoice_no: invoiceNo,
        method: 'qr',
        provider,
        business_date: '2026-09-21',
      }),
    ).rejects.toThrow(/payment_attempt_gateway_invoice_unique/);
  });

  it('allows terminal-local invoices to repeat across devices and coexist with a gateway invoice', async () => {
    const at = await tenancy();
    const [one, two] = await terminals(at);
    for (const [provider, deviceId, terminalRef] of [
      ['ghl', one, '000001'],
      ['ghl', two, '000001'],
      ['digio', one, '000002'],
      ['simulator', two, '000002'],
    ] as const) {
      await expect(
        insertAttempt(at, {
          invoice_no: '000001',
          method: 'card',
          provider,
          device_id: deviceId,
          terminal_ref: terminalRef,
        }),
      ).resolves.toBeUndefined();
    }
    await expect(
      insertAttempt(at, { invoice_no: '000001', method: 'qr', provider: '2c2p' }),
    ).resolves.toBeUndefined();
    await expect(
      insertAttempt(at, { invoice_no: '000001', method: 'qr', provider: 'simulator' }),
    ).rejects.toThrow(/payment_attempt_gateway_invoice_unique/);
  });

  it('retains device/date/terminalRef replay safety without making terminal invoices unique', async () => {
    const at = await tenancy();
    const [deviceId] = await terminals(at);
    const attempt = {
      invoice_no: '000002',
      method: 'card',
      provider: 'ghl',
      device_id: deviceId,
      terminal_ref: '000001',
    };
    await insertAttempt(at, attempt);
    await expect(insertAttempt(at, attempt)).rejects.toThrow(/payment_attempt_terminal_ref_unique/);
    await expect(
      insertAttempt(at, { ...attempt, terminal_ref: '000002' }),
    ).resolves.toBeUndefined();
    await expect(
      insertAttempt(at, { ...attempt, business_date: '2026-09-21' }),
    ).resolves.toBeUndefined();
  });

  it('PLANT — a status word from the gateway s vocabulary that is not in ours', async () => {
    // `PAYMENT_GATEWAY.md` §3.2 says `created|qr_shown|paid|expired|cancelled|
    // late_paid|refunded`. Ours says `approved`. The mapping is written down
    // once (decision D-3) and the CHECK is what stops a slice inventing its
    // own — an Attempts list with two vocabularies in it is unreadable.
    const at = await tenancy();
    await expect(insertAttempt(at, { status: 'paid' })).rejects.toThrow(
      /payment_attempt_status_check/,
    );
    await expect(insertAttempt(at, { status: 'qr_shown' })).rejects.toThrow(
      /payment_attempt_status_check/,
    );
  });

  it('refuses a second attempt on one action id, which is the replay net', async () => {
    // Pressing Pay twice down a dropped connection. `status = 'finalised'` on
    // the sale stopped being a sufficient guard the moment a sale could sit
    // part-paid.
    const at = await tenancy();
    await insertAttempt(at, { action_id: 'act-1' });
    await expect(insertAttempt(at, { action_id: 'act-1' })).rejects.toThrow(
      /payment_attempt_action_unique/,
    );
  });

  it('allows the same action id under a different operator', async () => {
    const one = await tenancy();
    const two = await tenancy();
    await insertAttempt(one, { action_id: 'act-shared' });
    await expect(insertAttempt(two, { action_id: 'act-shared' })).resolves.toBeUndefined();
  });

  it('allows several attempts on one sale, because a split tender is several', async () => {
    // The shape must not forbid what the ticket exists to allow: two approved
    // attempts covering one sale.
    const at = await tenancy();
    await insertAttempt(at, { amount_satang: 10000 });
    await expect(insertAttempt(at, { amount_satang: 35000 })).resolves.toBeUndefined();
  });

  it('refuses a short cash tender, where a psql session cannot walk around it', async () => {
    const at = await tenancy();
    await expect(insertAttempt(at, { tendered_satang: 40000 })).rejects.toThrow(
      /payment_attempt_tendered_check/,
    );
  });

  it('refuses anything but four digits in last4', async () => {
    const at = await tenancy();
    await expect(insertAttempt(at, { last4: '4111111111111111' })).rejects.toThrow(
      /payment_attempt_last4_check/,
    );
  });

  it('refuses an invoice number the gateway would not honour', async () => {
    const at = await tenancy();
    await expect(insertAttempt(at, { invoice_no: 'T01-2609-20/147' })).rejects.toThrow(
      /payment_attempt_invoice_no_check/,
    );
    await expect(insertAttempt(at, { invoice_no: 'X'.repeat(21) })).rejects.toThrow(
      /payment_attempt_invoice_no_check/,
    );
  });

  it('refuses two notifications for one (invoiceNo, tranRef) delivery', async () => {
    // The webhook's idempotency key. A replay must change nothing, and the
    // database is what decides that rather than whichever branch of the
    // handler happened to run first.
    const at = await tenancy();
    const insert = () =>
      client.query(
        `insert into pos.payment_notification (id, operator_id, invoice_no, tran_ref)
         values (gen_random_uuid(), $1, 'T01260920000148', 'TR-1')`,
        [at.operatorId],
      );
    await insert();
    await expect(insert()).rejects.toThrow(/payment_notification_tran_unique/);
  });

  it('refuses two tranRef-less notifications on one payment id', async () => {
    // The fallback key. Postgres treats nulls as distinct, so a single index
    // over both columns would let this through twice — which is the exact
    // thing the key exists to stop.
    const at = await tenancy();
    const insert = () =>
      client.query(
        `insert into pos.payment_notification (id, operator_id, invoice_no, payment_id)
         values (gen_random_uuid(), $1, 'T01260920000149', 'PAY-1')`,
        [at.operatorId],
      );
    await insert();
    await expect(insert()).rejects.toThrow(/payment_notification_payment_unique/);
  });

  it('refuses a notification carrying neither reference, which both keys would miss', async () => {
    // The hole between two partial indexes: `tran_ref` null and `payment_id`
    // null is covered by neither, so the same delivery could be written as
    // many times as it arrived. A notification with no reference cannot be
    // matched to an attempt or compared with a later one either — it is not a
    // delivery this table can hold, and the handler records it as an ops_run.
    const at = await tenancy();
    await expect(
      client.query(
        `insert into pos.payment_notification (id, operator_id, invoice_no)
         values (gen_random_uuid(), $1, 'T01260920000150')`,
        [at.operatorId],
      ),
    ).rejects.toThrow(/payment_notification_key_check/);
  });

  it('frees a payment method code again once the row is archived', async () => {
    const at = await tenancy();
    const insert = () =>
      client.query(
        `insert into pos.payment_method (id, operator_id, code, label, kind)
         values (gen_random_uuid(), $1, 'promptpay', 'PromptPay', 'qr') returning id`,
        [at.operatorId],
      );
    const first = await insert();
    await expect(insert()).rejects.toThrow(/payment_method_code_unique/);
    await client.query(`update pos.payment_method set archived_at = now() where id = $1`, [
      first.rows[0]!.id,
    ]);
    await expect(insert()).resolves.toBeTruthy();
  });
});

describe('the tenancy foreign keys hold a tenant still in use', () => {
  it('every operator_id on the three tables is ON DELETE restrict', async () => {
    // `no action` and `restrict` both refuse the delete; they differ on when,
    // and a deferred check is one a later transaction can defer past. These
    // are money rows and a tender list, so the refusal is immediate on all
    // three rather than immediate on two of them.
    const { rows } = await client.query<{ table: string; action: string }>(
      `select n.nspname || '.' || t.relname as table, c.confdeltype as action
         from pg_constraint c
         join pg_class t on t.oid = c.conrelid
         join pg_namespace n on n.oid = t.relnamespace
         join unnest(c.conkey) as k(attnum) on true
         join pg_attribute a on a.attrelid = t.oid and a.attnum = k.attnum
        where c.contype = 'f' and a.attname = 'operator_id'
          and n.nspname || '.' || t.relname in
              ('pos.payment_attempt','pos.payment_notification','pos.payment_method')
        order by 1`,
    );
    expect(rows).toEqual([
      { table: 'pos.payment_attempt', action: 'r' },
      { table: 'pos.payment_method', action: 'r' },
      { table: 'pos.payment_notification', action: 'r' },
    ]);
  });
});

describe('every foreign key carries an index', () => {
  it('holds for the two tables this migration adds', async () => {
    // CLAUDE.md §8. An unindexed FK is a sequential scan on every delete of the
    // parent and on every join from it.
    const { rows } = await client.query<{ table: string; column: string }>(
      `select n.nspname || '.' || t.relname as table, a.attname as column
         from pg_constraint c
         join pg_class t on t.oid = c.conrelid
         join pg_namespace n on n.oid = t.relnamespace
         join unnest(c.conkey) as k(attnum) on true
         join pg_attribute a on a.attrelid = t.oid and a.attnum = k.attnum
        where c.contype = 'f'
          and n.nspname || '.' || t.relname in
              ('pos.payment_attempt','pos.payment_notification','pos.payment_method')
          and not exists (
            select 1 from pg_index i
             where i.indrelid = t.oid and i.indkey[0] = a.attnum)`,
    );
    expect(rows).toEqual([]);
  });
});
