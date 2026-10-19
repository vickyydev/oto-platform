// The parity fixture (plan §6), generated once, locally, from the prototype
// itself (reference input, not committed) and committed here as fictional data:
//   - seed-world.json.gz: the prototype's `createSeedData()` with its clock
//     pinned to 2026-10-19T03:00:00Z (the seed dates itself from "now") and a
//     seeded Math.random, with the fictional Malaysian branch removed — its
//     branch, people, paying entity, account, inputs and policies (plan §4).
//     Removing it changed no Thai number: the prototype's results for both Thai
//     entities were identical with and without it.
//   - expected.json.gz: the prototype engine's own `calculateCompanyEngine` on
//     that world for 2026-09 and 2026-10, per person and line (id, component,
//     label, category, amount, flags, allocations), payments, exceptions, the
//     service-charge pools, the incentive awards and the source signature.
// `createSeedData` is named as the prototype's was so its unit tests port
// with their bodies unchanged: each call is a fresh copy, as each prototype
// call built a fresh seed. The later "trim the legacy month-end feed" subtask
// is gated by the same expected file.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync, strFromU8 } from "fflate";
import type { PayrollWorld } from "../../server/payroll/engine/model";

const PARITY = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "payroll", "parity");
const gz = (name: string) => strFromU8(gunzipSync(new Uint8Array(readFileSync(join(PARITY, name)))));
let text: string | undefined;
export function createSeedData(_calculator?: unknown): PayrollWorld {
  text ??= gz("seed-world.json.gz");
  const world = JSON.parse(text) as PayrollWorld;
  // The prototype's own short display names (company-pay-explanation.ts:4), which its line labels used;
  // the world loader passes `branches.name` here instead (plan §8).
  world.costCentreNames ??= { "hkt-central": "Central", "hkt-chalong": "Chalong" };
  return world;
}
export function parityExpected<T>(): T {
  return JSON.parse(gz("expected.json.gz")) as T;
}
