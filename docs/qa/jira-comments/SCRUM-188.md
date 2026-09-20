**Dev evidence — S2-01c complete, and deployed** (2026-09-20, commit `f5a16e3` on `main`)

The POS and the api are **live on Render**, the database is migrated and seeded, and both Playwright smoke flows pass against the two live origins. Full write-up: `docs/progress/DEPLOYMENT_STAGING.md`.

- POS: https://oto-pos-staging.onrender.com
- API: https://oto-api-staging.onrender.com

**Grouping.** A Render **project `OTO Platform`** with two environments — `production` (protected, empty) and `staging` — so a production environment of the same shape sits beside staging later rather than colliding with it. Staging holds `oto-db-staging`, `oto-api-staging` and `oto-pos-staging`, all in `singapore`.

**Sizing, measured rather than guessed.** The blueprint argued for a 4 GB database against the S2-22 restore and the analytics rollups. Against the real server that did not hold: the seeded database is **10 MB** across 38 tables and `max_connections` is **103**, where the blueprint had budgeted 68. Settled on `1c-2g` (1 CPU, 2 GB) — caches the eventual 33 MB restore many times over and doubles the CPU `pg_restore -j4` will want, without paying for headroom nothing uses. `shared_buffers` confirmed at 512 MB after the resize, data intact. The api is `standard`, not `starter`: argon2id on every sign-in makes it CPU-bound, the cheaper types spin down when idle (a ~50 s cold start on the first till of the day), and Render's autoscaling only begins at `standard`.

**Auto-deploy, gated on CI, with no credential on the GitHub side.** Both services use Render's `checksPass` trigger: Render watches the repository, waits for the `ci` workflow's commit status and deploys only when it is green. The CI workflow therefore has **no deploy job** — a deploy hook or an API key in repository secrets would put a key to the whole workspace within reach of anyone who can push a workflow file. Proven end to end: a push ran CI, went green, and Render deployed both services unattended.

**The pre-deploy step does the database work.** From the deploy log: `migrations applied successfully`, then `Full seed (SEED_PROFILE=staging): platform rows plus the demo tenant`, then `Seed complete: operator OTO, branch HKT Central, roles, accounts, members, catalog.` The seed entrypoint now reads `SEED_PROFILE`, so one pre-deploy command is correct on both environments: staging gets the demo tenant, production gets the platform rows only and waits for the S2-22 restore.

**Verified against the running deployment**, not against a local stack:
- `/health` 200; `/ready` reports the database reachable.
- Sign-in through the POS origin returns a session cookie marked `HttpOnly; Secure; SameSite=Lax` — the `/api/*` rewrite keeps it same-origin, which is the whole reason for the rewrite.
- The Sprint 1 membership check: `+66811111111` returns Mali with her tier verification and both children.
- A write carrying a foreign `Origin` is refused `ORIGIN_NOT_ALLOWED`.
- A member id outside the caller's operator answers **404**, not 403.
- Both Playwright smoke flows pass with `SMOKE_BASE_URL` pointed at the live POS: lock, sign in, membership lookup, child confirm, lock, unlock, sign out; and the create-member path.

**Four deploy blockers were found and fixed first.** A production-readiness audit (`docs/qa/PRODUCTION_READINESS_2026-09-20.md`) ran before the deploy and found: a tenancy hole where `GET /members/:id` resolved a member by id alone and returned their children's allergies and medical notes across operators; every profile-photo upload asking object storage to create the bucket, which a scoped token cannot do; the verification SMS being sent inside an open transaction, where a slow provider exceeds `idle_in_transaction_session_timeout` and rolls the account back **after** the code has gone out; and a boot guard that checked the storage keys but not the endpoint, port or SSL. A fifth was found while fixing them — a storage endpoint carrying a scheme is rejected by the SDK at construction, which is a crash loop rather than a bad request.

**SMS is real, and its absence is loud.** There is no console fallback on any deployment: the api refuses to boot with `SMS_ADAPTER=console` whenever `DEPLOY_ENV` is not `local`, and `buildSmsSender` throws when `SMS_ADAPTER=twilio` without complete credentials. A verification code printed into a hosted log stream is a live credential where anyone with log access can read it, and a delivery path only ever exercised in production is untested. Authentication uses a Twilio **Standard API key** rather than the account auth token, so the credential this deployment uses is revoked and rotated on its own; the shape of each value is checked at boot, because Twilio's answer to a swapped pair is a 401 at the first person who needs a code, days later, where it reads as a delivery problem.

**`DEPLOY_ENV` settled a conflict the blueprint exposed.** Staging runs the production *build* against throwaway data, so `NODE_ENV` could not decide whether the demo reset, the seeded tenant and console SMS exist. `DEPLOY_ENV=local|staging|production` does: a development default is refused on any deployment, the playground settings are refused on production only, and the console SMS adapter is refused on every deployment including staging.

**Security posture.** The database is unreachable from the public internet (`ipAllowList: []`) — only services in the workspace can connect; the one-off access opened to measure `max_connections` was closed again. Nothing secret is in the repository: `render.yaml` carries variable names only, with `sync: false` where a person supplies the value.

**QA (UI) steps 1–2 on the ticket are ready for the owner to run** against the live POS: the membership lookup is already proven by the smoke run, and "Reset demo data" is a platform-admin control on the Operators panel.

165 API tests + 22 shared tests, typecheck, lint and build all green.
