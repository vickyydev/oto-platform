/**
 * THE REASONS THE TILL VOIDS A SALE IT RANG UP THAT TOOK NO MONEY — in one
 * place, because two libraries speak them and neither should import the
 * other for a string: the sale writer (`lib/saleWriter.ts`), which voids the
 * sale a corrected order leaves behind (SCRUM-865) and the one the till's
 * Cancel throws away, and the voucher hold (`lib/tillVoucher.ts`), which
 * voids the abandoned sale when the voucher has to follow the corrected
 * cart. Each is what the voids report shows beside the sale.
 */

/**
 * The reason the till's Cancel voids a sale it rang up that took no money —
 * any such sale, voucher or not: the owner's rule for Cancel, so a sale nobody
 * will pay is never left `tendering` behind a screen that has moved on.
 */
export const CANCELLED_AT_THE_TILL = 'Cancelled at the till';

/**
 * The reason the sale rung up at Pay is voided when staff change the order
 * and pay again: the corrected cart is a new sale, and the first one — rung
 * up, unpaid, holding the voucher and the document check — is let go before
 * it. Only a sale this screen rang up is voided that way (`ownsSale`).
 */
export const ORDER_CHANGED_AFTER_PAY = 'Order changed at the till after Pay';
