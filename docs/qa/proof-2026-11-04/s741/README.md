# SCRUM-741 local proof: a family with a paid child and a sibling to pay

Run on 4 November 2026 at about 15:40 Bangkok on the isolated till harness
(disposable seeded database, local API and POS, Edge), with the simulated payment
gateway switched on by name:

```
PAYMENTS_SIMULATOR=on POS_E2E_SHOTS=<folder> pnpm --filter @oto/pos e2e e2e/family-paid-and-to-pay.spec.ts
```

The family is made the way staging made `ZZ TEST SCRUM-730 Ying`: one child booked
and paid online through the booking site's routes, then a sibling added to the same
registration through the route the till's Add sibling uses. Three cases, all passed.

| Screen | What it shows |
|---|---|
| `s741-01-desktop-board-paid-and-to-pay.png` | Board at 1440 px: `Booked & paid · ZZ TEST Bua` and `To pay · ZZ TEST Nok`, no `no payment needed`, and the two presses read `Check in ZZ TEST Bua` and `Check in ZZ TEST Nok` |
| `s741-02-desktop-paid-child-opens-the-booking.png` | `Check in ZZ TEST Bua` opens that booking's redeem dialog, ฿0 behind it (SCRUM-730 unchanged) |
| `s741-03-phone-family-paid-and-to-pay.png` | Phone at 390 px, the family screen: the same two labels and `Check In ZZ TEST Bua` / `Check In ZZ TEST Nok` |
| `s741-04-desktop-sibling-goes-to-the-till.png` | `Check in ZZ TEST Nok` takes the sibling, and only the sibling, to the till |

A family with one Check in reads exactly as before: one `Check in` (`Check In` on
the phone) and, for a family who all paid, `Booked & paid · no payment needed`.
The unit cases are in `apps/pos/test/s741-family-paid-and-to-pay.test.ts`.

UI additions (CLAUDE.md §7.2): on a family card with more than one Check in, each
press names its children; on a family with both a paid child and one still to pay,
the green paid pill names the paid children and an amber `To pay` pill beside it
names the rest. Both on the iPad board card and the phone's family screen.
