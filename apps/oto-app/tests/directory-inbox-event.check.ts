// seed: its own — three ZZ TEST park groups, made here and removed afterwards.
// Not a Playwright file: it mounts the directory routes on a bare server and
// needs a database whose otoapp schema the app's migrator has built.
//
// SCRUM-775 — a birthday booked from the platform inbox's Book Date
// (`POST /api/directory/events`):
//   - a tenant-bound directory key with `events:write` is the only way in;
//   - the event is a TENTATIVE birthday at the app branch mapped to the
//     platform branch sent, naming the conversation it came from; a park the
//     app has no branch for is refused `branch_not_mapped` and nothing is made;
//   - a park group with no statuses gets the board's four defaults and then
//     Tentative, last; one with statuses gets Tentative appended at the end;
//     one that already has a status named Tentative uses it and gains nothing;
//   - the same id for the same conversation is a replay (one row), sent twice
//     in a row or three times at once; the same id for another conversation,
//     or from another park group, is refused `id_in_use`;
//   - the Events page's deep link (`?beo=<event id>`, the inbox's Create BEO)
//     is read only when it names one uuid, and is taken off the address.
//
// Run from apps/oto-app: DATABASE_URL=<migrated scratch> npx tsx tests/directory-inbox-event.check.ts
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import express from "express";
import pg from "pg";
import { directoryEventRouter } from "../server/directory/eventRoutes";
import { generateDirectoryKey, hashDirectoryKey } from "../server/directory/clientAuth";
import { beoEventIdFrom, withoutBeoParam } from "../client/src/lib/beo-deep-link";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("directory-inbox-event.check: DATABASE_URL is not set");
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
const tenants = { fresh: randomUUID(), staged: randomUUID(), named: randomUUID() };
const appBranches = { fresh: randomUUID(), staged: randomUUID(), named: randomUUID() };
const coreBranches = { fresh: randomUUID(), staged: randomUUID(), named: randomUUID(), unmapped: randomUUID() };
const keys = { fresh: generateDirectoryKey(), staged: generateDirectoryKey(), named: generateDirectoryKey(), noScope: generateDirectoryKey() };
const conversation = { a: randomUUID(), b: randomUUID() };

let server: Server | undefined;
let base = "";

async function post(body: unknown, key: string | null = keys.fresh) {
  const response = await fetch(`${base}/api/directory/events`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json().catch(() => null)) as any };
}

const count = async (sql: string, params: unknown[]) =>
  Number((await pool.query<{ n: string }>(`select count(*) as n from ${sql}`, params)).rows[0]!.n);

const booking = (over: Record<string, unknown> = {}) => ({
  id: randomUUID(),
  coreBranchId: coreBranches.fresh,
  inboxConversationId: conversation.a,
  title: "ZZ TEST Mali's Birthday",
  eventDate: "2099-03-14",
  startTime: "14:00",
  numChildren: 12,
  numAdults: null,
  childName: "ZZ TEST Mali",
  kidTurningAge: 6,
  bookingName: "ZZ TEST Parent",
  whatsappPhone: "+66812345678",
  ...over,
});

