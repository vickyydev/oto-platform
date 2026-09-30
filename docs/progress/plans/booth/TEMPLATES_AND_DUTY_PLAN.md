# Booth templates and the day's staff — the plan of 1 October 2026

_Written from four read-only studies: the print-template system, the booth's staff
attribution end to end, the OTO App's scheduling tables (with the production dump's
real usage), and a survey of modern template-editor UX. Nothing here is built yet
except the quick round in §3. The owner's asks, verbatim in spirit: a preview you
can actually see; the booth's template link should land on the right screen; each
booth should have its own voucher customizer inside the booth tab; the editor needs
a fresh, minimal, modern UI with icons and identifiers; and the day's booth staff
should sync from the OTO App with merged names on the voucher, password sign-in on
the new keyboard, no press-count tricks and no badge scan before a spin._

## 1. What the recon established

**Templates.** `pos.print_template` is scoped operator + branch + type, one live row
per branch and type, six types (`packages/db/src/schema/print.ts:78-139`). The booth
voucher is NOT one of them: its layout is fixed in `packages/print/src/templates/booth.ts`,
its words come from the voucher type, and its footer lookup asks for a template type
(`booth_voucher`) that the schema forbids, so the footer is always empty — dead code
(`packages/box-agent/src/booth.ts:2486-2490`).

**The preview.** A server-rendered 1-bit PNG (the same renderer as the paper — keep
that), shown at ~0.46× in a 280 px frame with no zoom
(`apps/pos/src/components/admin/templates/PrintTemplatePreview.tsx:111`). The
non-integer downscale drops single-dot lines, which is exactly the unreadability in
the owner's screenshot.

**Deep links.** The till back office picks panels in React state; nothing reads the
URL (`apps/pos/src/pages/Admin.tsx:44`). A query parameter survives sign-in and the
launcher hand-off; a hash does not. The Console booth link can only point at `/admin`
today (`apps/console/src/pages/Booths.tsx:975`).

**Staff today.** One box-local session per station (PIN or phone+password); every
spin is attributed to whoever holds the open session; the slip prints "Name (S-XXXX)"
or "unattributed". The standing allowed list (`booth.booth_staff_assignment`) has no
dates. There is no badge scan before a spin — badge sign-in is wired but dead. The
press-count logic the owner remembers is only (a) overlay navigation for signing in
with the red button, and (b) the guest-facing double press for "play again"; neither
identifies anyone.

**The OTO App's duty data (verified in the production dump).** The park assigns booth
duty as week-plan assignments to shift rows in the shift group **"Sale Booth"**
(Central Floresta only; 136 real assignments, 3 people), plus free-text
**duty blocks** named "Sales booth" hung on Reception shifts (17 rows). Identity
chains to the platform as `schedule_assignments.employee_id` → `employees.user_id` →
`users.platform_user_id` → `core.account`. Casual workers have no user at all. The
app's only service API is the unconfigured directory key with no roster endpoint,
and the platform already reads `otoapp.*` directly through a narrow schema
(`apps/api/src/services/oto-app-users.ts`) — an established seam.

## 2. The decisions this plan proposes

**D1 — Deep link and preview visibility are a quick round, not a redesign.**
`?panel=templates` read in the Admin page's initial state (+ optional
`&template=<type>` opening the editor), the booth link updated, and the preview at
an integer scale with zoom presets (Fit / 100% / 200%) in a scrollable frame.
Recommended and started (§3).

**D2 — The booth's voucher customizer lives on booth settings, not on the template
table.** The booth voucher is per-station by nature and is not template-driven
today. Adding `voucher` fields to `booth.booth_settings` (header line, footer line,
show logo, and the toggleable rows) publishes with the wheel config, reaches the box
in the bundle it already pulls, and replaces the dead footer lookup. The Console
booth page gets a "Voucher slip" card with a live preview rendered by the same
`@oto/print` renderer through a small preview route. The alternative — generic
station-scoped `print_template` rows — is more general but triples the surface
(migration, resolution order, bundle, cloud lookups, station picker) for a need only
the booth has. If a second station kind ever needs its own template, that
generalisation is still open. **Recommended: booth settings.**

