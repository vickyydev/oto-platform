// seed: none — pure checks on ZZ TEST ids, plus reads of the route, storage
// and screen source. Not a Playwright file. Run: TZ=UTC npx tsx tests/employee-order.check.ts
// (the HTTP half is tests/employee-order-http.check.ts).
//
// SCRUM-1036 — the employee order, drawn and dragged the same way on
// Scheduling and on the Employees page.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { compareEmployeeOrder, orderAfterDrag, sortEmployeesForDisplay, type OrderedEmployee } from "../client/src/lib/employee-order";

const emp = (id: string, displayOrder: number): OrderedEmployee => ({ id, displayOrder });

// 1. The reproduction: the server sends newest first, the screen shows by
// displayOrder. Dragging C (third on screen) onto A (first) must save C, A, B.
// Worked out on the server's list (newest first: C, B, A) the old code moved
// the wrong people.
const A = emp("a", 0);
const B = emp("b", 1);
const C = emp("c", 2);
const serverList = [C, B, A];
const shown = sortEmployeesForDisplay(serverList).map((e) => e.id);
assert.deepEqual(shown, ["a", "b", "c"]);
assert.deepEqual(orderAfterDrag(serverList, shown, "c", "a"), ["c", "a", "b"]);
assert.deepEqual(orderAfterDrag(serverList, shown, "a", "c"), ["b", "c", "a"]);
assert.equal(orderAfterDrag(serverList, shown, "a", "a"), null);
assert.equal(orderAfterDrag(serverList, shown, "a", "zz"), null);

// 2. A filtered view: only b and d are shown; swapping them leaves a and c
// exactly where they were.
const dept = [emp("a", 0), emp("b", 1), emp("c", 2), emp("d", 3)];
assert.deepEqual(orderAfterDrag(dept, ["b", "d"], "d", "b"), ["a", "d", "c", "b"]);

// 3. Staff who share a place stay in the order the server sent them (newest
// first), as both screens drew them before the repair: the sort is stable and
// breaks no tie of its own.
const tied = [emp("newest", 0), emp("middle", 0), emp("oldest", 0)];
assert.deepEqual(sortEmployeesForDisplay(tied).map((e) => e.id), ["newest", "middle", "oldest"]);
assert.equal(compareEmployeeOrder(emp("x", 0), emp("y", 0)), 0);
assert.equal(compareEmployeeOrder({ id: "x" }, emp("y", 0)), 0, "a missing place reads as 0, as `|| 0` did");
// ...and a drag among tied staff saves the order shown, the dragged one moved.
assert.deepEqual(orderAfterDrag(tied, ["newest", "middle", "oldest"], "oldest", "newest"), ["oldest", "newest", "middle"]);
// A new employee (place after the last) sorts last.
assert.deepEqual(sortEmployeesForDisplay([emp("new", 4), ...dept]).map((e) => e.id).at(-1), "new");

// 4. Many random drags, with ties and searches: the order saved, read back
// through the comparator, is the order shown after the move, and the staff a
// search hid keep their places.
let seed = 1036;
const rand = (n: number) => {
  seed = (seed * 1103515245 + 12345) % 2 ** 31;
  return seed % n;
};
for (let round = 0; round < 500; round += 1) {
  const size = 2 + rand(8);
  const list = Array.from({ length: size }, (_, i) => emp(`p${i}`, rand(3)));
  const shownIds = list.filter(() => rand(4) > 0).map((e) => e.id);
  const visible = sortEmployeesForDisplay(list).map((e) => e.id).filter((id) => shownIds.includes(id));
  if (visible.length < 2) continue;
  const from = rand(visible.length);
  const to = rand(visible.length);
  const saved = orderAfterDrag(list, shownIds, visible[from]!, visible[to]!);
  if (from === to) {
    assert.equal(saved, null);
    continue;
  }
  const expected = [...visible];
  const [moved] = expected.splice(from, 1);
  expected.splice(to, 0, moved!);
  const reread = sortEmployeesForDisplay(saved!.map((id, place) => emp(id, place)));
  assert.deepEqual(reread.map((e) => e.id).filter((id) => shownIds.includes(id)), expected, `round ${round}`);
  const hiddenBefore = sortEmployeesForDisplay(list).map((e, place) => [e.id, place] as const).filter(([id]) => !shownIds.includes(id));
  for (const [id, place] of hiddenBefore) assert.equal(saved!.indexOf(id), place, `round ${round}: ${id} kept its place`);
}

// 5. Server: a new employee takes the place after the last; the reorder
// endpoint keeps its manager rule and validates its input (no size cap).
const storage = readFileSync(new URL("../server/storage.ts", import.meta.url), "utf8");
const create = storage.slice(storage.indexOf("async createEmployee("), storage.indexOf("async updateEmployee("));
assert.match(create, /max\(\$\{employees\.displayOrder\}\)/);
assert.match(create, /eq\(employees\.tenantId, employee\.tenantId\)/);
assert.match(create, /\.values\(\{ \.\.\.employee, displayOrder \}\)/);
const routes = readFileSync(new URL("../server/routes.ts", import.meta.url), "utf8");
const at = routes.indexOf('app.post("/api/employees/reorder"');
const route = routes.slice(at, at + 1500);
assert.match(route, /requireAuth, requireManager/);
assert.match(route, /new Set\(orderedIds\)\.size !== orderedIds\.length/);
assert.match(route, /typeof id === "string"/);
assert.doesNotMatch(route, /orderedIds\.length >/, "no size cap of its own");
assert.match(route, /storage\.reorderEmployees\(orderedIds, parkGroup\)/);

// 6. Both screens draw and drag with the same two helpers.
for (const page of ["scheduling-page.tsx", "employees-page.tsx"]) {
  const source = readFileSync(new URL(`../client/src/pages/${page}`, import.meta.url), "utf8");
  assert.match(source, /import \{ compareEmployeeOrder, orderAfterDrag \} from "@\/lib\/employee-order";/, page);
  assert.match(source, /\.sort\(compareEmployeeOrder\)/, page);
  assert.match(source, /orderAfterDrag\(department, shownIds, activeEmpId, overEmpId\)/, page);
}

console.log("employee-order checks passed");