try {
  await pool.query(
    `insert into tenants (id, name, slug) values ($1, $4, $7), ($2, $5, $8), ($3, $6, $9)`,
    [
      tenants.fresh, tenants.staged, tenants.named,
      `ZZ TEST 775 fresh ${run}`, `ZZ TEST 775 staged ${run}`, `ZZ TEST 775 named ${run}`,
      `zz-775-fresh-${run}`, `zz-775-staged-${run}`, `zz-775-named-${run}`,
    ],
  );
  await pool.query(
    `insert into branches (id, tenant_id, name, address, core_branch_id)
     values ($1, $2, 'ZZ TEST 775 park', 'Phuket', $3), ($4, $5, 'ZZ TEST 775 park', 'Phuket', $6), ($7, $8, 'ZZ TEST 775 park', 'Phuket', $9)`,
    [
      appBranches.fresh, tenants.fresh, coreBranches.fresh,
      appBranches.staged, tenants.staged, coreBranches.staged,
      appBranches.named, tenants.named, coreBranches.named,
    ],
  );
  // The staged park group has the board's four already; the named one has its own Tentative.
  await pool.query(
    `insert into event_statuses (tenant_id, name, value, color, sort_order, is_default) values
       ($1, 'Upcoming', 'upcoming', 'blue', 0, true), ($1, 'In Progress', 'in_progress', 'yellow', 1, true),
       ($1, 'Completed', 'completed', 'green', 2, true), ($1, 'Cancelled', 'cancelled', 'gray', 3, true),
       ($2, 'Upcoming', 'upcoming', 'blue', 0, true), ($2, ' tentative ', 'pencilled', 'purple', 1, false)`,
    [tenants.staged, tenants.named],
  );
  const client = (key: string, tenant: string, scopes: string[]) =>
    pool.query(
      `insert into directory_clients (tenant_id, name, key_hash, scopes, is_active) values ($1, $2, $3, $4, true)`,
      [tenant, `ZZ TEST 775 inbox ${run}`, hashDirectoryKey(key), scopes],
    );
  await client(keys.fresh, tenants.fresh, ["events:write"]);
  await client(keys.staged, tenants.staged, ["events:write"]);
  await client(keys.named, tenants.named, ["events:write"]);
  await client(keys.noScope, tenants.fresh, []);

  const app = express();
  app.use(express.json());
  app.use(directoryEventRouter(pool));
  app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(500).json({ error: "Internal server error", message: err.message });
  });
  server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  await check("keyOnly", async () => {
    assert.equal((await post(booking(), null)).status, 401, "no key");
    assert.equal((await post(booking(), keys.noScope)).status, 403, "a key without events:write");
    assert.equal((await post({ ...booking(), extra: true })).status, 400, "a body it does not take");
    assert.equal((await post(booking({ eventDate: "2099-02-30" }))).status, 400, "not a calendar date");
    assert.equal(await count("core_events where tenant_id = $1", [tenants.fresh]), 0);
  });

  await check("unmappedBranch", async () => {
    const res = await post(booking({ coreBranchId: coreBranches.unmapped }));
    assert.equal(res.status, 409);
    assert.equal(res.body.error, "branch_not_mapped");
    assert.equal(await count("core_events where tenant_id = $1", [tenants.fresh]), 0);
    assert.equal(await count("event_statuses where tenant_id = $1", [tenants.fresh]), 0, "no status for a refusal");
  });

  const first = booking();
  await check("tentativeBirthday", async () => {
    const res = await post(first);
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.replayed, false);
    assert.equal(res.body.event.id, first.id);
    assert.equal(res.body.event.status, "tentative");
    assert.equal(res.body.event.statusName, "Tentative");
    assert.equal(res.body.event.branchId, appBranches.fresh);
    assert.equal(res.body.event.coreBranchId, coreBranches.fresh);
    assert.equal(res.body.event.inboxConversationId, conversation.a);
    const { rows } = await pool.query(`select * from core_events where id = $1`, [first.id]);
    const row = rows[0];
    assert.ok(row, "the event row");
    assert.equal(row.event_type, "birthday");
    assert.equal(row.tenant_id, tenants.fresh);
    assert.equal(row.branch_id, appBranches.fresh);
    assert.equal(row.event_date, "2099-03-14");
    assert.equal(row.start_time, "14:00");
    assert.equal(row.num_children, 12);
    assert.equal(row.num_adults, null);
    assert.equal(row.child_name, "ZZ TEST Mali");
    assert.equal(row.kid_turning_age, 6);
    assert.equal(row.booking_name, "ZZ TEST Parent");
    assert.equal(row.whatsapp_phone_raw, "+66812345678");
    assert.equal(row.whatsapp_phone_e164, "+66812345678");
    assert.equal(row.status, "tentative");
    assert.equal(row.inbox_conversation_id, conversation.a);
    assert.equal(row.is_archived, false);
  });

  await check("defaultsThenTentative", async () => {
    const { rows } = await pool.query(
      `select name, value, color, sort_order, is_default from event_statuses where tenant_id = $1 order by sort_order`,
      [tenants.fresh],
    );
    assert.deepEqual(
      rows.map((r) => [r.name, r.value, r.color, r.sort_order, r.is_default]),
      [
        ["Upcoming", "upcoming", "blue", 0, true],
        ["In Progress", "in_progress", "yellow", 1, true],
        ["Completed", "completed", "green", 2, true],
        ["Cancelled", "cancelled", "gray", 3, true],
        ["Tentative", "tentative", "orange", 4, false],
      ],
    );
  });

  await check("replay", async () => {
    const again = await post(first);
    assert.equal(again.status, 200);
    assert.equal(again.body.replayed, true);
    assert.equal(again.body.event.id, first.id);
    const racing = booking();
    const three = await Promise.all([post(racing), post(racing), post(racing)]);
    assert.deepEqual(three.map((r) => r.status).sort(), [200, 200, 201]);
    assert.equal(await count("core_events where id = $1", [racing.id]), 1);
    assert.equal(await count("event_statuses where tenant_id = $1", [tenants.fresh]), 5, "Tentative made once");
  });

  await check("idInUse", async () => {
    const other = await post({ ...first, inboxConversationId: conversation.b });
    assert.equal(other.status, 409);
    assert.equal(other.body.error, "id_in_use");
    const elsewhere = await post({ ...first, coreBranchId: coreBranches.staged }, keys.staged);
    assert.equal(elsewhere.status, 409, "another park group cannot take or read the id");
    assert.equal(elsewhere.body.error, "id_in_use");
    assert.equal(elsewhere.body.event, undefined);
    assert.equal(await count("core_events where id = $1", [first.id]), 1);
  });

  await check("appendedAtTheEnd", async () => {
    const res = await post(booking({ coreBranchId: coreBranches.staged }), keys.staged);
    assert.equal(res.status, 201, JSON.stringify(res.body));
    const { rows } = await pool.query(
      `select name, value, sort_order from event_statuses where tenant_id = $1 order by sort_order`,
      [tenants.staged],
    );
    assert.deepEqual(
      rows.map((r) => [r.name, r.value, r.sort_order]),
      [
        ["Upcoming", "upcoming", 0],
        ["In Progress", "in_progress", 1],
        ["Completed", "completed", 2],
        ["Cancelled", "cancelled", 3],
        ["Tentative", "tentative", 4],
      ],
    );
  });

  await check("namedTentativeUsed", async () => {
    const res = await post(booking({ coreBranchId: coreBranches.named }), keys.named);
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.event.status, "pencilled");
    assert.equal(await count("event_statuses where tenant_id = $1", [tenants.named]), 2, "nothing added");
  });

  await check("deepLink", () => {
    const id = randomUUID();
    assert.equal(beoEventIdFrom(`?beo=${id}`), id);
    assert.equal(beoEventIdFrom(`?beo=${id.toUpperCase()}`), id);
    assert.equal(beoEventIdFrom(`?view=list&beo=${id}`), id);
    assert.equal(beoEventIdFrom(""), null);
    assert.equal(beoEventIdFrom("?beo=not-an-id"), null);
    assert.equal(beoEventIdFrom(`?beo=${id}&beo=${randomUUID()}`), null, "two ids open neither");
    assert.equal(withoutBeoParam("/studio/events/kanban", `?beo=${id}`), "/studio/events/kanban");
    assert.equal(withoutBeoParam("/studio/events/kanban", `?view=list&beo=${id}`), "/studio/events/kanban?view=list");
  });
} finally {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  const all = Object.values(tenants);
  await pool.query(`delete from core_events where tenant_id = any($1::uuid[])`, [all]).catch(() => undefined);
  await pool.query(`delete from event_statuses where tenant_id = any($1::uuid[])`, [all]).catch(() => undefined);
  await pool.query(`delete from directory_clients where tenant_id = any($1::uuid[])`, [all]).catch(() => undefined);
  await pool.query(`delete from branches where tenant_id = any($1::uuid[])`, [all]).catch(() => undefined);
  await pool.query(`delete from tenants where id = any($1::uuid[])`, [all]).catch(() => undefined);
  await pool.end();
}

console.log(JSON.stringify({ results, failures }, null, 2));
if (Object.values(results).some((ok) => !ok) || Object.keys(results).length !== 9) process.exit(1);
