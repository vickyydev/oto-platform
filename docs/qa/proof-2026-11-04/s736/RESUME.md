# SCRUM-736 paused checkpoint — 4 November 2026, 15:05 Bangkok

The owner explicitly requested this checkpoint and a pause until their command.
Do not continue implementation, proof or deployment until that command arrives.

Latest correction at checkpoint save: Pause checkpoint update: main has now advanced to 4fa176286, the planner's correction to the four deployment-column pins. Its new main CI is pending; the earlier red run remains a failure. The lane failed-job log confirms the same database inventory failure as main. The checkpoint rebases onto this correction on new lane/codex-box-scanner-20261104-r4, preserving r3 without force push. No new test or staging action is started while pausing. Read the new main CI and run the affected database file after the owner resumes.

## Resume location and identities

- Worktree: C:/oto-lanes/codex-box-scanner-20261104.
- Resume lane: lane/codex-box-scanner-20261104-r4. Previous r3 is preserved. No force push.
- Source/checkpoint before this documentation commit: ba59e33b0e2588baaaec682c9656c594a3daf605.
- Runtime implementation after rebase: 8e0e2563e; original tested runtime:
  936cfbbe3f9062d955d3afdbdae26f38bfaeff89.
- Rebased own commits on r4: 3b5495b66 plan, dad5c0ad1 runtime, 32442ee07
  local proof, 0d77c34d8 route inventories, eb857ece0 pause notes. Historical
  gate receipts retain their original source SHAs. The saved text copies have
  normalized line endings and trailing whitespace; source hashes refer to the
  original external files.
- Main at pause: 480f3cc65 (documentation over source 46e8accc0).
- Jira SCRUM-736 In Progress. No main landing or staging proof exists for it.
- SCRUM-753 To Do records offline History; its opened failure image is inline.

## Owner decisions, scope and queue

Q736-1 is APPROVED: temporarily add the two named API bridge keys and two
POS build-time bridge keys only in this lane's claimed staging window, using
single-key writes and exact fingerprint/count restoration (API 57 to 59 to 57;
POS 4 to 6 to 4). Preserve the signing key and BOX_AGENT_TEST_SLOT. Values are
not recorded here. The prepared helper has not run and staging is unchanged.

Q736-2 is RESOLVED: scanner delivery stays in 736. Offline History's existing
platform-only lookup is SCRUM-753; do not build cached History or remove its
failed extra test. Q727-1 and Q727-2 stay with the owner, unbuilt.

The latest main STATUS still retains 674/672's source/API/proof slot. A later
747/746 progress heading explicitly retains that hold. This lane has made no
claim. Claim only a newest explicit release, never a heading containing a claim.
Main CI 41792289018 is red: packages/db/test/suite-controls.test.ts still pins
the ten deployment columns before four release-feed columns were added. Its
other five jobs passed. This belongs to the planner's release work; no file in
that work was changed here. Recheck main and the planner's correction on resume.

## Completed verification, with limits

- Complete original API battery: 6,268 passes, four failures in only two
  route-inventory files, 401 inherited skips and four TODOs. Both whole files
  plus scanner review then pass 59 checks after deliberately adding the new
  authenticated relay route and increasing the exact route count 13 to 14.
  Original failure receipts are retained; no guard or test was weakened.
- Complete non-API workspace: all fifteen packages passed, box agent 888/888.
- Standard built POS browser smoke: seven journeys passed.
- After rebase to current main: all sixteen typecheck tasks pass (eight cached),
  API zero diagnostics, lint zero errors/eight inherited warnings, generated
  contracts match; entire output was read. Six combined API files pass 123.
- Full rebased Console browser suite: 357/357, exit zero, disposable DB removed.
- Real local Windows runner, SQLite, HID/CDC readers, HTTP bridge and built POS:
  wristband, credit voucher, booking QR and shop wristband all pass online and
  with browser/platform plus agent/cloud transport cut. Printed QR is decoded
  from the runner's real simulated printer output and matched in memory to the
  issued credential. All eight images in local/printed-qr were opened.
- Local exact fixture API cleanup and independent SQL readback pass in
  mw1tsr25: child collected through synthetic-photo pickup, simulator booking
  redeemed, own till session ended through native lock-screen sign-out, three
  finalised sales retained, station/printers/box archived, address removed,
  box disabled, four synthetic bands revoked, inactive working row removed,
  zero active sessions/working rows/print queues/commands/live bands. Wallet
  grants, sales, payments, booking redemption and pickup evidence remain as
  financial and safety history. Local DB then dropped; zero SMS.
- Dedicated staging-staff provisioning and retirement branches are prepared
  but NOT locally rehearsed yet; local cleanup used the seed reception subject.
- No physical Pi, DS2278 cradle, private HTTPS/LAN, park printer or real-bank
  acceptance. Product barcode catalog handling is not in these native cases.
  The real park cradle remains untested until owner installs the next release
  and moves it. Offline credit reflects the existing spending cap.

## CI and process state

Lane CI 41795390765 is bound to full SHA ba59e33b0e2588baaaec682c9656c594a3daf605.
At checkpoint it is still running, but ci already failed; POS and OTO App jobs
passed and the three API shards continue. Do not claim green or cancel it to
hide failure. Read its final result and failed job 126458167763 on resume.
The failed lane job log has now been read and confirms the same database
column-inventory failure as main. The repository watch-ci.sh filters main only; its attempted lane watch was
stopped and is not a result. Use full-SHA gh reads for the lane. On a future
main source push use sh scripts/agent/watch-ci.sh FULL_SHA 45 as required.

