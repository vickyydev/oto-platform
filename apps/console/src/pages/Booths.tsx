import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Check, Disc3, FerrisWheel, History, Plus, RefreshCw } from 'lucide-react';
import type { BoothSpins } from '@/api/vouchers';
import { useSession } from '@/auth/SessionContext';
import { directoryApi, type BranchRow } from '@/api/platform';
import { ErrorNote, Loading, RouteUnavailable, StaleNote, Unreadable } from '@/components/Panel';
import { Button } from '@/components/ui/button';
import { CheckRow } from '@/components/Form';
import { StatusMark } from '@/components/Status';
import { BarChip, FilterChip, SelectChip, Tag } from '@/components/redesign/chips';
import { CardShell, PageGrid, Rail, StripedList } from '@/components/redesign/layout';
import { EmptyNote, StatTile } from '@/components/redesign/StatTile';
import { formatWhen, timeAgo } from '@/lib/time';
import {
  boothApi,
  isMissingRoute,
  publishedSessionMinutes,
  type BoothDraft,
  type BoothLayoutRow,
  type BoothListRow,
  type BoothPrizeDraft,
  type BoothScreenRow,
  type BoothStaffRow,
  type BoothPinResult,
  type BoothStatus,
  type BoothVersionRow,
  type MintedPairingCode,
  type PrizeInput,
  type VoucherDefinitionRow,
} from '@/components/booth/boothApi';
import { BoothBoxCard } from '@/components/booth/BoothBoxCard';
import { BoothCommandBar } from '@/components/booth/BoothCommandBar';
import { BoothScreensPanel, boothBoxPlace } from '@/components/booth/BoothScreensPanel';
import {
  BoothSettingsEditor,
  BoothSettingsPanel,
  type BoothSettingsEdit,
} from '@/components/booth/BoothSettingsPanel';
import { BoothSpinsPanel } from '@/components/booth/BoothSpinsPanel';
import { BoothSetupChecklist } from '@/components/booth/BoothSetupChecklist';
import { BoothStaffPanel } from '@/components/booth/BoothStaffPanel';
import { boothSetupSteps } from '@/components/booth/boothState';
import { PrizeEditor } from '@/components/booth/PrizeEditor';
import { ArchivedPrizes, PrizeTable } from '@/components/booth/PrizeTable';
import { PublishPanel } from '@/components/booth/PublishPanel';
import { TodayStaffPanel } from '@/components/booth/TodayStaffPanel';
import { VoucherSlipEditor, VoucherSlipPanel } from '@/components/booth/VoucherSlipPanel';
import { WheelPreview, prizeInks } from '@/components/booth/WheelPreview';
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
 * the gap between them is closed by a publish and then by the box pulling it.
 * Editing a weight changes nothing in the mall; publishing writes the version
 * the booth will run once its box has pulled it, without anybody at the booth
 * being asked. So the cards are ordered the way the decision is made — what
 * is out there now, what the draft is, what the odds come to, what publishing
 * commits to — and the word "save" is never used for something that reaches a
 * television.
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
 *
 * **Laid out on the approved sheet (SCRUM-474, Main.dc.html).** The command
 * bar is the booth's: its name, that it is a Lucky Wheel, whether it is set
 * up, whether its box is online and which wheel is published. The booths at
 * the branch are the chip row under it. Then the twelve-column sheet: four
 * tiles for today, a wide column for the wheel and what runs it — the prizes,
 * the publish, who may sign in, the day's spins, the versions — and a rail
 * for the day and the box: today's staff, the voucher slip, the box's own
 * report, the wheel as the television draws it, the settings, the screens.
 * Every card is the height of what it holds and no taller: the two columns
 * end where their last card ends, and nothing is stretched to meet an edge.
 * The forms — a prize, the settings, the slip — open in drawers, so no form
 * stacks inline on the sheet.
 */
/**
 * Which card a write belongs to, so its refusal is drawn where the button was
 * pressed rather than in whichever card happens to hold an error slot.
 * `archived` is the Restore under "Show archived prizes", below the prize
 * table — its refusal is drawn beside the list, not above a table's height of
 * rows.
 */
type WriteSite = 'prizes' | 'archived' | 'settings' | 'slip' | 'publish' | 'screens' | 'staff';

/** Today's spins as the Spins card read them, and whether every one is on screen. */
interface TodaySpins {
  spins: BoothSpins;
  whole: boolean;
}

