import { describe, expect, it } from 'vitest';
import { WALLET_SPENT_FACT } from '@oto/shared';
import { describeRegressedPaidFact } from '../src/services/sync-epoch-regressed';
import type { Exec } from '../src/services/tx';

/**
 * SCRUM-486 — what a paid fact set aside for its epoch says on Failures. The
 * sale with a catalogue product is proved against the database in
 * `box-epoch-regressed-sale.test.ts`; these are the shapes that need none.
 */

/**
 * A ledger that answers each query, in order, with the rows given — and with
 * nothing once they run out. None of these carts names a product by id, so the
 * only questions asked are the ledger's (is the sale there, are its tenders),
 * and an empty ledger is one that holds neither.
 */
function ledger(...answers: unknown[][]): Exec {
  const next = (): Promise<unknown[]> => Promise.resolve(answers.shift() ?? []);
  const chain: Record<string, unknown> = {};
  for (const step of ['select', 'from', 'where', 'limit']) chain[step] = () => chain;
  chain.then = (resolve: (rows: unknown[]) => unknown, reject: (err: unknown) => unknown) => next().then(resolve, reject);
  return chain as unknown as Exec;
}
const noDb = ledger();

const SALE = '018f0000-0000-7000-8000-0000005a1e86';
const OPERATOR = '018f0000-0000-7000-8000-0000000000b1';

const envelope = (payload: unknown) => ({ eventId: 'e', journalEpoch: 1, boxSeq: 1, payload });

