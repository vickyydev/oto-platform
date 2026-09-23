import { describe, expect, it } from 'vitest';
import { emvcoCrcIsValid } from '../src/emvco';
import { SimulatorQrPayment } from '../src/simulator';

const MINT = {
  attemptId: '01a0cdcc-0000-7000-8000-000000000001',
  invoiceNo: 'T01260923000001',
  amountSatang: 144000,
  description: 'OTO Park admission',
  expiryMinutes: 20,
};

function at(iso: string): { now: () => Date } {
  return { now: () => new Date(iso) };
}

describe('the simulator answers in the gateway\'s shapes', () => {
  it('mints a 1005-style pending answer with a scannable payload and a timer', async () => {
    const sim = new SimulatorQrPayment(at('2026-09-23T03:00:00.000Z'));
    const qr = await sim.createQr(MINT);
    expect(qr.state).toBe('qr_shown');
    expect(qr.respCode).toBe('1005');
    expect(qr.expiryTimerMs).toBe(1_200_000);
    expect(qr.expiresAt.toISOString()).toBe('2026-09-23T03:20:00.000Z');
    expect(qr.qrPayload).not.toBeNull();
    expect(emvcoCrcIsValid(qr.qrPayload!)).toBe(true);
    expect(qr.providerRef).toMatch(/^SIM[0-9A-F]+$/);
  });

  it('answers 2002 for an invoice it has never seen', async () => {
    const sim = new SimulatorQrPayment();
    const facts = await sim.inquire({ invoiceNo: 'NOPE' });
    expect(facts.state).toBe('not_found');
    expect(facts.respCode).toBe('2002');
    expect(facts.amountSatang).toBeNull();
  });

  it('keeps saying pending until something happens to it', async () => {
    const sim = new SimulatorQrPayment(at('2026-09-23T03:00:00.000Z'));
    await sim.createQr(MINT);
    const facts = await sim.inquire({ invoiceNo: MINT.invoiceNo });
    expect(facts.state).toBe('qr_shown');
    expect(facts.amountSatang).toBe(144000);
    expect(facts.currencyCode).toBe('THB');
    expect(facts.channelCode).toBe('PPQR');
  });
});

describe('the five controls', () => {
  it('"customer paid" makes the inquiry agree', async () => {
    const sim = new SimulatorQrPayment(at('2026-09-23T03:00:00.000Z'));
    await sim.createQr(MINT);
    const facts = sim.apply(MINT.invoiceNo, 'paid');
    expect(facts?.state).toBe('paid');
    expect(facts?.respCode).toBe('0000');
    expect(facts?.transactionDateTime).toBe('20260923030000');
    expect((await sim.inquire({ invoiceNo: MINT.invoiceNo })).state).toBe('paid');
  });

  /**
   * THE PLANT'S MATERIAL. A payment one satang short is `5016`-shaped — the
   * amount does not match — and the caller must refuse it rather than settle.
   */
  it('can pay an amount that is not the amount asked for', async () => {
    const sim = new SimulatorQrPayment(at('2026-09-23T03:00:00.000Z'));
    await sim.createQr(MINT);
    const facts = sim.apply(MINT.invoiceNo, 'paid', { amountSatang: 143999 });
    expect(facts?.amountSatang).toBe(143999);
    expect(facts?.raw.amount).toBe('1439.99000');
  });

  it('"decline" and "expire" are different words with different codes', async () => {
    const sim = new SimulatorQrPayment(at('2026-09-23T03:00:00.000Z'));
    await sim.createQr(MINT);
    expect(sim.apply(MINT.invoiceNo, 'decline')?.respCode).toBe('0003');

    const other = new SimulatorQrPayment(at('2026-09-23T03:00:00.000Z'));
    await other.createQr(MINT);
    expect(other.apply(MINT.invoiceNo, 'expire')?.respCode).toBe('9020');
  });

  it('"late payment" is 5017, the guest who scanned on the way out', async () => {
    const sim = new SimulatorQrPayment(at('2026-09-23T03:00:00.000Z'));
    await sim.createQr(MINT);
    const facts = sim.apply(MINT.invoiceNo, 'late_paid');
    expect(facts?.state).toBe('late_paid');
    expect(facts?.respCode).toBe('5017');
  });

  /**
   * "Suppress webhook" is the absence of a notification, not the absence of a
   * payment: the record says paid and the only thing that can find out is the
   * inquiry poller. That is the whole acceptance for the safety net.
   */
  it('"suppress webhook" marks it paid and leaves the inquiry to discover it', async () => {
    const sim = new SimulatorQrPayment(at('2026-09-23T03:00:00.000Z'));
    await sim.createQr(MINT);
    sim.apply(MINT.invoiceNo, 'suppress_webhook');
    expect((await sim.inquire({ invoiceNo: MINT.invoiceNo })).state).toBe('paid');
  });

  it('answers nothing for an invoice it has forgotten', async () => {
    const sim = new SimulatorQrPayment();
    expect(sim.apply('GONE', 'paid')).toBeNull();
    expect(sim.knows('GONE')).toBe(false);
  });
});

