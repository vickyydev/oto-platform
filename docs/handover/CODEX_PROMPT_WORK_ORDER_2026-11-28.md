# Prompt for a fresh Codex chat — the work order of 28 November 2026

The owner pastes the block below into a new Codex chat that has no context. The plan itself is
`docs/handover/CODEX_WORK_ORDER_2026-11-28.md`.

```text
You are taking over a work order on the OTO platform (repository vickyydev/oto-platform). You start with no context: everything you need is written down. I am the owner. Read first, then work.

AUTHORISATION (my own words, 28 November 2026): I approve the work in docs/handover/CODEX_WORK_ORDER_2026-11-28.md and I hand it to you with full accountability for the result. You may run several agents in parallel and use workflows. Stop for my yes only at the gates in its section 10.

START
1. The folder you start in (Desktop/Projects/oto-pos) is a stale copy. Do not build in it and never reset or clean it. Run "git -C C:/oto-lanes/closing-checklist-20261125 fetch origin", then make a fresh worktree from origin/main under C:/oto-lanes/ (for example C:/oto-lanes/workorder-20261128 on a new branch lane/workorder-20261128).
2. In that worktree read, in this order: AGENTS.md; docs/handover/CODEX_WORK_ORDER_2026-11-28.md (the work order: it is the plan, and it wins where it is more specific); the newest blocks of docs/progress/STATUS.md; docs/handover/CODEX_HANDOVER.md; CONTRIBUTING.md.
3. Check section 1 of the work order against the real systems (git, "node scripts/agent/render.mjs status", Jira through scripts/agent/jira.mjs) and tell me in ten lines what you found, with anything that differs.
4. Then start. Stream A first and alone. Then streams B, C, D (its read-only parts and the rehearsal), E and F side by side, one lead agent and one worktree each. Land onto main one at a time.

THE WORK, one line each (the work order has the detail)
A. Remove the staff number endings from pull request 15 and merge it; merge pull request 14; bring four ticket state lines up to date.
B. Make main's automatic checks pass again (about 45 failing tests in four groups).
C. SCRUM-1061: the sign-in page says plainly why no code is sent, and shows the code step only after a code was really sent. Staging first.
D. Bring the live HR app to the build staging has run since 26 November (the BEO fixes of 23 November and the payroll fixes), with a rehearsal on a copy of the live data, a backup and a way back.
E. SCRUM-1076: the booth voucher bonus, counted from the booth and till records, with one settings card in Payroll Setup (rate, time limit, start date, a different rate for a person). The flyer clauses of SCRUM-1075 use the same count.
F. SCRUM-1075: my answers of 28 November (the 0.2% rate, which park "total revenue" means, the childcare pool), on staging.

STOP AND ASK ME, one short message each, in plain words
- G2: before the push that turns main green. Automatic deploy is on for all ten staging services, so that push moves all of staging to main by itself.
- G3: before the live HR app deploy, with the pre-deploy note the work order describes.
- G4: before any production deploy for SCRUM-1061.
- G5: anything the work order does not cover.

NOT YOURS: the gates, the counter boxes and the Pi (I finish those at my next park visit); building face clock-in (its plan is not approved); the automatic-deploy setting (SCRUM-1079 is on hold).

RULES THAT CANNOT BEND
- Staging takes real money. Test sales in cash only. Never a QR or card payment unless I say so. Never Close Day. Never void or refund a sale older than today. Never send a message from the staging inbox.
- Production is read-only until I pass a gate.
- Never print or write a secret's value, a staff phone number or its ending, or a person's pay. Hide names and numbers in every picture. Pictures of the live app go on the Jira ticket only, never into the repository.
- No attribution lines in commits. Commit format as CONTRIBUTING.md says. Never force-push, reset or clean. Never move a ticket to Done. "Deployed" needs a staging picture on the ticket.
- Keep the laptop responsive: check free memory before heavy jobs and keep about 3 GB spare.

REPORTING
- The same turn as every push: a dated block at the top of docs/progress/STATUS.md, the resume note in docs/handover/CODEX_HANDOVER.md, and a plain-words comment on the ticket. Rewrite the "Decision and state" lines of the ticket's description at every landing. Name every ticket with its title.
- When a stream is done or stopped, tell me what is done and proven, what is not and why, the decisions you made, and numbered questions with your recommendation first.

Begin with step 1.
```
