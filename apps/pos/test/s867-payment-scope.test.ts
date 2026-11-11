import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { cartBodyIdentity } from '@/lib/paymentScope';

/**
 * SCRUM-867 — THE PAYMENT SCOPE IS THE ORDER, NOT WHO IT IS FOR.
 *
 * A walk-in whose rate was verified on this sale becomes a member a moment
 * after the payment screen opens (the deferred profile save, SCRUM-779). The
 * scope used to carry the member, so that save reset the payment stage a
 * second after it opened: the method tapped and the cash typed vanished, and
 * a sale saved while the screen "moved on" was announced as the previous
 * visitor's. The scope now mirrors the sale writer's `bodySignatureOf`: the
 * member, the phone and the nickname are left out.
 */
const here = dirname(fileURLToPath(import.meta.url));
const source = (path: string) => readFileSync(join(here, '..', 'src', path), 'utf8');

describe('the payment scope is the cart body', () => {
  it('leaves out who the cart is for and keeps everything that prices it', () => {
    expect(
      cartBodyIdentity({
        branchId: 'branch-1',
        stationId: 'station-1',
        tier: 'thai',
        tierClaimActionId: 'claim-1',
        memberId: 'member-1',
        customerPhone: '+66812345678',
        customerNickname: 'Mali',
        accountId: 'account-1',
        accountName: 'Som',
      }),
    ).toEqual({
      branchId: 'branch-1',
      stationId: 'station-1',
      tier: 'thai',
      tierClaimActionId: 'claim-1',
      accountId: 'account-1',
      accountName: 'Som',
    });
  });

  it('is the same scope before and after a member joins the sale', () => {
    const walkIn = { branchId: 'b', stationId: 's', tier: 'thai', memberId: null, customerPhone: '+66812345678', customerNickname: null, accountId: 'a', accountName: 'Som' };
    const joined = { ...walkIn, memberId: 'member-1', customerNickname: 'Mali' };
    expect(JSON.stringify(cartBodyIdentity(walkIn))).toBe(JSON.stringify(cartBodyIdentity(joined)));
  });

  it('answers null for a till with no platform identity', () => {
    expect(cartBodyIdentity(null)).toBeNull();
  });

  it('is what both tills build their payment scope from', () => {
    expect(source('pages/Till.tsx')).toContain(
      'const paymentScope = JSON.stringify([paymentEpoch, cartBodyIdentity(cartIdentity), lines, discounts, manualDiscounts, voucherCodes]);',
    );
    expect(source('components/mobile/MobileTill.tsx')).toContain(
      'const paymentScope = JSON.stringify([paymentEpoch, cartBodyIdentity(cartIdentity), lines, discounts, manualDiscounts]);',
    );
  });
});
