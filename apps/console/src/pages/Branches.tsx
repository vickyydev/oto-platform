import { useCallback, useEffect, useState } from 'react';
import { Link2, Loader2, RefreshCw } from 'lucide-react';
import {
  branchAppApi,
  type BranchAppMapping,
  type BranchAppMappingRow,
  type BranchAppReconcileReport,
} from '@/api/platform';
import { isMissingRoute } from '@/api/client';
import { Button } from '@/components/ui/button';
import { ErrorNote, Loading, RouteUnavailable } from '@/components/Panel';
import { StatusMark, type Tone } from '@/components/Status';
import { CommandBar, placeName } from '@/components/redesign/CommandBar';
import { StatusChip, Tag, TitleChip } from '@/components/redesign/chips';
import { CardShell, FactLine, FactList, PageGrid, RailNote } from '@/components/redesign/layout';
import { EmptyNote } from '@/components/redesign/StatTile';
import { useSession } from '@/auth/SessionContext';

/**
 * The parks, and whether each one is joined to its row in the OTO App
 * (SCRUM-268), laid out as the approved design draws them (SCRUM-474): one
 * equal card per park and a strip across the foot for what the two lists do
 * not share and the button that reconciles them.
 *
 * Why this page exists at all: the two systems carry two branch lists, and
 * until SCRUM-268 nothing joined them — so a park opened here did not appear
 * there, a rename here did not reach there, and everybody provisioned from the
 * launcher landed in no app branch at all. None of that was visible anywhere.
 * A mapping nobody can see is a mapping nobody trusts, and the first question
 * on the morning it goes wrong is "which branch is not joined".
 *
 * So each card says one of four things, and never guesses between them:
 *
 *   - **mapped** — joined, and which app row it is joined to;
 *   - **app-only** — a row the app has that is deliberately not a park. Head
 *     Office trades nowhere and has no till; it is unmapped by design and is
 *     listed apart rather than shown as a failure;
 *   - **not mapped** — with the reason on the card, because "no app row" and
 *     "two rows it could be" are different things to do something about;
 *   - **not on this deployment** — the OTO App's tables are not here at all,
 *     which is every platform-only environment and is not a fault.
 *
 * The page shows what the mapping route answers and nothing else: a park's
 * trading day, its tax and its stations live on other pages and are not
 * guessed at here.
 */
