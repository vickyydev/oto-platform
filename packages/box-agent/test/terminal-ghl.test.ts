import assert from 'node:assert/strict';
import { test } from 'node:test';

import { TerminalError, type TerminalChannel } from '../src/terminal/contract';
import {
  GHL_POS_REF_MAX,
  GHL_REQUEST_ORDER,
  encodeGhlRequest,
  encodeGhlResponse,
  ghlAmount,
  ghlCode,
  ghlCodeSpace,
  ghlFrameScanner,
  ghlSatang,
  ghlTerminal,
  interpretGhl,
  parseGhl,
} from '../src/terminal/ghl';
import { createGhlSimulator } from '../src/terminal/simulator-ghl';

/**
 * The GHL dialect (S2-10a).
 *
 * The vendor PDF prints exactly one literal message — the C# request builder on
 * p.18 — so that is what the envelope test asserts against. Everything about
 * responses is reconstructed from the parameter tables, which is why the tests
 * below are about BEHAVIOUR (which code space, which key, what a mismatch does)
 * rather than about bytes: asserting bytes nobody has seen would be asserting
 * our own guess twice.
 */

const TID = '65703235';
const MID = '4648434010';
const DEVICE = '018f0000-0000-7000-8000-0000000edc01';

function terminalWith(
  sim: ReturnType<typeof createGhlSimulator>,
  refs: string[] = ['260923860001', '260923860002', '260923860003'],
) {
  let index = 0;
  const sent: string[] = [];
  const decoder = new TextDecoder();
  return {
    sent,
    terminal: ghlTerminal({
      deviceId: DEVICE,
      label: 'EDC 1',
      terminalId: TID,
      merchantId: MID,
      open: async (): Promise<TerminalChannel> => {
        const channel = sim.connect();
        return {
          async write(bytes) {
            sent.push(decoder.decode(bytes));
            return channel.write(bytes);
          },
          readFrame: (scan, ms) => channel.readFrame(scan, ms),
          discard: () => channel.discard(),
          close: () => channel.close(),
        };
      },
      nextRef: async () => refs[index++] ?? 'OUTOFREFS001',
      now: () => new Date('2026-09-23T07:05:00.000Z'),
      cashier: 'Jane Doe',
      timeouts: { saleMs: 60, probeMs: 40 },
    }),
  };
}

function simulator(): ReturnType<typeof createGhlSimulator> {
  return createGhlSimulator({
    deviceId: DEVICE,
    label: 'EDC 1',
    terminalId: TID,
    merchantId: MID,
    now: () => new Date('2026-09-23T07:05:00.000Z'),
  });
}

test('a request carries the sample’s eight elements, in the sample’s order', () => {
  /**
   * The order is p.18's, which is not the order of any parameter table in the
   * document — and `cashier` is in the sample and in no table at all. The ninth
   * element, `card_approval_code`, is the reconstructed one the card void needs.
   */
  const xml = encodeGhlRequest({ trade_type: 'CARD', pos_ref_no: 'X', transaction_type: 'SALE' });
  const body = xml.slice('<xml>'.length, -'</xml>'.length);
  const order = [...body.matchAll(/<([a-z_]+)>/g)].map((m) => m[1]);
  assert.deepEqual(order, [...GHL_REQUEST_ORDER]);
  assert.deepEqual(order.slice(0, 7), [
    'trade_type',
    'pos_ref_no',
    'amount',
    'invoice_no',
    'transaction_id',
    'transaction_type',
    'service_type',
  ]);
  assert.ok(xml.endsWith('<cashier></cashier></xml>'));
});

test('parsing is order-independent and survives noise around the message', () => {
  const fields = parseGhl(
    '<xml><response_msg>SUCCESS</response_msg><pos_ref_no>ABC</pos_ref_no></xml>',
  );
  assert.equal(fields.pos_ref_no, 'ABC');
  assert.equal(fields.response_msg, 'SUCCESS');

  const encoder = new TextEncoder();
  const stream = encoder.encode(`?junk<xml><pos_ref_no>ABC</pos_ref_no></xml>tail`);
  const span = ghlFrameScanner(stream);
  assert.ok(span);
  assert.equal(
    new TextDecoder().decode(stream.slice(span.start, span.end)),
    '<xml><pos_ref_no>ABC</pos_ref_no></xml>',
  );
  // There is no framing on this dialect: a message ends at `</xml>` and not
  // before it.
  assert.equal(ghlFrameScanner(encoder.encode('<xml><pos_ref_no>AB')), null);
});

