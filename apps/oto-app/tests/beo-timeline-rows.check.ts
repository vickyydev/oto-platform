// seed: its own — one ZZ TEST park group, made here and removed afterwards.
// Not a Playwright file: it calls the BEO's timeline generator directly and
// needs a database whose otoapp schema the app's migrator has built.
//
// SCRUM-1027 — the stored automatic timeline rows on the next Save of a BEO
// (generateTimelineFromBeo in server/beo-routes.ts), after the one timeline
// (shared/beoTimeline.ts) stopped making steps the old rules stored with an
// invented time:
//
//   1. a row staff ticked done is kept with its tick and who ticked it, even
//      when the timeline no longer makes its step (a setup task with no time
//      of its own; it was placed 30 minutes before the start);
//   2. such a row that nobody ticked is removed, as removed steps always were;
//   3. the steps the timeline makes are stored (Setup ready at its ready-by),
//      a stored step keeps its tick when its words change, and the party's
//      end time stores no step;
//   4. a kept ticked row is not shown again: the built timeline shows only
//      the steps it makes and the rows typed by hand.
//
// Run from apps/oto-app:
//   DATABASE_URL=<migrated scratch> npx tsx tests/beo-timeline-rows.check.ts
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("beo-timeline-rows.check: DATABASE_URL is not set");
  process.exit(2);
}
process.env.APP_ENV ??= "dev";
process.env.STORAGE_ENV_PREFIX ??= "zz-test-1027-rows";
process.env.OBJECT_STORAGE ??= "local";
process.env.DEPLOY_ENV ??= "local";
process.env.SESSION_SECRET ??= randomUUID() + randomUUID();
process.env.LOG_LEVEL ??= "warn";

const { generateTimelineFromBeo } = await import("../server/beo-routes");
const { readBeoTimeline, tickMadeStep } = await import("../server/lib/beoTimelineRead");
const { pool: appDbPool } = await import("../server/db");

const pool = new pg.Pool({ connectionString: DATABASE_URL, options: "-c search_path=otoapp", max: 2 });
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- rows are read field by field below
const q = async <T extends pg.QueryResultRow = Record<string, any>>(text: string, params: unknown[] = []) => (await pool.query<T>(text, params)).rows;

let checks = 0;
const check = async (title: string, fn: () => Promise<void> | void) => {
  await fn();
  checks += 1;
  console.log(`  ok  ${title}`);
};

const run = randomUUID().slice(0, 8);
const tenant = randomUUID();
const park = randomUUID();
const staff = randomUUID();
const eventId = randomUUID();
const tickedAt = new Date("2099-04-18T06:40:00Z");

type Row = { source_key: string | null; label: string; offset_from_start_minutes: number; is_completed: boolean; completed_by_user_id: string | null; completed_at: Date | null };
const rowsOf = async () =>
  q<Row>("select source_key, label, offset_from_start_minutes, is_completed, completed_by_user_id, completed_at from beo_timeline_items where event_id = $1 and is_system_generated order by source_key", [eventId]);
const storedRow = (sourceKey: string, label: string, offset: number, ticked: boolean) =>
  q(
    `insert into beo_timeline_items (event_id, label, offset_from_start_minutes, assigned_to_type, is_system_generated, source_key, sort_order, is_completed, completed_at, completed_by_user_id)
     values ($1, $2, $3, 'SETUP_RESPONSIBLE', true, $4, 0, $5, $6, $7)`,
    [eventId, label, offset, sourceKey, ticked, ticked ? tickedAt : null, ticked ? staff : null],
  );

