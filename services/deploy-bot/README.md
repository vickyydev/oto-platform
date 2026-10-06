# Deploy bot

Posts one WhatsApp message each morning to a group, saying in plain English
what went live since the last message. If nothing new went live, it says
nothing that day.

It is a helper, not part of the suite. Nothing else in the repository depends
on it, and it sits outside the pnpm workspace with its own `package.json` and
npm lockfile (the same arrangement as `apps/oto-app`).

## How it works

Every minute the bot checks the clock in `DIGEST_TZ`. Once a day, at
`DIGEST_TIME`, it:

1. Asks the **Render API** which deploys of the watched services went live
   since the last digest. Nothing about deploys is stored; Render is the record.
2. Compares the commit now running with the commit it last announced. The same
   commit (a restart, a settings change) means nothing is new, and it stops.
3. Collects the commits from those same deploy records. Render keeps one commit
   per deploy, with its full message. Because nearly every commit here is pushed
   and deployed on its own, that is nearly the whole history. Commits whose own
   deploy failed or was cancelled are included once a later deploy carries them
   live. The one blind spot is a commit pushed together with others and never
   deployed by itself: Render never saw it, so the digest cannot mention it.
4. Asks **Claude** (`SUMMARY_MODEL`, Opus 5 by default) to turn the commits
   into a few sections of short bullets, if `ANTHROPIC_API_KEY` is set. The
   model returns structured data, not formatted text; the layout is applied in
   code. If the call fails for any reason, the digest falls back to the commit
   subjects with their `type(scope):` prefixes removed.
5. Formats the message, splits it if it is long, and queues the parts.

A message looks like this:

```
🚀 *OTO staging — what's new*
_Sun 20 Sept_

*Till and reception*
• Reception can pick a station when signing in

*Admin console*
• A new Devices page lists every box and its status

_Updated: API, Console, POS · 14 changes_
```

### Message size and pacing

The habits below keep an automated number from looking like one.

- A part is at most `PART_MAX_CHARS` (1500). Longer digests are split
  **between bullets**, never inside one; a section that runs over carries its
  title into the next part as "(cont.)".
- Parts go out `PART_INTERVAL_MIN` (30) minutes apart, at most `MAX_PARTS` (4).
  Anything beyond that is dropped and counted ("…and 6 more changes").
- Bullets have `* _ ~` and backticks removed, so stray characters cannot bold
  or strike through half a message. Messages contain no links.
- The bot shows "typing…" for a few seconds before each message.
- One message a day at most, and none on days with nothing new.

### Delivery

Messages are written to an outbox table and sent from there. One that comes due
while WhatsApp is reconnecting, or while the process restarts, is sent when the
connection returns. One that cannot be delivered within `MESSAGE_TTL_HOURS` is
dropped, because a morning note at night is worse than none. If the bot was
down at `DIGEST_TIME`, it sends on return up to `DIGEST_LATEST`; after that it
waits for tomorrow, and tomorrow's digest covers both days.

## What it stores

One Postgres schema, `deploybot`, created by the bot on first boot:

| Table     | Holds                                                                         |
| --------- | ----------------------------------------------------------------------------- |
| `wa_auth` | The WhatsApp session. **Whoever can read this can send as the bot's number.** |
| `outbox`  | Messages waiting to be sent, and those already sent                           |
| `kv`      | The last announced commit, the last digest time and day, alert throttles      |

It can live in the platform's database. The bot never reads or writes any other
schema, and its pool is capped at three connections. The platform's migrations,
`schemaFilter` and `verify-schema` never see it, because they only look at the
platform's own schema list. To remove the bot: delete the Render service, then
`DROP SCHEMA deploybot CASCADE`.

## WhatsApp: read this first

