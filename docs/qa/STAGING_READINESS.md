# Staging readiness — is it configured, and can Antonie test it?

**Written 21 September 2026, against the deployed build `9a8c680`.**
Everything below was checked on the live staging services, not read off a plan.

---

## The short answer

**Yes. Staging is configured and ready for Antonie to walk through Sprint 1 — with three
things to do first and four things that will not work whatever we do.**

Every service has its variables set. Nothing is empty that should be full. The api boots,
and it is built to refuse to boot on a bad storage or SMS configuration, so the fact that
it is running is itself evidence. All five addresses answer, the database is healthy, and
all four apps are allowed to talk to the api — I tested that rather than assuming it.

**Do first (about fifteen minutes):**

1. Set `VITE_HR_APP_URL` on the OTO App service and redeploy it. Without it, two admin
   pages in the OTO App send whoever clicks them off our deployment and onto an old
   Replit workspace.
2. Set `STAFF_TOKEN_PRIVATE_KEY` on the api. Without it the till quietly cannot be
   unlocked when the internet is down — and nothing on screen ever says so.
3. Reset the box clock and clear the quarantine on the Console, or warn him first. The
   Console currently opens on a red "2 things need attention" badge. Every one of those
   alerts is something a test button did on purpose, and the counts are still climbing —
   478 and 476 when I checked, up from 427 and 425 earlier today.

**Will not work, and no variable fixes them:**

4. **No verification code can be texted.** Twilio refuses the message. That blocks
   password recovery and new-account setup. It does **not** block signing in — the seeded
   accounts already have passwords.
5. **Profile photo upload is broken twice over** — the storage token is read-only, and
   the bucket has no CORS rules. Both are settings in Cloudflare, not in Render.
6. **Creating a staff account shows a blank white screen.** The account *is* created;
   the page then goes blank. He will think it failed and try again, and get told the
   phone already exists. Same fault on "Assign administrator".
7. **There is no screen for creating a branch.** The api can do it; nothing calls it.

Items 4–7 need code or credential work, and are listed properly further down.

---

## 1. The environment punch list

*This section is for a developer. Names only — no values are printed anywhere in this
document.*

Live state, read from the Render API on 21 Sept:

| Service | Kind | Variables set |
|---|---|---|
| `oto-api-staging` | web service | 37 |
| `oto-app-staging` | web service | 25 |
| `oto-launcher-staging` | static site | 4 |
| `oto-console-staging` | static site | 3 |
| `oto-pos-staging` | static site | 2 |

### 1a. Set these before he tests

| Service | Variable | What breaks now | What to set |
|---|---|---|---|
| `oto-app-staging` | `VITE_HR_APP_URL` | Declared in `render.yaml:866` **with a literal value**, and not set on the live service — so this is drift, not an open decision. Three pages fall back to a hard-coded Replit host: `client/src/pages/core_admin/users.tsx:13`, `core_admin/branches.tsx:14`, `studio/users.tsx:18`. The blueprint's own comment says it plainly: *"unset it sends people from this deployment to a host that is not ours."* | `https://oto-app-staging.onrender.com`. **This is a Docker build ARG (`Dockerfile:53-54`) — setting it needs a deploy, not a restart.** A scan of the deployed chunks could not find the fallback string, so those pages may not be reachable in this build; set it anyway, because the blueprint already says it should be. |
| `oto-api-staging` | `STAFF_TOKEN_PRIVATE_KEY` | Not set, **and not declared in `render.yaml` at all** — a fresh environment would not get it either. `.env.example:210-216`: *"EMPTY IS A WORKING CONFIGURATION with one consequence… the till works, and it cannot be unlocked without the internet."* Nothing visible fails. `fleet.ts:581` returns an explanatory sentence on the station pick and `StationContext.tsx:123` calls `forgetStaffToken()`, so the till simply holds no token. The Console's Integrations page does not list this variable (`ops.ts:2511-2529`), and the boot log line (`index.ts:47`) is buried in the Render stream — so neither of the two places that would normally tell you does. | `openssl genpkey -algorithm ed25519`, paste the PEM. Raw PEM, escaped-newline PEM and base64 are all accepted. Runtime variable — a restart picks it up. Leave `STAFF_TOKEN_TTL_S` and `STAFF_OFFLINE_SIGN_IN` unset; 16 h and `false` are the intended defaults. |

