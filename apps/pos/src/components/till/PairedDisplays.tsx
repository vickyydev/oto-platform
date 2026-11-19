import { useState } from 'react';
import { Loader2, Monitor } from 'lucide-react';
import { api, ApiError } from '@/api/client';
import { useOperator } from '@/auth/OperatorContext';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { noteDisplayRemoved, type PairedDisplay } from '@/lib/displaySession';

/**
 * SCRUM-1041 — THE TILL'S DISPLAYS, EACH WITH ITS OWN "REMOVE".
 *
 * A till may have up to three customer displays, each showing the same sale
 * (the owner's answer of 19 November). The till lists them by the names they
 * were given when they were paired in the Console — numbered where two share
 * a name — with whether each is connected or when it was last seen, and a
 * Remove for each. Remove revokes that display's pairing alone: the others
 * stay paired and showing. Removing a display is a manager's, as it is in the
 * Console (`admin:device:revoke`); pairing one stays in the Console.
 */

/** "Connected", or when it was last seen in the park's time: the time today, the day and time before. */
export function displaySeenLine(display: Pick<PairedDisplay, 'connected' | 'lastSeenAt'>, timeZone: string | undefined,
  now: Date = new Date()): string {
  if (display.connected) return 'Connected';
  if (!display.lastSeenAt) return 'Not connected';
  const seen = new Date(display.lastSeenAt);
  const zone = timeZone ? { timeZone } : {};
  const day = (value: Date) => value.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', ...zone });
  const time = seen.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', ...zone });
  return day(seen) === day(now) ? `Last seen ${time}` : `Last seen ${day(seen)}, ${time}`;
}

export function PairedDisplaysDialog({ open, onOpenChange, displays, timeZone }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The displays paired to this till; null while the list cannot be read. */
  displays: PairedDisplay[] | null;
  timeZone?: string;
}) {
  const { can } = useOperator();
  const mayRemove = can('admin:device:revoke');
  const [removed, setRemoved] = useState<ReadonlySet<string>>(new Set());
  const [confirming, setConfirming] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const shown = (displays ?? []).filter((display) => !removed.has(display.id));

  const remove = async (display: PairedDisplay) => {
    if (busy) return;
    setBusy(display.id);
    setFailed(null);
    try {
      await api.post(`/credentials/${display.id}/revoke`, { reason: 'Removed at the till' },
        { idempotencyKey: crypto.randomUUID() });
      noteDisplayRemoved(display.id);
      setRemoved((current) => new Set([...current, display.id]));
      setConfirming(null);
    } catch (failure) {
      // Removed already (by the Console, or another till): it is gone all the same.
      if (failure instanceof ApiError && failure.code === 'CREDENTIAL_ALREADY_REVOKED') {
        noteDisplayRemoved(display.id);
        setRemoved((current) => new Set([...current, display.id]));
        setConfirming(null);
      } else {
        setFailed(failure instanceof ApiError && failure.status === 403
          ? 'Only a manager can remove a display.'
          : `${display.name} could not be removed: ${failure instanceof Error ? failure.message : 'try again.'}`);
      }
    } finally {
      setBusy(null);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) { setConfirming(null); setFailed(null); } onOpenChange(next); }}>
      <DialogContent className="max-w-md" data-testid="paired-displays">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Monitor className="h-5 w-5 text-primary" />
            Customer displays
          </DialogTitle>
          <DialogDescription>
            Each display shows the sale on this till. A till can have up to three; a manager pairs one in the
            Console, under Devices.
          </DialogDescription>
        </DialogHeader>
        {displays === null
          ? <p className="text-sm text-muted-foreground" role="status">The list of displays cannot be read right now.</p>
          : shown.length === 0
            ? <p className="text-sm text-muted-foreground" role="status">No display is paired to this till.</p>
            : <ul className="space-y-2">
              {shown.map((display) => {
                const asking = confirming === display.id;
                const working = busy === display.id;
                return (
                  <li key={display.id} className="rounded-xl border border-border bg-card px-4 py-3" data-testid="paired-display">
                    <div className="flex items-center gap-3">
                      <Monitor className="h-5 w-5 shrink-0 text-muted-foreground" />
                      <div className="min-w-0 flex-1">
                        <p className="truncate font-medium" data-testid="paired-display-name">{display.name}</p>
                        <p className="flex items-center gap-1.5 text-sm text-muted-foreground" data-testid="paired-display-seen">
                          <span aria-hidden className={cn('h-2 w-2 shrink-0 rounded-full',
                            display.connected ? 'bg-emerald-500' : 'bg-muted-foreground/40')} />
                          {displaySeenLine(display, timeZone)}
                        </p>
                      </div>
                      {mayRemove && !asking && (
                        <Button size="sm" variant="outline" disabled={!!busy} onClick={() => { setFailed(null); setConfirming(display.id); }}
                          data-testid="paired-display-remove">Remove</Button>
                      )}
                    </div>
                    {mayRemove && asking && (
                      <div className="mt-3 flex flex-wrap items-center justify-end gap-2 border-t border-border pt-3">
                        <p className="mr-auto text-sm text-muted-foreground">It stops showing this till&apos;s sales.</p>
                        <Button size="sm" variant="outline" disabled={working} onClick={() => setConfirming(null)}>Keep</Button>
                        <Button size="sm" variant="destructive" disabled={working} onClick={() => { void remove(display); }}
                          data-testid="paired-display-remove-confirm">
                          {working && <Loader2 className="animate-spin" />}
                          Remove
                        </Button>
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>}
        {failed && <p role="alert" className="rounded-lg border border-rose-500/40 bg-rose-500/10 p-3 text-sm text-rose-700 dark:text-rose-300"
          data-testid="paired-displays-error">{failed}</p>}
        {!mayRemove && shown.length > 0 && (
          <p className="text-sm text-muted-foreground" data-testid="paired-displays-manager">A manager can remove a display.</p>
        )}
      </DialogContent>
    </Dialog>
  );
}
