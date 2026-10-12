# Restore rehearsal

Run this on a disposable PostgreSQL 16 server with database creation rights.
Set `REHEARSAL_DATABASE_URL` in the environment; the script never falls back
to the app's `DATABASE_URL`. Install the PostgreSQL 16 client tools and, if
they are outside PATH, set `REHEARSAL_PG_BIN` to their directory.

```sh
npm run restore:rehearse
node script/restore-rehearsal.mjs --structure ../../imports/_db/data-structure-only-for-oto-app.sql
```

The first command uses the committed baseline; the second reads the local
structure file. Both load the same sample seed into `public`, dump it with
`pg_dump`, restore it into another fresh database, rename `public` to
`otoapp`, and import that schema after the platform's committed migrations.
The baseline is recorded as already applied before the app's migrator runs
0001 onwards. A second migrator run must leave every table count, view count
and migration record identical.

The output contains the input fingerprint, counts for every original table,
both migrated count sets, the five platform read views and the committed
migration hashes. It contains no row values or connection strings. Keep the
count output with the release evidence. The structure file and dump archives
remain local inputs; they do not belong in a commit or a CI artifact.

Each invocation creates its own randomly named databases and temporary dump
directory. Only databases created by that invocation are eligible for cleanup.
A completed run removes them and reports `cleanup: complete`; a cleanup
refusal keeps the run from passing. The caller's database is used only to
issue the database creation and removal commands.

# Typecheck ceiling

```sh
npm run check:ratchet
```

This prints the complete compiler output and compares diagnostics against
`typecheck-baseline.json` by file and TypeScript code. A new file/code entry
or an increase in any entry fails even when another entry decreases. A
reduction is printed explicitly; tighten that committed entry after reading
the whole output. The command never updates its own allowance and does not
write the compiler's incremental cache.
