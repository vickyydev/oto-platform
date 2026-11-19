// seed: none — no database, no server, no browser. Not a Playwright file.
//
// SCRUM-1032 — the people on an activity, and SCRUM-1033 — a serving time per
// dish or group, on the BEO's record, its one timeline and its Staff BEO print:
//
//   1. people: staff by name, one or several; a role with its number ("2 ×
//      Animator"); the words every reader prints; what a people body may hold
//      and what it is refused in words; an activity of before with its one
//      person, or none;
//   2. the timeline's step for an activity carries all its people; the print's
//      Entertainment part prints them and the activity's note;
//   3. serving times: a dish's own time, a group's time (its dishes share it),
//      no time (served at its menu's time, as before), a time equal to the
//      menu's (no second step); the editor's change of one line; what a Save
//      may hold;
//   4. the timeline makes one short food step at each other time, named by
//      its groups, for the kids', the adults' own and the bar's lists;
//   5. the print shows the time beside the dish, or its group with its time;
//   6. app migration 0055 expand only; nothing of either reaches the till: no
//      view the till reads names them and no platform file does.
//
// Run from apps/oto-app: npx tsx tests/beo-activities-times.check.ts
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

process.env.APP_ENV ??= "dev";
process.env.STORAGE_ENV_PREFIX ??= "zz-test-1032";
process.env.OBJECT_STORAGE ??= "local";
process.env.DEPLOY_ENV ??= "local";
process.env.SESSION_SECRET ??= randomUUID() + randomUUID();
// The PDF module reads the app's config, which wants a database address; nothing here connects to one.
process.env.DATABASE_URL ??= "postgres://zz-test-1032@127.0.0.1:1/none";

const people = await import("../shared/beoActivityPeople");
const serving = await import("../shared/beoServingTimes");
const { buildBeoTimeline, beoTimedMadeSteps, timelineStepLine, STEP_KIDS_MENU, STEP_ADULTS_MENU, STEP_DRINKS } = await import("../shared/beoTimeline");
const { beoPdfHtml, beoPdfTimelineOf } = await import("../server/pdf");
const { normalParty } = await import("./fixtures/beo-staff-print");
type PdfData = import("../server/pdf").BeoPdfData;

const APP = fileURLToPath(new URL("../", import.meta.url));
const REPO = join(APP, "..", "..");
const read = (path: string) => readFileSync(join(APP, path), "utf8").replace(/\r\n/g, "\n");

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

const party = { startTime: "11:00", endTime: "14:00" };
const line = (itemName: string, over: Record<string, unknown> = {}) => ({ id: randomUUID(), itemName, quantity: 1, notes: "", ...over });
const kitchen = (menus: Record<string, unknown>) => ({
  foodRequired: true,
  cakeMode: "NONE",
  serviceSchedule: [],
  menus: { kids: [], adults: [], adultsDiffer: false, kidsFoodTime: "11:30", adultsFoodTime: "", ...menus },
});
const pdf = (over: Partial<PdfData>) => beoPdfHtml({ eventTitle: "ZZ TEST 1032 party", eventDate: "2099-12-05", startTime: "11:00", endTime: "14:00", status: "confirmed", ...over });
/** The text of one part of the print. */
const part = (html: string, name: string) => {
  const from = html.indexOf(`data-part="${name}"`);
  assert.ok(from > 0, `the print has its ${name} part`);
  const to = html.indexOf('data-part="', from + 12);
  return html.slice(from, to < 0 ? undefined : to);
};

// ── 1. People ────────────────────────────────────────────────────────────────

await check("a person in the words every reader prints: a name; a role with its number first; a role of before with none", () => {
  assert.equal(people.activityPersonWords({ type: "employee", label: "ZZ Nok" }), "ZZ Nok");
  assert.equal(people.activityPersonWords({ type: "role", label: "ZZ Animator", count: 2 }), "2 × ZZ Animator");
  assert.equal(people.activityPersonWords({ type: "role", label: "ZZ Host", count: 1 }), "1 × ZZ Host", "the brief's \"1 host\"");
  assert.equal(people.activityPersonWords({ type: "role", label: "ZZ Host", count: null }), "ZZ Host", "a role stored with no number: its name, nothing invented");
  assert.equal(people.activityPeopleWords([{ type: "employee", label: "ZZ Nok" }, { type: "employee", label: "ZZ Ploy" }, { type: "role", label: "ZZ Animator", count: 2 }]), "ZZ Nok, ZZ Ploy, 2 × ZZ Animator");
  assert.equal(people.activityPeopleWords([]), "");
  assert.equal(people.activityPeopleWords(null), "");
});

