# Replit port, October 2026 — the staff-app upstream pull into our platform

**Source:** `imports/oto-app` pulled 2026-10-19 by the owner, upstream range
`9990891f..f2c569dc` (67 commits, ~52k insertions). `9990891f` is the base
our `apps/oto-app` fork was lifted from, so this range is exactly what the
park's side added since the lift. Ticket: SCRUM-540. Owner rulings
2026-10-19: adopt flexible leave types (balances freeze-then-recalc
accepted); the payroll prototype is **rules-as-spec only**
(`docs/features/oto-app-payroll-rulebook.md`), no demo pages ported; the
big screen reworks follow as their own wave AFTER rounds R1–R5.

## What the range contains

~80% is a browser-only payroll prototype (spec, not feature — see the
rulebook). The REAL server/database changes, classified:

| Feature | Verdict | Size | Notes |
|---|---|---|---|
| Flexible leave types (upstream mig 0024, `server/leave-types.ts`, policy-route rewrites, storage balances) | PORT-ADAPTED | L | Tenant catalog of leave types + per-employee overrides + opening-balance snapshots; one new balance engine replaces the fixed ones. Adaptations: tenant-fence the seed (upstream's picks any tenant's no-branch policy and reads settings cross-tenant with MAX — would leak across park groups), reconcile with our park-group fences and the SCRUM-544 branch-check fix (same outcome, different code), overrides must verify employee tenant, leave-policy ids need a combined lookup (upstream returns type ids as policy ids). Opening snapshot must also run (idempotently) after the production restore — upstream's lazy per-tenant init survives either order. |
| Salary hiding (`shared/hr-salary-permission.ts`, `hr.view_salary`) | PORT-ADAPTED | M | ~23 pay keys redacted server-side below admin; manager pay-field PATCH refused; omitted pay values preserved on save. Adapt: express through OUR permission model, not upstream's role strings (`owner`/`payroll_admin` aliases don't exist here); apply also in our `server/employee-action-routes.ts` (changes + probation review moved there — a plain diff misses them). Managers LOSE salary visibility — the park's own rule, flagged on the ticket. Known gaps upstream admits: contracts/PDFs/exports/notes still leak pay — recorded as a follow-up, not silently widened. |
| Birthdays (mig 0023, `server/person-birthdays.ts`, `shared/birthday.ts`) | PORT-ADAPTED | S | Month/day/opt-year on employees+users with DB checks (Feb 29 → Feb 28), `GET/PATCH /api/my-account/birthday`, branch-scoped `GET /api/birthdays` (≤370 days). Consumers: Today banners, both event calendars, employee editor, My Account. |
| Sidebar memory (mig 0025) + badges | PORT-ADAPTED | S+M | `user_preferences` jsonb per user; `GET/PATCH /api/me/sidebar-sections` (atomic merge); `GET /api/sidebar/badges` (needs-action + attendance flags) — fence to our park groups. We do NOT take upstream's sidebar payroll-menu replacement (it would empty our real payroll links) nor its dev-mode fake-data switches. |
| Checklist history filters (+ `ChecklistFilters` UI) | PORT-AS-IS on our handler | S–M | period day/week/month/custom + employee/department; branch timezone, Monday weeks. |
| Checklist video evidence | PORT-ADAPTED | M | JPEG/PNG/WebP photo or MP4/MOV/WebM video ≤20 MB with honest 413. Ours checks file signatures and serves privately: add MP4/MOV/WebM signatures, keep checker photos at 5 MB, and add byte-range (206) support to the private serving (iPad Safari needs it for video; untested inference — verify). The shared `image-upload.ts` preparation lib comes along. MUST NOT undo our upload-claim fix (itemId on upload + canonicalUrl swap). |
| Checker-photo 413 message | PORT-AS-IS | S | |
| Twilio hardening slivers | PORT-ADAPTED | S | Rate limiter locks while counting; phone verification re-checks user active + same phone. Only these two pieces. |
| Duty-shift markers + scheduling leave-type consumers | rides R3/R6 | S | DutyShiftMark etc. are new files, CLEAN; scheduling's time-off menu reads `/api/leave-types` (R3 consumer). |
| SMS-code login door, password hardening, owner bootstrap (susu/air/tom/miia), response-body log scrub, time-off approval fix, the published payroll test app | SKIP-SUPERSEDED / SKIP | — | Launcher owns identity; ours already scrubs logs; our round-5 H14 fix covers the time-off bug; the test app is a Replit deployment artifact (never copy `account-hashes.generated.json`). Mined piece kept: `isStrongGlobalAdminPassword` idea is moot behind the launcher. |

