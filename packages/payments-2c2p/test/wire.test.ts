import { describe, expect, it } from 'vitest';
import { PAYMENT_ATTEMPT_STATUSES } from '@oto/shared';
import {
  GATEWAY_STATE_TO_ATTEMPT_STATUS,
  QR_STATES,
  QR_TERMINAL_STATES,
} from '../src/contract';
import {
  formatPaymentExpiry,
  fromWireAmount,
  maintenanceHostFor,
  paymentHostFor,
  toWireAmount,
} from '../src/config';
import {
  isAboutTheMerchant,
  isAmountMismatch,
  isDuplicateInvoice,
  stateForRespCode,
} from '../src/resp-codes';
import { buildSimulatedEmvcoPayload, crc16, emvcoCrcIsValid } from '../src/emvco';

describe('money on the wire is D(12,5), and never a float', () => {
  it('formats satang to the documented shape', () => {
    expect(toWireAmount(250090)).toBe('2500.90000');
    expect(toWireAmount(0)).toBe('0.00000');
    expect(toWireAmount(1)).toBe('0.01000');
    expect(toWireAmount(144000)).toBe('1440.00000');
  });

  /**
   * The reason it is digit surgery. `250090 / 100` is 2500.8999999999996 in
   * IEEE 754 and `toFixed(5)` on that is right by luck. This asserts that the
   * luck is not being relied on across the range a park takes in a day.
   */
  it('round-trips every satang value a sale can carry', () => {
    for (let satang = 0; satang <= 200_000; satang += 7) {
      expect(fromWireAmount(toWireAmount(satang)), String(satang)).toBe(satang);
    }
  });

  it('reads a JSON number as well as a string, because both arrive', () => {
    expect(fromWireAmount('1440.00000')).toBe(144000);
    expect(fromWireAmount(1440)).toBe(144000);
    expect(fromWireAmount(2500.9)).toBe(250090);
  });

  /**
   * An unreadable amount answers null, and `gateway.ts` treats null as a
   * MISMATCH rather than as agreement. A notification whose amount cannot be
   * compared is not a notification that agrees.
   */
  it('refuses what it cannot read rather than guessing', () => {
    expect(fromWireAmount('')).toBeNull();
    expect(fromWireAmount('one thousand')).toBeNull();
    expect(fromWireAmount('-5.00000')).toBeNull();
    expect(fromWireAmount(null)).toBeNull();
    expect(fromWireAmount({})).toBeNull();
    // Half a satang. THB has no such unit, and rounding one into existence is
    // how a figure nobody can explain gets into a day's takings.
    expect(fromWireAmount('10.00500')).toBeNull();
  });

  it('refuses to put a fractional satang on the wire', () => {
    expect(() => toWireAmount(1.5)).toThrow();
    expect(() => toWireAmount(-1)).toThrow();
  });
});

describe('hosts', () => {
  it('are the published ones, and maintenance is a DIFFERENT host', () => {
    expect(paymentHostFor('sandbox')).toBe('https://sandbox-pgw.2c2p.com');
    expect(paymentHostFor('production')).toBe('https://pgw.2c2p.com');
    expect(maintenanceHostFor('sandbox')).toContain('PaymentAction/2.0/action');
    expect(maintenanceHostFor('production')).toContain('PaymentAction/2.0/action');
    expect(maintenanceHostFor('production')).not.toBe(paymentHostFor('production'));
  });

  it('let a deployment point at a mock without changing the code', () => {
    expect(paymentHostFor('production', 'http://localhost:9999')).toBe('http://localhost:9999');
    expect(paymentHostFor('production', '   ')).toBe('https://pgw.2c2p.com');
  });
});

describe('paymentExpiry', () => {
  it('is yyyy-MM-dd HH:mm:ss in the merchant wall clock, Asia/Bangkok', () => {
    // 2026-09-23T10:00:00Z is 17:00 in Phuket.
    expect(formatPaymentExpiry(new Date('2026-09-23T10:00:00.000Z'))).toBe('2026-09-23 17:00:00');
    // And the day rolls with it: 18:30Z is 01:30 the next morning there.
    expect(formatPaymentExpiry(new Date('2026-09-23T18:30:00.000Z'))).toBe('2026-09-24 01:30:00');
  });
});

