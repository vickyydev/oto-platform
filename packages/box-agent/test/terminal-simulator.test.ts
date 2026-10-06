import assert from 'node:assert/strict';
import { test } from 'node:test';

import { TERMINAL_OUTCOMES } from '@oto/shared';

import type { BoxConfigBundle } from '../src/protocol';
import { createTerminals } from '../src/terminal/index';
import { TERMINAL_OUTCOME_KINDS, type SimulatedOutcome } from '../src/terminal/contract';
import { BOX_ID, openTestStore, fakeBoxCloud, openTestAgent, tillBundle } from './_support';

/**
 * The two simulators, driven through the real adapters (S2-10a).
 *
 * Every assertion here is made against `createTerminals`, which is what the
 * agent's `terminal_sale` command calls, so nothing in the path is stubbed: the
 * controller routes by station and role, the adapter encodes the vendor's
 * message, the simulator answers the vendor's bytes, and the adapter parses its
 * own way back. The only thing that is not real is the cable.
 */

const STATION = '018f0000-0000-7000-8000-0000000057a1';
const NEXGO = '018f0000-0000-7000-8000-0000000edc01';
const PAX = '018f0000-0000-7000-8000-0000000edc03';
const NOW = new Date('2026-09-23T07:05:00.000Z');
/** A placeholder with no digits in it: the real one is configuration. */
const VOID_PASSWORD = 'VOIDPW';

function bundle(): BoxConfigBundle {
  return {
    box: { id: BOX_ID, name: 'Till box', role: 'till', epoch: 1, status: 'active' },
    branch: {
      id: '018f0000-0000-7000-8000-0000000000b2',
      code: 'HKT',
      name: 'HKT Central',
      operatorId: '018f0000-0000-7000-8000-0000000000b1',
      timezone: 'Asia/Bangkok',
      openingHours: null,
      businessDayStart: '05:00',
    },
    stations: [
      {
        id: STATION,
        name: 'Till 1',
        kind: 'till',
        codePrefix: 'T1',
        capabilities: [],
        configVersion: 1,
        paymentRouting: { card: 'card_terminal', qr: 'qr_terminal' },
        offlineWalletCapSatang: null,
        accessScope: 'branch',
        devices: [
          {
            id: NEXGO,
            role: 'card_terminal',
            kind: 'terminal',
            label: 'EDC 1 (NEXGO N5)',
            transport: 'simulated',
            address: '/dev/serial/by-id/usb-NEXGO-if00',
            model: 'NEXGO N5',
            protocol: 'ghl_linkpos',
            serialNumber: null,
            terminalId: '65703235',
            merchantId: '4648434010',
          },
          {
            id: PAX,
            role: 'qr_terminal',
            kind: 'terminal',
            label: 'EDC 3 (PAX A920Pro)',
            transport: 'simulated',
            address: '/dev/serial/by-id/usb-PAX_Technology_A920-if00',
            model: 'PAX A920Pro',
            protocol: 'digio_tlv',
            serialNumber: '1854355548',
            terminalId: null,
            merchantId: null,
          },
        ],
      },
    ],
    signingKeys: [],
  } as unknown as BoxConfigBundle;
}

function controllerOn(held: ReturnType<typeof openTestStore>) {
  return createTerminals({
    bundle: () => bundle(),
    store: held.store,
    boxId: () => BOX_ID,
    now: () => NOW,
    voidPassword: VOID_PASSWORD,
    cashier: 'Jane Doe',
    timeouts: { saleMs: 80, probeMs: 60 },
  });
}

async function withBox(
  run: (controller: ReturnType<typeof controllerOn>) => Promise<void>,
): Promise<void> {
  const held = openTestStore();
  try {
    await held.store.init(BOX_ID);
    await run(controllerOn(held));
  } finally {
    held.close();
  }
}

