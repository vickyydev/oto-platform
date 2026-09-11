import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Smartphone, User, Loader2 } from 'lucide-react';

interface StepAwaitCustomerProps {
  phone: string;
  nickname: string;
  onBack: () => void;
}

export function StepAwaitCustomer({ phone, nickname, onBack }: StepAwaitCustomerProps) {
  return (
    <div className="flex flex-col h-full animate-in fade-in slide-in-from-right-4 duration-300">
      <div className="mb-8">
        <h2 className="text-3xl font-bold tracking-tight">Customer Details</h2>
        <p className="text-muted-foreground mt-2 text-lg">
          Ask the customer to enter their details on their display.
        </p>
      </div>

      <div className="flex-1 flex flex-col items-center justify-center text-center">
        <div className="w-20 h-20 rounded-full bg-primary/10 flex items-center justify-center text-primary mb-6">
          <Loader2 className="w-10 h-10 animate-spin" />
        </div>
        <p className="text-xl font-medium">Waiting for the customer…</p>
        <p className="text-muted-foreground mt-1">
          The customer display is now their turn to enter a phone &amp; nickname.
        </p>

        <div className="grid grid-cols-2 gap-4 mt-8 w-full max-w-xl">
          <Card className="p-5 flex items-center gap-4 text-left">
            <div className="w-12 h-12 rounded-xl bg-muted flex items-center justify-center text-muted-foreground shrink-0">
              <Smartphone className="w-6 h-6" />
            </div>
            <div className="min-w-0">
              <div className="text-sm text-muted-foreground">Phone</div>
              <div className="text-xl font-bold truncate">
                {phone || <span className="text-muted-foreground/50">—</span>}
              </div>
            </div>
          </Card>
          <Card className="p-5 flex items-center gap-4 text-left">
            <div className="w-12 h-12 rounded-xl bg-muted flex items-center justify-center text-muted-foreground shrink-0">
              <User className="w-6 h-6" />
            </div>
            <div className="min-w-0">
              <div className="text-sm text-muted-foreground">Nickname</div>
              <div className="text-xl font-bold truncate">
                {nickname || <span className="text-muted-foreground/50">—</span>}
              </div>
            </div>
          </Card>
        </div>
      </div>

      <div className="mt-auto pt-6">
        <Button variant="outline" size="lg" className="w-32 h-16" onClick={onBack}>
          Back
        </Button>
      </div>
    </div>
  );
}
