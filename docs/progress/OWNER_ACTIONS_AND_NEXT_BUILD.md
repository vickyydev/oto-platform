# Owner actions, and the next build

_Written 2026-09-21, from five investigations run that day: the menu
import/export design, why no SMS code is delivered, whether LINE can carry
visitor registration, the OTO App "tenant not found" error, and re-tests of
photo upload and of editing staff roles and member tiers._

Two halves. **Half one** is what only the owner can do — accounts, payments,
approvals, settings on someone else's dashboard. **Half two** is our build
queue, in order, sized, with the dependency on the Lucky Wheel booth work
currently in flight made explicit.

Decisions, as opposed to actions, live in `OPEN_QUESTIONS.md`, which was
updated alongside this file.

---

# Half one — what only the owner can do

Written for a non-engineer. The first three block something visible; the rest
are waits that are cheap to start now and expensive to start late.

## 1. Twilio: lift the account out of trial — **blocks a demo**

**What it is.** The park's Twilio account, which sends the code a staff member
needs to set up a login or reset a forgotten password.

**Why it matters.** Today it sends nothing at all. Every attempt is refused
before Twilio even looks at the destination. So during a walkthrough, a new
staff account cannot be created and a forgotten password cannot be reset.

**Why, precisely.** The account is still a free trial. Twilio's own words,
from its live API: *"No Twilio trial phone number is assigned for messaging to
this destination number."* A trial may only text numbers that have been added
to an allow-list, and this account has **no phone numbers of its own, no
allow-listed numbers, and a zero balance**. The same refusal came back for a
Thai mobile, a US mobile, and a sender the account does not own — so this is
not yet a Thailand problem.

**What to do**, in the Twilio Console:

1. Add any prepaid balance. That alone ends trial mode, and with it the
   allow-list restriction and the spending cap. **About five minutes.**
2. While still in trial, or as a belt-and-braces step, add each phone that
   will receive a code during the walkthrough under **Verified Caller IDs**.
   Instant — Twilio texts or calls that phone with a confirmation code.

**Approval time:** none. It takes effect immediately.

**The honest caveat.** Paying does *not* guarantee a code reaches a Thai
mobile — see action 5. For a walkthrough, pair this with the temporary-password
route, which needs no SMS at all and which we are unblocking in build item
**B1**.

## 2. The storage bucket: add a CORS rule — **minutes, unblocks photo upload**

**What it is.** One setting on the object-storage bucket that holds profile
photos.

**Why it matters.** The write permission you granted on the token worked —
the server can now upload and read back a file, verified end to end on
staging today. But a **browser** still cannot. These were always two separate
locks and only one has been opened.

**What to do.** In the storage dashboard, open the bucket's CORS policy and
paste this:

```json
[
  {
    "AllowedOrigins": [
      "https://oto-pos-staging.onrender.com",
      "https://oto-console-staging.onrender.com",
      "https://oto-app-staging.onrender.com",
      "https://oto-launcher-staging.onrender.com"
    ],
    "AllowedMethods": ["GET", "PUT"],
    "AllowedHeaders": ["content-type"],
    "ExposeHeaders": ["ETag"],
    "MaxAgeSeconds": 3600
  }
]
```

Without it the browser's preliminary permission check comes back with no
answer at all, and the upload never starts.

**Approval time:** none. Takes effect on save, no deploy needed.

**Note:** no screen in any app uploads a photo yet, so nothing changes
visibly until build item **B4**. The rule costs nothing to add now and
removes the blocker from that item's path.

## 3. The OTO App on staging still looks empty — **blocks a convincing demo**

**What it is.** A one-off run of a data-loading script against the staging
database.

**Why it matters.** Employees, Departments, Roles, Branches and the Org Chart
all render empty on staging, which makes a working app look broken.

**Where it stands.** 116 invented records are already loaded through the app's
own screens — one branch, six departments, twelve roles, twenty-six staff with
Thai names and the short nicknames staff actually use, three announcements, ten
tasks. That is enough for a walkthrough of those screens. What is *not* loaded
is roughly 400 clock-in/clock-out events for Time & Attendance, because there
is no screen to enter them through.

