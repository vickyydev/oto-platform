import { useCallback, useEffect, useState } from 'react';
import { RefreshCw, Ticket, TriangleAlert, UserPlus, Users, X } from 'lucide-react';
import { staffCandidates, type BranchStaffMember } from '@/api/fleet';
import { ErrorNote, Loading, RouteUnavailable } from '@/components/Panel';
import { Field, Select, TextInput } from '@/components/Form';
import { Button } from '@/components/ui/button';
import { StatusChip } from '@/components/redesign/chips';
import { CardShell, StripedList } from '@/components/redesign/layout';
import { cn } from '@/lib/utils';
import { ApiError, boothApi, isMissingRoute, type BoothDutyRule, type BoothDutyView } from './boothApi';
import {
  APP_STATE_NOTE,
  DUTY_SOURCE,
  UNMATCHED_REASON,
  initialOf,
  labelLine,
  logLineText,
  logTime,
} from './todayStaff';

/**
 * Today's staff (SCRUM-473, plan D4-D6): who works this booth today, as the
 * OTO App's rota says, merged into the one label every voucher prints.
 *
 * The roster with where each person came from, the label preview, "Sync now",
 * the names the sync could not match (said plainly, never dropped), manual add
 * and remove, and the day's log lines in quiet mono — the approved "Today's
 * staff" card, on the page's sheet (SCRUM-474). The card reads and writes its
 * own routes, so the rest of the page is not re-read on every change here.
 *
 * On the page's card language: the people as striped rows like Booth staff,
 * the label on a primary wash, a warning with its triangle, the forms in the
 * bordered boxes every card uses for them, and the log on the ruled foot.
 */
