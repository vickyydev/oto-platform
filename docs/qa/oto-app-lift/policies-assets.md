# SCRUM-193: Policies and Assets staging acceptance

On 1 October 2026, a launcher-signed OTO App administrator exercised the live staging policy and asset routes using records named `ZZ SCRUM193 PA …`. The browser viewport was 820 × 1180, representing a park tablet. The proof images below are direct screenshots of the staging OTO App, visually reviewed after capture; they contain only synthetic labels.

## Policies

There was no published policy before this run. A branch-labelled synthetic draft was created through `/api/policies` (201), published through `/api/policies/:id/publish` (200), and read back through `/api/policies/:id` (200) with its published status and synthetic HTML content. `/api/policies/latest-published` selected the published test policy during the run. The Policies screen showed its title, **Published** badge, version and date in `scrum-193-staging-policy-published.png`. Anonymous list and by-ID requests each returned 401.

The test policy was then removed through Data Admin (204). It is absent from the final policy list. Its two synthetic activity-log entries were also removed. Because no policy was published beforehand, cleanup restored the prior state of no published policy.

## Assets

A synthetic employee and catalogue item were created (201 each). One labelled badge was assigned to that employee (201); the employee-assets read (200) showed it pending return, and the employee editor displayed the assigned row in `scrum-193-staging-asset-assigned.png`. Returning that same asset succeeded (200), and a fresh read and editor reload showed its returned timestamp and green **Returned** state in `scrum-193-staging-asset-returned.png`. A second return attempt was refused with 400. Anonymous catalogue and employee-assets reads each returned 401.

The assigned asset, catalogue item, synthetic activity entries and employee were removed; Data Admin returned 204 for each deletion. Final searches found zero matching policies, catalogue items, employee assets, employees or activity entries.

## Remaining access and tablet checks

These staging checks prove the administrator path and anonymous refusal. They do **not** prove role or branch refusal. The policy read routes require sign-in but do not show a role or branch guard in their route handlers; the employee-assets read requires sign-in, and assign/return require manager role, but those handlers do not show an employee-branch guard. A safe restricted staging sign-in was unavailable without invoking the platform's live SMS setup path, so cross-role and cross-branch outcomes remain unverified on staging. They require a restricted signed-in fixture and should not be called passed from the 401 checks above.

At 820 pixels wide, the top navigation items overlap visually in all three screenshots. The policy and asset controls used in this run remained operable; the navigation overlap is a tablet-layout defect to address before calling the tablet UX fully checked.

Source inspection found that `otoapp.policy_documents` and `otoapp.asset_catalog` lack a `tenant_id` column, while company-wide policies have no branch ID. A route-only filter cannot reliably separate those records across tenants, especially legacy rows. An additive platform migration and explicit legacy-row cutover are required before their cross-tenant access can be accepted; employee-asset record access can be guarded in the app independently.