**Why we could not simply run it.** The staging database refuses connections
from outside Render — its allow-list is empty, which is the correct setting
and was deliberately left alone.

**What to do — either:**

- Give us access to a Render shell on the staging service, and we run
  `script/sample/main.ts` there once; **or**
- Temporarily add one IP to the database's allow-list, and remove it after.

The first is cleaner. **A few minutes either way, no approval.**

**Everything loaded is invented.** The real staff export in `imports/` was
read for counts and shapes only; no real row was copied and none was
uploaded. Two markers make the sample obvious on sight: every email address
is on `sample.oto.test` — a reserved domain that cannot reach a real inbox —
and every phone is in one unused block. One announcement on the Today screen
says so in plain words.

## 4. LINE: create the Official Account now — **5–10 business days of waiting, free**

**What it is.** The park's own presence on LINE, plus the application to have
it verified so a visitor can find "OTO" by searching in LINE.

**Why it matters.** Nothing is blocked today, but verification takes up to two
weeks and costs nothing, so the waiting may as well start now. More
importantly, **one choice inside the setup is permanent and very expensive to
undo.**

**What to do:**

1. Create **one LINE provider** for the park, under the park's own LINE
   business account — not a vendor's, not an agency's. Create the Official
   Account under it.
2. Apply for verification. LINE asks for the Thai company registration
   certificate (หนังสือรับรองบริษัท), a company description, a website, store
   photos, and an administrator's ID. **5–10 business days.** Thailand is one
   of only three markets where LINE accepts these applications at all, so this
   is an advantage worth using.

**The permanent part, and why it matters.** LINE gives us the same identifier
for a person across messaging and sign-in **only when both sit under the same
provider**, and LINE's own documentation is blunt that a channel cannot be
moved to a different provider later. If the Official Account is created now
under one provider and a sign-in channel is created later under a different
one, the two can never be joined — registration and messaging would be
permanently separate, and the only fix is to start over. **One provider, owned
by the park.**

**On cost.** Published figures for Thailand disagree with each other and LINE
revises them, so treat any number as indicative until checked in LINE Business
Manager. The rule that is not in dispute: **replies are free and uncounted**;
only messages the park *initiates* consume quota. A registration conversation
is entirely reply-shaped, so the free tier very probably covers it outright.
What costs money is marketing broadcasts to every member — a separate, later
decision.

**Twilio cannot do this.** Twilio announced LINE support in 2018 and the press
release is still online, which is why a search says yes; the live product
documentation lists SMS, MMS, RCS, WhatsApp and Facebook Messenger, and the
LINE page is gone. Our Twilio account stays useful for SMS only.

## 5. Thailand SMS for production: pick a route — **start within two weeks**

**What it is.** The arrangement that lets a code actually arrive on a Thai
phone once the account is out of trial.

**Why it matters.** This is the part that outlives the demo. Twilio's own
Thailand guidelines say that **a US number cannot deliver SMS to Thailand at
all**, whatever the balance, and that **unregistered senders have been fully
blocked in Thailand since October 2025**. So action 1 fixes the refusal we see
today and may still leave codes undelivered in Thailand.

**Three routes, cheapest first:**

- **Twilio Verify** — Twilio's own product for exactly this job. It uses
  Twilio's pre-registered Thai senders, so it sidesteps the registration wait
  entirely. **No purchase and no approval; a code change on our side** (build
  item B12). This is the recommended route.
- **A registered alphanumeric sender ID** (e.g. the message appearing from
  `OTOPARK`) — needed only if the park's name should appear as the sender.
  Requires forms signed by an authorised signatory, on company letterhead,
  with stamp and signature. **Up to 10 business days.**
- **A Thai `+66` number** — needed only if two-way SMS is ever wanted. Requires
  a Thailand regulatory bundle. **Up to 3 business days plus a mailed
  confirmation.**

**For later, not now:** Thailand's regulator restricts links inside automated
messages, and the data-protection law requires recorded consent for marketing.
Our codes contain no link, so nothing is affected today — it constrains the
messaging work in a later sprint.

