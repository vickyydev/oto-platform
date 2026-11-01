import { useWorkingAuthority } from '@/lib/workingAuthority';
import { useCallback, useEffect, useState } from 'react';
import { Baby, RefreshCw, TriangleAlert, UserPlus, X } from 'lucide-react';
import { CONTROL } from '@/components/Filters';
import { Field, TextInput } from '@/components/Form';
import { ErrorNote, Loading, RouteUnavailable } from '@/components/Panel';
import { Button } from '@/components/ui/button';
import { StatusChip } from '@/components/redesign/chips';
import { CardShell, StripedList } from '@/components/redesign/layout';
import { cn } from '@/lib/utils';
import { ApiError, isMissingRoute, nannyApi, type NannyDutyView } from './nannyApi';
import {
  APP_STATE_NOTE,
  NANNY_SOURCE,
  alsoMatchesLine,
  initialOf,
  loadText,
  logLineText,
  logTime,
  shiftHours,
  shiftOver,
  unmatchedLine,
} from './todayNannies';

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const NAME_MAX = 100;
const MATCH_TEXT_MAX = 100;

/**
 * Today's nannies (SCRUM-699): who can take a Nanny drop-off at this park
 * today. The till only lets staff pick a nanny who is on shift now, so this
 * card is where a park that shows "Off shift" for everybody is put right.
 *
 * The roster comes from the OTO App's rota (read when the park opens, or now
 * with "Sync now"); reception can add a nanny for today by hand when nobody is
 * rostered, so a drop-off sale never has to wait for the rota. On shift and
 * the children with each nanny are the till's own answer, read by the same
 * service, so the card and the till never disagree.
 *
 * Built like the booth's "Today's staff" card (`../booth/TodayStaffPanel.tsx`):
 * it reads and writes its own routes, so the rest of the page is not re-read
 * on every change here, and the park's time zone comes from the answer.
 */
