import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  DIGIO_TAGS,
  decodeDigioFrame,
  digioAmount,
  digioCrc,
  digioFrameScanner,
  digioSatang,
  encodeBerLength,
  encodeDigioFrame,
  encodeTlv,
  fromHex,
  readBerLength,
  readDigioResponse,
  readTlv,
  readTlvAsGenericBer,
  toHex,
} from '../src/terminal/digio';
import { TerminalError } from '../src/terminal/contract';

/**
 * The Digio dialect, against the document's own frames (S2-10a).
 *
 * The document is "A920 Link-PoS-Spec" v2.21, read from `imports/` and not
 * copied into the repository. What is quoted below is its `Example :` lines —
 * five complete frames — because there is no other way to prove that our
 * encoder produces the bytes the terminal will accept. Each carries the line
 * number it was read at in the stripped HTML.
 */

/** §4, "String of content is 12345" (HTML line 388). */
const SPEC_WORKED_EXAMPLE = '3E550531323334355F';
/** §5.1.1 Terminal Info request (HTML line 552). */
const SPEC_TERMINAL_INFO_REQUEST = '3E550C21025430040631323334353625';
/** §5.1.2 Terminal Info response (HTML line 615). */
const SPEC_TERMINAL_INFO_RESPONSE =
  '3E552621025431220331303004063132333435360507312E382E313237060A303831323334353637382D';
/** §5.4.1 Sale request (HTML line 1278) — the generator's proof. */
const SPEC_SALE_REQUEST =
  '3E5521210241300105313030353003084A616E6520446F650406313233343536050241311F';
/** §5.13.2 Inquiry, transaction not found (HTML line 5099). */
const SPEC_INQUIRY_NOT_FOUND = '3E551121025433220332303304063132333435362B';
/**
 * §5.4.2.1 Credit sale response (HTML line 1270) — one of the SEVEN whose
 * printed CRC its own §4 rule does not produce.
 */
const SPEC_CREDIT_RESPONSE_WITH_WRONG_CRC =
  '3E5581E42102413101053130303530040631323334353622033130300518383736353433323131383035303931383035303031323334060652303737343107023030080B5669736120437265646974091034393231353931312A2A2A2A363031340A084A6F686E20446F650B063030303038330D0E41303030303030303033313031300E02303011083230313830353039120532333A353913083839383938393033140F31323334353132333435313233343515023335170C373333333139333933303537180436383030190A38304130303438303030200F43686970204F6E6C696E652050696E1E';

test('the framing rule reproduces the specification’s own worked example', () => {
  // §4: content "12345" -> 3E55 05 3132333435 5F, and the document even shows
  // the XOR: 0x3E ^ 0x55 ^ 0x05 ^ 0x31 ^ 0x32 ^ 0x33 ^ 0x34 ^ 0x35 = 0x5F.
  const frame = encodeDigioFrame(new TextEncoder().encode('12345'));
  assert.equal(toHex(frame), SPEC_WORKED_EXAMPLE);
});

test('the SALE request is reproduced byte for byte', () => {
  /**
   * THE test of this file.
   *
   * Seven of the ten complete frames the document prints carry a CRC its own
   * rule does not produce, so "does our output match the document" is only a
   * fair question of the three that are right. This is one of them, and it is
   * the one that matters: it is a request, so it is what the terminal will be
   * asked to accept.
   */
  const frame = encodeDigioFrame(
    encodeTlv([
      { tag: '21', value: 'A0' },
      { tag: '01', value: '10050' },
      { tag: '03', value: 'Jane Doe' },
      { tag: '04', value: '123456' },
      { tag: '05', value: 'A1' },
    ]),
  );
  assert.equal(toHex(frame), SPEC_SALE_REQUEST);
});

