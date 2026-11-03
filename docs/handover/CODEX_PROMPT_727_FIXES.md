# The prompt for Codex — what SCRUM-727 finishes before it lands; 3 November 2026

For the Codex chat on SCRUM-727 and SCRUM-728. An independent read of `8e99e33e` ran the sign-in matrix on a real agent, SQLite, HTTP and argon2, and also against the real API. The zone check and the installer hold: no bypass was found. Every row of the ticket's matrix answers correctly. The ended-shift memory needs one more change, and it should land inside SCRUM-727, because SCRUM-728's sign-in door would expose it.

## Why

`revoked: row.revokedAt !== null` at `apps/api/src/services/staff-token.ts:358`, read by the check at `packages/box-agent/src/staff-token.ts:712`, ignores the revoke reason (`sign_out`, `account_revoked`, `station_changed`, `admin`) and remembers only the latest token. A normal sign-out therefore looks the same as a manager ending a shift.

| Case | Answer today | Should be |
|---|---|---|
| Signed out last night, no token, right password | 401 `STAFF_TOKEN_REVOKED`, "This shift was ended by a manager" | 200 fresh |
| Today's valid token, box has not pulled yet (up to 60 s, or while its link is down) | 401 `STAFF_TOKEN_REVOKED` | 200 `offline_token` |
| Live token, and a later session signed out | 401 `STAFF_TOKEN_REVOKED` | 200 `offline_token` |
| An older token ended by a manager while a later one exists, token left out, either station on the box | 200 fresh | Refused |
| A fresh session already open when the end is pulled | Keeps working up to 16 h | Ends |
| Quiet box, list just confirmed current by the cloud | 401 `OFFLINE_DENY_LIST_STALE` | 200 fresh |

The first row breaks OD-6's morning path, and the same refusal silently fails the online background send.

## The decisions (final)

1. **An explicit per-account "manager ended at" time on the staff record**, set only for reason `admin`. Expand-only, and an older bundle behaves as today's safe answer.
2. **A fresh sign-in is refused when that time is later than the person's latest issue.** A manager's end-shift therefore stays ended across a later token and either station on the box. Signing in again online after the end clears it, by issue time, as the rule says.
3. **A valid token is judged only by its own id and its own issue time**, never by what happened to a different token.
4. **`sign_out` and `station_changed` stay on the deny-list only for that token's own life.** This also stops the list growing for 30 days (five re-picks added five entries).
5. **A fresh box session is ended when a pulled end-shift names its account**, as a token session already is (`packages/box-agent/src/station-bridge.ts:1387`).
6. **A "nothing changed" answer from the cloud refreshes the list's 72-hour age** (`packages/box-agent/src/agent.ts:2936`, `packages/box-agent/src/staff-token.ts:731`). A park closed for three days must not be refused on reopening just because nothing changed.
7. **A stored address that fails the check must not block other updates to the box** (`apps/api/src/services/fleet.ts:1626`): rename and disable must still work, including during an incident when the zone is emptied. The Console shows why the address is not in use instead of a blank field. Update the test at `s727-box-unlock-review.test.ts:122`, which pins the old answer, and say why on the ticket.
8. **The wrong rows above join the matrix test using the real API path.** Today's rows use a synthetic `lastTokenRevoked` with no reason, so they cannot see this.
9. **Words:** `refusalMessage` (`packages/box-agent/src/staff-token.ts:789`), `docs/ops/BOX_BRIDGE_BENCH.md` lines 126 and 152, and `docs/progress/plans/offline/PLAN.md` line 246 must say what is true.

## Small items in the same round

- `redirect: 'error'` applies to same-origin `/api` calls too (`apps/pos/src/api/bridge.ts:119`). Make it conditional on `origin`, so a till with no address stays byte-for-byte as before.
- Refuse a single-label zone and warn about a shared suffix (`packages/shared/src/box-bridge-origin.ts:8-11`): `BOX_BRIDGE_ZONE=com` or `onrender.com` currently passes `https://evil.com` or `https://evil.onrender.com`.
- A till whose zone is empty falls back to `/api` with no warning, so its outage path stops working unnoticed. It fails safe; make it visible where an administrator would look.
- The runbook says that restoring an older copy brings an ended shift back until the next pull, bounded by 72 hours for a fresh sign-in and by token expiry otherwise.
- A token dated more than 120 s ahead of the box's clock gets "not valid here" (`packages/box-agent/src/staff-token.ts:309`). Say what is actually wrong.
- Stale text: `apps/api/src/services/sync.ts:5242-5246` and `:5290`, and `OTO_DNS_MODULE`, which is required but unused (`scripts/pi/bridge-install.sh:36`).
- Commit bodies use bullets (`CONTRIBUTING.md:17`).

## Waiting for the owner

These two are his, so do not build them. Build so that either answer is small.

- **Does a manager's end-shift also end the person's platform session?** Today it does not (`apps/api/src/routes/staff-token.ts:289`), so a page reload mints a new token and password-only then works. The planner has recommended yes.
- **Should a fresh sign-in respect a station's named-staff scope?** The box never reads `accessScope` today.

## Order

Pause SCRUM-728 where it is, with its work pushed. Finish these in the 727 lane, re-run the complete gates, and land 727 when SCRUM-726 records its window closed. Then rebase and finish 728. The notes for 728: its sign-in door depends on decision 2; count tills with no box before production; and the old cloud route now defaults on until 728 decides its retirement.