describe('describeRegressedPaidFact', () => {
  it('a ticket sale with sized add-ons and socks names every unit and the money', async () => {
    const note = await describeRegressedPaidFact(noDb, OPERATOR, 'sale.finalised', envelope({
      saleId: SALE,
      receipt: { series: 'T1', seq: 42, number: 'T1-000042' },
      cart: {
        socks: { addOnId: 'a-socks', label: 'Grip Socks' },
        lines: [
          {
            id: 'l1',
            packageId: 'p1',
            kids: 2,
            adults: 1,
            socks: 2,
            addOns: [
              { id: 'a-tee', name: 'Oto Tee', quantity: 2, variantBreakdown: [
                { variantId: 's', variantLabel: 'S', quantity: 1 },
                { variantId: 'm', variantLabel: 'M', quantity: 1 },
              ] },
              { id: 'a-juice', name: 'Juice', quantity: 1 },
            ],
          },
        ],
        expectedTotalSatang: 150_000,
      },
      tenders: [
        { actionId: 'a', methodCode: 'cash', amountSatang: 100_000 },
        { actionId: 'b', methodCode: 'card', amountSatang: 50_000 },
      ],
    }));
    expect(note).not.toBeNull();
    expect(note!.detail).toMatchObject({ type: 'sale.finalised', saleId: SALE, receiptNumber: 'T1-000042', takenSatang: 150_000 });
    expect(note!.detail.units).toEqual([
      { item: 'Oto Tee', addOnId: 'a-tee', quantity: 1, variantLabel: 'S' },
      { item: 'Oto Tee', addOnId: 'a-tee', quantity: 1, variantLabel: 'M' },
      { item: 'Juice', addOnId: 'a-juice', quantity: 1 },
      { item: 'Grip Socks', quantity: 2 },
    ]);
    expect(note!.message).toContain(`PAID SALE set aside: sale ${SALE} (receipt T1-000042)`);
    expect(note!.message).toContain('Oto Tee (S) × 1, Oto Tee (M) × 1, Juice × 1, Grip Socks × 2');
    expect(note!.message).toContain('cash');
    expect(note!.message).toContain('card');
  });

  it('a later tender and a wallet spend name the money, and that the goods may be off the shelf too', async () => {
    const tender = await describeRegressedPaidFact(noDb, OPERATOR, 'payment.recorded', envelope({
      saleId: SALE,
      tender: { actionId: 'a', methodCode: 'promptpay', amountSatang: 12_000 },
    }));
    expect(tender!.detail).toMatchObject({ type: 'payment.recorded', takenSatang: 12_000, units: [] });
    expect(tender!.message).toContain('PAID TENDER set aside');
    expect(tender!.message).toContain('if it was the tender that closed the sale');

    const spend = await describeRegressedPaidFact(noDb, OPERATOR, WALLET_SPENT_FACT, envelope({
      saleId: SALE,
      amountSatang: 8_000,
    }));
    expect(spend!.detail).toMatchObject({ takenSatang: 8_000, tenders: [{ methodCode: 'wallet', amountSatang: 8_000 }] });
    expect(spend!.message).toContain('WALLET SPEND set aside');
  });

  it('a fact that carries no sale gets no note, and an odd payload does not stop the row being filed', async () => {
    expect(await describeRegressedPaidFact(noDb, OPERATOR, 'member.created', envelope({ memberId: 'm' }))).toBeNull();
    expect(await describeRegressedPaidFact(noDb, OPERATOR, null, {})).toBeNull();
    expect(await describeRegressedPaidFact(noDb, OPERATOR, 'sale.finalised', envelope('garbled'))).toBeNull();
    const odd = await describeRegressedPaidFact(noDb, OPERATOR, 'sale.finalised', envelope({
      saleId: SALE,
      cart: { lines: 'nope', items: [{ productId: 7 }] },
      tenders: [{ amountSatang: -5 }],
    }));
    expect(odd!.detail).toMatchObject({ takenSatang: 0, tenders: [], units: [] });
    expect(odd!.message).toContain('no money taken');
  });

  it('a fact the ledger already holds says so, and is not money to record by hand', async () => {
    const sold = {
      saleId: SALE,
      cart: { items: [] },
      tenders: [
        { actionId: 'a', methodCode: 'cash', amountSatang: 100_000 },
        { actionId: 'b', methodCode: 'card', amountSatang: 50_000 },
      ],
    };
    const held = await describeRegressedPaidFact(
      ledger([{ status: 'finalised' }], [{ actionId: 'a' }, { actionId: 'b' }]),
      OPERATOR,
      'sale.finalised',
      envelope(sold),
    );
    expect(held!.detail).toMatchObject({ inLedger: true, takenSatang: 150_000 });
    expect(held!.message).toContain('Already in the ledger');
    expect(held!.message).not.toContain('NOT in the ledger');
    expect(held!.message).not.toContain('record it by hand');

    // One tender missing, or the sale still open: money that is not all there is still reported as missing.
    const partly = await describeRegressedPaidFact(
      ledger([{ status: 'finalised' }], [{ actionId: 'a' }]),
      OPERATOR,
      'sale.finalised',
      envelope(sold),
    );
    expect(partly!.detail.inLedger).toBe(false);
    expect(partly!.message).toContain('NOT in the ledger');
    const open = await describeRegressedPaidFact(ledger([{ status: 'tendering' }]), OPERATOR, 'sale.finalised', envelope(sold));
    expect(open!.detail.inLedger).toBe(false);

    const tender = await describeRegressedPaidFact(ledger([{ actionId: 'a' }]), OPERATOR, 'payment.recorded', envelope({
      saleId: SALE,
      tender: { actionId: 'a', methodCode: 'promptpay', amountSatang: 12_000 },
    }));
    expect(tender!.detail.inLedger).toBe(true);
    const spend = await describeRegressedPaidFact(ledger([{ actionId: 'w' }]), OPERATOR, WALLET_SPENT_FACT, envelope({
      saleId: SALE,
      actionId: 'w',
      amountSatang: 8_000,
    }));
    expect(spend!.detail.inLedger).toBe(true);
    // A spend with no press cannot be found, so it is never claimed to be there.
    const unnamed = await describeRegressedPaidFact(ledger([{ actionId: 'w' }]), OPERATOR, WALLET_SPENT_FACT, envelope({
      saleId: SALE,
      amountSatang: 8_000,
    }));
    expect(unnamed!.detail.inLedger).toBe(false);
  });
});
