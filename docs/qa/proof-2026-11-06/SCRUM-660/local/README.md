# SCRUM-660 Create BEO with AI Fill: local proof

Built on lane `lane/beo660-20261106`, cut from main `248d41ce8`. Proved
locally on 6 November 2026 with the real platform api, the inbox (its
production build behind `vite preview`) and the OTO App (its own server and
client) on one disposable database (embedded Postgres, dropped afterwards),
driven in Microsoft Edge (headless). Nothing touched staging, a park device,
SMS or payments.

**The model is a stub.** No AI key reaches the OTO App's local run through
the repo's own env loading (the app loads no env file), so no real model was
called. The stub sits behind the Anthropic SDK's own `ANTHROPIC_BASE_URL`, so
the app's real client, request and answer path ran; it answers canned JSON
per language. What the proof shows is everything around the model: which
message is read, how it reaches the app, the review step, the team matching,
what is saved and what is logged. How well a real model reads a real
confirmation is for the staging proof.

## What a person sees

| Step | Screenshot |
|---|---|
| A ZZ TEST birthday chat: the customer's request, the team's final confirmation sent through the inbox's own reply, the date booked, Create BEO | `s660-01-inbox-birthday-chat-with-confirmation.png` |
| Create BEO opens the BEO form in a new tab with AI Fill already run: the review step, "Read from the inbox" with who sent the message and when, the message itself, and the fields it read | `s660-02-create-beo-ai-fill-preview-english.png` |
| The Team section: Nok as Party Host, Ploy as Entertainment Host, the Entertainment department as setup Who, each matched to this park's people and assigned only when ticked (two ticked here) | `s660-03-team-proposals-ticked.png` |
| Load into Editor: the form holds the fields, and Final Message to Parent holds the message word for word; nothing saved yet | `s660-04-loaded-into-the-form-not-saved.png` |
| The Party Host field now names Nok; the Entertainment Host was not ticked and stays empty | `s660-05-party-host-assigned-in-the-form.png` |
| Thai: the same review step, in the message's own words, times as 14:00 and 15:30 | `s660-06-create-beo-ai-fill-preview-thai.png` |
| Thai team row: "น้องนก" is Nok's Thai name, so Nok is proposed | `s660-06b-thai-team-name-matched.png` |
| Russian: the same, in Russian | `s660-07-create-beo-ai-fill-preview-russian.png` |
| Russian team row: "Нок" matches nobody at this park, so it is flagged and nobody is proposed | `s660-07b-russian-team-name-flagged.png` |
| A conversation with no confirmation yet: the form opens as SCRUM-775 opens it, with one line: "AI Fill did not run: no message from the team in this conversation names the date, the time and the party details yet." | `s660-08-no-confirmation-form-opens-with-one-line.png` |
| The event chip opens the form as it always did: no AI Fill, no model call | `s660-09-event-chip-opens-the-form-as-before.png` |

## Read back (`local-proof.json`)

- The platform's pick for each conversation (`GET /inbox/conversations/{id}/beo-confirmation`):
  the final confirmation for English, Thai and Russian (each over the team's
  2 messages: a holding reply, then the confirmation); `message: null` for the
  conversation with only a holding reply. Each answer names the event Book
  Date made.
- Three model calls in all (English, Thai, Russian): each with the built-in
  advice (the park group has no AI settings), the default model
  `claude-opus-5`, no temperature, 16000 max tokens. None for the
  no-confirmation conversation, none for the event chip.
- Nothing saved before Save: after Load into Editor, the event's party host,
  setup plan and kitchen plan rows are still 0 and its child name, adults,
  decoration and Final Message to Parent are still empty in the database.
- Four `auth.handoff_issue` rows with `purpose: inbox.create_beo` and
  `fill: inbox` (the Create BEO presses), and one without `fill` (the chip).
- Three `beo_ai_fill` activity rows, one per run: the event, `source: inbox`,
  the conversation and message ids, `outcome: filled`, the model and where
  the prompt came from, the message's length, the sections filled and the
  team counts. No message text in any of them (checked against phrases from
  all three messages).
- The OTO App's log: an `ai fill run` line per run (sizes, sources, outcome)
  and one `ai fill from the inbox did not run` line (`no_confirmation`); none
  of the messages' phrases appear anywhere in its output.