export function TodayNanniesPanel({
  branchId,
  canManage,
  canEditRule,
  id,
  className,
}: {
  branchId: string;
  /** Sync, add and remove the day's nannies (`pos:checkin:update` at the branch). */
  canManage: boolean;
  /** Change how nannies are found on the rota (`catalog:package:update` at the branch). */
  canEditRule: boolean;
  id?: string;
  className?: string;
}) {
  const working = useWorkingAuthority();
  const [view, setView] = useState<NannyDutyView | null>(null);
  const [missing, setMissing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [ruleOpen, setRuleOpen] = useState(false);
  const [matchText, setMatchText] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!working.isCurrent()) return;
    try {
      const next = await working.run(() => nannyApi.today(branchId));
      if (!working.isCurrent()) return;
      setView(next);
      setMatchText(next.rule.matchText);
      setError(null);
    } catch (err) {
      if (!working.isCurrent()) return;
      if (isMissingRoute(err)) setMissing(true);
      else setError(err instanceof ApiError ? err.message : 'Today’s nannies could not be read');
    }
  }, [branchId, working.isCurrent, working.run]);

  useEffect(() => {
    setView(null);
    setMissing(false);
    void load();
  }, [load]);

  /** One write, then the card is read again. True when the write went through. */
  const act = async (fn: () => Promise<unknown>): Promise<boolean> => {
    if (!working.isCurrent()) return false;
    setBusy(true);
    try {
      await working.run(fn);
      if (!working.isCurrent()) return false;
      await load();
      return true;
    } catch (err) {
      if (working.isCurrent())
        setError(err instanceof ApiError ? err.message : 'That could not be saved');
      return false;
    } finally {
      if (working.isCurrent()) setBusy(false);
    }
  };

  if (missing) {
    return (
      <CardShell id={id} className={className} icon={Baby} title="Today’s nannies">
        <RouteUnavailable
          what="Today’s nannies"
          detail="This deployment does not read the nanny rota yet."
        />
      </CardShell>
    );
  }

  const timezone = view?.timezone;
  const note = view?.lastSync ? APP_STATE_NOTE[view.lastSync.appState] : null;
  const unmatched = view?.lastSync?.unmatched ?? [];
  const nobodyOnShift = !!view && !view.nannies.some((n) => n.onShift);
  const trimmedName = name.trim();
  const canAdd =
    !busy &&
    trimmedName !== '' &&
    trimmedName.length <= NAME_MAX &&
    HHMM.test(from) &&
    HHMM.test(to) &&
    from !== to;
  const also = view ? alsoMatchesLine(view.rule.alsoMatches) : null;

  const syncButton = canManage && view && (
    <Button
      size="sm"
      variant="outline"
      className="rounded-full px-3.5"
      disabled={busy}
      onClick={() => void act(() => nannyApi.sync(branchId))}
    >
      <RefreshCw className={busy ? 'w-4 h-4 animate-spin' : 'w-4 h-4'} />
      Sync now
    </Button>
  );

  return (
    <CardShell
      id={id}
      className={className}
      icon={Baby}
      title="Today’s nannies"
      note={
        view
          ? `who can take a Nanny drop-off at this park on ${view.businessDate}, from the OTO App’s rota — the till offers only a nanny on shift`
          : 'who can take a Nanny drop-off at this park today, from the OTO App’s rota'
      }
      actions={syncButton}
      footer={
        // The day's log lines in quiet mono, on the card's ruled foot.
        view && view.log.length > 0 ? (
          <ul className="flex w-full flex-col gap-1.5 text-xs">
            {view.log.map((line, i) => (
              <li key={`${line.at}-${i}`} className="flex gap-2.5">
                <span className="shrink-0 font-mono text-[11px] tabular-nums text-muted-foreground/80">
                  {logTime(line.at, timezone)}
                </span>
                <span className="min-w-0 break-words">{logLineText(line, timezone)}</span>
              </li>
            ))}
          </ul>
        ) : undefined
      }
    >
      {error && <ErrorNote message={error} onRetry={() => void load()} />}
      {!view ? (
        !error && <Loading what="today’s nannies" />
      ) : (
        <>
          <p className="text-xs text-muted-foreground">
            {view.lastSync
              ? `Read from the rota at ${logTime(view.lastSync.syncedAt, timezone)}.`
              : 'The rota has not been read yet today — it is read when the park opens, or now with Sync now.'}
          </p>

          {view.nannies.length === 0 ? (
            <p className="text-sm text-muted-foreground">No nannies at this park yet.</p>
          ) : (
            <StripedList label="Today’s nannies">
              {view.nannies.map((nanny, index) => (
                <li key={nanny.id} className="flex items-start gap-3 px-3 py-2.5">
                  <span
                    aria-hidden="true"
                    className={cn(
                      'flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-sm font-bold',
                      index % 2 === 0
                        ? 'bg-secondary text-secondary-foreground'
                        : 'bg-primary/10 text-primary-ink',
                    )}
                  >
                    {initialOf(nanny.name)}
                  </span>
                  <div className="flex min-w-0 flex-1 flex-col gap-1">
                    <div className="break-words text-[13.5px] font-semibold">{nanny.name}</div>
                    {nanny.shifts.length === 0 ? (
                      <div className="text-xs text-muted-foreground">No shift today</div>
                    ) : (
                      <ul
                        className="flex flex-wrap gap-1.5"
                        aria-label={`${nanny.name}’s shifts today`}
                      >
                        {nanny.shifts.map((shift) => {
                          const hours = shiftHours(shift.startsAt, shift.endsAt, timezone);
                          const over = shiftOver(shift, view.asOf);
                          return (
                            <li
                              key={shift.id}
                              className={cn(
                                'inline-flex items-center gap-1 rounded-full border border-border px-2.5 py-0.5 font-mono text-[11.5px] tabular-nums',
                                over && 'text-muted-foreground/70',
                              )}
                            >
                              <span>{hours}</span>
                              {shift.source !== nanny.source && (
                                <span className="font-sans text-muted-foreground">
                                  · {NANNY_SOURCE[shift.source].label.toLowerCase()}
                                </span>
                              )}
                              {over && (
                                <span className="font-sans text-muted-foreground">· ended</span>
                              )}
                              {canManage && !over && (
                                <button
                                  type="button"
                                  aria-label={`Remove ${nanny.name}’s ${hours} shift`}
                                  disabled={busy}
                                  onClick={() =>
                                    void act(() => nannyApi.removeShift(branchId, shift.id))
                                  }
                                  className="-mr-1 rounded-full p-0.5 text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground disabled:opacity-50"
                                >
                                  <X className="w-3.5 h-3.5" />
                                </button>
                              )}
                            </li>
                          );
                        })}
                      </ul>
                    )}
                  </div>
                  <div className="flex shrink-0 flex-col items-end gap-1">
                    <div className="flex flex-wrap justify-end gap-1.5">
                      <StatusChip tone={NANNY_SOURCE[nanny.source].tone}>
                        {NANNY_SOURCE[nanny.source].label}
                      </StatusChip>
                      <StatusChip tone={nanny.onShift ? 'ok' : 'idle'}>
                        {nanny.onShift ? 'On shift' : 'Off shift'}
                      </StatusChip>
                    </div>
                    {(nanny.onShift || nanny.load > 0) && (
                      <span className="text-xs text-muted-foreground">{loadText(nanny.load)}</span>
                    )}
                  </div>
                </li>
              ))}
            </StripedList>
          )}

          {nobodyOnShift && (
            <p className="flex gap-2.5 rounded-[14px] border border-status-warn/30 bg-status-warn/15 px-3.5 py-2.5 text-sm">
              <TriangleAlert
                className="mt-0.5 w-4 h-4 shrink-0 text-status-warn"
                aria-hidden="true"
              />
              <span className="min-w-0 break-words">
                Nobody is on shift now, so the till cannot sell a Nanny drop-off.{' '}
                {canManage
                  ? 'Sync now, or add a nanny for today below.'
                  : 'Ask a manager to add a nanny for today.'}
              </span>
            </p>
          )}

          {note && (
            <p className="flex gap-2.5 rounded-[14px] border border-status-warn/30 bg-status-warn/15 px-3.5 py-2.5 text-sm">
              <TriangleAlert
                className="mt-0.5 w-4 h-4 shrink-0 text-status-warn"
                aria-hidden="true"
              />
              <span className="min-w-0 break-words">{note}</span>
            </p>
          )}

          {unmatched.length > 0 && (
            <div className="flex flex-col gap-1 rounded-[14px] border border-border p-3 text-sm">
              <p className="font-semibold">On the rota as a nanny, but not added</p>
              <ul className="flex flex-col gap-0.5 text-muted-foreground">
                {unmatched.map((u, i) => (
                  <li key={`${u.name ?? ''}-${u.reason}-${i}`} className="break-words">
                    {unmatchedLine(u)}
                  </li>
                ))}
              </ul>
              <p className="text-xs text-muted-foreground">
                Not offered at the till until added here by hand.
              </p>
            </div>
          )}

          {canManage && (
            <div className="flex flex-col gap-3 rounded-[14px] border border-border p-3">
              <p className="text-sm font-semibold">Add a nanny for today</p>
              <div className="grid gap-3 @md:grid-cols-[1fr_auto_auto_auto] @md:items-end">
                <Field label="Name">
                  <TextInput
                    value={name}
                    onChange={setName}
                    placeholder="e.g. Nok"
                    maxLength={NAME_MAX}
                    disabled={busy}
                  />
                </Field>
                <Field label="From">
                  <input
                    type="time"
                    aria-label="Shift starts"
                    value={from}
                    disabled={busy}
                    onChange={(e) => setFrom(e.target.value)}
                    className={cn(CONTROL, 'disabled:opacity-60')}
                  />
                </Field>
                <Field label="To">
                  <input
                    type="time"
                    aria-label="Shift ends"
                    value={to}
                    disabled={busy}
                    onChange={(e) => setTo(e.target.value)}
                    className={cn(CONTROL, 'disabled:opacity-60')}
                  />
                </Field>
                <Button
                  size="sm"
                  className="rounded-full px-4 font-bold"
                  disabled={!canAdd}
                  onClick={() => {
                    const input = { name: trimmedName, from, to };
                    void act(() => nannyApi.addManual(branchId, input)).then((done) => {
                      if (done) {
                        setName('');
                        setFrom('');
                        setTo('');
                      }
                    });
                  }}
                >
                  <UserPlus className="w-4 h-4" />
                  Add
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                Today at this park, in its own time. A finish at or before the start runs past
                midnight. A name already on the list is reused.
              </p>
            </div>
          )}

          <div className="flex flex-col gap-2">
            <button
              type="button"
              aria-expanded={ruleOpen}
              className="self-start text-xs font-semibold text-primary-ink underline underline-offset-4"
              onClick={() => setRuleOpen((o) => !o)}
            >
              {ruleOpen ? 'Hide how nannies are found' : 'How nannies are found'}
            </button>
            {ruleOpen && matchText !== null && (
              <div className="flex flex-col gap-3 rounded-[14px] border border-border p-3">
                <Field
                  label="Shift role, group or department contains"
                  hint={
                    <>
                      {also ? `${also}, whatever this says. ` : ''}Upper or lower case and extra
                      spaces do not matter.
                    </>
                  }
                >
                  <TextInput
                    value={matchText}
                    maxLength={MATCH_TEXT_MAX}
                    disabled={!canEditRule || busy}
                    onChange={setMatchText}
                  />
                </Field>
                {canEditRule && (
                  <div className="flex flex-col gap-1">
                    <Button
                      size="sm"
                      className="self-start rounded-full px-4 font-bold"
                      disabled={busy || matchText.trim() === view.rule.matchText}
                      onClick={() => void act(() => nannyApi.saveRule(branchId, matchText.trim()))}
                    >
                      Save rule
                    </Button>
                    <p className="text-xs text-muted-foreground">Takes effect at the next sync.</p>
                  </div>
                )}
              </div>
            )}
          </div>

          {!canManage && (
            <p className="text-xs text-muted-foreground">
              Changing today’s nannies needs{' '}
              <code className="font-mono text-xs">pos:checkin:update</code>.
            </p>
          )}
        </>
      )}
    </CardShell>
  );
}
