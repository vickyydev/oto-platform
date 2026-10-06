import { describe, expect, it } from 'vitest';
import {
  ATTEMPT_ALLOW_LIST,
  buildInvoiceNo,
  CARD_ROUTES,
  CASH_ROUTES,
  INVOICE_NO_MAX_LENGTH,
  INVOICE_NO_MAX_SEQ,
  INVOICE_NO_PATTERN,
  invoiceStationSegment,
  PaymentRoutingSchema,
  PAYMENT_ATTEMPT_STATUSES,
  PAYMENT_ATTEMPT_TAKEN_STATUSES,
  PAYMENT_ATTEMPT_TERMINAL_STATUSES,
  PAYMENT_METHODS,
  PAYMENT_METHOD_KINDS,
  PAYMENT_PROVIDERS,
  projectAttemptPayload,
  QR_ROUTES,
  TERMINAL_REF_COUNTER_SCOPE,
  WEB_INVOICE_STATION_CODE,
} from '../src/payments';

/**
 * SCRUM-206 (S2-10a) — the tender vocabulary and the gateway invoice number.
 *
 * Everything under test here is a thing that cannot be corrected after the
 * fact: an invoice number 2C2P has already seen is refused for ever, and a
 * status word that is not in the database's CHECK is a payment that cannot be
 * written down at the moment it is taken. The unions themselves are compared
 * against the CHECK text in `packages/db/test/migration-0019.test.ts`, which
 * is where a word added to one copy and not the other fails.
 */

describe('the tender vocabulary', () => {
  it('names each word once', () => {
    for (const list of [
      PAYMENT_METHODS,
      PAYMENT_PROVIDERS,
      PAYMENT_ATTEMPT_STATUSES,
      PAYMENT_METHOD_KINDS,
      CARD_ROUTES,
      QR_ROUTES,
      CASH_ROUTES,
    ]) {
      expect(new Set(list).size, `duplicate in ${list.join('|')}`).toBe(list.length);
    }
  });

  it('is lower snake case throughout, because every word is also a column value', () => {
    for (const word of [...PAYMENT_METHODS, ...PAYMENT_PROVIDERS, ...PAYMENT_ATTEMPT_STATUSES]) {
      // `2c2p` leads with a digit, which is fine in a text column and is the
      // reason the ENV names are `PGW_*` rather than `2C2P_*`.
      expect(word).toMatch(/^[a-z0-9_]+$/);
    }
  });

  it('counts `awaiting_settlement` as money taken but not as money settled', () => {
    // The guest's card was charged on the terminal's own connection. A till
    // that asked for the balance again would take it twice.
    expect(PAYMENT_ATTEMPT_TAKEN_STATUSES).toContain('awaiting_settlement');
    expect(PAYMENT_ATTEMPT_TAKEN_STATUSES).toContain('approved');
    expect(PAYMENT_ATTEMPT_TAKEN_STATUSES).toHaveLength(2);
  });

  it('leaves every unresolved status out of the terminal list, so the pending job can see them', () => {
    const unresolved = PAYMENT_ATTEMPT_STATUSES.filter(
      (s) => !PAYMENT_ATTEMPT_TERMINAL_STATUSES.includes(s),
    );
    expect(unresolved).toEqual([
      'created',
      'sent_to_terminal',
      'unknown',
      'inquiring',
      'awaiting_staff_confirmation',
    ]);
  });

  it('draws both lists from the status union and nowhere else', () => {
    for (const status of [...PAYMENT_ATTEMPT_TAKEN_STATUSES, ...PAYMENT_ATTEMPT_TERMINAL_STATUSES]) {
      expect(PAYMENT_ATTEMPT_STATUSES).toContain(status);
    }
  });
});