The harness is `s660-local-proof.mts.txt` (run from `apps/api` with tsx).

## How the message is chosen

The newest message in the conversation that (1) a person on the team wrote
(author `staff`, outbound, on the channel; never the customer's, the
assistant's or a system notice), still has its text, and was not refused by
the channel (`failed`; the assistant's `withdrawn` and `shadow` lines are
excluded too), and (2) names a date, a time and at least one more party
detail: a guest count, food or the programme, in Thai, English or Russian.
Among the team's newest 100 messages. A reminder with only the date and time,
a price quote or a greeting is passed over. The person sees the message that
was read before anything is applied.

## Local gates

| Gate | Result |
|---|---|
| `pnpm --filter @oto/shared typecheck`, `@oto/api`, `@oto/inbox`, `@oto/api-types` | pass (the api prints nothing) |
| `pnpm --filter @oto/api exec vitest run --pool=forks test/inbox-beo-confirmation.test.ts` | 13 / 13 |
| `test/inbox-book-date.test.ts` (SCRUM-775, unchanged) | 23 / 23 |
| the four route guards (`routes-guarded`, `route-write-conformance`, `id-conformance`, `route-scope-target`) | 113 / 113 (four new pins) |
| `test/inbox-read.test.ts`, `test/inbox-actions.test.ts` | 91 / 91 |
| `pnpm api-types:check`; `@oto/api-types` test (seam walker) | matches; 10 / 10 |
| `@oto/shared` `test/inbox.test.ts` | 42 / 42 |
| `@oto/inbox` test (all 12 files) and build | 240 / 240; built |
| OTO App `npm run check:ratchet`; `npm run build` | 418 / 418, no new diagnostic; built |
| OTO App `tests/ai-fill.check.ts` (no database) | 9 / 9 |
| OTO App `tests/beo-inbox-fill.check.ts` (fresh database, both migrators) | 11 / 11 |
| OTO App `tests/directory-inbox-event.check.ts` (SCRUM-775, fresh database) | 9 / 9 |
| `test/s660-beo-confirmation-review.test.ts` (house review) | 8 / 8: six pins, two FINDINGs standing as owner questions (Load into Editor writes the timeline before Save; a read-back of the request is not told from the final confirmation) |
| eslint on every changed `.ts` / `.tsx` outside `apps/oto-app` | clean |

## Staging proof plan (for the landing; ZZ TEST only)

Preconditions: the lane landed on main, CI green on its exact SHA, the api,
inbox and OTO App services live on that SHA. No new setting: the OTO App
service already holds `ANTHROPIC_API_KEY` (read-only check of names, 6
November) and `PLATFORM_API_URL`; it has no `ANTHROPIC_MODEL`, so the model is
the app's default `claude-opus-5`. No migration.

1. On a ZZ TEST simulator channel account at Central Floresta, play one ZZ
   TEST birthday conversation; as a ZZ TEST birthdays-team login reply once
   with a holding line, then send a ZZ TEST final confirmation (date, time,
   kids, menu, cake, "Host: <a ZZ TEST employee's nickname at that park>").
   No real customer conversation is opened or pressed.
2. Book Date, then press Create BEO. Screenshot the review step (the message
   beside it, the fields, the Team section). Tick the host, Load into Editor,
   screenshot the form. Do not save. A real model call is made here.
3. Read back, read-only: one `beo_ai_fill` row naming the event with no text;
   one `auth.handoff_issue` row with `fill: inbox`; the BEO's rows unchanged.
4. A second ZZ TEST conversation with only a holding reply: Book Date, Create
   BEO, screenshot the one line. Repeat step 1 once in Thai and once in
   Russian if the owner wants the real model's reading of each shown.
5. Clean up through the screens: archive the ZZ TEST events in the OTO App and
   mark the ZZ TEST conversations handled.

## Not proven here

- A real model's reading of a real confirmation (the stub answered): staging.
- A birthdays-team agent with a department grant pressing in the browser:
  the api test covers that grant for the read and for Create BEO; the browser
  ran as the seeded admin.
- The OTO App reading the platform as a person whose session the platform
  has since ended: the check file covers the 401 answer (`signed_out`).