test('amounts are decimal major units and come back as satang', () => {
  assert.equal(ghlAmount(10_025), '100.25');
  assert.equal(ghlAmount(5), '0.05');
  assert.equal(ghlAmount(0), '0.00');
  assert.equal(ghlSatang('100.25'), 10_025);
  assert.equal(ghlSatang('100.2'), 10_020);
  assert.equal(ghlSatang('10000.25'), 1_000_025);
  assert.equal(ghlSatang('100'), 10_000);
  assert.equal(ghlSatang('100.2.5'), null);
  assert.equal(ghlSatang('one hundred'), null);
});

test('the same response code means opposite things in the two code spaces', () => {
  /**
   * The single most likely defect in a first implementation, pinned.
   *
   * A card SALE answers ISO-8583 from the SCB host; a wallet SALE, every QUERY
   * and every VOID answer `00`/`01` from the SmartEDC itself.
   */
  assert.equal(ghlCodeSpace('CARD', 'SALE'), 'iso');
  assert.equal(ghlCodeSpace('CARD', 'VOID'), 'status');
  assert.equal(ghlCodeSpace('THAIQRCODE', 'SALE'), 'status');
  assert.equal(ghlCodeSpace('THAIQRCODE', 'QUERY'), 'status');

  assert.equal(interpretGhl('CARD', 'SALE', '00').outcome, 'approved');
  assert.equal(interpretGhl('CARD', 'SALE', '05').outcome, 'declined');
  assert.equal(interpretGhl('CARD', 'SALE', '05').text, 'Do not honor');
  assert.equal(interpretGhl('CARD', 'SALE', '10').outcome, 'partial_approval');
  // `09` is the host still working: unknown, never a decline.
  assert.equal(interpretGhl('CARD', 'SALE', '09').outcome, 'timeout');

  assert.equal(interpretGhl('THAIQRCODE', 'SALE', '00').outcome, 'approved');
  assert.equal(interpretGhl('THAIQRCODE', 'SALE', '01').outcome, 'declined');
  // `10` is a partial approval on a card and nothing at all on a wallet.
  assert.equal(interpretGhl('THAIQRCODE', 'SALE', '10').outcome, 'declined');
  // A card VOID answers in the wallet space, not the ISO one: `01` is FAIL
  // here and "refer to card issuer" there.
  assert.equal(interpretGhl('CARD', 'VOID', '01').outcome, 'declined');
  assert.equal(interpretGhl('CARD', 'VOID', '00').outcome, 'approved');

  // The tables print codes without their leading zero and type the field
  // String(2), so everything is compared padded.
  assert.equal(ghlCode('5'), '05');
  assert.equal(ghlCode('00'), '00');
  assert.equal(ghlCode(''), null);
});

test('an approved card sale carries the invoice number, the approval code and four digits', async () => {
  const sim = simulator();
  const { terminal, sent } = terminalWith(sim);
  const result = await terminal.sale({ attemptId: 'a1', amountSatang: 10_025, tender: 'card' });

  assert.equal(result.outcome, 'approved');
  assert.equal(result.approvedSatang, 10_025);
  assert.equal(result.terminalRef, '260923860001');
  assert.equal(result.invoiceNo, '000001');
  assert.equal(result.tranRef, '000001', 'the void key is the invoice number');
  assert.equal(result.approvalCode, 'R00001');
  assert.equal(result.last4, '4242');
  // TID and MID are NOT on the card wire (p.8): they come off the device row.
  assert.equal(result.tid, TID);
  assert.equal(result.mid, MID);
  assert.ok(sent[0]?.includes('<trade_type>CARD</trade_type>'));
  assert.ok(sent[0]?.includes('<amount>100.25</amount>'));
});

test('an approval for less than was asked is a partial approval, not a sale', async () => {
  const sim = simulator();
  sim.setOutcome('partial', { approvedSatang: 5_000 });
  const { terminal } = terminalWith(sim);
  const result = await terminal.sale({ attemptId: 'a1', amountSatang: 10_025, tender: 'card' });
  assert.equal(result.responseCode, '10');
  assert.equal(result.outcome, 'partial_approval');
  assert.equal(result.approvedSatang, 5_000);
});

test('a wallet approval for less is caught by the amount, which has no code of its own', async () => {
  const sim = simulator();
  sim.setOutcome('partial', { approvedSatang: 5_000 });
  const { terminal } = terminalWith(sim);
  const result = await terminal.sale({
    attemptId: 'a1',
    amountSatang: 10_025,
    tender: 'qr',
    wallet: 'THAIQRCODE',
  });
  // `00` SUCCESS in the wallet space, and an amount below the request. The
  // integer comparison after the round-trip is the only evidence there is.
  assert.equal(result.responseCode, '00');
  assert.equal(result.outcome, 'partial_approval');
  assert.equal(result.approvedSatang, 5_000);
});

