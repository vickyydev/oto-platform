# Work order for Codex — 28 November 2026

Written by the planning session on the owner's instruction of 28 November 2026. The owner asked
for this work to be handed to a fresh Codex session **with full accountability**: you own the
outcome of every stream below, from the first read to the proof on the ticket. `AGENTS.md` and
its absolute rules apply to everything here; where this file is more specific, this file wins.
`docs/progress/STATUS.md` (newest block) still wins on the live state.

Section 1 is the state on 28 November, read from the hosting settings, git and Jira that day.
Section 2 is the owner's decisions, word for word where it matters. Sections 3 to 9 are the
work. Section 10 is the gates where you stop for his yes. Section 11 is how to work and report.

---

## 1. State on arrival (verified 28 November 2026; verify again before you rely on it)

**Main** is `4313967f7` (26 November, a docs commit). Main's automatic checks have failed since
`06566b704` (23 November); the last green commit is `92264da39`.

**What each service runs**

| Service | Commit | Note |
|---|---|---|
| `oto-api-staging` | `c20754e98` | branch `staging/api-gate-language-1077`: main's server code by content, plus the administrator phone recovery that main does not have yet (PR #14) |
| `oto-app-staging` (HR app) | `6cd1569d7` | main of 26 November 17:01: every BEO change, the payroll fixes and the incentive clause reader |
| `oto-pos-staging`, `oto-pos-web-staging` | `2aaa5b2db` | 23 November |
| `oto-console-staging` | `0a1bf8fc6` | 26 November |
| `oto-inbox-staging`, `oto-launcher-staging` | `b7e002e1a` | 23 November |
| `oto-booth-staging` | `92264da39` | 23 November |
| `oto-radar-staging`, `oto-qa-worker-staging` | older | not touched by this work |
| `oto-app-production` (HR app, live) | `8870cabab` | branch `production/oto-app-stuck-clock-in-1074` = `92264da39` plus three back-ported fixes that main also has |
| `oto-api-production` | `5b9bf5b9a` | the administrator phone recovery on production's previous commit |
| `oto-launcher-production` | `669e1c00f` | 22 November |

**Automatic deploys.** All ten staging services have automatic deploy ON with the trigger
"checks pass". Nothing deploys by itself today only because main's checks fail. Production has
automatic deploy OFF. A docs-only push to main starts no checks and no deploy. SCRUM-1079,
"Staging: deploy by name only, switch off automatic deploys from main", is **on hold by the
owner** (section 2). Read gate G2 in section 10 before the push that turns main green.

**Open pull requests**
- PR #14, branch `lane/admin-registered-phone-recovery`: administrator accounts recover through
  their registered phone (6 files). Its change is live on both servers from side branches and is
  the only server change main lacks.
- PR #15, branch `docs/park-work-reconciliation-20261125`: hand-over and park checkpoint
  documents (docs only). **Its takeover guide names four staff phone-number endings. They must
  be removed before it merges** (section 11, privacy).

**What the live HR app is missing compared with staging** (13 commits under `apps/oto-app`,
two migrations):
- 23 November: `62d796edb` deposits, additional bills and kitchen serving times; `bf60a2f36`
  blocked refunds and confirmed bookings; `b7e002e1a` deposit alerts, offline billing guard,
  tablet navigation; `8356e9345` a retryable answer when the till cannot verify an item;
  `276c694d3` tests.
- 25 November: `57cae3e5a`, `6817b1a37` shared checklist (already on production as back-ports).
- 26 November: `224aa3db1`, `b946a44c5` payroll run reasons (SCRUM-1073); `123edc36c` stuck
  clock-in (already on production as a back-port); `c0cfef571`, `aa24dfbab`, `5b309dd3a` the
  incentive clause reader (SCRUM-1075).
- Migrations: `0060_beo_adult_serving_time.sql`, `0061_payroll_incentive_clause_readings.sql`.

**Staging takes real money.** `oto-api-staging` runs the live payment gateway for Central
Floresta. A QR made on a staging till is a real one. See section 11.

**Jira, the tickets this work touches**
- SCRUM-1061 "Sign-in page: set-up and password reset say a code was sent when none was": To Do.
  Its description says "being built": it is not.
- SCRUM-1075 "Payroll: read each incentive clause with AI, approve the reading, and pay it from
  a rule": Deployed on staging; the owner answered its open questions on 28 November.