describe('PaymentRoutingSchema', () => {
  it('accepts the three keys the Console writes', () => {
    const parsed = PaymentRoutingSchema.parse({ card: 'card_terminal', qr: 'gateway', cash: 'cash_drawer' });
    expect(parsed).toEqual({ card: 'card_terminal', qr: 'gateway', cash: 'cash_drawer' });
  });

  it('refuses a routing value the platform cannot honour', () => {
    // A station routed to a tender nothing implements is money that cannot be
    // taken at a counter, discovered by a guest rather than by a reviewer.
    expect(() => PaymentRoutingSchema.parse({ card: 'contactless' })).toThrow();
    expect(() => PaymentRoutingSchema.parse({ qr: 'promptpay' })).toThrow();
  });

  it('carries through a key it does not know, rather than deleting it', () => {
    // The Console merges rather than replaces when it writes one field. A
    // response schema that dropped `wallet` would silently unconfigure the
    // tender the next ticket adds.
    expect(PaymentRoutingSchema.parse({ card: 'manual', wallet: 'stored_value' })).toEqual({
      card: 'manual',
      wallet: 'stored_value',
    });
  });

  it('treats an absent key as "not configured" rather than as "none"', () => {
    // They are different facts: `none` is a park that has decided not to take
    // QR at this counter, absent is a station nobody has configured yet.
    expect(PaymentRoutingSchema.parse({})).toEqual({});
    expect(PaymentRoutingSchema.parse({ qr: 'none' }).qr).toBe('none');
  });
});

describe('buildInvoiceNo', () => {
  it('builds the shape PAYMENT_GATEWAY.md fixes', () => {
    expect(buildInvoiceNo({ stationCode: 'T1', businessDate: '2026-09-20', seq: 147 })).toBe(
      'T01260920000147',
    );
    expect(
      buildInvoiceNo({ prefix: 'SBX', stationCode: 'T1', businessDate: '2026-09-20', seq: 147 }),
    ).toBe('SBXT01260920000147');
  });

  it('stays inside 20 characters of A-Z0-9 at every extreme', () => {
    const longest = buildInvoiceNo({
      prefix: 'SANDB',
      stationCode: 'T99',
      businessDate: '2099-12-31',
      seq: INVOICE_NO_MAX_SEQ,
    });
    expect(longest).toBe('SANDBT99991231999999');
    expect(longest.length).toBe(INVOICE_NO_MAX_LENGTH);
    expect(longest).toMatch(INVOICE_NO_PATTERN);
  });

  it('is unique across a day boundary at the same sequence', () => {
    // The counter resets with the trading day, so the DATE is what keeps
    // yesterday's number 1 and today's number 1 apart. If it did not, 2C2P
    // would refuse the first sale of every day.
    const yesterday = buildInvoiceNo({ stationCode: 'T1', businessDate: '2026-09-20', seq: 1 });
    const today = buildInvoiceNo({ stationCode: 'T1', businessDate: '2026-09-21', seq: 1 });
    expect(yesterday).not.toBe(today);
  });

  it('is unique across stations on the same day at the same sequence', () => {
    expect(buildInvoiceNo({ stationCode: 'T1', businessDate: '2026-09-20', seq: 9 })).not.toBe(
      buildInvoiceNo({ stationCode: 'T2', businessDate: '2026-09-20', seq: 9 }),
    );
  });

  it('mints 2,000 distinct numbers over a day roll on two stations', () => {
    const minted = new Set<string>();
    for (const businessDate of ['2026-09-20', '2026-09-21']) {
      for (const stationCode of ['T1', 'T2']) {
        for (let seq = 1; seq <= 500; seq += 1) {
          minted.add(buildInvoiceNo({ stationCode, businessDate, seq }));
        }
      }
    }
    expect(minted.size).toBe(2000);
  });

  it('refuses a seventh digit rather than wrapping the sequence', () => {
    // A wrap would reuse a number the gateway has already seen today, and the
    // sale would be refused at the counter with nothing anybody could act on.
    expect(buildInvoiceNo({ stationCode: 'T1', businessDate: '2026-09-20', seq: INVOICE_NO_MAX_SEQ }))
      .toHaveLength(15);
    expect(() =>
      buildInvoiceNo({ stationCode: 'T1', businessDate: '2026-09-20', seq: INVOICE_NO_MAX_SEQ + 1 }),
    ).toThrow(/outside/);
    expect(() => buildInvoiceNo({ stationCode: 'T1', businessDate: '2026-09-20', seq: 0 })).toThrow();
  });

  it('refuses a station code too long to fit, rather than truncating it', () => {
    // Two stations whose codes differ only in the part that was cut off would
    // mint the same number for two different tills.
    expect(() =>
      buildInvoiceNo({ stationCode: 'TILL1', businessDate: '2026-09-20', seq: 1 }),
    ).toThrow(/three characters/);
  });

  it('refuses a prefix over five characters and an unparseable date', () => {
    expect(() =>
      buildInvoiceNo({ prefix: 'SANDBOX', stationCode: 'T1', businessDate: '2026-09-20', seq: 1 }),
    ).toThrow(/five characters/);
    expect(() => buildInvoiceNo({ stationCode: 'T1', businessDate: '20/09/2026', seq: 1 })).toThrow(
      /Unparseable/,
    );
  });

  it('normalises case and strips punctuation the gateway would refuse', () => {
    expect(buildInvoiceNo({ prefix: 'sb-x', stationCode: 't1', businessDate: '2026-09-20', seq: 1 }))
      .toBe('SBXT01260920000001');
  });
});

