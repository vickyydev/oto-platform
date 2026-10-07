/**
 * The directory API's event writes — the POS seam's way back into this app
 * (events-kiosk PLAN s8, round 0; SCRUM-217).
 *
 * What is held here, against a real database:
 *   - a tenant-bound directory key is the only way in, and its tenant is the
 *     only tenant it reaches: another tenant's event answers 404 and nothing
 *     is written;
 *   - an attendee POST replayed with the same id makes ONE attendee, for a
 *     camp and for a one-off event, sent twice in a row or three times at
 *     once;
 *   - a check-in POST replayed with the same id is answered from the row it
 *     made, and a second check-in for the same child and day is refused.
 *
 * Needs no running app and no browser: it mounts the directory routes on a
 * bare server of its own. It does need DATABASE_URL pointing at a database
 * both migrators have run on (`pnpm db:migrate` at the repository root, then
 * `npm run db:migrate` here). It writes its rows under two fresh tenants and
 * removes them afterwards. Run it with
 * `DATABASE_URL=… npx playwright test tests/directory-event-writes.spec.ts`;
 * with no DATABASE_URL it is skipped.
 */
import { test, expect } from "@playwright/test";
import express from "express";
import pg from "pg";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { randomUUID } from "node:crypto";
import { directoryEventRouter } from "../server/directory/eventRoutes";
import { generateDirectoryKey, hashDirectoryKey } from "../server/directory/clientAuth";

test.skip(!process.env.DATABASE_URL, "needs DATABASE_URL at a migrated database");
test.describe.configure({ mode: "serial" });

let pool: pg.Pool;
let server: Server;
let base = "";

const tenantA = randomUUID();
const tenantB = randomUUID();
const branchA = randomUUID();
const branchB = randomUUID();
const campA = randomUUID();
const eventA = randomUUID();
const partyA = randomUUID();
const eventB = randomUUID();

const keys = {
  a: generateDirectoryKey(),
  b: generateDirectoryKey(),
  revoked: generateDirectoryKey(),
  noScope: generateDirectoryKey(),
};

const DAY1 = "2026-10-12";
const DAY2 = "2026-10-13";