test('the panel’s six outcomes are the adapter’s six branches, on both dialects', async () => {
  // The words the Console sends are `TERMINAL_OUTCOMES` in `@oto/shared`; the
  // words an attempt is recorded with are this package's. The mapping below is
  // the whole of the difference, and it is asserted rather than assumed.
  assert.deepEqual([...TERMINAL_OUTCOMES], [
    'approved',
    'declined',
    'partial',
    'no_response',
    'inquiry_unavailable',
    'timeout',
  ]);

  const expected: Record<SimulatedOutcome, Record<string, string>> = {
    approved: { ghl: 'approved', digio: 'approved' },
    declined: { ghl: 'declined', digio: 'declined' },
    partial: { ghl: 'partial_approval', digio: 'partial_approval' },
    no_response: { ghl: 'no_response', digio: 'no_response' },
    // The NEXGO has no card QUERY at all, so "the inquiry is unavailable" looks
    // like silence on the sale and stays silent afterwards; the PAX answers
    // nothing to its `T2`.
    inquiry_unavailable: { ghl: 'no_response', digio: 'no_response' },
    // GHL documents no timeout semantics anywhere, so its simulator is silent;
    // Digio has `401 Host timeout`, which is a different, knowable fact.
    timeout: { ghl: 'no_response', digio: 'timeout' },
  };

  for (const outcome of TERMINAL_OUTCOMES) {
    await withBox(async (controller) => {
      controller.setOutcome(NEXGO, outcome);
      controller.setOutcome(PAX, outcome);
      const card = await controller.runCommand({
        mode: 'sale',
        attemptId: '018f0000-0000-7000-8000-00000000a001',
        stationId: STATION,
        amountSatang: 10_025,
        tender: 'card',
      });
      const qr = await controller.runCommand({
        mode: 'sale',
        attemptId: '018f0000-0000-7000-8000-00000000a002',
        stationId: STATION,
        amountSatang: 10_050,
        tender: 'qr',
      });
      assert.equal(card.result?.outcome, expected[outcome]?.ghl, `GHL on ${outcome}`);
      assert.equal(qr.result?.outcome, expected[outcome]?.digio, `Digio on ${outcome}`);
      assert.ok(TERMINAL_OUTCOME_KINDS.includes(card.result?.outcome ?? 'approved'));
    });
  }
});

test('a QR sale hands the payload over before the guest has paid', async () => {
  await withBox(async (controller) => {
    const progress: string[] = [];
    const outcome = await controller.runCommand(
      {
        mode: 'sale',
        attemptId: '018f0000-0000-7000-8000-00000000a003',
        stationId: STATION,
        amountSatang: 10_050,
        tender: 'qr',
        requestQrPayload: true,
      },
      {
        onProgress: (event) => {
          if (event.kind === 'qr_payload' && event.qrPayload) progress.push(event.qrPayload);
        },
      },
    );
    /**
     * Two answers to one request: `A18` with the payload, then `A3` when the
     * guest pays. The payload reaches the caller on the FIRST, which is what
     * lets the customer display draw the code rather than waiting two minutes
     * for the payment that the code is supposed to cause.
     */
    assert.equal(progress.length, 1);
    assert.match(progress[0] ?? '', /^SIMULATED-EMVCO-PAYLOAD\|/);
    assert.equal(outcome.result?.outcome, 'approved');
    assert.equal(outcome.result?.qrPayload, progress[0]);
    assert.equal(outcome.result?.approvedSatang, 10_050);
    // The PAX has no TID on file; the terminal tells us and the row can be
    // corrected from it.
    assert.equal(outcome.result?.tid, '54355548');
  });
});