describe('projectAttemptPayload', () => {
  it('keeps only the allow-listed keys', () => {
    const parsed = {
      tid: '65703235',
      mid: '4648434010',
      approvalCode: '481203',
      last4: '4412',
      amountSatang: 45000,
      status: 'approved',
      invoiceNo: 'T01260920000147',
    };
    expect(projectAttemptPayload(parsed)).toEqual(parsed);
    expect(Object.keys(projectAttemptPayload(parsed)).sort()).toEqual([...ATTEMPT_ALLOW_LIST].sort());
  });

  it('drops a masked PAN and a cardholder name, which is the whole point of it', () => {
    // A GHL `<xml>` response and a Digio `A1` frame both carry these. The
    // projection is an allow-list rather than a deny-list because the next
    // firmware version adds a field nobody here has heard of.
    const kept = projectAttemptPayload({
      approvalCode: '481203',
      cardNo: '4111********1111',
      cardholderName: 'SOMCHAI J',
      track2: '4111111111111111=2512',
      pan: '4111111111111111',
      voidPassword: 'not-the-real-one',
      unheardOfNewField: 'whatever the next firmware adds',
    });
    expect(kept).toEqual({ approvalCode: '481203' });
  });

  it('drops null and undefined rather than storing them', () => {
    expect(projectAttemptPayload({ tid: null, mid: undefined, last4: '4412' })).toEqual({
      last4: '4412',
    });
  });
});

describe('the terminal reference counter', () => {
  it('names the box_counter scope, so C1 and the schema agree on one word', () => {
    // D-1: no `terminal_counter` table. `edge.box_counter`'s primary key is
    // (box_id, scope, counter_key, business_date), which IS "unique per
    // terminal per day" once counter_key is the device id.
    expect(TERMINAL_REF_COUNTER_SCOPE).toBe('terminal_ref');
  });
});

describe('invoiceStationSegment (S2-12)', () => {
  it('is the three characters a station takes in an invoice number', () => {
    expect(invoiceStationSegment('T1')).toBe('T01');
    expect(invoiceStationSegment('T01')).toBe('T01');
    expect(invoiceStationSegment('B7')).toBe('B07');
    expect(invoiceStationSegment('7')).toBe('007');
    // A code that cannot number an invoice at all.
    expect(invoiceStationSegment('TILL1')).toBeNull();
    expect(invoiceStationSegment('')).toBeNull();
  });

  it("only WEB itself takes the booking site's segment", () => {
    expect(WEB_INVOICE_STATION_CODE).toBe('WEB');
    expect(invoiceStationSegment('WEB')).toBe(WEB_INVOICE_STATION_CODE);
    expect(invoiceStationSegment('web')).toBe(WEB_INVOICE_STATION_CODE);
    for (const code of ['W', 'WE', 'W1', 'WE1', 'EB', 'B']) {
      expect(invoiceStationSegment(code), code).not.toBe(WEB_INVOICE_STATION_CODE);
    }
    // And a booking's invoice and a till's never share a stem.
    const web = buildInvoiceNo({ stationCode: WEB_INVOICE_STATION_CODE, businessDate: '2026-09-30', seq: 1 });
    const till = buildInvoiceNo({ stationCode: 'T1', businessDate: '2026-09-30', seq: 1 });
    expect(web.slice(0, -6)).not.toBe(till.slice(0, -6));
  });
});
