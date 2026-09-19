# Intake analysis of the imported OTO apps — 2026-09-19

Working notes from a read-only review of the three Replit exports and the
database files dropped into `imports/`. One file per review pass. Nothing was
run, built or modified, and no secret values or personal data are recorded —
variable names, file locations, structure and row counts only.

> **Confidential.** These notes describe unfixed security weaknesses in systems
> that are live today. They are here because this repository is private. Redact
> or remove this folder before the repository is shared beyond the project team.

Start with the summary: [`../EXISTING_SYSTEMS.md`](../EXISTING_SYSTEMS.md).
The plan that follows from it: [`../PLATFORM_PLAN.md`](../PLATFORM_PLAN.md).

| # | Notes | Covers |
|---|---|---|
| 01 | [OTO App — backend](01-oto-app-backend.md) | Stack, 796 routes by module, auth and roles, integrations, environment variables, background jobs, files, all 184 tables, POS touchpoints, face clock-in, re-hosting work list |
| 02 | [OTO App — frontend](02-oto-app-frontend.md) | 122 routes, navigation and modes, permission screens, kiosks and public pages, porting assessment, seams to the rest of the suite |
| 03 | [Radar — Pisell pipeline](03-radar-pisell-pipeline.md) | Floresta: API, signing, sync, storage, how a daily summary is compiled, proposed feed contract, historical import |
| 04 | [Radar — Papaya pipeline](04-radar-papaya-pipeline.md) | Chalong: API, sync, storage, compilation, branch model, differences that matter for one feed contract |
| 05 | [Radar — API, auth, env, schema](05-radar-api-auth-env-schema.md) | All 107 routes, authentication (none), boot-time work, environment variables, schema, build and deploy, what re-hosting requires |
| 06 | [Radar — frontend](06-radar-frontend.md) | Dashboard map, which metrics are computed in the browser, branch handling, admin features, reuse assessment |
| 07 | [Radar — spin wheel, campaigns, vouchers](07-radar-booths-spin-vouchers.md) | How non-POS data arrives, spin-wheel lifecycle, campaigns and QR vouchers, marketing-channel attribution, what to preserve |
| 08 | [Lucky Wheel game](08-wheel-fortune-game.md) | Game mechanics, input, vouchers, backend calls, configurability, gap list against the booth specification |

Markers used throughout: **[V]** verified by reading the code or the dump,
**[I]** inferred, **[U]** unknown.

## Resolved since these notes were written

- *"Which environment holds production data is unknown"* (01) — resolved. Both
  database files were exported on 2026-09-19 from the catalog `oto_staging`, and
  the data is live: clock events, check-ins and schedules run up to the export
  date. The environment the agency calls "staging" is production.
- *Row counts and the real organisation setup* (01) — profiled from the data
  dump; see `EXISTING_SYSTEMS.md`.
- *Whether the Word specification supersedes the game's current rules* (08) —
  it does; see [`../../features/booth.md`](../../features/booth.md).

## Still open (needs access we do not have yet)

- A real `pg_dump` of Radar's published database and of the wheel's database.
  The Radar file we hold is a structure listing, not a restorable dump.
- Whether Radar's dev or published database is the authoritative one.
- Pisell and Papaya API credentials, needed to re-fetch history gaps.
- Who controls DNS for the domains that issued links and QR codes point to.
- Contents of the S3 buckets, and whether the agency will hand over the four
  OTO App secrets that printed QR posters and kiosk sessions depend on.
