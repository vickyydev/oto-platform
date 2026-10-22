import { archiveFailureMessage } from '@oto/admin-screens/lifted/organisation';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link2, Loader2, RefreshCw } from 'lucide-react';
import {
  BranchArchiveConfirmation,
  BranchesPanelWithPorts,
} from '@oto/admin-screens/lifted/admin/branches/BranchesPanel';
import {
  branchAppApi,
  type BranchAppMapping,
  type BranchAppMappingRow,
  type BranchAppReconcileReport,
} from '@/api/platform';
import { apiBranchToBranch, organisationApi, type OrganisationBranch } from '@/api/organisation';
import { isMissingRoute } from '@/api/client';
import { Button } from '@/components/ui/button';
import { Drawer } from '@/components/Drawer';
import { ErrorNote, Loading, PermissionRequired, RouteUnavailable } from '@/components/Panel';
import { StatusMark, type Tone } from '@/components/Status';
import { CommandBar } from '@/components/redesign/CommandBar';
import { StatusChip, Tag, TitleChip } from '@/components/redesign/chips';
import { CardShell, FactLine, FactList, PageGrid, RailNote } from '@/components/redesign/layout';
import { displayName, useSession } from '@/auth/SessionContext';

/** The original branch controls and the existing mapping, on one branch list. */
export function Branches() {
  const { me, has, permissions, switchBranch } = useSession();
  const allowed = has('admin:branch:read');
  const [branches, setBranches] = useState<OrganisationBranch[] | null>(null);
  const [mapping, setMapping] = useState<BranchAppMapping | null>(null);
  const [missing, setMissing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mappingError, setMappingError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [report, setReport] = useState<BranchAppReconcileReport | null>(null);
  const [editing, setEditing] = useState<OrganisationBranch | null>(null);
  const request = useRef(0);
  const editorRequest = useRef(0);
  const canOperator = (permission: string) =>
    permissions.some(
      (grant) =>
        grant.permission === permission &&
        grant.scopeType === 'operator' &&
        (grant.scopeId === null || grant.scopeId === me?.account.operatorId),
    );
  const canUpdate = (id: string) =>
    canOperator('admin:branch:update') ||
    permissions.some(
      (grant) =>
        grant.permission === 'admin:branch:update' &&
        grant.scopeType === 'branch' &&
        grant.scopeId === id,
    );

  const load = useCallback(async () => {
    const current = ++request.current;
    setLoading(true);
    setError(null);
    setMappingError(null);
    const [directory, appMapping] = await Promise.allSettled([
      organisationApi.branchesApi.list(),
      branchAppApi.mapping(),
    ]);
    if (current !== request.current) return;
    if (directory.status === 'fulfilled') setBranches(directory.value.branches);
    else
      setError(
        directory.reason instanceof Error
          ? directory.reason.message
          : 'The branches could not be read.',
      );
    if (appMapping.status === 'fulfilled') {
      setMapping(appMapping.value);
      setMissing(false);
    } else if (isMissingRoute(appMapping.reason)) {
      setMapping(null);
      setMissing(true);
    } else {
      setMapping(null);
      setMappingError(
        appMapping.reason instanceof Error
          ? appMapping.reason.message
          : 'The mapping could not be read.',
      );
    }
    setLoading(false);
    if (directory.status === 'rejected') throw directory.reason;
  }, []);
  useEffect(() => {
    if (allowed) void load().catch(() => {});
    return () => {
      request.current++;
    };
  }, [allowed, load]);

  const reconcile = async () => {
    if (busy) return;
    setBusy(true);
    setMappingError(null);
    try {
      setReport(await branchAppApi.reconcile());
      await load();
    } catch (failure) {
      setMappingError(
        failure instanceof Error ? failure.message : 'The two lists could not be reconciled.',
      );
    } finally {
      setBusy(false);
    }
  };

  if (!allowed) return <PermissionRequired permission="admin:branch:read" />;
  const views = (branches ?? []).map(apiBranchToBranch);
  const activeBranch = views.find((row) => row.apiId === me?.branch?.id) ?? null;
  const joined = mapping?.installed
    ? mapping.branches.filter((row) => mappingWords(row, true).tone === 'ok').length
    : 0;
  const editVersion = editorRequest.current;
  return (
    <>
      <CommandBar
        sectionId="branches"
        badges={
          branches ? (
            <TitleChip>
              {branches.length} park{branches.length === 1 ? '' : 's'}
              {mapping?.installed ? ' · ' + joined + ' joined to the OTO App' : ''}
            </TitleChip>
          ) : undefined
        }
        actions={
          <Button
            variant="outline"
            size="sm"
            className="h-9 gap-2 rounded-full px-3.5"
            disabled={loading}
            onClick={() => void load().catch(() => {})}
          >
            {loading ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <RefreshCw className="w-4 h-4" />
            )}
            Refresh
          </Button>
        }
      />
      {error && <ErrorNote message={error} onRetry={() => void load().catch(() => {})} />}
      {mappingError && (
        <ErrorNote message={mappingError} onRetry={() => void load().catch(() => {})} />
      )}
      {missing && (
        <RouteUnavailable
          what="The branch mapping"
          detail="The branch controls still use the platform; mapping appears when this deployment carries it."
        />
      )}
      {!branches && loading ? (
        <Loading what="branches" />
      ) : (
        branches && (
          <BranchesPanelWithPorts
            key={me?.account.id + ':' + (activeBranch?.apiId ?? 'unseated')}
            ports={{
              branches: views,
              activeBranch,
              actorName: displayName(me),
              canCreate: canOperator('admin:branch:create'),
              branchesApi: organisationApi.branchesApi,
              upsertBranch: async (branch) => {
                await organisationApi.branchesApi.create({
                  name: branch.name,
                  code: branch.id,
                  timezone: branch.timezone,
                  country: branch.country,
                });
                await load();
              },
              onSelectBranch: async (slug) => {
                const target = views.find((row) => row.id === slug);
                if (!target?.apiId)
                  throw new Error('That branch has not been saved to the platform.');
                await switchBranch(target.apiId);
              },
              afterClone: async () => {
                await load();
              },
              renderBranchDetails: (branch) => {
                const row = mapping?.branches.find((item) => item.branchId === branch.apiId);
                return row ? (
                  <BranchMappingDetails row={row} installed={mapping?.installed ?? false} />
                ) : (
                  <p className="mt-2 text-xs text-muted-foreground">
                    {missing
                      ? 'Mapping is not on this deployment.'
                      : mappingError
                        ? 'Mapping could not be read.'
                        : 'No mapping was returned for this park.'}
                  </p>
                );
              },
              renderBranchActions: (branch) =>
                canUpdate(branch.apiId ?? '') ? (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      editorRequest.current++;
                      setEditing(branches.find((row) => row.id === branch.apiId) ?? null);
                    }}
                  >
                    Edit
                  </Button>
                ) : null,
            }}
          />
        )
      )}
      <PageGrid>
        {mapping && !missing && (
          <ReconcileStrip
            mapping={mapping}
            canReconcile={canOperator('admin:branch:update')}
            busy={busy}
            report={report}
            onReconcile={() => void reconcile()}
          />
        )}
      </PageGrid>
      {editing && (
        <BranchEditor
          key={editing.id + ':' + editVersion}
          branch={editing}
          onClose={() => {
            if (editorRequest.current === editVersion) setEditing(null);
          }}
          onSave={async (body) => {
            await organisationApi.branchesApi.update(editing.id, body);
            await load();
          }}
          onArchive={async (confirmName) => {
            await organisationApi.branchesApi.update(editing.id, { archived: true, confirmName });
            await load();
          }}
        />
      )}
    </>
  );
}