- SCRUM-1076 "Payroll: 10 baht per redeemed booth voucher to each staff member named on it,
  counted from the booth and till records": To Do; **approved to build** on 28 November.
- SCRUM-1056 "Face clock-in in the new app: staff enrol their faces again": To Do; a proposal
  was given to the owner in another Codex chat on 28 November and is **not approved**.
- SCRUM-1077 "Gate screen: show the messages in the language the guest chose at the till":
  Testing; its proof needs the park. SCRUM-68 "Integrate gate control and status": In Progress.
  **Gates are out of this work order** (section 9).
- SCRUM-921, SCRUM-922, SCRUM-923 (go-live follow-ups): their state lines are behind; see 3.3.

**Folders.** The checkout at `C:/Users/waqar/OneDrive/Desktop/Projects/oto-pos` is a stale copy
(hundreds of commits behind). Never build in it and never reset or clean it; it is only a place
to run the helper scripts in `scripts/agent/`. Work in fresh worktrees under `C:/oto-lanes/`
cut from `origin/main`. Many old lane folders are there, and five of them hold uncommitted
files (run `git status` in a folder before you touch anything in it). Leave them alone.

---

## 2. The owner's decisions of 28 November 2026 (do not ask again)

1. **Merge the two pull requests** after checking the earlier Codex work.
2. **Repair main's checks.**
3. **Fix SCRUM-1061.**
4. **The live HR app gets the latest staging HR app changes**: "carefully deploy the latest
   changes in the staging for the HR app to the production app without breaking anything and
   making sure that nothing affects the database or the flow."
5. **SCRUM-1079 is on hold**: "does not look so important for now".
6. **Face clock-in**: the plan is not approved; nothing is built.
7. **Gates**: tested at the park; "in the third visit, we will finalize everything for the
   gates". Nothing on the gates now.
8. **SCRUM-1075, his answers**
   - "Revenue" in a clause: keep it as payroll has it now (sales less VAT and service charge).
   - The clause written "0,002%" is really **0.2%**.
   - Flyer clauses pay 10, 15 or 30 baht "according to the setting", applied for that person,
     counted "by checking the number of vouchers redeemed, issued by the booth with her name on
     that slip, and the rate for that day". The count comes from the records, never typed.
   - "Total revenue": both parks when the clause says so; "if the person has only one park,
     then just mean that branch". It depends on the clause.
   - The nanny and drop-off bonus: "be smart and think like a business owner… be fair with the
     owner and be fair with the staff and set that rule up. The AI should be smart enough to
     handle it accordingly from the clause."
9. **SCRUM-1076: build it.**
   - Payroll counts from the records. Each named person gets the bonus in full. A voucher
     whose sale was refunded earns nothing. The report as proposed.
   - Vouchers are redeemed on the new till only. The old till is not connected and stops.
   - A setting for "the day rate of the booth on that date", recorded for the vouchers issued
     that day, so that when a voucher is redeemed the rate and the person can be fetched.
   - A flexible time limit: the bonus counts only if the voucher is redeemed within the same
     day, or within 24 hours, one week or one month, by a setting.
   - It counts in the month the voucher is redeemed. No minimum spend.
10. **How it should feel**: "be professional and make things user friendly. Not so many clicks,
    not so many boxes… with the modern methods"; "without making anything complicated or
    breaking anything".

He left the design of the settings to the planner ("decide it on your own and let me know").
Sections 7 and 8 hold those design decisions. They were told to him on 28 November. They are
the build. If the code shows one of them cannot work as written, stop on that point, say why in
one paragraph on the ticket, and propose the nearest thing that does.

---

## 3. Stream A — tidy the record and merge the pull requests

Small and first. One agent, one worktree.

3.1 **Read before merging.** The earlier Codex work of 21 to 25 November is recorded in
`docs/handover/CODEX_HANDOVER.md`, the top blocks of `docs/progress/STATUS.md`,
`docs/qa/proof-2026-11-2x/`, and on PR #15 (`docs/handover/CLAUDE_TAKEOVER_2026-11-25.md`,
`docs/progress/PARK_CHECKPOINT_2026-11-25.md`). The planning session's work of 26 November
(gate language SCRUM-1077, gate messages page SCRUM-1078, band details for the gate, payroll
SCRUM-1073, clock-in alerts SCRUM-1074, the clause reader SCRUM-1075) is in the top six blocks
of `STATUS.md`. Read them. Write a ten-line "state on arrival" note in your own words at the top
of your first report, with anything that differs from section 1.