test('an inquiry that finds the sale completes it without a second charge', async () => {
  await withBox(async (controller) => {
    const sale = await controller.runCommand({
      mode: 'sale',
      attemptId: '018f0000-0000-7000-8000-00000000a004',
      stationId: STATION,
      deviceId: PAX,
      amountSatang: 10_050,
      tender: 'card',
      role: 'qr_terminal',
    });
    assert.equal(sale.result?.outcome, 'approved');

    const found = await controller.runCommand({
      mode: 'inquire',
      attemptId: '018f0000-0000-7000-8000-00000000a004',
      deviceId: PAX,
      amountSatang: 10_050,
      tender: 'card',
      role: 'qr_terminal',
      terminalRef: sale.result?.terminalRef ?? '',
      tranRef: sale.result?.tranRef ?? '',
    });
    assert.equal(found.result?.outcome, 'approved');
    // The same transaction id and the same approval code as the answer that was
    // lost: the cloud settles the attempt it already has.
    assert.equal(found.result?.tranRef, sale.result?.tranRef);
    assert.equal(found.result?.approvalCode, sale.result?.approvalCode);

    const missing = await controller.runCommand({
      mode: 'inquire',
      attemptId: '018f0000-0000-7000-8000-00000000a005',
      deviceId: PAX,
      amountSatang: 10_050,
      tender: 'card',
      role: 'qr_terminal',
      terminalRef: '990099',
      tranRef: 'NOSUCHTRANSACTIONID00000',
    });
    assert.equal(missing.result?.outcome, 'not_found');
    assert.equal(missing.result?.responseCode, '203');
  });
});

test('a void after a partial approval reads approved, whichever amount is passed', async () => {
  /**
   * THE TICKET'S OWN RESCUE PATH, on both dialects.
   *
   * A partial approval is refused and the tender voided. The terminal then
   * answers the void with the amount it gave BACK — which is the approved
   * amount, not the amount the sale asked for — so an answer-reader that
   * measured every approval against the request would read the successful
   * rescue as a second partial approval. A caller doing the obvious thing
   * (`outcome === 'approved'`) would conclude the void failed and leave a
   * guest charged with nobody chasing it.
   *
   * Which of the two amounts a caller passes is its own choice
   * (`TerminalVoidRequest.amountSatang` says the approved one), so both are
   * driven here and both must read `approved`.
   */
  for (const [label, amountSatang] of [
    ['the amount the sale asked for', 10_025],
    ['the amount the terminal approved', 5_000],
  ] as const) {
    await withBox(async (controller) => {
      controller.setOutcome(NEXGO, 'partial', { approvedSatang: 5_000 });
      const sale = await controller.runCommand({
        mode: 'sale',
        attemptId: '018f0000-0000-7000-8000-00000000b001',
        stationId: STATION,
        amountSatang: 10_025,
        tender: 'card',
      });
      // The rule itself, unchanged: a SALE approved below the request is a
      // partial approval and the cloud must not take it.
      assert.equal(sale.result?.outcome, 'partial_approval', `GHL sale, ${label}`);
      assert.equal(sale.result?.approvedSatang, 5_000);

      const voided = await controller.runCommand({
        mode: 'void',
        attemptId: '018f0000-0000-7000-8000-00000000b001',
        stationId: STATION,
        amountSatang,
        tender: 'card',
        tranRef: sale.result?.tranRef ?? '',
        approvalCode: sale.result?.approvalCode ?? null,
      });
      assert.equal(voided.result?.outcome, 'approved', `GHL void with ${label}`);
      assert.equal(voided.result?.responseCode, '00');
    });

    await withBox(async (controller) => {
      controller.setOutcome(PAX, 'partial', { approvedSatang: 5_000 });
      const sale = await controller.runCommand({
        mode: 'sale',
        attemptId: '018f0000-0000-7000-8000-00000000b002',
        deviceId: PAX,
        role: 'qr_terminal',
        amountSatang: 10_050,
        tender: 'card',
      });
      // Digio has no partial-approval code at all: `100 SUCCESS` with an
      // amount below the request is the only evidence there is.
      assert.equal(sale.result?.outcome, 'partial_approval', `Digio sale, ${label}`);
      assert.equal(sale.result?.responseCode, '100');
      assert.equal(sale.result?.approvedSatang, 5_000);

      const voided = await controller.runCommand({
        mode: 'void',
        attemptId: '018f0000-0000-7000-8000-00000000b002',
        deviceId: PAX,
        role: 'qr_terminal',
        amountSatang: amountSatang === 10_025 ? 10_050 : amountSatang,
        tender: 'card',
        tranRef: sale.result?.tranRef ?? '',
      });
      assert.equal(voided.result?.outcome, 'approved', `Digio void with ${label}`);
      assert.equal(voided.result?.responseCode, '100');
      // The money that came back, reported as the terminal reported it.
      assert.equal(voided.result?.approvedSatang, 5_000);
    });
  }
});