await check("a people body: one person, several, a role with its number, the person of before kept; in their order", () => {
  const one = people.activityPeopleOfBody({ people: [{ type: "employee", id: "e1" }] });
  assert.deepEqual(one, { ok: true, people: [{ type: "employee", id: "e1", count: null }] });
  const several = people.activityPeopleOfBody({ people: [
    { type: "kept", id: "t-old" },
    { type: "employee", id: "e1" },
    { type: "user", id: "u1" },
    { type: "role", id: "r1", count: 2 },
    { type: "department", id: "d1" },
  ] });
  assert.ok(several.ok);
  assert.deepEqual(several.people.map((p) => [p.type, p.id, "count" in p ? p.count : undefined]), [["kept", "t-old", undefined], ["employee", "e1", null], ["user", "u1", null], ["role", "r1", 2], ["department", "d1", null]]);
  assert.deepEqual(people.activityPeopleOfBody({ people: [] }), { ok: true, people: [] }, "nobody: the activity names no one");
  assert.deepEqual(people.activityPeopleOfBody({ people: [{ type: "role", id: "r1" }] }), { ok: true, people: [{ type: "role", id: "r1", count: null }] });
});

await check("a people body the activity cannot store is refused in words", () => {
  const refused = (body: unknown) => {
    const r = people.activityPeopleOfBody(body);
    assert.equal(r.ok, false, JSON.stringify(body));
    return r.ok ? "" : r.reason;
  };
  assert.match(refused({}), /must be a list/);
  assert.match(refused({ people: "ZZ Nok" }), /must be a list/);
  assert.match(refused({ people: [{ type: "employee" }] }), /name who it is/);
  assert.match(refused({ people: [{ type: "vendor", id: "x" }] }), /member of staff or a role/);
  assert.match(refused({ people: [{ type: "role", id: "r1", count: 0 }] }), /whole number from 1 to 99/);
  assert.match(refused({ people: [{ type: "role", id: "r1", count: 2.5 }] }), /whole number from 1 to 99/);
  assert.match(refused({ people: [{ type: "role", id: "r1", count: 100 }] }), /whole number from 1 to 99/);
  assert.match(refused({ people: [{ type: "employee", id: "e1", count: 2 }] }), /Only a role carries a number/);
  assert.match(refused({ people: [{ type: "employee", id: "e1" }, { type: "employee", id: "e1" }] }), /named twice/);
  assert.match(refused({ people: Array.from({ length: 21 }, (_, i) => ({ type: "employee", id: `e${i}` })) }), /at most 20 people/);
});

// ── 2. The timeline's step and the print's Entertainment ─────────────────────

const acts = [
  { id: "a-several", customName: "ZZ Bubble show", startTime: "12:00", people: ["ZZ Nok", "ZZ Ploy (left)", "2 × ZZ Animator"], person: "ZZ Nok, ZZ Ploy (left), 2 × ZZ Animator", notes: "ZZ bring the bubble machine; outdoor area ถ้าฝนไม่ตก" },
  { id: "a-role", customName: "ZZ Treasure hunt", startTime: "13:00", people: ["1 × ZZ Host"], person: "1 × ZZ Host", notes: null },
  { id: "a-old", customName: "ZZ Magic", startTime: "13:30", person: "ZZ TEST Host Noi" },
  { id: "a-none", customName: "ZZ Disco", startTime: null, people: [], person: null },
];

await check("the timeline's step for an activity carries all its people, in their order; an activity of before its one person; none, nobody", () => {
  const t = buildBeoTimeline({ ...party, activities: acts });
  const step = (key: string) => t.steps.find((s) => s.key === key)!;
  assert.deepEqual(step("entertainment::a-several").people, ["ZZ Nok", "ZZ Ploy (left)", "2 × ZZ Animator"]);
  assert.equal(step("entertainment::a-several").person, "ZZ Nok, ZZ Ploy (left), 2 × ZZ Animator");
  assert.deepEqual([step("entertainment::a-role").people, step("entertainment::a-role").person], [["1 × ZZ Host"], "1 × ZZ Host"]);
  assert.deepEqual([step("entertainment::a-old").people, step("entertainment::a-old").person], [["ZZ TEST Host Noi"], "ZZ TEST Host Noi"], "an activity of before: its one person, as it printed");
  const none = t.untimed.find((u) => u.key === "entertainment::a-none")!;
  assert.deepEqual([none.people, none.person], [[], null]);
  assert.equal(timelineStepLine(step("entertainment::a-several")), "ZZ Bubble show · ZZ Nok, ZZ Ploy (left), 2 × ZZ Animator");
  // The other steps carry no people.
  assert.ok(t.steps.filter((s) => s.kind !== "activity").every((s) => s.people.length === 0 && s.person === null));
});