test('silence is not a decline', async () => {
  const sim = simulator();
  sim.setOutcome('no_response');
  const { terminal } = terminalWith(sim);
  const result = await terminal.sale({ attemptId: 'a1', amountSatang: 10_025, tender: 'card' });
  assert.equal(result.outcome, 'no_response');
  assert.equal(result.approvedSatang, null);
  assert.equal(result.terminalRef, '260923860001');
});

test('there is no QUERY for a card, and the adapter writes no byte trying', async () => {
  const sim = simulator();
  const { terminal, sent } = terminalWith(sim);
  const result = await terminal.inquire({
    attemptId: 'a1',
    tender: 'card',
    terminalRef: '260923860001',
    amountSatang: 10_025,
  });
  assert.equal(result.outcome, 'unsupported');
  assert.match(result.responseText ?? '', /no QUERY for a card sale/);
  assert.equal(sent.length, 0, 'nothing was sent: the dialect has no such message');
});

test('a wallet QUERY is keyed on the ORIGINAL reference and returns the identities', async () => {
  const sim = simulator();
  const { terminal, sent } = terminalWith(sim);
  const sale = await terminal.sale({
    attemptId: 'a1',
    amountSatang: 10_025,
    tender: 'qr',
    wallet: 'THAIQRCODE',
  });
  const found = await terminal.inquire({
    attemptId: 'a1',
    tender: 'qr',
    wallet: 'THAIQRCODE',
    terminalRef: sale.terminalRef ?? '',
    amountSatang: 10_025,
  });
  assert.equal(found.outcome, 'approved');
  assert.ok(sent[1]?.includes(`<pos_ref_no>${sale.terminalRef}</pos_ref_no>`));
  assert.ok(sent[1]?.includes('<transaction_type>QUERY</transaction_type>'));
  // p.14: the QUERY response is the only place this dialect sends a TID or MID.
  assert.equal(found.tid, TID);
  assert.equal(found.mid, MID);

  const missing = await terminal.inquire({
    attemptId: 'a2',
    tender: 'qr',
    wallet: 'THAIQRCODE',
    terminalRef: 'NOSUCHREF001',
  });
  assert.equal(missing.outcome, 'not_found', 'a QUERY that fails means no such sale');
});

test('an inquiry carries no amount of its own, and its answer is not a shortfall', async () => {
  /**
   * `TerminalInquiryRequest.amountSatang` is optional, because an inquiry asks
   * what happened rather than checking an answer against a request — the
   * QUERY is keyed on the sale's reference and the terminal answers with the
   * amount it took.
   *
   * Left out, it defaults to `0` at the call, and a reader that measured every
   * approval against the amount on the request would call an inquiry that
   * found the sale intact a partial approval — inverting the ticket's own
   * "no final response → inquiry → the sale completes without a second charge"
   * into declining and voiding a sale the guest has already paid for.
   */
  const sim = simulator();
  const { terminal } = terminalWith(sim);
  const sale = await terminal.sale({
    attemptId: 'a1',
    amountSatang: 10_025,
    tender: 'qr',
    wallet: 'THAIQRCODE',
  });
  assert.equal(sale.outcome, 'approved');

  const found = await terminal.inquire({
    attemptId: 'a1',
    tender: 'qr',
    wallet: 'THAIQRCODE',
    terminalRef: sale.terminalRef ?? '',
  });
  assert.equal(found.outcome, 'approved');
  assert.equal(found.approvedSatang, 10_025, 'the amount the sale took, as the terminal reports it');
  assert.equal(found.requestedSatang, 0, 'nothing was asked for: this is not a sale');
});

test('a void after a partial approval is approved, and reports what came back', async () => {
  const sim = simulator();
  sim.setOutcome('partial', { approvedSatang: 5_000 });
  const { terminal } = terminalWith(sim);
  const sale = await terminal.sale({ attemptId: 'a1', amountSatang: 10_025, tender: 'card' });
  assert.equal(sale.outcome, 'partial_approval', 'the sale rule, unchanged');

  const voided = await terminal.void({
    attemptId: 'a1',
    tender: 'card',
    // The requested amount rather than the approved one: the wrong number to
    // record, and still a void that succeeded.
    amountSatang: 10_025,
    tranRef: sale.invoiceNo ?? '',
    approvalCode: sale.approvalCode,
  });
  assert.equal(voided.outcome, 'approved');
  assert.equal(voided.approvedSatang, 5_000, 'the terminal answers with what it gave back');
});

