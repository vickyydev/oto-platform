import type { ApiWalletGrant } from '@/api/wallet';
import type { CreditGrant, Sale } from '@/types';

/**
 * SCRUM-883 — WHAT THE FAMILY AND STAFF ARE SHOWN OF A SALE'S CREDIT IS WHAT
 * THE PLATFORM GRANTED.
 *
 * The platform's ledger is the system of record for money: it grants a sale's
 * F&B credit as it closes it, one wallet per person who earns, each with the
 * ONE voucher QR its receipt prints (`grantSaleCredit`), and answers with
 * those grants on the sale read. Found on staging on 12 November 2026: the
 * customer's thank-you screen showed the till's own list ("Credit ฿350", with
 * a QR seeded from the till's grant id) for a sale the platform granted
 * nothing, while the staff half, which follows the platform, showed none.
 *
 * So a finished sale's credit rows are the platform's grants once it has
 * answered — their amounts and their real QR — and the till's own items to
 * collect (socks, add-ons, a free-item promo) beside them, unchanged. Before
 * it answers there is no credit row at all, as the staff half shows none. A
 * sale closed on the box, which the platform has not seen yet, keeps the
 * till's own list — read from the same grant law (`buildPersonGrants`), so it
 * is what the platform will grant when the sale lands — with no QR, because
 * no wallet exists to scan yet.
 */

const PLATFORM_SALE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The platform's grants as the thank-you rows draw them, in the platform's person order. */
export function creditGrantsOfPlatform(grants: readonly ApiWalletGrant[]): CreditGrant[] {
  return [...grants]
    .filter((grant) => grant.creditSatang > 0)
    .sort((a, b) => a.personIndex - b.personIndex)
    .map((grant) => ({
      id: grant.walletId,
      type: 'fnb_credit',
      label: 'Credit',
      valueTHB: grant.creditSatang / 100,
      role: grant.role,
      gateAccess: grant.gateAccess,
      ...(grant.qrCode ? { qrCode: grant.qrCode } : {}),
    }));
}

/**
 * The sale with its credit rows as the platform granted them.
 *
 * `platform` is the sale read's grants, null until it answers (or where it
 * cannot: offline). `closedOnBox` says the sale was closed on the box lane, so
 * no answer is coming yet. A sale whose id the platform never issued (a
 * seeded or local record) has no answer to wait for and is left as it is.
 */
export function withPlatformCredit(
  sale: Sale,
  platform: readonly ApiWalletGrant[] | null,
  closedOnBox: boolean,
): Sale {
  const items = sale.creditGrants.filter((grant) => grant.type !== 'fnb_credit');
  if (platform) return { ...sale, creditGrants: [...creditGrantsOfPlatform(platform), ...items] };
  if (closedOnBox || !PLATFORM_SALE_ID.test(sale.id)) return sale;
  return items.length === sale.creditGrants.length ? sale : { ...sale, creditGrants: items };
}