await check("the print: the timeline names the activity's people; Entertainment prints them and the activity's note under its name", async () => {
  const html = await pdf({ entertainmentActs: acts, ...beoPdfTimelineOf(buildBeoTimeline({ ...party, activities: acts })) });
  const timeline = part(html, "timeline");
  assert.match(timeline, /ZZ Bubble show <span class="item-note">· ZZ Nok, ZZ Ploy \(left\), 2 × ZZ Animator<\/span>/);
  const ent = part(html, "entertainment");
  assert.match(ent, /ZZ Bubble show<div class="act-note" data-act-note>ZZ bring the bubble machine; outdoor area ถ้าฝนไม่ตก<\/div><\/td>\s*<td data-act-people>ZZ Nok, ZZ Ploy \(left\), 2 × ZZ Animator<\/td>/);
  assert.match(ent, /ZZ Treasure hunt<\/td>\s*<td data-act-people>1 × ZZ Host<\/td>/, "a role with its number; no note: nothing under the name");
  assert.match(ent, /ZZ Magic<\/td>\s*<td data-act-people>ZZ TEST Host Noi<\/td>/, "an activity of before prints its one person");
  assert.match(ent, /No time set<\/span><\/td>\s*<td>ZZ Disco<\/td>\s*<td data-act-people><\/td>/, "nobody named: an empty cell");
  assert.equal((ent.match(/data-act-note/g) ?? []).length, 1);
});

await check("the print: no activity names anyone, no people's column (as before); the fixture party of before prints as it did", async () => {
  const html = await pdf({ entertainmentActs: [{ id: "x", customName: "ZZ Clown", startTime: "12:00", person: null }] });
  assert.doesNotMatch(part(html, "entertainment"), /data-act-people|<col style="width: 34%;" \/>/);
  const older = part(await beoPdfHtml(normalParty), "entertainment");
  assert.match(older, /ZZ TEST Bubble show<\/td>\s*<td data-act-people>ZZ TEST Host Noi<\/td>/);
  assert.doesNotMatch(older, /data-act-note/);
});

// ── 3. Serving times ─────────────────────────────────────────────────────────

await check("a dish's own time, a group's time, no time, a time equal to its menu's: what is shown beside the dish", () => {
  assert.equal(serving.lineServingOf(line("ZZ Fries")), null, "no time: served with the menu, as before");
  assert.equal(serving.lineServingTagOf(line("ZZ Fries"), "11:30"), null);
  assert.deepEqual(serving.lineServingOf(line("ZZ Skewers", { serviceTime: "13:00" })), { time: "13:00", minute: 780, group: null });
  assert.equal(serving.lineServingTagOf(line("ZZ Skewers", { serviceTime: "13:00" }), "11:30"), "13:00");
  assert.equal(serving.lineServingTagOf(line("ZZ Waffles", { serviceTime: "13:00", serviceGroup: " ZZ  Dessert " }), "11:30"), "ZZ Dessert · 13:00");
  assert.equal(serving.lineServingTagOf(line("ZZ Pizza", { serviceTime: "11:30" }), "11:30"), null, "its menu's time: nothing beside it");
  assert.equal(serving.lineServingTagOf(line("ZZ Pizza", { serviceTime: "11:30:00", serviceGroup: "ZZ Mains" }), "11:30"), "ZZ Mains · 11:30", "a named group says its name");
  assert.equal(serving.lineServingOf(line("ZZ Odd", { serviceTime: "soon" })), null, "no clock time is none");
  assert.equal(serving.lineServingOf(line("ZZ Odd", { serviceGroup: "ZZ Dessert" })), null, "a group with no time is none");
});

