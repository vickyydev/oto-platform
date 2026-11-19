# Family backfill runbook

SCRUM-1024, plan step F2. The plan is `FAMILY_PROFILES_PLAN.md` beside this file (section 3, steps B1 and V1). This page says how the two scripts are run on staging and later on production, in what order, what they print, how long they hold locks, and how to stop and resume.

**Nothing here has been run anywhere yet.** Running the backfill is a data job on a real database and needs the owner's go, first for staging and separately for production. No setting is changed by any of these scripts.

## 1. The two scripts

| Script | What it does | Writes? |
|---|---|---|
| `packages/db/scripts/family-backfill.ts` | Gives a family to every child saved before families existed. A dry run unless `--apply` is given. | Only with `--apply` |
| `packages/db/scripts/family-verify.ts` | The plan's four checks and a fifth (a member in more than one family), each with its count. Exits 1 when any count is above zero. | No |

Both print ids and counts only. None of them prints a name, a phone number or a care note. Each takes its database from the `DATABASE_URL` variable of the service it runs on.

The plan's shadow compare (section 3, R1: for every member, the children today's read gives beside the children the family read gives) is not one of them. It needs the family read rule, which is built with the readers in step F3, and it is run with that step.

## 2. What the backfill does

- It reads members in id order, in batches (200 members by default), and only members who have at least one child without a family. Archived members and archived children are included.
- Each batch is one transaction. For each member in it:
  - if the member has no family yet, it makes one (source `backfill`) with that member as its only guardian;
  - if the member already has one family whose only guardian is that member (a child saved since the release that added families made it), it uses that family, so no member gets a second family;
  - if the member is in several families, or in a family that has another guardian, it changes nothing and lists the member as "needs a hand". Neither case can happen before a second parent can be added (plan step F4).
- Then it sets `family_id` on that member's children who have none. A child that already has a family is never touched. The child's `updated_at` is not changed.
- It never puts two members in one family.
- It writes one audit row per batch and park group (`family.backfill`, request id `script:family-backfill`), with the batch's member id range and its counts.
- A second run over a finished database writes nothing, not even an audit row.

## 3. When and in what order

The release that carries migration `0136_family_profiles` (its number may change at landing) and the family writers must be live on the api first. From then on every new child gets a family from the writer that saves it; the backfill is for the children saved before. A child saved by an old api instance during the deploy is picked up by the backfill like any other.

The migration itself holds a short lock on the children table: it adds two columns, builds two indexes and checks two foreign keys over `crm.child` in one transaction, and while it runs a till's lookup of children waits. At today's size that is well under a second, but a long-running read on the table would make the migration, and the tills behind it, wait for that read. So on production the release is deployed at a quiet hour too, as the backfill is.

Run the scripts in this order, each only after the one before printed what is expected:

1. **Backfill, dry run.** Read the totals. "needs a hand" should be 0.
2. **Backfill, applied** (`--apply`). On production, first with `--max-batches 1`, then read the batch line and the verify output, then run again without it.
3. **Verify.** All five counts must be 0.

Only after step 3 is clean may anyone ask the owner to switch any reader to the family (plan step F3), and that is a separate go. Step F3 brings the shadow compare, which must report no difference before its readers are switched on.

## 4. How to run them

### On staging

One-off jobs on the staging api service, from the repository root of a working checkout, with the helper that already runs staging jobs:

```
node scripts/agent/render.mjs job "pnpm --filter @oto/db exec tsx scripts/family-backfill.ts"
node scripts/agent/render.mjs job "pnpm --filter @oto/db exec tsx scripts/family-backfill.ts --apply"
node scripts/agent/render.mjs job "pnpm --filter @oto/db exec tsx scripts/family-verify.ts"
```

The job runs on the api image at the commit the service is deployed at, so the scripts exist there only once the release that carries them is live. The helper waits for each job and prints its log.

### On production

The same three commands, as one-off jobs on the production api service (by its name, from the Render dashboard or the same API call with that service), at a quiet hour after the park has closed. On production, step 2 is run twice: first with `--max-batches 1`, then without it.

### Options of the backfill

- `--apply`: write. Without it, nothing is written.
- `--batch-size <n>`: members per batch and transaction, 1 to 2000, default 200.
- `--start-after <member id>`: resume after this member. The summary prints the id to use. A plain re-run also resumes, because it only reads members who still have a child without a family.
- `--max-batches <n>`: stop after n batches.

## 5. What the output looks like

### Backfill

One line per batch, then a summary:

```
batch 1 (members after (the first) up to <member id>): members 200, families made 198, families reused 2, guardian rows made 198, children given a family 371, needs a hand 0, busy 0, locks held 61 ms
...
Family backfill, run <run id>: APPLIED
totals: members ..., families made ..., families reused ..., guardian rows made ..., children given a family ..., needs a hand 0, busy 0
finished: no member after the last batch has a child without a family.
```

- "families made" equals "guardian rows made" in every line.
- "families reused" counts members who already had their own family from a writer.
- A dry run prints `DRY RUN, nothing written` and no lock times.
- Exit code 0 means finished with nothing left over. Exit code 1 means a batch failed, a member needs a hand, a member was busy, the run stopped at `--max-batches`, or an argument was refused. Exit code 2 means the run could not start or could not read its next batch, for example because the database could not be reached; every batch committed before that stays.

### Verify

```
Family checks (each must be 0):
  1. children with no family: 0
  2. live families with no live guardian: 0
  3. children whose family's live guardians are not exactly the child's own member: 0
  4. rows whose family, guardian member and child member disagree on the operator: 0
  5. members who are a live guardian of more than one live family (until step F4): 0
ALL ZERO
```

Check 2 counts live families only: linking two records later (plan step F5) archives a family together with its guardian row, so an archived family rightly has none. Check 5 is not one of the plan's four: a member with two families of their own, the children split between them, passes checks 1 to 4, and it is the fault the writers and the backfill are built to prevent. From step F4 a member may rightly be in several families, and check 5 is retired then. When a count is above zero, up to 20 row ids are printed under it (`--sample <n>` for more).

## 6. Locks: what a batch holds, and for how long

- A batch locks its members, then their children who have no family, with `FOR NO KEY UPDATE SKIP LOCKED`, and holds those locks until it commits.
- **It never waits for the till.** A member or child that a till is changing at that moment is skipped, counted as "busy", and left for the next run. So the backfill cannot be one side of a deadlock, and a stuck till cannot hold the run up. Any other lock it needs is given up after 5 seconds (the batch then fails and rolls back), and any statement after 10 seconds.
- **What waits for a batch:** a write to one of the batch's members or children, for at most the length of that batch's transaction. That is an edit of the member or the child (at the till, on a box's replay, on the booking site, or of a saved child on the check-in board), adding a member's first child, a removal, and confirming a visit's children, which stamps each child's last confirmation (at the till and on a box's replay).
- **What does not wait:** lookups, sales, bands and anything else that only reads those rows or refers to them, and adding a child to a member who already has a family.
- **How long:** each applied batch prints "locks held" in milliseconds. On a laptop's test database, a batch of 200 members with two children each held its locks for 40 to 75 ms, 500 members for 75 to 125 ms, and 1000 members for about 150 ms. On Render each statement adds the network round trip; a batch makes about ten statements inside its transaction. If a production batch line ever shows more than a second, stop the job and run again with a smaller `--batch-size`.

## 7. Stopping and resuming

- **To stop:** cancel the job in the Render dashboard at any moment. The batch in flight rolls back whole; every batch before it stays committed and audited.
- **To resume:** run the same command again. It starts from the first member who still has a child without a family. `--start-after <member id>` (printed in the summary) only saves re-reading the members before it.
- **A failed batch** stops the run and prints `STOPPED: batch <n> failed and was rolled back whole` with the database's own message. Nothing of that batch was written. Find the cause, then run again.
- **Busy members** (the till held them during their batch): run again; the summary lists them.
- **Members that need a hand** are listed by id. They are not changed by any re-run. Look at them with the owner before anything is done; they are not expected before plan step F4.

## 8. When a check is not zero

| Check | What it means | What to do |
|---|---|---|
| 1. Children with no family | The backfill has not finished, a member needs a hand, or an old api instance saved a child after the run. | Run the backfill again. If the count stays, look at the listed children's members (needs a hand). |
| 2. Live families with no live guardian | A family nobody can see. Not expected from any writer or from the backfill. | Stop. Report the ids; do not switch readers. |
| 3. Children whose family's guardians are not exactly their own member | A family with a second guardian, or a child in someone else's family. Not expected before step F4. | Stop. Report the ids. |
| 4. Operator disagreement | A row crossing park groups. | Stop at once and report: this is the fence the whole design stands on. |
| 5. A member in more than one family | Two families of one member, each holding only that member. Not expected from any writer or from the backfill before step F4. | Stop. Report the member ids; do not switch readers. |

## 9. Undo

Before any reader uses the families, nothing reads the rows the backfill made, so they can simply be left. Withdrawing the whole step is the migration's undo file, `packages/db/migrations/undo/0136_family_profiles.sql` (renumbered with the migration), run by hand as one transaction as the undo folder's README says; it removes the two tables and the two child columns and everything in them, and the way back from it is a new forward migration.