All local gate/proof processes have completed; do not kill other lanes' Node,
database or browser processes. All local disposable DBs and owned agents,
forwarders and browser contexts were closed. Eight new stopped 736 agent homes
remain on disk and are listed in resume/checkpoint.json. They contain local
synthetic credentials: never commit or print their contents. The earlier five
736 homes were already removed with an absence receipt. Leave the previously
documented stopped 727 cache alone; do not attempt its removal again.

## Exact next steps after owner resumes

1. Read this lane's newest STATUS and both handovers, then git fetch origin.
   Read the newest main STATUS and both CI results. No main/staging action
   while main is red or the planner retains its slot. Do not rerun a failed
   CI job until its cause and exact-source reproduction are understood.
2. Inspect the finished lane CI, including the database inventory inherited
   from the planner. Pull its correction by rebase. Ground-truth all own commits
   and preserve every STATUS block. If rebasing rewrites pushed history, use a
   new r4 lane instead of force pushing. Existing source gates retain their
   exact identities; rerun affected combined checks after incoming fixes.
3. Finish the prepared staging harness: rehearse dedicated ZZ TEST staff
   provision and retirement locally; verify interruption cleanup and final
   session sign-out. The currently prepared staging helper is syntax-checked
   only, has never run, and must not be mistaken for proof. Latest saved copies
   are under resume/harness; copy to C:/oto-lanes if needed, preserving UTF-8.
   Do not rerun one-shot preparation/checkpoint scripts blindly: some prepend
   notes, post comments or replace files. Controllers use exclusive log names;
   choose a new version prefix for a necessary rerun.
4. When the newest main STATUS explicitly releases the slot and main is green,
   claim it in STATUS, rebase, run final affected gates, check gh run list,
   push the lane and then authorized main source. Walk Jira Testing when source
   is on main. Watch full-SHA main CI and confirm live API/POS source.
5. Only then use s736-proof-settings.mjs enable with the approved owner/window
   flags and exact main SHA/CI. It reads/counts first, writes single keys,
   fingerprints every key and deploys the same source. No bulk setting writes.
   Check partial receipts before retrying an interrupted enable or restore.
6. Run the actual eight-case staging proof using only its new ZZ TEST box/till,
   local native runner, cash and simulator. S736_PROOF_SHA pins live runtime
   even if checkout later has documentation commits; runtime trees must match.
   Never save a real box address; no park devices, SMS or real people. Read the
   exact three sales/payments and cleanup counts. Keep every failed receipt.
7. Restore the four temporary keys and all original fingerprints/counts,
   deploy the same source again and read live health/identity. Clean only own
   fixtures, sessions and credentials and independently read the result.
8. Open actual staging PNGs, copy them to the ticket attachment directory,
   publish inline with commentWithImages, verify inline references, then use
   jira.mjs walk SCRUM-736 Deployed and read back. Never Done. Say plainly the
   real park cradle remains untested. Update STATUS and both handovers and
   explicitly release the slot. Report ticket, source SHA, CI, live SHA,
   opened images, status readback and unproven limits.
9. Only after 736 completion start SCRUM-744 on a new origin/main lane: read
   its ticket; reproduce inactivity lock/reload/unlock/station recovery with a
   browser test, determine platform vs box and stale lease, fix cause, stage
   desktop and phone on own ZZ TEST till. Then prepare the owner-installed
   box release from origin/main carrying 727,728,730,731,736 and 744 if landed,
   checksum into Desktop oto-box-release, update Quickstart part H where steps
   changed; never install on park hardware (dry run at most).

## Files to use, not restart from scratch

- resume/checkpoint.json: exact receipts, CI snapshots, hashes, stopped homes.
- resume/cleanup-rehearsal.json: passing native API and independent DB cleanup.
- resume/final-types-and-lint.log: complete rebased types/lint/contracts output.
- local/printed-qr: eight opened success images and source-bound local result.
- local/extended: original offline-History failure and nine successes.
- resume/harness/s736-staging-run.mts.txt: latest prepared staging collector.
- resume/harness/s736-cleanup-api.mjs.txt and s736-cleanup-database.mjs.txt:
  verified local fixture retirement; staging staff branch still untested.
- resume/harness/s736-proof-settings.mjs.txt: approved bounded temporary keys.
- resume/harness/s736-proof-account.mjs.txt and s736-release-render-job.mjs.txt:
  dedicated account creation with no SMS and guarded source-bound jobs.
- External full logs: C:/oto-lanes/s736-rerun1-api{1,2,3}.log/.json;
  s736-workspace-serial.log; s736-final-{types,combined,console}.log;
  s736-rerun1-smoke.log; s736-cleanup-local5-browser.log. Hashes in receipts.
- External failed main log: C:/oto-lanes/s736-observed-main-failure.log.
- External branch failed-job log download completed and its failure was read:
  C:/oto-lanes/s736-branch-ci-failed-job.log.

Do not touch apps/pos/src/lib/displaySession.ts. Do not change accepted 727,
728 or 739 work. Preserve all owner and protected-lane boundaries, no attribution
lines, explicit git file lists, no imports/.env/services, no printed secrets.
Push every commit to its lane. This checkpoint grants no permission to resume
before the owner's next command.
