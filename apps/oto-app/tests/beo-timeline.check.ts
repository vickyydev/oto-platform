// seed: none — no database, no server, no browser. Not a Playwright file.
//
// SCRUM-1027 — ONE timeline, made by the system from the stored BEO
// (shared/beoTimeline.ts), never typed twice:
//
//   1. each source alone: the party's own times (setup ready-by, guests
//      arrive, the end; an old plan's setup items at its stored offset), the
//      kids' and the adults' menus with what is served, an old event's
//      service blocks, the bar, the cake, each activity with its person, the
//      rows typed by hand (the "other timed steps");
//   2. all together, in time order; at an equal time party, food, activity,
//      other, each in the order it was made or stored;
//   3. nothing is given a time the BEO does not store (a setup task, an
//      activity with no time, a typed row on a party with no start): such a
//      step is listed with the part of the BEO that shows it;
//   4. a party with no food; an old event with only typed rows;
//   5. the same step (same minute, same words) shown once; anything less
//      shown twice; a step staff removed stays removed; a stored row's tick
//      carried over;
//   6. every reader builds it here: the PDF route and the generator that
//      stores the automatic rows (server/beo-routes.ts), the read route the
//      editor's preview, the Day-of view and the view-only BEO ask
//      (server/lib/beoTimelineRead.ts); the PDF prints what is served, the
//      person and the steps with no time.
//
// Run from apps/oto-app: npx tsx tests/beo-timeline.check.ts
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

process.env.APP_ENV ??= "dev";
process.env.STORAGE_ENV_PREFIX ??= "zz-test-1027";
process.env.OBJECT_STORAGE ??= "local";
process.env.DEPLOY_ENV ??= "local";
process.env.SESSION_SECRET ??= randomUUID() + randomUUID();
// The PDF module reads the app's config, which wants a database address; nothing here connects to one.
process.env.DATABASE_URL ??= "postgres://zz-test-1027@127.0.0.1:1/none";

const {
  buildBeoTimeline,
  beoTimedMadeSteps,
  beoClockOf,
  sameTimelineStep,
  untimedBesideTimeline,
  timelineStepLine,
  STEP_GUESTS_ARRIVE,
  STEP_PARTY_ENDS,
  STEP_SETUP_READY,
  STEP_KIDS_MENU,
  STEP_ADULTS_MENU,
  STEP_DRINKS,
  STEP_CAKE,
} = await import("../shared/beoTimeline");
const { ADULTS_SAME_AS_KIDS } = await import("../shared/kitchenAdults");
const { beoPdfHtml, beoPdfTimelineOf } = await import("../server/pdf");
type Source = import("../shared/beoTimeline").BeoTimelineSource;
type Timeline = import("../shared/beoTimeline").BeoTimeline;

const APP = fileURLToPath(new URL("../", import.meta.url));
const read = (path: string) => readFileSync(APP + path, "utf8").replace(/\r\n/g, "\n");

let checks = 0;
const failed: string[] = [];
const check = async (title: string, fn: () => Promise<void> | void) => {
  try {
    await fn();
    checks += 1;
    console.log(`  ok  ${title}`);
  } catch (error) {
    failed.push(title);
    console.log(`  FAIL  ${title}\n${error instanceof Error ? error.message : String(error)}`);
  }
};

const at = (t: Timeline) => t.steps.map((s) => [s.time, s.label] as const);
const line = (itemName: string, quantity?: unknown) => ({ id: randomUUID(), itemName, ...(quantity === undefined ? {} : { quantity }), notes: "" });
const row = (label: string, offset: number, over: Partial<{ isSystemGenerated: boolean; sourceKey: string | null; isCompleted: boolean; sortOrder: number; assignedToType: string }> = {}) => ({
  id: randomUUID(),
  label,
  offsetFromStartMinutes: offset,
  isSystemGenerated: false,
  sourceKey: null,
  isCompleted: false,
  sortOrder: 0,
  assignedToType: "PARTY_HOST",
  ...over,
});
const kitchen = (over: Record<string, unknown> = {}, menus: Record<string, unknown> = {}) => ({
  foodRequired: true,
  cakeMode: "NONE",
  cakeTime: null,
  cakeNotes: null,
  cakeQuantity: 1,
  serviceSchedule: [],
  menus: { kids: [], adults: [], adultsDiffer: false, kidsFoodTime: "", adultsFoodTime: "", ...menus },
  ...over,
});
const party: Source = { startTime: "14:00", endTime: "17:00" };

