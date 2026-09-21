# Playing with staging: every simulator and test control

_Written 2026-09-21, after S2-06's device half went live. Kept current as each
ticket adds controls._

**If you only do one thing:** sign in to the Console, open Devices → Virtual
box 1, take the paper out of Receipt Printer 1, and run a test print from the
POS. In one minute you will see the job waiting rather than lost, the till
saying *why* in plain words, and — when you clear the fault — the receipt
printing itself with nobody pressing anything twice. That is the whole of
this sprint's printing work in one gesture. Do it after 10:00; the note on
opening hours below explains why.

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
| Device faults and scanning | **Devices** → open a box → *Simulator* panel |
| What came off the paper | **Devices** → open a box → *Printing* panel |
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
> The seeded branch is open **10:00–20:00**, which is what the park's own SOP
> says. It was seeded an hour late until 21 Sept; the hour mattered, because
> it meant expecting every box to answer for an hour after the park was dark.
>
> **The paper-out rule is gated the same way**, so a walkthrough that starts
> before 10:00 will inject a paper fault and see no alert. That is not a
> fault in the alerting — but it is the one thing in this document most
> likely to look like one, so start after the park would have opened, or
> widen the hours in Console → Branches first.

**Resume heartbeats** — the box comes back and the alert resolves itself. An
alert that closes on its own is the one you can trust when it opens.

**Advance box clock** — pushes the box's clock 120 seconds ahead. This is not
cosmetic: a box with a wrong clock stamps the wrong *business date* on
everything it records while offline, which is an accounting problem rather
than a display one. The alert says exactly that.

**Put the box clock back** — undoes it.

### Scanning a band without a scanner

Console → Devices → **Virtual box 1** → **Simulator** → *Scanner and counter
button*.

**Scan** — type a code and press it. The code reaches the box's scanning
service **exactly as one read off a wristband would**, marked as having come
from the simulator so nothing later mistakes a rehearsal for a real scan. Try
a band code, a voucher code, and a code that is simply wrong: the point of
this control is that the refusals are as visible as the successes.

**Press the button** — the button beside the counter is not a scan and is
sent as its own key press. It defaults to `F9` and the field will refuse
`Enter`, which is deliberate: a keyboard-wedge scanner sends `Enter` at the
end of every code it reads, so a counter button bound to `Enter` is
indistinguishable from somebody finishing a scan.

> **Staff badge and PIN are deliberately absent from this panel**, and the
> panel says so where the buttons would be. Every other control here travels
> on the box's command queue, whose payload is stored in the database and
> rendered in the command history on that same page — so a panel that could
> send a PIN would be a panel that writes a credential to a screen. They need
> a path that carries a value without keeping it, and that is not built yet.
> An empty space with a reason in it is better than a control that quietly
> does the wrong thing.

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

**6. A printer runs out during trading.**
Console → Devices → Virtual box 1 → Simulator → Receipt Printer 1 → *Paper
out*. Run a test print from the POS's Print templates panel. The job queues,
the till header turns red within a minute **and says "paper out"** rather
than showing a silent count, and nothing is lost. Clear the fault and the
queued job prints itself. (Do this after 10:00 — see the note on opening
hours above.)

**7. The till says what is wrong, not that something is.**
Same panel, but try **Cover open** and then **Unreachable** on the same
printer, clearing between. The header names each one differently: a lid left
open after a paper change, and a printer whose socket will not open at all,
are different problems for whoever is standing there. This is worth pressing
because until 21 Sept it showed amber "1 job waiting" for all three and never
said which.

**8. A scan, with no scanner in the building.**
Console → Devices → Virtual box 1 → Simulator → *Scanner and counter button*
→ type a code → **Scan**. Then do it again with a code that is nonsense. The
refusal should be as clear as the success — a scanner that silently does
nothing is the commonest complaint about till hardware, and the point of
simulating it is to see the answer, not just the happy path.

**9. The suite is one sign-on.**
Sign in at the launcher once. POS, Console and the OTO App all open with no
second password. Press *Sign out* on the launcher and every one of them ends.

**10. The till survives losing the network — up to a point.**
The POS installs as an app and keeps its shell when the connection drops, so
a staff member does not get a browser error page mid-sale. **What it cannot
do yet is let somebody back in:** unlocking still needs the cloud. See *What
is not simulated yet* at the foot of this page — this is the honest edge of
what is built, and it is better to meet it here than at a counter.

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

## Printing, end to end — what to press and what to look at

This is the part with the most to see, because a printer is the one device
whose output you can look at and immediately tell is wrong.

**Where.** Console → **Devices** → open **Virtual box 1**. Two panels matter:
*Simulator* (the faults) and *Printing* (the queue, and the paper).

### 1. Print something, and look at it

POS → **Admin → Print templates** → open **Standard receipt** → **Test print**.

Then Console → Devices → Virtual box 1 → **Printing** → *Refresh*. The job is
listed `printed`, and below it is **the picture the printer was told to burn**
— rebuilt by the simulator from the bytes it received, not from anything the
Console drew. Scroll it: the Thai line `สวัสดี OTO Park` and the Cyrillic
`Привет` are rasterised glyphs, not boxes.