## 6. Still outstanding from before

Unchanged, and repeated here so this list is complete:

- **2C2P sandbox credentials** — the merchant id and secret, so QR payments
  can be built against the sandbox rather than a simulator. Needed by S2-10.
- **The phone numbers to allow-list on Twilio** — folded into action 1.
- **The live OTO App repository, or a change-freeze date** — see
  `OPEN_QUESTIONS.md` §0 and §0b. Every commit made to the live app after our
  export widens a gap someone has to close by hand.

## 7. And six decisions only the owner can make

These are choices, not chores. Each is written up in full in
`OPEN_QUESTIONS.md` with what it costs and what we are assuming meanwhile, so
nothing is blocked while they are open:

1. **Should a menu import ever remove things?** Our answer is never — only an
   explicit `archive`. Worth confirming, because the other reading ("the sheet
   *is* the menu") differs by an entire menu. (§7a)
2. **A short code on every menu item.** Safe importing needs a stable key and
   the menu has none. It means inventing a short code per item; the
   alternative silently duplicates items the first time one is renamed. (§7b)
3. **The member-tier control on the admin Members screen: wire it, or remove
   it?** (§7c)
4. **What "staff category / department" should mean** — rostering, or
   permission scoping? The answers build different things. (§7d)
5. **How far LINE should go** — a messaging channel only, or visitor
   self-registration too? (§7e)
6. **Three smaller menu-sheet questions** — allergens, weekday/weekend F&B
   prices, and whether item cost belongs in a file that gets emailed around.
   (§7f)

---

# Half two — what we build, in order

## First: broken, or never built?

The owner asked about editing tiers because he remembers it not working.
"It is broken" and "we never built it" are different answers with very
different costs, so they are separated here before anything is sequenced.

| What he tried | Verdict | What that means |
|---|---|---|
| Member tier, from the admin **Members** screen | **Broken** | The control exists, accepts a change, closes without complaint, and discards it. Worst kind — it looks saved. |
| Member tier, from the **till** | **Works** | Proof type, expiry date, audited, stamped with who checked it and where. |
| **Adding** a role to a staff account | **Never built** | Removing one is built. Adding is not, and the endpoint it would call has no caller. So removing a role is currently a one-way door. |
| Staff **department / category** | **Never built, end to end** | The table and the permission engine support it; no API field and no screen do. |
| Staff **name / phone** on an existing account | **Never built (screen)** | The API accepts a phone change; nothing sends one. Today a staff member who changes number must be deactivated and re-invited. |
| **Tier definitions** (Tiers & Pricing screen) | **Never built (persistence)** | In-memory by Sprint 1 design, like roughly twenty other admin panels. Add a tier, refresh, it is gone. |
| **Photo upload** | **Half built** | The server half now works end to end. No screen in any app uploads or displays a photo. |
| **Menu import / export** | **Never built — and neither is the menu** | The menu screens run entirely in the browser's memory. There is no menu table, no menu service, and no way to save a menu item at all. |
| OTO App **"tenant not found"** | **Broken — a real bug, reproduced** | Root cause found and a one-file fix written (uncommitted). |
| POS **temporary password** dead end | **Broken — a gap between two built things** | The temporary password works; the POS has nowhere to change it, so it strands the person it was meant to help. |

Two of these deserve emphasis:

- **The tier bug is half-built, not overlooked.** The code carries a comment
  saying tier editing "stays out of Sprint 1", while the dialog above it
  offers a tier picker and a proof-type picker. Meanwhile the panel's own
  footer reads *"Changes are saved to the database and audited."* The screen
  asserts the opposite of what it does. That is worth fixing whichever way the
  owner decides, because **the pricing engine reads tier** — a member left on
  the wrong one is charged the wrong price.
- **Menu import/export is not a feature added to a working menu.** It arrives
  with the menu's first real persistence. That single fact dominates the
  sizing below.

## The dependency on the Lucky Wheel booth

Another session is building the booth in this same working tree right now. It
owns these paths, and nothing below edits them:

`packages/box-agent/**` · `packages/db/migrations/**` ·
`packages/db/src/schema/edge.ts` · the booth/sync/box/ops services ·
`apps/api/src/routes/booth.ts` · `apps/api/src/app.ts` · the booth tests ·
`apps/console/src/components/health/**` and `Health.tsx` · `apps/booth/**`

**Only one thing in this queue collides: a database migration.** The menu
needs new tables, Drizzle writes every migration into one shared journal file
under `packages/db/migrations/`, and two sessions generating into it will
conflict — there is already an uncommitted booth migration sitting there.

Everything else is arranged to avoid the overlap. In particular the menu's new
endpoints go **inside the existing `apps/api/src/routes/catalog.ts`**, which
is already registered, so `app.ts` is never touched.

## The queue

| # | Item | Size | Can start | Waits on |
|---|---|---|---|---|
| **B0** | Four one-line fixes (below) | ~1 hour total | **now** | — |
| **B1** | POS password-change screen — the temporary-password dead end | half a day | **now** | — |
| **B2** | "Add role" control on a staff account | ~half a day | **now** | — |
| **B3** | Member tier on the admin screen — wire it, or remove it | half a day | **now** | owner decision §7c |
| **B4** | Photo upload and profile editing on the Account screen | half a day | **now** (works once CORS is set) | owner action 2 |
| **B5** | OTO App tenant fix — review, test, commit | ~2 hours | **now** | — |
| **B6** | OTO App sample data — commit the script, run it on staging | ~1 hour | **now** | owner action 3 for the run |
| **B7** | Menu persistence — the real work | **2–3 days** | **waits** | booth migration |
| **B8** | Menu export to Excel | ~1 day | after B7 | B7 |
| **B9** | Menu import — preview only, writes nothing | ~1.5 days | after B8 | B8 |
| **B10** | Menu import — apply | ~1 day | after B9 | B9 |
| **B11** | Staff name / phone editing | ~half a day | **now** | — |
| **B12** | SMS through Twilio Verify | ~half a day | **now** | owner picks route (action 5) |
| **B13** | Shop / Retail import and export | ~half a day | after B10 | B10 |
| **B14** | Staff department / category | **2–3 days** | **waits** | owner decision §7d, and a migration |
| **B15** | LINE messaging adapter | with S2-19 | later | S2-19, owner action 4 |

Roughly: **three days of small, high-value fixes that can all start
immediately**, then the menu, which is a week on its own and cannot start
until the booth migration lands.

---

## The items in detail

### B0 — Four one-line fixes · ~1 hour · start now

Each was found while investigating something else. None is urgent alone;
together they are an hour.

1. **Thai text will arrive mangled in every exported spreadsheet.**
   `apps/pos/src/lib/csv.ts:24` writes the file without a byte-order mark.
   Excel on Windows then reads it in the system's own character set and Thai
   becomes gibberish. Latent today only because every report row is currently
   English — it breaks the first time a Thai name appears in one. Three bytes
   to fix.
2. **`instagram` is storable but not settable.**
   `apps/api/src/routes/members.ts:288` and `:370` accept
   `whatsapp | telegram | line`, while the database permits `instagram` too.
   Worth fixing before any LINE work writes to the same column.
3. **The SMS adapter throws away the reason it failed.**
   `apps/api/src/services/sms.ts` keeps the HTTP status and deliberately
   discards Twilio's message — a sound privacy choice, since that text quotes
   the recipient's number. But Twilio also returns a **numeric** code, and
   `572002` (trial restriction), `21608` (unverified number) and `30018`
   (sender not registered) are three different problems for three different
   people. Today all three read as "status 422", which is why diagnosing this
   took live API calls rather than a log read. Keep the number, not the text.
4. **A profile photo can be an image that was never uploaded.**
   `apps/api/src/routes/me.ts:23-28` derives the photo from *the most recent
   file record owned by the account*, not from a stored column. Register a
   file and abandon the upload, and that becomes the account's photo — and
   asking for it returns "no such object". Nothing displays a photo today so
   nobody can see it, but B4 builds exactly the screen that would show a
   broken image. Either record the photo on the account explicitly, or skip
   records with no file behind them.

### B1 — The POS password-change screen · half a day · start now

**What it is.** When an administrator issues a temporary password, the person
signs in, the POS sends them to pick a station, and the station list is
refused with a raw error message. There is no way forward inside the POS. The
only escape today is to go to the launcher and change the password there.

**Why it is worth doing first.** The temporary password is our workaround for
the SMS problem. Right now the workaround hands someone a password and then
strands them.

**Files:** `apps/pos/src/App.tsx` (one gate, before the station gate),
`apps/pos/src/auth/OperatorContext.tsx` (carry the flag through, clear it
after a successful change), and a new POS-styled panel modelled on
`apps/launcher/src/components/ChangePasswordPanel.tsx`.

No API or database work: the server already refuses correctly, and
`apps/pos/src/api/platform.ts:64` already exports the call — it simply has no
caller. ~100–120 lines across three files.

### B2 — "Add role" on a staff account · ~half a day · start now

**What it is.** The permissions dialog on a login user lists the roles it has,
each with a Remove button, and offers no way to add one. So roles can only
ever be set once, at invite time; remove one by mistake and the account must
be deactivated and re-invited.

**Why it is cheap.** The endpoint exists and works. The browser-side wrapper
exists too — `apps/pos/src/api/platform.ts:320` — with zero callers. The
role and scope selects already exist in the invite dialog and can be reused.

**Files:** `apps/pos/src/components/admin/access/LoginUsersPanel.tsx` and its
permissions dialog. ~40 lines.

**Worth:** closes a one-way door. Small, and the cost of *not* doing it is a
deactivated account.

### B3 — The member tier on the admin screen · half a day · needs a decision

Two clean options; the owner picks (see `OPEN_QUESTIONS.md` §7c).

**(a) Wire it properly.** Add the missing document-expiry date field — the
admin dialog has no date input at all, while the server requires an expiry —
call the tier-verification endpoint the till already uses, and handle clearing
back to the default tier. ~40 lines across
`apps/pos/src/components/admin/members/MembersPanel.tsx` and
`MemberFormDialog.tsx`.

**(b) Remove the control** so the till stays the single place a tier changes,
and the screen stops promising something it does not do. ~30 lines deleted.

(a) is better if reception should be able to correct a tier without ringing up
a sale. Either way the footer text that claims tier changes are saved must go
or become true.

### B4 — Photo upload and profile editing · half a day · start now

**What it is.** There is no profile screen in any app. `apps/launcher/src/pages/Account.tsx`
is read-only — sessions and refusals, with a "sign out everywhere" button.
Nothing anywhere uploads a file; nothing displays a photo.

**Why it is only half a day.** The server half is finished and was verified
end to end on staging today: register a file, upload it, ask for it back,
receive the exact bytes. Four pieces remain:

1. The bucket CORS rule — **owner action 2**, no code.
2. An avatar block on the Account screen: file picker → register → upload →
   re-read the profile. ~80 lines.
3. Displaying it, with initials as the fallback. ~20 lines.
4. Editable name, nickname and email while that screen is open — the profile
   endpoint accepts them and nothing sends them. Small, and this is its
   natural home.

Do **B0.4** in the same pass, or the first abandoned upload becomes a broken
image on everyone's screen.

### B5 — The OTO App tenant fix · ~2 hours · start now

**What it is.** Saving a batch of staff records fails with *"Tenant ID not
found"*. Reproduced on staging.

**Root cause.** The app resolves which tenant a request belongs to in two
steps — the user's branch access, then the first branch on file. On staging
both are empty, because a launcher-provisioned user gets no branch access and
the branch table was never populated. The result is an undefined value that
several handlers treat as always present.

**The same gap breaks more than the one screen**, all confirmed live:

| Screen | What it does when the tenant is missing |
|---|---|
| Bulk staff upload | Refuses with "Tenant ID not found" |
| Org Chart | Says **Unauthorized** — it looks like you were signed out |
| Creating a duty type | A raw database error |
| The whole events module | Returns **empty, with no error at all** |

**The fix** is one file, `apps/oto-app/server/storage.ts`, already written and
sitting uncommitted in the working tree. It adds one more step to the lookup —
find the tenant by its known name, which is exactly where the rest of the
app's own helpers already end up. It **looks up and never creates**, because a
read path must not write.

It also adds a missing import that two existing statements already depended
on — a latent crash waiting for precisely this situation.

**Remaining work:** review it, add a test, run the typecheck, commit. After
the fix and the sample data, the Org Chart returns 24 nodes.

### B6 — OTO App sample data · ~1 hour · start now

**What it is.** A re-runnable script that fills the OTO App's screens with
invented but realistic staff records, at
`apps/oto-app/script/sample/` (untracked today).

Every write is find-or-create on a natural key, so it can be run repeatedly.
The only change it ever makes to an existing row is filling in a blank the row
cannot work without. It is deliberately separate from the existing
insert-blindly scripts.

**Remaining work:** commit it, and run it once on staging — which needs
**owner action 3**. The 116 records already loaded through the app's screens
cover the visible screens; the run adds the ~400 attendance events that have
no screen to enter them through.

**Three things worth knowing, all found the hard way:**

1. The Today task panel is a **personal** workspace, not a branch board — it
   deliberately shows only what is assigned to you or your department. An
   administrator with no staff record sees "No pending tasks" with ten tasks
   sitting there. The script assigns two to the administrator so the panel has
   content.
2. The Roles screen filters by the branch in the header, so roles with no
   branch link render as "No roles yet" even when twelve exist.
3. Branch access is only filled in for administrators, who already see every
   branch. A provisioned manager or ordinary staff user still sees nothing
   until an administrator grants them access inside the app — that is their
   decision and the script does not make it for them.

### B7 — Menu persistence · 2–3 days · **waits on the booth migration**

**This is the prerequisite for everything about importing a menu, and it is
most of the work.**

Today the menu screens read and write an in-memory store. The panel itself
still says so: *"Changes are kept in memory for this prototype and reset on
page reload."* There is no menu table, no menu service, and no way to save a
menu item. The catalogue's `product` table is a five-field placeholder with no
prep station, no modifiers, no translations, no cost and no weekday/weekend
pair — it is not the menu.

**What it involves:**

- Tables for menu categories and menu items matching the shapes the approved
  design already uses: prices in satang as a weekday/weekend pair,
  translations, prep-station and tax-category overrides that a sub-category
  inherits from its parent, plus **two new fields the design does not have —
  a short code and an archive date**.
- A menu service, and read/write endpoints added **inside the existing
  `apps/api/src/routes/catalog.ts`** — so no new route file and no edit to
  `app.ts`, which the booth session owns.
- Repointing `apps/pos/src/components/admin/menu/` and the category screens off
  the in-memory store, and deleting that "kept in memory" line.
- New permissions. The catalogue has none for a menu today.

**The wait.** Drizzle writes every migration into one shared journal, and the
booth session has an uncommitted migration in there now. Two sessions
generating into it will collide. So either the booth work lands first, or the
menu's migration is explicitly handed to that session to generate. **This is
the only hard dependency in the queue.**

Two new fields deserve a sentence each, because both are additions to an
approved design:

- **A code** is what makes re-importing a file an *update* instead of a second
  copy of the menu. Matching on name instead would silently duplicate an item
  the first time one is renamed — and leave the old one on the till. The retail
  items already have a code; menu items have only a generated internal id.
- **An archive date**, because there is currently nothing to archive a menu
  item *to* — the screen deletes outright, and past orders reference these
  items.

### B8 — Menu export · ~1 day · after B7

Two sheets plus a help sheet, written as a real `.xlsx` file.

**Why not CSV**, since that is the obvious choice: the whole point of this
feature is export → edit → import, and CSV fails in the middle. Excel on
Windows mangles Thai in a CSV unless a specific marker is present, and even
with it, re-saving from Excel or Google Sheets can drop that marker. Excel also
coerces types on a CSV — a code like `2-1` becomes a date and leading zeros
vanish, which corrupts exactly the column that keeps re-imports safe. An
`.xlsx` stores text unambiguously, keeps cell types explicit, and is what
someone means when they say "Excel".

**Sheet 1 — Menu items:** code, English and Thai name, English and Thai
description, category and optional sub-category, weekday price, weekend price
(blank means the same as weekday — the approved design's own rule), cost,
prep station, tax category, available, modifier groups by name, and an action
column whose only value is `archive`.

**Sheet 2 — Categories:** code, names, parent, sort order, and the default
prep station and tax category — required on a top-level category and optional
on a sub-category, which is the design's own rule.

**Sheet 3 — How to fill this in:** every allowed value, what blank means in
each column, and the two or three rules a person needs.

**The empty-menu case matters most**, because it is both the first-ever use and
the demo path. Exporting an empty menu must produce a usable template — full
headers, the help sheet populated, three greyed example rows clearly marked to
delete, and the seven existing categories pre-filled so there is something
valid to reference. An export that hands back a bare header row is the version
of this feature that fails in front of the owner.

**Where the buttons go:** the menu screen's header row already holds the item
count on the left and "Add item" on the right. Export and Import go in that
right-hand group, just left of "Add item", in the same outline style as the
existing export buttons on the reports screens.

**One rule that outlives the format choice:** any cell whose text starts with
`=`, `+`, `-` or `@` must be written as explicit text, never left to be
interpreted. A menu item named `+1 Topping` is otherwise a formula.

**Libraries:** `write-excel-file` and `read-excel-file` — both MIT, both
actively published, one small dependency each, no advisories. The two obvious
alternatives are both rejected on security: one carries a critical
prototype-pollution flaw **on the read path** and has shipped nothing in three
years; the other's fix was never published to npm. Worth noting that the
vulnerability databases have not yet ingested the 2026 advisories for the
first, so a clean automated audit would be misleading here.

**Worth on its own:** shippable before any import exists. The owner can
download the file and see exactly what the columns are.

### B9 — Menu import, preview only · ~1.5 days · after B8

Parses and validates, **writes nothing**, and returns what *would* happen:
counts of new, changed, archived and unchanged items, a row-by-row list of
old value → new value, and a token tying the confirmation to exactly what was
previewed. Demoable on its own.

**Three rules that shape it:**

- **Matching is by id first, then code — never by name.** A row with neither
  is always a new item, which is why the code column is required: without it,
  importing the same file twice creates the menu twice. A row whose code
  already belongs to a different item is an error, not a merge.
- **Items in the system but not in the sheet are left completely alone.** The
  realistic use is partial — export, add a desserts section, import. Treating
  the sheet as the whole menu would mean that file silently withdrawing
  everything it did not mention. The cost of this choice is honest and gets
  said on the screen in as many words: *an import can never remove something
  you forgot to include.* Removal is explicit only. (This is
  `OPEN_QUESTIONS.md` §7a — genuinely the owner's call.)
- **One bad row rejects the whole file — and the report lists every error, not
  the first.** A menu is one document; a half-applied import leaves no way to
  know what landed. Rejecting everything is recoverable, a half-applied menu is
  not. That is only defensible if validation runs to the end and collects
  everything: the row number as Excel shows it, the column, and what was wrong
  — *"Row 14, price_weekday: expected a number, found '฿220'"*.

**Upload:** the file arrives in the request body, with a size limit on that one
route. A menu workbook of a few hundred rows is well under 100 KB. This avoids
a new dependency, and avoids depending on the storage bucket — whose browser
access is the open item in owner action 2.

### B10 — Menu import, apply · ~1 day · after B9

Takes the preview's token and applies it in a **single transaction** — all
rows or none. Nothing is ever written without the second click. If the menu
changed underneath between preview and confirmation, the confirmation is
refused and the preview must be re-run, because otherwise the numbers the
owner just approved are a lie.

Re-importing the same file a day later is **not** an error: every row matches
and resolves to "unchanged", which is correct for a file that describes a
desired state.

Every created, changed and archived item records an audit entry, plus one for
the import itself carrying the filename, the counts and a fingerprint of the
contents.

**Permission:** importing gets its own, separate from editing one item.
Changing one price and replacing eighty in a single click are different risks.
Import goes to administrators and branch managers only — not to reception,
which currently inherits the catalogue-reading bundle.

### B11 — Staff name and phone editing · ~half a day · start now

There is no Edit button on a login user's row. The API accepts a phone change;
the screen only ever sends a status change. A staff member who changes their
number must be deactivated and re-invited.

**Files:** `apps/pos/src/components/admin/access/LoginUsersPanel.tsx`, and
widening the account-update endpoint to accept a name.

### B12 — SMS through Twilio Verify · ~half a day · needs the owner's route

If the owner takes the recommended route in **action 5**, this replaces our
direct message sending with Twilio's Verify product, which carries Twilio's
pre-registered Thai senders. Our side only: the SMS interface already has
swappable adapters chosen by a single setting.

Also worth knowing what we **deliberately will not build**: a staging adapter
that shows the code to an administrator on screen or in a log. Staging is on
the public internet and a verification code is a credential — anything that
displays one hands that account to whoever can see the screen. The
temporary-password route already gives an administrator a scoped, audited,
single-use way in, which is strictly better. The codebase already records this
reasoning from a previous round; re-opening it would undo that.

### B13 — Shop / Retail import and export · ~half a day · after B10

The same pattern, and the easier case: retail items already have a code, so
there is no new field and no matching question.

### B14 — Staff department / category · 2–3 days · waits

Missing end to end above the database. The table exists, the staff record has
a department field, and the permission engine fully supports a department as a
scope — but the invite dialog has no such field, the account endpoints accept
none, and no route lists departments.

**Needs the owner's answer first** (`OPEN_QUESTIONS.md` §7d): rostering and
permission scoping build different things. It also needs a migration, so it
sits behind the same booth dependency as B7.

### B15 — LINE messaging adapter · with S2-19

Build the LINE adapter behind the messaging-channel interface that ticket
already defines, and land per-channel handle storage as part of the inbox
contact table — so a LINE identifier has a home from day one and is never
retrofitted onto the member record.

**Do not put LINE behind the SMS interface.** SMS delivers to a phone number;
LINE delivers to an identifier that only means anything inside one channel.
Conflating them pushes channel resolution into the wrong layer.

**Visitor self-registration over LINE comes after the inbox**, and one design
decision keeps it simple: **ask for the phone number in the LINE registration
form.** LINE will not give us one — a phone number sits behind a partner-level
permission we do not have — and our member record is keyed on phone. Capturing
it in the form keeps the phone as the single identity, and makes "this phone
already exists" the *correct* outcome rather than an error: attach the LINE
handle to the member who is already there.

Two residues that do not vanish, and are worth knowing before this is built:

- **A phone captured on LINE is claimed, not verified.** A rule worth adopting
  now, which costs nothing to hold: a LINE-created member with an unverified
  phone holds nothing of value — no wallet, no credit — until reception
  confirms them in person. Today a member record carries nothing worth
  stealing; once child wallets arrive, an unverified phone becomes a way to
  claim someone else's money.
- **The same person on two different numbers** — registers on LINE with a
  foreign number, gives a Thai one at the till. Two records, one human, and
  phone uniqueness cannot catch it because the numbers genuinely differ. So a
  merge tool is needed eventually regardless. It is a proper ticket, not an
  afternoon: a merge must explicitly move children rather than let allergy and
  medical notes disappear with a guardian, must keep the absorbed phone
  findable, and must leave a marker so an old QR code still resolves. Later —
  and the form decision above keeps it rare.

---

## What was not done here

No code was changed and nothing was committed while writing this. The OTO App
tenant fix and the sample-data script are in the working tree from the
investigation that produced them, uncommitted, and are listed above as B5 and
B6 precisely so they are finished properly rather than left there.

No production data was read, copied or uploaded. Every record now on staging
is invented.