3.2 **PR #15.** Remove every phone-number ending and any other personal detail from its files
(search the diff for digit runs next to a person or a role). Rebase on main, read the result,
merge. If a statement in it is out of date compared with section 1, correct it in the same PR.

3.3 **PR #14.** Rebase on main, run its own tests and the auth tests it touches, merge. Then
prove main now holds everything the two servers run: `git diff` the server and shared packages
between the new main and `staging/api-gate-language-1077`, and between main and the production
server's commit for the recovery files. Any real difference is listed on the ticket, not
ignored. From this point a deploy of main to a server no longer removes the recovery.

3.4 **Ticket state lines.** Bring the "State" line at the top of the description up to date on
SCRUM-921, SCRUM-922, SCRUM-923 and SCRUM-1061, from what the systems show today (read, do not
guess; a state you cannot verify is written as "not verified on <date>").

Done when: both pull requests are merged, no number ending is in the repository, the diff of
3.3 is recorded, and the four state lines are current.

---

## 4. Stream B — repair main's checks

Create one ticket in Sprint 2: "Main: the automatic checks pass again (failing since
23 November)". One lead agent; helpers may take one failure group each in their own worktree.

What failed on run 45506198603 (about 45 tests; read the newest failing run yourself first):
1. **About 20 tests tied to a date** that is now in the past (booking tests with a fixed visit
   date, a seeded holiday that is now current). Fix the tests so they cannot rot again: a fixed
   clock or dates worked out from "today". Do not change product behaviour.
2. **About 7 tests that meet the new guard** refusing "Reset demo data" once bank payment
   records exist (`GATEWAY_HISTORY_PRESENT`). The guard is intended. Change the tests to expect
   it, or give them a database without gateway history.
3. **About 12 text pins** on files that were rewritten (the till's drop-off form, the BEO routes
   hash, the template count 66 against 75). Never re-record blind: for each pin read the diff it
   guards, confirm the change was intended (name the commit), then update the pin. List every
   pin you changed, with its commit, on the ticket.
4. **Real faults, fix the product**: `route-write-conformance` reports one new write route
   outside a transaction (find it, put it in a transaction with its audit record); a missing
   `prebooking_deposit_request` template in `inbox-access-993-review` (find out whether the
   template is missing or the test is stale, and fix the true one); three type errors in
   `apps/api/test/s1070-shared-checklist-review.test.ts`.

The owner's lean rule holds: focused local checks per group, no review rounds, and nobody sits
watching the checks. The final proof here is the green run itself, read by full commit SHA.

**Before the push that turns main green, stop at gate G2 (section 10).**

Done when: one run on main is green, the ticket lists what was changed in each group, and the
staging services' commits after that push are recorded (G2).

---

## 5. Stream C — SCRUM-1061, the sign-in page tells the truth

The owner's decision of 21 November stands: the set-up and reset pages say plainly why no code
is sent and do not show the code step. An earlier comment on the ticket calls that decision
"open for review against account privacy": it is not open. Build it as decided.

- Today "Set up your account" and "Reset your password" answer ok and show the six-digit step
  even when no text message was sent (no account, an account already set up, a switched-off
  account, a number never confirmed).
- Build: one plain message for each case on the same step; the code step only after a code was
  really sent; the attempt limits stay exactly as they are.
- The stale uncommitted edits in `C:/oto-lanes/codex-inbox-feedback-20261116` are forty commits
  behind and touch files rewritten since. Do not build on them. Start from main.
- Staging first: the launcher and the server, by name, at the pushed commit. Proof: one picture
  per case on staging, with any phone number hidden, attached to the ticket.
- **Production is gate G4.** The live launcher and server carry real staff sign-ins.

Done when: the four cases are proven on staging with pictures, and the owner has been asked for
the production go with the exact commits it would deploy.

---

## 6. Stream D — the live HR app catches up with staging

This is the owner's answer to the BEO feedback: the park's birthday team tests on the live app,
which lacks the 23 November fixes. It is production and it holds the park's real staff,
attendance and party data. Treat it as the most careful piece of this work order. One lead
agent; one second agent re-checks 6.2 and 6.3 independently before the gate.