test('a void is refused once the terminal’s batch has settled', async () => {
  await withBox(async (controller) => {
    const sale = await controller.runCommand({
      mode: 'sale',
      attemptId: '018f0000-0000-7000-8000-00000000a006',
      stationId: STATION,
      deviceId: PAX,
      amountSatang: 10_050,
      tender: 'card',
      role: 'qr_terminal',
    });
    const voided = await controller.runCommand({
      mode: 'void',
      attemptId: '018f0000-0000-7000-8000-00000000a006',
      deviceId: PAX,
      amountSatang: 10_050,
      tender: 'card',
      role: 'qr_terminal',
      tranRef: sale.result?.tranRef ?? '',
    });
    assert.equal(voided.result?.outcome, 'approved');
    assert.equal(voided.result?.responseCode, '100');

    const second = await controller.runCommand({
      mode: 'sale',
      attemptId: '018f0000-0000-7000-8000-00000000a007',
      stationId: STATION,
      deviceId: PAX,
      amountSatang: 10_050,
      tender: 'card',
      role: 'qr_terminal',
    });
    // "Advance terminal clock" is what makes the void window real: §6.2's `205`
    // "Transaction already settle" cannot be reached any other way.
    controller.advanceClock(PAX, 20 * 60);
    const late = await controller.runCommand({
      mode: 'void',
      attemptId: '018f0000-0000-7000-8000-00000000a007',
      deviceId: PAX,
      amountSatang: 10_050,
      tender: 'card',
      role: 'qr_terminal',
      tranRef: second.result?.tranRef ?? '',
    });
    assert.equal(late.result?.responseCode, '205');
    assert.equal(late.result?.outcome, 'declined');
  });
});

test('a Thai QR sale on the PAX cannot be voided', async () => {
  await withBox(async (controller) => {
    const sale = await controller.runCommand({
      mode: 'sale',
      attemptId: '018f0000-0000-7000-8000-00000000a008',
      stationId: STATION,
      amountSatang: 10_050,
      tender: 'qr',
    });
    const voided = await controller.runCommand({
      mode: 'void',
      attemptId: '018f0000-0000-7000-8000-00000000a008',
      stationId: STATION,
      amountSatang: 10_050,
      tender: 'qr',
      tranRef: sale.result?.tranRef ?? '',
    });
    // §5.5: "only Credit Card, Alipay and WeChat … EDC will send response code
    // '333'". GHL says the same of its own Thai QR, which is why we assume it.
    assert.equal(voided.result?.responseCode, '333');
    assert.equal(voided.result?.outcome, 'unsupported');
  });
});

test('a void without the configured password never reaches an approval', async () => {
  const held = openTestStore();
  try {
    await held.store.init(BOX_ID);
    const controller = createTerminals({
      bundle: () => bundle(),
      store: held.store,
      boxId: () => BOX_ID,
      now: () => NOW,
      // A box with no password configured: the simulator refuses, exactly as a
      // real terminal refuses a wrong one.
      voidPassword: null,
      timeouts: { saleMs: 80, probeMs: 60 },
    });
    const sale = await controller.runCommand({
      mode: 'sale',
      attemptId: '018f0000-0000-7000-8000-00000000a009',
      stationId: STATION,
      deviceId: PAX,
      amountSatang: 10_050,
      tender: 'card',
      role: 'qr_terminal',
    });
    const voided = await controller.runCommand({
      mode: 'void',
      attemptId: '018f0000-0000-7000-8000-00000000a009',
      deviceId: PAX,
      amountSatang: 10_050,
      tender: 'card',
      role: 'qr_terminal',
      tranRef: sale.result?.tranRef ?? '',
    });
    assert.equal(voided.result, null);
    assert.equal(voided.errorCode, 'TERMINAL_NOT_CONFIGURED');
  } finally {
    held.close();
  }
});