export function Branches() {
  const { has } = useSession();
  const canReconcile = has('admin:branch:update');

  const [mapping, setMapping] = useState<BranchAppMapping | null>(null);
  const [missing, setMissing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [report, setReport] = useState<BranchAppReconcileReport | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setMapping(await branchAppApi.mapping());
      setMissing(false);
    } catch (err) {
      if (isMissingRoute(err)) {
        setMissing(true);
      } else {
        setError(err instanceof Error ? err.message : 'The branch list could not be read');
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const reconcile = async () => {
    setBusy(true);
    setError(null);
    try {
      setReport(await branchAppApi.reconcile());
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The two lists could not be reconciled');
    } finally {
      setBusy(false);
    }
  };

  const parks = mapping?.branches ?? [];
  const joined = mapping?.installed
    ? parks.filter((row) => mappingWords(row, true).tone === 'ok').length
    : 0;

  return (
    <>
      <CommandBar
        sectionId="branches"
        badges={
          mapping && !missing && parks.length > 0 ? (
            <TitleChip>
              {parks.length} park{parks.length === 1 ? '' : 's'}
              {mapping.installed ? ` · ${joined} joined to the OTO App` : ''}
            </TitleChip>
          ) : undefined
        }
        actions={
          <Button
            variant="outline"
            size="sm"
            className="h-9 gap-2 rounded-full px-3.5"
            onClick={() => void load()}
            disabled={loading}
          >
            {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
            Refresh
          </Button>
        }
      />

      {error && <ErrorNote message={error} onRetry={() => void load()} />}

      <PageGrid>
        {missing ? (
          <CardShell span={12}>
            <RouteUnavailable
              what="The branch mapping"
              detail="It appears here as soon as this environment is running an API that carries it."
            />
          </CardShell>
        ) : loading && !mapping ? (
          <CardShell span={12}>
            <Loading what="branches" />
          </CardShell>
        ) : parks.length === 0 ? (
          <CardShell span={12}>
            <EmptyNote
              title="No branches here"
              detail="Either none is open yet, or this account holds no branch of its own."
            />
          </CardShell>
        ) : (
          parks.map((row) => (
            <BranchCard key={row.branchId} row={row} installed={mapping?.installed ?? false} />
          ))
        )}

        {mapping && !missing && (
          <ReconcileStrip
            mapping={mapping}
            canReconcile={canReconcile}
            busy={busy}
            report={report}
            onReconcile={() => void reconcile()}
          />
        )}
      </PageGrid>
    </>
  );
}

/** What one branch's mapping says, in the words a reader would use. */
function mappingWords(
  row: BranchAppMappingRow,
  installed: boolean,
): { tone: Tone; chip: string; detail: string } {
  if (!installed) {
    return { tone: 'idle', chip: 'Not on this deployment', detail: 'the OTO App is not installed here' };
  }
  if (row.status === 'APP_ONLY') return { tone: 'idle', chip: 'App-only', detail: 'app-only' };
  if (row.status === 'FAILED') {
    return { tone: 'down', chip: 'Not mapped', detail: `not mapped — ${row.error ?? 'the join failed'}` };
  }
  if (!row.appBranchId) {
    return {
      tone: 'warn',
      chip: 'Not mapped',
      detail: 'not mapped — the app has no row for this park yet',
    };
  }
  return { tone: 'ok', chip: 'Mapped', detail: 'mapped ✓' };
}

/** The park's two letters, for its tile: "Central Floresta" is CF. */
function initials(name: string): string {
  const words = placeName(name).split(/\s+/).filter(Boolean);
  return (words.length > 1 ? words[0]![0]! + words[1]![0]! : (words[0] ?? '?').slice(0, 2)).toUpperCase();
}

function BranchCard({ row, installed }: { row: BranchAppMappingRow; installed: boolean }) {
  const { tone, chip, detail } = mappingWords(row, installed);
  // The app's own name for the same park, when the two have drifted. Worth
  // saying: it is what somebody reads inside that app, and a rename here brings
  // it back into line.
  const drifted =
    row.appBranchName !== null && row.appBranchName.trim() !== row.branchName.trim();

  return (
    <section className="@container min-w-0 flex flex-col gap-3.5 rounded-[20px] border border-card-border bg-card p-5 @4xl:p-6 @2xl:col-span-6 @4xl:col-span-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <span
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[12px] bg-primary/10 text-[15px] font-extrabold text-primary"
            aria-hidden="true"
          >
            {initials(row.branchName)}
          </span>
          <div className="min-w-0">
            <h2 className="m-0 text-[16.5px] font-bold break-words">{row.branchName}</h2>
            {drifted && (
              <p className="text-[12.5px] text-muted-foreground break-words">
                in the OTO App as “{row.appBranchName}”
              </p>
            )}
          </div>
        </div>
        <StatusChip tone={tone}>{chip}</StatusChip>
      </div>

      <FactList>
        <FactLine label="OTO App">{detail}</FactLine>
        {row.appBranchId && (
          <FactLine label="App row">
            <span className="font-mono text-xs font-normal break-all">{row.appBranchId}</span>
          </FactLine>
        )}
      </FactList>
    </section>
  );
}

/**
 * Across the foot: the rows only the app has, what the last reconciliation
 * did, and the button that runs it again. The report is shown rather than a
 * toast, because "nothing changed" is the answer on every run after the first
 * and a reader has to be able to tell it apart from "nothing happened".
 */
function ReconcileStrip({
  mapping,
  canReconcile,
  busy,
  report,
  onReconcile,
}: {
  mapping: BranchAppMapping;
  canReconcile: boolean;
  busy: boolean;
  report: BranchAppReconcileReport | null;
  onReconcile: () => void;
}) {
  const appOnly = mapping.appOnly;
  const headline = !mapping.installed
    ? 'The OTO App is not installed on this deployment'
    : appOnly.length > 0
      ? `In the OTO App only: ${appOnly.map((a) => `“${a.appBranchName}”`).join(', ')}`
      : 'Nothing is in the OTO App only';
  const detail = !mapping.installed
    ? 'So there is nothing to join these parks to. That is not a fault — it is every environment that runs the platform on its own.'
    : appOnly.length > 0
      ? 'Rows the app has and the platform does not. They are unmapped on purpose: a branch here is a place that trades, and these do not.'
      : 'Every row the app has is a park listed above.';

  return (
    <CardShell span={12} bodyClassName="gap-3">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
        <Link2 className="w-[18px] h-[18px] shrink-0 text-primary" aria-hidden="true" />
        <div className="min-w-0 flex-1 basis-[280px]">
          <h2 className="m-0 text-sm font-bold break-words">{headline}</h2>
          <p className="text-[12.5px] text-muted-foreground">{detail}</p>
        </div>
        {canReconcile && mapping.installed && (
          <Button
            variant="outline"
            size="sm"
            className="h-9 gap-2 rounded-full px-4"
            onClick={onReconcile}
            disabled={busy}
            title="Join the rows that already exist on both sides. Safe to press twice: a second run changes nothing."
          >
            {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Link2 className="w-4 h-4" />}
            Reconcile with the OTO App
          </Button>
        )}
      </div>

      {appOnly.length > 0 && (
        <ul className="flex flex-col gap-1.5 pl-[34px]">
          {appOnly.map((row) => (
            <li key={row.appBranchId} className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px]">
              <StatusMark tone="idle" />
              <span className="min-w-0 font-semibold break-words">{row.appBranchName}</span>
              <Tag>app-only</Tag>
              <span className="text-xs text-muted-foreground">No platform branch, and none expected</span>
            </li>
          ))}
        </ul>
      )}

      {report && <ReconcileReport report={report} />}
    </CardShell>
  );
}

function ReconcileReport({ report }: { report: BranchAppReconcileReport }) {
  const lines: string[] = [
    ...report.matchedByName.map((m) => `Joined ${m.branchName} to the app's “${m.appBranchName}”.`),
    ...report.created.map((c) => `Created a row in the app for ${c.branchName}.`),
    ...report.appOnly
      .filter((a) => a.marked)
      .map((a) => `Marked “${a.appBranchName}” as app-only — it is not a park.`),
    ...report.ambiguous.map(
      (a) => `Left “${a.appBranchName}” alone: more than one branch it could be.`,
    ),
    ...report.unmapped.map((u) => `${u.branchName} has no row in the app (${u.reason}).`),
    ...(report.caseLowered ?? []).map(
      (c) => `Lower-cased the platform id on the app's “${c.appBranchName}”, so its events reach the till.`,
    ),
  ];
  /**
   * Said whether or not this run wrote anything: a collision is left exactly
   * as it was, so a second run writes nothing — and "nothing to change" would
   * then hide the one thing a person has to settle.
   */
  const collisions = (report.caseCollisions ?? []).map(
    (c) =>
      `Left “${c.appBranchName}” alone: it carries its platform id in upper case and another app row already holds that id. Settle which row is the park's by hand — nothing was merged.`,
  );

  return (
    <div className="rounded-[14px] bg-foreground/[0.025] px-4 py-3 @lg:ml-[34px]">
      <h3 className="text-[13px] font-bold">The last reconciliation</h3>
      {report.writes === 0 && collisions.length === 0 ? (
        <RailNote className="mt-1 text-[12.5px]">
          Nothing to change — {report.alreadyMapped} branch
          {report.alreadyMapped === 1 ? '' : 'es'} already joined by id. Running it again is always
          safe and always says this.
        </RailNote>
      ) : (
        <ul className="mt-1 flex flex-col gap-1 text-[13px]">
          {[...(report.writes === 0 ? [] : lines), ...collisions].map((line, i) => (
            <li key={`${i}:${line}`} className="flex gap-2">
              <span className="text-muted-foreground">·</span>
              <span className="min-w-0 break-words">{line}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
