# imports/_db/ — production schema and data dumps (LOCAL ONLY)

Drop the existing system's Postgres **schema** and **data dump** files here.

- Everything in this folder except this README is **ignored by git**, so a dump
  placed here cannot be committed or pushed to GitHub by accident.
- These files contain real customer, children's and staff data. They are only
  ever restored into the **local Docker Postgres** on this machine for
  profiling and migration rehearsals — never into staging or production as-is,
  and never uploaded anywhere.
- Note: this project folder is synced by OneDrive, so files here are also
  uploaded to your OneDrive. If you would rather avoid that, put the dump in a
  folder outside OneDrive (for example `C:\oto-data\`) and tell Claude the path.

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