test('the terminal-info pair and the not-found inquiry are reproduced byte for byte', () => {
  assert.equal(
    toHex(
      encodeDigioFrame(
        encodeTlv([
          { tag: '21', value: 'T0' },
          { tag: '04', value: '123456' },
        ]),
      ),
    ),
    SPEC_TERMINAL_INFO_REQUEST,
  );
  assert.equal(
    toHex(
      encodeDigioFrame(
        encodeTlv([
          { tag: '21', value: 'T1' },
          { tag: '22', value: '100' },
          { tag: '04', value: '123456' },
          { tag: '05', value: '1.8.127' },
          { tag: '06', value: '0812345678' },
        ]),
      ),
    ),
    SPEC_TERMINAL_INFO_RESPONSE,
  );
  assert.equal(
    toHex(
      encodeDigioFrame(
        encodeTlv([
          { tag: '21', value: 'T3' },
          { tag: '22', value: '203' },
          { tag: '04', value: '123456' },
        ]),
      ),
    ),
    SPEC_INQUIRY_NOT_FOUND,
  );
});

test('a printed CRC is not evidence: the document contradicts its own rule', () => {
  /**
   * This is why the rule in `digio.ts` is "generate, never copy".
   *
   * The credit-sale response example's declared length is right and its CRC is
   * not: the §4 rule computes 0x1C over those bytes and the document prints
   * 0x1E. An implementation that had trusted the printed byte would have
   * written a checksum the terminal rejects — and would have found out in
   * Phuket.
   */
  const frame = fromHex(SPEC_CREDIT_RESPONSE_WITH_WRONG_CRC);
  const printed = frame[frame.length - 1];
  const computed = digioCrc(frame.subarray(0, frame.length - 1));
  assert.equal(printed, 0x1e, 'the document prints 1E');
  assert.equal(computed, 0x1c, '§4 computes 1C');
  assert.throws(() => decodeDigioFrame(frame), TerminalError);
});

test('BER lengths round-trip at every boundary the document names', () => {
  for (const length of [0, 1, 127, 128, 255, 256, 4096, 65_535, 65_536, 0xffffff]) {
    const encoded = encodeBerLength(length);
    const read = readBerLength(encoded, 0);
    assert.ok(read, `length ${length} did not read back`);
    assert.equal(read.value, length);
    assert.equal(read.width, encoded.length);
  }
  // The long forms the document prints: 128 is `81 80`, 4096 is `82 10 00`.
  assert.equal(toHex(encodeBerLength(128)), '8180');
  assert.equal(toHex(encodeBerLength(4096)), '821000');
});

test('a flipped CRC byte is refused rather than read as garbage', () => {
  const frame = encodeDigioFrame(
    encodeTlv([
      { tag: '21', value: 'A1' },
      { tag: '22', value: '100' },
      { tag: '01', value: '10050' },
    ]),
  );
  const tampered = Uint8Array.from(frame);
  tampered[tampered.length - 1] = (tampered[tampered.length - 1] ?? 0) ^ 0x01;
  assert.throws(
    () => decodeDigioFrame(tampered),
    (err: unknown) => err instanceof TerminalError && err.code === 'TERMINAL_BAD_FRAME',
  );
  // And one byte of the CONTENT flipped is caught by the same check, which is
  // the case that matters: an amount read wrong is money read wrong.
  const inBody = Uint8Array.from(frame);
  inBody[10] = (inBody[10] ?? 0) ^ 0x01;
  assert.throws(() => decodeDigioFrame(inBody), TerminalError);
});

test('the named ASCII tags survive a round-trip and generic BER mis-reads them', () => {
  const payload = 'SIMULATED-EMVCO-PAYLOAD|'.padEnd(200, 'x');
  const content = encodeTlv([
    { tag: '21', value: 'A18' },
    { tag: '22', value: '100' },
    { tag: 'QR', value: payload },
  ]);
  const read = readTlv(content);
  assert.deepEqual(
    read.map((entry) => entry.tag),
    ['21', '22', 'QR'],
  );
  assert.equal(read[2]?.value, payload);

  /**
   * THE PLANT, as a test.
   *
   * `QR` is `0x51 0x52`. A reader written from §4.1.1's generic BER rule takes
   * `0x51` for a tag and `0x52` for a length — 82 bytes — and everything after
   * that is read at the wrong offset. Here is that happening.
   */
  const naive = readTlvAsGenericBer(content);
  const qrish = naive.find((entry) => entry.tag === '51');
  assert.ok(qrish, 'a generic BER reader sees a tag 51 that does not exist');
  assert.notEqual(qrish.value, payload, 'and its value is not the payload');
  assert.equal(qrish.value.length, 0x52, 'it is the first 82 bytes of it');
});

