# SCRUM-193: Policies and Assets staging acceptance

On 1 October 2026, a launcher-signed OTO App administrator exercised the live staging policy and asset routes using records named `ZZ SCRUM193 PA …`. The browser viewport was 820 × 1180, representing a park tablet. The proof images below are direct screenshots of the staging OTO App, visually reviewed after capture; they contain only synthetic labels.

## Policies

There was no published policy before this run. A branch-labelled synthetic draft was created through `/api/policies` (201), published through `/api/policies/:id/publish` (200), and read back through `/api/policies/:id` (200) with its published status and synthetic HTML content. `/api/policies/latest-published` selected the published test policy during the run. The Policies screen showed its title, **Published** badge, version and date in `scrum-193-staging-policy-published.png`. Anonymous list and by-ID requests each returned 401.

The test policy was then removed through Data Admin (204). It is absent from the final policy list. Its two synthetic activity-log entries were also removed. Because no policy was published beforehand, cleanup restored the prior state of no published policy.

## Assets

A synthetic employee and catalogue item were created (201 each). One labelled badge was assigned to that employee (201); the employee-assets read (200) showed it pending return, and the employee editor displayed the assigned row in `scrum-193-staging-asset-assigned.png`. Returning that same asset succeeded (200), and a fresh read and editor reload showed its returned timestamp and green **Returned** state in `scrum-193-staging-asset-returned.png`. A second return attempt was refused with 400. Anonymous catalogue and employee-assets reads each returned 401.

The assigned asset, catalogue item, synthetic activity entries and employee were removed; Data Admin returned 204 for each deletion. Final searches found zero matching policies, catalogue items, employee assets, employees or activity entries.

## Remaining access and tablet checks

The first staging run proved the administrator path and anonymous refusal only. The subsequent app route slice added policy branch checks and employee-asset tenant/branch checks; the post-deployment checks below cover its default-tenant and second-tenant paths. Restricted-manager policy and asset access has not yet been checked on staging, so the branch and role outcome remains a local-route result rather than live acceptance.

At 820 pixels wide, the top navigation items overlap visually in all three screenshots. The policy and asset controls used in this run remained operable; the navigation overlap is a tablet-layout defect to address before calling the tablet UX fully checked.

Source inspection found that `otoapp.policy_documents` and `otoapp.asset_catalog` lack a `tenant_id` column, while company-wide policies have no branch ID. A route-only filter cannot reliably separate those records across tenants, especially legacy rows. An additive platform migration and explicit legacy-row cutover are required before their cross-tenant access can be accepted; employee-asset record access can be guarded in the app independently.

## Post-fix live check on deployment `dep-daupqp60tbcc73c7ehv0`

On 1 October, a fresh `ZZ SCRUM193 PA2` policy was created, published and read as the default-tenant administrator (201/200/200). A labelled asset-catalogue item was created (201), assigned to a synthetic employee (201), read back (200), returned (200), and a repeat return was refused (400). Anonymous policy and asset reads returned 401. Actual 820 × 1180 staging captures, visually reviewed, are `scrum-193-staging-pa2-policy-published.png`, `scrum-193-staging-pa2-asset-assigned.png`, and `scrum-193-staging-pa2-asset-returned.png`.

A separate launcher-signed user in a disposable second tenant received 503 for policy list, latest published policy, asset catalogue, and contract finalisation. Their branch list returned 200 with only their own branch. `scrum-193-staging-pa2-nondefault-policies-503.png` is an actual signed-in staging browser capture of the unavailable response. These routes intentionally fail closed for non-default tenants until the platform adds tenant columns and cuts over existing policy, catalogue and template rows; they are **unavailable**, not fully lifted for that tenant.

The policy, asset, catalogue, employee and related activity rows were removed. The second-tenant app link was withdrawn, its account deactivated, and its app user, branch access, branch and tenant deleted. A final read-only Data Admin sweep found no `ZZ SCRUM193 PA2` rows in policy documents, asset catalogues, employee assets, employees, activity logs, schedule tables, time off, holidays, tenants, branches, users or user-branch access. The platform account remains inactive as the audit record.