**Hygiene item found during analysis (ours, fix regardless):** our fork
still auto-seeds an admin account at startup (`server/index.ts:115`) — the
old door upstream itself deleted. Remove.

## Migration renumbering

Our journal is at `0016_qa_reports` → these become ours, REGENERATED via
drizzle-kit from the ported schema (fresh `when` timestamps; upstream's are
older than our 0016 and would be skipped), with the 0024 seed hand-added
and tenant-fenced:

| Upstream | Ours |
|---|---|
| 0023_person_birthdays | 0017_person_birthdays |
| 0024_flexible_leave_types | 0018_flexible_leave_types |
| 0025_user_preferences_sidebar | 0019_user_preferences |

Upstream's journal lists only 0023 (0024/0025 went out by schema-push).
No table/column collisions with our 0001–0016. `recordDeletion.ts` needs no
change (new tables cascade with their owners); add TABLE_WORDS entries.

## Collision hotspots (exact, from the readers)

- `routes.ts`: ~1338 (birthday routes site), 3284–4517+5266 (salary
  redaction + birthday validation), 6359–6420 (settings↔leave-types keys vs
  our tenant-scoped settings), ~7200 (sidebar routes), 12715–13225
  (time-off + balances on top of our H14/date fixes), **13239–13365 (leave
  policies — our park-group fence + SCRUM-544 vs upstream's rewrite; the
  biggest)**, 13372–13700 (sick/all balances → new engine; our storage.ts
  tenantId params), 21208–21300 + 21807 (checklist history + message),
  23760–23850 (evidence upload/serving).
- Client: timekeeping review/detail/live rewrites still use field names we
  corrected (`userClockInAt`→`userProposedClockInAt`), would drop our
  auth-method labels and ping/recovery rework; checklist-run rewrite would
  undo the upload-claim fix; attention/reviews rewrites sit on our
  paused-flag and manager-request-id lines; employee-editor tabs re-add the
  vouchers section we removed and wrap our launcher access section; layout
  menus anchor on the "My Vouchers" item we deleted. ALL deferred to R6
  except where a port round needs a hook. Every ported dialog is conformed
  to our DialogBody recipe (upstream's new ones ignore it).

## Rounds

- **R0** — this plan + the rulebook committed; SCRUM-540 populated;
  subtasks created. (done with this commit)
- **R1** — hygiene: remove the dormant admin auto-seed. (S)
- **R2** — salary hiding, our permission model, both route files. (M, Opus)
- **R3** — flexible leave types whole: schema 0018, tenant-fenced seed,
  server engine + routes reconciliation, LeaveTypesManager (DialogBody-
  conformed) on the policies page, scheduling/rota/balances consumers,
  duty markers. (L, Opus)
- **R4** — birthdays (0017) + sidebar memory/badges (0019). (S+M, Sonnet)
- **R5** — media + checklist round: video evidence with signatures/range
  serving, image-upload lib, history filters + ChecklistFilters, 413
  wording, twilio slivers — our upload-claim fix re-applied on top. (M, Opus)
- **R6 (later wave, own ticket)** — Today's-attendance rework, Needs-action
  tabs, sidebar regroup (keeping our payroll links), employee-editor tabs
  (without the vouchers regression). (L)

Out of scope entirely: payroll demo pages, dev-mode fake-data switches,
`VITE_PAYROLL_DEMO_MODE`, the four-owner bootstrap, OTP login. The four
rulebook concerns + the managers-lose-salary rule + the balances-change
note travel to the park's side via the owner.
