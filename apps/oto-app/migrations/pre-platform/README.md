# The migration history the app arrived with

Nothing here is applied, and nothing here should be added to. The migrator
reads `../meta/_journal.json`, which lists only the baseline and what came
after it; these files and their `meta/` are inert.

They are kept because they are the only written record of how a table came to
look the way it does — when a column was added, what a rename replaced, which
shapes were tried. That record is worth reading when a column's purpose is not
obvious. It is not worth running: 53 of the app's 184 tables never appear here
at all, and 14 of the 25 files are not in the journal, so replaying the chain
builds a database the app cannot start on. `../README.md` sets out the counts
and why the history starts again.

Three more hand-written files from the same period sit in `server/db/`
(`0005_beo_bar_plans.sql`, `0006_kid_turning_age.sql`,
`0007_fix_dept_assignment.sql`). They were never in a journal either and are
left where they were found.
