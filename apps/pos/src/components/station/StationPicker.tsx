import { useState } from 'react';
import { useLocation } from 'wouter';
import {
  ArrowRight,
  Check,
  Cpu,
  Info,
  Loader2,
  Plus,
  RefreshCw,
  Settings,
  UserCheck,
} from 'lucide-react';
import type { PickableStation } from '@/api/platform';
import { useStation } from '@/station/StationContext';
import { useOperator } from '@/auth/OperatorContext';
import { boxState } from '@/components/station/boxState';
import { StationShell } from '@/components/station/StationShell';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { ScrollArea } from '@/components/ui/scroll-area';
import { toast } from '@/hooks/use-toast';
import { cn } from '@/lib/utils';

/**
 * The station picker — the first thing a shift sees after signing in (R-14).
 *
 * The list is the API's answer to "which stations may this account work", and
 * that filtering is the point of the screen: a station kept for named staff is
 * ABSENT from everybody else's list, not greyed out and not present-and-
 * refusing, because somebody who cannot use a till should never be left looking
 * at it wondering why. Taking one by id is still refused by the API — a list
 * that hides something is not a permission check — and that refusal is handled
 * here without costing the person anything but the tap.
 *
 * Staff never set a station up. Only a manager or an administrator does, which
 * is why the only thing this screen offers them is the choice.
 */
export function StationPicker() {
  const { station, stations, loading, error, notice, pick, reload } = useStation();
  const { can } = useOperator();
  const [location, navigate] = useLocation();
  const [busyId, setBusyId] = useState<string | null>(null);

  const mayConfigure = can('admin:station:create');
  const mayEdit = can('admin:station:update');

  const take = async (target: PickableStation) => {
    if (busyId) return;
    setBusyId(target.id);
    try {
      await pick(target.id);
      toast({
        title: `${target.name} is yours`,
        description: target.boxId
          ? `Printing and scanning run through ${target.boxName ?? 'its box'}.`
          : 'No box is assigned to this station yet, so nothing will print.',
      });
      // When this screen stood in for a surface somebody had asked for, that
      // surface is what they get back — the address never changed, only what
      // was drawn at it. Leaving the station screens is a move of its own.
      if (location.startsWith('/station-setup')) navigate('/');
    } catch (err) {
      // The list and the refusal can disagree — somebody may have been taken
      // off this station's list a moment ago. Say what happened and read the
      // list again rather than leaving a row that no longer opens.
      toast({
        title: `Could not take ${target.name}`,
        description: err instanceof Error ? err.message : 'The platform refused it.',
        variant: 'destructive',
      });
      void reload();
    } finally {
      setBusyId(null);
    }
  };

  const list = stations ?? [];

  return (
    <StationShell subtitle="Pick your station" closeTo={station ? '/' : null}>
      <Card className="p-6 flex flex-col bg-card/50 max-w-3xl mx-auto w-full">
        <div className="flex items-center gap-3 mb-4">
          <div className="w-11 h-11 rounded-xl flex items-center justify-center bg-primary/15 text-primary">
            <Cpu className="w-6 h-6" />
          </div>
          <div className="flex-1 min-w-0">
            <h2 className="text-2xl font-bold">Which station are you on?</h2>
          </div>
          {stations !== null && (
            <Button variant="ghost" size="sm" onClick={() => void reload()} disabled={loading}>
              <RefreshCw className={cn('w-4 h-4', loading && 'animate-spin')} />
              Refresh
            </Button>
          )}
        </div>

        <p className="text-muted-foreground mb-4">
          The station decides which printers, scanner and card machine this screen drives. Pick the
          counter you are standing at.
        </p>

        {notice && (
          <p className="mb-4 rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-600 dark:text-amber-400">
            {notice}
          </p>
        )}

        {error && (
          <div className="mb-4 rounded-xl border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
            {error}
            <Button variant="ghost" size="sm" className="ml-2" onClick={() => void reload()}>
              Try again
            </Button>
          </div>
        )}

        {stations === null ? (
          <div className="flex justify-center py-12">
            <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
          </div>
        ) : list.length === 0 ? (
          <div className="rounded-xl border border-dashed px-6 py-10 text-center">
            <p className="font-semibold">No station here is yours to work</p>
            <p className="mt-1 text-sm text-muted-foreground">
              {mayConfigure
                ? 'Nothing is set up at this branch yet. Set a station up on one of its boxes to open the till.'
                : 'Ask a manager to set one up, or to put you on the list of a station that is kept for named staff.'}
            </p>
          </div>
        ) : (
          // Capped rather than stretched, so a branch with two stations gets a
          // card the size of the wizard's and not one the size of the screen.
          <ScrollArea className="max-h-[45vh] -mx-1 px-1">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pb-1">
              {list.map((s) => (
                <StationTile
                  key={s.id}
                  station={s}
                  active={s.id === station?.stationId}
                  busy={busyId === s.id}
                  onSelect={() => void take(s)}
                />
              ))}
            </div>
          </ScrollArea>
        )}

        <div className="flex items-center justify-between gap-3 mt-6 pt-5 border-t">
          <p className="flex items-start gap-2 text-sm text-muted-foreground">
            <Info className="w-4 h-4 mt-0.5 shrink-0" />
            <span>Stations are set up by a manager. This list is the ones you may work.</span>
          </p>
          <div className="flex items-center gap-2 shrink-0">
            {station && mayEdit && (
              <Button variant="ghost" onClick={() => navigate('/station-setup/settings')}>
                <Settings className="w-4 h-4" />
                Station settings
              </Button>
            )}
            {mayConfigure && (
              <Button variant="outline" onClick={() => navigate('/station-setup/new')}>
                <Plus className="w-4 h-4" />
                Set up a station
              </Button>
            )}
          </div>
        </div>
      </Card>
    </StationShell>
  );
}

function StationTile({
  station,
  active,
  busy,
  onSelect,
}: {
  station: PickableStation;
  active: boolean;
  busy: boolean;
  onSelect: () => void;
}) {
  const box = boxState(station.boxStatus);
  const devices = station.deviceCount ?? 0;
  return (
    <button
      type="button"
      onClick={onSelect}
      disabled={busy}
      className={cn(
        'rounded-xl border p-4 text-left transition-colors min-h-[88px]',
        active ? 'border-primary bg-primary/10' : 'hover:bg-muted',
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="font-semibold truncate">{station.name}</span>
        {busy ? (
          <Loader2 className="w-5 h-5 animate-spin text-muted-foreground shrink-0" />
        ) : active ? (
          <Check className="w-5 h-5 text-primary shrink-0" />
        ) : (
          <ArrowRight className="w-5 h-5 text-muted-foreground shrink-0" />
        )}
      </div>
      <div className="text-xs mt-2 flex items-center gap-1.5 text-muted-foreground">
        <Cpu className="w-3.5 h-3.5 shrink-0" />
        {station.boxId ? (
          <span className="truncate">
            {station.boxName ?? 'Box'}
            {box && (
              <>
                {' · '}
                <span className={box.tone}>{box.label}</span>
              </>
            )}
            {' · '}
            {devices} {devices === 1 ? 'device' : 'devices'}
          </span>
        ) : (
          <span className="truncate text-amber-600 dark:text-amber-400">No box assigned</span>
        )}
      </div>
      {station.accessScope === 'selected_staff' && (
        <div className="text-xs mt-1 flex items-center gap-1.5 text-muted-foreground">
          <UserCheck className="w-3.5 h-3.5 shrink-0" />
          Kept for named staff
        </div>
      )}
    </button>
  );
}