// ── 1. Each source alone ─────────────────────────────────────────────────────

await check("the party's own times: guests arrive at the start, the party ends at the end", () => {
  const t = buildBeoTimeline(party);
  assert.deepEqual(at(t), [["14:00", STEP_GUESTS_ARRIVE], ["17:00", STEP_PARTY_ENDS]]);
  assert.deepEqual(t.steps.map((s) => [s.kind, s.key, s.generated]), [["party", "guests_arrive", true], ["party", "party_end", true]]);
  assert.deepEqual(t.untimed, []);
});

await check("the setup's ready-by is always a step; its tasks, with no time stored, are listed for the setup plan", () => {
  const t = buildBeoTimeline({
    ...party,
    setupPlan: { setupRequired: true, setupTasks: { readyBy: "13:30", simplifiedTasks: [{ id: "a", itemLabel: "ZZ balloon arch", notes: "" }, { id: "b", itemLabel: "ZZ table cloths" }] } },
  });
  assert.deepEqual(at(t), [["13:30", STEP_SETUP_READY], ["14:00", STEP_GUESTS_ARRIVE], ["17:00", STEP_PARTY_ENDS]]);
  assert.deepEqual(t.untimed.map((u) => [u.label, u.home]), [["ZZ balloon arch", "setup"], ["ZZ table cloths", "setup"]], "no task is placed 30 minutes before the start");
  // A plan of before without a ready-by: its tasks are still no timed step.
  const noReady = buildBeoTimeline({ ...party, setupPlan: { setupRequired: true, setupTasks: [{ itemLabel: "ZZ chairs" }] } });
  assert.deepEqual(at(noReady), [["14:00", STEP_GUESTS_ARRIVE], ["17:00", STEP_PARTY_ENDS]]);
  // A setup not required is not on the timeline.
  assert.deepEqual(at(buildBeoTimeline({ ...party, setupPlan: { setupRequired: false, setupTasks: { readyBy: "13:30" } } })), at(buildBeoTimeline(party)));
  // A task that stores its own deadline is timed by it.
  const timedTask = buildBeoTimeline({ ...party, setupPlan: { setupRequired: true, setupTasks: { simplifiedTasks: [{ itemLabel: "ZZ banner", deadlineOffsetMin: 45 }] } } });
  assert.deepEqual(at(timedTask)[0], ["13:15", "ZZ banner"]);
});

await check("an old setup plan's items are placed at the offset the plan stores, as they always printed", () => {
  const t = buildBeoTimeline({ ...party, setupPlan: { setupRequired: true, setupTasks: [], setupItems: ["ZZ old balloons"], setupDeadlineOffsetMinutes: 20 } });
  assert.deepEqual(at(t)[0], ["13:40", "ZZ old balloons"]);
});

await check("the kids' menu at its service time with what is served; a dish with no count is one", () => {
  const t = buildBeoTimeline({ ...party, kitchenPlan: kitchen({}, { kids: [line("ZZ Margherita", 3), line("ZZ French fries"), line("ZZ Rice", "2")], kidsFoodTime: "15:00" }) });
  const kids = t.steps.find((s) => s.key === "kids_food")!;
  assert.deepEqual([kids.time, kids.label, kids.detail, kids.kind], ["15:00", STEP_KIDS_MENU, "3x ZZ Margherita, 1x ZZ French fries, 2x ZZ Rice", "food"]);
  assert.equal(t.steps.filter((s) => s.kind === "food").length, 1, "the adults eat the kids' menu at no time of their own: no second step");
});

