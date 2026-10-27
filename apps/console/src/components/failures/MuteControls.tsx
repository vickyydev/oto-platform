import { useState } from 'react';
import { BellOff, Loader2 } from 'lucide-react';
import { alertRoutingApi, type AlertMute } from '@/api/observability';
import { Button } from '@/components/ui/button';
import { CONTROL, Labelled } from '@/components/Filters';
import { StatusChip } from '@/components/redesign/chips';
import { MUTE_DEFAULT_MINUTES, muteDurations, muteFormProblem } from '@/lib/alertRouting';
import { formatExact, formatWhen } from '@/lib/time';

/**
 * SCRUM-644 (planner ruling Q25) — a fingerprint mute, as the Failures page
 * shows and changes it.
 *
 * A muted group stays on the list with this badge: muting holds back the
 * alert's DELIVERY, and every delivery it holds back is recorded, so the
 * badge says how many. Muting needs a reason and lasts at most 24 hours — the
 * form offers nothing longer and the API refuses anything longer.
 */
export function MutedBadge({ mute, timezone }: { mute: AlertMute; timezone?: string | null }) {
  return (
    <StatusChip tone="idle" title={`Muted ${formatExact(mute.startsAt, timezone)} by ${mute.createdByName ?? 'an administrator'}: ${mute.reason}`}>
      <BellOff className="w-3.5 h-3.5" />
      Muted until {formatWhen(mute.mutedUntil, timezone)} · {mute.reason}
      {mute.heldBack > 0 ? ` · ${mute.heldBack} held back` : ''}
    </StatusChip>
  );
}

export function MuteForm({
  fingerprint,
  maxMinutes,
  onDone,
  onCancel,
}: {
  fingerprint: string;
  maxMinutes: number;
  onDone: () => void;
  onCancel: () => void;
}) {
  const [reason, setReason] = useState('');
  const [minutes, setMinutes] = useState(MUTE_DEFAULT_MINUTES);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const problem = muteFormProblem({ reason, minutes }, maxMinutes);

  const save = async () => {
    if (problem || busy) return;
    setBusy(true);
    setError(null);
    try {
      await alertRoutingApi.mute({ fingerprint, reason: reason.trim(), minutes });
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not mute it');
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="flex flex-col gap-2.5 rounded-xl border border-dashed px-3 py-3"
      aria-label="Mute this alert"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <Labelled label="Why mute it">
        <textarea
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          rows={2}
          maxLength={500}
          className={CONTROL}
          placeholder="The printer is being replaced this afternoon"
        />
      </Labelled>
      <Labelled label="For how long">
        <select value={minutes} onChange={(e) => setMinutes(Number(e.target.value))} className={CONTROL}>
          {muteDurations(maxMinutes).map((d) => (
            <option key={d.minutes} value={d.minutes}>
              {d.label}
            </option>
          ))}
        </select>
      </Labelled>
      <p className="text-xs text-muted-foreground">
        The failures stay listed and the alert is still raised; only its delivery is held back, and each one held
        back is recorded. A mute lasts at most 24 hours.
      </p>
      {(error ?? (reason.length > 0 ? problem : null)) && (
        <p role="alert" className="text-xs font-semibold text-status-down">
          {error ?? problem}
        </p>
      )}
      <span className="flex items-center gap-2">
        <Button type="submit" size="sm" className="rounded-full" disabled={Boolean(problem) || busy}>
          {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : null}
          Mute
        </Button>
        <Button type="button" variant="outline" size="sm" className="rounded-full" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
      </span>
    </form>
  );
}

export function UnmuteButton({ mute, onDone }: { mute: AlertMute; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  return (
    <button
      type="button"
      disabled={busy}
      onClick={() => {
        setBusy(true);
        setNote(null);
        void alertRoutingApi
          .lift(mute.id)
          .then(onDone)
          .catch((err: unknown) => setNote(err instanceof Error ? err.message : 'Could not unmute it'))
          .finally(() => setBusy(false));
      }}
      className="rounded-full border bg-card px-3 py-1.5 text-xs font-bold disabled:opacity-50"
    >
      {busy ? 'Unmuting…' : (note ?? 'Unmute')}
    </button>
  );
}