6.1 **Choose the commit.** The target is the commit the staging HR app runs
(`6cd1569d7`, proven on staging since 26 November), or a newer main commit only if the staging
HR app has run it first. Never a commit staging has not run.

6.2 **Read what it brings.** For each of the 13 commits (section 1): what a person at the park
will see differently, in one line each. For the two migrations: read the SQL; confirm they only
add (columns, tables, indexes) and never rewrite, drop or lock a large table; say how long they
take on the live data size.

6.3 **Check what it needs and what it could start.**
- Every call the new HR app code makes to the platform server: does the live server
  (`5b9bf5b9a`) answer it? Where it does not, the HR app must degrade without an error to the
  user (the 23 November "retryable" change exists for exactly this). List each call and result.
- Settings: list by NAME every setting the new code reads that the live HR app does not have.
  Never print a value. A missing key for the clause reader must leave payroll working and the
  reader saying it is not set up.
- **Nothing may start by itself**: no new scheduled job, no message to a guest or to staff, no
  payment request. The owner's go-live rulings stand (placeholder payments on production,
  scheduled jobs held). If the new code would send or charge on production, stop and report.
- The staging test rules and figures named "ZZ TEST" are data on staging only. Confirm nothing
  in the deploy carries them.

6.4 **Rehearse on a copy.** Restore the newest production copy of the HR app's data into a
scratch database on the laptop (`tools/data/restore-otoapp.mjs`, the Docker database
`oto-restore-pg`; the folders are under `C:/oto-data`; read `docs/progress/plans/go-live/`
first). Run the two migrations on it, start the target commit against it, open the sign-in, the
clock page, a party's BEO, the Day-of view and Payroll. Count the rows of the main tables
(employees, attendance punches, parties and their BEOs, payroll runs) before and after: the
counts must be equal. Then run the OLD commit (`8870cabab`) against the migrated copy: it must
still start and work, because that is the way back.

6.5 **Gate G3: the pre-deploy note to the owner** (section 10). Deploy only on his yes.

6.6 **Deploy.** Take a fresh backup of the live HR app's database and write down where it is and
how to restore it. Deploy `oto-app-production` by name at the chosen commit. Watch it go live.

6.7 **Verify on the live app without changing the park's data.** The status address answers
with the new commit; sign-in works; an existing party's BEO opens with the new fields; the
Day-of view opens; Payroll opens; the registered tablet's clock page loads. **Never clock a real
person in or out, never save a party, never run or lock a payroll, never send a message.** Count
the same tables again: equal to before, apart from what staff did meanwhile.

6.8 **The way back.** If anything is wrong: redeploy `8870cabab` at once (the rehearsal proved
it runs on the migrated data), tell the owner, write what happened on the ticket.

6.9 **Record.** One ticket in Sprint 2: "Live HR app: the BEO fixes of 23 November and the
payroll fixes reach production". Proof pictures go on the ticket only, with every person's name
and number hidden; **pictures of the live app are never committed to the repository**. Then a
short note for the birthday team, in plain words, of what is different, and a request to test
again on the live link. Their notes come back as tickets, one per point, each answered as
works, broken or not built.

Done when: the live HR app runs the chosen commit, the counts match, the ticket holds the proof
and the way back, and the note to the birthday team is written for the owner to forward.

---

## 7. Stream E — the booth voucher bonus (SCRUM-1076, and the flyer clauses of SCRUM-1075)

One bonus, one way to count it, for both tickets. Staging only. Nothing here goes to production
without the owner's word.

### 7.1 What it is

Every voucher printed at the sales booth carries the staff on duty that day. When a guest uses
that voucher on the new till and the sale is paid, **each person named on it earns the bonus in
full** (two people named, ten vouchers used: each earns ten times the rate). Payroll works it
out from the records. Nobody types a count.

### 7.2 The setting (design decision of the planner, told to the owner)

**One card, "Booth voucher bonus", in the HR app under Payroll > Payroll Setup > Service charge
& incentives**, beside the other incentives, because that is where the people who run payroll
already set bonuses and where a person can approve a change with a reason.

The card has three things and nothing else:
1. **Bonus per used voucher**: an amount in baht (it starts at 10).
2. **Counts if the voucher is used within**: one choice of *the same day*, *24 hours*, *7 days*,
   *30 days*, *any time*.
