import type { ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import { Card } from '@/components/ui/card';

/**
 * The party Edit form's own parts (the prototype's PartyEditForm), shared with
 * its kitchen and bar sections (SCRUM-907, PartyKitchenPlanEditor), so both
 * draw the same card, label and grid.
 */

export function Section({ icon: Icon, title, children }: { icon: LucideIcon; title: string; children: ReactNode }) {
  return (
    <Card className="p-5 bg-card/50">
      <div className="flex items-center gap-2 mb-4 font-bold">
        <Icon className="w-5 h-5 text-primary" />
        {title}
      </div>
      <div className="space-y-3">{children}</div>
    </Card>
  );
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="text-sm text-muted-foreground">{label}</span>
      <div className="mt-1">{children}</div>
    </label>
  );
}

export function Grid2({ children }: { children: ReactNode }) {
  return <div className="grid grid-cols-2 gap-3">{children}</div>;
}