**D3 — The editor redesign follows the researched patterns, in our design
language.** The full brief is in the UX study; the binding points: preview
dot-for-dot with zoom and a paper/scenario switcher; controls grouped by region of
the paper (Top / Body / Bottom) with icons and two-line rows; visibility as an eye
control with the region disappearing from the preview; a sticky save bar
("Unsaved changes · Discard · Save"); test print attached to the preview, naming the
printer, reading "Save & print test" when dirty; rarely-used options behind one
disclosure; template list as cards with type icon, live thumbnail and an
"in use at N stations" chip. Anti-patterns to kill: the wall of identical toggle
rows inside a form with a Save button, and the afterthought preview. The warm/cream
palette stays; structure comes from spacing, icons and grouping, not new colours.

**D4 — The day's booth staff sync from the OTO App, read directly.** A platform
reader (the established narrow-schema seam) computes "who is assigned to this booth
today": assignments whose shift row sits in a booth-named shift group, department or
role, plus duty blocks whose name contains "booth" — free text normalised
case-insensitively with trailing spaces trimmed, because that is what the real rows
look like. The match rule is stored per booth with that default, editable in the
Console. The directory-API and event-push alternatives both need new code inside the
lifted app plus a shared secret that is not configured; the direct read needs
neither and a nightly reconcile keeps it honest. **Recommended: direct read.**

New table `booth_duty_assignment` (station, business date, account, display name,
source: app_schedule / app_duty_block / manual / self_assigned, synced_at), audited
as `booth_duty.assign` so every row appears in Activity — the log the owner asked
for — plus a readable "Today's staff" list on the booth page with a
"Sync now" button. Sync runs on a morning job at branch open and on demand.

**D5 — The fallback ladder when the sync finds nobody.**
1. The Console shows "nobody assigned for today" on the booth page and Health, with
   one-click manual assignment (audited as `manual`).
2. Sign-in eligibility stays the union of the day's roster and the standing allowed
   list, so a stand-in can always sign in with their password; doing so adds them to
   the day's roster as `self_assigned`, with its own log line, so the printed label
   stays truthful.
3. Nobody signed in at all: the wheel still plays, spins record unattributed, and
   the existing `booth.unattributed` alert fires. Nothing blocks a guest.
Employees the sync cannot map to a platform account (no app user, no linked
account) are listed by name in the sync log as unmatched rather than silently
dropped.

**D6 — Merged attribution.** The voucher's Staff row prints the merged label of the
day's roster ("Tom and Jerry"), and stats in the POS, Console and app credit every
roster member. Underneath, the spin row keeps recording the individually signed-in
account when there is one — extra precision that costs nothing and settles disputes —
but every display surface uses the merged day label. Password sign-in on the booth
keyboard stays exactly as built; there is no badge scan before a spin (there never
was), and the red-button overlay navigation becomes unnecessary with the keyboard
but stays as a harmless fallback. The guest-facing double press for "play again" is
part of the game, not staff identity, and is untouched.

## 3. The rounds

| Round | Scope | Size | State |
|---|---|---|---|
| Q | D1: deep link + preview zoom (Admin.tsx, TemplateEditor, PrintTemplatePreview, Booths.tsx link) | quick | launched with this plan |
| T1 | D2: booth voucher customizer (booth_settings migration, publish + bundle + box print, Console card with live preview route) | story | awaiting the owner's word |
| T2 | D3: the template editor redesign per the UX brief | story | awaiting the owner's word |
| D | D4-D6: duty sync, log, fallbacks, merged label, stats (platform migration + reader + job + Console + box label) | story, possibly split sync/label | awaiting the owner's word |

T1 and T2 touch the same editor area; T1 lands first so the redesign styles both
screens once. The duty round is independent and can run in parallel with T2.

## 4. Open decisions for the owner

1. **Casual workers** appear in the merged voucher label by name (they can never
   sign in — no account). Recommended: yes in the label, no as sign-in.
2. **A stand-in not on the synced roster** who signs in joins the day's label as
   self-assigned, logged. Recommended: yes (D5.2). The alternative is refusing
   sign-in to unassigned staff, which strands a shift swap.
3. **Sync moment**: morning job at branch open plus the manual button. Alternative:
   only at first sign-in.
4. **The match rule default** ("Sale Booth" group, plus duty blocks containing
   "booth"): confirm with the client that this is how duties will keep being
   assigned — it matches every real row in the dump.
5. **Does the redesign extend to the Console booth page's remaining panels** (status
   strip chips, empty states per the UX brief) or only the template screens for now?

## 5. What this plan does not touch

The wheel's game flow and the guest experience; the voucher's redemption rules;
the standing allowed list and PIN sign-in; the app lane's scheduling screens
(the sync only reads); the migration numbering discipline (each round takes the
next number when it lands, never reserved).