test('a void is keyed on the invoice number and the approval code, with a fresh reference', async () => {
  const sim = simulator();
  const { terminal, sent } = terminalWith(sim);
  const sale = await terminal.sale({ attemptId: 'a1', amountSatang: 10_025, tender: 'card' });
  const voided = await terminal.void({
    attemptId: 'a1',
    tender: 'card',
    amountSatang: 10_025,
    tranRef: sale.invoiceNo ?? '',
    approvalCode: sale.approvalCode,
  });
  assert.equal(voided.outcome, 'approved');
  const request = sent[1] ?? '';
  assert.ok(request.includes('<transaction_type>VOID</transaction_type>'));
  assert.ok(request.includes(`<invoice_no>${sale.invoiceNo}</invoice_no>`));
  assert.ok(request.includes(`<card_approval_code>${sale.approvalCode}</card_approval_code>`));
  assert.ok(
    request.includes('<pos_ref_no>260923860002</pos_ref_no>'),
    'the void draws a FRESH reference; reusing the sale’s breaks the uniqueness rule',
  );
});

test('a card void without its approval code is refused before the wire', async () => {
  const sim = simulator();
  const { terminal, sent } = terminalWith(sim);
  await terminal.sale({ attemptId: 'a1', amountSatang: 10_025, tender: 'card' });
  await assert.rejects(
    terminal.void({ attemptId: 'a1', tender: 'card', amountSatang: 10_025, tranRef: '000001' }),
    (err: unknown) => err instanceof TerminalError && err.code === 'TERMINAL_BAD_REQUEST',
  );
  assert.equal(sent.length, 1, 'only the sale went out');
});

test('a Thai QR sale cannot be voided at all', async () => {
  const sim = simulator();
  const { terminal, sent } = terminalWith(sim);
  const result = await terminal.void({
    attemptId: 'a1',
    tender: 'qr',
    wallet: 'THAIQRCODE',
    amountSatang: 10_025,
    tranRef: '000001',
  });
  assert.equal(result.outcome, 'unsupported');
  assert.equal(sent.length, 0);
});

test('a void after the terminal’s day has ended is refused', async () => {
  const sim = simulator();
  const { terminal } = terminalWith(sim);
  const sale = await terminal.sale({ attemptId: 'a1', amountSatang: 10_025, tender: 'card' });
  // p.15: a card must be voided before settlement and a wallet before 11PM.
  // Both are the terminal's own clock, which is what the panel can move.
  sim.advanceClock(20 * 60);
  const voided = await terminal.void({
    attemptId: 'a1',
    tender: 'card',
    amountSatang: 10_025,
    tranRef: sale.invoiceNo ?? '',
    approvalCode: sale.approvalCode,
  });
  assert.equal(voided.outcome, 'declined');
});

test('a reference longer than twelve characters never reaches the terminal', async () => {
  const sim = simulator();
  const { terminal, sent } = terminalWith(sim, ['THIRTEENCHARS']);
  await assert.rejects(
    terminal.sale({ attemptId: 'a1', amountSatang: 100, tender: 'card' }),
    (err: unknown) => err instanceof TerminalError && err.code === 'TERMINAL_BAD_REQUEST',
  );
  assert.equal(sent.length, 0);
  assert.equal(GHL_POS_REF_MAX, 12);
});

test('the health probe answers from a terminal that is there, and says so when it is not', async () => {
  const sim = simulator();
  const { terminal, sent } = terminalWith(sim);
  const healthy = await terminal.health();
  assert.equal(healthy.reachability, 'reachable');
  assert.ok(sent[0]?.includes('<transaction_type>QUERY</transaction_type>'));
  assert.ok(
    sent[0]?.includes('<pos_ref_no>HEALTHPROBE0</pos_ref_no>'),
    'the probe reference is alphabetic, so it can never be one the counter minted',
  );

  sim.setOutcome('inquiry_unavailable');
  const silent = await terminal.health();
  assert.equal(silent.reachability, 'unreachable');
  assert.equal(silent.lastError, 'the terminal answered nothing');
});

test('a response about somebody else’s transaction is inconclusive, not approved', async () => {
  const encoder = new TextEncoder();
  const wrong = encodeGhlResponse({
    pos_ref_no: 'SOMEONEELSE1',
    response_code: '00',
    response_msg: 'SUCCESS',
    amount: '100.25',
  });
  const terminal = ghlTerminal({
    deviceId: DEVICE,
    label: 'EDC 1',
    terminalId: TID,
    merchantId: MID,
    open: async () => {
      let sink: ((bytes: Uint8Array) => void) | null = null;
      const { terminalChannel } = await import('../src/terminal/serial-channel');
      return terminalChannel({
        async write() {
          sink?.(encoder.encode(wrong));
        },
        onData(next) {
          sink = next;
        },
        async close() {},
      });
    },
    nextRef: async () => '260923860001',
    now: () => new Date('2026-09-23T07:05:00.000Z'),
    timeouts: { saleMs: 60, probeMs: 40 },
  });
  const result = await terminal.sale({ attemptId: 'a1', amountSatang: 10_025, tender: 'card' });
  // "***For POS, to ensure the pos_ref_no from request and response are
  // matched" (p.8). An answer about another sale says nothing about ours.
  assert.equal(result.outcome, 'no_response');
});
