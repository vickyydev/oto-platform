import { useCallback, useEffect, useState } from 'react';
import { Plus, RefreshCw } from 'lucide-react';
import { useSession } from '@/auth/SessionContext';
import { directoryApi, type BranchRow } from '@/api/platform';
import {
  EmptyState,
  ErrorNote,
  Fact,
  Loading,
  Panel,
  RouteUnavailable,
  StaleNote,
  Unreadable,
} from '@/components/Panel';
import { Button } from '@/components/ui/button';
import { Field, Select } from '@/components/Form';
import { StatusMark, StatusPill, toneForHealth } from '@/components/Status';
import { toneForPaper, toneForReachability } from '@/lib/fleetWords';
import { formatWhen, timeAgo } from '@/lib/time';
import {
  boothApi,
  isMissingRoute,
  type BoothDraft,
  type BoothLayoutRow,
  type BoothListRow,
  type BoothPrizeDraft,
  type BoothStatus,
  type BoothVersionRow,
  type PrizeInput,
  type VoucherDefinitionRow,
} from '@/components/booth/boothApi';
import { BoothSettingsPanel, type BoothSettingsEdit } from '@/components/booth/BoothSettingsPanel';
import { PrizeEditor } from '@/components/booth/PrizeEditor';
import { PrizeTable } from '@/components/booth/PrizeTable';
import { PublishPanel } from '@/components/booth/PublishPanel';
import { WheelPreview } from '@/components/booth/WheelPreview';
import {
  readAbsent,
  readFailed,
  readFailureMessage,
  readOk,
  reading,
  unread,
  type Read,
} from '@/components/booth/readState';

/**
 * Console > Booths (S2-07b, SCRUM-200): the screen a manager uses to decide
 * what the Lucky Wheel gives away.
 *
 * The page is built around the distinction the schema is built around: what
 * somebody is EDITING and what a booth is RUNNING are different things, and
 * the gap between them is closed by a publish. Editing a weight changes
 * nothing in the mall; publishing does, about a minute later, without anybody
 * at the booth being asked. So the panels are ordered the way the decision is
 * made — what is out there now, what the draft is, what the odds come to, what
 * publishing commits to — and the word "save" is never used for something that
 * reaches a television.
 *
 * **What each reading is worth travels with it** (`readState.ts`). A booth
 * whose draft has not come back and a booth with no prizes are not drawn the
 * same way, because "this wheel has no prizes on it" is a claim about a
 * machine in a shopping centre and a failed request is not evidence for it.
 *
 * **There is no draft table.** `GET /booths/:id/draft` reads the live rows, so
 * two managers editing one booth are editing the same thing and the second
 * one's Publish carries a hash that has moved. That is why every write here
 * re-reads rather than patching what is on screen.
 */
