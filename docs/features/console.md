# Console (super admin) and Launcher

## What it is for
**Launcher** — the front door of the suite. After sign-in it shows a tile for
each OTO app the person may open (POS, OTO App, Radar, Console) and nothing
else. It is how a receptionist, a manager and the owner each land in the right
place with one login.

**Console** — the control room for the owner and a few administrators. It
oversees all apps: who can use what, how branches and devices are set up, what
every staff member did, the headline numbers from every source, and whether the
system is healthy. Day-to-day work never happens here.

## Intake
- **Source:** new. No Replit prototype exists for either. Each existing app has
  its own partial admin (OTO App: users, permissions matrix, operators, data
  admin; Radar: a config tab with no login; POS: the Sprint 1 admin console),
  and none oversees the others.
- **Building blocks already in the repository:** accounts, scoped roles and
  permissions, append-only audit log, sessions, SMS verification (Sprint 1);
  accounts / roles / audit screens in `apps/pos` `/admin`.

## Scope
| Area | What it does | Notes |
|---|---|---|
| People and access | Accounts, roles, per-person switches for apps, modules and sensitive features, branch scope, sign-in history, force sign-out | Module vocabulary starts from OTO App's 11 module keys and per-user overrides; the Console writes them through so OTO App's menus follow |
| Organisation | Operators, branches, opening hours | Mirrors OTO App's records until cutover, then becomes the editor |
| Devices | Boxes, stations (setup wizard from the brief: what it does → choose the box → assign devices → test print), booths, customer displays, kiosks: pairing codes, status, config version, revoke | |
| Activity | One feed across every app: person, app, branch, action, result, time | Platform audit log + request audit from the sign-on adapter in the lifted apps + box and booth events |
| Analytics | Headline figures for all branches from `analytics`; booth funnel; attendance headline. Links into Radar for depth | Reuses Radar's tile, heatmap and chart components |
| Health | Services, heartbeats, sync lag per source (Pisell, Papaya, boxes), failed jobs, printer / SMS faults, alert channels | |
| Integrations | Which keys are configured (never the values), API consumers, webhooks | |

Domain settings stay where the work is done: catalogue, prices and tiers in the
POS back office; HR settings in OTO App; formulas and targets in Radar.

## Integration plan
- **Deployables:** `apps/launcher` and `apps/console`, static sites on their own
  subdomains, both served by the platform `api`.
- **Login:** the platform session. The Console requires `app:console:access`
  and re-checks each action's own permission on the server.
- **Data:** `core` (identity, organisation, devices, audit) and read access to
  `analytics`.
- **Migration of existing screens:** the accounts, roles and audit panels move
  from the POS admin to the Console; members, tier verifications, catalogue and
  pricing stay in the POS back office.

## Status
| Area | State | Notes |
|---|---|---|
| Scope outline | done | details to be agreed with the owner |
| Everything else | not started | follows the platform foundation work |

## Open questions
- Exact list of module and feature switches the client wants per person.
- Who besides the owner gets Console access, and whether any action needs a
  second approver (e.g. granting Console access, revoking a box).
- Alert channels and who receives which alert.