test('a card sale on the NEXGO cannot be inquired about, and says so', async () => {
  await withBox(async (controller) => {
    const inquiry = await controller.runCommand({
      mode: 'inquire',
      attemptId: '018f0000-0000-7000-8000-00000000a010',
      stationId: STATION,
      amountSatang: 10_025,
      tender: 'card',
      terminalRef: '260923860001',
    });
    assert.equal(inquiry.result?.outcome, 'unsupported');
    // Which is the audited staff-confirmation dialog's reason for existing: on
    // this dialect it is permanent, not a degraded path.
    assert.match(inquiry.result?.responseText ?? '', /no QUERY for a card sale/);
  });
});

test('both terminals answer a health probe, and each answers what its dialect has', async () => {
  await withBox(async (controller) => {
    const nexgo = controller.terminal(NEXGO);
    const pax = controller.terminal(PAX);
    assert.ok(nexgo && pax);
    const ghlHealth = await nexgo.health();
    assert.equal(ghlHealth.reachability, 'reachable');
    assert.equal(ghlHealth.serialNumber, null, 'GHL has no terminal-info message');
    assert.equal(ghlHealth.tid, '65703235');

    const digioHealth = await pax.health();
    assert.equal(digioHealth.reachability, 'reachable');
    // `T0`/`T1` is the vendor's own "test connect edc device", and it is the
    // only message in the dialect with no financial effect.
    assert.equal(digioHealth.serialNumber, '1854355548');
    assert.equal(digioHealth.softwareVersion, '1.8.127');
  });
});

test('a tender for a station with no such terminal is refused, not guessed at', async () => {
  await withBox(async (controller) => {
    const nowhere = await controller.runCommand({
      mode: 'sale',
      attemptId: '018f0000-0000-7000-8000-00000000a011',
      stationId: '018f0000-0000-7000-8000-0000000057ff',
      amountSatang: 10_025,
      tender: 'card',
    });
    assert.equal(nowhere.routed, null);
    assert.equal(nowhere.errorCode, 'TERMINAL_NOT_ON_THIS_BOX');
    assert.equal(nowhere.result, null);
  });
});

test('two tenders for one terminal are taken one at a time', async () => {
  await withBox(async (controller) => {
    /**
     * A tethered EDC has one screen. Two tenders sent at once would interleave
     * on the wire and, worse, a guest would be looking at somebody else's
     * amount — so the controller chains them per device, as the print queue
     * chains jobs per printer.
     */
    const both = await Promise.all([
      controller.runCommand({
        mode: 'sale',
        attemptId: '018f0000-0000-7000-8000-00000000a012',
        stationId: STATION,
        amountSatang: 10_025,
        tender: 'card',
      }),
      controller.runCommand({
        mode: 'sale',
        attemptId: '018f0000-0000-7000-8000-00000000a013',
        stationId: STATION,
        amountSatang: 20_000,
        tender: 'card',
      }),
    ]);
    assert.equal(both[0]?.result?.outcome, 'approved');
    assert.equal(both[1]?.result?.outcome, 'approved');
    assert.notEqual(both[0]?.result?.terminalRef, both[1]?.result?.terminalRef);
    assert.equal(both[0]?.result?.approvedSatang, 10_025);
    assert.equal(both[1]?.result?.approvedSatang, 20_000);
  });
});

test('the simulator keeps a tape of what it was asked and what it withheld', async () => {
  await withBox(async (controller) => {
    controller.setOutcome(NEXGO, 'no_response');
    await controller.runCommand({
      mode: 'sale',
      attemptId: '018f0000-0000-7000-8000-00000000a014',
      stationId: STATION,
      amountSatang: 10_025,
      tender: 'card',
    });
    const events = controller.events(NEXGO);
    assert.ok(events.some((event) => event.kind === 'outcome.set'));
    assert.ok(events.some((event) => event.kind === 'request'));
    const withheld = events.find((event) => event.kind === 'withheld');
    assert.ok(withheld, 'silence is recorded, or nobody could tell it from a lost cable');
    assert.equal(withheld.detail.because, 'no_response');
  });
});