### 1b. Set these before the park uses it for real

| Service | Variable | Why |
|---|---|---|
| `oto-launcher-staging` | `VITE_RADAR_LEGACY_URL`, `VITE_BOOTH_LEGACY_URL`, `VITE_OTO_APP_LEGACY_URL` | The launcher already renders an "Open the Radar that is running today" button from these (`apps/launcher/src/suite/apps.ts` — `legacyUrl` / `legacyLabel`). Unset, the Radar and Lucky Wheel tiles read "Coming soon" with **no link to the systems the park actually runs today**. Build-time — a rebuild. Not declared in `render.yaml` either. |
| `oto-api-staging`, `oto-app-staging` | `SENTRY_DSN` | Optional by design, *"a no-op while unset."* Consequence: if he hits a server error mid-walkthrough there is no trace anywhere but the Render log stream, so "it broke" reports arrive with nothing behind them. |
| `render.yaml` — console block | `VITE_POS_URL` | **Set on the live service, absent from the blueprint** (the console block at `render.yaml:623` declares only `NODE_VERSION` and `VITE_LAUNCHER_URL`; the `VITE_POS_URL` at line 602 belongs to the launcher). Drift the other way: a blueprint re-apply would under-provision the Console, losing the link to the till's `/admin` panels (`ConsoleLayout.tsx:23`) and making its own Integrations page report the variable as not set (`Integrations.tsx:217`). |
| `render.yaml` — api block | `STAFF_TOKEN_PRIVATE_KEY`, `STAFF_TOKEN_TTL_S`, `STAFF_OFFLINE_SIGN_IN` | None of the three are declared. Whatever is set on the dashboard today, the next environment built from the blueprint starts without offline unlock again. |

> **`render.yaml` and `services/` belong to another session.** The two blueprint items above
> are flagged here, not edited.

### 1c. Correctly left unset — do not "fix" these

- **`TWILIO_AUTH_TOKEN`** — the API-key credential shape is complete and is the
  *recommended* one. `.env.example:144`: *"Leave empty once the key above is in place."*
  Setting it would be a downgrade.
- **`VITE_RADAR_URL`, `VITE_BOOTH_URL`, `VITE_INBOX_URL`** on the launcher — these are the
  *new* apps' own addresses, and those apps do not exist yet. `readOrigin()` leaves an unset
  tile as "Coming soon" rather than a dead link. (Not to be confused with the `_LEGACY_URL`
  trio above, which point at the systems running today and *should* be set.)
- **`VITE_OTO_APP_URL` on the Console** — nothing needs it. The Console reads only
  `VITE_LAUNCHER_URL` and `VITE_POS_URL` (`apps/console/src/env.d.ts:11,17`). The launcher
  needs it because the launcher owns the tiles and the hand-off; the Console has no OTO App tile.
- **The sync, watchdog, retention and alert-flap dials** on the api — *"leave them unset and
  the defaults apply."*
- **`API_PORT`** — Render's own `PORT` wins (`index.ts:59`). Correctly absent.
- **`TEST_DATABASE_URL`, `POS_PORT`, `SMOKE_BASE_URL`** — local development only.
- **`TWILIO_WHATSAPP_FROM`, `REPORT_WHATSAPP_TO`** — nothing in the api depends on them.

### 1d. Verified, not assumed

- **Origins.** I probed the origin hook (`app.ts:157`, which runs before routing, so the
  probe creates nothing). POS, launcher, Console and OTO App all pass; an origin that is not
  ours is refused with `ORIGIN_NOT_ALLOWED`. `ALLOWED_ORIGINS` covers exactly the four front
  ends and correctly refuses a fifth.
