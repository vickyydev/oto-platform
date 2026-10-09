/**
 * The HR employee doors per park group (S2-17b round 6's review, findings 1
 * and 2; plan section 4, "the HR employee doors", and Q54).
 *
 * WHAT WAS OPEN. The app looks an employee up by id alone
 * (`storage.getEmployee`) at most of its `/api/employees/:id*` doors and then
 * checks only the branch, which every all-branch admin passes. So one park
 * group's admin read another park group's employee in full, edited them,
 * switched their login off or reset its password, and could move them into
 * their own park group with `tenantId` in the edit's body — after which every
 * round 6 door that trusts `employee.tenant_id` handed over that person's
 * contracts, letters, documents, assets and offboarding.
 *
 * THE RULE. Every door resolves the employee in the caller's park group first
 * (`getEmployeeInTenant`, the session's park group, as round 6's employee doors
 * do), and another park group's employee is the same answer as one that does
 * not exist — the app's own answer at that door. Where the app answers a list
 * for an employee it does not find (their contracts, letters, change history),
 * that is the empty list, as round 6 already had it. Within the park group
 * every door behaves exactly as the app has it, its branch rules included.
 *
 * IDS A BODY NAMES. An id that would tie the employee to another park group's
 * record is refused in the app's words for that kind of record (404), when it
 * changes: a branch ("Branch not found"), a login ("User not found", the
 * app's strict placement deciding whose a login is, as User Management
 * does), a person ("Person not found", placed as the employee delete places
 * them: their employee row, access policy and login), a department
 * ("Department not found") and a role ("Role not found"). `tenantId` is never taken from a body. Roles are one set the
 * app keeps in the default park group (its create names the default), so a
 * park group may assign its own roles and the default park group's; another
 * park group's role is refused (Q54).
 *
 * THE WIZARD. The contract wizard's employee edits are the six personal fields
 * the app's own client sends (client/src/pages/contract-wizard-page.tsx,
 * `employeeUpdates`), and nothing else: no login, person, branch, department,
 * status or park group rides in with a contract (finding 2). `nationalId` is
 * one of the six although the table has no such column; the app sent it and
 * the update ignores it, and both stay so.
 *
 * No Express or database import: the platform's tests read the census and
 * the words from here.
 */

/** The answer a door gives for another park group's employee. */
export type ForeignEmployeeAnswer =
  /** The app's 404 "Employee not found". */
  | "employee-not-found"
  /** The app's empty list, as for an employee it does not find. */
  | "empty-list"
  /** The app's `null`, as for an employee it does not find. */
  | "null"
  /** The app's own park-group check, kept: 403 "Access denied". */
  | "access-denied"
  /** Face is off (round 5, H13): refused in words before any lookup; the lookup stands behind it. */
  | "face-off";

/**
 * Who fenced the door:
 *  - `review`: round 6's review (finding 1) — the employee resolved in the caller's park group here;
 *  - `re-review`: round 6's re-review (findings 6 and 8) — the doors without an id;
 *  - `lift`: an earlier round of the lift, unchanged;
 *  - `app`: the app's own park-group check, kept as it is;
 *  - `none`: nothing to fence — the handler never runs.
 */
export type EmployeeDoorFence = "review" | "re-review" | "lift" | "app" | "none";

export interface EmployeeDoor {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
  fence: EmployeeDoorFence;
  foreign: ForeignEmployeeAnswer;
}

