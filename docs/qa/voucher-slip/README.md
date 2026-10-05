# Lucky Wheel voucher verification - 5 October 2026

SCRUM-499 covers fixed codes and the temporary current-POS QR override. SCRUM-500 covers editable bilingual slip design and prompt published-config apply.

## Verified source and deployment

- Pi/API/Booth implementation: 7eca661228876e6bc202f603e22f04f1da385b0b. CI [37289763344](https://github.com/vickyydev/oto-platform/actions/runs/37289763344) succeeded, including Pi pack and artifact upload.
- Console repair: 0c641b7e922458e147f91fa54664e25b5f2d7746. It is manually deployed and verified on staging. CI 37292071118 attempt 1 failed on an unchanged print-package Vitest worker RPC timeout (onTaskUpdate), not an assertion; attempt 2 was requested and remains pending at this checkpoint. Do not describe that run as green.
- API deployment dep-db1mpenavr4c73cmgb5g, Booth dep-db1mqt9srm7s73ce45c0 and Console dep-db1n39ou01pc73f7tjc0 were observed live. Normal automatic deployment remains enabled.
- Earlier b6b77d71 did auto-deploy after its successful CI; the older STOP POINT saying it was not deployed is superseded.

## Existing checks

Affected API tests: 65 passed; fixed-code till cases: 3 passed. Print slip: 33 passed; box slip: 4 passed; shared slip: 8 passed; Console type/slip: 38 passed, 2 inherited todo. All seven touched packages typechecked; scoped lint and Console/Booth builds passed. Migration 0057 passed empty-schema verification. The delayed booth-switch case and existing repricing browser case passed (2). No new test suite or framework was added.

The first database rehearsal caught PostgreSQL's regex repetition bound; the unshipped constraint was repaired to check length separately. Real staging testing caught a Console race where a previous booth draft remained editable during selection; the repair ignores stale reads, hides mismatched drafts and closes editors on selection changes. The older proof-booth draft changed during that test was restored from its exact guarded audit snapshot. QA fixture records were archived by exact ID; no park publish occurred.

## Staging proof and limits

An isolated local box connected to the staging API and a simulated 80 mm printer. The real Console saved and published bilingual slip settings; the box reported the new version in 2050 ms. Two different spins used the configured fixed code. Printing worked offline and both spins synced after reconnect. The current-POS QR setting saved through the Console, applied automatically, printed offline, matched the TV fallback while preserving the platform reference, and synced. Clearing it and publishing applied version 3. Reprint stability and normal-QR restoration are also covered by existing box tests.

All six supplied images decoded successfully. Actual 512-dot and 576-dot printer renders decoded to the exact original values: 12 matches. Only boolean evidence is retained in qr-scan-verification.json. Actual redeemable values are not recorded here or on Jira. No original QR was opened or redeemed.

The current-POS scanner and physical paper have not been tested in this session. The park installation is the remaining hardware acceptance step. New-platform staging lookup returned NO_STATION_PICKED (409), so it is not claimed as a successful till redemption; the three affected local redemption tests passed. Current-POS redemption and repeat-use rules remain in that POS and do not update the platform voucher ledger.

## Park draft

FWBooth1 remained published/running at version 11 when checked. Six exact QR mappings and the bilingual showcase layout are saved, not published. The owner approved adding Kids Pizza and sharing chance: the existing 300 THB slot's 10% was split into 5% each, preserving every other chance. Seven active prizes total 100%:

| Prize | Chance |
| --- | ---: |
| 100 THB Voucher | 25% |
| Free Bracelet Workshop | 30.5% |
| 150 THB Voucher | 17.5% |
| 1+1 Kids Ticket | 2.5% |
| 200 THB Voucher | 14.5% |
| 300 THB Voucher | 5% |
| Kids Pizza | 5% |

300 THB has no supplied static QR and remains generated. A supplied QR changes only the QR; the readable platform code remains its tracking reference. Existing printed slips/reprints retain their saved version. New slips use the new settings after publish and confirmed apply. Costs for Bracelet, Kids Ticket and Kids Pizza are not configured, so Console's estimated prize-cost total is incomplete.

## Evidence attached to Jira

- SCRUM-499: SCRUM-499-staging-fixed-code-proof.png (11252), SCRUM-499-staging-qr-proof.png (11253), SCRUM-499-staging-qr-setting.png (11254), SCRUM-499-park-seven-prizes-draft.png (11255).
- SCRUM-500: SCRUM-500-staging-preview.png (11256), SCRUM-500-staging-published-box.png (11257), SCRUM-500-park-slip-draft.png (11258).

The two backend cards are explicitly test-run evidence with a simulated printer. Other images are actual staging Console captures. Redeemable setting fields are masked. The published-box screenshot proves online/version/printer status; backend verification.json supplies spin counts because that screenshot preceded the refreshed count.

## Release and next actions

The CI-packed oto-box-0.1.0-7eca661.tgz and its .sha256 are on the Windows Desktop. SHA-256 was verified before and after copy:

970d5340b45f892174de2167ef5806c2858480e3a5239cf031f7a69e4cdf063e

The 0468c38 and d10d78f archive/checksum pairs moved into Desktop/old-oto-box-releases. Console-only 0c641b7e changes no Pi files; 7eca661 is the correct compatible Pi release. Follow update-at-park.md: copy both files, check checksum, install, reboot, then publish the draft and confirm running version. Print a new winning slip and scan it on the current POS. Do not use a reprint of an old slip to test the new design. Record physical results under these tickets. Check Console CI attempt 2 and document its actual conclusion when available.

## On-site follow-up - 18:35 Bangkok

**5 October, park QR follow-up:** the owner reports the Pi update completed, but a NEW 100 THB spin still printed a QR scanning to the previous URL after an override edit and publish. SCRUM-499 is reopened In Progress for diagnosis. Live version 14 had saved/published plain codes for 100/200/300 THB and the physical box reported running 14; config_apply succeeded. During checking, the owner cleared the 100 THB override and published version 15, now also reported running; no settings were changed by the investigation. Latest observed 100 THB print was 18:34 Bangkok, before version 15. Direct SSH from this environment timed out. A read-only Pi command has been requested to report release path and whether the last eight remembered print jobs contain URLs or plain codes, never actual QR values. Await this evidence; do not assume a restart fixes the cause. Keep the owner's latest draft/prize edits.

Console CI 37292071118 attempt 2 is now SUCCESS; API, Console, Booth, POS and Launcher staging are observed live at 0c641b7e. The CI-packed 7eca661 Pi archive is still correct. SCRUM-500 stays Deployed; its English/Thai terms fields were verified live as enabled multiline controls, 2000 characters each, with Print the terms on in the latest park draft. Physical paper/current-POS acceptance is still not claimed.

