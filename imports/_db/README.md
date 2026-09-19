# imports/_db/ — production schema and data dumps (LOCAL ONLY)

Drop the existing system's Postgres **schema** and **data dump** files here.

- Everything in this folder except this README is **ignored by git**, so a dump
  placed here cannot be committed or pushed to GitHub by accident.
- These files contain real customer, children's and staff data. They are
  restored into the **local Docker Postgres** on this machine for profiling and
  migration rehearsals, and never uploaded anywhere. Loading a copy into staging
  is a deliberate, owner-approved step: staging then sits behind the sign-on
  with outbound SMS and email switched off.
- Note: this project folder is synced by OneDrive, so files here are also
  uploaded to your OneDrive. If you would rather avoid that, put the dump in a
  folder outside OneDrive (for example `C:\oto-data\`) and tell Claude the path.

## What is here (2026-09-19)

| File | What it is |
|---|---|
| `data-structure-only-for-oto-app.sql` | OTO App schema, Navicat export from the RDS catalog `oto_staging` (PostgreSQL 16.13). 184 tables, 65 enums. |
| `db-structure-with-data-dump-for-oto-app.sql` | Same database with data (33 MB, plain `INSERT`s). **Live production data** up to the export date. Hard-codes `"public".` in every statement. |
| `database-schema-for-oto-radar.sql` | Radar **structure listing only** (drizzle-kit style). Not restorable as-is, no data, no triggers, no grants. |

Still needed: a real dump of Radar's *published* Replit database and of the
wheel's database; for cutover rehearsals a `pg_dump -Fc` of OTO App instead of
the Navicat file.

## Suggested names

```
imports/_db/
  schema-YYYY-MM-DD.sql          pg_dump --schema-only
  data-YYYY-MM-DD.dump           pg_dump -Fc   (custom format, preferred)
  data-YYYY-MM-DD.sql            plain SQL also fine
  NOTES.md                       Postgres version, which apps/databases it covers, date taken
```

## At cutover

The same procedure is repeated with a fresh dump taken at switch-over time:
load the dump, run the (re-runnable) post-import script, verify counts. The
rehearsal dumps here exist so that procedure is proven before the real day.
