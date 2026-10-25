# SCRUM-638 local checkpoint

This is the local checkpoint for `cd8b38b7bdccd0737bac307aa5eecd699ad55f44`, pushed to `lane/admin-assistant-settings`. SCRUM-638 remains In Progress. Its feature has not landed on main or staging, and this directory contains no staging screenshot or deployment acceptance.

The Console settings page, settings storage and pricing calculations have local evidence. Q21 still holds the three protected consumer integrations and the initial rate inputs on the planner lane. A fresh complete combined release battery is required after that work. No initial model prices are invented here.

## Source frames

The broad battery used frame `2d39ecea41b0a21800be2ed550939737d1e46d4c77ccec73216c34df140a07ef`. The final checkpoint uses `8173e6ed67ff191ded96da79303abdb4ca5cf7a7df7510d429a9224091b1af87` over 3,774 inputs. The [bridge](local/final-guard-bridge.json) records 3,772 identical inputs. Its only two changed files contain the three-line year-zero validation guard and its HTTP regression. The final source bytes remained unchanged through rebase.

| Check | Observed result | Frame and receipt |
| --- | --- | --- |
| Full API, three shards | 5,582 passed across 370 files; 3 skipped and 5 todo | Broad frame; `api-all-{1,2,3}-final.json` |
| Console built-browser suite | 220 passed | Broad frame; [receipt](local/console-browser-all-1.json) |
| POS | 1,437 passed across 101 files | Broad frame; [receipt](local/pos-tests-1.json) |
| Other pnpm package tests | Recursive workspace command passed, excluding root/API/POS/Box which have separate receipts | Broad frame; [receipt](local/workspace-package-tests-1.json) |
| Workspace compilation and builds | All 16 typechecks and 5 builds passed, 21 tasks with no cache reuse | Broad frame; [receipt](local/workspace-compilers-builds-2.json) |
| Box, default concurrency | Twice 747 passed and 2 timing cases failed | Broad frame; [first](local/box-tests-1.json), [second](local/box-idle-1.json) |
| Box, serial concurrency | All 749 passed with unchanged source, assertions and timeouts | Same broad frame; [receipt](local/box-serial-1.json) |

A real year-zero check exposed a reliability fault: the schema accepted ISO year `0000`, which PostgreSQL rejected with `22008`. The new HTTP test then observed 200 where 400 was required. Both failed receipts are retained. After the guard, eight focused API files passed all 223 tests and the additional Node regression passed. API, Console and API-client compilers, generated contracts, all 10 client tests and lint on 20 changed TypeScript files passed. Those focused checks passed again after rebase. Their receipts bind the final frame; the broad battery does not.

`fullBatteryOnFinalFrame`, `localReleaseGreen` and `protectedConsumersBuilt` are all **false**. There is no `local-release.json`. Passing serial Box tests does not erase either default-concurrency failure. Earlier failed, interrupted and corrected attempts remain in the metadata history, with their original exit codes and frame hashes.

## Evidence and cleanup

[source-manifest.json](source-manifest.json) is a byte-identical copy of the final external `current.json`, renamed for publication. `local/` preserves every integrated JSON receipt and manifest, including setup, census, superseded attempts, final bridge, both source checkpoints and cleanup. `metadata/` preserves database-generation history, progress checkpoints and the two local loader preflights. [independent-checks.json](independent-checks.json) lists every new file and the copied receipt hashes. [external-artifacts.json](external-artifacts.json) inventories raw logs, progress journals, archives, path lists and the held proof source by path, size and SHA-256. Their contents stay outside this directory.

The held staging helper passed 19 initial offline checks. Its independent native-callback regressions then failed 3 of 22 checks before the fixes; the unchanged 22-check suite passed afterward. The local Windows schema-loader preflight succeeded. These are preparation results with zero authentication attempts and no staging execution; the preflight explicitly has no released-source binding.

The [terminal cleanup receipt](local/cleanup.json) records removal of exactly the two ticket-owned containers at `2026-10-25T09:50:44.884Z`, after zero database clients were observed. All ten baseline containers were preserved. No volumes, images, networks or bind data were removed.

This publication copied and checked metadata only. It ran no tests, containers, Git commands, Jira actions, authentication or staging calls. Before main and deployment acceptance, complete Q21, collect a fresh combined release result, watch the exact source SHA through CI and automatic rollout, and capture and inspect new staging evidence.
