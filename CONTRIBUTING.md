# Contributing

## Commits

History is part of the product. Every commit should read as a deliberate,
reviewable change.

**Subject line** — `type(scope): summary`

- Imperative mood, lower case after the colon, no trailing period, 72 characters or fewer.
- `type`: `feat`, `fix`, `refactor`, `perf`, `test`, `docs`, `build`, `ci`, `chore`.
- `scope`: the area touched — `api`, `pos`, `db`, `shared`, `box`, `infra`, `repo`, or a module name (`members`, `catalog`, `auth`, `payments`, …).

**Body** — explain what a reviewer cannot see from the diff.

- One or two sentences of context: the problem or the reason for the change.
- Then short bullet points for the notable changes, one idea per bullet.
- Mention behaviour changes, migrations, new environment variables and anything a deployer must do.
- Wrap at 72 columns. Plain text only: no emojis, no headings, no marketing language.

**Footer**

- `Refs: SCRUM-123` for the ticket(s) the commit belongs to.
- `BREAKING CHANGE: …` when an API contract or a migration is not backward compatible.
- No tool, generator or assistant attribution lines of any kind.

**Granularity** — one logical change per commit. Schema changes ship with the
code that uses them. Formatting-only and rename-only changes go in their own commit.

Example:

```
feat(members): record tier verification with document expiry

Discounted tiers were applied on a staff member's say-so with nothing
recorded. Verification is now a first-class record.

- add POST /members/:id/tier-verification; verifier, branch and time
  are taken from the session, never from the request body
- reject documents that have already expired and unknown tiers
- hide expired verifications from member lookups; keep the row for audit
- list all verifications for back-office review

Refs: SCRUM-33
```

## Branches

- `main` is always deployable. Work happens on short-lived branches:
  `feat/<topic>`, `fix/<topic>`, `chore/<topic>`.
- Rebase onto `main` before merging; keep history linear.

## Before pushing

```
pnpm typecheck && pnpm lint && pnpm test && pnpm build
```

## Migrations

`0005_schema_move` is the last migration allowed to break the release before
it. It lands ahead of the first deploy, so there is no running service for it
to break. **From `0006` onwards every migration is expand/contract.**

Expand/contract means a migration never removes or renames anything the
currently deployed release still reads. The reason is the deploy itself: old
and new instances run side by side for a minute or two, and during a rollback
the old release runs against the new database. A `DROP COLUMN` or a `RENAME`
shipped together with the code that needs it turns those minutes into errors,
and turns a rollback into an outage. So a rename is three steps across two
releases, not one statement:

1. **Expand** — add the new column, table or index, nullable or with a
   default, and backfill it. The old shape still works and the old code is
   still correct.
2. **Switch** — ship the code that writes and reads the new shape. Both
   shapes are populated for the length of one release.
3. **Contract** — once nothing deployed reads the old shape any more, drop it
   in a later migration.

In practice: add columns nullable or with a default; never rename in place;
never change a type destructively; index a large table concurrently; and keep
every migration re-runnable from an empty database, because CI builds one that
way on every push.

**Generating one.** `pnpm --filter @oto/db generate` (or `pnpm db:generate`)
diffs the Drizzle schema against the last committed snapshot and writes the
SQL. Read what it produced before committing it — left to itself it answers a
rename with `DROP` + `CREATE`, which is data loss — and never edit a migration
that has already been applied anywhere.

**Writing one by hand.** Some changes cannot be generated: a move between
schemas, a rename that has to preserve rows, a data backfill. A hand-written
migration must be accompanied by the matching snapshot, or the next `generate`
will diff against a shape the database no longer has and offer to undo the
change:

```
pnpm --filter @oto/db snapshot 0006_your_tag
pnpm --filter @oto/db verify-schema
```

`verify-schema` builds a throwaway database from the committed migrations,
runs them a second time to prove they are a no-op, and compares the live
catalogue with the snapshot — tables, columns, nullability, foreign-key names
and their `ON DELETE`, indexes and their uniqueness, and check constraints. It
also fails if a table of ours is left in `public`. Run it whenever you touch
the migrations by hand; it needs no Docker.

## What is never committed

Secrets (`.env`), database dumps, anything under `imports/` except its README
files, build output and `node_modules`.
