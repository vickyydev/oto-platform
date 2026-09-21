import { DiscountCodesSection } from './DiscountCodesSection';
import { DiscountReasonsSection } from './DiscountReasonsSection';
import { PaymentMethodsSection } from '../payments/PaymentMethodsSection';

export function DiscountsScreen() {
  return (
    <div className="flex flex-col gap-6">
      {/* Each of the three sections carries its own notice: they are three
          different pieces of work under three different tickets. */}
      <DiscountCodesSection />
      <DiscountReasonsSection />
      <PaymentMethodsSection />
    </div>
  );
}