await check("one list's serving times other than its menu's: each time once, in clock order, with its groups' names", () => {
  const lines = [
    line("ZZ Pizza"),
    line("ZZ Skewers", { serviceTime: "13:00", serviceGroup: "ZZ Dessert" }),
    line("ZZ Waffles", { serviceTime: "13:00", serviceGroup: "zz dessert" }),
    line("ZZ Juice", { serviceTime: "12:15" }),
    line("ZZ Fries", { serviceTime: "11:30" }),
    line("ZZ Cupcakes", { serviceTime: "13:00", serviceGroup: "ZZ Treats" }),
  ];
  assert.deepEqual(serving.servingTimesOf(lines, "11:30"), [
    { time: "12:15", minute: 735, groups: [] },
    { time: "13:00", minute: 780, groups: ["ZZ Dessert", "ZZ Treats"] },
  ]);
  assert.deepEqual(serving.servingTimesOf(lines, ""), [
    { time: "11:30", minute: 690, groups: [] },
    { time: "12:15", minute: 735, groups: [] },
    { time: "13:00", minute: 780, groups: ["ZZ Dessert", "ZZ Treats"] },
  ], "a menu with no time of its own: every time a dish stores");
  assert.deepEqual(serving.servingGroupsOf(lines), [{ name: "ZZ Dessert", time: "13:00" }, { name: "ZZ Treats", time: "13:00" }]);
});

await check("the editor's change of one line: a time, a group whose dishes follow its time, cleared; the others untouched", () => {
  const lines = [line("ZZ Skewers", { serviceTime: "13:00", serviceGroup: "ZZ Dessert" }), line("ZZ Waffles"), line("ZZ Fries")];
  const timed = serving.withLineServing(lines, 2, { time: "12:00", group: "" });
  assert.deepEqual([timed[2]!.serviceTime, "serviceGroup" in timed[2]!], ["12:00", false]);
  assert.equal(timed[0], lines[0], "another line is the same object");
  assert.equal(timed[1], lines[1]);
  const joined = serving.withLineServing(lines, 1, { time: "13:15", group: "zz dessert" });
  assert.deepEqual([joined[1]!.serviceTime, joined[1]!.serviceGroup], ["13:15", "zz dessert"]);
  assert.equal(joined[0]!.serviceTime, "13:15", "the group's other dish follows its one time");
  assert.equal(joined[0]!.serviceGroup, "ZZ Dessert", "and keeps its own spelling");
  const cleared = serving.withLineServing(joined, 0, { time: "", group: "ZZ Dessert" });
  assert.deepEqual(["serviceTime" in cleared[0]!, "serviceGroup" in cleared[0]!], [false, false], "cleared: served with the menu again, out of its group");
  assert.equal(cleared[1]!.serviceTime, "13:15", "the group's other dish keeps its time");
  assert.deepEqual(serving.servingKeysOf(line("ZZ Before")), {}, "a line of before is held with no new key");
  assert.deepEqual(serving.servingKeysOf(line("ZZ Timed", { serviceTime: "9:05", serviceGroup: "" })), { serviceTime: "09:05" });
});

await check("what a Save's dishes and drinks may hold: every line of before; a time of day; a short group name with its time", () => {
  assert.equal(serving.servingRefusal([[line("ZZ Pizza"), { itemName: "ZZ odd shape" }, "not a line", null], undefined, null]), null);
  assert.equal(serving.servingRefusal([[line("ZZ Pizza", { serviceTime: "", serviceGroup: "" })]]), null, "empty is none");
  assert.equal(serving.servingRefusal([[line("ZZ Pizza", { serviceTime: "13:00", serviceGroup: "ZZ Dessert" })]]), null);
  assert.equal(serving.servingRefusal([[line("ZZ Pizza", { serviceTime: "25:00" })]]), "ZZ Pizza: its serving time must be a time of day (HH:MM), or empty.");
  assert.equal(serving.servingRefusal([[], [line("ZZ Mors", { serviceTime: 1300 })]]), "ZZ Mors: its serving time must be a time of day (HH:MM), or empty.");
  assert.equal(serving.servingRefusal([[line("ZZ Pizza", { serviceGroup: "ZZ Dessert" })]]), "ZZ Pizza: a serving group needs its time.");
  assert.equal(serving.servingRefusal([[line("ZZ Pizza", { serviceTime: "13:00", serviceGroup: "x".repeat(61) })]]), "ZZ Pizza: its serving group must be a short name of at most 60 characters.");
  assert.equal(serving.servingRefusal([[{ itemName: "", serviceTime: "x" }]]), "A dish: its serving time must be a time of day (HH:MM), or empty.");
});