export function Booths() {
  const { me, has } = useSession();
  const canManage = has('admin:booth:manage');
  const canPublish = has('admin:booth:publish');
  /** Who works the booth is a different decision from its odds (`@oto/shared`), and a different permission. */
  const canAssignStaff = has('admin:booth:staff_assign');

  const [branches, setBranches] = useState<BranchRow[] | null>(null);
  const [branchId, setBranchId] = useState(me?.branch?.id ?? '');
  const branch = branches?.find((b) => b.id === branchId);
  const timezone = branch?.timezone ?? me?.branch?.timezone;
  const [booths, setBooths] = useState<Read<BoothListRow[]>>(() => unread<BoothListRow[]>([]));
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<Read<BoothDraft | null>>(() =>
    unread<BoothDraft | null>(null),
  );
  const [status, setStatus] = useState<Read<BoothStatus | null>>(() =>
    unread<BoothStatus | null>(null),
  );
  const [versions, setVersions] = useState<Read<BoothVersionRow[]>>(() =>
    unread<BoothVersionRow[]>([]),
  );
  const [layouts, setLayouts] = useState<BoothLayoutRow[]>([]);
  const [definitions, setDefinitions] = useState<VoucherDefinitionRow[]>([]);
  const [screens, setScreens] = useState<Read<BoothScreenRow[]>>(() =>
    unread<BoothScreenRow[]>([]),
  );
  const [staff, setStaff] = useState<Read<BoothStaffRow[]>>(() => unread<BoothStaffRow[]>([]));
  /**
   * The pairing code just minted (SCRUM-244).
   *
   * Held here and nowhere else: the API returns it once and stores only a
   * hash, so this is the only copy in existence and it lasts exactly as long
   * as the card is on screen. Cleared when the booth selection changes, so a
   * code for one booth can never be read beside another booth's name.
   */
  const [mintedCode, setMintedCode] = useState<MintedPairingCode | null>(null);
  /**
   * Today's spins, handed up by the Spins card from its own read: the day's
   * totals for the tiles, and — while every spin of the day is on screen —
   * each prize's wins for the wheel. Dropped with the booth selection.
   */
  const [today, setToday] = useState<TodaySpins | null>(null);

  const [editing, setEditing] = useState<BoothPrizeDraft | null>(null);
  /** The settings drawer (SCRUM-468): the form lives there, the summary on the page. */
  const [settingsOpen, setSettingsOpen] = useState(false);
  /** The voucher slip's drawer (SCRUM-471, on the sheet since SCRUM-474): likewise. */
  const [slipOpen, setSlipOpen] = useState(false);
  /**
   * Whether the setup checklist is on the sheet. Null is "as the booth
   * stands": open while a step is still to do, folded into the bar's chip
   * once every step is done. The chip toggles it either way.
   */
  const [setupOpen, setSetupOpen] = useState<boolean | null>(null);
  /**
   * "Show archived prizes" (SCRUM-468), the voucher types' `showArchived`.
   * Mirrored in a ref so every read of the draft — a write's re-read
   * included — asks for the archived slices while the box is ticked, without
   * `loadBooth` changing identity and re-running the booth-selection effect
   * (which would drop a pairing code on screen).
   */
  const [showArchived, setShowArchived] = useState(false);
  const showArchivedRef = useRef(false);
  const [busy, setBusy] = useState(false);
  /**
   * The last refusal, and WHICH card's button earned it.
   *
   * A publish refused for a stale hash is the message that decides whether
   * somebody presses again, and it used to be drawn in the prize table —
   * measured at 1,769 pixels above the Publish button that caused it, which on
   * any real screen is off it. Each card is handed only its own failure, so
   * the answer appears where the person is looking.
   */
  const [writeError, setWriteError] = useState<{ where: WriteSite; message: string } | null>(null);
  const [writeUnavailable, setWriteUnavailable] = useState(false);
  const [lastPublished, setLastPublished] = useState<{ version: number } | null>(null);

  const errorAt = (where: WriteSite) =>
    writeError && writeError.where === where ? writeError.message : null;

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

  /** The booth's draft, with its archived slices while "Show archived prizes" is ticked. */
  const readDraft = useCallback(async (id: string) => {
    setDraft((held) => reading(held));
    await boothApi
      .draft(id, showArchivedRef.current)
      .then((d) => setDraft(readOk<BoothDraft | null>(d)))
      .catch((reason: unknown) =>
        setDraft((held) =>
          isMissingRoute(reason)
            ? readAbsent<BoothDraft | null>(null)
            : readFailed(held, readFailureMessage(reason), null),
        ),
      );
  }, []);

  const loadBooth = useCallback(async (id: string) => {
    setVersions((held) => reading(held));
    setStatus((held) => reading(held));
    setStaff((held) => reading(held));

    // Each read is settled on its own, so one failing does not empty the page.
    await Promise.allSettled([
      readDraft(id),
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
      boothApi
        .screens(id)
        .then((r) => setScreens(readOk(r.screens)))
        .catch((reason: unknown) =>
          setScreens((held) =>
            isMissingRoute(reason)
              ? readAbsent<BoothScreenRow[]>([])
              : readFailed(held, readFailureMessage(reason), []),
          ),
        ),
      boothApi
        .staff(id)
        .then((r) => setStaff(readOk(r.staff)))
        .catch((reason: unknown) =>
          setStaff((held) =>
            isMissingRoute(reason)
              ? readAbsent<BoothStaffRow[]>([])
              : readFailed(held, readFailureMessage(reason), []),
          ),
        ),
    ]);
  }, [readDraft]);

  /** Tick or untick "Show archived prizes", and read the draft again to match. */
  const toggleArchived = (next: boolean) => {
    showArchivedRef.current = next;
    setShowArchived(next);
    if (selectedId) void readDraft(selectedId);
  };

  /**
   * The pickers' contents: the operator's designs and its voucher
   * definitions.
   *
   * Read once for the page rather than per booth — both are the operator's,
   * not the booth's, which is what makes a seasonal wheel a choice from a list
   * instead of a re-entry of six prizes. A failure here empties a dropdown and
   * nothing else, and the field says what an empty one means.
   *
   * The archived voucher types come too (SCRUM-400), so a prize still pointing
   * at one names it in the editor — the picker offers only live ones.
   */
  useEffect(() => {
    void boothApi
      .layouts()
      .then((r) => setLayouts(r.layouts))
      .catch(() => setLayouts([]));
    void boothApi
      .voucherDefinitions(true)
      .then((r) => setDefinitions(r.definitions))
      .catch(() => setDefinitions([]));
  }, []);

  useEffect(() => {
    void loadBooths(branchId);
  }, [branchId, loadBooths]);

  useEffect(() => {
    // Another booth's staff list is not this booth's while the read is out:
    // who may sign in where is exactly the thing not to show under a wrong name.
    setStaff(unread<BoothStaffRow[]>([]));
    if (selectedId) void loadBooth(selectedId);
    // A code is for one booth. Selecting another must not leave six digits on
    // screen under a different booth's name.
    setMintedCode(null);
    // Nor another booth's day on this one's tiles, nor its checklist's fold.
    setToday(null);
    setSetupOpen(null);
  }, [selectedId, loadBooth]);

  /**
   * One place for every write, because they all end the same way: what is on
   * screen is no longer authoritative, so it is re-read rather than patched.
   * A prize list that drifts from the rows behind it is how somebody publishes
   * a version they did not see.
   */
  const run = async (where: WriteSite, write: () => Promise<unknown>) => {
    if (!selectedId) return;
    setBusy(true);
    setWriteError(null);
    try {
      await write();
      setWriteUnavailable(false);
      await loadBooth(selectedId);
    } catch (reason) {
      if (isMissingRoute(reason)) setWriteUnavailable(true);
      else setWriteError({ where, message: readFailureMessage(reason) });
    } finally {
      setBusy(false);
    }
  };

  /**
   * The staff card's writes (SCRUM-400), apart from `run` on purpose.
   *
   * `run` reads any 404 as "this deployment has no such route" and closes
   * every form on the page. A 404 from the staff routes is nearly always the
   * other thing — a colleague took the person off the booth, or withdrew the
   * PIN, a moment before this press — so it is said in the staff card, and
   * the list is read again either way so the card shows what is now true.
   */
  const runStaff = async (write: () => Promise<unknown>): Promise<boolean> => {
    if (!selectedId) return false;
    setBusy(true);
    setWriteError(null);
    try {
      await write();
      return true;
    } catch (reason) {
      setWriteError({ where: 'staff', message: readFailureMessage(reason) });
      return false;
    } finally {
      await loadBooth(selectedId);
      setBusy(false);
    }
  };

  const selected = draft.value;
  const selectedRow = booths.value.find((b) => b.id === selectedId) ?? null;
  /** The name on the bar: the draft's once read, the list's meanwhile. */
  const boothName = selected?.booth.name ?? selectedRow?.name ?? null;

  /**
   * The setup steps, ticked from the readings in hand (`boothSetupSteps`),
   * and whether they are all done — which is what folds the checklist into
   * the bar's chip. Nothing until a draft is on screen: a checklist over a
   * booth whose draft has not come back would tick nothing and say "0 of 6"
   * about a booth that may be fully set up.
   */
  const steps = selected
    ? boothSetupSteps(
        draft.state === 'read' ? draft.value : null,
        status.state === 'read' ? status.value : null,
        staff.state === 'read' ? staff.value : null,
      )
    : null;
  const stepsDone = steps ? steps.filter((s) => s.done).length : 0;
  const setupComplete = steps !== null && stepsDone === steps.length;
  const showSetup = steps !== null && (setupOpen ?? !setupComplete);

  /** Each prize's colour on the page: the wheel's, the table's, the spins' dots. */
  const inks = useMemo(() => prizeInks(selected?.prizes ?? []), [selected]);
  /** Wins today by prize, counted from the day's spins while every one is on screen. */
  const wonToday = useMemo(() => (today && today.whole ? winsByPrize(today.spins) : null), [today]);

  if (booths.state === 'absent') {
    return (
      <>
        <BoothCommandBar title={null} place={branch?.name} />
        <RouteUnavailable
          what="Booths"
          detail="This deployment does not serve the booth admin routes yet — SCRUM-200. The page is built and fills in as soon as they are deployed here."
        />
      </>
    );
  }

  const refresh = () => {
    void loadBooths(branchId);
    if (selectedId) void loadBooth(selectedId);
  };

  return (
    <>
      <BoothCommandBar
        title={boothName}
        place={branch?.name ?? me?.branch?.name}
        badges={
          boothName ? (
            <>
              <Tag variant="mint">Lucky Wheel</Tag>
              {steps && (
                <button
                  type="button"
                  onClick={() => setSetupOpen(!showSetup)}
                  aria-expanded={showSetup}
                  aria-controls="booth-setup"
                  title={showSetup ? 'Hide the setup steps' : 'Show the setup steps'}
                  className="inline-flex items-center gap-1.5 rounded-full border border-border bg-card px-3 py-[5px] text-[12.5px] font-semibold text-foreground transition-colors hover:bg-foreground/5"
                >
                  {setupComplete ? (
                    <Check className="w-3.5 h-3.5 text-status-ok" strokeWidth={3} aria-hidden="true" />
                  ) : (
                    <StatusMark tone="warn" className="w-2.5 h-2.5" />
                  )}
                  {setupComplete ? 'Setup complete' : `Setup ${stepsDone} of ${steps.length} done`}
                </button>
              )}
            </>
          ) : undefined
        }
        actions={
          <>
            {selectedId && <BoxChip status={status} boothId={selectedId} />}
            {selected && <WheelChip draft={selected} />}
            {branches && branches.length > 1 && (
              // Sized by its longest option (SCRUM-435), so a park's full
              // name is never cut to "…Chal…".
              <SelectChip
                label="Branch"
                showLabel
                value={branchId}
                onChange={(next) => {
                  setBranchId(next);
                  setSelectedId(null);
                }}
                options={branches.map((b) => ({ value: b.id, label: b.name }))}
              />
            )}
            <Button
              variant="outline"
              size="sm"
              className="h-9 gap-2 rounded-full px-3.5"
              onClick={refresh}
              disabled={booths.refreshing}
            >
              <RefreshCw className={booths.refreshing ? 'w-4 h-4 animate-spin' : 'w-4 h-4'} />
              Refresh
            </Button>
          </>
        }
      />

      {/*
        The booths at this branch, and which one the sheet is about. A chip
        row like the views on Devices: a booth's own facts are on the sheet
        once it is chosen, so the chip carries its name, the version published
        for it and a mark when something on it needs a look — the list route
        answers with the last version PUBLISHED, never with what any box is
        running, which is The box's reading, one booth at a time.
      */}
      {booths.state === 'stale' && booths.readAt !== null && (
        <StaleNote readAt={booths.readAt} message={booths.error} onRetry={refresh} />
      )}
      {booths.state === 'failed' ? (
        <Unreadable what="The booth list" message={booths.error} onRetry={refresh} />
      ) : booths.state === 'unread' ? (
        <Loading what="booths" />
      ) : booths.value.length === 0 ? (
        <CardShell>
          <EmptyNote
            icon={FerrisWheel}
            title="No booths at this branch"
            detail="A booth is a station of kind “booth” on a box. Add one on Devices and it appears here."
          />
        </CardShell>
      ) : (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <h2 className="m-0 text-[11.5px] font-semibold uppercase tracking-[0.07em] text-muted-foreground/80">
            Booths
          </h2>
          <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Booth">
            {booths.value.map((booth) => {
              const attention = [
                booth.boxId === null ? 'no box' : null,
                booth.eligibility !== 'none'
                  ? `eligibility ${booth.eligibility} — publishing will refuse it`
                  : null,
              ].filter((part): part is string => part !== null);
              const facts = `${booth.layoutName ?? 'no design'} · ${booth.activePrizes} prize${
                booth.activePrizes === 1 ? '' : 's'
              } on the wheel`;
              return (
                <FilterChip
                  key={booth.id}
                  active={booth.id === selectedId}
                  onClick={() => setSelectedId(booth.id)}
                  title={attention.length > 0 ? `${facts} · ${attention.join(' · ')}` : facts}
                >
                  {attention.length > 0 && <StatusMark tone="warn" className="w-2.5 h-2.5" />}
                  {booth.name}
                  <span className="font-normal opacity-70">
                    · {booth.publishedVersion === null ? 'never published' : `v${booth.publishedVersion}`}
                  </span>
                </FilterChip>
              );
            })}
          </div>
        </div>
      )}

      {selected && !canManage && (
        <p className="rounded-[14px] border border-dashed border-foreground/20 px-4 py-3 text-sm text-muted-foreground">
          You can read this booth but not change it. Editing prizes needs{' '}
          <code className="font-mono text-xs">admin:booth:manage</code>; publishing needs{' '}
          <code className="font-mono text-xs">admin:booth:publish</code>.
        </p>
      )}

      {selectedId && (
        <PageGrid>
          {steps && showSetup && <BoothSetupChecklist id="booth-setup" steps={steps} />}

          <TodayBand status={status} boothId={selectedId} today={today} />

          {draft.state === 'absent' ? (
            <CardShell span={8}>
              <RouteUnavailable
                what="The booth’s prize list and settings"
                detail="The draft route is not deployed here yet — SCRUM-200. What the booth is running is shown beside this, from the route that does ship."
              />
            </CardShell>
          ) : draft.state === 'failed' ? (
            <CardShell span={8}>
              <Unreadable
                what="This booth’s draft"
                message={draft.error}
                onRetry={() => void loadBooth(selectedId)}
              />
            </CardShell>
          ) : selected === null ? (
            <CardShell span={8}>
              <Loading what="this booth’s draft" />
            </CardShell>
          ) : (
            <Rail span={8}>
              {draft.state === 'stale' && draft.readAt !== null && (
                <StaleNote
                  readAt={draft.readAt}
                  message={draft.error}
                  onRetry={() => void loadBooth(selectedId)}
                />
              )}

              <CardShell
                id="booth-prizes"
                className="scroll-mt-24"
                icon={FerrisWheel}
                title="The wheel"
                note={wheelNote(selected)}
                actions={
                  canManage ? (
                    <Button
                      size="sm"
                      variant="outline"
                      className="rounded-full border-primary px-3.5 font-bold text-primary-ink"
                      onClick={() => setEditing(blankPrize(selected))}
                    >
                      <Plus className="w-4 h-4" />
                      Add prize
                    </Button>
                  ) : undefined
                }
                footer={
                  <>
                    {/*
                      The archived slices (SCRUM-468), behind a quiet tick the
                      way Voucher types keeps its archived rows: off by
                      default, so the table reads as the wheel it is.
                    */}
                    <CheckRow
                      checked={showArchived}
                      onChange={toggleArchived}
                      label="Show archived prizes"
                      detail="Archived prizes are off the wheel and out of every total here; every spin that won one still names it."
                    />
                    <span>
                      Switched-off prizes never appear on the wheel ·{' '}
                      {selected.published
                        ? `v${selected.published.version} published ${formatWhen(selected.published.publishedAt, timezone)}`
                        : 'never published'}
                    </span>
                  </>
                }
              >
                {errorAt('prizes') && <ErrorNote message={errorAt('prizes')!} />}
                {selected.prizes.length === 0 ? (
                  <EmptyNote
                    className="py-3"
                    icon={FerrisWheel}
                    title="No prizes on this booth"
                    detail="A wheel with nothing on it refuses every press. Add the first prize to start."
                  />
                ) : (
                  <PrizeTable
                    prizes={selected.prizes}
                    spinsToday={status.state === 'read' ? (status.value?.today.spins ?? null) : null}
                    cappedToday={status.value?.today.dailyCapsReached ?? []}
                    wonToday={wonToday}
                    onEdit={(p) => setEditing(p)}
                    readOnly={!canManage}
                    busy={busy}
                  />
                )}
                {showArchived && (
                  <div className="flex flex-col gap-2 border-t border-card-border pt-3">
                    {errorAt('archived') && <ErrorNote message={errorAt('archived')!} />}
                    {selected.archivedPrizes !== undefined ? (
                      <ArchivedPrizes
                        prizes={selected.archivedPrizes}
                        definitions={definitions}
                        timezone={timezone}
                        readOnly={!canManage}
                        busy={busy}
                        onRestore={(p) =>
                          void run('archived', () => boothApi.restorePrize(selected.booth.id, p.id))
                        }
                      />
                    ) : draft.refreshing ? (
                      <Loading what="archived prizes" />
                    ) : (
                      <p className="py-2 text-sm text-muted-foreground">
                        This deployment does not list archived prizes yet.
                      </p>
                    )}
                  </div>
                )}
              </CardShell>

              {canPublish ? (
                <PublishPanel
                  id="booth-publish"
                  className="scroll-mt-24"
                  draft={selected}
                  publishing={busy}
                  unavailable={writeUnavailable}
                  error={errorAt('publish')}
                  lastPublished={lastPublished}
                  timezone={timezone}
                  onPublish={(note, expectedBundleHash) =>
                    void run('publish', async () => {
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
                <CardShell
                  id="booth-publish"
                  className="scroll-mt-24"
                  title="Publish"
                  note="freezes the draft as a new version the booths pick up"
                >
                  <p className="text-sm text-muted-foreground">
                    Publishing needs <code className="font-mono text-xs">admin:booth:publish</code>. A
                    manager can grant it from the Login Users panel.
                  </p>
                </CardShell>
              )}

              <BoothStaffPanel
                id="booth-staff"
                className="scroll-mt-24"
                // The PIN form holds digits for one booth; another booth is another card.
                key={selected.booth.id}
                branchId={selected.booth.branchId}
                staff={staff}
                // What the box grants now is the PUBLISHED length; the draft's
                // reaches it with the next publish, and the note says both.
                session={{
                  running: publishedSessionMinutes(selected),
                  next: selected.settings.staffSessionMinutes ?? null,
                }}
                busy={busy}
                readOnly={!canAssignStaff}
                error={errorAt('staff')}
                onAdd={(accountId) =>
                  void runStaff(() => boothApi.addStaff(selected.booth.id, accountId))
                }
                onRemove={(accountId) =>
                  void runStaff(() => boothApi.removeStaff(selected.booth.id, accountId))
                }
                onSetPin={async (accountId, input) => {
                  let result: BoothPinResult | null = null;
                  await runStaff(async () => {
                    result = await boothApi.setPin(selected.booth.id, accountId, input);
                  });
                  return result;
                }}
                onClearPin={(accountId) =>
                  void runStaff(() =>
                    boothApi.clearPin(selected.booth.id, accountId, 'withdrawn from the Console'),
                  )
                }
                onRetry={() => void loadBooth(selectedId)}
              />

              <BoothSpinsPanel
                key={'spins-' + selected.booth.id}
                id={selected.booth.id}
                timezone={timezone}
                inks={inks}
                onToday={(spins, whole) => setToday({ spins, whole })}
              />

              <VersionHistory
                versions={versions}
                timezone={timezone}
                onRetry={() => void loadBooth(selectedId)}
              />

              {/*
                The televisions that press this wheel, at the foot of the
                column about the wheel — and where the column's height meets
                the rail's, so the sheet ends on one line rather than two.
              */}
              <BoothScreensPanel
                // Whether this booth is paired at all: only one on the platform's
                // virtual box is. A booth on its own box, the Pi, needs no pairing.
                place={boothBoxPlace(status, selected.booth.id)}
                screens={screens}
                minted={mintedCode}
                busy={busy}
                readOnly={!canManage}
                error={errorAt('screens')}
                timezone={timezone}
                onMint={() =>
                  void run('screens', async () => {
                    // The answer is the only copy of the code there will ever be,
                    // so it is put on screen before anything else can throw.
                    setMintedCode(
                      await boothApi.mintPairingCode(selected.booth.id, 'Booth television'),
                    );
                  })
                }
                onUnpair={(screen) =>
                  void run('screens', async () => {
                    await boothApi.unpairScreen(
                      selected.booth.id,
                      screen.id,
                      'unpaired from the Console',
                    );
                    setMintedCode(null);
                  })
                }
                onRetry={() => void loadBooth(selectedId)}
                onDismissCode={() => setMintedCode(null)}
              />
            </Rail>
          )}

          {/*
            The rail. A third of the sheet from twelve columns up, and the
            whole width of it below, where a third would be a strip.
          */}
          <Rail span={4} className="@2xl:col-span-6">
            {selected && (
              <>
                {/*
                  Today's staff (SCRUM-473): the day's roster from the OTO App's
                  rota and the one label every voucher prints. It reads and
                  writes its own routes; Booth staff is who may ever sign in.
                */}
                <TodayStaffPanel
                  id="booth-today-staff"
                  className="scroll-mt-24"
                  key={'duty-' + selected.booth.id}
                  boothId={selected.booth.id}
                  branchId={selected.booth.branchId}
                  timezone={timezone}
                  readOnly={!canAssignStaff}
                />

                <VoucherSlipPanel
                  id="booth-voucher-slip"
                  className="scroll-mt-24"
                  draft={selected}
                  readOnly={!canManage}
                  onOpen={() => {
                    setWriteError((held) => (held?.where === 'slip' ? null : held));
                    setSlipOpen(true);
                  }}
                />
              </>
            )}

            <BoothBoxCard
              id="booth-printer"
              className="scroll-mt-24"
              status={status}
              boothId={selectedId}
              timezone={timezone}
              onRetry={() => void loadBooth(selectedId)}
            />

            {selected && (
              <>
                <CardShell
                  icon={Disc3}
                  title="Wheel preview"
                  note="slice order and colours, as the television draws them"
                >
                  <WheelPreview prizes={selected.prizes} />
                </CardShell>

                <BoothSettingsPanel
                  id="booth-settings"
                  className="scroll-mt-24"
                  draft={selected}
                  readOnly={!canManage}
                  onEdit={() => {
                    setWriteError((held) => (held?.where === 'settings' ? null : held));
                    setSettingsOpen(true);
                  }}
                />
              </>
            )}
          </Rail>
        </PageGrid>
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
          saveUnavailable={writeUnavailable}
          readOnly={!canManage}
          error={errorAt('prizes')}
          onClose={() => setEditing(null)}
          onSave={(next) =>
            void run('prizes', async () => {
              if (next.id === '') await boothApi.createPrize(selected.booth.id, toInput(next));
              else await boothApi.savePrize(selected.booth.id, next.id, toInput(next));
              setEditing(null);
            })
          }
          onArchive={(p) =>
            void run('prizes', async () => {
              await boothApi.archivePrize(selected.booth.id, p.id);
              setEditing(null);
            })
          }
        />
      )}

      {settingsOpen && selected && (
        <BoothSettingsEditor
          // One booth's edit is not another's: a different booth is a
          // different form, seeded from its own draft.
          key={selected.booth.id}
          draft={selected}
          layouts={layouts}
          saving={busy}
          unavailable={writeUnavailable}
          readOnly={!canManage}
          error={errorAt('settings')}
          onClose={() => setSettingsOpen(false)}
          onSave={(settings: BoothSettingsEdit) =>
            void run('settings', async () => {
              await boothApi.saveSettings(selected.booth.id, settings);
              setSettingsOpen(false);
            })
          }
        />
      )}

      {slipOpen && selected && (
        <VoucherSlipEditor
          // One booth's slip is not another's: a different booth is a
          // different form, seeded from its own draft.
          key={selected.booth.id}
          draft={selected}
          readOnly={!canManage}
          saving={busy}
          error={errorAt('slip')}
          onClose={() => setSlipOpen(false)}
          onSave={(slip) =>
            void run('slip', async () => {
              await boothApi.saveSettings(selected.booth.id, slip);
              setSlipOpen(false);
            })
          }
        />
      )}
    </>
  );
}

// ---------------------------------------------------------------------------

/**
 * The bar's word on the box: online and how long since it was heard from,
 * silent and how long ago it last was, or no box at all. Nothing until the
 * status has been read for THIS booth — the page keeps the last booth's
 * status while the next one's is read, and a chip is a claim.
 */
function BoxChip({ status, boothId }: { status: Read<BoothStatus | null>; boothId: string }) {
  const s = status.value;
  if (!s || s.booth.id !== boothId || (status.state !== 'read' && status.state !== 'stale')) {
    return null;
  }
  if (s.box.id === null) return <BarChip tone="idle">No box yet</BarChip>;
  const seen = s.box.lastHeartbeatAt ? timeAgo(s.box.lastHeartbeatAt) : null;
  return s.box.online ? (
    <BarChip tone="ok">Box online{seen ? ` · seen ${seen}` : ''}</BarChip>
  ) : (
    <BarChip tone="down">
      Box not reporting{seen ? ` · last seen ${seen}` : ' · never reported'}
    </BarChip>
  );
}

/**
 * The bar's word on the wheel: which version is published and whether the
 * draft still matches it. "Published" is what the cloud holds, never what a
 * box is running — that is The box's "Wheel" line, from the box's own report.
 */
function WheelChip({ draft }: { draft: BoothDraft }) {
  if (!draft.published) return <BarChip tone="warn">Wheel never published</BarChip>;
  return (
    <BarChip tone={draft.changed ? 'warn' : 'ok'}>
      Wheel v{draft.published.version} published ·{' '}
      {draft.changed ? 'draft has unpublished changes' : 'draft matches'}
    </BarChip>
  );
}

/** The wheel card's line: how many prizes, and whether their odds add up. */
function wheelNote(draft: BoothDraft): string {
  const active = draft.prizes.filter((p) => p.active);
  const totalBp = active.reduce((sum, p) => sum + p.weightBp, 0);
  const count = `${draft.prizes.length} prize${draft.prizes.length === 1 ? '' : 's'}`;
  if (active.length === 0) return `${count} · nothing switched on`;
  return `${count} · odds ${totalBp === 10_000 ? 'add to 100%' : `add to ${Number((totalBp / 100).toFixed(2))}%`}`;
}

/**
 * The four tiles across the top of the sheet: today at this booth, from the
 * box's report (`GET /booths/:id/status`) and from the day's spins as the
 * Spins card read them. A tile whose reading has not come back shows a dash
 * and says so — never a zero.
 */
function TodayBand({
  status,
  boothId,
  today,
}: {
  status: Read<BoothStatus | null>;
  boothId: string;
  today: TodaySpins | null;
}) {
  const s =
    status.value && status.value.booth.id === boothId && (status.state === 'read' || status.state === 'stale')
      ? status.value
      : null;
  const summary = today?.spins.summary ?? null;
  const capReached = s !== null && s.today.spinCap !== null && s.today.spins >= s.today.spinCap;
  /** The share of today's spins with somebody signed in, once there are any. */
  const attribution =
    s && s.today.spins > 0
      ? {
          percent: Math.round(((s.today.spins - s.today.unattributed) / s.today.spins) * 100),
          unattributed: s.today.unattributed,
        }
      : null;

  return (
    <>
      <StatTile
        span={3}
        label="Spins today"
        value={
          s === null
            ? '—'
            : s.today.spinCap === null
              ? s.today.spins
              : `${s.today.spins} of ${s.today.spinCap}`
        }
        tone={capReached ? 'warn' : undefined}
        detail={
          s === null
            ? 'waiting for the box’s report'
            : capReached
              ? 'cap reached — no more spins today'
              : `trading day ${s.today.businessDate}`
        }
      />
      <StatTile
        span={3}
        label="Vouchers printed"
        value={summary ? summary.printed : '—'}
        detail={
          summary && today
            ? `from ${summary.spins} spin${summary.spins === 1 ? '' : 's'} on ${today.spins.businessDate}`
            : 'from today’s spins, once read'
        }
      />
      <StatTile
        span={3}
        label="Redeemed today"
        value={summary ? summary.redeemed : '—'}
        detail={
          summary
            ? `of ${summary.printed} printed, taken at the till`
            : 'from today’s spins, once read'
        }
      />
      <StatTile
        span={3}
        label="Attribution"
        value={attribution === null ? '—' : `${attribution.percent}%`}
        tone={attribution === null ? undefined : attribution.unattributed > 0 ? 'warn' : 'ok'}
        detail={
          s === null
            ? 'waiting for the box’s report'
            : attribution === null
              ? 'no spins yet today'
              : attribution.unattributed > 0
                ? `${attribution.unattributed} with nobody signed in`
                : 'every spin has a name against it'
        }
      />
    </>
  );
}

/** Wins by prize id over one day's spins — only meaningful when the rows are the whole day. */
function winsByPrize(spins: BoothSpins): Map<string, number> {
  const counts = new Map<string, number>();
  for (const spin of spins.spins) {
    if (spin.prize) counts.set(spin.prize.id, (counts.get(spin.prize.id) ?? 0) + 1);
  }
  return counts;
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
    <CardShell
      icon={History}
      title="Version history"
      note="every wheel this booth has run — a version is frozen, so what the odds were on a given day cannot be changed by tonight’s publish"
    >
      {versions.state === 'absent' ? (
        <RouteUnavailable what="Version history" detail="Not deployed here yet — SCRUM-200." />
      ) : versions.state === 'failed' ? (
        <Unreadable what="The version history" message={versions.error} onRetry={onRetry} />
      ) : versions.state === 'unread' ? (
        <Loading what="versions" />
      ) : versions.value.length === 0 ? (
        <EmptyNote
          className="py-3"
          icon={History}
          title="Nothing published yet"
          detail="This booth has never been given a wheel."
        />
      ) : (
        <StripedList label="Versions">
          {versions.value.map((v) => (
            <li key={v.id} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 px-3 py-2.5 text-[13.5px]">
              <span className="font-semibold tabular-nums">v{v.version}</span>
              <span className="text-[12.5px] text-muted-foreground">
                {formatWhen(v.publishedAt, timezone)}
              </span>
              {v.note ? (
                <span className="min-w-0 break-words">“{v.note}”</span>
              ) : (
                <span className="text-[12.5px] text-muted-foreground">no note</span>
              )}
              <span className="ml-auto font-mono text-[11px] text-muted-foreground">
                {v.bundleHash.slice(0, 8)}
              </span>
            </li>
          ))}
        </StripedList>
      )}
    </CardShell>
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
