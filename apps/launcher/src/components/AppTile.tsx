import { useState } from 'react';
import { useLocation } from 'wouter';
import { ArrowRight, Construction, Loader2, TriangleAlert } from 'lucide-react';
import { cn } from '@/lib/utils';
import { ApiError } from '@/api/client';
import { closedForNow, tileAction, type LauncherTile } from '@/suite/apps';
import { openApp, openAppUnauthenticated } from '@/suite/handoff';

/**
 * One app, one tile. Colour carries readiness and nothing else: an app you can
 * open now is in the brand's coral, one that is still being built is muted and
 * says so. Tiles an account has no access to never reach this component.
 *
 * An app in maintenance (SCRUM-643) shows the message the Console set and
 * opens nothing. A tile drawn as open whose hand-off is then refused because
 * the app has since closed turns into that same notice — and never offers the
 * "open anyway" way round, which would be a way into an app that is shut.
 */
export function AppTile({ tile, onStale }: { tile: LauncherTile; onStale?: () => void }) {
  const { app } = tile;
  const [, navigate] = useLocation();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [closedNow, setClosedNow] = useState<string | null>(null);
  const closed = closedNow ?? (tile.state === 'maintenance' ? (tile.maintenance?.message ?? '') : null);
  const live = Boolean(app.origin) && tile.state !== 'coming_soon';
  const Icon = app.icon;

  const open = async () => {
    const action = closedNow ? 'none' : tileAction(tile);
    if (action === 'none') return;
    if (action === 'refresh') {
      onStale?.();
      return;
    }
    if (action === 'soon') {
      navigate(`/soon/${app.key}`);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await openApp(app);
      // Navigation has begun; the spinner stays until the page goes.
    } catch (err) {
      setBusy(false);
      if (err instanceof ApiError && closedForNow(err.code)) {
        setClosedNow(err.message);
        return;
      }
      setError(err instanceof Error ? err.message : `Could not open ${app.name}`);
    }
  };

  return (
    <div className="flex flex-col gap-2">
      <button
        type="button"
        onClick={() => void open()}
        disabled={busy}
        aria-disabled={closed !== null || undefined}
        aria-label={closed !== null ? `${app.name} — in maintenance` : live ? `Open ${app.name}` : `${app.name} — coming soon`}
        className={cn(
          'group h-full text-left rounded-2xl border bg-card p-5 shadow-sm transition-shadow',
          closed === null && 'hover-elevate active-elevate-2 hover:shadow-md',
          closed !== null && 'cursor-not-allowed',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
          'disabled:pointer-events-none disabled:opacity-70',
        )}
      >
        <div className="flex items-start gap-4">
          <span
            className={cn(
              'w-12 h-12 rounded-xl flex items-center justify-center shrink-0',
              live && closed === null ? 'bg-primary/10 text-primary' : 'bg-muted text-muted-foreground',
            )}
          >
            <Icon className="w-6 h-6" />
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex items-start justify-between gap-2">
              <h3 className="text-lg font-bold leading-tight truncate">{app.name}</h3>
              <span
                className={cn(
                  'shrink-0 inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-semibold',
                  closed !== null
                    ? 'border-amber-500/40 bg-amber-400/10 text-amber-600 dark:text-amber-300'
                    : live
                      ? 'border-primary/25 bg-primary/10 text-primary'
                      : 'border-amber-500/40 bg-amber-400/10 text-amber-600 dark:text-amber-300',
                )}
              >
                {closed !== null ? 'Maintenance' : live ? 'Open' : 'Coming soon'}
              </span>
            </div>
            <p className="mt-1.5 text-sm text-muted-foreground">{app.purpose}</p>
          </div>
        </div>

        {closed !== null ? (
          <p className="mt-4 flex items-start gap-1.5 text-sm font-semibold text-amber-700 dark:text-amber-300">
            <Construction className="w-4 h-4 mt-0.5 shrink-0" />
            <span>{closed || `${app.name} is closed for maintenance for now.`}</span>
          </p>
        ) : (
          <div
            className={cn(
              'mt-4 flex items-center gap-1.5 text-sm font-semibold',
              live ? 'text-primary' : 'text-muted-foreground',
            )}
          >
            {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
            {busy ? 'Signing you in…' : live ? `Open ${app.name}` : 'What it will do'}
            {!busy && (
              <ArrowRight className="w-4 h-4 transition-transform group-hover:translate-x-0.5" />
            )}
          </div>
        )}
      </button>

      {error && (
        <div className="rounded-xl border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm">
          <p className="flex items-start gap-2 text-destructive">
            <TriangleAlert className="w-4 h-4 mt-0.5 shrink-0" />
            <span>
              {error}
              <span className="block text-foreground/60 font-normal mt-0.5">
                One sign-on could not be arranged. Opening {app.name} directly will ask for your
                password again.
              </span>
            </span>
          </p>
          <button
            type="button"
            onClick={() => openAppUnauthenticated(app)}
            className="mt-2 text-sm font-semibold text-primary hover:underline"
          >
            Open {app.name} anyway
          </button>
        </div>
      )}
    </div>
  );
}