test('a Digio card exchange leaves no card number and no frame on the tape', async () => {
  await withBox(async (controller) => {
    /**
     * The `A1` credit response is the frame that carries both: a masked PAN on
     * tag `09` and the cardholder's name on tag `0A`. The result keeps four
     * digits of the first and nothing of the second — and the tape, which a
     * Console panel reads through `TerminalController.events`, must not be the
     * back door that carries what the parser refused.
     */
    const sale = await controller.runCommand({
      mode: 'sale',
      attemptId: '018f0000-0000-7000-8000-00000000b010',
      deviceId: PAX,
      role: 'qr_terminal',
      amountSatang: 10_050,
      tender: 'card',
    });
    assert.equal(sale.result?.outcome, 'approved');
    assert.equal(sale.result?.last4, '4242', 'four digits reach the result, and only four');

    const tape = JSON.stringify(controller.events(PAX)).toUpperCase();
    // As text, and as the bytes a frame would have spelled them in: a hex
    // dump of an `A1` says the same things and says them in a form nothing
    // downstream would recognise as a card number.
    const asHex = (text: string): string =>
      [...new TextEncoder().encode(text)]
        .map((byte) => byte.toString(16).padStart(2, '0'))
        .join('')
        .toUpperCase();
    assert.equal(tape.includes('424242'), false, 'tag 09, the masked PAN');
    assert.equal(tape.includes(asHex('424242')), false, 'tag 09 in hex either');
    assert.equal(tape.includes('CARDHOLDER'), false, 'tag 0A, the cardholder name');
    assert.equal(tape.includes(asHex('CARDHOLDER')), false, 'tag 0A in hex either');
    assert.equal(tape.includes('3E55'), false, 'the frame header, so no frame');
    assert.equal(/[0-9A-F]{40,}/.test(tape), false, 'nothing long enough to be a frame in hex');

    const response = controller.events(PAX).find((event) => event.kind === 'response');
    assert.ok(response, 'the answer is still on the tape — narrowed, not removed');
    assert.equal(response.detail.frame, undefined);
    assert.equal(response.detail.action, 'A1');
    assert.equal(response.detail.responseCode, '100');
    assert.equal(response.detail.amount, '10050');
    assert.equal(response.detail.tranRef, sale.result?.tranRef);
  });
});

test('a GHL card exchange leaves no card_no and no message on the tape', async () => {
  await withBox(async (controller) => {
    const sale = await controller.runCommand({
      mode: 'sale',
      attemptId: '018f0000-0000-7000-8000-00000000b011',
      stationId: STATION,
      amountSatang: 10_025,
      tender: 'card',
    });
    assert.equal(sale.result?.outcome, 'approved');

    const tape = JSON.stringify(controller.events(NEXGO));
    assert.equal(tape.includes('card_no'), false, 'the masked PAN’s own element');
    assert.equal(tape.includes('424242'), false, 'or its value under any other name');
    assert.equal(tape.includes('<xml'), false, 'the message itself is not written down');
    assert.equal(tape.includes('card_approval_code'), false, 'the void key stays on the result');

    const response = controller.events(NEXGO).find((event) => event.kind === 'response');
    assert.ok(response);
    assert.equal(response.detail.xml, undefined);
    assert.equal(response.detail.responseCode, '00');
    assert.equal(response.detail.amount, '100.25');
    assert.equal(response.detail.invoiceNo, sale.result?.invoiceNo);
  });
});