/** Every `/api/employees/:id*` door the app registers, in the order `server/routes.ts` registers them (45). */
export const EMPLOYEE_DOORS: readonly EmployeeDoor[] = [
  { method: "GET", path: "/api/employees/:id/roles", fence: "review", foreign: "employee-not-found" },
  { method: "PATCH", path: "/api/employees/:id/roles", fence: "review", foreign: "employee-not-found" },
  { method: "PATCH", path: "/api/employees/:id/department", fence: "review", foreign: "employee-not-found" },
  { method: "GET", path: "/api/employees/:id", fence: "review", foreign: "employee-not-found" },
  { method: "GET", path: "/api/employees/:id/onboarding-status", fence: "lift", foreign: "employee-not-found" },
  { method: "GET", path: "/api/employees/:id/profile-photo", fence: "lift", foreign: "employee-not-found" },
  { method: "POST", path: "/api/employees/:id/profile-photo", fence: "lift", foreign: "employee-not-found" },
  { method: "PATCH", path: "/api/employees/:id", fence: "review", foreign: "employee-not-found" },
  { method: "POST", path: "/api/employees/:id/enable-login", fence: "lift", foreign: "employee-not-found" },
  { method: "POST", path: "/api/employees/:id/generate-login", fence: "lift", foreign: "employee-not-found" },
  { method: "POST", path: "/api/employees/:id/reset-password", fence: "review", foreign: "employee-not-found" },
  { method: "POST", path: "/api/employees/:id/toggle-login", fence: "review", foreign: "employee-not-found" },
  { method: "DELETE", path: "/api/employees/:id", fence: "lift", foreign: "employee-not-found" },
  { method: "GET", path: "/api/employees/:id/cost-allocations", fence: "review", foreign: "employee-not-found" },
  { method: "PUT", path: "/api/employees/:id/cost-allocations", fence: "review", foreign: "employee-not-found" },
  { method: "POST", path: "/api/employees/:id/complete-probation-review", fence: "review", foreign: "employee-not-found" },
  { method: "GET", path: "/api/employees/:employeeId/changes", fence: "review", foreign: "empty-list" },
  { method: "POST", path: "/api/employees/:employeeId/changes", fence: "review", foreign: "employee-not-found" },
  { method: "PATCH", path: "/api/employees/:employeeId/changes/:changeId", fence: "review", foreign: "employee-not-found" },
  { method: "POST", path: "/api/employees/:employeeId/transfer", fence: "lift", foreign: "employee-not-found" },
  { method: "GET", path: "/api/employees/:employeeId/contracts", fence: "lift", foreign: "empty-list" },
  { method: "GET", path: "/api/employees/:employeeId/active-contract", fence: "lift", foreign: "null" },
  { method: "GET", path: "/api/employees/:employeeId/documents", fence: "lift", foreign: "employee-not-found" },
  { method: "POST", path: "/api/employees/:employeeId/documents", fence: "lift", foreign: "employee-not-found" },
  { method: "DELETE", path: "/api/employees/:employeeId/documents/:docId", fence: "lift", foreign: "employee-not-found" },
  { method: "GET", path: "/api/employees/:employeeId/documents/:docId/file", fence: "lift", foreign: "employee-not-found" },
  { method: "GET", path: "/api/employees/:employeeId/offboarding", fence: "lift", foreign: "employee-not-found" },
  { method: "POST", path: "/api/employees/:employeeId/offboarding", fence: "lift", foreign: "employee-not-found" },
  { method: "PATCH", path: "/api/employees/:employeeId/offboarding", fence: "lift", foreign: "employee-not-found" },
  { method: "GET", path: "/api/employees/:employeeId/letters", fence: "lift", foreign: "empty-list" },
  { method: "POST", path: "/api/employees/:employeeId/warnings", fence: "lift", foreign: "employee-not-found" },
  { method: "POST", path: "/api/employees/:employeeId/letters", fence: "lift", foreign: "employee-not-found" },
  { method: "GET", path: "/api/employees/:employeeId/letters/:letterId/download", fence: "lift", foreign: "employee-not-found" },
  { method: "GET", path: "/api/employees/:employeeId/assets", fence: "lift", foreign: "employee-not-found" },
  { method: "POST", path: "/api/employees/:employeeId/assets", fence: "lift", foreign: "employee-not-found" },
  { method: "POST", path: "/api/employees/:employeeId/enrollment-session", fence: "review", foreign: "face-off" },
  { method: "POST", path: "/api/employees/:employeeId/reset-face-enrollment", fence: "review", foreign: "employee-not-found" },
  { method: "GET", path: "/api/employees/:employeeId/time-events", fence: "lift", foreign: "employee-not-found" },
  { method: "POST", path: "/api/employees/:employeeId/pin", fence: "review", foreign: "employee-not-found" },
  { method: "DELETE", path: "/api/employees/:employeeId/pin", fence: "review", foreign: "employee-not-found" },
  { method: "GET", path: "/api/employees/:employeeId/timekeeping-status", fence: "review", foreign: "employee-not-found" },
  { method: "GET", path: "/api/employees/:employeeId/time-off", fence: "lift", foreign: "employee-not-found" },
  { method: "GET", path: "/api/employees/:employeeId/leave-balance", fence: "lift", foreign: "employee-not-found" },
  { method: "GET", path: "/api/employees/:employeeId/sick-leave-balance", fence: "lift", foreign: "employee-not-found" },
  { method: "GET", path: "/api/employees/:employeeId/all-leave-balances", fence: "app", foreign: "access-denied" },
];

