// seed: its own — two ZZ TEST park groups and their users, made here and removed afterwards.
// Not a Playwright file: it mounts the directory routes on a bare server and
// needs a database whose otoapp schema the app's migrator has built.
//
// SCRUM-823 — the platform's inbox telling a person in the bell
// (`POST /api/directory/notifications`):
//   - a tenant-bound directory key with `notifications:write` is the only way
//     in; a key with only `events:write` is refused 403;
//   - the notification lands as an `inbox_handover` row for a user of the
//     key's park group, naming the conversation; a user of another park group
//     is the same 404 as one that does not exist, and nothing is written;
//   - a login in pay only or switched off is addressed nothing (409);
//   - the same id for the same recipient is a replay (one row), sent twice in
//     a row or three times at once; the same id for anyone else is refused
//     `id_in_use`.
//
// Run from apps/oto-app: DATABASE_URL=<migrated scratch> npx tsx tests/directory-notifications.check.ts
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import express from "express";
import pg from "pg";
import { directoryNotificationRouter } from "../server/directory/notificationRoutes";
import { generateDirectoryKey, hashDirectoryKey } from "../server/directory/clientAuth";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("directory-notifications.check: DATABASE_URL is not set");
  process.exit(2);
}

const pool = new pg.Pool({ connectionString: DATABASE_URL, options: "-c search_path=otoapp", max: 6 });
const results: Record<string, boolean> = {};
const failures: Record<string, string> = {};
async function check(name: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    results[name] = true;
  } catch (error) {
    results[name] = false;
    failures[name] = error instanceof Error ? error.message : String(error);
  }
}

const run = randomUUID().slice(0, 8);
const tenants = { mine: randomUUID(), other: randomUUID() };
const users = { manager: randomUUID(), payOnly: randomUUID(), off: randomUUID(), stranger: randomUUID() };
const keys = { mine: generateDirectoryKey(), eventsOnly: generateDirectoryKey() };
const conversation = randomUUID();

let server: Server | undefined;
let base = "";

async function post(body: unknown, key: string | null = keys.mine) {
  const response = await fetch(`${base}/api/directory/notifications`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json().catch(() => null)) as any };
}

const count = async (where: string, params: unknown[]) =>
  Number((await pool.query<{ n: string }>(`select count(*) as n from notifications where ${where}`, params)).rows[0]!.n);

const notice = (over: Record<string, unknown> = {}) => ({
  id: randomUUID(),
  recipientUserId: users.manager,
  title: "ZZ TEST Birthday family waiting in the Inbox",
  body: "ZZ TEST A Birthdays & Events conversation was handed to a person at 14:05 (advice asked).",
  referenceType: "inbox_conversation",
  referenceId: conversation,
  ...over,
});