test('settlement uses durable terminal facts by business day and replays the same batch after restart', async () => {
  const held = openTestStore();
  try {
    await held.store.init(BOX_ID);
    const controller = controllerOn(held);
    for (let i = 0; i < 25; i += 1) {
      const taken = await controller.runCommand({ mode: 'sale',
        attemptId: `018f0000-0000-7000-8000-${String(i + 1).padStart(12, '0')}`,
        deviceId: NEXGO, tender: 'card', amountSatang: 1000 + i });
      assert.equal(taken.result?.outcome, 'approved');
    }
    controller.setOutcome(NEXGO, 'declined');
    await controller.runCommand({ mode: 'sale', attemptId: '018f0000-0000-7000-8000-000000001111',
      deviceId: NEXGO, tender: 'card', amountSatang: 9999 });
    const reopened = controllerOn(held);
    const payload = { batchId: '018f0000-0000-7000-8000-000000002222',
      deviceId: NEXGO, businessDate: '2026-09-23' };
    const batch = await reopened.settle(payload);
    assert.equal(batch.outcome, 'settled');
    assert.equal(batch.lines.length, 25);
    assert.equal(batch.lines.reduce((sum, line) => sum + line.amountSatang, 0), 25300);
    assert.ok(batch.batchRef?.startsWith('SIM-'));
    assert.equal(batch.tid, bundle().stations[0]?.devices[0]?.terminalId);
    assert.deepEqual(await controllerOn(held).settle(payload), batch);
    assert.equal((await reopened.settle({ ...payload, businessDate: '2026-09-22' })).errorCode,
      'SETTLEMENT_BATCH_CONFLICT');
    assert.equal((await reopened.settle({ ...payload,
      batchId: '018f0000-0000-7000-8000-000000003333' })).lines.length, 0);
    const first = batch.lines[0];
    const attemptedVoid = await reopened.runCommand({ mode: 'void',
      attemptId: '018f0000-0000-7000-8000-000000004444', deviceId: NEXGO, tender: 'card',
      amountSatang: first!.amountSatang, tranRef: first!.tranRef, approvalCode: first!.approvalCode });
    assert.notEqual(attemptedVoid.result?.outcome, 'approved');
  } finally { held.close(); }
});

test('settlement excludes voids, other terminals and other business days', async () => {
  const held = openTestStore();
  try {
    await held.store.init(BOX_ID);
    const controller = controllerOn(held);
    const card = await controller.runCommand({ mode: 'sale',
      attemptId: '018f0000-0000-7000-8000-000000005555', deviceId: NEXGO, tender: 'card', amountSatang: 5000 });
    assert.equal(card.result?.outcome, 'approved');
    await controller.runCommand({ mode: 'void',
      attemptId: '018f0000-0000-7000-8000-000000006666', deviceId: NEXGO, tender: 'card',
      amountSatang: 5000, tranRef: card.result?.tranRef, approvalCode: card.result?.approvalCode });
    await controller.runCommand({ mode: 'sale',
      attemptId: '018f0000-0000-7000-8000-000000007777', deviceId: PAX, tender: 'qr', amountSatang: 7000 });
    const payload = { batchId: '018f0000-0000-7000-8000-000000008888', deviceId: NEXGO,
      businessDate: '2026-09-23' };
    assert.deepEqual((await controller.settle(payload)).lines, []);
    assert.deepEqual((await controller.settle({ ...payload, deviceId: PAX,
      businessDate: '2026-09-22' })).lines, []);
    const qr = await controller.settle({ ...payload, deviceId: PAX,
      batchId: '018f0000-0000-7000-8000-000000009999' });
    assert.equal(qr.lines.length, 1);
    assert.equal(qr.lines[0]?.method, 'qr');
    assert.equal(qr.lines[0]?.amountSatang, 7000);
  } finally { held.close(); }
});

test('real terminals report unsupported without opening an unverified settlement wire', async () => {
  const config = bundle();
  for (const device of config.stations[0]!.devices) device.transport = 'serial';
  const controller = createTerminals({ bundle: () => config, boxId: () => BOX_ID,
    openSerial: async () => { throw new Error('must not open'); } });
  for (const deviceId of [NEXGO, PAX]) {
    const result = await controller.settle({ batchId: '018f0000-0000-7000-8000-000000002222',
      deviceId, businessDate: '2026-09-23' });
    assert.equal(result.outcome, 'unsupported');
    assert.equal(result.errorCode, 'TERMINAL_SETTLEMENT_UNSUPPORTED');
    assert.deepEqual(result.lines, []);
  }
});


