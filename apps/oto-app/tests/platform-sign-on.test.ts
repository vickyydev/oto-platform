// seed: none — this file talks to nothing. Run it with `npx tsx
// tests/platform-sign-on.test.ts`, or let the Playwright run load it: the
// assertions are at module level, so a broken one fails collection.
import assert from "node:assert/strict";
import {
  PLATFORM_SESSION_COOKIE,
  REFUSAL_FALLBACK,
  openPlatformToken,
  refusalMessage,
  sealPlatformToken,
  sessionTokenFromSetCookie,
} from "../server/lib/platformSession";

// ─── Reading the platform's session out of an exchange ────────────────────────

const REAL_SET_COOKIE = [
  `${PLATFORM_SESSION_COOKIE}=abc.123-token_value; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=86400`,
];

assert.equal(
  sessionTokenFromSetCookie(REAL_SET_COOKIE),
  "abc.123-token_value",
  "the session token is read out of the platform's Set-Cookie",
);

assert.equal(
  sessionTokenFromSetCookie([
    "other=1; Path=/",
    `${PLATFORM_SESSION_COOKIE}=second; Path=/; HttpOnly`,
  ]),
  "second",
  "the right cookie is picked out of several",
);

assert.equal(
  sessionTokenFromSetCookie(["oto_session_other=nope; Path=/"]),
  null,
  "a cookie whose name merely starts the same is not the session cookie",
);

assert.equal(
  sessionTokenFromSetCookie([]),
  null,
  "an exchange that set no cookie yields nothing rather than an empty token",
);

assert.equal(
  sessionTokenFromSetCookie([`${PLATFORM_SESSION_COOKIE}=a%2Bb%3Dc; Path=/`]),
  "a+b=c",
  "a percent-encoded value is decoded",
);

// ─── Sealing it while this app holds it ───────────────────────────────────────

const secret = "a-session-secret-of-a-believable-length-0123456789";
const sessionId = "sid-one";
const token = "platform-session-token";

const sealed = sealPlatformToken(secret, sessionId, token);

assert.notEqual(sealed, token, "the stored value is not the token");
assert(!sealed.includes(token), "the token does not appear inside the sealed value");
assert.equal(
  openPlatformToken(secret, sessionId, sealed),
  token,
  "what was sealed opens again for the same session",
);
assert.notEqual(
  sealPlatformToken(secret, sessionId, token),
  sealed,
  "two seals of the same token differ — the nonce is fresh each time",
);

// The three ways it can fail to open. All three answer the same way, because
// the caller's response to all three is the same: end the session.
assert.equal(
  openPlatformToken(secret, "sid-two", sealed),
  null,
  "a value copied onto another session does not open",
);
assert.equal(
  openPlatformToken("a-different-session-secret-0123456789abcdef", sessionId, sealed),
  null,
  "a value sealed under another secret does not open",
);
const tampered = Buffer.from(sealed, "base64");
// Inside the ciphertext, past the 12-byte nonce and the 16-byte tag.
tampered[30] = tampered[30]! ^ 0xff;
assert.equal(
  openPlatformToken(secret, sessionId, tampered.toString("base64")),
  null,
  "a tampered value does not open",
);
assert.equal(openPlatformToken(secret, sessionId, "not base64 at all"), null, "rubbish does not open");

// ─── What a refusal says to the person who clicked the tile ───────────────────

// The platform's own HandoffRejection vocabulary (apps/api/src/services/handoff.ts).
// Every one of them has a sentence: falling back would show somebody a screen
// that tells them nothing about whether to try again or find an administrator.
for (const reason of ["replayed", "expired", "audience", "origin", "revoked", "signature"]) {
  const message = refusalMessage(reason);
  assert.notEqual(message, REFUSAL_FALLBACK, `${reason} has a sentence of its own`);
  assert(message.length > 30, `${reason}'s sentence says something`);
}

assert.equal(
  refusalMessage("something_the_platform_added_later"),
  REFUSAL_FALLBACK,
  "an unknown reason falls back rather than showing an internal word",
);

console.log("Platform sign-on checks passed.");
