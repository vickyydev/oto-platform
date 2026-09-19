# Contributing

## Commits

History is part of the product. Every commit should read as a deliberate,
reviewable change.

**Subject line** — `type(scope): summary`

- Imperative mood, lower case after the colon, no trailing period, 72 characters or fewer.
- `type`: `feat`, `fix`, `refactor`, `perf`, `test`, `docs`, `build`, `ci`, `chore`.
- `scope`: the area touched — `api`, `pos`, `db`, `shared`, `box`, `infra`, `repo`, or a module name (`members`, `catalog`, `auth`, `payments`, …).

**Body** — explain what a reviewer cannot see from the diff.

- One or two sentences of context: the problem or the reason for the change.
- Then short bullet points for the notable changes, one idea per bullet.
- Mention behaviour changes, migrations, new environment variables and anything a deployer must do.
- Wrap at 72 columns. Plain text only: no emojis, no headings, no marketing language.

**Footer**

- `Refs: SCRUM-123` for the ticket(s) the commit belongs to.
- `BREAKING CHANGE: …` when an API contract or a migration is not backward compatible.
- No tool, generator or assistant attribution lines of any kind.

**Granularity** — one logical change per commit. Schema changes ship with the
code that uses them. Formatting-only and rename-only changes go in their own commit.

Example:

```
feat(members): record tier verification with document expiry

Discounted tiers were applied on a staff member's say-so with nothing
recorded. Verification is now a first-class record.

- add POST /members/:id/tier-verification; verifier, branch and time
  are taken from the session, never from the request body
- reject documents that have already expired and unknown tiers
- hide expired verifications from member lookups; keep the row for audit
- list all verifications for back-office review

Refs: SCRUM-33
```

## Branches

- `main` is always deployable. Work happens on short-lived branches:
  `feat/<topic>`, `fix/<topic>`, `chore/<topic>`.
- Rebase onto `main` before merging; keep history linear.

## Before pushing

```
pnpm typecheck && pnpm lint && pnpm test && pnpm build
```

Database changes: generate a migration (`pnpm db:generate`), never edit an
applied one, and keep migrations additive so running services are not broken
mid-deploy.

## What is never committed

Secrets (`.env`), database dumps, anything under `imports/` except its README
files, build output and `node_modules`.
