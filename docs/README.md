# OTO documentation

Four kinds of document, kept apart on purpose.

| Folder | What lives here | Who changes it |
|---|---|---|
| [`briefs/`](briefs/) | **What to build and why** — the owner's governing documents. `OWNER_DIRECTION.md` (decisions given in conversation; newest wins), `PROJECT_CONTEXT.md` (target system: boxes, devices, offline, payments, booth), `POS_BACKEND_LOGIC.md` (the previous developer's explanation of the prototype's rules), `AGENCY_PROPOSAL.md` (the agency's proposal to the client, assessed against the live OTO App — what the contract still owes). The Sprint 1 brief is `/CLAUDE.md` at the repo root because agents load it automatically. | Owner |
| [`architecture/`](architecture/) | **How it is built** — `EXISTING_SYSTEMS.md` (what the client runs today, verified), `PLATFORM_PLAN.md` (the suite: five apps, one database, sign-on, analytics continuity, stations, cutover), `DEVELOPMENT_PLAN.md` (the technical plan an agent follows to build Sprint 2: architecture, conventions, lift method per app, research conclusions, resume protocol), `ARCHITECTURE.md` (stack, decisions log, data model), `DEPLOYMENT_TOPOLOGY.md` (what is deployed where and what fails with what), `DEVICE_INVENTORY.md` (the park's real devices, addresses and protocols incl. the gate), `PAYMENT_GATEWAY.md` (2C2P integration, sandbox first), `POS_RULES_RECONCILIATION.md` (rule ids R-nn / conflicts C-nn cited by tickets), `intake-2026-09-19/` (code-review notes on each imported app), `research/` (dated research notes that feed the reference documents), `design-review-2026-09-19/` (the earlier platform design review). | Engineering |
| [`features/`](features/) | **What each app/module does and its status** — one page per app: scope, where its code came from, what is wired vs mock, open questions. Start here to see the state of any one app. | Engineering, per feature |
| [`progress/`](progress/) | **What happened, sprint by sprint** — `STATUS.md` (where we are and what is next — read first when resuming), `SPRINT_n_PROGRESS.md` (live working log, resume instructions, questions) and `SPRINT_n_REPORT.md` (end-of-sprint summary). | Engineering, continuously |
| [`qa/`](qa/) | **Proof it works** — `TEST_CASES.md` (step-by-step QA cases) and `jira-comments/` (evidence posted to Jira, with screenshots). | Engineering / QA |

Related, outside `docs/`:

- [`/imports/`](../imports/) — raw Replit exports, production dump drop zone, vendor device documents. Reference input only; never built or deployed.
- [`/CLAUDE.md`](../CLAUDE.md) — working agreement and the Sprint 1 brief.