async function post(path: string, body: unknown, key: string | null = keys.a) {
  const response = await fetch(`${base}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(key ? { authorization: `Bearer ${key}` } : {}),
    },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as any };
}

const count = async (sql: string, params: unknown[]) =>
  Number((await pool.query<{ n: string }>(`select count(*) as n from ${sql}`, params)).rows[0]!.n);

test.beforeAll(async () => {
  pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, options: "-c search_path=otoapp", max: 6 });
  await pool.query(
    `insert into tenants (id, name, slug) values ($1, 'Tenant A', $3), ($2, 'Tenant B', $4)`,
    [tenantA, tenantB, `dir-a-${tenantA.slice(0, 8)}`, `dir-b-${tenantB.slice(0, 8)}`],
  );
  await pool.query(
    `insert into branches (id, tenant_id, name, address) values ($1, $2, 'A park', 'Phuket'), ($3, $4, 'B park', 'Bangkok')`,
    [branchA, tenantA, branchB, tenantB],
  );
  const event = (id: string, tenant: string, branch: string, type: string, title: string, end: string | null) =>
    pool.query(
      `insert into core_events (id, tenant_id, branch_id, event_type, title, event_date, camp_end_date, start_time)
       values ($1, $2, $3, $4, $5, $6, $7, '09:00')`,
      [id, tenant, branch, type, title, DAY1, end],
    );
  await event(campA, tenantA, branchA, "camp", "Ocean camp", "2026-10-16");
  await event(eventA, tenantA, branchA, "workshop", "Slime workshop", null);
  await event(partyA, tenantA, branchA, "birthday", "Mali's 6th", null);
  await event(eventB, tenantB, branchB, "studio_event", "B tenant event", null);

  const client = (key: string, tenant: string, name: string, scopes: string[], revoked = false) =>
    pool.query(
      `insert into directory_clients (tenant_id, name, key_hash, scopes, is_active, revoked_at)
       values ($1, $2, $3, $4, $5, $6)`,
      [tenant, name, hashDirectoryKey(key), scopes, !revoked, revoked ? new Date() : null],
    );
  await client(keys.a, tenantA, "pos (A)", ["events:write"]);
  await client(keys.b, tenantB, "pos (B)", ["events:write"]);
  await client(keys.revoked, tenantA, "old pos (A)", ["events:write"], true);
  await client(keys.noScope, tenantA, "reader (A)", []);

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
});

test.afterAll(async () => {
  await new Promise<void>((resolve) => server?.close(() => resolve()));
  if (!pool) return;
  // Events cascade to their registrations, attendees and check-ins.
  await pool.query(`delete from core_events where tenant_id in ($1, $2)`, [tenantA, tenantB]);
  await pool.query(`delete from directory_clients where tenant_id in ($1, $2)`, [tenantA, tenantB]);
  await pool.query(`delete from branches where tenant_id in ($1, $2)`, [tenantA, tenantB]);
  await pool.query(`delete from tenants where id in ($1, $2)`, [tenantA, tenantB]);
  await pool.end();
});

test.describe("who may call", () => {
  const body = () => ({ id: randomUUID(), childFullName: "Nobody", attendanceDays: [DAY1] });

  test("no key is 401, an unknown or revoked key 403, a key without the scope 403", async () => {
    expect((await post(`/api/directory/events/${campA}/attendees`, body(), null)).status).toBe(401);
    expect((await post(`/api/directory/events/${campA}/attendees`, body(), generateDirectoryKey())).status).toBe(403);
    expect((await post(`/api/directory/events/${campA}/attendees`, body(), keys.revoked)).status).toBe(403);
    expect((await post(`/api/directory/events/${campA}/attendees`, body(), keys.noScope)).status).toBe(403);
    expect(await count("camp_registrations where event_id = $1", [campA])).toBe(0);
  });

  test("a key reaches its own tenant only: another tenant's event is 404 and nothing is written", async () => {
    const res = await post(`/api/directory/events/${eventB}/attendees`, { id: randomUUID(), childFullName: "Intruder" }, keys.a);
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("event_not_found");
    expect(await count("event_attendees where event_id = $1", [eventB])).toBe(0);

    // The same event with its own tenant's key is reachable, so the 404 above
    // was the fence and not a missing row.
    const own = await post(`/api/directory/events/${eventB}/attendees`, { id: randomUUID(), childFullName: "Belongs here" }, keys.b);
    expect(own.status).toBe(201);
  });
});

test.describe("adding a child, by the caller's id", () => {
  test("a camp child: the replay makes one registration, with a waiting row for its day", async () => {
    const id = randomUUID();
    const body = {
      id,
      childFullName: "Ploy",
      parentName: "Nok",
      parentPhone: "+66812345001",
      parentAttending: true,
      attendanceDays: [DAY1],
      allergies: "Peanuts",
      notes: "Walk-up added by Som (today only)",
    };
    const first = await post(`/api/directory/events/${campA}/attendees`, body);
    expect(first.status).toBe(201);
    expect(first.body).toMatchObject({
      replayed: false,
      merged: false,
      attendee: { id, eventId: campA, recordKind: "camp_registration", parentAttending: true, attendanceDays: [DAY1] },
    });

    const again = await post(`/api/directory/events/${campA}/attendees`, body);
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ replayed: true, attendee: { id } });

    expect(await count("camp_registrations where id = $1", [id])).toBe(1);
    expect(await count("camp_attendance where camp_registration_id = $1 and attendance_date = $2 and status = 'waiting'", [id, DAY1])).toBe(1);

    // Made as the app's one-time add makes one.
    const row = (await pool.query(`select is_one_time, added_by_manager, parent_attending, special_notes from camp_registrations where id = $1`, [id])).rows[0];
    expect(row).toMatchObject({ is_one_time: true, added_by_manager: true, parent_attending: true });
    expect(row.special_notes).toBe("Walk-up added by Som (today only)");
  });

  test("a one-off event child: three copies at once still make one attendee", async () => {
    const id = randomUUID();
    const body = { id, childFullName: "Tee", parentName: "Pim", parentPhone: "+66812345002", source: "pos" };
    const answers = await Promise.all([1, 2, 3].map(() => post(`/api/directory/events/${eventA}/attendees`, body)));
    expect(answers.map((a) => a.status).sort()).toEqual([200, 200, 201]);
    expect(answers.every((a) => a.body.attendee.id === id)).toBe(true);
    expect(await count("event_attendees where id = $1", [id])).toBe(1);
    expect(await count("event_attendees where event_id = $1", [eventA])).toBe(1);
  });

  test("a party guest is a per-child row too", async () => {
    const res = await post(`/api/directory/events/${partyA}/attendees`, { id: randomUUID(), childFullName: "Guest one" });
    expect(res.status).toBe(201);
    expect(res.body.attendee.recordKind).toBe("event_attendee");
  });

  test("the same id offered for another event is refused, not reused", async () => {
    const id = randomUUID();
    expect((await post(`/api/directory/events/${eventA}/attendees`, { id, childFullName: "First" })).status).toBe(201);
    const reused = await post(`/api/directory/events/${partyA}/attendees`, { id, childFullName: "Second" });
    expect(reused.status).toBe(409);
    expect(reused.body.error).toBe("id_in_use");
    expect(await count("event_attendees where id = $1", [id])).toBe(1);
  });

  test("the camp's own duplicate rule: same name and phone merges the days into the registration", async () => {
    const first = await post(`/api/directory/events/${campA}/attendees`, {
      id: randomUUID(),
      childFullName: "Win",
      parentPhone: "+66812345003",
      attendanceDays: [DAY1],
    });
    expect(first.status).toBe(201);
    const second = await post(`/api/directory/events/${campA}/attendees`, {
      id: randomUUID(),
      childFullName: "  win ",
      parentPhone: "+66812345003",
      attendanceDays: [DAY2],
    });
    expect(second.status).toBe(200);
    expect(second.body).toMatchObject({ merged: true, attendee: { id: first.body.attendee.id, attendanceDays: [DAY1, DAY2] } });
    expect(await count("camp_registrations where event_id = $1 and emergency_contact_number = $2", [campA, "+66812345003"])).toBe(1);
  });

  test("a camp add must name its days; a one-off event takes none", async () => {
    const noDays = await post(`/api/directory/events/${campA}/attendees`, { id: randomUUID(), childFullName: "Days?" });
    expect(noDays.status).toBe(400);
    expect(noDays.body.error).toBe("attendance_days_required");
    const days = await post(`/api/directory/events/${eventA}/attendees`, { id: randomUUID(), childFullName: "Days!", attendanceDays: [DAY1] });
    expect(days.status).toBe(400);
    expect(days.body.error).toBe("attendance_days_not_applicable");
    const junk = await post(`/api/directory/events/${eventA}/attendees`, { id: "not-a-uuid", childFullName: "x", surprise: 1 });
    expect(junk.status).toBe(400);
  });
});

test.describe("checking in, by the caller's id", () => {
  test("a camp child: the replay is answered from the row; a second check-in that day is refused", async () => {
    const attendee = randomUUID();
    expect(
      (await post(`/api/directory/events/${campA}/attendees`, { id: attendee, childFullName: "Fah", attendanceDays: [DAY1, DAY2] })).status,
    ).toBe(201);

    const id = randomUUID();
    const path = `/api/directory/events/${campA}/attendees/${attendee}/checkins`;
    const body = { id, date: DAY1, checkedInAt: "2026-10-12T02:15:00.000Z", checkedInBy: "Som (till 1)" };
    const first = await post(path, body);
    expect(first.status).toBe(201);
    expect(first.body).toMatchObject({
      replayed: false,
      checkin: { attendeeId: attendee, date: DAY1, status: "checked_in", checkinRef: id, checkedInAt: "2026-10-12T02:15:00.000Z" },
    });

    const again = await post(path, body);
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ replayed: true, checkin: { checkinRef: id, status: "checked_in" } });

    const other = await post(path, { ...body, id: randomUUID() });
    expect(other.status).toBe(409);
    expect(other.body.error).toBe("already_checked_in");

    const sameIdOtherDay = await post(path, { ...body, date: DAY2 });
    expect(sameIdOtherDay.status).toBe(409);
    expect(sameIdOtherDay.body.error).toBe("id_in_use");

    // It landed in the app's own day row — the one the app seeded as waiting.
    expect(await count("camp_attendance where camp_registration_id = $1 and attendance_date = $2", [attendee, DAY1])).toBe(1);
    const naive = (await pool.query(`select to_char(checked_in_at, 'YYYY-MM-DD HH24:MI') as at from camp_attendance where checkin_ref = $1`, [id])).rows[0];
    expect(naive.at).toBe("2026-10-12 02:15"); // the app's naive UTC
  });

  test("a one-off event child: two tills at once, one check-in", async () => {
    const attendee = randomUUID();
    expect((await post(`/api/directory/events/${eventA}/attendees`, { id: attendee, childFullName: "Bam" })).status).toBe(201);
    const path = `/api/directory/events/${eventA}/attendees/${attendee}/checkins`;
    const [one, two] = await Promise.all([
      post(path, { id: randomUUID(), date: DAY1 }),
      post(path, { id: randomUUID(), date: DAY1 }),
    ]);
    expect([one.status, two.status].sort()).toEqual([201, 409]);
    expect(await count("event_attendee_checkins where attendee_id = $1", [attendee])).toBe(1);
  });

  test("an attendee of another event, or of another tenant, is not found", async () => {
    const attendee = randomUUID();
    expect((await post(`/api/directory/events/${eventA}/attendees`, { id: attendee, childFullName: "Elsewhere" })).status).toBe(201);
    const wrongEvent = await post(`/api/directory/events/${partyA}/attendees/${attendee}/checkins`, { id: randomUUID(), date: DAY1 });
    expect(wrongEvent.status).toBe(404);
    const wrongTenant = await post(`/api/directory/events/${eventA}/attendees/${attendee}/checkins`, { id: randomUUID(), date: DAY1 }, keys.b);
    expect(wrongTenant.status).toBe(404);
    expect(await count("event_attendee_checkins where attendee_id = $1", [attendee])).toBe(0);
  });
});
