// seed: none — no database, no server, no browser. Not a Playwright file.
//
// SCRUM-1030, SCRUM-1031, SCRUM-1042 — the BEO's new fields, read off the code
// and the shared rules (the editor's half is tests/beo-four-sections-ui.check.ts,
// the print's tests/beo-print-fields.check.ts; the stored columns on a migrated
// database are tests/beo-guests-socks-db.check.ts):
//
//   1. the expected extra guests and the socks arrangement in the brief's words;
//      what a Save may store, and the refusal in words for anything else;
//   2. they are stored on the party by app migration 0054, expand only, and
//      named by nothing the till reads: no view of the app's, no file of the
//      platform; the Save checks them before it writes anything; the print
//      route hands them to the print;
//   3. the Kitchen Notes are the kitchen plan's own column, written by the
//      BEO's Save only when its body names them;
//   4. "Adult Waffles": which line reads so, and nothing else.
//
// Run from apps/oto-app: npx tsx tests/beo-guests-socks.check.ts
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

process.env.APP_ENV ??= "dev";
process.env.STORAGE_ENV_PREFIX ??= "zz-test-1031";
process.env.OBJECT_STORAGE ??= "local";
process.env.DEPLOY_ENV ??= "local";
process.env.SESSION_SECRET ??= randomUUID() + randomUUID();
// The routes' module reads the app's config, which wants a database address; nothing here connects to one.
process.env.DATABASE_URL ??= "postgres://zz-test-1031@127.0.0.1:1/none";

const { expectedExtraWordsOf, socksWordsOf, guestsSocksRefusal, SOCKS_ARRANGEMENTS, SOCKS_ARRANGEMENT_LABELS } = await import("../shared/beoGuestsSocks");
const { BEO_ADULT_WAFFLES, beoDishNameOf, isPackageWafflesLine } = await import("../shared/beoAdultWaffles");
const { kitchenPlanDbDataOf } = await import("../server/beo-routes");

const APP = fileURLToPath(new URL("../", import.meta.url));
const REPO = join(APP, "..", "..");
const read = (path: string) => readFileSync(join(APP, path), "utf8").replace(/\r\n/g, "\n");
const code = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

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

// ── 1. The words and what a Save may store ───────────────────────────────────

await check("the expected extra guests in the brief's words; only counts above nought are said", () => {
  assert.equal(expectedExtraWordsOf({ expectedExtraKids: 1, expectedExtraAdults: 6 }), "+1 child · +6 adults");
  assert.equal(expectedExtraWordsOf({ expectedExtraKids: 2, expectedExtraAdults: 1 }), "+2 children · +1 adult");
  assert.equal(expectedExtraWordsOf({ expectedExtraAdults: 3 }), "+3 adults");
  for (const none of [{}, { expectedExtraKids: 0, expectedExtraAdults: 0 }, { expectedExtraKids: null }, null, undefined]) {
    assert.equal(expectedExtraWordsOf(none as never), null, JSON.stringify(none));
  }
});

await check("the socks arrangement: the brief's three options in its order and words; none chosen says nothing", () => {
  assert.deepEqual(SOCKS_ARRANGEMENTS.map((a) => SOCKS_ARRANGEMENT_LABELS[a]), ["Birthday Parent Pays", "Guests Pay Individually", "Other / Custom"]);
  assert.equal(socksWordsOf({ socksArrangement: "birthday_parent" }), "Birthday Parent Pays");
  assert.equal(socksWordsOf({ socksArrangement: "other", socksNote: "  ZZ TEST the school pays  " }), "Other / Custom: ZZ TEST the school pays");
  assert.equal(socksWordsOf({ socksArrangement: "other", socksNote: "   " }), "Other / Custom");
  assert.equal(socksWordsOf({ socksArrangement: "guests", socksNote: "ZZ TEST stray" }), "Guests Pay Individually", "the note is Other's");
  for (const none of [null, undefined, "", "pay_at_reception"]) assert.equal(socksWordsOf({ socksArrangement: none }), null, String(none));
});

await check("what a Save may store: counts 0 to 999 or empty, one of the options or none, a short note; anything else refused in words", () => {
  assert.equal(guestsSocksRefusal(undefined), null);
  assert.equal(guestsSocksRefusal({ title: "ZZ TEST" }), null, "a Save that names none of them is not asked");
  assert.equal(guestsSocksRefusal({ expectedExtraKids: 0, expectedExtraAdults: 999, socksArrangement: "other", socksNote: "ZZ TEST" }), null);
  assert.equal(guestsSocksRefusal({ expectedExtraKids: null, expectedExtraAdults: null, socksArrangement: null, socksNote: null }), null);
  for (const bad of [-1, 1.5, 1000, "2", true]) {
    assert.match(guestsSocksRefusal({ expectedExtraKids: bad }) ?? "", /^The expected extra children must be a whole number from 0 to 999, or empty\.$/, String(bad));
  }
  assert.match(guestsSocksRefusal({ expectedExtraAdults: -2 }) ?? "", /expected extra adults/);
  assert.equal(guestsSocksRefusal({ socksArrangement: "pay_at_reception" }), "The socks arrangement must be one of: Birthday Parent Pays, Guests Pay Individually, Other / Custom; or not set.");
  assert.match(guestsSocksRefusal({ socksNote: "x".repeat(201) }) ?? "", /at most 200 characters/);
  assert.match(guestsSocksRefusal({ socksNote: 5 }) ?? "", /short text/);
});