test('a tag number means different things on different actions', () => {
  /**
   * The reason there is a table per action and not one lookup.
   *
   * On a credit response tag `13` is the TID; on a QR response it is Ref3 and
   * the TID has moved to `16`. A shared helper would report a reference number
   * as a terminal id, on the row an accountant reconciles with.
   */
  assert.equal(DIGIO_TAGS.A1['13'], 'tid');
  assert.equal(DIGIO_TAGS.A3['13'], 'ref3');
  assert.equal(DIGIO_TAGS.A3['16'], 'tid');
  // And tag `06` is four different fields on four messages.
  assert.equal(DIGIO_TAGS.A0['06'], 'requestQrData');
  assert.equal(DIGIO_TAGS.A1['06'], 'approvalCode');
  assert.equal(DIGIO_TAGS.A18['06'], 'qrCodeType');
  assert.equal(DIGIO_TAGS.A10['06'], 'password');
  // Tag `05` is a transaction id on every sale response and a version string
  // on the terminal-info response.
  assert.equal(DIGIO_TAGS.A1['05'], 'tranRef');
  assert.equal(DIGIO_TAGS.T1['05'], 'softwareVersion');
});

test('a response is read through the table of the action it declares', () => {
  const a1 = readDigioResponse(
    encodeTlv([
      { tag: '21', value: 'A1' },
      { tag: '22', value: '100' },
      { tag: '13', value: '65703235' },
    ]),
  );
  assert.equal(a1.fields.tid, '65703235');
  const a3 = readDigioResponse(
    encodeTlv([
      { tag: '21', value: 'A3' },
      { tag: '22', value: '100' },
      { tag: '13', value: '65703235' },
      { tag: '16', value: '54355548' },
    ]),
  );
  assert.equal(a3.fields.ref3, '65703235');
  assert.equal(a3.fields.tid, '54355548');
});

test('an action with no table is still read for the four tags that never move', () => {
  // A wallet response this ticket does not implement stays legible rather than
  // unreadable: `21`, `22`, `04` and `01` mean the same on every response the
  // document prints.
  const parsed = readDigioResponse(
    encodeTlv([
      { tag: '21', value: 'A4' },
      { tag: '22', value: '100' },
      { tag: '04', value: '860001' },
      { tag: '01', value: '10050' },
      { tag: '07', value: 'something-new' },
    ]),
  );
  assert.equal(parsed.known, false);
  assert.equal(parsed.fields.responseCode, '100');
  assert.equal(parsed.fields.ref, '860001');
  assert.equal(parsed.fields.amount, '10050');
  assert.equal(parsed.fields.tag07, 'something-new');
});

test('amounts are satang as ASCII digits, with no float in the path', () => {
  assert.equal(digioAmount(10_050), '10050');
  assert.equal(digioAmount(5), '5');
  assert.equal(digioSatang('10050'), 10_050);
  assert.equal(digioSatang('100.50'), null, 'a decimal point is not this dialect');
  assert.equal(digioSatang(''), null);
  assert.throws(() => digioAmount(-1), TerminalError);
  assert.throws(() => digioAmount(1_000_000_000_000_0), TerminalError);
});

test('the frame scanner drops noise, waits for a whole frame and keeps the next one', () => {
  const first = encodeDigioFrame(encodeTlv([{ tag: '21', value: 'A18' }]));
  const second = encodeDigioFrame(encodeTlv([{ tag: '21', value: 'A3' }]));
  const noise = Uint8Array.from([0x00, 0xff, 0x3e]);
  const stream = new Uint8Array(noise.length + first.length + second.length);
  stream.set(noise);
  stream.set(first, noise.length);
  stream.set(second, noise.length + first.length);

  const span = digioFrameScanner(stream);
  assert.ok(span);
  assert.equal(span.start, noise.length);
  assert.equal(toHex(stream.slice(span.start, span.end)), toHex(first));

  const rest = stream.slice(span.end);
  const next = digioFrameScanner(rest);
  assert.ok(next, 'the second frame is still there, which is the QR exchange');
  assert.equal(toHex(rest.slice(next.start, next.end)), toHex(second));

  // Half a frame is not a frame.
  assert.equal(digioFrameScanner(first.slice(0, first.length - 1)), null);
});
