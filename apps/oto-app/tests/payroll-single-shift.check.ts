// seed: its own — the September golden's ZZ TEST park group, entered through
// the real routes (tests/payroll-golden-http.ts), then ZZ TEST former
// employees and their single shifts made here. Not a Playwright file.
//
// SCRUM-1055 — a former employee's single shift reaches company payroll.
//
//   1. Nothing changes for a month without a single shift: the September
//      golden month, computed from the database by the preview route, is
//      identical figure for figure and line for line to the run recorded
//      before this change (tests/fixtures/payroll/single-shift/, recorded on
//      the lane's commit before the payroll change; ids named stably).
//
// Usage, from apps/oto-app, with DATABASE_URL naming a database whose otoapp
// schema the app's migrator has built (CI's OTO App job runs exactly this):
//   npx tsx tests/payroll-single-shift.check.ts
//   npx tsx tests/payroll-single-shift.check.ts --record   (writes the baseline; only on the commit before a change)
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { gunzipSync, gzipSync, strFromU8, strToU8 } from "fflate";
import { projectRun, stableNames } from "./payroll/run-projection";

// The engine's answer depends on the ORDER of the people's ids (the world is
// read in id order and a pool's last cents go by that order), and the golden
// park group's ids are random. Ids made here are random per run but sort in
// the order they are made, so two runs read the same people in the same order
// and compare exactly. (Ids the routes make are not ordered; none of them
// orders the people.)
const runPrefix = crypto.randomBytes(4).toString("hex");
let made = 0;
crypto.randomUUID = (() => `${runPrefix}-0000-4000-8000-${(made++).toString(16).padStart(12, "0")}`) as typeof crypto.randomUUID;
syncBuiltinESMExports();
const { runGoldenHttpLeg } = await import("./payroll-golden-http");
const { database } = await import("./payroll-harness");

const BASELINE = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "payroll", "single-shift", "september-golden-run.json.gz");
const RECORD = process.argv.includes("--record");

let checks = 0;
const check = async (name: string, fn: () => void | Promise<void>) => {
  await fn();
  checks += 1;
  console.log(`  ok  ${name}`);
};

const { pool, q } = database();
try {
  console.log("1. a month without a single shift:");
  const golden = await runGoldenHttpLeg();
  const [{ tenant_id: tenant }] = await q<{ tenant_id: string }>("select tenant_id from payroll_paying_entities where id = $1", [golden.ids.entity]);
  const names = await stableNames(q, tenant);
  const projection = projectRun(golden.calc, names);
  if (RECORD) {
    const recordedOn = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    mkdirSync(dirname(BASELINE), { recursive: true });
    writeFileSync(BASELINE, gzipSync(strToU8(JSON.stringify({ recordedOn, month: golden.calc.month, projection }))));
    console.log(`payroll-single-shift.check: baseline recorded on ${recordedOn}`);
    process.exit(0);
  }
  const baseline = JSON.parse(strFromU8(gunzipSync(new Uint8Array(readFileSync(BASELINE))))) as { recordedOn: string; month: string; projection: unknown };
  // DUMP_PROJECTION=<file> writes both sides, to read a difference whole.
  if (process.env.DUMP_PROJECTION) writeFileSync(process.env.DUMP_PROJECTION, JSON.stringify({ now: projection, then: baseline.projection }, null, 1));
  await check(`the golden month is the run recorded before the change (${baseline.recordedOn.slice(0, 9)}), figure for figure and line for line`, () => {
    assert.equal(golden.calc.month, baseline.month);
    assert.deepEqual(projection, baseline.projection);
  });

  console.log(`payroll-single-shift.check: ${checks} checks passed`);
} catch (err) {
  console.error("payroll-single-shift.check FAILED:", err);
  process.exitCode = 1;
} finally {
  await pool.end();
  setTimeout(() => process.exit(process.exitCode ?? 0), 200).unref();
}
