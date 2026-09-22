import { useCallback, useEffect, useState } from 'react';
import { Building2, Link2, Loader2, RefreshCw } from 'lucide-react';
import {
  branchAppApi,
  type BranchAppMapping,
  type BranchAppMappingRow,
  type BranchAppReconcileReport,
} from '@/api/platform';
import { isMissingRoute } from '@/api/client';
import { Button } from '@/components/ui/button';
import { EmptyState, ErrorNote, Loading, Panel, RouteUnavailable } from '@/components/Panel';
import { Chip, StatusMark, StatusPill, type Tone } from '@/components/Status';
import { useSession } from '@/auth/SessionContext';

/**
 * The parks, and whether each one is joined to its row in the OTO App
 * (SCRUM-268).
 *
 * Why this page exists at all: the two systems carry two branch lists, and
 * until this ticket nothing joined them — so a park opened here did not appear
 * there, a rename here did not reach there, and everybody provisioned from the
 * launcher landed in no app branch at all. None of that was visible anywhere.
 * A mapping nobody can see is a mapping nobody trusts, and the first question
 * on the morning it goes wrong is "which branch is not joined".
 *
 * So each row says one of four things, and never guesses between them:
 *
 *   - **mapped** — joined, and which app row it is joined to;
 *   - **app-only** — a row the app has that is deliberately not a park. Head
 *     Office trades nowhere and has no till; it is unmapped by design and is
 *     listed apart rather than shown as a failure;
 *   - **not mapped** — with the reason on the row, because "no app row" and
 *     "two rows it could be" are different things to do something about;
 *   - **not on this deployment** — the OTO App's tables are not here at all,
 *     which is every platform-only environment and is not a fault.
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

  return (
    <div className="flex flex-col gap-4">
      {error && <ErrorNote message={error} onRetry={() => void load()} />}

      <Panel
        title="Branches"
        description="Every park on the platform, and the row it is joined to in the OTO App. The platform's branch is the record: the app's row follows its name."
        actions={
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              className="h-9 gap-2"
              onClick={() => void load()}
              disabled={loading}
            >
              {loading ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <RefreshCw className="w-4 h-4" />
              )}
              Refresh
            </Button>
            {canReconcile && mapping?.installed && (
              <Button
                size="sm"
                className="h-9 gap-2"
                onClick={() => void reconcile()}
                disabled={busy}
                title="Join the rows that already exist on both sides. Safe to press twice: a second run changes nothing."
              >
                {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Link2 className="w-4 h-4" />}
                Reconcile with the OTO App
              </Button>
            )}
          </div>
        }
      >
        {missing ? (
          <RouteUnavailable
            what="The branch mapping"
            detail="It appears here as soon as this environment is running an API that carries it."
          />
        ) : loading && !mapping ? (
          <Loading what="branches" />
        ) : !mapping || mapping.branches.length === 0 ? (
          <EmptyState
            title="No branches here"
            detail="Either none is open yet, or this account holds no branch of its own."
          />
        ) : (
          <>
            {!mapping.installed && (
              <p className="mb-3 text-sm text-muted-foreground">
                The OTO App is not installed on this deployment, so there is nothing to join these
                to. That is not a fault — it is every environment that runs the platform on its own.
              </p>
            )}
            <ul className="flex flex-col divide-y">
              {mapping.branches.map((row) => (
                <BranchRow key={row.branchId} row={row} installed={mapping.installed} />
              ))}
            </ul>
          </>
        )}
      </Panel>

      {mapping && mapping.appOnly.length > 0 && (
        <Panel
          title="In the OTO App only"
          description="Rows the app has and the platform does not. They are unmapped on purpose: a branch here is a place that trades, and these do not."
        >
          <ul className="flex flex-col divide-y">
            {mapping.appOnly.map((row) => (
              <li key={row.appBranchId} className="flex flex-wrap items-center gap-x-3 gap-y-2 py-3">
                <StatusMark tone="idle" />
                <span className="text-sm font-semibold min-w-0 break-words">
                  {row.appBranchName}
                </span>
                <Chip>app-only</Chip>
                <span className="text-xs text-muted-foreground ml-auto">
                  No platform branch, and none expected
                </span>
              </li>
            ))}
          </ul>
        </Panel>
      )}

      {report && <ReconcileReport report={report} />}
    </div>
  );
}

/** What one branch's mapping says, in the words a reader would use. */
function mappingWords(row: BranchAppMappingRow, installed: boolean): { tone: Tone; label: string } {
  if (!installed) return { tone: 'idle', label: 'OTO App: not on this deployment' };
  if (row.status === 'APP_ONLY') return { tone: 'idle', label: 'OTO App: app-only' };
  if (row.status === 'FAILED') {
    return { tone: 'down', label: `OTO App: not mapped — ${row.error ?? 'the join failed'}` };
  }
  if (!row.appBranchId) {
    return {
      tone: 'warn',
      label: 'OTO App: not mapped — the app has no row for this park yet',
    };
  }
  return { tone: 'ok', label: 'OTO App: mapped ✓' };
}

function BranchRow({ row, installed }: { row: BranchAppMappingRow; installed: boolean }) {
  const { tone, label } = mappingWords(row, installed);
  // The app's own name for the same park, when the two have drifted. Worth
  // saying: it is what somebody reads inside that app, and a rename here brings
  // it back into line.
  const drifted =
    row.appBranchName !== null && row.appBranchName.trim() !== row.branchName.trim();

  return (
    <li className="py-3 first:pt-0 last:pb-0">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <span className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-muted text-muted-foreground">
          <Building2 className="w-4 h-4" />
        </span>
        <span className="text-sm font-bold min-w-0 break-words">{row.branchName}</span>
        <StatusPill tone={tone}>{label}</StatusPill>
      </div>
      <div className="mt-1.5 ml-11 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
        {drifted && <span>in the OTO App as “{row.appBranchName}”</span>}
        {row.appBranchId && <span className="font-mono break-all">{row.appBranchId}</span>}
      </div>
    </li>
  );
}

/**
 * What the last run did. Shown rather than a toast, because "nothing changed"
 * is the answer on every run after the first and a reader has to be able to
 * tell it apart from "nothing happened".
 */
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
  ];

  return (
    <Panel title="The last reconciliation">
      {report.writes === 0 ? (
        <p className="text-sm text-muted-foreground">
          Nothing to change — {report.alreadyMapped} branch
          {report.alreadyMapped === 1 ? '' : 'es'} already joined by id. Running it again is always
          safe and always says this.
        </p>
      ) : (
        <ul className="flex flex-col gap-1.5 text-sm">
          {lines.map((line) => (
            <li key={line} className="flex gap-2">
              <span className="text-muted-foreground">·</span>
              <span className="min-w-0 break-words">{line}</span>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}
