# SCRUM-737 first-sale printer configuration

## Reproduction before product changes

On 3 November 2026 at 23:22 Bangkok, product source `6fd968a3` failed
the real API/box-agent regression. The station create request included both
receipt and kitchen assignments. The transaction committed them before
returning, and `routeOnBox` resolved both. The first cash sale queued both
jobs with their assigned device IDs. The ordinary command poll then used
the box's older configuration and reported both as `NO_DEVICE_FOR_ROLE`.

The control pulled configuration before the same command path: both jobs
printed, each in one attempt. Each sale had exactly one approved cash
payment. [Original failing output](reproduction-before.log) records one
failed test, one passing control and exit 1. No product file was changed
before that reproduction. The seed and database are disposable local test
fixtures; this is not a physical printer or staging result.

## Cause and fix

Station creation is transactional; its assignments were not lost or delayed.
The command timer runs independently of the heartbeat that refreshes the
configuration. A print command can therefore name a newly assigned printer
before the box's cached configuration includes it.

Before rendering an assigned print command, the agent compares that route
with its cache and reads configuration if they differ. A matching route
needs no extra request. Current assignments still decide the route, including
deliberate removal. An unread configuration reports `CONFIG_UNAVAILABLE`
with zero print attempts, using the existing failed-job reporting path.
No sale or payment request is retried. The earlier offline-print duplicate
guard still runs before this refresh.

The seven-case review covers the original timing, a fresh-cache control,
a changed receipt printer, HTTP and connection failures, deliberate removal
after queuing, and a till intentionally created without printers. It reads
simulator output and approved cash attempts and polls commands again to
check that neither paper nor payment is duplicated. Full release gates and
staging proof remain pending.

## What staff see

`announceSalePrinting` reads the sale once. If that read already sees a skip,
the till shows **Some items not printed**. If it sees queued jobs, it says
they were sent and does not automatically warn when a later command skips
them. Opening the sale in History reads the final skipped status. This is
the code-observed behavior; a native staging capture is still required.
No new notification is part of this job.

The two historical rows named on SCRUM-737 remain unchanged. No setting,
Render service, plan, size or park device changes are planned. Source landing
and staging proof wait for a committed, uncontested release-slot claim;
SCRUM-730 currently holds the slot.

**4 November 2026, 01:33 Bangkok, SCRUM-737/742 COMPLETE LOCAL AND BRANCH GATES PASS; REBASED OVER 728:** All three final local API shards pass on frozen e186b0ad: 444 files, 6,176 passes, zero failures, 401 existing skips and four TODOs. Full branch CI 41689125742 passes all six jobs. Whole workspace types, lint/contracts, POS and other package tests, builds, tools, 357 Console browser cases and native till journeys pass; the OTO App ratchet stays at 418 inherited errors across 54 files, with no increase. The original failures and corrected regression remain recorded. A separate release checkout is rebased onto 728 main source 00f414ba with the six own commits intact and every handover block retained; own product/test bytes match e186b0ad. Backup branch lane/codex-first-print-20261104-r4 is pushed. Since 728 changes the outage path, the merged release gates run before landing. Prepared real-agent staging proof, independent readback and exact retirement helpers are backed up in the report; none has run on staging. 728 still holds the source/API/proof/cleanup window. No slot claim, main source push, restart or setting change. 737/742 stay In Progress until their own main CI and exact live proof. The eight older proof tickets are Deployed; 734 remains held for 707 Deployed.**

**4 November 2026, 02:33 Bangkok, SCRUM-737/742 ALL COMBINED LOCAL AND BRANCH GATES GREEN; SOURCE LANDING NEXT:** CI 41700223785 passed all six jobs for 4757ed1c7bf9ba85acb3ac8a008f36fc35987da8. The rebased lane is product/test byte-identical, with every main and lane handover line retained. All 445 local API files pass 6,181 tests, with 401 existing skips and four TODOs; workspace types/lint/contracts/tests/builds, eleven till journeys and the full unchanged 357-case Console repeat pass. The original mock error remains recorded under open SCRUM-743; no assertion was weakened and no cause is invented. The migration journal ends at 0099; this lane adds no migration. The only archive change removes a surplus ending blank line with its original hash retained. Current prepared proof helpers are backed up and omit handoff credentials from navigation errors. 737/742 hold the source/API/proof/cleanup slot through their own exact live proof and retirement. Source landing follows this checkpoint, then Testing, full-SHA main CI, exact affected live commits, one dedicated ZZ TEST cash sale through the real local agent, independent readback and cleanup, and opened images inside commentWithImages before Deployed. No staging fixture, setting or park-device change yet. Older eight stay Deployed; 734 remains held for 707 Deployed.**

**4 November 2026, 02:36 Bangkok, SCRUM-737/742 SOURCE LANDED; EXACT-SHA MAIN CI RUNNING:** Source 773fd25f5436bf07f663af183761481b3197a3ef is on main and backed up on lane/codex-first-print-20261104-r5. Jira reads Testing for both tickets through jira.mjs walk. All complete local gates pass; full branch CI 41700223785 passed all six jobs on identical product/test bytes. Main CI 41704476807 is watched by the full source SHA with the required 45-minute watcher. The release worktree stays frozen at that SHA for the matching real local agent and staging proof; this separate notes lane preserves progress. 737/742 retain the source/API/proof/cleanup slot. Wait for green main CI and exact live API, POS web, old POS, Console and OTO App sources before the dedicated first-cash-sale proof and live-source redaction check. No staging fixture or setting change has occurred. Historical skipped jobs and park devices remain untouched. Retire only own fixtures, independently read cleanup, open final images and show them inside commentWithImages before Deployed, never Done. SCRUM-743 remains open for the retained intermittent Console mock error. Older eight remain Deployed; 734 stays built and backed up, held for 707 Deployed.**

**4 November 2026, 02:54 Bangkok, SCRUM-737 SEVEN-SERVICE PREFLIGHT SAVED; MAIN CI CONTINUES:** The matching local agent runner builds on frozen source 773fd25f; its bundle hash is saved. An initial request for a nonexistent build script is recorded separately, followed by the successful canonical build:runner command. Read-only metadata confirms all seven staging services healthy on their preceding live commits: API/POS web/old POS/Console/Launcher/Booth at 00f414ba, OTO App at 629714f2. This is a baseline, not acceptance. The proof guard now requires all seven live on the exact new source before creating its fixture. The existing local-agent registration path needs no new setting; BOX_AGENT_TEST_SLOT is only for the hosted extra virtual agent and is not used. No Render setting or test record changed. Main CI 41704476807 continues with POS and OTO App green; API and workspace jobs remain active. 737/742 retain the source/API/proof/cleanup slot and stay Testing. The held clone lane is now backed up at 50e98eb325ef5ac822c2eda6b8ed6743bc43440a on lane/codex-branch-clone-20261104-r4, with unchanged owned code, preserved local proof and the original helper retained. 734 remains In Progress until 707 Deployed, a fresh rebase and combined gates. All eight older tickets still read Deployed.**
