
import { DiscountCodesSection, DiscountCodesSectionWithPorts } from "./DiscountCodesSection";
import { DiscountReasonsSection, DiscountReasonsSectionWithPorts } from "./DiscountReasonsSection";
import { PaymentMethodsSection, PaymentMethodsSectionWithPorts } from "../payments/PaymentMethodsSection";
import type { DiscountCodesSectionPorts, DiscountReasonsSectionPorts, PaymentMethodsSectionPorts } from '../../../runtime/money';

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

export function DiscountsScreenWithPorts({ ports }: { ports: { codes: DiscountCodesSectionPorts; reasons: DiscountReasonsSectionPorts; payments: PaymentMethodsSectionPorts } }) {
  return (
    <div className="flex flex-col gap-6">
      <DiscountCodesSectionWithPorts ports={ports.codes} />
      <DiscountReasonsSectionWithPorts ports={ports.reasons} />
      <PaymentMethodsSectionWithPorts ports={ports.payments} />
    </div>
  );
}
