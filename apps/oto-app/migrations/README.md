# OTO App migrations

These run into schema `otoapp` of the platform database. `npm run db:migrate`
applies them; `script/migrate.mjs` is the migrator and the only supported way
to change this app's schema.

## Why the history starts again at 0000

The chain the app arrived with does not build the schema the app runs on. The
numbers:

| | tables |
|---|---|
| declared in `shared/schema.ts` + `server/db/coreSchema.ts` | 184 |
| created by the chain Drizzle would actually apply (the 11 files in `meta/_journal.json`) | 112 |
| created by all 25 `.sql` files that were in the folder, journalled or not | 131 |

So 53 tables — `notifications`, `announcements`, `kiosk_codes`,
`casual_workers`, the five `xero_*` tables, the six `task_*` tables and the
rest — exist only in the TypeScript. They were never written as a migration at
all. Another 14 `.sql` files sit in the folder unreferenced by the journal, so
`drizzle-kit migrate` skips them, and the snapshots stop at `0002` while the
files run to `0022`, so a diff would have been taken against a shape three
migrations old.

That is what maintaining a schema with `drizzle-kit push` leaves behind: the
live database is right, the migration history is a partial record of how it got
there, and `scripts/post-merge.sh` (which ran `push --force` on every merge and
was deliberately not copied into this repository — see `../README.md`) is why.

Replaying that chain into an empty database produces a database the app cannot
run on. Rather than fake the missing 53 tables into a history that never ran,
`0000_otoapp_baseline` is a single generated migration for a fresh database,
and the original chain is kept, unapplied, in `pre-platform/` for whoever needs
to read how a table came to look the way it does.

The one thing this costs: the live production database was built by the old
chain plus `push`, so it is not at `0000` and never will be. Loading it onto
the platform is a restore-and-rename (`public` to `otoapp`), not a migration —
S2-17b owns that rehearsal. From that point on, both databases move forward on
the same numbered migrations.

## The SQL is unqualified on purpose

The 184 table definitions carry no schema. The migrator sets `search_path` to
`otoapp` on its one connection and every unqualified statement lands there,
which is why 184 table definitions did not have to be rewritten to move the app
onto a database it shares with the POS, the booth and the console.

Drizzle does not quite honour that on its own: for a table with no schema it
writes `CREATE TYPE "public"."x"` and `REFERENCES "public"."y"`, which ignore
the search path. **Every generated file therefore has `"public".` stripped
before it is committed** — 584 occurrences in the baseline. `script/migrate.mjs`
reads each journalled file and refuses to apply one that still qualifies a name
with `"public"`, so a forgotten strip stops the deploy instead of quietly
putting 65 enum types into the schema every other application reads first.

`otoapp.__drizzle_migrations` is the ledger, so the record of what ran lives
beside the tables it describes rather than in a `drizzle` schema shared with
the platform's own history.

## Adding one

```
npm run db:generate -- --name <what_it_does>
```

Then, before committing: strip `"public".` from the new `.sql`, read the SQL,
and check it is expand-only (`CONTRIBUTING.md`) — the database is shared and a
`DROP` or a `RENAME` here breaks whatever is deployed. Commit the `.sql`, the
new `meta/<n>_snapshot.json` and the updated `meta/_journal.json` together: a
snapshot left behind means the next `generate` diffs against a shape the
database no longer has and offers to undo the change.

Never `drizzle-kit push`. It has no migration to review and no record of what
it did.
