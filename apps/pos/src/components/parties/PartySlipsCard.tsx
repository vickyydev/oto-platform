import { useEffect, useRef, useState } from 'react';
import { newId, type PartySlipsView } from '@oto/shared';
import { Clock, GlassWater, Printer, UtensilsCrossed } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { toast } from '@/hooks/use-toast';
import { partyWriteBlocker } from '@/api/parties';
import { partySlipWords, printPartySlipsOnPlatform, readPartySlipsOnPlatform } from '@/api/partySlips';
import type { PartyBooking } from '@/types';

/**
 * SCRUM-805 — "Kitchen & bar slips" on the party page (birthday plan §5): the
 * party's slip time, what became of its kitchen slip and its bar slip on its
 * day, and "Print party slips now". Drawn as the page's other blocks are (its
 * card, its header, its rows); shown only for a party the OTO App publishes a
 * plan for.
 */

function SlipRow({ icon: Icon, label, value }: { icon: typeof Printer; label: string; value: string }) {
  return (
    <div className="flex items-start justify-between gap-4 py-1.5">
      <span className="flex items-center gap-2 text-muted-foreground shrink-0">
        <Icon className="w-4 h-4" />
        {label}
      </span>
      <span className="text-right font-medium">{value}</span>
    </div>
  );
}

/** The block as it draws, from the slips the platform answered. */
export function PartySlipsBlock({
  slips,
  busy,
  onPrint,
}: {
  slips: PartySlipsView;
  busy: boolean;
  onPrint: () => void;
}) {
  return (
    <Card className="p-5 bg-card/50">
      <div className="flex items-center gap-2 mb-4 font-bold">
        <Printer className="w-5 h-5 text-primary" />
        Kitchen &amp; bar slips
      </div>
      <div className="text-sm">
        <SlipRow icon={Clock} label="Slip time" value={slips.slipsTime} />
        <SlipRow
          icon={UtensilsCrossed}
          label="Kitchen slip"
          value={partySlipWords(slips.latest.kitchen, slips.station, 'kitchen')}
        />
        <SlipRow icon={GlassWater} label="Bar slip" value={partySlipWords(slips.latest.bar, slips.station, 'bar')} />
      </div>
      <Button variant="outline" size="lg" className="gap-2 h-12 w-full mt-3" disabled={busy} onClick={onPrint}>
        <Printer className="w-5 h-5" />
        Print party slips now
      </Button>
    </Card>
  );
}

/** The block for one party: read on opening, printed again on a press. */
export function PartySlipsCard({ party }: { party: Pick<PartyBooking, 'id' | 'branchId'> }) {
  const [slips, setSlips] = useState<PartySlipsView | null>(null);
  const [busy, setBusy] = useState(false);
  // A press nothing answered keeps its id, so pressing again is the same run.
  const pending = useRef<string | null>(null);

  useEffect(() => {
    let live = true;
    setSlips(null);
    pending.current = null;
    void readPartySlipsOnPlatform({ id: party.id, branchId: party.branchId }).then((read) => {
      if (live) setSlips(read);
    });
    return () => {
      live = false;
    };
  }, [party.id, party.branchId]);

  if (!slips) return null;

  const print = async () => {
    const blocked = partyWriteBlocker({ branchSlug: party.branchId });
    if (blocked) {
      toast(blocked);
      return;
    }
    const actionId = pending.current ?? newId();
    pending.current = actionId;
    setBusy(true);
    try {
      const outcome = await printPartySlipsOnPlatform({ party, actionId });
      if (outcome.ok || !outcome.retryable) pending.current = null;
      if (!outcome.ok) {
        toast({ title: 'Party slips not printed', description: outcome.message, variant: 'destructive' });
        return;
      }
      const now = outcome.answer.slips;
      setSlips(now);
      const kitchen = outcome.answer.printed.find((r) => r.station === 'kitchen') ?? null;
      const bar = outcome.answer.printed.find((r) => r.station === 'bar') ?? null;
      toast({
        title: 'Print party slips now',
        description: `Kitchen slip: ${partySlipWords(kitchen, now.station, 'kitchen')} · Bar slip: ${partySlipWords(bar, now.station, 'bar')}`,
      });
    } finally {
      setBusy(false);
    }
  };

  return <PartySlipsBlock slips={slips} busy={busy} onPrint={() => void print()} />;
}