The bot connects with [Baileys](https://github.com/WhiskeySockets/Baileys), an
unofficial library that attaches to a normal WhatsApp account as a linked
device, the way WhatsApp Web does. The official Business API cannot post to a
group. This is against WhatsApp's terms of service, and **the number can be
banned**. So:

- Use a number that exists only for this, never a personal one.
- Create the group from a personal number and keep that number as admin, so a
  banned bot does not take the group with it.
- Before linking, use the number normally for a few days. Have the group's
  members save it as a contact, and add it to the group by hand.
- Open WhatsApp on the phone that owns the number at least once a fortnight.
  WhatsApp unlinks devices whose phone has been away for 14 days.
- Keep the number alive. A lapsed virtual number or a recycled SIM can be
  registered by someone else, who then owns the bot's identity.

If the session is lost (unlinked from the phone, or banned), the bot stops
trying to reconnect, logs an error, and sends an SMS to `OWNER_PHONE` through
Twilio if that is configured. It never pairs on its own: pairing only starts
when someone calls `POST /admin/pair`, so a broken session cannot turn into a
stream of link requests to the phone.

## Setting it up

**Where to do this.** The WhatsApp session lives in the database, and the
staging database only accepts connections from inside Render. So the bot that
posts to the real group has to be paired **on Render**: run the steps below
against `https://oto-deploy-bot.onrender.com` with the `ADMIN_TOKEN` Render
generated for the service (dashboard → oto-deploy-bot → Environment). Running
it locally uses the compose database instead. That is fine for previewing
digests and for development, but a pairing made there stays there.

Every request below carries `Authorization: Bearer $ADMIN_TOKEN`. The examples
use `localhost:8790`; swap in the Render URL when setting up the real one.

1. **Configure.** On Render the blueprint sets everything except the values
   marked `sync: false`. Locally, copy `.env.example` to `.env` and set
   `DATABASE_URL`, `ADMIN_TOKEN` and `WHATSAPP_PHONE`. Keys already in the
   repository's main `.env` (`RENDER_API_KEY`, `ANTHROPIC_API_KEY`, `TWILIO_*`)
   are read from there. Then:
   ```
   docker compose -f ../../infra/docker-compose.yml up -d postgres
   npm install && npm run dev
   ```
2. **Preview a digest.** This needs no WhatsApp and is the quickest check that
   Render and the summary are wired up:
   ```
   curl -X POST -H "Authorization: Bearer $ADMIN_TOKEN" localhost:8790/admin/digest
   ```
   It returns the message parts and sends nothing.
3. **Pair the phone.**
   ```
   curl -X POST -H "Authorization: Bearer $ADMIN_TOKEN" localhost:8790/admin/pair
   ```
   On the phone: WhatsApp → Linked devices → Link a device → _Link with phone
   number instead_ → enter the eight-character code. It is valid for about
   three minutes. `GET /admin/status` shows `"status": "open"` when it worked.
4. **Find the group.** Add the bot's number to the group from the phone, then:
   ```
   curl -H "Authorization: Bearer $ADMIN_TOKEN" localhost:8790/admin/groups
   ```
   Put the group's `id` (it ends in `@g.us`) in `WHATSAPP_GROUP_ID` and restart.
5. **Send a test message.**
   ```
   curl -X POST -H "Authorization: Bearer $ADMIN_TOKEN" -H "content-type: application/json" \
     -d '{"text":"Test from the deploy bot"}' localhost:8790/send
   ```

The session is in the database, not on disk, so a restart or a redeploy
reconnects without pairing again. **Never point two running bots at the same
database and schema**: two processes on one session knock each other off.

## Endpoints

|                      |                                                                                                                              |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `GET /health`        | Render's health check. It says nothing about WhatsApp on purpose: a lost session is fixed by pairing, not by a restart loop. |
| `GET /admin/status`  | WhatsApp state, what is configured, last digest, messages waiting                                                            |
| `POST /admin/pair`   | Start a pairing and return the code. `?force=true` replaces an existing session.                                             |
| `GET /admin/groups`  | The groups the bot's number is in, with their ids                                                                            |
| `POST /admin/digest` | The digest on demand. See "Running a digest by hand" below.                                                                  |
| `POST /send`         | Queue a message to the group: `{"text": "…"}`                                                                                |

There is no inbound webhook. The only public route is `/health`.

### Running a digest by hand

`POST /admin/digest` builds the digest immediately, without waiting for the
morning. Two query parameters control it:

| `mode`              | Sent to the group | Recorded | Use it to                                                                                           |
| ------------------- | ----------------- | -------- | --------------------------------------------------------------------------------------------------- |
| `preview` (default) | no                | no       | See exactly what would be sent                                                                      |
| `test`              | yes, now          | no       | Try the whole path live. The next real digest still covers the same changes, so nothing is used up. |
| `send`              | yes, now          | yes      | Do the morning run early. The next digest starts after it, and the same changes are not sent twice. |

`hours=N` (up to 168) looks back N hours and ignores what was already
announced, instead of continuing from the last digest. It is what makes a
preview or a test show a full message on a day when nothing is new:

```
curl -X POST -H "Authorization: Bearer $ADMIN_TOKEN" \
  "localhost:8790/admin/digest?mode=test&hours=24"
```

The response includes the message parts, plus `whatsapp` and
`groupConfigured`. If `whatsapp` is not `open` or no group is set, the message
was queued, not sent; it goes out when the connection returns, or is dropped
after `MESSAGE_TTL_HOURS`. A digest of several parts sends the first at once
and the rest `PART_INTERVAL_MIN` minutes apart, in every mode.

The scheduled run is unaffected by `preview` and `test`. After a `send`, that
morning's scheduled run finds nothing new and stays silent.

## On Render

`render.yaml` declares it as `oto-deploy-bot`, with `rootDir: services/deploy-bot`.
Render only redeploys a service when something under its root changes, so
pushes to the suite do not restart the bot. It must stay at **one instance**.
When the bot itself deploys, the old and new instances overlap for a moment.
The old one is told its session was replaced and stands back for a minute
instead of fighting for it.

## Development

```
npm run typecheck
npm test
```

The tests cover the pure parts: message layout and splitting, the daily clock,
and configuration. The repository's ESLint and Prettier configs apply to this
folder (`pnpm lint` from the root includes it).