await check("the adults' own menu at its time; the kids' menu at a time of the adults' own says so; at the same time, one step", () => {
  const own = buildBeoTimeline({ ...party, kitchenPlan: kitchen({}, { kids: [line("ZZ Margherita", 3)], adults: [line("ZZ Salmon pizza", 2)], adultsDiffer: true, kidsFoodTime: "15:00", adultsFoodTime: "15:30" }) });
  const adults = own.steps.find((s) => s.key === "adults_food")!;
  assert.deepEqual([adults.time, adults.label, adults.detail], ["15:30", STEP_ADULTS_MENU, "2x ZZ Salmon pizza"]);
  const sameMenu = buildBeoTimeline({ ...party, kitchenPlan: kitchen({}, { kids: [line("ZZ Margherita", 3)], kidsFoodTime: "15:00", adultsFoodTime: "15:30" }) });
  assert.deepEqual(sameMenu.steps.filter((s) => s.kind === "food").map((s) => [s.time, s.label, s.detail]), [["15:00", STEP_KIDS_MENU, "3x ZZ Margherita"], ["15:30", STEP_ADULTS_MENU, ADULTS_SAME_AS_KIDS]]);
  const together = buildBeoTimeline({ ...party, kitchenPlan: kitchen({}, { kids: [line("ZZ Margherita", 3)], kidsFoodTime: "15:00", adultsFoodTime: "15:00" }) });
  assert.deepEqual(together.steps.filter((s) => s.kind === "food").map((s) => s.label), [STEP_KIDS_MENU]);
  // Different for adults at the kids' time: two steps, each its own list.
  const both = buildBeoTimeline({ ...party, kitchenPlan: kitchen({}, { kids: [line("ZZ Margherita", 3)], adults: [line("ZZ Salmon pizza", 2)], adultsDiffer: true, kidsFoodTime: "15:00", adultsFoodTime: "15:00" }) });
  assert.deepEqual(both.steps.filter((s) => s.kind === "food").map((s) => [s.time, s.label]), [["15:00", STEP_KIDS_MENU], ["15:00", STEP_ADULTS_MENU]]);
});

await check("an old event's service blocks keep their time and what they serve; one with no time is given none", () => {
  const t = buildBeoTimeline({
    ...party,
    kitchenPlan: kitchen({ serviceSchedule: [
      { label: "ZZ Lunch", time: "15:15", items: [{ itemName: "ZZ Noodles", quantity: 4 }, { itemName: "ZZ Soup" }, { itemName: "ZZ Rolls", quantity: 2 }, { itemName: "ZZ Fruit", quantity: 1 }] },
      { label: "ZZ Lunch", time: "15:15", items: [] },
      { label: "ZZ Snack", items: [] },
    ] }),
  });
  assert.deepEqual(t.steps.filter((s) => s.kind === "food").map((s) => [s.time, s.label, s.detail]), [["15:15", "ZZ Lunch", "4x ZZ Noodles, 1x ZZ Soup, 2x ZZ Rolls, 1x ZZ Fruit"]], "every dish, the repeat once");
  assert.deepEqual(t.untimed.filter((u) => u.home === "kitchen").map((u) => u.label), ["ZZ Snack"], "not 15 minutes after the start");
});

await check("the bar at its service time with its drinks; the cake at its time with what it is", () => {
  const t = buildBeoTimeline({
    ...party,
    barPlan: { serviceTime: "14:30", items: [line("ZZ Mors", 2), line("ZZ Lemonade")] },
    kitchenPlan: kitchen({ cakeMode: "INTERNAL", cakeTime: "16:00", cakeQuantity: 2, cakeNotes: "ZZ mix flavour" }),
  });
  const bar = t.steps.find((s) => s.key === "bar_service")!;
  assert.deepEqual([bar.time, bar.label, bar.detail], ["14:30", STEP_DRINKS, "2x ZZ Mors, 1x ZZ Lemonade"]);
  const cake = t.steps.find((s) => s.key === "cake")!;
  assert.deepEqual([cake.time, cake.label, cake.detail], ["16:00", STEP_CAKE, "Our cake x2: ZZ mix flavour"]);
  const own = buildBeoTimeline({ ...party, kitchenPlan: kitchen({ cakeMode: "EXTERNAL", cakeTime: "16:00" }) });
  assert.equal(own.steps.find((s) => s.key === "cake")!.detail, "Own cake");
  assert.equal(buildBeoTimeline({ ...party, kitchenPlan: kitchen({ cakeMode: "NONE", cakeTime: "16:00" }) }).steps.some((s) => s.key === "cake"), false, "No Cake is no step");
  const untimedBar = buildBeoTimeline({ ...party, barPlan: { serviceTime: null, items: [line("ZZ Mors", 2)] } });
  assert.deepEqual(untimedBar.untimed.map((u) => [u.label, u.home]), [[STEP_DRINKS, "bar"]]);
});