// ── 4. The timeline ──────────────────────────────────────────────────────────

await check("a dish's own time is a short food step at that time; a group's time says the group; no time and the menu's time make none", () => {
  const t = buildBeoTimeline({
    ...party,
    kitchenPlan: kitchen({ kids: [
      line("ZZ Pizza"),
      line("ZZ Fries", { serviceTime: "11:30" }),
      line("ZZ Juice", { serviceTime: "12:15" }),
      line("ZZ Skewers", { serviceTime: "13:00", serviceGroup: "ZZ Dessert" }),
      line("ZZ Waffles", { serviceTime: "13:00", serviceGroup: "ZZ Dessert" }),
    ] }),
  });
  const food = t.steps.filter((s) => s.kind === "food").map((s) => [s.key, s.time, s.label, s.detail]);
  assert.deepEqual(food, [
    ["kids_food", "11:30", STEP_KIDS_MENU, null],
    ["kids_food::12:15", "12:15", STEP_KIDS_MENU, null],
    ["kids_food::13:00", "13:00", STEP_KIDS_MENU, "ZZ Dessert"],
  ], "one step at each other time; no dish named; the menu's own time once");
  assert.equal(timelineStepLine(t.steps.find((s) => s.key === "kids_food::13:00")!), `${STEP_KIDS_MENU}: ZZ Dessert`);
  const plain = buildBeoTimeline({ ...party, kitchenPlan: kitchen({ kids: [line("ZZ Pizza"), line("ZZ Fries")] }) });
  assert.deepEqual(plain.steps.filter((s) => s.kind === "food").map((s) => s.key), ["kids_food"], "no time of their own: as before");
});

await check("the adults' own list and the bar make their own steps; the kids' times are not the adults' when they eat the kids' menu", () => {
  const own = buildBeoTimeline({
    ...party,
    kitchenPlan: kitchen({ kids: [line("ZZ Pizza")], adults: [line("ZZ Salmon", { serviceTime: "12:45", serviceGroup: "ZZ Starters" }), line("ZZ Salad", { serviceTime: "12:15" })], adultsDiffer: true, adultsFoodTime: "12:15" }),
    barPlan: { serviceTime: "11:30", items: [line("ZZ Mors"), line("ZZ Coffee", { serviceTime: "13:30", serviceGroup: "ZZ Coffee & tea" })] },
  });
  assert.deepEqual(own.steps.filter((s) => s.kind === "food").map((s) => [s.key, s.time, s.label, s.detail]), [
    ["kids_food", "11:30", STEP_KIDS_MENU, null],
    ["bar_service", "11:30", STEP_DRINKS, null],
    ["adults_food", "12:15", STEP_ADULTS_MENU, null],
    ["adults_food::12:45", "12:45", STEP_ADULTS_MENU, "ZZ Starters"],
    ["bar_service::13:30", "13:30", STEP_DRINKS, "ZZ Coffee & tea"],
  ]);
  const same = buildBeoTimeline({ ...party, kitchenPlan: kitchen({ kids: [line("ZZ Pizza"), line("ZZ Skewers", { serviceTime: "13:00" })], adults: [], adultsDiffer: false, adultsFoodTime: "11:30" }) });
  assert.deepEqual(same.steps.filter((s) => s.kind === "food").map((s) => s.key), ["kids_food", "kids_food::13:00"], "Same as kids: no adults' step of the kids' dish");
  const noFood = buildBeoTimeline({ ...party, kitchenPlan: { ...kitchen({ kids: [line("ZZ Skewers", { serviceTime: "13:00" })] }), foodRequired: false } });
  assert.equal(noFood.steps.some((s) => s.key.startsWith("kids_food")), false, "No food for this party: no food step, as before");
});

await check("the generator stores each serving time's step under its own key; a time with no menu time of its own is still a step", () => {
  const made = beoTimedMadeSteps({ ...party, kitchenPlan: kitchen({ kidsFoodTime: "", kids: [line("ZZ Pizza"), line("ZZ Skewers", { serviceTime: "13:00" })] }) });
  assert.deepEqual(made.filter((s) => s.kind === "food").map((s) => [s.key, s.clock.time, s.assignedToType]), [["kids_food::13:00", "13:00", "KITCHEN_RESPONSIBLE"]]);
  const t = buildBeoTimeline({ ...party, kitchenPlan: kitchen({ kidsFoodTime: "", kids: [line("ZZ Pizza"), line("ZZ Skewers", { serviceTime: "13:00" })] }) });
  assert.deepEqual(t.untimed.map((u) => [u.key, u.home]), [["kids_food", "kitchen"]], "the menu's own step still has no time: none is invented");
});