test('a lost settlement callback is retried with durable evidence before command acknowledgement', { timeout: 10000 }, async () => {
  const cloud = fakeBoxCloud(tillBundle(bundle()));
  const fetch = cloud.fetch;
  let available = false;
  const received: unknown[] = [];
  cloud.fetch = async (url, init) => {
    if (new URL(url).pathname.endsWith('/terminal-result')) {
      received.push(JSON.parse(init.body!));
      return { status: available ? 200 : 503, json: async () => ({}), text: async () => '{}', header: () => null };
    }
    return fetch(url, init);
  };
  const held = await openTestAgent(cloud, { terminal: { enabled: true } });
  try {
    const terminal = held.agent.terminal()!;
    await terminal.runCommand({ mode: 'sale',
      attemptId: '018f0000-0000-7000-8000-000000004444', deviceId: NEXGO,
      tender: 'card', amountSatang: 19000 });
    const command = { id: '018f0000-0000-7000-8000-000000002222', kind: 'terminal_settle' as const,
      actionId: null, attempts: 1, createdAt: NOW.toISOString(), expiresAt: null, payload: { batchId: '018f0000-0000-7000-8000-000000003333',
        deviceId: NEXGO, businessDate: terminal.businessDate() } };
    cloud.commands.push(command);
    await held.agent.runPendingCommands();
    assert.equal(cloud.commandResults.length, 0);
    assert.equal(cloud.commands.length, 0);
    held.agent.stop();
    available = true;
    const restarted = await openTestAgent(cloud, { terminal: { enabled: true } }, held.harness);
    try {
      // start() invokes the production command tick. The cloud has no queued
      // command left; only the durable box handout can finish this callback.
      await restarted.agent.start();
      assert.deepEqual(received[1], received[0]);
      assert.equal((received[1] as { lines: unknown[] }).lines.length, 1);
      assert.equal(cloud.commandResults.length, 1);
      assert.equal(cloud.commandResults[0]?.body.state, 'succeeded');
      await restarted.agent.runPendingCommands();
      assert.equal(received.length, 2);
    } finally { restarted.close(); }
  } finally { held.close(); }
});


test('settlement uses the branch day start and preserves the terminal identity that took the money', async () => {
  const held = openTestStore();
  try {
    await held.store.init(BOX_ID);
    const config = bundle();
    const options = { bundle: () => config, boxId: () => BOX_ID, store: held.store,
      now: () => new Date('2026-09-23T20:00:00Z') };
    const controller = createTerminals(options); // 03:00 Bangkok, still trading on the 23rd.
    await controller.runCommand({ mode: 'sale',
      attemptId: '018f0000-0000-7000-8000-000000007777', deviceId: NEXGO, tender: 'card', amountSatang: 7000 });
    const originalTid = config.stations[0]!.devices[0]!.terminalId;
    config.stations[0]!.devices[0]!.terminalId = 'REPLACED';
    const rebooted = createTerminals(options);
    const payload = { batchId: '018f0000-0000-7000-8000-000000008888', deviceId: NEXGO,
      businessDate: '2026-09-24' };
    assert.deepEqual((await rebooted.settle(payload)).lines, []);
    const previousDay = await rebooted.settle({ ...payload, businessDate: '2026-09-23',
      batchId: '018f0000-0000-7000-8000-000000009999' });
    assert.equal(previousDay.lines.length, 1);
    assert.equal(previousDay.tid, originalTid);
  } finally { held.close(); }
});


test('settlement includes paid GHL wallet transactions on the QR ledger line', async () => {
  await withBox(async (controller) => {
    const sale = await controller.runCommand({ mode: 'sale',
      attemptId: '018f0000-0000-7000-8000-000000007777', deviceId: NEXGO,
      tender: 'wallet', wallet: 'ALIPAY', amountSatang: 12000 });
    assert.equal(sale.result?.outcome, 'approved');
    const batch = await controller.settle({ batchId: '018f0000-0000-7000-8000-000000008888',
      deviceId: NEXGO, businessDate: '2026-09-23' });
    assert.equal(batch.lines.length, 1);
    assert.equal(batch.lines[0]?.method, 'qr');
    assert.equal(batch.lines[0]?.amountSatang, sale.result?.approvedSatang);
    assert.equal(batch.lines[0]?.terminalRef, sale.result?.terminalRef);
    assert.equal(batch.lines[0]?.tranRef, sale.result?.tranRef);
    assert.equal(batch.lines[0]?.approvalCode, sale.result?.approvalCode);
  });
});
