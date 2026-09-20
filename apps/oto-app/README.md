# OTO App

The park's HR and daily-operations system, lifted onto this platform (S2-17).

This is a **working copy, not a reference copy**. The read-only export it came
from stays at `imports/oto-app/` and is never built or deployed; from here on
the app is maintained in this repository and deployed from it.

## What was left behind

The export carries 619 MB of `attached_assets`, plus `uploads/`, `pdfs/`,
`profile-photos/` and `fix-media/` — runtime output and real uploads from the
live system, none of which belongs in a repository. The Vite build does not
reference any of it (`@assets` is aliased but unused), so the copy is the
source only. Files the app writes at runtime are gitignored here.

Two scripts were deliberately **not** copied, and must never be added:

| Script | Why |
|---|---|
| `scripts/post-merge.sh` | Runs `drizzle-kit push --force`. Against the shared platform database that is a schema-destroying operation with no migration to review. |
| `script/db-reset.sh` | `DROP SCHEMA public CASCADE`. |

The app's schema is changed the way every other schema here is changed: a
generated SQL migration, committed, forward-only, applied by a migrator. See
`migrations/`.

## Where it runs

Its tables live in schema `otoapp` of the platform database. The app emits
unqualified table names, so the schema is selected by `search_path` on its
database role rather than by qualifying 184 table definitions.

## Toolchain

It keeps npm and its own `package-lock.json`, and is excluded from the pnpm
workspace (`pnpm-workspace.yaml`). Render builds it from its `Dockerfile`.
Commands inside this directory use `npm`, not `pnpm`.