- **Hand-off.** `HANDOFF_SIGNING_KEY`, `HANDOFF_APP_ORIGINS` and `HANDOFF_TOKEN_TTL_S` are all
  set, covering POS, Console and OTO App. One sign-in on the launcher opens all three with no
  second password — I opened each and counted zero password boxes.
- **Storage configuration.** All seven `MINIO_*` variables on the api and the full parallel
  set on the OTO App are present and point at the same bucket by design. The configuration is
  right; the *permissions on the bucket* are not (see §3).
- **Database.** `/ops/health` reports database ok at 1 ms, pool 2/10, watchdog fresh.
- **Seeding.** `SEED_PROFILE=staging` selects the demo tenant. Worth knowing: **a deploy does
  not re-seed.** The pre-deploy command is migrate plus platform-sync only — the re-runnable
  half, which touches no demo rows, so a password changed on staging survives a deploy.
- **`oto-deploy-bot`** is declared in `render.yaml` but is not deployed. Owned by another
  session; flagged only.

---

## 2. What he can test today

Every item below was walked end to end on the live deployment. Sign in on each address
separately — each app has its own sign-in, even though one sign-in on the launcher opens
all of them.

**Sign-ins:** administrator `090 000 0001` / `admin1234` · reception `090 000 0002` /
`reception1234`. The till's phone box may prefer `900000001`.

**Start here:** <https://oto-launcher-staging.onrender.com>

1. **Sign in once, open everything.** Sign in on the launcher. Six tiles appear: POS,
   Console and OTO App marked *Open*; Radar, Lucky Wheel and Inbox marked *Coming soon*.
   Click any of the three open ones — it opens without asking for a password again.
2. **Sign out once, and it ends everywhere.** Sign out on the launcher, then reload the
   POS: it is back at its lock screen.
3. **Reception sees less, and is told why.** Sign in as reception `090 000 0002`. One tile,
   and a line naming what is not on their access and that a manager can grant it. Try to
   open the Console directly — it refuses in plain words rather than going blank.
4. **Sign in at the till.** <https://oto-pos-staging.onrender.com> — phone and password on
   the lock screen. It lands on *Pick your station*, not the till; pick one.
5. **Find a member by phone, in any format.** On the till, the visitor types their phone on
   the customer display (the right-hand panel) — *not* on the till itself. `0811111111`,
   `+66811111111` and `081 111 1111` all find the same person. Mali appears, with both
   children and a peanut-allergy note.
6. **Confirm who is visiting, and edit an allergy.** Tick the children, change an allergy
   note, save. It persists, the child's "last confirmed" date updates, and a draft visit is
   created.
7. **Create a new member from a phone and a name.** The same screen offers it when no one is
   found.
8. **Ticket packages and pricing.** <https://oto-pos-staging.onrender.com/admin> (it will ask
   for the password a second time — that is deliberate). Create a package with weekday and
   weekend prices per tier. Then add a holiday range covering today and watch the header on
   the till flip from *Weekday pricing* to *Weekend pricing*. The end of the range is
   inclusive, and that was checked.
9. **VAT and service charge.** Same admin area. Set a service charge on one area and it
   applies there and nowhere else.
10. **Roles and who can do what.** Assign a role scoped to HKT Central and look at the
    resulting permissions — 45 of them, correctly branch-scoped.
11. **Create an operator, then archive it.** Archived operators do vanish from the pickers.
12. **Deactivate an account and try to sign in as it.** Refused with *"This account has been
    deactivated — contact a manager."*
13. **The lock is real.** Lock the till and the business screens refuse to answer until it is
    unlocked.
14. **The activity log.** <https://oto-console-staging.onrender.com> → Activity. Every action
    above leaves a row: who, what, when, which branch.
15. **The booking page is genuinely public.** <https://oto-pos-staging.onrender.com/book>
    loads signed out and shows the live catalogue. *(Worth a decision: it currently returns
    the whole tier price matrix, so anyone can see the 1-Hour pass is ฿690 for a tourist and
    ฿420 for a Thai resident, side by side. That is a commercial call, not a fault.)*
16. **The OTO App.** <https://oto-app-staging.onrender.com> — opens from the launcher tile,
    running on the central database.