/**
 * What a door without an id does about park groups (round 6's re-review, F6
 * and F8). Within the park group each is the app's door as it was.
 *  - `list`: the caller's park group's employees, then the app's branch
 *    filters; another park group's branch lists nobody, the app's answer for
 *    a branch with no one in it.
 *  - `sample`: the import template's sample branch name is the park group's.
 *  - `create`: made in the caller's park group (the app's strict placement,
 *    an earlier round), and the ids its body names weighed as the edit's are,
 *    in the same words (F8).
 *  - `delete`: each id resolved in the park group, another's "Employee not
 *    found" in the row (round 2).
 *  - `reorder`: the park group's ids are written; another's is skipped as a
 *    missing id is, its place in the list kept.
 *  - `dead`: registered after `GET /api/employees/:id`, which answers it
 *    ("Employee not found" for the id `upcoming-reviews`); its own handler
 *    never runs, and nothing is changed.
 *  - `recalculate`: the park group's employees only (round 6, Q31).
 *  - `import-preview`: rows matched (by email, then full name) and branch
 *    names placed only within the park group; another's branch name is the
 *    app's own row error `Branch "<name>" not found`.
 *  - `import-apply`: a row's employee is resolved in the park group (the
 *    app's row error "Employee not found") and its branch taken only from the
 *    park group (the app's row error "No access to branch"), new rows too.
 */
export type EmployeeListRule =
  | "list"
  | "sample"
  | "create"
  | "delete"
  | "reorder"
  | "dead"
  | "recalculate"
  | "import-preview"
  | "import-apply";

export interface EmployeeListDoor {
  method: "GET" | "POST";
  path: string;
  fence: EmployeeDoorFence;
  rule: EmployeeListRule;
}

/** Every `/api/employees*` route without an id, in the order `server/routes.ts` registers them (9; with the 45 above, all 54). */
export const EMPLOYEE_LIST_DOORS: readonly EmployeeListDoor[] = [
  { method: "GET", path: "/api/employees", fence: "re-review", rule: "list" },
  { method: "GET", path: "/api/employees/bulk-template", fence: "re-review", rule: "sample" },
  { method: "POST", path: "/api/employees", fence: "re-review", rule: "create" },
  { method: "POST", path: "/api/employees/bulk-delete", fence: "lift", rule: "delete" },
  { method: "POST", path: "/api/employees/reorder", fence: "re-review", rule: "reorder" },
  { method: "GET", path: "/api/employees/upcoming-reviews", fence: "none", rule: "dead" },
  { method: "POST", path: "/api/employees/recalculate-probation", fence: "lift", rule: "recalculate" },
  { method: "POST", path: "/api/employees/bulk-upload-preview", fence: "re-review", rule: "import-preview" },
  { method: "POST", path: "/api/employees/bulk-update", fence: "re-review", rule: "import-apply" },
];

/** The ids an employee record ties to a park group's other records, weighed by the edit and the create. */
export const EMPLOYEE_PARK_GROUP_ID_FIELDS = ["branchId", "userId", "updatedBy", "profilePhotoUpdatedBy", "personId", "primaryDepartmentId"] as const;
export type EmployeeParkGroupIdField = (typeof EMPLOYEE_PARK_GROUP_ID_FIELDS)[number];

/** A record that holds none of those ids yet: what the create weighs its body against (F8). */
export const NO_PARK_GROUP_IDS: Readonly<Record<EmployeeParkGroupIdField, null>> = {
  branchId: null,
  userId: null,
  updatedBy: null,
  profilePhotoUpdatedBy: null,
  personId: null,
  primaryDepartmentId: null,
};

/** The six personal fields the app's contract wizard sends as its employee edits — and the only ones taken. */
export const WIZARD_EMPLOYEE_FIELDS = ["fullName", "nickname", "email", "phone", "address", "nationalId"] as const;

/** The wizard's employee edits, kept to the six personal fields; anything else in the body is dropped. */
export function wizardEmployeeEdits(raw: unknown): Record<string, unknown> | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const edits: Record<string, unknown> = {};
  for (const field of WIZARD_EMPLOYEE_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(raw, field)) edits[field] = (raw as Record<string, unknown>)[field];
  }
  return edits;
}

/** The app's own words for a record of another park group, per kind (404). */
export const USER_NOT_FOUND = { message: "User not found" } as const;
export const PERSON_NOT_FOUND = { message: "Person not found" } as const;
export const DEPARTMENT_NOT_FOUND = { message: "Department not found" } as const;
export const ROLE_NOT_FOUND = { message: "Role not found" } as const;
/** No words in the app here: its change update answered a missing change with an empty 200. */
export const CHANGE_NOT_FOUND = { message: "Change not found" } as const;
