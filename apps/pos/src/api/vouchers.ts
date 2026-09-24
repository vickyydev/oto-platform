import { api, idemKey } from './client';

/**
 * S2-10b (SCRUM-207) — A LUCKY WHEEL VOUCHER AT THE TILL, from the till's side.
 *
 * Three calls, and none of them decides anything about the voucher: whether it
 * exists, what it is worth here, whether it has been used and who holds it are
 * the platform's answers (`apps/api/src/services/vouchers.ts`). The till shows
 * them — refusals included, in the platform's own words — and puts the code on
 * the cart it rings up, where the platform prices it.
 *
 *   lookup   what is this code? Consumes nothing; a wrong code counts against
 *            this till's guessing limit.
 *   hold     keep it for the cart this till is ringing up, by the sale id the
 *            till minted for that cart (usually before any sale row exists).
 *   release  take it off a cart that has not been rung up.
 *
 * A voucher on a sale already rung up is let go only by voiding that sale —
 * the till's Cancel, which voids any rung-up sale that took no money, so it
 * lives with the sales calls (`salesApi.voidSale` in api/sales.ts).
 *
 * Every call acts at the till the SESSION stands at (`PUT /me/session/station`),
 * never at a station the request names.
 */

/** What a voucher is worth, as the platform resolved it at this branch. */
export type VoucherEffect =
  | { type: 'amount_off'; appliesTo: 'tickets'; valueSatang: number }
  | { type: 'percent_off'; appliesTo: 'tickets'; valueBp: number }
  | {
      type: 'free_item';
      product: {
        id: string;
        name: string;
        /**
         * Which counter sells it: `menu` is the kitchen's and the bar's (the F&B
         * tills), `merch` the shop's, `addon` a ticket extra. The ticket till
         * reads it to send a menu item to the restaurant till.
         */
        kind: 'menu' | 'merch' | 'addon';
        priceSatang: number;
        weekendPriceSatang: number;
      };
    }
  | { type: 'free_kids_ticket'; package: { id: string; name: string } }
  | { type: 'hand_over' };

/** A voucher as every answer about one shows it (`VoucherView` in the api). */
export interface VoucherView {
  id: string;
  code: string;
  source: string;
  /** `available` — nobody has it on a cart; `held_here` — this till has it. */
  state: 'available' | 'held_here';
  prize: { nameEn: string; nameTh: string | null };
  definitionCode: string;
  kind: string;
  effect: VoucherEffect;
  /** What to hand over or take off, in the platform's words. */
  summary: string;
  issuedAt: string;
  issuedBooth: { stationId: string; name: string; codePrefix: string | null } | null;
  issuedBranch: { id: string; name: string };
  expiresAt: string | null;
  legacyFormat: boolean;
  hold: { saleId: string; stationId: string; stationName: string; heldAt: string } | null;
  redeemableOffline: boolean;
  /**
   * Who was signed in at the booth when it printed — the slip's Staff line:
   * the name it prints (null for an account with no employee) and the staff
   * code beside it. Null when the spin was unattributed.
   */
  issuedBy: { name: string | null; code: string } | null;
}

export interface VoucherHoldAnswer {
  voucher: VoucherView;
  saleId: string;
  /** True when this cart already held it and nothing was written. */
  alreadyHeld: boolean;
}

export interface VoucherReleaseAnswer {
  released: boolean;
  voucherId: string;
  saleId: string;
}

export const vouchersApi = {
  lookup: (code: string) =>
    api.get<{ voucher: VoucherView }>(`/vouchers/lookup?code=${encodeURIComponent(code)}`),
  /**
   * A fresh idempotency key per press: the hold is idempotent on its own (the
   * same cart holding it again changes nothing), and a key kept across presses
   * would replay a refusal after whatever caused it has cleared.
   */
  hold: (saleId: string, code: string) =>
    api.post<VoucherHoldAnswer>(
      `/sales/${encodeURIComponent(saleId)}/vouchers`,
      { code },
      { idempotencyKey: idemKey() },
    ),
  release: (saleId: string, voucherId: string) =>
    api.delete<VoucherReleaseAnswer>(
      `/sales/${encodeURIComponent(saleId)}/vouchers/${encodeURIComponent(voucherId)}`,
    ),
};
