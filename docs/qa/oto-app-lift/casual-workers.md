# SCRUM-462: Casual-worker access and dates

The casual-worker page is manager-only, but its prior API allowed any signed-in account to list and read workers, including daily rates, across branches. Every casual-worker read and write now uses the signed-in tenant, manager role and permitted branch. A specific worker must belong to that tenant and an accessible branch; branch, department and role references on create or edit must belong to the same tenant. Scheduling lookup requires one valid day or a valid date range and an accessible branch. Invalid dates, reversed periods and non-integer or non-positive daily rates are refused before storage.

The page now uses the branch context's current name and evaluates a worker's start/end dates as inclusive calendar dates, so the worker remains active through the end date. The daily-rate form submits a number without truncation and only accepts a positive whole-baht value, matching the database's integer column.

The production build passed. App typecheck remains at 542 inherited errors with none in the edited casual-worker files, and scoped ESLint is clear. There is no existing casual-worker test file. A local signed-in route probe did not run because the command environment rejected test-server startup.

On 30 September, the documented administrator signed in through the suite launcher and opened Central Floresta scheduling and `/employees/casual`. The page reported zero workers. The real, reviewed staging screenshot `scrum-462-staging-casual-workers-page.png` is attached to SCRUM-462 and the parent story. It replaces the prior capture limitation; the older test-run card remains labelled as such. With no worker row on this branch, rate, write, cross-branch and lower-role cases remain. SCRUM-462 stays Testing.