// ── 2. Where they are stored, and that the till never reads them ─────────────

await check("app migration 0054 adds four nullable columns and two checks every existing row passes; nothing else", () => {
  const journal = JSON.parse(read("migrations/meta/_journal.json")) as { entries: { idx: number; tag: string }[] };
  const entry = journal.entries.find((e) => e.tag === "0054_otoapp_beo_extra_guests_socks");
  assert.ok(entry && entry.idx === 54, "journalled as 54");
  const sql = read("migrations/0054_otoapp_beo_extra_guests_socks.sql");
  const statements = sql.split("--> statement-breakpoint").map((s) => s.replace(/--.*$/gm, "").replace(/\s+/g, " ").trim()).filter(Boolean);
  assert.deepEqual(statements, [
    'ALTER TABLE "core_events" ADD COLUMN "expected_extra_kids" integer;',
    'ALTER TABLE "core_events" ADD COLUMN "expected_extra_adults" integer;',
    'ALTER TABLE "core_events" ADD COLUMN "socks_arrangement" text;',
    'ALTER TABLE "core_events" ADD COLUMN "socks_note" text;',
    'ALTER TABLE "core_events" ADD CONSTRAINT "core_events_expected_extra_check" CHECK (("core_events"."expected_extra_kids" IS NULL OR "core_events"."expected_extra_kids" >= 0) AND ("core_events"."expected_extra_adults" IS NULL OR "core_events"."expected_extra_adults" >= 0));',
    'ALTER TABLE "core_events" ADD CONSTRAINT "core_events_socks_arrangement_check" CHECK ("core_events"."socks_arrangement" IS NULL OR "core_events"."socks_arrangement" IN (\'birthday_parent\', \'guests\', \'other\'));',
  ]);
  assert.equal(/"public"\./.test(sql), false, "unqualified, as the migrator wants");
  assert.equal(/\b(DROP|RENAME|UPDATE|DELETE|NOT NULL|SET DATA TYPE)\b/i.test(sql.replace(/--.*$/gm, "")), false, "expand only; no stored row is changed");
  const snapshot = JSON.parse(read("migrations/meta/0054_snapshot.json")) as { id: string; prevId: string; tables: Record<string, { columns: Record<string, { notNull: boolean }> }> };
  const before = JSON.parse(read("migrations/meta/0053_snapshot.json")) as { id: string };
  assert.equal(snapshot.prevId, before.id, "the snapshot follows 0053's (the leave types, landed first)");
  for (const c of ["expected_extra_kids", "expected_extra_adults", "socks_arrangement", "socks_note"]) {
    assert.equal(snapshot.tables["public.core_events"]!.columns[c]!.notNull, false, c);
  }
  // The same values the shared rules allow (shared/beoGuestsSocks.ts).
  assert.match(sql, new RegExp(`IN \\(${SOCKS_ARRANGEMENTS.map((a) => `'${a}'`).join(", ")}\\)`));
});

/** Every file under a folder, as text (no node_modules, build output or binary). */
function filesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (["node_modules", "dist", ".turbo", ".git"].includes(name)) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...filesUnder(path));
    else if (/\.(ts|tsx|mjs|js|sql)$/.test(name)) out.push(path);
  }
  return out;
}

await check("nothing the till reads names them: no other app migration (its views), nothing of the platform", () => {
  const NAMES = /expected_extra_kids|expected_extra_adults|socks_arrangement|socks_note|expectedExtraKids|expectedExtraAdults|socksArrangement|socksNote/;
  const migrations = readdirSync(join(APP, "migrations")).filter((f) => f.endsWith(".sql") && f !== "0054_otoapp_beo_extra_guests_socks.sql");
  for (const f of migrations) assert.equal(NAMES.test(read(`migrations/${f}`)), false, f);
  const platform = ["apps/api/src", "apps/pos/src", "packages"].flatMap((p) => filesUnder(join(REPO, p)));
  assert.ok(platform.length > 100, "the platform's sources were read");
  const hits = platform.filter((p) => NAMES.test(readFileSync(p, "utf8")));
  assert.deepEqual(hits, []);
});

