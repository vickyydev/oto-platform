# The first-message reader over the park's exported chats

Measured 11 Nov 2026 on the SCRUM-830 lane as landed (the reader of
`packages/assistant/src/first-message.ts` after its complaints, groups and
language fix), read-only and local: no model, no key, nothing written. The
exported WhatsApp chats under `imports/whatsapp-history` are local reference
input (git ignores them); this record carries counts, cue keys and chat ids
only. A chat id is the first 12 hex of the sha256 of the chat's lines; never a
name, a phone number, a line or a file name.

```
pnpm --filter @oto/assistant firstmsg:measure -- --dir <path to imports/whatsapp-history>
```

The script is `packages/assistant/scripts/first-message-measure.ts`. It parses
every export with `scripts/inbox/whatsapp-history.mjs` (the same parser the
history import uses), counts a chat exported twice once, and reads each chat's
first family line with the reader, which is the message the ingest sees when it
opens the thread.

## What the real queue is not

The exports do not say which inbox a chat belonged to: they are one WhatsApp
Business number's chats, exported in batches, and an export carries no label
per chat. So there is no agreement rate against a recorded queue. Instead the
measure prints what share of first lines the reader classifies, and a proxy
from the chat's own words: the business's text replies in a chat about a party
carry a birthday word (a package, a cake, the party room), so a party chat is
one whose replies say so.

## The corpus

| | |
|---|---|
| export files read (`.txt`, and the `.txt` inside a `.zip`) | 625 |
| unreadable | 0 |
| distinct chats | 217 |
| chats where the family wrote (the ingest would read a first message) | **194** |
| chats the business opened | 0 |

## Where the first line sends each chat

| queue | chats | share |
|---|---|---|
| Birthdays & Events | **64** | 33.0 % |
| GM (refund or complaint) | **0** | 0 % |
| the channel's default | **130** | 67.0 % |

The cue that decided each of the 64 (language:cue):

| cue | chats |
|---|---|
| en:birthday | 27 |
| ru:birthday | 18 |
| en:camp | 7 |
| ru:camp | 6 |
| en:party | 2 |
| th:birthday | 2 |
| en:event | 1 |
| ru:package | 1 |

Reading the family's whole first turn (the lines they sent in a row before the
business answered) instead of the first line alone changes nothing: 64 / 0 /
130, and no chat is caught only by a later line of the turn. Of the 130 default
first lines, a later family line carries a birthday cue in 2 chats
(`1cba7c33adc3`, `937656c50ec9`), neither in the very second line; a GM cue in
none. Those are the threads the ingest leaves on the default and only the
assistant's second opinion can move.

## The staff-reply proxy

17 chats have a business text reply that names a birthday matter. The first
line sent **12 of the 17** to Birthdays & Events (70.6 %); the first turn would
add none. The 5 the first line leaves on the default: `2a6ed639431b`,
`52c52c793caa`, `5a34b44de8b6`, `1cba7c33adc3`, `937656c50ec9` (the last two are
the chats whose later family line carries the cue).

Of the 64 first lines sent to Birthdays & Events, **12 have a business text
reply, and all 12 are corroborated** by it (12 / 12, 100 %): no chat the reader
sent there was answered without a birthday word. The remaining **52 have no
business text reply in the export** (a reply by media, voice or from another
number is not in a text export), so there is nothing to corroborate either way:

```
9da76d51712e b86ff3eb5751 d5568dcef585 2a9e4209b9c9 1a813728efa4 220bb48d0edd
189fe8159b35 aeb0cd3dc8ce 3ff4b8f0816a 7786efb97dd8 c7fa8aaa67d5 80c9a9900db1
c262ec3fba68 cf82c11f67e0 a3473c9baf47 7949006ad8a2 9abf5b524d5f 2b225d46042a
4c73701e7e0d 8fb6ef73f6e9 8b187b9c33ac 5447d3f51153 c5df26c606a0 bfed2e437959
9db79fc95e01 4136f73e92fd 270d0f61ba9f 59369c013d4d 33781d746d5b a02f43c709c5
c8eaab814d7c f51ac821416c bbd0257ff119 2a83806fddd4 f227dc01ba25 280902ce8773
fe512baf01c8 c73aff0134a2 7e7fb7ce0e8c f3399ceea6ae 7a7aba3d7490 0cea8fa3fd09
0f8eb4cff76f b4d4328cb97b 61e1627c3f6f 6b66884fc4db b0eadd4ddc6d b93cec728429
ea8718d198f2 5e740ab2d03e beb30489f5d6 30090471209e
```

For the GM there is no proxy in the replies, so every chat the reader sends
there would be listed for a person to read: none, as above. No real first line
in the corpus trips the complaint or refund cues, including the everyday
phrasings the fix added.

## Against the build's first figures

The build's first measure (before its fix) read 65 / 0 / 129 with 53 unanswered
birthday first lines, re-run here with the first commit's reader to confirm.
The fix made a bare day-care or nursery word no longer a cue (the park's own
child care is Central reception's; a school word counts only as a group
coming), which moved one chat, `258c06786cc7`, from Birthdays & Events
(`en:school_group`) to the default: 64 / 0 / 130, 52 unanswered. That chat has
no business text reply, so the proxy is unchanged at 12 of 17 and 12 / 12. One
other first line kept its queue but changed its cue's language: a camp opener
in Cyrillic, `1a813728efa4`, now reads as `ru:camp` rather than `en:camp`,
because the reading's language is the line's script before the cue's (8 / 5
became 7 / 6). No other first line reads differently; the GM stayed at none.
