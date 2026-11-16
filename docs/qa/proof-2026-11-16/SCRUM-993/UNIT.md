# SCRUM-993 implementation checkpoint — verification pending

Worktree: `C:/oto-lanes/codex-inbox-feedback-20261116`, branch `lane/codex-inbox-feedback-20261116`. Root owns Jira, source review, shared status, integration, deployment and staging proof. This local source checkpoint is not a release or a verification claim. No real staff grant, preference or access policy has been changed.

## Authority and storage

The approved Tom feedback plan authorizes category and specific-channel limits inside existing Inbox permissions. The owner's approval preserves existing role/action and operator/branch/team boundaries. Root clarified that changing the whole account policy needs existing operator-wide or platform-wide `admin:role:assign`; branch-only role managers retain their existing role controls and read these new controls only where existing account scope/dominance permits.

Provisional platform migration **0128** creates `inbox.account_access` and `inbox.account_channel_access`, initially empty. No policy means existing unrestricted access. `null` means no additional restriction; an empty list deliberately allows none. The policy has a positive version. Composite tenant FKs cover account ownership, channel ownership and child-policy ownership. A forward-only `core.account(operator_id,id)` unique constraint supports the account FK. All eleven generated constraint names are at most 50 bytes. The unapplied generated SQL was reordered so this referenced unique constraint is created before its dependent FK.

The current provisional journal/snapshot follows 0125 in this lane. **Do not land it as final:** wait for deposit 0126 and BEO 0127, rebase, regenerate the final 0128 snapshot chain and prove the SQL remains the same. Do not edit an applied migration.

## Authored source

- The existing permissions drawer embeds `InboxAccessControls`; it reads current limits, previews exact before/after on the server, and saves by expected-version CAS. Read, preview and save are guarded against account switches and stale responses. Unavailable saved channels require explicit review/removal. Administrators retain their existing access; role-name spelling is never authority.
- Management routes reuse existing account reach/dominance. Whole-policy writes require operator-wide assignment authority. They use existing resource-owned replay semantics and fresh authorization, not a cached permission answer. An immediately repeated identical version change can replay; another stale edit cannot overwrite it.
- `read-visibility.ts` intersects fresh database policy with the existing read/reply/assignment arms. Operator-wide reading and assignment cannot bypass a restrictive policy. The actual current own-operator/platform `admin:operator:all` marker is the management exception; tenant fences and existing action reach still apply.
- Every list refresh returns current limit metadata. Category/source filters, named views, contact/simulator/AI channel pickers and cached learned source names use those limits. A forbidden direct thread read clears cached thread contents in the UI.
- Direct media already enters through the shared visibility loader. New-contact creation and destination category changes add policy checks. Hidden duplicate contacts no longer reveal their names through a conflict response.
- Source-linked proposed AI examples now filter by current conversation policy; own-id returns follow current thread authorization. Approved de-identified examples retain their existing global KB behavior because approval deliberately severs personal source links.
- Personal-data erasure preview/action must cover every affected subject conversation under current limits; no partial erasure is inferred. Archived Start over rechecks current policy before its already-cleared response.
- Existing cached Inbox action/read/reply/contact/AI/erasure/simulator responses have optional current-resource replay guards. The independent generic hook was reviewed and checked separately at `cbd9e66bf0ca4ad719bdd2dc70e22ddcd26c4175`; it is also present locally as `a4aa54dbb`. Root/deposit own BookDate and prebooking replay callbacks. Preserve those callbacks when integrating this lane.
- Simulator actions check their requested category/channel. Global demo setup is refused under a restricted policy; it cannot create hidden cross-category fixtures on behalf of a limited viewer.

No Inbox server export or realtime stream endpoint was found in the audited route set. Existing Inbox refresh is polling through the fenced reads; the internal assistant's Inbox tools call those same authenticated routes. Customer-channel AI jobs are background processing, not an account's staff read permission.

## Checks completed at this checkpoint

API contract generation/boot succeeded. Authored-source lint produced zero output. Constraint identifier inspection found eleven names, longest 50 bytes, none over PostgreSQL's 63-byte limit. **No SCRUM-993 runtime boundary or migration acceptance is claimed yet.**

The independent generic replay hook passed 63 checks across four complete API files, whole API compiler output zero, and touched lint zero. That proof does not verify the new category/channel implementation.

## Finite remaining work

1. Add and run the adversarial whole API review for: initially empty policies; null versus empty lists; operator/branch/team/assignment intersections; own/foreign administrator markers; foreign accounts/channels; direct detail/messages/media/search/counts; proposed AI source context; destination and channel pickers; unchanged exact cached replay versus revoked category/channel denial; archived Start over; actor revocation before replay; preview/version-CAS concurrency and account ownership; no duplicate policy version or audit on replay.
2. Add/run drawer tests for read-only branch managers, stale account/read/preview/save responses, explicit empty selections, server before/after review and conflict refresh. Add/run Inbox filter/source-cache boundary tests.
3. Rebase after root lands 0126/0127. Ground-truth the commit list and drop duplicate already-landed 992/generic-hook patches. Reconcile shared contract blocks with deposit/BEO; regenerate API types and final snapshot/journal, compare SQL identity and inspect the actual schema/FK names after migration.
4. Run whole relevant API read/action/reply/contact/media/privacy/AI/test-line/simulator and generic permission/idempotency/route-conformance files; run the relevant DB schema controls. Fix actual findings without weakened assertions or timeouts. Serialize heavy work with the BEO/deposit lanes.
5. Complete whole API/shared/DB/admin-screens/Inbox/Console/POS compiler gates as applicable, authored-file lint, whole Inbox/admin UI checks and affected production builds. Read compiler output whole. Preserve failed and successful receipts with exact candidate bindings.
6. Freeze the final candidate for root's independent review. Root then lands normally, watches full-SHA CI in the background and deploys named affected staging services. Staging proof uses only owned ZZ TEST fixtures/policies or a read-only actual management view, with screenshots and local boundary coverage clearly separated. No real staff policy changes; exact owned-fixture/session cleanup receipts are required. Only root may publish acceptance/Jira evidence.

Local checkpoint lint receipt: `C:/oto-lanes/inbox-993-checkpoint-lint.log`. Migration/contract generation receipts: `C:/oto-lanes/inbox-993-migration-generate.log` and `inbox-993-api-types-generate.log`.
