import { MerchOrder } from '@/types';
import { getPrintTemplate } from '@/mockApi';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  CheckCircle2,
  ShoppingBag,
  Wallet,
  Banknote,
  CreditCard,
  Plus,
  QrCode as QrCodeIcon,
} from 'lucide-react';

interface MerchConfirmationProps {
  order: MerchOrder;
  newBalance: number | null;
  onNewOrder: () => void;
  /**
   * THE RECEIPT NUMBER THE PLATFORM ALLOCATED (S2-09b), when the sale reached
   * the ledger. Null on a device with no platform station behind it, where the
   * notice above says why — so its absence is never silent.
   */
  receiptNumber?: string | null;
}

export function MerchConfirmation({
  order,
  newBalance,
  onNewOrder,
  receiptNumber = null,
}: MerchConfirmationProps) {
  const { payment } = order;
  // Printout CONTENT follows the active receipt template (routing is unchanged).
  // With no template configured, default to showing everything.
  const receiptTpl = getPrintTemplate('receipt');
  const showReceiptItems = receiptTpl ? !!receiptTpl.fields.itemizedLines : true;

  return (
    <div className="flex flex-col items-center p-6 animate-in zoom-in-95 duration-400 h-full justify-center">
      <div className="w-full max-w-xl flex flex-col h-full max-h-[640px]">
        <div className="flex flex-col items-center text-center mb-5 shrink-0">
          <div className="w-20 h-20 rounded-full bg-emerald-500/20 text-emerald-500 flex items-center justify-center mb-3">
            <CheckCircle2 className="w-11 h-11" />
          </div>
          <h2 className="text-3xl font-bold tracking-tight">Sale Confirmed</h2>
          <div className="flex items-center gap-2 text-primary mt-2 text-lg font-medium">
            <ShoppingBag className="w-5 h-5" />
            Items handed over at the till
          </div>
          {receiptTpl?.headerText && (
            <p className="text-muted-foreground/80 mt-1 text-sm font-semibold tracking-wide">
              {receiptTpl.headerText}
            </p>
          )}
          <p className="text-muted-foreground mt-1">
            Sale #{order.id}
            {order.wristband ? ` • ${order.wristband.customerNickname}` : ' • Guest'}
          </p>
          {receiptNumber && (
            <p className="mt-1 text-sm font-semibold tabular-nums text-foreground/80">
              Receipt {receiptNumber}
            </p>
          )}
        </div>

        <Card className="p-5 flex flex-col bg-card/50 mb-4 min-h-0 flex-1">
          <div className="text-xs font-bold uppercase tracking-wide text-muted-foreground mb-3 shrink-0">
            Items
          </div>
          <ScrollArea className="-mx-2 px-2 flex-1">
            {showReceiptItems ? (
              <div className="space-y-2">
                {order.lines.map((line) => (
                  <div
                    key={line.id}
                    className="flex items-start justify-between gap-3 text-sm"
                  >
                    <span className="min-w-0">
                      <span className="font-bold tabular-nums">{line.qty}×</span>{' '}
                      <span>{line.merchItem.name}</span>
                    </span>
                    <span className="font-bold tabular-nums shrink-0">฿{line.lineTotal}</span>
                  </div>
                ))}
              </div>
            ) : (
              <div className="text-xs text-muted-foreground italic px-1">
                Itemized lines hidden by the receipt template.
              </div>
            )}
          </ScrollArea>

          <div className="border-t mt-3 pt-3 space-y-1.5 shrink-0">
            <div className="flex items-center justify-between text-lg font-bold">
              <span>Total</span>
              <span className="tabular-nums">฿{order.total}</span>
            </div>
            {payment.creditUsed > 0 && (
              <PaidRow icon={Wallet} label="Credit" amount={payment.creditUsed} />
            )}
            {payment.cash > 0 && <PaidRow icon={Banknote} label="Cash" amount={payment.cash} />}
            {payment.card > 0 && <PaidRow icon={CreditCard} label="Card" amount={payment.card} />}
            {payment.promptpay > 0 && (
              <PaidRow icon={QrCodeIcon} label="Thai QR / PromptPay" amount={payment.promptpay} />
            )}
            {receiptTpl?.footerText && (
              <div className="pt-1 text-center text-xs italic text-muted-foreground/70">
                {receiptTpl.footerText}
              </div>
            )}
          </div>
        </Card>

        {order.wristband && newBalance !== null && (
          <Card className="p-4 mb-4 shrink-0 flex items-center justify-between bg-primary/5 border-primary/30">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl bg-primary/20 text-primary flex items-center justify-center">
                <Wallet className="w-5 h-5" />
              </div>
              <div>
                <div className="text-sm text-muted-foreground">Remaining credit balance</div>
                <div className="text-xs text-muted-foreground">
                  {order.wristband.customerNickname}
                </div>
              </div>
            </div>
            <div className="text-2xl font-bold text-primary tabular-nums">฿{newBalance}</div>
          </Card>
        )}

        <Button
          size="lg"
          className="w-full h-16 text-xl font-bold gap-2 shrink-0"
          onClick={onNewOrder}
        >
          <Plus className="w-6 h-6" />
          New Sale
        </Button>
      </div>
    </div>
  );
}

function PaidRow({
  icon: Icon,
  label,
  amount,
}: {
  icon: typeof Wallet;
  label: string;
  amount: number;
}) {
  return (
    <div className="flex items-center justify-between text-sm text-muted-foreground">
      <span className="flex items-center gap-2">
        <Icon className="w-4 h-4" />
        {label}
      </span>
      <span className="tabular-nums">฿{amount}</span>
    </div>
  );
}