describe('the clock expires a QR nobody pressed a button about', () => {
  it('turns qr_shown into expired once expiresAt has passed', async () => {
    let clock = new Date('2026-09-23T03:00:00.000Z');
    const sim = new SimulatorQrPayment({ now: () => clock });
    await sim.createQr(MINT);
    clock = new Date('2026-09-23T03:19:59.000Z');
    expect((await sim.inquire({ invoiceNo: MINT.invoiceNo })).state).toBe('qr_shown');
    clock = new Date('2026-09-23T03:20:01.000Z');
    const facts = await sim.inquire({ invoiceNo: MINT.invoiceNo });
    expect(facts.state).toBe('expired');
    expect(facts.respCode).toBe('9020');
  });

  it('does not expire one that was already paid', async () => {
    let clock = new Date('2026-09-23T03:00:00.000Z');
    const sim = new SimulatorQrPayment({ now: () => clock });
    await sim.createQr(MINT);
    sim.apply(MINT.invoiceNo, 'paid');
    clock = new Date('2026-09-23T04:00:00.000Z');
    expect((await sim.inquire({ invoiceNo: MINT.invoiceNo })).state).toBe('paid');
  });
});

describe('maintenance V and R are honoured, with their windows', () => {
  it('voids before settlement and refuses after it', async () => {
    const sim = new SimulatorQrPayment(at('2026-09-23T03:00:00.000Z'));
    await sim.createQr(MINT);
    sim.apply(MINT.invoiceNo, 'paid');

    const voided = await sim.refund({
      invoiceNo: MINT.invoiceNo,
      amountSatang: 144000,
      processType: 'V',
    });
    expect(voided.respCode).toBe('00');
    expect(voided.state).toBe('cancelled');

    const again = new SimulatorQrPayment(at('2026-09-23T03:00:00.000Z'));
    await again.createQr(MINT);
    again.apply(MINT.invoiceNo, 'paid');
    again.markSettled(MINT.invoiceNo);
    const late = await again.refund({
      invoiceNo: MINT.invoiceNo,
      amountSatang: 144000,
      processType: 'V',
    });
    expect(late.respCode).not.toBe('00');
    expect(late.respDesc).toContain('Already settled');
  });

  it('refunds only after settlement', async () => {
    const sim = new SimulatorQrPayment(at('2026-09-23T03:00:00.000Z'));
    await sim.createQr(MINT);
    sim.apply(MINT.invoiceNo, 'paid');
    expect(
      (await sim.refund({ invoiceNo: MINT.invoiceNo, amountSatang: 144000, processType: 'R' }))
        .respCode,
    ).not.toBe('00');

    sim.markSettled(MINT.invoiceNo);
    const refunded = await sim.refund({
      invoiceNo: MINT.invoiceNo,
      amountSatang: 144000,
      processType: 'R',
    });
    expect(refunded.respCode).toBe('00');
    expect(refunded.state).toBe('refunded');
    expect(refunded.providerRefundRef).toMatch(/^SIMRF/);
  });

  it('refuses more than was paid, and anything unpaid', async () => {
    const sim = new SimulatorQrPayment(at('2026-09-23T03:00:00.000Z'));
    await sim.createQr(MINT);
    expect(
      (await sim.refund({ invoiceNo: MINT.invoiceNo, amountSatang: 100, processType: 'V' }))
        .respCode,
    ).toBe('2002');
    sim.apply(MINT.invoiceNo, 'paid');
    expect(
      (await sim.refund({ invoiceNo: MINT.invoiceNo, amountSatang: 144001, processType: 'V' }))
        .respCode,
    ).toBe('4122');
  });

  it('will not cancel a payment that has been made', async () => {
    const sim = new SimulatorQrPayment(at('2026-09-23T03:00:00.000Z'));
    await sim.createQr(MINT);
    sim.apply(MINT.invoiceNo, 'paid');
    expect(await sim.cancel({ invoiceNo: MINT.invoiceNo })).toEqual({
      ok: false,
      reason: 'failed',
      detail: 'already paid',
    });
  });
});