await check("each activity with its time and its own person; one with no time is listed beside the timeline", () => {
  const t = buildBeoTimeline({
    ...party,
    activities: [
      { id: "act-1", customName: "ZZ Bubble show", startTime: "15:00", person: "ZZ Host" },
      { id: "act-2", customName: "ZZ Magic", startTime: null },
      { id: "act-3", customName: null, startTime: "16:30" },
    ],
  });
  assert.deepEqual(t.steps.filter((s) => s.kind === "activity").map((s) => [s.time, s.label, s.person, s.key]), [["15:00", "ZZ Bubble show", "ZZ Host", "entertainment::act-1"], ["16:30", "Entertainment", null, "entertainment::act-3"]]);
  assert.deepEqual(untimedBesideTimeline(t).map((u) => [u.label, u.home]), [["ZZ Magic", "entertainment"]]);
});

await check("an old event with only typed rows keeps printing them, at the start plus their offset, in time order", () => {
  const t = buildBeoTimeline({ startTime: "14:00", rows: [row("ZZ Pinata", 90, { sortOrder: 2 }), row("ZZ Welcome", 0, { sortOrder: 1 }), row("ZZ Photos", -15, { sortOrder: 3 })] });
  assert.deepEqual(at(t), [["13:45", "ZZ Photos"], ["14:00", STEP_GUESTS_ARRIVE], ["14:00", "ZZ Welcome"], ["15:30", "ZZ Pinata"]]);
  assert.ok(t.steps.filter((s) => s.kind === "other").every((s) => !s.generated && s.rowId), "the typed rows keep their stored row for an edit");
});

// ── 2. All together ──────────────────────────────────────────────────────────

await check("all together in time order; at an equal time party, food, activity, other", () => {
  const t = buildBeoTimeline({
    startTime: "15:00",
    endTime: "18:00",
    setupPlan: { setupRequired: true, setupTasks: { readyBy: "14:00", simplifiedTasks: [] } },
    kitchenPlan: kitchen({ cakeMode: "INTERNAL", cakeTime: "17:30" }, { kids: [line("ZZ Margherita", 3)], kidsFoodTime: "15:00" }),
    barPlan: { serviceTime: "15:00", items: [line("ZZ Mors", 2)] },
    activities: [{ id: "a1", customName: "ZZ Bubble show", startTime: "15:00" }, { id: "a2", customName: "ZZ Disco", startTime: "16:00" }],
    rows: [row("ZZ Pinata", 0), row("ZZ Goodbye", 165)],
  });
  assert.deepEqual(at(t), [
    ["14:00", STEP_SETUP_READY],
    ["15:00", STEP_GUESTS_ARRIVE],
    ["15:00", STEP_KIDS_MENU],
    ["15:00", STEP_DRINKS],
    ["15:00", "ZZ Bubble show"],
    ["15:00", "ZZ Pinata"],
    ["16:00", "ZZ Disco"],
    ["17:30", STEP_CAKE],
    ["17:45", "ZZ Goodbye"],
    ["18:00", STEP_PARTY_ENDS],
  ]);
  assert.deepEqual(t.steps.filter((s) => s.time === "15:00").map((s) => s.kind), ["party", "food", "food", "activity", "other"]);
});

await check("at an equal time the order is stable: activities in their stored order, typed rows in theirs", () => {
  const t = buildBeoTimeline({
    startTime: "14:00",
    activities: [{ id: "b", customName: "ZZ Second act", startTime: "15:00" }, { id: "a", customName: "ZZ First act", startTime: "15:00" }],
    rows: [row("ZZ row two", 60, { sortOrder: 2 }), row("ZZ row one", 60, { sortOrder: 1 })],
  });
  assert.deepEqual(t.steps.filter((s) => s.time === "15:00").map((s) => s.label), ["ZZ Second act", "ZZ First act", "ZZ row one", "ZZ row two"]);
});

// ── 3. No times ──────────────────────────────────────────────────────────────

