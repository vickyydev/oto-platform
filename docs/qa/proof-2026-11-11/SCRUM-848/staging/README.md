# SCRUM-848 The New guest dialog shows the phone number in the till's format

The till was live at 8bb78f578a836feb6d1eece2690afff51fda5e4e (oto-pos-web-staging dep-dbq99dajnfac73d8eu8g, live from 16:19:01Z) and loaded in a new browser profile.

On an own ZZ TEST till the number 0898020048 (ZZ TEST only, confirmed to belong to no member) was typed on the customer half, and "Sell pass" pressed. The dialog "New guest — enter name" opened and read: "Phone +66 89 802 0048 is not recognised. Enter the guest's name to register them so they're remembered next time." No "+660…" form. Result: Pass. Picture 848-1-new-guest-dialog.png, opened and inspected; the staff identity and the voucher entry are covered with boxes.

The dialog opens only from an event pass card, and staging has no event on sale. The one pass card in the picture ("ZZ TEST SCRUM-848 pass (test card)") was supplied to the browser by the test; nothing was written for it. The member lookup behind the dialog and the dialog itself are the deployed till's.

Cancel closed the dialog. No member write left the till and the number still belongs to no member (read back). The ZZ TEST till was archived and both sessions read 401 after sign-out. The harness is ../../SCRUM-847/staging/proof.mjs and flow.mjs (stepNewGuestDialog).
