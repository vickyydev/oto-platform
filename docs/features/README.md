# Features — one page per app or module

Each page answers, for one app: what it is for, where its code came from, what
works against the real backend today, what is still mock, and what is open.

| App / module | Page | Source | Status |
|---|---|---|---|
| Oto POS (till, customer display, admin console, booking site) | [pos.md](pos.md) | Ported from `imports/oto-pos/` | Sprint 1 done: accounts, permissions, members, children, catalog, tier verification. Selling, payments, printing, boxes: Sprint 2. |
| *(other OTO apps)* | — | Awaiting Replit exports in `imports/` | Not yet reviewed |

When an app is dropped into `imports/`, copy [`_TEMPLATE.md`](_TEMPLATE.md) to
`<app-name>.md` and fill in the intake section first.