await check("nothing is given a time the BEO does not store: no start, no guests arrive; typed rows listed, not placed at 14:00", () => {
  const t = buildBeoTimeline({ startTime: null, endTime: null, activities: [{ id: "x", customName: "ZZ Clown" }], rows: [row("ZZ Speech", 30)], kitchenPlan: kitchen({}, { kids: [line("ZZ Margherita", 2)] }) });
  assert.deepEqual(t.steps, []);
  assert.deepEqual(t.untimed.map((u) => [u.label, u.home]), [[STEP_KIDS_MENU, "kitchen"], ["ZZ Clown", "entertainment"], ["ZZ Speech", "timeline"]]);
  assert.deepEqual(untimedBesideTimeline(t).map((u) => u.label), ["ZZ Clown", "ZZ Speech"], "the kitchen lists its own menu");
  // A start that is no clock time is none.
  assert.deepEqual(buildBeoTimeline({ startTime: "", rows: [row("ZZ Speech", 30)] }).steps, []);
});

await check("times are the park's clock as stored: no time zone, only written as HH:MM", () => {
  assert.deepEqual(beoClockOf("9:05"), { time: "09:05", minute: 545 });
  assert.deepEqual(beoClockOf("14:00:00"), { time: "14:00", minute: 840 });
  assert.equal(beoClockOf("25:00"), null);
  assert.equal(beoClockOf("2pm"), null);
  assert.equal(beoClockOf(null), null);
  const t = buildBeoTimeline({ startTime: "9:05", kitchenPlan: kitchen({}, { kids: [line("ZZ Toast", 1)], kidsFoodTime: "09:30:00" }) });
  assert.deepEqual(at(t), [["09:05", STEP_GUESTS_ARRIVE], ["09:30", STEP_KIDS_MENU]]);
});

// ── 4. No food ───────────────────────────────────────────────────────────────

await check("a party with no food: no menu step, the bar and the cake as they are stored", () => {
  const t = buildBeoTimeline({
    ...party,
    kitchenPlan: kitchen({ foodRequired: false, cakeMode: "EXTERNAL", cakeTime: "16:00", serviceSchedule: [{ label: "ZZ Lunch", time: "15:00" }] }, { kids: [line("ZZ Margherita", 3)], kidsFoodTime: "15:00" }),
    barPlan: { serviceTime: "15:00", items: [] },
  });
  assert.deepEqual(at(t), [["14:00", STEP_GUESTS_ARRIVE], ["15:00", STEP_DRINKS], ["16:00", STEP_CAKE], ["17:00", STEP_PARTY_ENDS]]);
  assert.equal(t.steps.find((s) => s.key === "bar_service")!.detail, null, "no drinks listed: nothing said");
  assert.deepEqual(buildBeoTimeline({ ...party, kitchenPlan: null, barPlan: null }).steps.map((s) => s.key), ["guests_arrive", "party_end"]);
});

// ── 5. The same step once ────────────────────────────────────────────────────

await check("a typed row that repeats a step the system makes (same minute, same words) is shown once", () => {
  const t = buildBeoTimeline({ ...party, kitchenPlan: kitchen({ cakeMode: "INTERNAL", cakeTime: "16:00" }), rows: [row("Guests arrive", 0), row("  guests ARRIVE! ", 0), row("cake moment", 120), row("Cake", 120), row("Guests arrive", 15)] });
  assert.deepEqual(at(t), [["14:00", STEP_GUESTS_ARRIVE], ["14:15", "Guests arrive"], ["16:00", STEP_CAKE], ["16:00", "Cake"], ["17:00", STEP_PARTY_ENDS]], "other words or another minute: shown twice rather than dropped");
  assert.equal(t.steps.find((s) => s.label === STEP_GUESTS_ARRIVE && s.time === "14:00")!.generated, true, "the system's own step is the one kept");
});

await check("two typed rows that are the same step are shown once; the first stored is kept", () => {
  const first = row("ZZ Pinata", 60, { sortOrder: 1 });
  const t = buildBeoTimeline({ startTime: "14:00", rows: [row("zz pinata.", 60, { sortOrder: 2 }), first] });
  assert.deepEqual(t.steps.filter((s) => s.kind === "other").map((s) => s.rowId), [first.id]);
  assert.equal(sameTimelineStep({ minuteOfDay: 60, label: "" }, { minuteOfDay: 60, label: "" }), false, "an empty step is never 'the same'");
});

