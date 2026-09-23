import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import { decodeDigioFrame, encodeDigioFrame, readTlv, toHex } from '../src/terminal/digio';
import { encodeGhlRequest, encodeGhlResponse, parseGhl } from '../src/terminal/ghl';
import {
  FIXTURE_DIR,
  buildFixtures,
  payloadOf,
  renderFixture,
} from './fixtures/terminal/generate';

/**
 * The committed fixtures (S2-10a).
 *
 * Each one is the bytes that crossed the wire between the adapter and the
 * simulator, so this test is a drift guard: change what either sends and the
 * committed file stops matching, and the diff says exactly which message moved.
 * Correctness against the vendors is a different test — `terminal-digio.test.ts`
 * reproduces the specification's own frames byte for byte.
 */

test('every committed fixture is what the code produces today', async () => {
  for (const fixture of await buildFixtures()) {
    const target = path.join(FIXTURE_DIR, fixture.file);
    const held = readFileSync(target, 'utf8');
    assert.equal(
      held.replace(/\r\n/g, '\n'),
      renderFixture(fixture),
      `${fixture.file} has drifted — regenerate it and read the diff before committing`,
    );
  }
});

test('every fixture carries its citation, and every GHL response says it is inferred', async () => {
  for (const fixture of await buildFixtures()) {
    const header = fixture.header.join('\n');
    assert.match(header, /Source: /, `${fixture.file} has no source citation`);
    if (fixture.file.startsWith('ghl/') && fixture.file.includes('response')) {
      /**
       * The vendor PDF prints no response XML anywhere — page 18 is a request
       * builder and it is the only literal message in the document. Every
       * response fixture has to say so where somebody will read it.
       */
      assert.match(
        header,
        /INFERRED FROM THE PARAMETER TABLES/,
        `${fixture.file} must say that its envelope is reconstructed`,
      );
    }
    if (fixture.file.startsWith('digio/')) {
      assert.match(header, /CRC IS GENERATED, NEVER COPIED/, `${fixture.file}`);
    }
  }
});

test('every Digio fixture decodes, re-encodes to itself, and checks its own CRC', () => {
  const files = [
    'sale-request-card.hex',
    'sale-response-card-approved.hex',
    'sale-response-host-timeout.hex',
    'sale-request-qr.hex',
    'qr-payload-a18.hex',
    'sale-response-qr-approved.hex',
    'void-request.hex',
    'void-response.hex',
    'inquiry-request.hex',
    'inquiry-not-found.hex',
    'terminal-info-request.hex',
    'terminal-info-response.hex',
  ];
  for (const file of files) {
    const hex = payloadOf(readFileSync(path.join(FIXTURE_DIR, 'digio', file), 'utf8'));
    const frame = Uint8Array.from(hex.match(/../g)?.map((b) => Number.parseInt(b, 16)) ?? []);
    // `decodeDigioFrame` verifies the CRC and the declared length; re-encoding
    // the content it returns has to land on the same bytes.
    const content = decodeDigioFrame(frame);
    assert.equal(toHex(encodeDigioFrame(content)), hex.toUpperCase(), file);
    // And every frame is readable as TLV with the named-tag table.
    const entries = readTlv(content);
    assert.ok(entries.length > 0, file);
    assert.equal(entries[0]?.tag, '21', `${file} starts with its action code`);
  }
});

test('every GHL fixture parses, and a request re-encodes to itself', () => {
  const requests = ['sale-request-card.xml', 'sale-request-qr.xml', 'query-request.xml', 'void-request-card.xml'];
  for (const file of requests) {
    const xml = payloadOf(readFileSync(path.join(FIXTURE_DIR, 'ghl', file), 'utf8'));
    const fields = parseGhl(xml);
    assert.equal(encodeGhlRequest(fields), xml, file);
  }
  const responses = [
    'sale-response-card-approved.xml',
    'sale-response-card-declined.xml',
    'sale-response-card-partial.xml',
    'sale-response-qr-approved.xml',
    'query-response-not-found.xml',
    'void-response-card.xml',
  ];
  for (const file of responses) {
    const xml = payloadOf(readFileSync(path.join(FIXTURE_DIR, 'ghl', file), 'utf8'));
    const fields = parseGhl(xml);
    assert.ok(fields.response_code, `${file} carries a response code`);
    assert.equal(encodeGhlResponse(fields), xml, file);
  }
});

test('no fixture carries a password, a PAN or track data', async () => {
  /**
   * The rule, enforced where it is cheapest to enforce.
   *
   * A credential printed in a vendor document is still a credential: the Digio
   * void password is configuration, and the placeholder the fixtures use has no
   * digits in it at all so it cannot be mistaken for one. The card number in
   * the approved-sale fixtures is masked by the terminal before we see it and
   * is a recognisable test number; what the adapter keeps of it is four digits.
   */
  for (const fixture of await buildFixtures()) {
    const text = `${fixture.header.join('\n')}\n${fixture.body}`;
    const readable =
      fixture.file.endsWith('.hex') && /^[0-9A-F]+$/.test(fixture.body)
        ? Buffer.from(fixture.body, 'hex').toString('latin1')
        : fixture.body;
    assert.doesNotMatch(readable, /password=/i, fixture.file);
    /**
     * "Looks like a card" is the platform's own definition, not a digit count.
     *
     * `packages/telemetry/src/redact.ts` sweeps bare digit runs of 13 to 19
     * that pass Luhn, and that is the right rule here too: a wallet's
     * transaction id is a long run of digits by the vendor's own example
     * (28 of them), so a test that banned digit runs would ban the protocol.
     */
    for (const run of readable.match(/\d{13,19}/g) ?? []) {
      assert.equal(luhn(run), false, `${fixture.file} carries a Luhn-valid digit run`);
    }
    // Track data: the sentinels a magnetic stripe is framed with.
    assert.doesNotMatch(readable, /;\d{10,}=/, `${fixture.file} looks like track 2`);
    assert.ok(text.length > 0);
  }
});

/** The check `packages/telemetry` uses to decide a digit run is a card number. */
function luhn(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let value = digits.charCodeAt(i) - 48;
    if (double) {
      value *= 2;
      if (value > 9) value -= 9;
    }
    sum += value;
    double = !double;
  }
  return sum % 10 === 0;
}