function BranchMappingDetails({
  row,
  installed,
}: {
  row: BranchAppMappingRow;
  installed: boolean;
}) {
  const { tone, chip, detail } = mappingWords(row, installed);
  const drifted = row.appBranchName !== null && row.appBranchName.trim() !== row.branchName.trim();
  return (
    <div className="mt-2 flex min-w-0 flex-col gap-2">
      <div>
        <StatusChip tone={tone}>{chip}</StatusChip>
      </div>
      {drifted && (
        <p className="text-xs text-muted-foreground break-words">
          in the OTO App as “{row.appBranchName}”
        </p>
      )}
      <FactList>
        <FactLine label="OTO App">{detail}</FactLine>
        {row.appBranchId && (
          <FactLine label="App row">
            <span className="font-mono text-xs font-normal break-all">{row.appBranchId}</span>
          </FactLine>
        )}
      </FactList>
    </div>
  );
}

const DAYS = [
  ['mon', 'Monday'],
  ['tue', 'Tuesday'],
  ['wed', 'Wednesday'],
  ['thu', 'Thursday'],
  ['fri', 'Friday'],
  ['sat', 'Saturday'],
  ['sun', 'Sunday'],
] as const;
type DayKey = (typeof DAYS)[number][0];
type Hours = Partial<Record<DayKey, { open: string; close: string } | null>>;
function editableHours(raw: unknown): raw is Hours {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return false;
  return Object.entries(raw).every(
    ([key, value]) =>
      DAYS.some(([day]) => day === key) &&
      (value === null ||
        (typeof value === 'object' &&
          !Array.isArray(value) &&
          Object.keys(value).every((field) => field === 'open' || field === 'close') &&
          typeof value.open === 'string' &&
          typeof value.close === 'string' &&
          /^([01]\d|2[0-3]):[0-5]\d$/.test(value.open) &&
          /^([01]\d|2[0-3]):[0-5]\d$/.test(value.close))),
  );
}