await check("a step staff removed stays removed; a stored automatic row's tick and id are carried; a stored row of a step no longer made is not shown", () => {
  const ticked = row("Guests arrive", 0, { isSystemGenerated: true, sourceKey: "guests_arrive", isCompleted: true });
  const oldTask = row("ZZ old task", -30, { isSystemGenerated: true, sourceKey: "setup_task::0" });
  const t = buildBeoTimeline({ ...party, suppressedSources: ["party_end"], rows: [ticked, oldTask] });
  assert.deepEqual(at(t), [["14:00", STEP_GUESTS_ARRIVE]]);
  assert.deepEqual([t.steps[0]!.rowId, t.steps[0]!.isCompleted], [ticked.id, true]);
  // A step made but not stored yet (a BEO not saved since): shown, with no row to tick.
  const unsaved = buildBeoTimeline({ ...party, kitchenPlan: kitchen({}, { kidsFoodTime: "15:00" }) });
  assert.equal(unsaved.steps.find((s) => s.key === "kids_food")!.rowId, null);
});

await check("the generator stores the timed steps the timeline makes, under the source keys the stored rows carry", () => {
  const made = beoTimedMadeSteps({
    ...party,
    setupPlan: { setupRequired: true, setupTasks: { readyBy: "13:30", simplifiedTasks: [{ itemLabel: "ZZ chairs" }] } },
    kitchenPlan: kitchen({ cakeMode: "INTERNAL", cakeTime: "16:00" }, { kids: [line("ZZ Margherita")], kidsFoodTime: "15:00" }),
    barPlan: { serviceTime: "14:30", items: [] },
    activities: [{ id: "a1", customName: "ZZ Show", startTime: "15:30" }, { id: "a2", customName: "ZZ Later" }],
  });
  assert.deepEqual(made.map((s) => [s.key, s.clock.time, s.label]), [
    ["setup_ready", "13:30", STEP_SETUP_READY],
    ["guests_arrive", "14:00", STEP_GUESTS_ARRIVE],
    ["party_end", "17:00", STEP_PARTY_ENDS],
    ["kids_food", "15:00", STEP_KIDS_MENU],
    ["bar_service", "14:30", STEP_DRINKS],
    ["cake", "16:00", STEP_CAKE],
    ["entertainment::a1", "15:30", "ZZ Show"],
  ]);
});

// ── 6. Every reader builds it here ───────────────────────────────────────────

const code = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
const routes = code(read("server/beo-routes.ts"));
const sliceFrom = (text: string, start: string, end: string) => {
  const from = text.indexOf(start);
  assert.ok(from >= 0, `found: ${start}`);
  const to = text.indexOf(end, from + start.length);
  return text.slice(from, to < 0 ? undefined : to);
};

