import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  identityFromExchange,
  parseHeldIdentity,
  readHandoffToken,
  withoutHandoff,
} from '../src/booth/signon.ts';

/**
 * SCRUM-528 — the launcher's one sign-on, as the booth page reads it.
 *
 * The token rides in the fragment and is case-sensitive; the api's answer is
 * an identity with no credential, and only an unlocked, fully set-up session
 * for the booth audience is acted on.
 */

const TOKEN = 'eyJhbGciOiJIUzI1NiJ9.eyJqdGkiOiJ4In0.Ab-c_D';
const LATER = new Date(Date.now() + 3_600_000).toISOString();

test('reads the hand-off from the fragment with its case intact, and nothing that is not one', () => {
  assert.equal(readHandoffToken(`#handoff=${TOKEN}`), TOKEN);
  assert.equal(readHandoffToken(`#cw,handoff=${TOKEN}`), TOKEN);
  assert.equal(readHandoffToken('#handoff=not a token'), null);
  assert.equal(readHandoffToken('#debug'), null);
  assert.equal(readHandoffToken(''), null);
});

test('scrubs the hand-off from the fragment and keeps the stage flags', () => {
  assert.equal(withoutHandoff(`#handoff=${TOKEN}`), '');
  assert.equal(withoutHandoff(`#cw,handoff=${TOKEN},lite`), '#cw,lite');
});

test('acts only on a booth identity from a usable session', () => {
  const answer = {
    accountId: 'a',
    audience: 'booth',
    mustChangePassword: false,
    sessionLocked: false,
    identity: { accountId: 'a', name: 'Nok', code: 'S-AB12', expiresAt: LATER },
  };
  assert.deepEqual(identityFromExchange(answer, Date.now()), { name: 'Nok', code: 'S-AB12', expiresAt: LATER });
  assert.equal(identityFromExchange({ ...answer, audience: 'pos' }, Date.now()), null);
  assert.equal(identityFromExchange({ ...answer, sessionLocked: true }, Date.now()), null);
  assert.equal(identityFromExchange({ ...answer, mustChangePassword: true }, Date.now()), null);
  assert.equal(identityFromExchange({ ...answer, identity: undefined }, Date.now()), null);
});

test('forgets a held sign-on once the session behind it would have ended', () => {
  const held = JSON.stringify({ name: null, code: 'S-AB12', expiresAt: LATER });
  assert.deepEqual(parseHeldIdentity(held, Date.now()), { name: null, code: 'S-AB12', expiresAt: LATER });
  assert.equal(parseHeldIdentity(held, Date.parse(LATER) + 1), null);
  assert.equal(parseHeldIdentity('{not json', Date.now()), null);
  assert.equal(parseHeldIdentity(null, Date.now()), null);
});
