# Playing with staging: every simulator and test control

_Written 2026-09-21, after S2-06. Kept current as each ticket adds controls._

Everything here works on **staging only**. Two gates have to agree before any
of it exists: the deployment says it is a playground (`OPS_TEST_CONTROLS`),
and the person asking is a platform administrator. On production these
controls are not disabled — they are **absent**, so there is no switch for
anybody to flip by mistake.

Nothing below needs hardware. That is the point of this sprint's virtual box:
the whole fleet, its printers, its scanner and its faults can be driven from a
browser before a Raspberry Pi is plugged in at the park.

---

## Where to find them

| | |
|---|---|
| Console | <https://oto-console-staging.onrender.com> |
| Sign in | `090 000 0001` / `admin1234` |
| Controls | **Health** page, bottom — *Test controls* |
| What they affect | **Health**, **Failures → Problems**, **Failures → Quarantine**, **Devices** |

The POS is <https://oto-pos-staging.onrender.com> and the suite front door is
<https://oto-launcher-staging.onrender.com>.

---

## The controls, and what each one is for

### Watching the alerting work

**Run the watchdog now** — the watchdog normally compares what should have
run against what did, once a minute. This does it immediately, so you never
wait to see whether a fault you just caused is noticed.

**Send a test alert** — raises a harmless alert and delivers it through every
configured channel. It stays open until somebody presses *Acknowledge*, which
is how you see the difference between *taken* and *resolved*: acknowledging
says somebody is on it, never that it is fixed.

**Record a failed job run** — writes the same failure a genuinely broken job
would. Press it three times and watch Failures group all three into one
problem with a count, rather than three rows. That grouping is the whole
reason the page is usable when something breaks sixty times.

### Making a box misbehave

**Stop heartbeats** — the box goes quiet. Then press *Run the watchdog now*
and it is reported offline, with an alert.

> Worth knowing: the offline rule **only fires during opening hours**. A park
> that is shut is not a park with a broken till. If you stop heartbeats
> outside the branch's hours nothing will happen, and that is correct.
> (Related: the seeded closing time is currently 21:00 where the park's own
> SOP says 20:00 — recorded in `OPEN_QUESTIONS.md`.)

**Resume heartbeats** — the box comes back and the alert resolves itself. An
alert that closes on its own is the one you can trust when it opens.

**Advance box clock** — pushes the box's clock 120 seconds ahead. This is not
cosmetic: a box with a wrong clock stamps the wrong *business date* on
everything it records while offline, which is an accounting problem rather
than a display one. The alert says exactly that.

**Put the box clock back** — undoes it.

### Making the sync ledger misbehave

**Inject poison event** — files one malformed event, exactly as a truncated
or half-written one would arrive. It lands on **Failures → Quarantine** with
an alert, and can be replayed or discarded from there.

> This one is worth pressing twice. It used to jam the box it was aimed at so
> that every subsequent sale was silently discarded as a duplicate, and
> pressing Replay filed a *new* quarantine row each time. Both are fixed;
> pressing it twice now leaves one row per injection and the box keeps
> working.

**Replay last batch** — re-sends the last batch a box pushed. Nothing should
double-apply; the ledger recognises it and answers "duplicate". This is the
control that proves a lost answer costs nothing.

**Reset store (new epoch)** — wipes the box's local store and starts a new
journal. Anything the box was holding is gone, and the cloud refuses events
from the old journal. The nuclear option, and the remedy for a box whose
store is genuinely damaged.

---

## Things to try, in order, that show something real

**1. A box goes dark during trading.**
Stop heartbeats → Run the watchdog now → Health shows it offline with an
alert → Resume heartbeats → the alert resolves itself. Then try the same
thing outside opening hours and watch nothing happen.

**2. One broken thing, sixty times.**
Record a failed job run, three times. Failures shows **one** problem with
`×3`, not three rows.

**3. A fact the cloud would not accept.**
Inject poison event → Failures → Quarantine → the row says *why* it was
refused, and offers Replay and Discard. Press Replay: an injected row can
never apply (it was never a real fact), and the panel says so rather than
pretending. Then press Discard.

**4. A clock nobody noticed.**
Advance box clock → Run the watchdog now → the alert names the consequence,
not the symptom: everything the box stamps while offline lands on the wrong
business date.

**5. Who may stand at which till.**
Console → Devices → edit **Booth 1** → it is restricted to named staff. Sign
in to the POS as reception (`090 000 0002` / `reception1234`) and the booth is
**absent from the picker** — not greyed out, not refusing. Add reception to
its list, reload, and it appears.

**6. The suite is one sign-on.**
Sign in at the launcher once. POS, Console and the OTO App all open with no
second password. Press *Sign out* on the launcher and every one of them ends.

---

## Simulated devices, and what is still only simulated

The seeded fleet has two virtual boxes. Virtual box 1 carries the park's real
device list — both band printers, the kitchen printer, two receipt printers,
a scanner and two card terminals — with the **real models and LAN addresses**
from `DEVICE_INVENTORY.md`, so the switch to hardware is a change of
transport rather than a change of code.

| Simulated today | Real counterpart, when it arrives |
|---|---|
| Receipt printers | Welltech G4 / XP-C260 and XP-80 family, ESC/POS over TCP 9100 |
| Wristband printers | 4B-2082A, TSPL2 label mode |
| Scanner | Zebra DS2278 on the **box**, not the iPad — USB HID with a programmed suffix, or USB CDC serial |
| Card terminals | NEXGO N5 and PAX A920Pro over serial |
| The box itself | Raspberry Pi on the branch LAN |

**Virtual box 2 is deliberately left unclaimed.** It is not a fault: it exists
so the same-person-at-two-tills merge can be demonstrated, and so the "waiting
to be claimed" state has something to show.

### What a printed receipt actually looks like

The print renderer produces the real bytes for both printer families, and its
preview is pixel-for-pixel what the printer would put on paper. Sixteen
committed samples live in `packages/print/test/fixtures/` — open any `.png`
to see a receipt, a wristband, a kitchen ticket or a voucher exactly as it
prints, Thai and all.

---

## What is not simulated yet

Named here so nobody goes looking for a button that does not exist:

- **Printing end to end.** The renderer is done and verified; the adapters
  that open a socket to a printer, and their simulators, are being built now.
- **Scanning.** Same — the service and its simulator are in progress.
- **Payments.** No gateway is wired. `POST /public/bookings` currently marks a
  booking paid with no payment taken; the 2C2P sandbox arrives with S2-10.
- **SMS.** Twilio credentials are a trial account, so a code can only reach a
  phone that has been verified on it. The seeded accounts have known
  passwords, so no walkthrough needs a code.
- **The gate, the wheel and the booth.** Later tickets.

---

## If something looks wrong

Check **Health** first — it is written to answer "is anything wrong right
now" rather than to be a dashboard. Then **Failures**, which groups a
repeating break into one problem, and its **Quarantine** tab, which holds
facts from a till that the cloud refused.

**Activity** is the audit log: who did what, to what, and whether it went
through. Every control on this page writes a row there, so you can always see
that it was you.