await check("the generator that stores the automatic rows takes them from the timeline's own steps", () => {
  const gen = sliceFrom(routes, "export async function generateTimelineFromBeo(", "export function registerBeoRoutes(");
  assert.match(gen, /beoTimedMadeSteps\(await beoTimelineSourceOf\(event\)\)/);
  assert.doesNotMatch(gen, /sourceMap\.set\("guests_arrive"|sourceMap\.set\("setup_ready"|sourceMap\.set\("cake"/, "no second set of rules");
  assert.match(gen, /if \(suppressed\.has\(sourceKey\)\) continue;/, "a removed step stays removed");
});

await check("the PDF route prints the timeline the system makes, not the stored rows", () => {
  const pdf = sliceFrom(routes, 'app.get("/api/events/:eventId/beo/pdf"', "generateBeoPdf(pdfData)");
  assert.match(pdf, /const timeline = await readBeoTimeline\(event\);/);
  assert.match(pdf, /\.\.\.beoPdfTimelineOf\(timeline\),/);
  assert.doesNotMatch(pdf, /select\(\)\.from\(beoTimelineItems\)/, "no own read of the rows");
  assert.doesNotMatch(pdf, /offsetToTime/);
});

await check("the read route the screens ask: signed in, the event's park checked, then the timeline the system makes", () => {
  const built = sliceFrom(routes, 'app.get("/api/events/:eventId/beo/timeline/built", requireAuth,', "app.post(");
  assert.ok(built.indexOf("verifyEventAccess(eventId, req.userWithAccess)") >= 0);
  assert.ok(built.indexOf("verifyEventAccess(eventId, req.userWithAccess)") < built.indexOf("readBeoTimeline(event)"));
  const reader = code(read("server/lib/beoTimelineRead.ts"));
  assert.match(reader, /return buildBeoTimeline\(await beoTimelineSourceOf\(event, \{ rows: true, people: true \}\)\);/);
});

await check("the screens show the built timeline: the editor's preview, the Day-of view, the view-only BEO", () => {
  const list = code(read("client/src/components/beo/beo-built-timeline.tsx"));
  assert.match(list, /\["\/api\/events", eventId, "beo", "timeline", "built"\]/, "under the timeline's key: every change to its rows reads it again");
  const editor = code(read("client/src/components/beo/beo-timeline-editor.tsx"));
  assert.match(editor, /useBuiltTimeline\(eventId\)/);
  assert.match(editor, /<BeoBuiltTimelineList timeline=\{built\.data\}/);
  assert.match(editor, /\(timeline \|\| \[\]\)\.filter\(\(item\) => !item\.isSystemGenerated\)/, "the control keeps only the other timed steps");
  const form = read("client/src/components/beo/beo-event-editor.tsx");
  assert.match(form, /<span>Other timed steps<\/span>/);
  const dayOf = code(read("client/src/components/beo/beo-day-of-view.tsx"));
  assert.match(dayOf, /useBuiltTimeline\(eventId, \{ refetchInterval: 30000 \}\)/);
  assert.doesNotMatch(dayOf, /beoData\.timeline/, "the Day-of view no longer reads the stored rows as its timeline");
  const viewOnly = code(read("client/src/components/beo/beo-view-only.tsx"));
  assert.match(viewOnly, /useBuiltTimeline\(eventId\)/);
  assert.doesNotMatch(viewOnly, /\/beo\/timeline`/, "no read of the stored rows");
});

await check("the PDF prints each step with what is served and its person, in the system's order, and the steps with no time", async () => {
  const t = buildBeoTimeline({
    startTime: "14:00",
    endTime: "17:00",
    kitchenPlan: kitchen({}, { kids: [line("ZZ Margherita", 3), line("ZZ Fries")], kidsFoodTime: "14:00" }),
    activities: [{ id: "a1", customName: "ZZ Bubble show", startTime: "15:00", person: "ZZ Host" }, { id: "a2", customName: "ZZ Clown" }],
    rows: [row("ZZ Pinata", 0)],
  });
  const pdf = beoPdfTimelineOf(t);
  assert.deepEqual(pdf.timelineUntimed, [{ description: "ZZ Clown" }]);
  const html = await beoPdfHtml({ eventTitle: "ZZ TEST party", eventDate: "2099-12-05", startTime: "14:00", endTime: "17:00", status: "confirmed", ...pdf });
  const section = html.slice(html.indexOf("<h2>Timeline</h2>"));
  const order = ["Guests arrive", "menu served", "ZZ Pinata", "ZZ Bubble show", "Party ends"].map((w) => section.indexOf(w));
  assert.ok(order.every((i) => i > 0), JSON.stringify(order));
  assert.deepEqual([...order].sort((a, b) => a - b), order, "printed in the system's order");
  assert.match(section, /3x ZZ Margherita, 1x ZZ Fries/);
  assert.match(section, /· ZZ Host/);
  assert.match(section, /No time set: ZZ Clown/);
  // An old event with only typed rows still prints them.
  const old = await beoPdfHtml({ eventTitle: "ZZ TEST old", eventDate: "2099-12-05", startTime: "14:00", status: "confirmed", ...beoPdfTimelineOf(buildBeoTimeline({ startTime: "14:00", rows: [row("ZZ Speech", 60)] })) });
  assert.match(old, /15:00<\/td>\s*<td>ZZ Speech/);
  assert.equal(timelineStepLine({ label: "ZZ Show", detail: null, person: "ZZ Host" }), "ZZ Show · ZZ Host");
});

console.log(`\n${checks} checks passed${failed.length ? `, ${failed.length} failed` : ""}`);
if (failed.length) {
  console.log(failed.map((f) => `  - ${f}`).join("\n"));
  process.exit(1);
}
process.exit(0);
