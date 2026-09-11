import { Info } from 'lucide-react';
import { DiscountCodesSection } from './DiscountCodesSection';
import { DiscountReasonsSection } from './DiscountReasonsSection';
import { PaymentMethodsSection } from '../payments/PaymentMethodsSection';

export function DiscountsScreen() {
  return (
    <div className="flex flex-col gap-6">
      <p className="flex items-center gap-2 rounded-xl border border-foreground/10 bg-foreground/[0.02] px-3 py-2 text-xs text-foreground/40">
        <Info className="w-3.5 h-3.5 shrink-0" />
        Changes save to the live in-memory store and appear instantly in the POS.
        A full page reload resets everything to the seeded data.
      </p>

      <DiscountCodesSection />
      <DiscountReasonsSection />
      <PaymentMethodsSection />
    </div>
  );
}
