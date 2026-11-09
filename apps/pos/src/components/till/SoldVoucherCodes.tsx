import { useEffect, useState } from 'react';
import { Gift } from 'lucide-react';
import { getSale, type ApiIssuedVoucher } from '@/api/history';
import { formatVoucherStamp } from '@/lib/tillVoucher';

/**
 * SCRUM-798 — THE GIFT VOUCHERS A SALE SOLD, on its confirmation: each code in
 * full, to read out or write down for the family, beside the receipt that
 * prints it. The platform minted them when the sale closed; this only shows
 * its answer, and nothing when the sale sold none.
 */
export function SoldVoucherCodes({ vouchers }: { vouchers: readonly ApiIssuedVoucher[] | null }) {
  if (!vouchers || vouchers.length === 0) return null;
  return (
    <div
      className="inline-flex flex-col items-center gap-1 rounded-lg bg-emerald-500/10 px-4 py-2 text-sm text-emerald-500"
      data-testid="sold-voucher-codes"
    >
      {vouchers.map((v) => (
        <div key={v.id} className="flex flex-wrap items-center justify-center gap-x-2">
          <Gift className="w-4 h-4 shrink-0" />
          <span className="font-semibold">{v.nameEn}</span>
          <span className="font-mono font-bold tracking-wide">{v.code}</span>
          {v.expiresAt && (
            <span className="text-xs text-emerald-500/70">valid until {formatVoucherStamp(v.expiresAt)}</span>
          )}
        </div>
      ))}
      <div className="text-xs text-emerald-500/70">
        {vouchers.length === 1 ? 'Give this code to the family' : 'Give these codes to the family'} — it is
        on the receipt, and redeemed at the ticket till.
      </div>
    </div>
  );
}

/** The same, read from the platform for a sale this screen holds by id only. */
export function SoldVoucherCodesOf({ saleId }: { saleId: string | null }) {
  const [vouchers, setVouchers] = useState<ApiIssuedVoucher[] | null>(null);
  useEffect(() => {
    if (!saleId) return;
    let live = true;
    void getSale(saleId)
      .then((detail) => {
        if (live) setVouchers(detail.issuedVouchers ?? []);
      })
      .catch(() => {
        // The receipt carries the codes; a read that fails shows nothing rather than a guess.
      });
    return () => {
      live = false;
    };
  }, [saleId]);
  return <SoldVoucherCodes vouchers={vouchers} />;
}
