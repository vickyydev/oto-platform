/**
 * The document modules per park group (S2-17b round 6; plan section 8 round 6,
 * questions Q31, Q40 and Q47 onwards).
 *
 * Before migration 0008 `templates`, `policy_documents`, `asset_catalog` and
 * `leave_policies` had no park group (tenant) column, so the app kept ONE set
 * of each and every park group read and wrote it. The lift fenced the first
 * three behind "This module is unavailable for this tenant" (503) for every
 * park group but the default one; `leave_policies` it left open across park
 * groups (the round 4a census, Q31). 0008 gave each row its park group, and
 * this round takes the 503 down: each module reads and writes the caller's
 * park group.
 *
 * WHICH READS FALL BACK TO THE DEFAULT PARK GROUP. Settings (round 4a, Q28)
 * fall back: a park group with no row of its own for a key reads the default
 * park group's, because the one set used to be everybody's. That holds only
 * where the value is READ and nothing of another park group's is KEPT — the
 * Fix department was the exception there, being an id: another park group
 * reading the default's Fix department would have filed its reports in a
 * department not its own, so it reads none. Decided per module from the app's
 * code by the same line:
 *
 *   templates        OWN ONLY. The app's own create already names the tenant
 *                    (`resolveTenantId`, POST /api/templates) for a column that
 *                    did not exist; a template reaches a park group's branches
 *                    by its assignments; and a contract or letter stores the
 *                    template's id (`contract_instances.template_id`,
 *                    `employee_letters.template_id`).
 *   policies         OWN ONLY. A contract stores the id of the policy its
 *                    employee acknowledged when signing
 *                    (`contract_instances.policy_document_id`) — a contract of
 *                    one park group acknowledging another's Rules & Regulations
 *                    would be the Fix department's fault again. "Company-wide"
 *                    is the park group's company.
 *   asset catalogue  OWN ONLY. An assigned asset stores the id of the
 *                    catalogue item it came from (`employee_assets.catalog_asset_id`).
 *   leave policies   OWN, THEN THE DEFAULT PARK GROUP'S COMPANY-WIDE ONE. A
 *                    leave policy's numbers (days worked per days off earned)
 *                    are read when a balance is worked out and stored nowhere
 *                    by id — a setting, in all but name — and before 0008 a
 *                    company-wide policy was every park group's. So a branch
 *                    takes its own policy, else its park group's company-wide
 *                    one, else the default park group's company-wide one (Q28's
 *                    rule; Q49 offers own-only, as the sick-leave policy has it
 *                    since round 5). Writing is always the park group's own.
 *
 * Another park group's template, policy, catalogue item, leave policy or
 * branch is the same answer as one that does not exist, in the app's own words
 * where the app has them ("Template not found", "Policy not found", "Catalog
 * item not found", "Branch not found").
 *
 * A row with no park group can only be one the release before this wrote
 * during the hand-over; until round 7 runs 0008's backfill again and sets NOT
 * NULL, it reads as its branch's park group's (a policy or leave policy with a
 * branch) or else the default park group's — where it was read before.
 *
 * No Express or database import: the platform's tests read the decisions and
 * the words from here.
 */

/** How a module's reads treat the default park group (see above). */
export type DocumentReadRule = "own" | "own-then-default";

export const DOCUMENT_READ_RULES = {
  templates: "own",
  policies: "own",
  assetCatalog: "own",
  leavePolicies: "own-then-default",
} as const satisfies Record<string, DocumentReadRule>;

/** The answers a route gives for another park group's row — the app's own words where it has them. */
export const TEMPLATE_NOT_FOUND = { message: "Template not found" } as const;
export const POLICY_NOT_FOUND = { message: "Policy not found" } as const;
export const CATALOG_ITEM_NOT_FOUND = { message: "Catalog item not found" } as const;
export const BRANCH_NOT_FOUND = { message: "Branch not found" } as const;
export const EMPLOYEE_NOT_FOUND = { message: "Employee not found" } as const;
export const CONTRACT_NOT_FOUND = { message: "Contract not found" } as const;
export const LETTER_NOT_FOUND = { message: "Letter not found" } as const;
/** No words in the app here: its update and delete answered as if a missing id had worked. */
export const LEAVE_POLICY_NOT_FOUND = { message: "Leave policy not found" } as const;
export const PUBLIC_HOLIDAY_NOT_FOUND = { message: "Public holiday not found" } as const;

/** A caller with no park group at all (the lift's own words, from the guard this round takes down). */
export const PARK_GROUP_REQUIRED = { message: "Tenant access required" } as const;
