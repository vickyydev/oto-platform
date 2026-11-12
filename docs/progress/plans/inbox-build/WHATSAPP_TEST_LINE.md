# A real WhatsApp number on the unified inbox: what was decided and what is built (12 November 2026)

Ticket: SCRUM-908, "Connect a real WhatsApp number to the unified inbox through
Twilio". This page records the owner's requirement, what was verified, the
decision and the set-up steps, so the work can be picked up at any point.

## What the owner asked

1. First: "I have the twilio account and a whatsapp number ready. I want to
   connect a real whatsapp chat and number with our unified inbox agent."
2. Then, the requirement in full: one assigned test number writes to the park's
   existing WhatsApp support number; the assistant answers that one chat through
   the park's number; staff keep using the park's number for every other
   customer and the assistant never touches those chats.
3. Then, the goal for now: "connect tom number as customer and use any random
   sandbox number assuming as Park operator and communicate 1:1 as live using
   twilio APIs." The assistant replies by itself, "act like a staff from park
   assuming live environment". "Create a separate inbox of Tom's Number for
   Testing and show all his messages there. Keep it general however give an
   option to delete the chat so he can try again with a new message acting as a
   new customer."

The tester's number is a setting on staging, entered by the owner. It is never
written in code, tests, tickets or these documents.

## What was verified

- The inbox had no Twilio connection. Its only WhatsApp code was written for
  Meta's Cloud API directly (`packages/messaging/src/whatsapp-cloud.ts`) and has
  never been live. Twilio was used only for SMS and sign-in codes.
- Twilio's own sign-up page: a number "must not already be registered with
  WhatsApp"; a number on WhatsApp or the WhatsApp Business app must have that
  account deleted first. So the park's number cannot be on Twilio while staff
  use it in the app. (https://www.twilio.com/docs/whatsapp/self-sign-up)
- Meta's "coexistence" mode lets a WhatsApp Business app number also be used
  through the API, with messages mirrored both ways. It is set up only through
  a Meta Solution Partner or Tech Provider that offers it; no evidence was found
  that Twilio does. It needs app version 2.24.17 or higher, unlinks every
  linked device at set-up, switches off disappearing, view-once and
  live-location messages in one-to-one chats, makes broadcast lists read-only,
  does not mirror groups, and drops if the main phone is inactive for about 14
  days. Every customer's message would also reach our side.
  (https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/onboarding-business-app-users/)
- Twilio's WhatsApp sandbox: shared number +1 415 523 8886; each user sends
  `join <code>` first; the join expires after three days; only joined users can
  be messaged; one message every three seconds; only Twilio's three sample
  templates, so the park cannot write first; the join code, the "When a message
  comes in" address and the status callback address are set only in the legacy
  Console under Sandbox settings > Sandbox configuration; testing only.
  (https://www.twilio.com/docs/whatsapp/sandbox)
- Twilio signs every webhook with `X-Twilio-Signature`: HMAC-SHA1 under the
  account's auth token over the exact public address plus the posted fields
  sorted by name. (https://www.twilio.com/docs/usage/webhooks/webhooks-security)
- The Twilio account whose keys are in the repo-root `.env` (never printed) is
  active and upgraded but holds no phone number, no WhatsApp sender and no
  messaging service. The owner had no Console access on 12 November and is
  waiting for an invitation.

## The three ways forward that were put to him

| | What it gives | Risk to the park's live number |
|---|---|---|
| A. Coexistence through a provider that offers it | Exactly the first requirement: the park's own number, staff keep the app | Touches the live number: devices unlinked once, some app features change |
| B. A separate number on Twilio (the sandbox to start) | The same assistant on real WhatsApp, answering only the tester | None |
| C. Automating the app through a linked-device session | The requirement without a provider | Breaks WhatsApp's terms; the number can be banned. Not proposed |

Decided by the owner: B on the sandbox now. A can follow for the park's number.

## What is built (lane `lane/twilio908b-20261112`, not yet landed on 12 November 16:15)

- A Twilio WhatsApp adapter behind the inbox's channel contract
  (`packages/messaging/src/twilio.ts`), provider `twilio`, migration
  provisionally `0121_inbox_twilio_test_line`.
- A webhook: `POST /webhooks/inbox/twilio/:channelAccountId` on the api. The
  same address goes into both sandbox fields.
- Only numbers on the allow-list are answered or sent to. A message from any
  other number gets no reply and is not stored or shown; only a count is kept.
- The test line shows as its own named inbox in the left rail and answers as
  the General team does. Its conversations also appear under All and General.
- Start over: a button on the test line only, for inbox admins. It removes the
  thread and its words and resets the contact's name and language.
- A new line starts with the assistant off, as every number does; it is
  switched to live for this line at set-up, as the owner asked.
- A production deployment refuses to start with the test line switched on.
- Review points being corrected before landing: Start over left a booked party
  linked to the cleared conversation; a message beginning "join" and one more
  word was taken for the sandbox's join command; the allow-list is read with
  the platform's phone rules; a PDF's caption is sent.

## Set-up, once it is deployed to staging

1. Owner, in Render, on the staging api (names only here):
   `INBOX_TWILIO_ENABLED`, `INBOX_TWILIO_PUBLIC_URL` (the api's public https
   address, no path), `INBOX_TWILIO_ACCOUNT_SID_SANDBOX`,
   `INBOX_TWILIO_AUTH_TOKEN_SANDBOX`, `INBOX_TWILIO_ALLOWED_NUMBERS_SANDBOX`
   (the tester's number as one run: plus sign, country code, no spaces).
2. Owner, in the Twilio Console: switch the WhatsApp sandbox on, note the join
   code, paste the one address into "When a message comes in" and "Status
   callback URL".
3. The channel account for the line is created through
   `POST /inbox/test-lines`; the assistant is switched to live for it.
4. The tester sends the join message, then a question. Proof with the tester's
   own phone only.

## Open with the owner

- Should a hand-over on the test line notify the duty birthday manager on
  staging, as live would, or nobody?
- The park's own number: option A, when and with which provider.