// ── 5. The print ─────────────────────────────────────────────────────────────

await check("the print's Kitchen and Bar: the time beside the dish, or its group with its time; nothing beside a dish served with its menu", async () => {
  const kids = [
    { ...line("ZZ Pizza", { quantity: 3 }), source: "set_menu", groupId: "g-pizza", notes: "(ZZ Pizza 1)" },
    { ...line("ZZ Fries", { quantity: 2, serviceTime: "11:30" }), source: "additional", price: 80 },
    { ...line("ZZ Skewers", { quantity: 2, serviceTime: "13:00", serviceGroup: "ZZ Dessert" }), source: "additional", price: 120 },
    { ...line("ZZ Juice", { serviceTime: "12:15" }), source: "additional", price: 60 },
  ];
  const adults = [{ ...line("ZZ Salmon", { quantity: 2, serviceTime: "12:45" }), source: "additional", price: 450 }];
  const bar = { serviceTime: "11:30", items: [{ ...line("ZZ Mors", { quantity: 2 }), source: "set_menu" }, { ...line("ZZ Coffee", { quantity: 4, serviceTime: "13:30", serviceGroup: "ZZ Coffee & tea" }), price: 70 }] };
  const html = await pdf({
    numChildren: 10,
    kitchenPlan: { required: true, setMenuEnabled: true, setMenuTemplateName: "ZZ Set", menus: { kids, adults, adultsDiffer: true, kidsFoodTime: "11:30", adultsFoodTime: "12:15" } as never },
    barPlan: bar as never,
  });
  const k = part(html, "kitchen");
  assert.match(k, /ZZ Skewers <span class="at" data-serving>ZZ Dessert · 13:00<\/span>/);
  assert.match(k, /ZZ Juice <span class="at" data-serving>12:15<\/span>/);
  assert.match(k, /ZZ Salmon <span class="at" data-serving>12:45<\/span>/, "the adults' own list beside its own menu's time");
  assert.doesNotMatch(k, /ZZ Fries <span class="at"/, "its menu's own time: nothing beside it");
  assert.doesNotMatch(k, /ZZ Pizza \(ZZ Pizza 1\) <span class="at"/, "no time of its own: as before");
  assert.equal((k.match(/data-serving/g) ?? []).length, 3);
  const b = part(html, "bar");
  assert.match(b, /ZZ Coffee <span class="at" data-serving>ZZ Coffee (&|&amp;) tea · 13:30<\/span>/);
  assert.equal((b.match(/data-serving/g) ?? []).length, 1);
  // The fixture party of before prints no time beside any dish.
  assert.doesNotMatch(await beoPdfHtml(normalParty), /data-serving/);
});

// ── 6. Stored, and nothing to the till ───────────────────────────────────────

