import { useLanguage } from '@/i18n/LanguageContext';
import { bahtText } from '@/lib/bahtText';

/**
 * SCRUM-960 — THE CODE'S DISCOUNT ON THE GUEST'S SCREEN. With a promo code on
 * the order the lines read their shelf prices and the total the price after
 * the code, and nothing between them said why (picture 15d: French fries 175,
 * total 157.50). The prototype's customer displays show every discount as a
 * row above the tax, and its ticket display shows a code's as "Discount code
 * −฿X" (`components/till/CustomerDisplay.tsx`): this is that row, from the
 * platform's quote of the codes on the order (baht). Absent or 0, no row.
 */
export function CodeDiscountRow({ amount }: { amount?: number }) {
  const { t } = useLanguage();
  if (!amount || amount <= 0) return null;
  return (
    <div className="flex items-center justify-between mb-2 text-(--cd-success)">
      <span className="text-lg">{t('till.order.discountCode')}</span>
      <span className="text-lg font-bold tabular-nums">−฿{bahtText(amount)}</span>
    </div>
  );
}