3. **From**: the date the rule starts.

Below it, folded shut by default, "**A different rate for a person**": a short list of person
and amount. It is filled from each person's approved contract clause (the 10, 15 and 30 baht
clauses), so nobody types them twice. A person without an own rate gets the card's rate.

Rules behind the card:
- A rule is dated. Changing it never rewrites the past: it adds a new rule from a date. The card
  shows the rule in force and a small list of earlier ones. Saving asks for a reason, as the
  other payroll settings do.
- **The rate and the time limit that apply to a voucher are those in force on the day the
  voucher was ISSUED.** This is the owner's "day rate of the booth on that date".
- The first time payroll counts a voucher for a person, it saves that voucher's bonus as a row
  (voucher, person, rate, time limit, issue time, use time, sale) and never changes it again.
  A later change of the rule cannot alter a bonus already counted.
- "The same day" is the park's day in the branch's own time zone. "24 hours" is by the clock
  from the moment of issue. "7 days" and "30 days" are park days.
- The booth box and the till hold no pay rate. They record who was named and when; the rate
  lives in payroll.
- The Console's booth page shows the rule in force as one read-only line with a link to the
  card, so a booth manager can see it without a second place to edit it.

### 7.3 What must be recorded (check first, add only what is missing)

Read the code before building. Confirm or add each of these, with the smallest change:
1. **The day's roster names real people.** Each roster entry links to the person's employee
   record, chosen from the staff list, while the slip keeps printing the short name it prints
   today. A roster entry that is only a typed name cannot earn a bonus.
2. **Each printed voucher keeps who was named on it**: the employee records of the roster at the
   moment of printing, the booth, the park and the time. The owner's words: "as we are saving
   that person's name on the slip", save the person too.
3. **Each use of a voucher at the till links back to that voucher** and to the sale that used
   it, with the time and the sale's state.
4. **Payroll can read it**: per person and month, the vouchers used in that month whose slip
   named them. The HR app and the platform already talk to each other (the party bills and the
   till, the BEO serving times). Use the bridge that exists. Do not make a second one. If
   nothing fits, write the smallest proposal on the ticket before building it.

Old vouchers printed before the roster was linked to employee records: match them by the saved
name where it is unambiguous; list the rest for a manager as "name not matched to a person".

### 7.4 The count

A voucher earns its bonus for a named person when all of these hold:
- it was used on the new till and the sale that used it is paid;
- the sale is not voided or refunded;
- it was used within the time limit in force on its issue day;
- the named person is linked to an employee record.

It counts in the month it was **used**. There is no minimum spend.

Edge cases, decided:
- Nobody on the roster: no bonus; listed for a manager.
- A named person with no clock-in that day: paid as printed, flagged for a manager's look.
- A sale refunded or voided **before** the month is locked: not counted.
- A sale refunded **after** the month was locked and paid: nothing is taken back
  automatically; it is listed in the next month's report as "refunded after pay" for a manager
  to decide. (Fair to staff, visible to the owner.)
- One voucher used twice cannot happen at the till; if the records ever show it, it counts once.

### 7.5 What payroll shows

- In Run Payroll > Check the month: one line per person, "Booth voucher bonus", with the count
  and the sum, and the orange "!" the contract bonuses already carry. Opening it lists the
  vouchers behind it: issue time, use time, the rate.
- One report, per person and month: vouchers issued with their name, used inside the time
  limit, used outside it, the share used, and the total and the average spend of those sales.
  A second view by booth and day. No guest's name or number in it.

### 7.6 The flyer clauses (SCRUM-1075) join this

- The clause reader reads "an amount per returned flyer" as **Booth voucher bonus at that
  person's rate, counted from the booth and till records**, and says so in plain words on the
  card. Approving it puts the person's rate into the card's "different rate for a person" list.
- The typed monthly count of returned flyers and the shared pool per rate that staging has
  today are **retired for these clauses**, so nothing is paid twice. The approved readings on
  staging that use the pool are converted, with a reason naming the owner's decision of
  28 November.
- The contracts say "divided by the Sale Booth Team". The owner's rule of 28 November is that
  each named person earns it in full. The system follows the owner. Put one line on the review
  card for these clauses: "Paid in full to each person named on the voucher (owner,
  28 November 2026); the contract wording says divided by the team", so HR can bring the
  contract text into line.