> The picture is not an illustration. It is produced by parsing the ESC/POS
> the box sent, with the same reader that proves the emitter's bytes in
> `packages/print`, so anything missing from it was missing from the wire.

### 2. Edit the template and print again

Same screen: turn **Show logo** off, put something in **Footer text**, Save,
then **Test print** again. The new printout has the change — with nothing
redeployed and no box restarted. (The edit bumps the template's version, the
version is part of the box's config hash, and the box pulls on its next
heartbeat. That is the whole mechanism.)

Watch the **Live preview** on the right while you type: it redraws a moment
after you stop. That picture is not an illustration either — the platform
renders it with `@oto/print`, the same package that produces the bytes the
printer is sent, so the preview and the paper are one drawing path rather than
two things that resemble each other. It is laid out for the printer *Test
print* would route to, which is why the wristband templates preview narrow.

### 3. Take the paper out

Console → Devices → Virtual box 1 → **Simulator** → *Receipt Printer 1* →
**Paper out**.

Now run a test print. Three things happen and all three are the point:

- the job is **queued**, not failed — it is waiting, not lost;
- the POS station header turns **red** and names the printer (within a minute,
  which is the heartbeat interval);
- nothing prints, and the simulator's log says the bytes were dropped.

Press **Clear faults**, wait for the next heartbeat (or press a test print,
which also nudges the queue), and the job that was waiting comes out. Nobody
pressed print twice.

> Unlike the offline rule above, **paper does not wait for opening hours**.
> A printer with no paper at 08:00 is a printer with no paper at 10:00, and
> the morning shift is there to change the roll — so the `printer.paper_out`
> alert opens whenever the box is reporting, closed park or not. It is a
> warning rather than a critical, so out of hours it waits on the Health page
> instead of paging anybody. *Unreachable* below is the opposite and
> deliberately so: the park's printers are switched off at night, a printer
> that is off cannot be asked about its paper either (it reports *unknown*,
> never *out*), and calling a powered-down printer a fault at 04:00 is raising
> an alert about somebody having gone home.

### 4. Unplug it

Same panel → **Unreachable**. This is different from paper out and reads
differently: the socket does not open at all. The job queues, the header goes
red saying *not answering*, and the Printing panel shows the attempt count
climbing.

### 5. Print something with nowhere to go

POS → a station with no band printer (Booth 1) → a wristband test print. The
job is **skipped**, the till says "not printed", and **no alert is raised**.
That is deliberate: a station with no band printer is a choice somebody made
in Station Setup, not a machine that broke. An alert here would teach everyone
to ignore the alerts that matter.

### 6. Print on the other box

The park's **bar** printer is Counter 2's 80 mm Xprinter, on **virtual box
2** — which is unclaimed by default. A bar-ticket test print aimed there will
sit `queued` until that box is claimed and comes online. That is correct, and
it is also the quickest way to see what a job waiting for an absent box looks
like.

### What is faithfully reproduced, and what is not

The simulators answer the real status commands with the real bit frames —
`DLE EOT n` on the receipt family (one byte, answered even mid-job and even
in error), `ESC ! ?` and `~!T` on the band printers — and refuse a second
connection while one is open, as both families do. What they deliberately do
**not** answer is anything the adapter does not rely on: `GS a` automatic
status back, `SET RESPONSE` per-label acknowledgement, dump mode, the vendor
IP-set command. Each of those is unconfirmed on the park's firmware, and a
simulator that answered them would be rehearsing a path the park cannot use.

### Four things that will happen on real hardware, and what we decided

Worth knowing before the Pi is plugged in, because each is a decision rather
than an accident:

| When | What happens |
|---|---|
| The cable is pulled **mid-job** | The job is `failed`, and **no timer retries it** — paper has already come out, and an unattended retry hands the guest a second receipt beside a torn-off first one. A person pressing reprint is a different act. |
| The printer **answers no status query** | It is printed to anyway, and reported `status unknown`. Some firmware in this family does not answer `DLE EOT` over the LAN board, and a till that refused to sell because of that would be a worse fault. |
| **Two jobs race one printer** | They are serialised; the second waits. Neither vendor document says whether a second connection is refused or stalls, so we never open two. |
| The printer **was removed** while a job waited | The job is `skipped`, not failed. Nobody can fix it by waiting. |

---

## What is not simulated yet

Named here so nobody goes looking for a button that does not exist:

- **A till unlocking with the internet down.** This is the one to know about,
  because it is the one most likely to be assumed working. The signed staff
  badge that makes it possible is built and tested: the cloud signs a shift
  token when somebody picks a station, the box holds the public half, and the
  box can check a badge against its own cached staff list and revoked list
  with nothing to ask. What does **not** exist is the door — the only way in
  today is a route in the cloud, which reads the live database before it does
  anything. So a Raspberry Pi with the mall's link down has a till that keeps
  selling and cannot be unlocked. Three comments in the code claimed
  otherwise and now say what is true; the remaining work is the next ticket's.
- **Staff badge and PIN in the simulator panel.** Deliberate, explained above.
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
