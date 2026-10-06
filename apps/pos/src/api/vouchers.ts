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
 * A voucher on a sale already rung up is let go only by voiding that sale, so
 * that call lives with the sales calls (`salesApi.voidSale` in api/sales.ts).
 * Four paths void one: the till's Cancel, which voids any rung-up sale that
 * took no money; a corrected order after Pay, which voids without asking the
 * sale THIS screen rang up (`moveTo` in lib/tillVoucher.ts, reason
 * `ORDER_CHANGED_AFTER_PAY`); the offer on a refusal that names an unpaid sale
 * left at this till (`voidRungUp` in lib/tillVoucher.ts); and History's Void.
 *
 * Every call acts at the till the SESSION stands at (`PUT /me/session/station`),
 * never at a station the request names.
 */

/**
 * What a `HELD_ELSEWHERE` refusal carries (`heldElsewhere` in
 * apps/api/src/services/vouchers.ts): where the voucher is, whether the cart
 * holding it has been rung up, and — only to a session standing at that same
 * till — which sale it is on (`saleId`), so the till can offer to void it.
 */
export interface HeldElsewhereDetails {
  stationId?: string;
  stationName?: string | null;
  rungUp?: boolean;
  /** Set only for a rung-up sale, and only when the asking session stands at its till. */
  saleId?: string | null;
}

/**
 * S2-14a round 5 — what a discount voucher comes off, as the platform resolved
 * it at this branch: `tickets` (every booth voucher), or a category or an item
 * a promotion was aimed at. `label` is the platform's name for it.
 */
export interface VoucherScope {
  appliesTo: 'tickets' | 'ticket_package' | 'fnb' | 'category' | 'items' | 'merch';
  target?: unknown;
  label?: string;
}

/** What a voucher is worth, as the platform resolved it at this branch. */
export type VoucherEffect =
  | ({ type: 'amount_off'; valueSatang: number } & VoucherScope)
  | ({ type: 'percent_off'; valueBp: number } & VoucherScope)
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
  | { type: 'hand_over' }
  /** S2-14a round 5 — loads this much credit onto a new wallet when its ฿0 sale closes. */
  | { type: 'wallet_credit'; valueSatang: number };

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

// --- S2-14a round 5: promotional vouchers -------------------------------------------

/** A print the platform queued for a voucher: queued, skipped (no printer here) or none (no box). */
export interface VoucherPrintAnswer {
  jobId: string | null;
  status: 'queued' | 'skipped' | 'none';
  note: string | null;
}

/** A definition this till may issue today (`GET /vouchers/issuable`). */
export interface IssuableDefinition {
  id: string;
  code: string;
  nameEn: string;
  nameTh: string | null;
  kind: string;
  valueSatang: number | null;
  valueBp: number | null;
  validFrom: string | null;
  validUntil: string | null;
  usageLimit: number | null;
  redeemed: number;
}

export interface IssuedVoucher {
  voucher: {
    id: string;
    code: string;
    definitionId: string;
    nameEn: string;
    kind: string;
    issuedAt: string;
    expiresAt: string | null;
    validFrom: string | null;
    validUntil: string | null;
  };
  print: VoucherPrintAnswer;
}

/** The wallet a wallet-credit voucher loaded (`GET /vouchers/:id/credit`); null until its sale closes. */
export interface VoucherCredit {
  voucherId: string;
  wallet: { id: string; balanceSatang: number; holderName: string | null; expiresAt?: string | null } | null;
  qrCode: string | null;
}

export const vouchersApi = {
  issuable: () => api.get<{ definitions: IssuableDefinition[] }>('/vouchers/issuable'),
  /** One key per press: a retried press is the same voucher, never a second. */
  issue: (definitionId: string, memberId: string | null, idempotencyKey: string = idemKey()) =>
    api.post<IssuedVoucher>('/vouchers/issue', { definitionId, ...(memberId ? { memberId } : {}) }, { idempotencyKey }),
  credit: (voucherId: string) => api.get<VoucherCredit>(`/vouchers/${encodeURIComponent(voucherId)}/credit`),
  printCredit: (voucherId: string) =>
    api.post<{ walletId: string; print: VoucherPrintAnswer }>(
      `/vouchers/${encodeURIComponent(voucherId)}/credit/print`,
      {},
      { idempotencyKey: idemKey() },
    ),
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