export function Booths() {
  const { me, has } = useSession();
  const canManage = has('admin:booth:manage');
  const canPublish = has('admin:booth:publish');
  const timezone = me?.branch?.timezone;

  const [branches, setBranches] = useState<BranchRow[] | null>(null);
  const [branchId, setBranchId] = useState(me?.branch?.id ?? '');
  const [booths, setBooths] = useState<Read<BoothListRow[]>>(() => unread<BoothListRow[]>([]));
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<Read<BoothDraft | null>>(() => unread<BoothDraft | null>(null));
  const [status, setStatus] = useState<Read<BoothStatus | null>>(() => unread<BoothStatus | null>(null));
  const [versions, setVersions] = useState<Read<BoothVersionRow[]>>(() => unread<BoothVersionRow[]>([]));
  const [layouts, setLayouts] = useState<BoothLayoutRow[]>([]);
  const [definitions, setDefinitions] = useState<VoucherDefinitionRow[]>([]);

  const [editing, setEditing] = useState<BoothPrizeDraft | null>(null);
  const [busy, setBusy] = useState(false);
  const [writeError, setWriteError] = useState<string | null>(null);
  const [writeUnavailable, setWriteUnavailable] = useState(false);
  const [lastPublished, setLastPublished] = useState<{ version: number } | null>(null);

  useEffect(() => {
    void directoryApi
      .branches()
      .then((r) => {
        const live = r.branches.filter((b) => !b.archived);
        setBranches(live);
        // A platform-wide account has no branch on /me, and the booth list is
        // branch-scoped, so the page opens on the first branch rather than on
        // nothing. Same reasoning as Devices.
        setBranchId((current) => current || (live[0]?.id ?? ''));
      })
      .catch(() => setBranches(null));
  }, []);

  const loadBooths = useCallback(async (branch: string) => {
    if (!branch) return;
    setBooths((held) => reading(held));
    try {
      const answer = await boothApi.list(branch);
      setBooths(readOk(answer.booths));
      setSelectedId((current) =>
        current && answer.booths.some((b) => b.id === current)
          ? current
          : (answer.booths[0]?.id ?? null),
      );
    } catch (reason) {
      setBooths((held) =>
        isMissingRoute(reason)
          ? readAbsent<BoothListRow[]>([])
          : readFailed(held, readFailureMessage(reason), []),
      );
    }
  }, []);

  const loadBooth = useCallback(async (id: string) => {
    setDraft((held) => reading(held));
    setVersions((held) => reading(held));
    setStatus((held) => reading(held));

    // Each read is settled on its own, so one failing does not empty the page.
    await Promise.allSettled([
      boothApi
        .draft(id)
        .then((d) => setDraft(readOk<BoothDraft | null>(d)))
        .catch((reason: unknown) =>
          setDraft((held) =>
            isMissingRoute(reason)
              ? readAbsent<BoothDraft | null>(null)
              : readFailed(held, readFailureMessage(reason), null),
          ),
        ),
      boothApi
        .status(id)
        .then((s) => setStatus(readOk<BoothStatus | null>(s)))
        .catch((reason: unknown) =>
          setStatus((held) =>
            isMissingRoute(reason)
              ? readAbsent<BoothStatus | null>(null)
              : readFailed(held, readFailureMessage(reason), null),
          ),
        ),
      boothApi
        .versions(id)
        .then((v) => setVersions(readOk(v.versions)))
        .catch((reason: unknown) =>
          setVersions((held) =>
            isMissingRoute(reason)
              ? readAbsent<BoothVersionRow[]>([])
              : readFailed(held, readFailureMessage(reason), []),
          ),
        ),
    ]);
  }, []);

  /**
   * The pickers' contents: the operator's designs and its voucher
   * definitions.
   *
   * Read once for the page rather than per booth — both are the operator's,
   * not the booth's, which is what makes a seasonal wheel a choice from a list
   * instead of a re-entry of six prizes. A failure here empties a dropdown and
   * nothing else, and the field says what an empty one means.
   */
  useEffect(() => {
    void boothApi
      .layouts()
      .then((r) => setLayouts(r.layouts))
      .catch(() => setLayouts([]));
    void boothApi
      .voucherDefinitions()
      .then((r) => setDefinitions(r.definitions))
      .catch(() => setDefinitions([]));
  }, []);

  useEffect(() => {
    void loadBooths(branchId);
  }, [branchId, loadBooths]);

  useEffect(() => {
    if (selectedId) void loadBooth(selectedId);
  }, [selectedId, loadBooth]);

  /**
   * One place for every write, because they all end the same way: what is on
   * screen is no longer authoritative, so it is re-read rather than patched.
   * A prize list that drifts from the rows behind it is how somebody publishes
   * a version they did not see.
   */
  const run = async (write: () => Promise<unknown>) => {
    if (!selectedId) return;
    setBusy(true);
    setWriteError(null);
    try {
      await write();
      setWriteUnavailable(false);
      await loadBooth(selectedId);
    } catch (reason) {
      if (isMissingRoute(reason)) setWriteUnavailable(true);
      else setWriteError(readFailureMessage(reason));
    } finally {
      setBusy(false);
    }
  };

  const selected = draft.value;

  if (booths.state === 'absent') {
    return (
      <RouteUnavailable
        what="Booths"
        detail="This deployment does not serve the booth admin routes yet — SCRUM-200. The page is built and fills in as soon as they are deployed here."
      />
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {branches && branches.length > 1 && (
        <Panel>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Field label="Branch">
              <Select
                value={branchId}
                onChange={(next) => {
                  setBranchId(next);
                  setSelectedId(null);
                }}
                options={branches.map((b) => ({ value: b.id, label: b.name }))}
              />
            </Field>
          </div>
        </Panel>
      )}

      <Panel
        title="Booths"
        description="Every Lucky Wheel at this branch, and the version each one is on."
        actions={
          <Button
            variant="outline"
            size="sm"
            onClick={() => void loadBooths(branchId)}
            disabled={booths.refreshing}
          >
            <RefreshCw className={booths.refreshing ? 'w-4 h-4 animate-spin' : 'w-4 h-4'} />
            Refresh
          </Button>
        }
      >
        {booths.state === 'stale' && booths.readAt !== null && (
          <StaleNote
            readAt={booths.readAt}
            message={booths.error}
            onRetry={() => void loadBooths(branchId)}
          />
        )}
        {booths.state === 'failed' ? (
          <Unreadable
            what="The booth list"
            message={booths.error}
            onRetry={() => void loadBooths(branchId)}
          />
        ) : booths.state === 'unread' ? (
          <Loading what="booths" />
        ) : booths.value.length === 0 ? (
          <EmptyState
            title="No booths at this branch"
            detail="A booth is a station of kind “booth” on a box. Add one on Devices and it appears here."
          />
        ) : (
          <ul className="flex flex-col divide-y">
            {booths.value.map((booth) => (
              <li key={booth.id}>
                <button
                  type="button"
                  onClick={() => setSelectedId(booth.id)}
                  className={`w-full text-left py-3 px-1 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg hover-elevate ${
                    booth.id === selectedId ? 'bg-muted/60' : ''
                  }`}
                >
                  <span className="font-semibold">{booth.name}</span>
                  <span className="text-sm text-muted-foreground">
                    {booth.layoutName ?? 'no design'} · {booth.activePrizes} prize
                    {booth.activePrizes === 1 ? '' : 's'} on the wheel
                  </span>
                  {booth.eligibility !== 'none' && (
                    <StatusPill tone="warn">eligibility {booth.eligibility}</StatusPill>
                  )}
                  {booth.boxId === null && <StatusPill tone="idle">no box</StatusPill>}
                  <span className="ml-auto text-xs text-muted-foreground tabular-nums">
                    {booth.publishedVersion === null
                      ? 'never published'
                      : `version ${booth.publishedVersion}`}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      {selectedId && (
        <LiveStatus status={status} timezone={timezone} onRetry={() => void loadBooth(selectedId)} />
      )}

      {draft.state === 'absent' ? (
        <RouteUnavailable
          what="The booth’s prize list and settings"
          detail="The draft route is not deployed here yet — SCRUM-200. What the booth is running is shown above, from the route that does ship."
        />
      ) : draft.state === 'failed' ? (
        <Unreadable
          what="This booth’s draft"
          message={draft.error}
          onRetry={() => selectedId && void loadBooth(selectedId)}
        />
      ) : selected === null ? (
        draft.refreshing ? <Loading what="this booth’s draft" /> : null
      ) : (
        <>
          {draft.state === 'stale' && draft.readAt !== null && (
            <StaleNote
              readAt={draft.readAt}
              message={draft.error}
              onRetry={() => selectedId && void loadBooth(selectedId)}
            />
          )}

          {!canManage && (
            <p className="rounded-xl border border-dashed px-4 py-3 text-sm text-muted-foreground">
              You can read this booth but not change it. Editing prizes needs{' '}
              <code className="font-mono text-xs">admin:booth:manage</code>; publishing needs{' '}
              <code className="font-mono text-xs">admin:booth:publish</code>.
            </p>
          )}

          <Panel
            title="Prizes and odds"
            description="What the wheel gives away, what each one costs, and whether the odds add up."
            actions={
              canManage ? (
                <Button size="sm" variant="outline" onClick={() => setEditing(blankPrize(selected))}>
                  <Plus className="w-4 h-4" />
                  Add prize
                </Button>
              ) : undefined
            }
          >
            {writeError && <ErrorNote message={writeError} />}
            {selected.prizes.length === 0 ? (
              <EmptyState
                title="No prizes on this booth"
                detail="A wheel with nothing on it refuses every press. Add the first prize to start."
              />
            ) : (
              <PrizeTable
                prizes={selected.prizes}
                spinsToday={status.state === 'read' ? (status.value?.today.spins ?? null) : null}
                cappedToday={status.value?.today.dailyCapsReached ?? []}
                onEdit={(p) => setEditing(p)}
                disabled={!canManage || busy}
              />
            )}
          </Panel>

          <div className="grid gap-4 lg:grid-cols-2">
            <Panel
              title="Wheel preview"
              description="Slice order and colours, as the television draws them."
            >
              <WheelPreview prizes={selected.prizes} />
            </Panel>

            <div className="flex flex-col gap-4">
              <BoothSettingsPanel
                draft={selected}
                layouts={layouts}
                saving={busy}
                unavailable={writeUnavailable || !canManage}
                error={null}
                onSave={(settings: BoothSettingsEdit) =>
                  void run(() => boothApi.saveSettings(selected.booth.id, settings))
                }
              />

              {canPublish ? (
                <PublishPanel
                  draft={selected}
                  publishing={busy}
                  unavailable={writeUnavailable}
                  error={null}
                  lastPublished={lastPublished}
                  timezone={timezone}
                  onPublish={(note, expectedBundleHash) =>
                    void run(async () => {
                      const answer = await boothApi.publish(selected.booth.id, {
                        note: note.trim() === '' ? null : note.trim(),
                        // Sent only when the draft had one: the API treats it
                        // as "refuse if this is not still the draft", and an
                        // absent hash is a booth with no publishable bundle,
                        // not a licence to overwrite.
                        ...(expectedBundleHash ? { expectedBundleHash } : {}),
                      });
                      setLastPublished({ version: answer.version.version });
                      await loadBooths(branchId);
                    })
                  }
                />
              ) : (
                <Panel title="Publish" description="Freezes the draft as a new version the booths pick up.">
                  <p className="text-sm text-muted-foreground">
                    Publishing needs <code className="font-mono text-xs">admin:booth:publish</code>.
                    A manager can grant it from the Login Users panel.
                  </p>
                </Panel>
              )}
            </div>
          </div>

          <VersionHistory
            versions={versions}
            timezone={timezone}
            onRetry={() => selectedId && void loadBooth(selectedId)}
          />
        </>
      )}

      {editing && selected && (
        <PrizeEditor
          // The drawer seeds its fields from the prize once, so a different
          // prize has to be a different component or it opens showing the
          // last one's numbers.
          key={editing.id || 'new-prize'}
          prize={editing}
          siblings={selected.prizes.filter((p) => p.id !== editing.id)}
          voucherDefinitions={definitions}
          saving={busy}
          saveUnavailable={writeUnavailable || !canManage}
          error={writeError}
          onClose={() => setEditing(null)}
          onSave={(next) =>
            void run(async () => {
              if (next.id === '') await boothApi.createPrize(selected.booth.id, toInput(next));
              else await boothApi.savePrize(selected.booth.id, next.id, toInput(next));
              setEditing(null);
            })
          }
          onArchive={(p) =>
            void run(async () => {
              await boothApi.archivePrize(selected.booth.id, p.id);
              setEditing(null);
            })
          }
        />
      )}
    </div>
  );
}

/**
 * What the booth is actually doing, as against what somebody is editing.
 *
 * Every reading here is the cloud's copy of what the box last REPORTED, which
 * is why the heartbeat's age sits beside it: a booth that went offline at
 * lunchtime shows lunchtime's answers. `runningVersion` null is "the box has
 * not said", not "the box is running nothing".
 */
function LiveStatus({
  status,
  timezone,
  onRetry,
}: {
  status: Read<BoothStatus | null>;
  timezone?: string | null;
  onRetry: () => void;
}) {
  if (status.state === 'absent') return <RouteUnavailable what="This booth’s live status" />;
  if (status.state === 'failed') {
    return <Unreadable what="This booth’s live status" message={status.error} onRetry={onRetry} />;
  }
  const s = status.value;
  if (!s) return status.refreshing ? <Loading what="the booth’s status" /> : null;

  const behind =
    s.config.runningVersion !== null &&
    s.config.publishedVersion !== null &&
    s.config.runningVersion < s.config.publishedVersion;

  return (
    <Panel
      title="What this booth is running"
      description="From the box’s last heartbeat and the rows it has synced — nothing on this panel asks the booth anything."
    >
      {status.state === 'stale' && status.readAt !== null && (
        <StaleNote readAt={status.readAt} message={status.error} onRetry={onRetry} />
      )}
      <dl className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Fact label="Box">
          <span className="inline-flex items-center gap-1.5">
            <StatusMark tone={toneForHealth(s.box.online ? 'ok' : 'down')} />
            {s.box.online ? 'online' : 'not reporting'}
            {s.box.lastHeartbeatAt && (
              <span className="text-muted-foreground">· {timeAgo(s.box.lastHeartbeatAt)}</span>
            )}
          </span>
        </Fact>
        <Fact label="Wheel version">
          {s.config.runningVersion === null ? (
            <span className="text-muted-foreground">not reported</span>
          ) : behind ? (
            <span style={{ color: 'hsl(var(--status-warn))' }}>
              running {s.config.runningVersion}, {s.config.publishedVersion} published
            </span>
          ) : (
            `running ${s.config.runningVersion}`
          )}
        </Fact>
        <Fact label="Printer">
          {s.printer === null ? (
            <span className="text-muted-foreground">no printer on this booth</span>
          ) : (
            <span className="flex flex-wrap items-center gap-1.5">
              <StatusPill tone={toneForReachability(s.printer.reachability)}>
                {s.printer.reachability}
              </StatusPill>
              <StatusPill tone={toneForPaper(s.printer.paperStatus)}>
                paper {s.printer.paperStatus}
              </StatusPill>
            </span>
          )}
        </Fact>
        <Fact label={`Spins today (${s.today.businessDate})`}>
          {s.today.spins}
          {s.today.unattributed > 0 && (
            <span style={{ color: 'hsl(var(--status-warn))' }}>
              {' '}
              · {s.today.unattributed} with nobody signed in
            </span>
          )}
        </Fact>
      </dl>
      {s.lastSpinAt && (
        <p className="mt-3 text-xs text-muted-foreground">
          Last spin {formatWhen(s.lastSpinAt, timezone)}.
        </p>
      )}
    </Panel>
  );
}

function VersionHistory({
  versions,
  timezone,
  onRetry,
}: {
  versions: Read<BoothVersionRow[]>;
  timezone?: string | null;
  onRetry: () => void;
}) {
  return (
    <Panel
      title="Version history"
      description="Every wheel this booth has run. A version is frozen — the spins that happened under it still point at it, so what the odds were on a given day cannot be changed by tonight’s publish."
    >
      {versions.state === 'absent' ? (
        <RouteUnavailable what="Version history" detail="Not deployed here yet — SCRUM-200." />
      ) : versions.state === 'failed' ? (
        <Unreadable what="The version history" message={versions.error} onRetry={onRetry} />
      ) : versions.state === 'unread' ? (
        <Loading what="versions" />
      ) : versions.value.length === 0 ? (
        <EmptyState title="Nothing published yet" detail="This booth has never been given a wheel." />
      ) : (
        <ul className="flex flex-col divide-y">
          {versions.value.map((v) => (
            <li key={v.id} className="py-2.5 flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <span className="font-semibold tabular-nums">v{v.version}</span>
              <span className="text-sm text-muted-foreground">
                {formatWhen(v.publishedAt, timezone)}
              </span>
              {v.note ? (
                <span className="text-sm break-words">“{v.note}”</span>
              ) : (
                <span className="text-sm text-muted-foreground">no note</span>
              )}
              <span className="ml-auto font-mono text-[11px] text-muted-foreground">
                {v.bundleHash.slice(0, 8)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

/** The editor's prize, as the create and edit routes take it. */
function toInput(prize: BoothPrizeDraft): PrizeInput {
  return {
    nameEn: prize.nameEn,
    nameTh: prize.nameTh,
    wheelLabel: prize.wheelLabel,
    weightBp: prize.weightBp,
    active: prize.active,
    expiryDays: prize.expiryDays,
    dailyCap: prize.dailyCap,
    costSatang: prize.costSatang,
    sliceColor: prize.sliceColor,
    textColor: prize.textColor,
    sortOrder: prize.sortOrder,
    voucherDefinitionId: prize.voucherDefinitionId,
  };
}

/**
 * A new slice.
 *
 * Weight zero rather than a guessed share: an invented weight is one more
 * number to notice and correct, and a zero is visibly not a decision. It goes
 * on the end of the wheel.
 */
function blankPrize(draft: BoothDraft): BoothPrizeDraft {
  return {
    id: '',
    nameEn: '',
    nameTh: null,
    wheelLabel: null,
    weightBp: 0,
    active: true,
    expiryDays: null,
    dailyCap: null,
    costSatang: 0,
    sliceColor: null,
    textColor: null,
    sortOrder: draft.prizes.reduce((max, p) => Math.max(max, p.sortOrder + 1), 0),
    voucherDefinitionId: null,
    voucherDefinitionCode: null,
    effectiveExpiryDays: null,
  };
}