### 7.7 Proof

On staging: issue vouchers at the staging booth under a roster of two test people, use some on
the staging till **paid in cash** (never QR or card), refund one, let one fall outside the time
limit, change the rule from a date and issue again. One month's Check the month must match a
separate count made by a second agent from the raw records, to the baht. Pictures with names
hidden on SCRUM-1076. Read section 11 on staging sales first: the park's counter box prints for
some staging stations.

Done when: the card saves a dated rule, the four records of 7.3 exist, the month matches the
separate count, the report shows the spend, and the flyer clauses read as this bonus.

---

## 8. Stream F — the other clause answers (SCRUM-1075)

Staging only. Small. It shares files with stream E in the HR app, so give both to one lead or
land them one after the other.

1. **Revenue** stays sales less VAT and service charge. Remove that question from the card.
2. **The clause written "0,002%"**: the owner confirmed the rate is **0.2%**. Correct the
   reading by hand with the reason "owner, 28 November 2026: the rate is 0.2%", approve it, and
   show a line on the card that the clause text on the profile should be corrected by HR (when
   it is, the card will ask for a new reading, which is right).
3. **Which park "total revenue" means.** The reader decides from the clause and says it in plain
   words on the card, and the approver can change it with one control:
   - the clause says both, combined or all parks: both parks together;
   - the clause names a park: that park;
   - the clause says neither: a person assigned to one park gets that park; a person assigned to
     more than one, or to the whole company, gets both.
4. **The nanny and drop-off bonus** (the planner's rule, asked for by the owner as fair to both
   sides, told to him on 28 November):
   - One **Childcare Team pool per park per month**: 20% of that park's nanny and drop-off sales
     (less VAT and service charge). The 20% is the rate the park's own nanny clause states.
   - The members are the people whose approved clause names the nanny or drop-off bonus and who
     worked in childcare at that park in that month.
   - It is shared **by days worked in childcare** that month (from the shifts in the childcare
     department; if the records cannot tell childcare days apart, from the days the person
     clocked in, and the card says which was used).
   - A clause that names the bonus **without a rate joins the same pool**. It never makes a
     second pool and never adds cost.
   - A person named in two clauses is in the pool once. A person with no days gets nothing.
   - The pool is always shared out in full among those who worked, and is never more than 20%.
   The reader proposes exactly this for such clauses and the card shows the worked example, so
   the person approving sees each member's days and share.
