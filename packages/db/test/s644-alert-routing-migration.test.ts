import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId } from '@oto/shared';
import { createTestDatabase, stopTestServer } from '../src/testing';

/**
 * SCRUM-644 (Q25) — the database half of the alert routing rules.
 *
 * The routes validate first; these checks are what still hold when a later
 * writer forgets: an address REFERENCE can never hold an address, a mute can
 * never outlast a day or lack a reason, and a `muted` delivery always names
 * the mute that held it back.
 */
let client: pg.Client;
let database: { url: string; drop: () => Promise<void> };
let operatorId: string, accountId: string, alertId: string;

beforeAll(async () => {
  database = await createTestDatabase();
  client = new pg.Client({ connectionString: database.url, application_name: 'oto-test-644-alert-routing' });
  await client.connect();
  operatorId = newId(); accountId = newId(); alertId = newId();
  await client.query(`insert into core.operator (id, name) values ($1, 'ZZ TEST 644 routing')`, [operatorId]);
  await client.query(`insert into core.account (id, operator_id, phone, status) values ($1, $2, '+66000000644', 'active')`,
    [accountId, operatorId]);
  await client.query(`insert into core.alert (id, key, category, subject, summary)
    values ($1, 'zz.test.644', 'ops.failing', 'ZZ TEST 644', 'ZZ TEST 644 summary')`, [alertId]);
}, 300_000);

afterAll(async () => {
  try { await client?.end(); } finally {
    try { await database?.drop(); } finally { await stopTestServer(); }
  }
});

async function recipient(channel: string, addressRef: string | null, category = 'ops.failing') {
  return client.query(`insert into core.alert_recipient (id, operator_id, category, channel, address_ref, created_by_account_id)
    values ($1, $2, $3, $4, $5, $6)`, [newId(), operatorId, category, channel, addressRef, accountId]);
}

async function refused(work: Promise<unknown>, constraint: string) {
  await expect(work).rejects.toMatchObject({ code: '23514', constraint });
}

describe('core.alert_recipient (SCRUM-644)', () => {
  it('stores an environment variable NAME for email and webhook rows, and no address for the console', async () => {
    await recipient('email', 'ALERT_ONCALL_EMAIL');
    await recipient('webhook', 'ALERT_ONCALL_WEBHOOK');
    await recipient('console', null, '*');
    const { rows } = await client.query(`select channel, address_ref from core.alert_recipient where operator_id = $1 order by channel`, [operatorId]);
    expect(rows).toEqual([
      { channel: 'console', address_ref: null },
      { channel: 'email', address_ref: 'ALERT_ONCALL_EMAIL' },
      { channel: 'webhook', address_ref: 'ALERT_ONCALL_WEBHOOK' },
    ]);
  });

  it('refuses any value that looks like an address rather than a reference', async () => {
    await refused(recipient('email', 'oncall@example.test'), 'alert_recipient_address_ref_check');
    await refused(recipient('webhook', 'https://hooks.example.test/x'), 'alert_recipient_address_ref_check');
    await refused(recipient('webhook', 'ALERT_X://Y'), 'alert_recipient_address_ref_check');
    await refused(recipient('email', 'ALERT_A@B'), 'alert_recipient_address_ref_check');
    await refused(recipient('email', 'alert_lower_case'), 'alert_recipient_address_ref_check');
    await refused(recipient('email', 'DATABASE_URL'), 'alert_recipient_address_ref_check');
  });

  it('refuses a console row with an address and an email row without one', async () => {
    await refused(recipient('console', 'ALERT_CONSOLE_X'), 'alert_recipient_address_shape_check');
    await refused(recipient('email', null), 'alert_recipient_address_shape_check');
    await refused(recipient('sms', 'ALERT_SMS_X'), 'alert_recipient_channel_check');
    await refused(recipient('console', null, 'Not A Category'), 'alert_recipient_category_check');
  });
});

describe('core.alert_mute (SCRUM-644)', () => {
  const mute = (reason: string, minutes: number) => client.query(
    `insert into core.alert_mute (id, fingerprint, operator_id, reason, starts_at, muted_until, created_by_account_id)
     values ($1, 'zz-test-644-fp', $2, $3, now(), now() + make_interval(mins => $4), $5) returning id`,
    [newId(), operatorId, reason, minutes, accountId]);

  it('accepts a reasoned mute of up to 24 hours', async () => {
    expect((await mute('ZZ TEST planned printer swap', 60)).rowCount).toBe(1);
    expect((await mute('ZZ TEST overnight', 24 * 60)).rowCount).toBe(1);
  });

  it('refuses a mute past 24 hours, a blank reason and a lift without its author', async () => {
    await refused(mute('ZZ TEST too long', 24 * 60 + 1), 'alert_mute_window_check');
    await refused(mute('   ', 30), 'alert_mute_reason_check');
    const { rows: [row] } = await mute('ZZ TEST to lift', 30);
    await refused(client.query(`update core.alert_mute set lifted_at = now() where id = $1`, [row.id]), 'alert_mute_lifted_check');
  });

  it('records a muted delivery only with the mute that held it back, and keeps sent/failed rows valid', async () => {
    const { rows: [row] } = await mute('ZZ TEST delivery', 30);
    await client.query(`insert into core.alert_delivery (id, alert_id, channel, event, status, mute_id)
      values ($1, $2, 'console', 'opened', 'muted', $3)`, [newId(), alertId, row.id]);
    await client.query(`insert into core.alert_delivery (id, alert_id, channel, event, status, target)
      values ($1, $2, 'console', 'opened', 'sent', 'console')`, [newId(), alertId]);
    await client.query(`insert into core.alert_delivery (id, alert_id, channel, event, status, target)
      values ($1, $2, 'email', 'opened', 'unsupported', 'email:ALERT_ONCALL_EMAIL')`, [newId(), alertId]);
    await refused(client.query(`insert into core.alert_delivery (id, alert_id, channel, event, status)
      values ($1, $2, 'console', 'opened', 'muted')`, [newId(), alertId]), 'alert_delivery_mute_check');
    await refused(client.query(`insert into core.alert_delivery (id, alert_id, channel, event, status, mute_id)
      values ($1, $2, 'console', 'opened', 'sent', $3)`, [newId(), alertId, row.id]), 'alert_delivery_mute_check');
    await refused(client.query(`insert into core.alert_delivery (id, alert_id, channel, event, status)
      values ($1, $2, 'console', 'opened', 'dropped')`, [newId(), alertId]), 'alert_delivery_status_check');
  });
});

describe('core.audit_log labels (SCRUM-644)', () => {
  it('adds nullable source_app and category beside the 643 target_app, and an unlabelled insert still works', async () => {
    const { rows } = await client.query(`select column_name, is_nullable from information_schema.columns
      where table_schema = 'core' and table_name = 'audit_log' and column_name in ('source_app','category','target_app') order by 1`);
    expect(rows).toEqual([
      { column_name: 'category', is_nullable: 'YES' },
      { column_name: 'source_app', is_nullable: 'YES' },
      { column_name: 'target_app', is_nullable: 'YES' },
    ]);
    await client.query(`insert into core.audit_log (id, operator_id, action, entity_type, entity_id)
      values ($1, $2, 'zz.test.644', 'zz', 'zz')`, [newId(), operatorId]);
  });
});
