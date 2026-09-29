# Undo notes for applied migrations

A migration written with its own reverse block, as `0025_voucher_line_labels.sql`
was, carries it from the start. One that was applied without gets its notes here,
beside it, under the same file name — never inside the applied file.

Why beside, not inside: `drizzle-kit migrate` (the `migrate` script of `@oto/db`)
opens each migration by its journal tag, runs it, and stores the SHA-256 of the
file it ran in `drizzle.__drizzle_migrations` (`drizzle-orm/pg-core/dialect.js`,
`migrate`). It never compares that hash again — what runs next is decided by the
journal's `when` against the last row's `created_at`, a high-water mark — but
the stored hash is the record of what staging and production executed, and an
edited file, even by a comment, is a file that record no longer describes. The
rule is older than that detail: migrations are forward-only and never edited
once applied (`docs/architecture/DEVELOPMENT_PLAN.md`, "Migrations").

What the migrator does with this folder: nothing. It reads only the files the
journal names, and nothing here is in the journal; `verify-schema` and
`snapshot` read `meta/` alone. Each file here is run by hand, by a person, as one
transaction (`psql "$DATABASE_URL" -1 -f <file>`), as its header says, after
reading what it says is not reversible.

After an undo, the migration's row stays in `drizzle.__drizzle_migrations`, and
so do the rows of anything that went with it. Deleting a row would change
nothing: the migrator re-applies nothing below its high-water mark. The way
forward from an undone migration is a new forward migration that puts back what
is wanted — not a re-run of the old file.

| Migration | Notes | Goes with it |
| --- | --- | --- |
| `0021_voucher_redemption` | `0021_voucher_redemption.sql` | 0023 (the ledger's TRUNCATE trigger), 0024 (the throttle's code hashes) |
| `0022_booth_staff_session_and_voucher_wording` | `0022_booth_staff_session_and_voucher_wording.sql` | — |

Both files were run against a database built from every migration up to 0034,
and the schema they left matched, object for object, a database built from a
journal without 0021–0024 (SCRUM-423, 30 September).