try {
  await q("insert into tenants (id, name, slug) values ($1, $2, $3)", [tenant, `ZZ TEST 1027 ${run}`, `zz-1027-${run}`]);
  await q("insert into branches (id, tenant_id, name, address, timezone) values ($1, $2, 'ZZ TEST 1027 park', 'ZZ TEST', 'Asia/Bangkok')", [park, tenant]);
  await q("insert into users (id, email, password, full_name, role, is_active, must_change_password) values ($1, $2, 'x', 'ZZ TEST 1027', 'manager', true, false)", [staff, `zz-1027-${run}@example.com`]);
  await q(
    `insert into core_events (id, tenant_id, branch_id, event_type, title, event_date, start_time, end_time, num_children, num_adults, status)
     values ($1, $2, $3, 'birthday', $4, '2099-04-18', '14:00', '17:00', 10, 4, 'upcoming')`,
    [eventId, tenant, park, `ZZ TEST 1027 rows ${run}`],
  );
  // A setup plan with a ready-by and two tasks that store no time of their own.
  await q("insert into beo_setup_plans (event_id, setup_required, setup_tasks) values ($1, true, $2)", [
    eventId,
    JSON.stringify({ readyBy: "13:30", simplifiedTasks: [{ id: "a", itemLabel: "ZZ TEST balloon arch" }, { id: "b", itemLabel: "ZZ TEST table cloths" }] }),
  ]);
  // What the old rules stored: each task 30 minutes before the start; the first one ticked done.
  await storedRow("setup_task::0", "ZZ TEST balloon arch", -30, true);
  await storedRow("setup_task::1", "ZZ TEST table cloths", -30, false);
  await storedRow("guests_arrive", "Guests arrive", 0, true);

  await generateTimelineFromBeo(eventId);
  const rows = await rowsOf();

  await check("a ticked row whose step the timeline no longer makes is kept, with its tick, who and when", () => {
    const kept = rows.find((r) => r.source_key === "setup_task::0");
    assert.ok(kept, JSON.stringify(rows));
    assert.deepEqual([kept.label, kept.offset_from_start_minutes, kept.is_completed, kept.completed_by_user_id], ["ZZ TEST balloon arch", -30, true, staff]);
    assert.equal(kept.completed_at?.toISOString(), tickedAt.toISOString());
  });

  await check("an unticked row whose step the timeline no longer makes is removed, as removed steps always were", () => {
    assert.equal(rows.some((r) => r.source_key === "setup_task::1"), false, JSON.stringify(rows));
  });

  await check("the steps the timeline makes are stored; a stored step keeps its tick; the end time stores no step", () => {
    assert.deepEqual(rows.map((r) => r.source_key), ["guests_arrive", "setup_ready", "setup_task::0"]);
    const ready = rows.find((r) => r.source_key === "setup_ready")!;
    assert.deepEqual([ready.label, ready.offset_from_start_minutes, ready.is_completed], ["Setup ready", -30, false]);
    const arrive = rows.find((r) => r.source_key === "guests_arrive")!;
    assert.deepEqual([arrive.offset_from_start_minutes, arrive.is_completed, arrive.completed_by_user_id], [0, true, staff]);
  });

  await check("a kept ticked row is not shown again: the timeline shows only the steps it makes", async () => {
    const [event] = await q("select * from core_events where id = $1", [eventId]);
    assert.ok(event);
    const timeline = await readBeoTimeline({
      id: event.id, tenantId: event.tenant_id, startTime: event.start_time, endTime: event.end_time, suppressedTimelineSources: event.suppressed_timeline_sources,
    } as Parameters<typeof readBeoTimeline>[0]);
    assert.deepEqual(timeline.steps.map((s) => [s.time, s.label]), [["13:30", "Setup ready"], ["14:00", "Guests arrive"]]);
    assert.equal(timeline.steps.find((s) => s.key === "guests_arrive")!.isCompleted, true, "the stored tick is carried");
    assert.deepEqual(timeline.untimed.filter((u) => u.home === "setup").map((u) => u.label), ["ZZ TEST balloon arch", "ZZ TEST table cloths"], "the tasks belong to the setup plan");
  });

  // SCRUM-1050: a step the timeline makes that no Save stored yet (the kids' menu's time, set after
  // the last Save) is ticked on the Day-of view straight away.
  await q("insert into beo_kitchen_plans (event_id, food_required, menus) values ($1, true, $2)", [
    eventId,
    JSON.stringify({ kids: [{ id: "k1", itemName: "ZZ TEST Margherita", quantity: 3 }], adults: [], adultsDiffer: false, kidsFoodTime: "14:30", adultsFoodTime: "" }),
  ]);
  const eventRead = async () => {
    const [event] = await q("select * from core_events where id = $1", [eventId]);
    return { id: event.id, tenantId: event.tenant_id, startTime: event.start_time, endTime: event.end_time, suppressedTimelineSources: event.suppressed_timeline_sources } as Parameters<typeof readBeoTimeline>[0];
  };

  await check("SCRUM-1050: the first tick of a step not stored yet stores its row as the generator would, ticked by this person", async () => {
    const before = await readBeoTimeline(await eventRead());
    const kids = before.steps.find((s) => s.key === "kids_food");
    assert.ok(kids, "the timeline makes the kids' menu step");
    assert.equal(kids.rowId, null, "not stored yet: it had no tick until the next Save");
    const row = await tickMadeStep(await eventRead(), "kids_food", staff);
    assert.ok(row);
    assert.deepEqual(
      [row.sourceKey, row.label, row.offsetFromStartMinutes, row.assignedToType, row.isSystemGenerated, row.isCompleted, row.completedByUserId],
      ["kids_food", "Kids' menu served", 30, "KITCHEN_RESPONSIBLE", true, true, staff],
    );
    const after = await readBeoTimeline(await eventRead());
    const ticked = after.steps.find((s) => s.key === "kids_food")!;
    assert.equal(ticked.rowId, row.id);
    assert.equal(ticked.isCompleted, true, "the timeline shows the tick at once");
  });

  await check("SCRUM-1050: the next Save stores no second row for it and keeps the tick; a second press keeps it ticked", async () => {
    await generateTimelineFromBeo(eventId);
    const kids = (await rowsOf()).filter((r) => r.source_key === "kids_food");
    assert.equal(kids.length, 1, JSON.stringify(kids));
    assert.deepEqual([kids[0]!.is_completed, kids[0]!.completed_by_user_id, kids[0]!.offset_from_start_minutes], [true, staff, 30]);
    const again = await tickMadeStep(await eventRead(), "kids_food", staff);
    assert.equal(again?.isCompleted, true);
    assert.equal((await rowsOf()).filter((r) => r.source_key === "kids_food").length, 1);
  });

  await check("SCRUM-1050: a step the timeline does not make, or one staff removed, stores nothing", async () => {
    assert.equal(await tickMadeStep(await eventRead(), "cake", staff), null, "no cake on this party");
    await q("update core_events set suppressed_timeline_sources = $2 where id = $1", [eventId, ["setup_ready"]]);
    assert.equal(await tickMadeStep(await eventRead(), "setup_ready", staff), null, "removed by staff");
    await q("update core_events set suppressed_timeline_sources = '{}' where id = $1", [eventId]);
    assert.equal((await rowsOf()).some((r) => r.source_key === "cake"), false);
  });

  console.log(`\nbeo-timeline-rows.check: ${checks} checks passed`);
} finally {
  await q("delete from core_events where id = $1", [eventId]).catch(() => {});
  await q("delete from users where id = $1", [staff]).catch(() => {});
  await q("delete from branches where id = $1", [park]).catch(() => {});
  await q("delete from tenants where id = $1", [tenant]).catch(() => {});
  await pool.end();
  await appDbPool.end().catch(() => {});
}
process.exit(0);