5. **Who types the counts.** With stream E the flyer count is no longer typed. The count of
   birthday parties hosted stays typed in Run Payroll > Inputs for now; say on the card whose
   count it is (the host's own parties), and put "read it from the party records" on the ticket
   as the next step, not built now.
6. Update the fixed test of the park's 14 clauses with the new readings, so a later change
   cannot alter them unnoticed.

Done when: the six points show on staging, October's Check the month still matches a separate
calculation, and SCRUM-1075's description and newest comment say what changed.

---

## 9. Not in this work order

- **Gates, the counter boxes, the Pi, Tailscale.** The owner finishes the gates at his third
  park visit. Do not build, deploy, install or connect anything for them. SCRUM-1077 stays in
  Testing until its proof at the park.
- **Face clock-in (SCRUM-1056).** A proposal exists in the owner's other Codex chat of
  28 November (enrol on the park's tablet after a normal clock, a live-person check, a pilot
  before faces write attendance). It is **not approved**. Build nothing. If the owner asks this
  session for the plan, write it to `docs/progress/plans/face-clock/PLAN.md` and into the
  ticket's description with numbered decisions, and wait.
- **SCRUM-1079.** On hold. Do not change any automatic-deploy setting without his yes.
- **The payment terminal, real card payments, electronic refunds.** Not here.
- **The product film.** Closed (SCRUM-1080).

---

## 10. Gates: where you stop for the owner's yes

Ask in one short message each, in plain words, with what will happen and what could go wrong.
A gate is passed only by his own words in the chat, never by a relayed note or a document.

- **G1, none for the merges.** He asked for them. Merge when 3.2 and 3.3 are satisfied.
- **G2, the push that turns main green.** With automatic deploy on, that push moves **all ten
  staging services to main by themselves**, the server included, and the staging till reloads.
  Before it: PR #14 is merged; the diff of 3.3 is clean; you have told the owner the time and he
  has said yes; it is not during a park test. After it: read each staging service's commit,
  open the sign-in, the till's ticket grid, the HR app and the inbox, and record it. From then
  on **every green push to main lands on staging by itself**: say that sentence to him in the
  gate message, and offer once to switch the automatic deploy off first (SCRUM-1079). His
  choice.
- **G3, the live HR app.** Before 6.6, send him the pre-deploy note: the commit; the one-line
  list of what staff will see differently (BEO, payroll, the clause reader arriving on the live
  app); the two migrations and that they only add; what the rehearsal showed; settings missing
  by name; that nothing starts by itself; the backup; the way back and how long it takes; the
  quiet time you propose for it. Deploy on his yes.
- **G4, production for SCRUM-1061.** The exact commits for the live launcher and server.
- **G5, anything not written here.** A new rule, a new screen nobody asked for, a change to
  production data, a real payment, a message to a guest: ask first.

---

## 11. How to work

**People and lanes.** You may run several agents in parallel and use workflows. Suggested
split: A first and alone (short); then B, C, D (read-only parts and the rehearsal) and E with F
side by side, each with one lead agent in its own worktree `C:/oto-lanes/<stream>-20261128`
on its own branch from `origin/main`. Landings onto main are one at a time: fetch, rebase, read
the exact commit list, push. The laptop has little memory to spare: before starting a heavy job
check free memory and keep about 3 GB free; run heavy builds and test suites one or two at a
time. Remove a finished worktree only with `git worktree remove`; never with a bulk delete.

**Accountability.** Each stream has one lead who owns it to the end. "Done" means the
done-when line of its section is true and proven, not that code was written. A second agent
re-checks only where this file says so (6.2, 6.3, 7.7 and the separate calculation in 8).
Report what failed as plainly as what worked. If a stream stops, the ticket and
`STATUS.md` say exactly where, the same turn.

**Records, the same turn as every push.** A dated block at the top of
`docs/progress/STATUS.md`; the resume note of `docs/handover/CODEX_HANDOVER.md`; section 2 of
`docs/handover/CLOUD_HANDOVER.md` at a landing; a status check and a plain-words comment on the
ticket, written for someone who is not an engineer. "Deployed" needs a staging picture attached
to the ticket and named in the comment. Nothing is ever moved to Done. Rewrite the
"Decision and state" lines of a ticket's description at approval and at every landing: the
owner reads the description first. Every ticket number you name to him carries its title.

**Commits.** `CONTRIBUTING.md`: `type(scope): summary`, bullet body, `Refs:` footer. No
attribution line of any kind. Write about the system, never about the commercial arrangement.
Commit by explicit file list. Never commit `imports/`, `.env` or `services/`. Never force-push,
reset or clean.

**Privacy, absolute.**
- No secret or setting VALUE anywhere: names only. The owner types every secret himself.
- No staff phone number and no ending of one, in the repository, Jira, a report or the chat.
  No real person's name in a picture: hide names and numbers before you take it.
- No photo of a child, no signature, no staff photo, no contract, in the repository or Jira.
- No salary or pay amount of a person in the repository or Jira. Rates written in a contract
  clause are already part of the fixed clause test and may be named as rates.
- Pictures of the live app go on the ticket only, never into the repository.
- The earlier Codex chat record contains phone numbers and may contain temporary passwords:
  if you read it, mask digits before printing anything from it. Never open the hand-off files
  in the owner's Downloads folder.

**Staging takes real money.** Test sales are paid in **cash** only. Never make a QR or card
payment unless the owner asks for one in his own words. Cancel an unpaid attempt at once. Never
Close Day. Never void or refund a sale older than today. Use the test stations; a sale on the
station that is paired with the park's counter box prints real wristbands at the park, so read
which station you are on before you sell. The staging inbox may reach real guests: never send a
message from it.

**Production.** Read-only unless a gate above was passed. Never deploy main to a production
service on your own judgement. The stored production administrator password on the laptop is
out of date: do not try it.

**The final report to the owner**, when the streams are done or stopped: for each stream, what
is done and proven (with the ticket and its title), what is not done and why, each decision you
made that he did not make, and the questions that remain, numbered, with your recommendation
first.