export function TodayStaffPanel({
  boothId,
  branchId,
  timezone,
  readOnly,
  id,
  className,
}: {
  boothId: string;
  branchId: string;
  timezone: string | null | undefined;
  /** The caller may read the roster but not change it (`admin:booth:staff_assign`). */
  readOnly: boolean;
  id?: string;
  className?: string;
}) {
  const [view, setView] = useState<BoothDutyView | null>(null);
  const [missing, setMissing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [candidates, setCandidates] = useState<BranchStaffMember[] | null>(null);
  const [adding, setAdding] = useState('');
  const [name, setName] = useState('');
  const [ruleOpen, setRuleOpen] = useState(false);
  const [rule, setRule] = useState<BoothDutyRule | null>(null);

  const load = useCallback(async () => {
    try {
      const next = await boothApi.duty(boothId);
      setView(next);
      setRule(next.rule);
      setError(null);
    } catch (err) {
      if (isMissingRoute(err)) setMissing(true);
      else setError(err instanceof ApiError ? err.message : 'Today’s staff could not be read');
    }
  }, [boothId]);

  useEffect(() => {
    setView(null);
    setMissing(false);
    void load();
  }, [load]);

  useEffect(() => {
    if (readOnly) return;
    let cancelled = false;
    void staffCandidates(branchId)
      .then((r) => !cancelled && setCandidates(r.staff))
      .catch(() => !cancelled && setCandidates([]));
    return () => {
      cancelled = true;
    };
  }, [branchId, readOnly]);

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'That could not be saved');
    } finally {
      setBusy(false);
    }
  };

  const syncButton = !readOnly && view && (
    <Button
      size="sm"
      variant="outline"
      className="rounded-full px-3.5"
      disabled={busy}
      onClick={() => void act(() => boothApi.syncDuty(boothId))}
    >
      <RefreshCw className={busy ? 'w-4 h-4 animate-spin' : 'w-4 h-4'} />
      Sync now
    </Button>
  );

  if (missing) {
    return (
      <CardShell id={id} className={className} icon={Users} title="Today’s staff">
        <RouteUnavailable what="Today’s staff" detail="This deployment does not sync the booth’s roster yet." />
      </CardShell>
    );
  }

  const onRoster = new Set(view?.roster.flatMap((r) => (r.accountId ? [r.accountId] : [])) ?? []);
  const note = view?.lastSync ? APP_STATE_NOTE[view.lastSync.appState] : null;
  const unmatched = view?.lastSync?.unmatched ?? [];

  return (
    <CardShell
      id={id}
      className={className}
      icon={Users}
      title="Today’s staff"
      note={
        view
          ? `who works this booth on ${view.businessDate}, from the OTO App’s rota — their names print together on every voucher`
          : 'who works this booth today, from the OTO App’s rota'
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
                <span className="min-w-0 break-words">{logLineText(line)}</span>
              </li>
            ))}
          </ul>
        ) : undefined
      }
    >
      {error && <ErrorNote message={error} onRetry={() => void load()} />}
      {!view ? (
        !error && <Loading what="today’s staff" />
      ) : (
        <>
          {view.roster.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Nobody is assigned for today.{' '}
              {view.lastSync
                ? `The rota has named nobody for this booth since ${logTime(view.lastSync.syncedAt, timezone)}.`
                : 'The rota has not been read yet today — it is read when the park opens, or now with Sync now.'}
            </p>
          ) : (
            <StripedList label="Today’s staff">
              {view.roster.map((person, index) => (
                <li key={person.id} className="flex items-center gap-3 px-3 py-2.5">
                  <span
                    aria-hidden="true"
                    className={cn(
                      'flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-sm font-bold',
                      // The artboard alternates the two suite washes down the
                      // roster, so two people side by side read as two.
                      index % 2 === 0
                        ? 'bg-secondary text-secondary-foreground'
                        : 'bg-primary/10 text-primary-ink',
                    )}
                  >
                    {initialOf(person.displayName)}
                  </span>
                  <div className="min-w-0 flex-1">
                    {/* Wraps rather than truncates (SCRUM-477): a long name was
                        cut with an ellipsis even at full width, and the name
                        is the one thing this row exists to show. */}
                    <div className="break-words text-[13.5px] font-semibold">{person.displayName}</div>
                    <div className="text-xs text-muted-foreground">
                      {person.accountId ? 'May sign in today' : 'No login — named on the voucher only'}
                    </div>
                  </div>
                  <StatusChip tone={DUTY_SOURCE[person.source].tone}>{DUTY_SOURCE[person.source].label}</StatusChip>
                  {!readOnly && (
                    <button
                      type="button"
                      aria-label={`Take ${person.displayName} off today’s roster`}
                      disabled={busy}
                      onClick={() => void act(() => boothApi.removeDuty(boothId, person.id))}
                      className="shrink-0 rounded-full p-1.5 text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground disabled:opacity-50"
                    >
                      <X className="w-4 h-4" />
                    </button>
                  )}
                </li>
              ))}
            </StripedList>
          )}

          <div className="flex items-center gap-2.5 rounded-[14px] border border-primary/30 bg-primary/10 px-3.5 py-2.5 text-sm">
            <Ticket className="w-4 h-4 shrink-0 text-primary-ink" aria-hidden="true" />
            <span className="min-w-0 break-words">
              {view.label ? (
                <>
                  On every voucher today: <strong>{view.label}</strong>
                </>
              ) : (
                labelLine(null)
              )}
            </span>
          </div>

          {note && (
            <p className="flex gap-2.5 rounded-[14px] border border-status-warn/30 bg-status-warn/15 px-3.5 py-2.5 text-sm">
              <TriangleAlert className="mt-0.5 w-4 h-4 shrink-0 text-status-warn" aria-hidden="true" />
              <span className="min-w-0 break-words">{note}</span>
            </p>
          )}

          {unmatched.length > 0 && (
            <div className="flex flex-col gap-1 rounded-[14px] border border-border p-3 text-sm">
              <p className="font-semibold">On the rota, but not matched to an account</p>
              <ul className="flex flex-col gap-0.5 text-muted-foreground">
                {unmatched.map((u) => (
                  <li key={`${u.name}-${u.reason}`} className="break-words">
                    {u.name} — {UNMATCHED_REASON[u.reason]}
                  </li>
                ))}
              </ul>
              <p className="text-xs text-muted-foreground">
                Not on the voucher until linked, or added here by hand.
              </p>
            </div>
          )}

          {!readOnly && (
            <div className="flex flex-col gap-3 rounded-[14px] border border-border p-3">
              <p className="text-sm font-semibold">Add somebody for today</p>
              <div className="grid gap-3 @md:grid-cols-[1fr_auto] @md:items-end">
                <Field label="A member of staff">
                  <Select
                    value={adding}
                    onChange={setAdding}
                    disabled={busy || candidates === null}
                    placeholder={candidates === null ? 'Loading staff…' : '— choose somebody —'}
                    options={(candidates ?? [])
                      .filter((c) => !onRoster.has(c.accountId))
                      .map((c) => ({ value: c.accountId, label: c.name ?? c.phone ?? c.accountId }))}
                  />
                </Field>
                <Button
                  size="sm"
                  className="rounded-full px-4 font-bold"
                  disabled={busy || adding === ''}
                  onClick={() => {
                    const accountId = adding;
                    setAdding('');
                    void act(() => boothApi.addDuty(boothId, { accountId }));
                  }}
                >
                  <UserPlus className="w-4 h-4" />
                  Add
                </Button>
              </div>
              <div className="grid gap-3 @md:grid-cols-[1fr_auto] @md:items-end">
                <Field label="Or a name alone" hint="Somebody with no login — named on the voucher, never signs in.">
                  <TextInput value={name} onChange={setName} placeholder="e.g. Nok" disabled={busy} />
                </Field>
                <Button
                  size="sm"
                  variant="outline"
                  className="rounded-full bg-card px-4"
                  disabled={busy || name.trim() === ''}
                  onClick={() => {
                    const displayName = name.trim();
                    setName('');
                    void act(() => boothApi.addDuty(boothId, { displayName }));
                  }}
                >
                  <Users className="w-4 h-4" />
                  Add name
                </Button>
              </div>
            </div>
          )}

          <div className="flex flex-col gap-2">
            <button
              type="button"
              aria-expanded={ruleOpen}
              className="self-start text-xs font-semibold text-primary-ink underline underline-offset-4"
              onClick={() => setRuleOpen((o) => !o)}
            >
              {ruleOpen ? 'Hide how staff are found' : 'How staff are found'}
            </button>
            {ruleOpen && rule && (
              <div className="flex flex-col gap-3 rounded-[14px] border border-border p-3">
                <Field
                  label="Shift group, department or role contains"
                  hint="The park schedules the booth under “Sale Booth”. Upper or lower case and trailing spaces do not matter."
                >
                  <TextInput
                    value={rule.groupText}
                    disabled={readOnly || busy}
                    onChange={(groupText) => setRule({ ...rule, groupText })}
                  />
                </Field>
                <Field label="Duty block name contains" hint="Matches duties such as “Sales booth”. Empty matches nothing.">
                  <TextInput
                    value={rule.dutyText}
                    disabled={readOnly || busy}
                    onChange={(dutyText) => setRule({ ...rule, dutyText })}
                  />
                </Field>
                {!readOnly && (
                  <div className="flex flex-col gap-1">
                    <Button
                      size="sm"
                      className="self-start rounded-full px-4 font-bold"
                      disabled={
                        busy || (rule.groupText === view.rule.groupText && rule.dutyText === view.rule.dutyText)
                      }
                      onClick={() => void act(() => boothApi.saveDutyRule(boothId, rule))}
                    >
                      Save rule
                    </Button>
                    <p className="text-xs text-muted-foreground">Takes effect at the next sync.</p>
                  </div>
                )}
              </div>
            )}
          </div>

          {readOnly && (
            <p className="text-xs text-muted-foreground">
              Changing today’s staff needs <code className="font-mono text-xs">admin:booth:staff_assign</code>.
            </p>
          )}
        </>
      )}
    </CardShell>
  );
}
