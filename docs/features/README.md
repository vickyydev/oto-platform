# Features — one page per app or module

Each page answers, for one app: what it is for, where its code came from, what
works against the real backend today, what is still mock, and what is open.

| App / module | Page | Source | Status |
|---|---|---|---|
| Oto POS (till, customer display, back office, booking site) | [pos.md](pos.md) | Ported from `imports/oto-pos/` | Sprint 1 done: accounts, permissions, members, children, catalog, tier verification. Selling, payments, printing, boxes: next. **The only new product.** |
| OTO App (HR, daily ops, events, camps, check-ins) | [oto-app.md](oto-app.md) | `imports/oto-app/` — live system | Reviewed 2026-09-19. To be lifted as its own service. |
| OTO Radar (revenue analytics) | [oto-radar.md](oto-radar.md) | `imports/oto-radar/` — live system | Reviewed 2026-09-19. To be lifted; needs a real database dump and the POS API credentials. |
| Booth (lucky wheel) | [booth.md](booth.md) | `imports/oto-wheel-fortune/` + client specification v2 | Reviewed 2026-09-19. To be rebuilt on the platform, reusing the game UI. |
| Console (super admin) and Launcher | [console.md](console.md) | New | Scope outlined. |
| Inbox (unified customer messaging: WhatsApp, Instagram, Facebook, web form) | [inbox.md](inbox.md) | `imports/oto-asset-manager/` — client's prototype on sample data | Reviewed 2026-09-20. Milestone 4; data pillars and a mockup shell in Sprint 2, live channels later. |

How the apps fit together: [`../architecture/PLATFORM_PLAN.md`](../architecture/PLATFORM_PLAN.md).
What runs today: [`../architecture/EXISTING_SYSTEMS.md`](../architecture/EXISTING_SYSTEMS.md).

When an app is dropped into `imports/`, copy [`_TEMPLATE.md`](_TEMPLATE.md) to
`<app-name>.md` and fill in the intake section first.
