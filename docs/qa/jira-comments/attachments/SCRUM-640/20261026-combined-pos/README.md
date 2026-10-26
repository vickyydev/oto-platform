# SCRUM-640 combined Linux POS check

A fresh local Linux execution passed all 1,437 POS tests in 101 files on
2026-10-26, 13:31:05.656–13:32:58.585 UTC. The native unpiped command was:

`pnpm --filter @oto/pos test --maxWorkers=1 --fileParallelism=false`

The 101 executed file paths exactly match the current POS test manifest.
The complete sanitized native output was read: 119 lines, no failed, skipped
or TODO cases. The command exited 0 with no signal.

The fresh workspace copy contains 3,809 source inputs at manifest
`6640afe780d69234f365dd583d25bddef3ca586f0b5c87ab3530c9f7cc7e4506`.
It matches feature checkpoint `025c9929e26f3100876905d9b1430ae06722521a`;
snapshot HEAD `ee05af58e6d3851915f39e15d22744e05c0f3994` adds docs only.
All 28 package/lock inputs and the installed POS dependency metadata matched
before and after. Four supplemental document inputs are listed separately.
The offline frozen install reported the lockfile and cached packages already
up to date; no package download or network access was available.

Node was 22.23.3 and pnpm 10.33.0. Default Intl locale was en-US, with native
number formatting checked before execution. No assertions, timeouts or locale
functions were changed. The cached Linux image was run with a 2 GiB limit,
network disabled, no published ports and no host mounts. Peak memory was
1,246,580,736 bytes, with zero OOM events.

The exact owned worker was removed after receipt capture. All ten shared
container IDs remained present. Images, volumes and networks were preserved.

`artifact-index.json` binds each immutable external original to its display
copy. Copies use LF, remove trailing horizontal whitespace and extra blank
lines at EOF, and add a final LF where needed. Original raw files remain outside the repository. Receipt
`logSha256` fields and the original review still identify the original
sanitized output; use the index's `copiedArchiveSha256` for normalized copies.
The source archive itself is retained externally and fingerprinted by the
create intent; this directory contains its complete source path/hash manifest.

This is local package coverage. It does not establish hosted CI, staging
acceptance or a complete SCRUM-640 release. Pending protected-source fixes
and other package gates remain separate.