function BranchEditor({
  branch,
  onClose,
  onSave,
  onArchive,
}: {
  branch: OrganisationBranch;
  onClose: () => void;
  onSave: (body: Record<string, unknown>) => Promise<void>;
  onArchive: (confirmName: string) => Promise<void>;
}) {
  const [name, setName] = useState(branch.name);
  const [timezone, setTimezone] = useState(branch.timezone);
  const [dayStart, setDayStart] = useState(branch.businessDayStart ?? '');
  const initialMode =
    branch.openingHours === null
      ? 'unknown'
      : editableHours(branch.openingHours)
        ? 'weekly'
        : 'legacy';
  const [hoursMode, setHoursMode] = useState(initialMode);
  const [hours, setHours] = useState<Hours>(() =>
    editableHours(branch.openingHours) ? branch.openingHours : {},
  );
  const [hoursChanged, setHoursChanged] = useState(false);
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [archiving, setArchiving] = useState(false);
  const [archiveError, setArchiveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fieldClass =
    'w-full min-w-0 rounded-xl border border-input bg-background px-3 py-2 text-sm';
  const save = async () => {
    if (saving) return;
    const body: Record<string, unknown> = {};
    if (!name.trim()) {
      setError('Enter a branch name.');
      return;
    }
    if (name.trim() !== branch.name) body.name = name.trim();
    if (timezone !== branch.timezone) body.timezone = timezone;
    if (dayStart !== (branch.businessDayStart ?? '')) body.businessDayStart = dayStart;
    if (hoursChanged && hoursMode !== 'legacy') {
      if (
        hoursMode === 'weekly' &&
        Object.values(hours).some((day) => day && (!day.open || !day.close))
      ) {
        setError('Enter opening and closing times for every open day.');
        return;
      }
      body.openingHours = hoursMode === 'unknown' ? null : hours;
    }
    if (Object.keys(body).length === 0) {
      onClose();
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await onSave(body);
      onClose();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'The branch could not be saved.');
    } finally {
      setSaving(false);
    }
  };
  const archive = async (confirmName: string) => {
    if (archiving || confirmName !== branch.name) return;
    setArchiving(true);
    setArchiveError(null);
    try {
      await onArchive(confirmName);
      onClose();
    } catch (failure) {
      setArchiveError(archiveFailureMessage(failure, 'The branch could not be archived.'));
    } finally {
      setArchiving(false);
    }
  };
  const closeEditor = () => {
    if (archiveOpen) {
      if (!archiving) setArchiveOpen(false);
      return;
    }
    onClose();
  };
  return (
    <Drawer
      title="Edit branch"
      subtitle={branch.name}
      onClose={closeEditor}
      footer={
        <div className="flex gap-2">
          <Button disabled={saving} onClick={() => void save()}>
            Save branch
          </Button>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
        </div>
      }
    >
      {error && (
        <div role="alert">
          <ErrorNote message={error} />
        </div>
      )}
      <label className="flex flex-col gap-1 text-sm font-semibold">
        Branch name
        <input
          className={fieldClass}
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
      </label>
      <label className="flex flex-col gap-1 text-sm font-semibold">
        Timezone
        <input
          className={fieldClass}
          value={timezone}
          onChange={(event) => setTimezone(event.target.value)}
        />
      </label>
      <label className="flex flex-col gap-1 text-sm font-semibold">
        Business day start
        <input
          className={fieldClass}
          type="time"
          step="1"
          value={dayStart}
          onChange={(event) => setDayStart(event.target.value)}
        />
      </label>
      <label className="flex flex-col gap-1 text-sm font-semibold">
        Opening hours
        <select
          className={fieldClass}
          value={hoursMode}
          onChange={(event) => {
            setHoursMode(event.target.value as typeof hoursMode);
            setHoursChanged(true);
          }}
        >
          {initialMode === 'legacy' && <option value="legacy">Stored hours (unchanged)</option>}
          <option value="unknown">Not set</option>
          <option value="weekly">Weekly hours</option>
        </select>
      </label>
      {hoursMode === 'unknown' && (
        <p className="text-sm text-muted-foreground">
          Opening hours have not been set. This does not mean the park is closed.
        </p>
      )}
      {hoursMode === 'legacy' && (
        <p className="text-sm text-muted-foreground">
          The stored hours use a format this editor cannot change. They stay unchanged when other
          details are saved. Choose Weekly hours or Not set to replace them.
        </p>
      )}
      {hoursMode === 'weekly' && (
        <div className="flex min-w-0 flex-col gap-3">
          {DAYS.map(([day, label]) => (
            <div key={day} className="min-w-0 rounded-xl border p-3">
              <label className="flex items-center gap-2 text-sm font-semibold">
                <input
                  type="checkbox"
                  checked={!!hours[day]}
                  onChange={(event) => {
                    setHoursChanged(true);
                    setHours((held) => ({
                      ...held,
                      [day]: event.target.checked ? { open: '', close: '' } : null,
                    }));
                  }}
                />
                {label} open
              </label>
              {hours[day] && (
                <div className="mt-2 grid min-w-0 grid-cols-2 gap-2">
                  <label className="min-w-0 text-xs">
                    Open
                    <input
                      aria-label={label + ' opens'}
                      className={fieldClass}
                      type="time"
                      value={hours[day]?.open ?? ''}
                      onChange={(event) => {
                        setHoursChanged(true);
                        setHours((held) => ({
                          ...held,
                          [day]: { open: event.target.value, close: held[day]?.close ?? '' },
                        }));
                      }}
                    />
                  </label>
                  <label className="min-w-0 text-xs">
                    Close
                    <input
                      aria-label={label + ' closes'}
                      className={fieldClass}
                      type="time"
                      value={hours[day]?.close ?? ''}
                      onChange={(event) => {
                        setHoursChanged(true);
                        setHours((held) => ({
                          ...held,
                          [day]: { open: held[day]?.open ?? '', close: event.target.value },
                        }));
                      }}
                    />
                  </label>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
      <div className="rounded-xl border border-destructive/25 p-4">
        <h3 className="font-semibold">Archive branch</h3>
        <p className="mt-1 text-sm text-muted-foreground">
          Hide this branch from active pickers while keeping its records.
        </p>
        <Button
          className="mt-3"
          variant="outline"
          disabled={saving || archiving}
          onClick={() => {
            setArchiveError(null);
            setArchiveOpen(true);
          }}
        >
          Archive branch
        </Button>
      </div>
      <BranchArchiveConfirmation
        name={branch.name}
        open={archiveOpen}
        busy={archiving}
        error={archiveError}
        onCancel={() => setArchiveOpen(false)}
        onConfirm={archive}
      />
    </Drawer>
  );
}

/** What one branch's mapping says, in the words a reader would use. */
function mappingWords(
  row: BranchAppMappingRow,
  installed: boolean,
): { tone: Tone; chip: string; detail: string } {
  if (!installed) {
    return {
      tone: 'idle',
      chip: 'Not on this deployment',
      detail: 'the OTO App is not installed here',
    };
  }
  if (row.status === 'APP_ONLY') return { tone: 'idle', chip: 'App-only', detail: 'app-only' };
  if (row.status === 'FAILED') {
    return {
      tone: 'down',
      chip: 'Not mapped',
      detail: `not mapped — ${row.error ?? 'the join failed'}`,
    };
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
            <li
              key={row.appBranchId}
              className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px]"
            >
              <StatusMark tone="idle" />
              <span className="min-w-0 font-semibold break-words">{row.appBranchName}</span>
              <Tag>app-only</Tag>
              <span className="text-xs text-muted-foreground">
                No platform branch, and none expected
              </span>
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
      (c) =>
        `Lower-cased the platform id on the app's “${c.appBranchName}”, so its events reach the till.`,
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
