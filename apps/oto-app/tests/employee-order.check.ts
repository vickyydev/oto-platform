// seed: none — pure checks on ZZ TEST names, plus reads of the route and
// storage source. Not a Playwright file. Run: TZ=UTC npx tsx tests/employee-order.check.ts
//
// SCRUM-1036 — Scheduling's employee order.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { orderAfterDrag, sortEmployeesForDisplay, type OrderedEmployee } from "../client/src/lib/employee-order";

const emp = (id: string, displayOrder: number, createdAt = "2026-01-01T00:00:00Z"): OrderedEmployee => ({
  id, fullName: `ZZ TEST ${id}`, displayOrder, createdAt,
});

// 1. The reproduction: the server sends newest first, the screen shows by
// displayOrder. Dragging C (third on screen) onto A (first) must save C, A, B.
// Worked out on the server's list (newest first: C, B, A) the old code moved
// the wrong people.
const A = emp("a", 0, "2026-01-01T00:00:00Z");
const B = emp("b", 1, "2026-02-01T00:00:00Z");
const C = emp("c", 2, "2026-03-01T00:00:00Z");
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

// 3. Staff who all share place 0 read the same on every load (oldest first,
// then name, then id), whatever order the server sent them in.
const tied = [emp("x", 0, "2026-05-01T00:00:00Z"), emp("y", 0, "2026-04-01T00:00:00Z"), emp("z", 0, "2026-04-01T00:00:00Z")];
const once = sortEmployeesForDisplay(tied).map((e) => e.id);
assert.deepEqual(once, ["y", "z", "x"]);
assert.deepEqual(sortEmployeesForDisplay([...tied].reverse()).map((e) => e.id), once);
// A new employee (place after the last) sorts last.
assert.deepEqual(sortEmployeesForDisplay([emp("new", 4), ...dept]).map((e) => e.id).at(-1), "new");

// 4. Server: a new employee takes the place after the last; the reorder
// endpoint keeps its manager rule and validates its input.
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
assert.match(route, /storage\.reorderEmployees\(orderedIds, parkGroup\)/);

console.log("employee-order checks passed");