Everything in that list is a Sprint 1 acceptance item bar the last two, and 14 of the 18
checklist items in §10 of `CLAUDE.md` pass as deployed.

---

## 3. What will not work, and why

### Texted codes do not arrive — password recovery and new-account setup

Twilio answers the send with a **422**. Not a 401 — our credentials authenticated fine and
Twilio then refused the message. The account is a trial one, and a trial Twilio account can
only text numbers on its Verified Caller IDs list. A Thai `+66` destination commonly also
needs a registered sender.

What he sees: *"Could not send the SMS — try again in a moment"*, twice, because "Forgot
password?" sits on every sign-in screen in the suite. Two such failures are already recorded
on the Console's Failures page from earlier today.

Also worth knowing: the seeded phone numbers are not real phones, so they could never receive
a code regardless.

**Fix:** upgrade the Twilio account, or add his number and any staff phone to Verified Caller
IDs, and check the Twilio error log for the specific rejection code. **Not a Render variable.**

**Workaround meanwhile:** issue a temporary password from the admin area — that flips an
invited account straight to active. One catch: the person must then change it **on the
launcher**. The till reads the "must change password" flag but does nothing with it, so it
shows *"Password change required before continuing / Try again"* on the station picker with
no form and no way forward.

### Profile photo upload

Broken in two independent places, and no screen implements it yet in any case:

- Asking for an upload link returns **200** and a Cloudflare R2 address.
- Uploading from a browser is **blocked by CORS**.
- Uploading from a server, where CORS does not apply, returns **403 AccessDenied**.
- Reading a key that does not exist returns **404 NoSuchKey**.

Denied on write but a clean "not found" on read means the signature is valid and **the R2 API
token is read-only**. Two separate fixes, both in Cloudflare: reissue the token with Object
Read & Write, *and* add CORS rules to the bucket. Fixing only the token still leaves browsers
blocked. **Not a Render variable.**

### Creating a staff account shows a white screen

The account is created, then the page goes blank. He will read that as a failure, retry, and
be told the phone already exists.

`apps/pos/src/components/admin/access/LoginUsersPanel.tsx:172` puts the api's warning
*object* into a toast where a string is expected, so the `??` fallback never runs and React
throws. Identical fault at `apps/pos/src/components/admin/access/OperatorsPanel.tsx:105` —
"Assign admin" white-screens the same way. It only fires when the SMS fails, which on staging
is every time. One-line fix in each.

### There is no screen for creating a branch

`POST /branches` exists and the store is wired for it, but no admin screen calls it — the
Branches panel lists and clones only. The acceptance line *"create operator, branch,
administrator"* is therefore half-deliverable: operator yes, administrator yes, branch no.

---

## 4. Things that look broken but are not

**The Console opens on red.** A "2" badge, *"2 things need attention"*, three open alerts.
Every one is a test button doing what it was built to do:

| Alert | Count | Cause |
|---|---|---|
| Events from Virtual box 1 waiting in quarantine | 478 | the "Inject poison event" test control |
| Virtual box 1's clock is 120 s ahead | 476 | the "Advance box clock" test control |
| *"A test alert… Nothing is wrong."* | 2 | the test control that says so |

The first two are **still climbing** — they rose by roughly fifty between two readings today,
because the box clock was never put back. Reset it before he opens the link, or tell him
first. Also on that page is a *Test controls* panel with buttons marked *Stop heartbeats*,
*Inject poison event* and *Reset store (new epoch)*. He is curious and they are buttons.

**The first page load is slow.** Staging sleeps. Cold loads ran 5–7 seconds, one sign-in
longer. Nothing showed a raw error; it just sits there.

**The admin area asks for the password a second time**, even with the till already signed in.
Deliberate — it is a second gate on the back office — but it reads like a bug.

**Sign-in lands on "Pick your station"**, not on the till. Correct behaviour.

**The membership phone box is on the customer display, not the till.** The till only says
*"Waiting for the customer…"*. Correct per the brief, but he will hunt for a phone box on the
till and not find one.