try {
  await pool.query(`insert into tenants (id, name, slug) values ($1, $3, $5), ($2, $4, $6)`, [
    tenants.mine, tenants.other,
    `ZZ TEST 823 mine ${run}`, `ZZ TEST 823 other ${run}`,
    `zz-823-mine-${run}`, `zz-823-other-${run}`,
  ]);
  const user = (id: string, name: string, extra: { isActive?: boolean; payOnly?: boolean } = {}) =>
    pool.query(
      `insert into users (id, username, email, password, full_name, is_active, access_mode)
       values ($1, $2, $3, 'zz-not-a-hash', $4, $5, $6)`,
      [id, `zz-823-${name}-${run}`, `zz-823-${name}-${run}@example.test`, `ZZ TEST 823 ${name}`, extra.isActive ?? true, extra.payOnly ? "pay_only" : "full"],
    );
  await user(users.manager, "manager");
  await user(users.payOnly, "pay-only", { payOnly: true });
  await user(users.off, "off", { isActive: false });
  await user(users.stranger, "stranger");
  for (const id of [users.manager, users.payOnly, users.off]) {
    await pool.query(`insert into user_branch_access (tenant_id, user_id) values ($1, $2)`, [tenants.mine, id]);
  }
  await pool.query(`insert into user_branch_access (tenant_id, user_id) values ($1, $2)`, [tenants.other, users.stranger]);
  const client = (key: string, scopes: string[]) =>
    pool.query(`insert into directory_clients (tenant_id, name, key_hash, scopes, is_active) values ($1, $2, $3, $4, true)`, [
      tenants.mine,
      `ZZ TEST 823 inbox ${run}`,
      hashDirectoryKey(key),
      scopes,
    ]);
  await client(keys.mine, ["events:write", "notifications:write"]);
  await client(keys.eventsOnly, ["events:write"]);

  const app = express();
  app.use(express.json());
  app.use(directoryNotificationRouter(pool));
  app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(500).json({ error: "Internal server error", message: err.message });
  });
  server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  await check("keyOnly", async () => {
    assert.equal((await post(notice(), null)).status, 401, "no key");
    assert.equal((await post(notice(), keys.eventsOnly)).status, 403, "a key without notifications:write");
    assert.equal((await post({ ...notice(), extra: true })).status, 400, "a body it does not take");
    assert.equal((await post(notice({ referenceType: "task" }))).status, 400, "only an inbox conversation");
    assert.equal(await count("tenant_id = $1", [tenants.mine]), 0);
  });

  const first = notice();
  await check("inTheBell", async () => {
    const res = await post(first);
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.replayed, false);
    assert.equal(res.body.notification.id, first.id);
    assert.equal(res.body.notification.type, "inbox_handover");
    const { rows } = await pool.query(`select * from notifications where id = $1`, [first.id]);
    const row = rows[0];
    assert.ok(row, "the notification row");
    assert.equal(row.tenant_id, tenants.mine);
    assert.equal(row.recipient_user_id, users.manager);
    assert.equal(row.type, "inbox_handover");
    assert.equal(row.reference_type, "inbox_conversation");
    assert.equal(row.reference_id, conversation);
    assert.equal(row.is_read, false);
  });

  await check("replay", async () => {
    const again = await post(first);
    assert.equal(again.status, 200);
    assert.equal(again.body.replayed, true);
    const burst = notice();
    const answers = await Promise.all([post(burst), post(burst), post(burst)]);
    assert.deepEqual(answers.map((a) => a.status).sort(), [200, 200, 201]);
    assert.equal(await count("id = any($1::uuid[])", [[first.id, burst.id]]), 2);
  });

  await check("idInUse", async () => {
    const res = await post({ ...first, recipientUserId: users.payOnly });
    assert.equal(res.status, 409);
    assert.equal(res.body.error, "id_in_use");
  });

  await check("anotherParkGroupIsNotFound", async () => {
    const res = await post(notice({ recipientUserId: users.stranger }));
    assert.equal(res.status, 404);
    assert.equal(res.body.error, "recipient_not_found");
    const nobody = await post(notice({ recipientUserId: randomUUID() }));
    assert.equal(nobody.status, 404);
    assert.equal(await count("recipient_user_id = $1", [users.stranger]), 0);
  });

  await check("heldLogins", async () => {
    for (const id of [users.payOnly, users.off]) {
      const res = await post(notice({ recipientUserId: id }));
      assert.equal(res.status, 409, id);
      assert.equal(res.body.error, "recipient_not_addressable");
    }
    assert.equal(await count("recipient_user_id = any($1::varchar[])", [[users.payOnly, users.off]]), 0);
  });
} finally {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  const all = Object.values(tenants);
  await pool.query(`delete from notifications where tenant_id = any($1::uuid[])`, [all]).catch(() => undefined);
  await pool.query(`delete from directory_clients where tenant_id = any($1::uuid[])`, [all]).catch(() => undefined);
  await pool.query(`delete from user_branch_access where tenant_id = any($1::uuid[])`, [all]).catch(() => undefined);
  await pool.query(`delete from users where id = any($1::varchar[])`, [Object.values(users)]).catch(() => undefined);
  await pool.query(`delete from tenants where id = any($1::uuid[])`, [all]).catch(() => undefined);
  await pool.end();
}

console.log(JSON.stringify({ results, failures }, null, 2));
if (Object.values(results).some((ok) => !ok) || Object.keys(results).length !== 6) process.exit(1);
