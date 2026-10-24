# SCRUM-632 read-only preparation

Prepared on 24 October 2026 while SCRUM-631 waits for its Q16 seed-file ruling, under PLAN section2. This is a source map for the next P3 item. SCRUM-632 has not been picked up, implemented, tested or deployed.

Use the routed native pages below. The unused core_admin and studio pages are separate inventory entries and are not replacements for these approved screens.

| Page | Native source | Current writes to cover |
|---|---|---|
| Users | apps/oto-app/client/src/pages/users-page.tsx | POST /api/users; PATCH /api/users/:id; legacy password reset; the existing SuiteSignInDialog integration |
| Permissions | apps/oto-app/client/src/pages/permissions-page.tsx | PUT /api/people/:id/access; PUT /api/permissions/bulk-update |
| Operators | apps/oto-app/client/src/pages/operators-page.tsx | POST/PATCH/DELETE /api/admin/operators[/:id]; PUT /api/admin/operators/:id/branches and /users |

The approved change is the existing lists with a Managed in Admin banner and no write controls while management is enabled; the corresponding writes answer409 managed_in_admin. Flag-off behavior stays as built. A row/action inventory must include menus, open dialogs and bulk controls, not just the primary create button.

The feature flag lives on the app's legal-entity operators, independently of its tenant. apps/oto-app/server/lib/platformRoleMapping.ts resolves a trusted mapped session and preserves the raw advisor identity. That existing session field alone does not inventory every management target: user, people, operator-assignment and bulk routes still need their existing target-resolution trace before implementation. Preserve tenant and branch fences and the current403/404 rules; do not broaden them to make the new banner work.

Relevant server locations in routes.ts at this preparation:
- Users reads/writes:1018–1639; userManagementTenant and managedBranchIds supply current target fences.
- Operator administration:2081–2231; operatorForUser resolves the entity before mutation. The native create flow currently sends create, branch assignment and user assignment separately.
- People access:14787/14818; bulk permissions:27663. Permissions includes people beyond a simple login list.
- Module overrides:27480–27542 are a separate existing access surface to trace when checking that the new management refusal has no alternate writer.

The Users page deliberately keeps the launcher-era password behavior from SCRUM-539. SuiteSignInDialog can provision a real platform account and send an SMS. Future staging checks must use existing demo identities and safe refusal/readback controls; no invitation is authorized by this preparation.

At implementation, retain the existing pages and flag-off tests. Prove the approved flag-on HTTP refusals leave selected data unchanged, cover mixed/bulk targets before any write, and check the native page state without opening a second management authority. Any unresolved policy or scope conflict goes to the planner through STATUS and the ticket under PLAN section2.
