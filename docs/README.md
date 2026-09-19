# OTO documentation

Four kinds of document, kept apart on purpose.

| Folder | What lives here | Who changes it |
|---|---|---|
| [`briefs/`](briefs/) | **What to build and why** — the owner's governing documents. `PROJECT_CONTEXT.md` (target system: boxes, devices, offline, payments, booth), `OWNER_DIRECTION.md` (decisions given in conversation; newest wins). The Sprint 1 brief is `/CLAUDE.md` at the repo root because agents load it automatically. | Owner |
| [`architecture/`](architecture/) | **How it is built** — `ARCHITECTURE.md` (stack, decisions log, data model), `DEPLOYMENT_TOPOLOGY.md` (what is deployed where and what fails with what), `design-review-2026-09-19/` (the pre-Sprint-2 multi-agent review). | Engineering |
| [`features/`](features/) | **What each app/module does and its status** — one page per app: scope, where its code came from, what is wired vs mock, open questions. Start here to see the state of any one app. | Engineering, per feature |
| [`progress/`](progress/) | **What happened, sprint by sprint** — `STATUS.md` (where we are and what is next — read first when resuming), `SPRINT_n_PROGRESS.md` (live working log, resume instructions, questions) and `SPRINT_n_REPORT.md` (end-of-sprint summary). | Engineering, continuously |
| [`qa/`](qa/) | **Proof it works** — `TEST_CASES.md` (step-by-step QA cases) and `jira-comments/` (evidence posted to Jira, with screenshots). | Engineering / QA |

Related, outside `docs/`:

- [`/imports/`](../imports/) — raw Replit exports, production dump drop zone, vendor device documents. Reference input only; never built or deployed.
- [`/CLAUDE.md`](../CLAUDE.md) — working agreement and the Sprint 1 brief.