**The navigation clips.** At laptop widths the *Messages* tab renders as *Mess* (1600 px) or
*Messa* (1500 px), with its red badge half-cut. The nav fix was verified at 1980 px.

**The lock screen advertises three "(temp)" links** to anyone, signed out — booking site,
admin console, stock module. They work; the "(temp)" labels just read as half-built.

**`Today` shows ฿0 revenue next to "Parties today 3".** The zeroes are honest and the threes
are mock, on the same screen. The revenue split also renders as **"฿00%"** with no gap, which
simply reads as broken.

**Two third-party links ship inside the OTO App** — a QR generator and a franchise guidebook,
both pointing at Replit workspaces (`client/src/pages/core/find.tsx:20`,
`core/learn.tsx:19`). Inherited from the app the park runs today, not introduced here.

---

## 5. What is still mock data

Nothing below talks to the api at all — I watched the network to confirm it. The risk is not
that they are empty; it is that they are **convincing**.

| Screen | What it shows | Why it matters |
|---|---|---|
| **Events** (`/parties`) | Headed **today's date**, five events, three named birthday parties, one badged *IN PROGRESS*, and outstanding balances of ฿5,800 / ฿9,940 / ฿9,800 | The most convincing screen in the system. Nothing labels it a demonstration. He will read it as real bookings and real money owed. |
| **Check-in** | *"1 overdue · 2 due soon"*, a child **"Nong Ton · Overdue · 10:00"**, a real-sounding allergy note, and WhatsApp reading *"No connection"* | A child reading as unaccounted for is the worst possible false alarm in this business. |
| **History** | Eight sales dated 14–15 June with named members, named staff, ฿1,790, ฿3,300, Paid and Partial refund badges | A sales ledger for sales that never happened. |
| **Messages** | Four parent conversations and a red **7** unread badge | — |
| **Header, every screen** | *"3 in park"*, and a permanent red band *"1 out of stock · 2 low"* naming three products | Present on screens that are otherwise real. |
| **`Today` tiles** | *Parties today 3*, *Drop-off kids in park 3* — beside real zeroes | Mixed real and mock on one screen. |
| **F&B, Shop, Stock** | Demo wristbands and stock | **These do it right** — their wristbands sit under a heading that reads **"DEMO WRISTBANDS"**. That is the pattern the five screens above need. |

**Recommendation:** put an F&B-style demonstration label on Events, Check-in, History,
Messages and the header counters before he opens the link. It is a heading, not a rebuild,
and it removes every false alarm on this list at once.

---

## 6. Before he opens the link — the list

1. Set `VITE_HR_APP_URL` on `oto-app-staging` and **redeploy** it.
2. Set `STAFF_TOKEN_PRIVATE_KEY` on `oto-api-staging`.
3. Reset the box clock and clear the quarantine, so the Console opens green — or tell him
   the red is a test.
4. Label Events, Check-in, History, Messages and the header counters as demonstration data.
5. Create him an account on his own number and hand him the password **directly** — the
   texted-code path will fail. The only owner-shaped login today is the seeded
   *Khun Anan (Owner)*.
6. Get his number onto Twilio's Verified Caller IDs, or upgrade the account, so recovery
   works.
7. Fix the two white-screen toasts — one line each.
8. Set the three launcher legacy URLs so Radar and Lucky Wheel link to the systems he
   already uses.

Items 1–6 are configuration and briefing. Items 7–8 are small changes.

---

## Appendix — what was and was not touched

Nothing on staging was created, renamed, deleted or rotated for this document, and nothing
was redeployed. `render.yaml` and `services/` were read only. Sign-ins were made with the
seeded administrator account to read the health snapshot.

Left behind by the earlier readiness walk, and worth knowing about because the platform has
no hard delete for accounts by design:

- `zz-readiness-check` — left inactive with no roles; cannot sign in.
- `zz-readiness-admin` — sits under an archived test operator.
- Four file-metadata rows from presign attempts, with no object behind any of them.
- Three draft visits for the seeded member Mali, dated today.

Everything else created during testing — test members, a test holiday, a service-charge
change, an allergy edit, a test operator — was put back.