await check("app migration 0055 is expand only: the new kind, four columns, their keys and index, one check; snapshot chained to 0054", () => {
  const journal = JSON.parse(read("migrations/meta/_journal.json")) as { entries: { idx: number; tag: string; when: number }[] };
  const entry = journal.entries.find((e) => e.tag === "0055_otoapp_beo_activity_people");
  assert.ok(entry && entry.idx === 55, "journalled as 55");
  assert.ok(entry.when > journal.entries.find((e) => e.idx === 54)!.when);
  const sql = read("migrations/0055_otoapp_beo_activity_people.sql");
  const statements = sql.split("--> statement-breakpoint").map((x) => x.replace(/^--.*$/gm, "").trim()).filter(Boolean);
  assert.deepEqual(statements.map((x) => x.split(" ").slice(0, 3).join(" ")), [
    "ALTER TYPE \"beo_assignment_target_type\"",
    "ALTER TABLE \"beo_assignment_targets\"",
    "ALTER TABLE \"beo_assignment_targets\"",
    "ALTER TABLE \"beo_assignment_targets\"",
    "ALTER TABLE \"beo_assignment_targets\"",
    "ALTER TABLE \"beo_assignment_targets\"",
    "ALTER TABLE \"beo_assignment_targets\"",
    "CREATE INDEX \"idx_beo_assignment_targets_entertainment_item\"",
    "ALTER TABLE \"beo_assignment_targets\"",
  ]);
  assert.match(statements[0]!, /ADD VALUE 'EMPLOYEE';$/);
  // ("ON DELETE cascade" is the activity's own targets going with it; no row is deleted here.)
  assert.doesNotMatch(statements.join("\n"), /\bDROP\b|\bRENAME\b|ALTER COLUMN|SET DATA TYPE|DELETE FROM|\bUPDATE "|TRUNCATE|"public"\./i);
  assert.equal((sql.match(/ADD COLUMN/g) ?? []).length, 4);
  assert.match(sql, /ADD COLUMN "sort_order" integer DEFAULT 0 NOT NULL/, "the one NOT NULL column has a default every row takes");
  assert.equal((sql.match(/NOT NULL/g) ?? []).length, 1);
  assert.match(sql, /"head_count" IS NULL OR/, "the check passes every existing row (no number stored)");
  const prev = JSON.parse(read("migrations/meta/0054_snapshot.json")) as { id: string };
  const snap = JSON.parse(read("migrations/meta/0055_snapshot.json")) as { prevId: string; enums: Record<string, { values: string[] }>; tables: Record<string, { columns: Record<string, { notNull: boolean }> }> };
  assert.equal(snap.prevId, prev.id);
  assert.deepEqual(snap.enums["public.beo_assignment_target_type"]!.values, ["DEPARTMENT", "ROLE", "USER", "EMPLOYEE"]);
  const cols = snap.tables["public.beo_assignment_targets"]!.columns;
  assert.deepEqual(["employee_id", "head_count", "entertainment_item_id"].map((c) => cols[c]!.notNull), [false, false, false]);
});

const sourcesUnder = (dir: string): string[] => {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist" || name.startsWith(".")) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...sourcesUnder(path));
    else if (/\.(ts|tsx|sql|mjs|js)$/.test(name)) out.push(path);
  }
  return out;
};

await check("nothing of either reaches the till: no view the till reads names them; no file of the platform does", () => {
  const views = readdirSync(join(APP, "migrations")).filter((f) => f.endsWith(".sql") && /otoapp_v|CREATE (OR REPLACE )?VIEW/i.test(read(`migrations/${f}`)));
  assert.ok(views.length > 0, "the till's views are read");
  for (const f of views) {
    assert.doesNotMatch(read(`migrations/${f}`), /serviceTime'|serviceGroup|head_count|entertainment_item_id|beo_assignment_targets|beo_entertainment_items/, f);
  }
  const hits: string[] = [];
  for (const root of ["apps/api/src", "apps/pos/src", "packages"]) {
    for (const path of sourcesUnder(join(REPO, root))) {
      if (/serviceGroup|head_count|entertainment_item_id|beoServingTimes|beoActivityPeople/.test(readFileSync(path, "utf8"))) hits.push(path.slice(REPO.length));
    }
  }
  assert.deepEqual(hits, []);
});

await check("the editor reads and saves a line's serving keys only when it stores them; an activity's people go to their own route", () => {
  const editor = read("client/src/components/beo/beo-event-editor.tsx");
  assert.equal(editor.split("...servingKeysOf(m),").length - 1, 2, "the kitchen's lines and the bar's");
  assert.match(editor, /apiRequest\("PUT", `\/api\/events\/\$\{eventId\}\/beo\/entertainment-items\/\$\{id\}\/people`, \{ people \}\)/);
  const routes = read("server/beo-routes.ts");
  const save = routes.slice(routes.indexOf('app.put("/api/events/:eventId/beo", requireAuth, requireManager,'));
  assert.ok(save.indexOf("servingRefusal([") > 0 && save.indexOf("servingRefusal([") < save.indexOf("db.transaction("), "refused before anything is written");
  const peopleRoute = routes.slice(routes.indexOf('app.put("/api/events/:eventId/beo/entertainment-items/:id/people"'));
  assert.ok(peopleRoute.indexOf("verifyEventAccess(eventId, req.userWithAccess)") < peopleRoute.indexOf("writeActivityPeople("), "the event's own access first");
});

console.log(`\n${checks} checks passed${failed.length ? `, ${failed.length} failed` : ""}`);
if (failed.length) {
  console.log(failed.map((f) => `  - ${f}`).join("\n"));
  process.exit(1);
}
process.exit(0);
