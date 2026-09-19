# Sprint 2 in Jira — board state and ticket map

_Created 2026-09-20. Site `oto-suite-dev.atlassian.net`, project **SCRUM
("Oto Suite")**, board 1. The plan text lives in
`SPRINT_2_PLAN.md`; this file only records where each ticket went and what was
done to the pre-existing board, so nobody has to re-derive it._

## The sprint

**Sprint 2 - Complete build** (sprint id 3, state *future* — start it when you
are ready). Goal as set on the sprint:

> All remaining software: POS complete with the Lucky Wheel booth on real
> device simulators and real 2C2P sandbox QR; OTO App, Radar and the Inbox on
> the central database with one sign-on; the owner Console; the client
> production data restored; box image and the on-site bring-up runbook. After
> this sprint: on-site testing with the real devices, not more development.

24 stories are in it. Sprint 1 (id 1) and "Migration Sprint" (id 2) were left
exactly as they were.

## Epics

| Key | Epic |
|---|---|
| SCRUM-181 | S2 P1 - POS, booth and the money path |
| SCRUM-182 | S2 P2 - Apps on the platform |
| SCRUM-183 | S2 P3 - Console, the client data and on-site readiness |
| SCRUM-184 | S2 P4 - Acceptance and delivery |

## Stories and sub-tasks

Listed in **execution order** (the order they were created, so the backlog
reads top to bottom the way the work runs). Each story carries the full
ticket text from the plan — feature area, rules, description, includes,
excludes, acceptance criteria and QA steps — plus labels `sprint-2` and its
own id.

| Plan id | Jira | Sub-tasks |
|---|---|---|
| S2-01 | SCRUM-185 | S2-01a = SCRUM-186, S2-01b = SCRUM-187, S2-01c = SCRUM-188 |
| S2-02 | SCRUM-189 | — |
| S2-03 | SCRUM-190 | — |
| S2-17 | SCRUM-191 | S2-17a = SCRUM-192, S2-17b = SCRUM-193, S2-17c = SCRUM-194 |
| S2-04 | SCRUM-195 | — |
| S2-05 | SCRUM-196 | — |
| S2-06 | SCRUM-197 | — |
| S2-07 | SCRUM-198 | S2-07a = SCRUM-199, S2-07b = SCRUM-200 |
| S2-08 | SCRUM-201 | — |
| S2-09 | SCRUM-202 | S2-09a = SCRUM-203, S2-09b = SCRUM-204 |
| S2-10 | SCRUM-205 | S2-10a = SCRUM-206, S2-10b = SCRUM-207 |
| S2-11 | SCRUM-208 | — |
| S2-12 | SCRUM-209 | — |
| S2-13 | SCRUM-210 | — |
| S2-14 | SCRUM-211 | S2-14a = SCRUM-212, S2-14b = SCRUM-213 |
| S2-15 | SCRUM-214 | S2-15a = SCRUM-215, S2-15b = SCRUM-216 |
| S2-20 | SCRUM-217 | — |
| S2-21 | SCRUM-218 | — |
| S2-18 | SCRUM-219 | — |
| S2-19 | SCRUM-220 | — |
| S2-23 | SCRUM-221 | — |
| S2-22 | SCRUM-222 | — |
| S2-24 | SCRUM-223 | — |
| S2-16 | SCRUM-224 | — |

Checkpoints map onto this order: **CP1** after SCRUM-192 (S2-17a), **CP2**
after SCRUM-200, **CP3** after SCRUM-208 (the POS play-test opens), **CP4**
after SCRUM-216, **CP5** after SCRUM-218, **CP6** after SCRUM-220, **CP7**
after SCRUM-222, **CP8** after SCRUM-224.

## What was done to the pre-existing board

177 issues existed (SCRUM-4 … SCRUM-180). **Nothing was deleted and no
delivered work was touched.** They fall into three groups:

| Group | Count | What was done |
|---|---|---|
| Sprint 1 delivered stories (status *Testing*) | 25 | **Untouched.** They remain the record of Sprint 1 in sprint 1. |
| The agency proposal's future scope — epics P1…P7 and their stories, status *To Do* | 84 | Labelled **`superseded-by-sprint-2`**, left in the backlog, status unchanged. A comment on each of the 21 epics explains that these are the scope inventory kept for traceability to the contract, that the execution now lives in the Sprint 2 tickets, and that nothing from the proposal is deferred. |
| The live OTO App's existing features — epics X1…X8 and their stories, status *In Review* | 66 | Labelled **`verify-in-s2-17`**, status unchanged. A comment on each of the 8 epics explains that these are the verification checklist for the OTO App lift: S2-17b walks through every module on staging against the real data, and S2-17c builds the gaps. |
| Jira's two onboarding sample sub-tasks (SCRUM-4, SCRUM-5) | 2 | Labelled **`not-tracked`**. Delete them in the UI whenever you like; they are not work items. |

Nothing was transitioned, so no status history was rewritten. Every change is
reversible: remove a label, or delete a comment.

## Conventions from here

- **We never change a ticket's status.** Status is the owner's and QA's to
  move. We add evidence comments in the Sprint 1 format
  (`docs/qa/jira-comments/`) when a ticket's work merges.
- A ticket's text in Jira is a copy; `SPRINT_2_PLAN.md` stays the source. If a
  ticket changes, change the plan first and then update the Jira description.
- Sub-tasks carry their part's own acceptance criteria and QA steps, so
  evidence is posted per sub-task where one exists, and on the story where
  none does.