describe('respCode', () => {
  it('reads the codes the acceptance names', () => {
    expect(stateForRespCode('0000')).toBe('paid');
    expect(stateForRespCode('0001')).toBe('pending');
    expect(stateForRespCode('1005')).toBe('qr_shown');
    expect(stateForRespCode('0003')).toBe('cancelled');
    expect(stateForRespCode('9020')).toBe('expired');
    expect(stateForRespCode('5009')).toBe('expired');
    expect(stateForRespCode('5017')).toBe('late_paid');
    expect(stateForRespCode('2002')).toBe('not_found');
    expect(stateForRespCode('5005')).toBe('duplicate_invoice');
    expect(stateForRespCode('9015')).toBe('duplicate_invoice');
  });

  /** The line the plant is built on: neither mismatch code is ever `paid`. */
  it('never reads an amount mismatch as paid', () => {
    expect(stateForRespCode('5015')).toBe('amount_mismatch');
    expect(stateForRespCode('5016')).toBe('amount_mismatch');
    expect(isAmountMismatch('5015')).toBe(true);
    expect(isAmountMismatch('5016')).toBe(true);
    expect(isAmountMismatch('0000')).toBe(false);
    expect(GATEWAY_STATE_TO_ATTEMPT_STATUS.amount_mismatch).toBe('awaiting_staff_confirmation');
    expect(GATEWAY_STATE_TO_ATTEMPT_STATUS.amount_mismatch).not.toBe('approved');
  });

  it('keeps 9999 as a fact about US, not about the payment', () => {
    expect(isAboutTheMerchant('9999')).toBe(true);
    expect(isAboutTheMerchant('0000')).toBe(false);
  });

  it('names an invoice reuse as ours to fix', () => {
    expect(isDuplicateInvoice('5005')).toBe(true);
    expect(isDuplicateInvoice('9015')).toBe(true);
    expect(isDuplicateInvoice('2002')).toBe(false);
  });

  it('calls an unknown code failed rather than guessing', () => {
    expect(stateForRespCode('7777')).toBe('failed');
    expect(stateForRespCode(null)).toBe('failed');
    expect(stateForRespCode(undefined)).toBe('failed');
  });
});

describe('D-3 — the mapping from the gateway words to the ledger words', () => {
  it('covers every gateway state exactly once', () => {
    expect(Object.keys(GATEWAY_STATE_TO_ATTEMPT_STATUS).sort()).toEqual([...QR_STATES].sort());
  });

  it('only ever answers with a word the column CHECK allows', () => {
    for (const [state, status] of Object.entries(GATEWAY_STATE_TO_ATTEMPT_STATUS)) {
      if (status === null) continue;
      expect(PAYMENT_ATTEMPT_STATUSES, `${state} -> ${status}`).toContain(status);
    }
  });

  it('is the mapping the plan wrote down, line for line', () => {
    expect(GATEWAY_STATE_TO_ATTEMPT_STATUS.qr_shown).toBe('sent_to_terminal');
    expect(GATEWAY_STATE_TO_ATTEMPT_STATUS.paid).toBe('approved');
    expect(GATEWAY_STATE_TO_ATTEMPT_STATUS.expired).toBe('cancelled');
    expect(GATEWAY_STATE_TO_ATTEMPT_STATUS.late_paid).toBe('awaiting_staff_confirmation');
    // `refunded` is S2-11's word and is not written by this slice.
    expect(GATEWAY_STATE_TO_ATTEMPT_STATUS.refunded).toBeNull();
  });

  it('stops the poller on the states nothing more happens to', () => {
    expect(QR_TERMINAL_STATES).toContain('paid');
    expect(QR_TERMINAL_STATES).toContain('expired');
    expect(QR_TERMINAL_STATES).not.toContain('qr_shown');
    expect(QR_TERMINAL_STATES).not.toContain('pending');
    // `late_paid` is deliberately NOT terminal: a person still has to answer it.
    expect(QR_TERMINAL_STATES).not.toContain('late_paid');
  });
});

describe('the simulator EMVCo payload', () => {
  const payload = buildSimulatedEmvcoPayload({ amountSatang: 144000, invoiceNo: 'T01260923000007' });

  it('carries a valid CRC over its own body', () => {
    expect(emvcoCrcIsValid(payload)).toBe(true);
    expect(emvcoCrcIsValid(`${payload.slice(0, -1)}0`)).toBe(false);
  });

  it('is a dynamic merchant-presented THB code carrying the amount', () => {
    expect(payload.startsWith('000201')).toBe(true);
    expect(payload).toContain('010212');
    expect(payload).toContain('5303764');
    expect(payload).toContain('54071440.00');
    expect(payload).toContain('5802TH');
    expect(payload).toContain('T01260923000007');
  });

  /**
   * THE SIMULATOR'S QR MUST NOT BE PAYABLE. A demo QR somebody could actually
   * scan and send money to would move real money during a rehearsal.
   */
  it('names no real PromptPay proxy', () => {
    expect(payload).toContain('A000000677010111');
    expect(payload).toContain('000000000000000');
    expect(payload).not.toMatch(/0066\d{9}/);
  });

  it('matches the prototype builder on the reference vector', () => {
    // CRC-16/CCITT-FALSE of "123456789" is 0x29B1 — the standard's own check.
    expect(crc16('123456789')).toBe('29B1');
  });
});
