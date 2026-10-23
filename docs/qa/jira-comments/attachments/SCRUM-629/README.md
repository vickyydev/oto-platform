# SCRUM-629 platform role mapping

Source: `699a7555679aee59ee3e210d00b7b977e017af02`. CI: `40014668250` with six successful jobs; latest live API, Admin and OTO App are bound in release.json. Proof: `cbc5c0a9ac7b643c746f6bdc28c9addd5591ae2961b4c9a3c07cbd0ad9332330`, completed 2026-10-23T20:17:34.895Z.

OTO App access now follows platform grants when the legal entity has enabled mapping: operator administrator becomes Admin, branch manager becomes Manager, and other users become Staff. Entities with the flag off keep their existing behavior. Advisors retain their identity and existing restrictions; that safeguard was checked locally because the demo cast has no advisor account.

The earlier CI run 40001219847 failed the restore rehearsal because the sample seed named the new managed mapping column before its migration. A narrow seed compatibility repair then passed the actual PostgreSQL restore and replay rehearsal. The repaired version must pass its own fresh CI run before staging evidence can be accepted.

Version 699a7555679aee59ee3e210d00b7b977e017af02 passed all six jobs in CI 40014668250 and is live on API, Admin and OTO App. Four fresh staging sign-ins showed Staff with mapping off, then Admin, Manager and Staff with mapping on. The demo person kept the same single-branch limit throughout. The trial grants were removed, the original account and app placement were restored, and the empty test entity was archived with its flag off. All ten app sessions signed out and then refused current-user access.

No invitation, employee creation, SMS, payment, check-in, hardware or channel change occurred. Photos and the exact public font stylesheet were privacy-suppressed; their original assets were not tested. Salary permission bundles and read-only app administration belong to the following subtasks.

Screenshots attached:

- SCRUM-629-01-flag-off-staff.png
- SCRUM-629-02-enabled-admin.png
- SCRUM-629-03-enabled-manager.png
- SCRUM-629-04-enabled-staff.png

The owner retains final acceptance.

The 33 HTTP operations, two app-owned flag jobs and ten signout/current-user checks are recorded in staging-results.json. Both actual image reviews bind all four PNG hashes. Local helper reviews are summarized separately and do not represent staging evidence. No raw logs, credentials or app media are included.
