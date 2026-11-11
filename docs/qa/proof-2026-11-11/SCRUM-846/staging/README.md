# SCRUM-846: Console screen proof on staging

Passed on 11 November 2026 on source
`4d45c4d2adf7db4b4762dbdfb1e039f3b426e7ea`. The staging API deploy
`dep-dbq8vpd6e07s73fesr0g` was live at that commit from 15:59:32 UTC; the
run started at 16:03:40 UTC and the deploy was read live again after it.

In the real Edge browser, signed in to the Console, in Devices > Stations at
the staging park (Central Floresta), on ZZ TEST tills only:

1. Created till A with prefix `Z84603` in the station form (HTTP 200) and
   archived it with the form's own button (HTTP 200); read back archived.
2. Created till B with the free prefix `Z84604` (HTTP 200).
3. Edited till B without touching its prefix, twice:
   - renamed it: HTTP 200, the card still shows `Z84604`;
   - set how cards and QR reach it: HTTP 200, the card still shows `Z84604`.
4. Changed till B's prefix to till A's `Z84603`: HTTP 409
   `STATION_CODE_PREFIX_TAKEN`. The form showed: "Receipt prefix Z84603 was
   already used by ZZ TEST SCRUM-846 till A 1794413025829 at this park.
   Choose a different prefix; archiving a till does not free its receipt
   numbers." A read-back showed till B exactly as before the attempt.
5. Changed the prefix to the free `Z84605` in the same form: HTTP 200, the
   card shows `Z84605`.
6. Archived till B, read back both tills archived, signed out; `/me`
   answered 401. No sale was made and no other station was touched.

Inspected pictures (the signed-in badge is masked when in view):

- `846-1-renamed-prefix-kept.png`: the renamed card, prefix `Z84604`.
- `846-2-routing-changed-prefix-kept.png`: after the payment change, same prefix.
- `846-3-archived-prefix-refused.png`: the refusal naming till A.
- `846-4-free-prefix-saved.png`: the card with the new prefix `Z84605`.

What this run does not show: a till that already shared its prefix with
another till before the rule existed. The form can no longer make one, and
staging holds none, so that case rests on the API tests that landed with the
change. The same holds for the receipt-number clash wording in a sale: no
sale was made here.

`receipt.json` holds every request and status. `attempt-1.json` is an
earlier run that stopped in step 3: the harness looked for the QR field by a
label that the QR terminal field also starts with. The rename had saved
(HTTP 200, prefix kept); its two ZZ TEST tills (prefixes `Z84601`,
`Z84602`) were archived and the session closed. `proof.mjs` is the harness
as run, adapted from the SCRUM-809 one.