await check("the BEO's Save checks them before it writes anything; the print route hands them to the print", () => {
  const routes = code(read("server/beo-routes.ts"));
  const save = routes.slice(routes.indexOf('app.put("/api/events/:eventId/beo", requireAuth, requireManager'), routes.indexOf("await generateTimelineFromBeo(eventId);", routes.indexOf('app.put("/api/events/:eventId/beo", requireAuth, requireManager')));
  const refused = save.indexOf("const guestsSocksRefused = guestsSocksRefusal(eventUpdates as Record<string, unknown> | undefined);");
  assert.ok(refused > 0);
  assert.match(save, /if \(guestsSocksRefused\) return res\.status\(400\)\.json\(\{ error: guestsSocksRefused \}\);/);
  for (const write of ["db.update(coreEvents)", "beoPartyHostAssignments", "lockKitchenPlanMutation", "writeBarPlanRow", "tx.update(beoEventBilling)"]) {
    assert.ok(save.indexOf(write) > refused, `checked before ${write}`);
  }
  const pdf = routes.slice(routes.indexOf('app.get("/api/events/:eventId/beo/pdf"'), routes.indexOf("generateBeoPdf(pdfData)"));
  for (const f of ["expectedExtraKids", "expectedExtraAdults", "socksArrangement", "socksNote"]) {
    assert.match(pdf, new RegExp(`${f}: event\\.${f},`), f);
  }
});

// ── 3. The Kitchen Notes ─────────────────────────────────────────────────────

await check("the Kitchen Notes are the kitchen plan's own column, written by the Save only when its body names them", () => {
  assert.match(read("server/db/coreSchema.ts"), /kitchenNotes: text\("kitchen_notes"\),/);
  assert.equal("kitchenNotes" in kitchenPlanDbDataOf({ cakeMode: "NONE" }), false, "not named: the plan keeps its own");
  assert.equal(kitchenPlanDbDataOf({ kitchenNotes: "ZZ TEST ทำก่อน then serve" }).kitchenNotes, "ZZ TEST ทำก่อน then serve");
  assert.equal(kitchenPlanDbDataOf({ kitchenNotes: "  " }).kitchenNotes, null, "emptied: none");
  assert.equal(kitchenPlanDbDataOf({ kitchenNotes: null }).kitchenNotes, null);
  // Not the special requests, not the final message to the parent: those are the event's own.
  assert.equal("specialRequests" in kitchenPlanDbDataOf({ kitchenNotes: "x" }), false);
  assert.equal("internalStaffNotes" in kitchenPlanDbDataOf({ kitchenNotes: "x" }), false);
});

// ── 4. Adult Waffles ─────────────────────────────────────────────────────────

await check("Adult Waffles: only the set menu's own waffles line (SET with its set menu item's group), its name aside from case and spaces", () => {
  const pkg = { itemName: "Mini Waffles", source: "set_menu", groupId: "item_zz_sweets" };
  assert.equal(BEO_ADULT_WAFFLES, "Adult Waffles");
  assert.equal(beoDishNameOf(pkg), "Adult Waffles");
  assert.equal(beoDishNameOf({ ...pkg, itemName: "  mini   WAFFLES " }), "Adult Waffles");
  assert.equal(isPackageWafflesLine(pkg), true);
  for (const kept of [
    { ...pkg, source: "additional" },
    { ...pkg, groupId: undefined },
    { ...pkg, groupId: "" },
    { ...pkg, itemName: "Mini Pancakes" },
    { ...pkg, itemName: "Waffles x2" },
    { ...pkg, itemName: "Belgian waffles" },
    { ...pkg, itemName: "Mini Waffles with ice cream" },
    { itemName: "Mini Waffles", source: null, groupId: null },
  ]) {
    assert.equal(beoDishNameOf(kept), kept.itemName, JSON.stringify(kept));
  }
  // Nothing is written: the line is read, never changed.
  const line = { ...pkg };
  beoDishNameOf(line);
  assert.deepEqual(line, pkg);
});

await check("Adult Waffles is a name at the BEO's edge only: the set menu, the till's views, the kitchen slips and the server never write it", () => {
  const writers = ["server/lib/setMenuResolve.ts", "server/lib/tillKitchenEdit.ts", "server/lib/beoAiApprove.ts", "server/beo-routes.ts"];
  for (const f of writers) assert.equal(read(f).includes("Adult Waffles") || read(f).includes("beoDishNameOf"), false, f);
  for (const f of readdirSync(join(APP, "migrations")).filter((x) => x.endsWith(".sql"))) assert.equal(read(`migrations/${f}`).includes("Adult Waffles"), false, f);
  const platform = ["apps/api/src", "apps/pos/src", "packages"].flatMap((p) => filesUnder(join(REPO, p)));
  assert.equal(platform.some((p) => /Adult Waffles/i.test(readFileSync(p, "utf8"))), false);
  // Where it is read: the print and the editor.
  assert.match(code(read("server/pdf.ts")), /const name = area === 'food' \? beoDishNameOf\(item\) : \(item\.itemName \?\? ''\);/);
  assert.match(code(read("client/src/components/beo/beo-event-editor.tsx")), /value=\{beoDishNameOf\(item\)\}/);
});

console.log(`\n${checks} checks passed${failed.length ? `, ${failed.length} failed` : ""}`);
if (failed.length) {
  console.log(failed.map((f) => `  - ${f}`).join("\n"));
  process.exit(1);
}
process.exit(0);
