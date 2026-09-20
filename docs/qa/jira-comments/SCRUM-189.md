SCRUM-189 — S2-02 — Suite launcher with signed hand-off
Dev evidence 2026-09-20 on commit 56aeb5e (branch main). Built and DEPLOYED. 185 API integration tests + 22 shared unit tests, typecheck, lint and build green. Screenshots attached are from the live deployment, not a local stack.

Live: launcher https://oto-launcher-staging.onrender.com, POS https://oto-pos-staging.onrender.com, api https://oto-api-staging.onrender.com. All three deploy on a push to main once CI is green, through Render's checksPass trigger.

Why a hand-off at all. One platform session has to open several apps on different origins. A parent-domain cookie cannot do it: onrender.com is on the public suffix list, so two subdomains of it are cross-site, and it would not have covered the booking site's separate domain anyway. So the launcher mints a short-lived signed token aimed at ONE app, the browser carries it in the URL fragment, and the app exchanges it for its own cookie bound to the same session row. Revoking the session ends every app at once, because there is no second credential anyone can forget to revoke.

The fragment, not the query string. A fragment is never sent to a server: it reaches no access log, no proxy and no Referer on the next click. The POS strips it with history.replaceState before anything can render, so it cannot be copied out of the address bar or bookmarked either.

Verified end to end against the deployed services, by HTTP and then again in a real browser:
- Sign-in on the launcher origin: 200, its own session cookie.
- Minting a hand-off for the POS: 200, audience pos, launchUrl pointing at the POS host, token in the fragment, query string empty.
- Exchanging it at the POS origin: 200, and /me on the POS then answers 200 — one platform session, two app cookies.
- Replaying the same token: refused HANDOFF_REJECTED, reason replayed. The jti is claimed in one statement, so a second tab racing the same fragment cannot win either.
- Reception asking for a console token: refused FORBIDDEN, app:console:access is not in that role. A tile a person cannot open is not a tile the api will mint for.
- In the browser: reception signed in on the launcher, clicked Open POS, and arrived at the POS till already signed in as Som with no second prompt and no fragment left in the address bar (screenshot 05).

Screenshots:
- 01-launcher-signed-out — the landing page and sign-in, in the POS design language.
- 02-launcher-admin-all-tiles — platform admin sees six tiles, each with its state: POS open, the rest coming soon.
- 03-launcher-account-page — the session, and where hand-off rejections are listed.
- 04-launcher-reception-pos-only — reception sees only what reception can open.
- 05-pos-opened-from-launcher-no-second-signin — the acceptance criterion: the POS till, signed in, reached by clicking a tile.
- 06-pos-lock-screen-no-face-scan — the face-scan placeholder is gone; biometrics are out of scope, so there was nothing behind it. Asserted in the capture: zero buttons matching "Scan my face".
- 07-launcher-phone-width — 390px, no horizontal scroll (scrollWidth 390 = clientWidth 390).

The signing key is a KEYRING: kid:secret pairs, newest signs, the rest still verify, so rotating is expand and contract like a migration — prepend a new pair, deploy, drop the old once every token it signed has expired.

One thing learned the hard way, recorded because it will happen again: naming the launcher in HANDOFF_APP_ORIGINS makes the api refuse to boot. The launcher is the issuer, never a target. The refusal names the variable and lists the valid apps, which is how it was diagnosed in under a minute.

A flaky test was found and fixed while running the suite. The tampered-signature case flipped the LAST base64url character of the signature, but in a 43-character encoding of a 32-byte HMAC that character carries only four meaningful bits — so the "tampered" token frequently decoded to identical bytes and verified correctly. It passed or failed on the luck of the signature. It now mutates the middle and asserts the decoded bytes actually differ.

Deferred, not hidden: the "Expire hand-off now" test control named in QA step 3 is not built. Expiry is covered by an integration test but not by a button on the account page; it belongs with the other staging-only controls behind OPS_TEST_CONTROLS in S2-03.

Worth a decision before S2-03, S2-17 and S2-18 multiply the origins: every app origin currently holds the same bearer cookie value. That is what makes revocation inherently global, but per-origin values would need a session_credential table and a change to loadAuth. Recorded in the ticket log.
