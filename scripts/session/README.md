# Session helpers

Small, dependency-free Node scripts the build sessions use to read Jira, read and
steer the Render staging services, and split a working-tree diff into hunks so a
commit can carry one slice of a shared file. They were written in a session
scratchpad, which vanishes with the session; they live here so the next session
finds them.

Every script is an ES module, run directly with Node (no build, no install):

```sh
node scripts/session/<name>.mjs [args]
```

Run them **from the repository root**. They locate the repo themselves — each one
derives `ROOT` from its own file location (`scripts/session/` → `../../`) — so the
working directory only matters for `hunks.mjs`, which diffs against `ROOT` anyway.

## Credentials

No script contains a credential. Each reads the gitignored `.env` at the repo root
and takes values **by variable name only**:

| Variable | Used by |
|---|---|
| `RENDER_API_KEY` | every `render-*.mjs`, `wait-ok.mjs` |
| `JIRA_BASE_URL` | `jira-lib.mjs` |
| `JIRA_EMAIL` | `jira-lib.mjs` |
| `JIRA_API_TOKEN` | `jira-lib.mjs` |

`.env` is ignored by `.gitignore` and must stay that way. Nothing here prints a
secret: the Render scripts print service names, ids, shas and statuses. The one
exception is `render-env-names.mjs`, which prints the **value** of `SEED_PROFILE`
(a profile name such as `full`, not a secret) because knowing which seed profile
staging runs is the whole reason that script exists; everything else it prints is
variable names.

The Digio terminal's void password is **not** in this repository and must not be
added to it. It is configuration, read at runtime; the vendor spec holds it
(`§5.5`, under `imports/`, which is never committed) and the plan copy under
`docs/progress/plans/206-tenders/` refers to it by description only.

## The scripts

### Jira

- **`jira-lib.mjs`** — not run directly; imported by the other Jira scripts. Loads
  `.env`, builds the Basic auth header, and exports `jget` / `jpost` / `jput`,
  `statusOf(key)`, `walkTo(key, target)`, `adf(text)`, `comment(key, text)`,
  `attach(key, paths)`, `commentWithImages(key, text, files)` and
  `createInSprint({...})`. `walkTo` steps one status at a time along
  `To Do → In Progress → Testing → Deployed`, re-reading after each hop, and never
  walks backwards. `adf` turns plain paragraphs into Atlassian document format and
  promotes a block whose lines all start with `- ` into a bullet list.

### Render staging

- **`render-deploys.mjs`** — the everyday one. Lists each `*-staging` service with
  its `autoDeploy` setting and its last four deploys (sha, status, time, subject).
  `node scripts/session/render-deploys.mjs`
- **`render-cmds.mjs`** — per service: type, pre-deploy command, build command,
  start command, root directory. Use it to check what a service actually runs,
  which is authoritative — `render.yaml` only documents.
- **`render-env-names.mjs`** — the API service's env-var **names**, sorted, plus the
  `SEED_PROFILE` value.
- **`render-projects.mjs`** — projects, their environments, and which staging
  services are attached to which environment.
- **`render-triggers.mjs`** — per service: `autoDeploy` and `autoDeployTrigger`.
- **`render-wait.mjs <sha7>`** — polls every 30s until all five root-built staging
  services (api, pos, console, launcher, booth) are `live` on exactly that sha;
  stops early on a failed or cancelled deploy; gives up after 15 minutes. The OTO
  App is excluded deliberately — it builds from `apps/oto-app` and only deploys
  when its own files change.
- **`wait-ok.mjs <sha7> [<sha7> ...]`** — the looser wait for api/pos/console:
  succeeds when each service has a **live** deploy on any of the accepted shas,
  because the CI queue may roll past the target to a newer push. 40-minute deadline.

### Render, mutating

These two change Render configuration. They are **inert without `--apply`**, so a
bare run cannot silently re-patch staging:

- **`render-predeploy.mjs --apply`** — sets the api service's pre-deploy command to
  `pnpm db:migrate && pnpm db:platform-sync`, then prints it back. This is the
  change that stopped the full seed running on every deploy.
- **`render-group-booth.mjs --apply`** — attaches the booth service to the staging
  environment and prints the resulting membership.

Both hold hard-coded Render resource ids (`srv-…`, `evm-…`). Those are identifiers,
not credentials, but they pin these scripts to today's staging: re-read the ids from
`render-projects.mjs` before trusting them.

### Diffs

- **`hunks.mjs list <file>`** — splits `git diff -U3 -- <file>` into hunks and prints
  each hunk's number, its `@@` header and its first six changed lines.
- **`hunks.mjs pick <file> 1,3 > out.patch`** — writes a patch holding only those
  hunks, for `git apply --cached out.patch`.

This exists because several slices are live in the working tree at once and a commit
must carry only its own. Read the hunks, pick the ones that belong to the slice, and
stage the patch into a temporary index as below.

## Committing one slice out of a shared working tree

Several slices are usually in flight in the same files. To commit exactly one
without stashing the others, build the commit in a **temporary index** and leave the
working tree untouched:

```sh
export GIT_INDEX_FILE="$(mktemp -u)"      # a scratch index, not .git/index
git read-tree HEAD                        # start from HEAD's tree

# then EITHER stage whole files by explicit path:
git add -- apps/api/src/services/payments/gateway.ts apps/api/test/payments-2c2p.test.ts
# OR stage selected hunks of a file shared with another slice:
node scripts/session/hunks.mjs list apps/api/src/routes/payments.ts
node scripts/session/hunks.mjs pick apps/api/src/routes/payments.ts 2,3 > slice.patch
git apply --cached slice.patch

TREE="$(git write-tree)"
SHA="$(git commit-tree "$TREE" -p HEAD -F msg.txt)"
git update-ref HEAD "$SHA"

unset GIT_INDEX_FILE
git reset -q                              # resync the real index with the new HEAD
```

Two rules, both learned the hard way:

1. **Never run it with an empty file list.** `read-tree HEAD` followed by nothing
   staged still produces a valid tree — HEAD's own — so `commit-tree` succeeds and
   `update-ref` moves the branch to a commit that changes nothing. It looks like it
   worked. Assert the list is non-empty before staging.
2. **Never build the file list by substring filter.** Filtering paths by a fragment
   (`grep payments`, `*sync*`) silently sweeps in files belonging to the other live
   slices, and the commit ships work that was not reviewed. Name every path
   explicitly, or pick hunks.

## Jira protocol

Every push moves its ticket and says so in the same turn: the ticket goes
**In Progress** while the work is being written and **Testing** on the push that
lands it, and the push carries a comment written for the owner, not for an engineer
— what changed at the till or on reception, what to look at, what is still open,
in plain sentences and no stack traces. A ticket reaches **Deployed** only with a
staging screenshot **attached to the ticket and named in the comment that
references it**; a walk with no screenshot is refused rather than fudged, because
"deployed" is a claim about what is running, and the screenshot is the evidence.
Times quoted in a comment come from `git log` or from the clock — never estimated,
never rounded to make a sequence look tidier than it was.
