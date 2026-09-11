import { ReactNode, useState } from 'react';
import { Button } from '@/components/ui/button';
import { useLanguage } from '@/i18n/LanguageContext';
import { Smartphone, ArrowLeft, ArrowRight } from 'lucide-react';

interface HandToCustomerProps {
  /** Title shown on the staff-facing "hand over" prompt. */
  title: string;
  /** Subtitle / instructions shown on the hand-over prompt. */
  subtitle?: string;
  /** What the customer sees when they hold the device. */
  children: ReactNode;
  /** Called when customer is done (staff gets phone back). */
  onDone: () => void;
  /** Called when staff cancels instead of handing over. */
  onCancel?: () => void;
  /** Label for the "Customer is done" hand-back button (default: "Done — return phone to staff"). */
  handBackLabel?: string;
}

/**
 * Full-screen overlay for "hand to customer" moments on the single-device mobile POS.
 *
 * Phase 1 (staff): shows a clear hand-over prompt + "Customer ready" button.
 * Phase 2 (customer): renders `children` on the dark customer-facing screen with
 *   a large "Return phone to staff" button at the very bottom.
 *
 * The children are responsible for their own action buttons (e.g. "Find my
 * membership"). Those buttons should call handlers that eventually call `onDone`,
 * OR the customer can use the explicit "return" button at the bottom.
 */
export function HandToCustomer({
  title,
  subtitle,
  children,
  onDone,
  onCancel,
  handBackLabel,
}: HandToCustomerProps) {
  const { t } = useLanguage();
  const [phase, setPhase] = useState<'staff' | 'customer'>('staff');
  const resolvedHandBackLabel = handBackLabel ?? t('handToCustomer.handBackDefault');

  if (phase === 'staff') {
    return (
      <div className="fixed inset-0 z-50 flex flex-col bg-background text-foreground animate-in fade-in duration-200">
        <div className="flex-1 flex flex-col items-center justify-center px-8 text-center">
          <div className="w-24 h-24 rounded-full bg-primary/15 flex items-center justify-center text-primary mb-8">
            <Smartphone className="w-12 h-12" />
          </div>
          <h2 className="text-3xl font-black tracking-tight mb-3">{title}</h2>
          {subtitle && (
            <p className="text-lg text-muted-foreground max-w-sm">{subtitle}</p>
          )}
          <div className="flex items-center gap-3 mt-8 text-muted-foreground">
            <ArrowRight className="w-5 h-5" />
            <span className="text-base">{t('handToCustomer.pointScreen')}</span>
          </div>
        </div>
        <div className="p-6 space-y-3">
          <Button
            size="lg"
            className="w-full h-16 text-xl font-bold rounded-2xl"
            onClick={() => setPhase('customer')}
          >
            {t('handToCustomer.customerReady')}
          </Button>
          {onCancel && (
            <Button
              variant="ghost"
              size="lg"
              className="w-full h-12 text-muted-foreground"
              onClick={onCancel}
            >
              <ArrowLeft className="w-4 h-4 mr-2" />
              {t('handToCustomer.cancel')}
            </Button>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 z-50 flex flex-col overflow-hidden animate-in fade-in duration-200">
      <div className="flex-1 overflow-y-auto">{children}</div>
      <div className="shrink-0 p-4 border-t bg-slate-950/90 backdrop-blur-sm">
        <Button
          size="lg"
          variant="outline"
          className="w-full h-14 text-base font-semibold rounded-2xl border-white/20 text-white hover:bg-white/10"
          onClick={onDone}
        >
          {resolvedHandBackLabel}
        </Button>
      </div>
    </div>
  );
}
