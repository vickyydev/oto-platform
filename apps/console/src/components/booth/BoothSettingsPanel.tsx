import { useEffect, useState } from 'react';
import { Keyboard, SlidersHorizontal } from 'lucide-react';
import {
  BOOTH_ELIGIBILITY_MODES,
  BOOTH_SPIN_DURATION_MIN_SECONDS,
  BOOTH_SPIN_DURATION_MAX_SECONDS,
  boothSpinDurationSeconds,
  BOOTH_STAFF_SESSION_DEFAULT_MINUTES,
  BOOTH_STAFF_SESSION_MAX_MINUTES,
  type BoothEligibilityMode,
} from '@oto/shared';
import { Drawer } from '@/components/Drawer';
import { Panel, ErrorNote, Fact, RouteUnavailable } from '@/components/Panel';
import { Button } from '@/components/ui/button';
import { ChoiceRow, Field, NumberInput, Select } from '@/components/Form';
import { ELIGIBILITY_REFUSAL } from './publishPlan';
import type { BoothDraft, BoothLayoutRow, BoothSettingsDraft } from './boothApi';

/** What the settings form can actually change. `layoutName` is the API's to say. */
export type BoothSettingsEdit = Omit<BoothSettingsDraft, 'layoutName'>;

/** The words each spin-eligibility mode goes by, on the form and on the summary. */
function eligibilityLabel(mode: BoothEligibilityMode): string {
  return mode === 'none' ? 'Anybody' : mode === 'band' ? 'One spin per wristband' : 'One spin per phone';
}

/** A staff sign-in's length in hours, as the summary says it. */
function sessionHoursText(minutes: number | null | undefined): string {
  if (minutes == null) return `${BOOTH_STAFF_SESSION_DEFAULT_MINUTES / 60} hours (default)`;
  const hours = minutes / 60;
  return `${Number.isInteger(hours) ? hours : hours.toFixed(1)} hour${hours === 1 ? '' : 's'}`;
}

/**
 * The booth's own settings, as saved to the draft (SCRUM-468): the design it
 * draws, who may spin, the key the red button sends, how many spins a day it
 * will allow, how long a spin lasts and how long a staff sign-in lasts.
 *
 * A summary on the page and the form in a drawer (`BoothSettingsEditor`), so
 * the page reads at a glance and the form has the screen to itself while it
 * is being changed. The summary reads what the API returned — never an edit
 * in progress — so what it says is what a publish would carry.
 *
 * **Its name, its branch and whether it is in service are not here.** A booth
 * is a station (`core.station`, kind `booth`) and those three belong to the
 * station, which is edited on Devices with every other station in the park.
 * Showing them here as read-only facts and saying where they are changed is
 * better than a second form that writes the same row from two pages and lets
 * them disagree.
 */
export function BoothSettingsPanel({
  draft,
  readOnly = false,
  onEdit,
}: {
  draft: BoothDraft;
  /** The caller may read this booth but not change it. */
  readOnly?: boolean;
  onEdit: () => void;
}) {
  const s = draft.settings;
  return (
    <Panel
      title="Booth settings"
      description="Saved here, applied at the booth only when a version is published."
      actions={
        readOnly ? undefined : (
          <Button variant="outline" size="sm" onClick={onEdit}>
            <SlidersHorizontal className="w-4 h-4" />
            Edit settings
          </Button>
        )
      }
    >
      <dl className="grid gap-x-4 gap-y-3 grid-cols-2 sm:grid-cols-3">
        <Fact label="Booth">{draft.booth.name}</Fact>
        <Fact label="Design in use">{s.layoutName ?? 'none chosen'}</Fact>
        <Fact label="Published">
          {draft.published ? `version ${draft.published.version}` : 'never'}
        </Fact>
        <Fact label="Who may spin">
          {s.eligibility === 'none' ? (
            eligibilityLabel(s.eligibility)
          ) : (
            <span style={{ color: 'hsl(var(--status-down))' }}>
              {eligibilityLabel(s.eligibility)} — publishing will refuse it
            </span>
          )}
        </Fact>
        <Fact label="Spins per day">{s.dailySpinCap ?? 'no cap'}</Fact>
        <Fact label="Spin duration (seconds)">{boothSpinDurationSeconds(s)}</Fact>
        <Fact label="Staff session length">{sessionHoursText(s.staffSessionMinutes)}</Fact>
        <Fact label="Button key">
          <code className="font-mono text-sm">{s.buttonKey === ' ' ? 'Space' : s.buttonKey}</code>
        </Fact>
      </dl>
      <p className="mt-4 text-xs text-muted-foreground">
        The booth’s name, its branch, its box and whether it is in service belong to the station and
        are changed on Devices, with the rest of the park’s stations.
        {readOnly && (
          <>
            {' '}
            Changing these needs <code className="font-mono">admin:booth:manage</code>.
          </>
        )}
      </p>
    </Panel>
  );
}

/**
 * The settings form, in the drawer the summary's "Edit settings" opens.
 *
 * Unchanged from when it sat on the page: the same fields, the same checks,
 * and the same rule that a fresh read of the booth replaces what is on screen.
 * The page closes the drawer once a save has been accepted and the booth read
 * again; a refused save keeps it open with the refusal at the top.
 */
export function BoothSettingsEditor({
  draft,
  layouts,
  saving,
  unavailable,
  readOnly = false,
  error,
  onSave,
  onClose,
}: {
  draft: BoothDraft;
  /** The operator's designs, read separately — a layout is shared between booths. */
  layouts: readonly BoothLayoutRow[];
  saving: boolean;
  /**
   * The settings route is not on this deployment — a fact about the SERVER.
   * Never pass a permission for this: a branch manager reading a booth they
   * may not re-weight was being told the route was undeployed, which is a
   * claim about the deployment and was untrue. That is `readOnly`.
   */
  unavailable: boolean;
  /** The caller may read this booth but not change it. */
  readOnly?: boolean;
  error: string | null;
  onSave: (settings: BoothSettingsEdit) => void;
  onClose: () => void;
}) {
  const [settings, setSettings] = useState<BoothSettingsEdit>(() => edit(draft.settings));
  const [listening, setListening] = useState(false);

  // A fresh read of the booth replaces what is on screen — this panel holds an
  // edit, not the truth, and the truth arriving is the thing it should follow.
  useEffect(() => setSettings(edit(draft.settings)), [draft.settings]);

  /**
   * Capture the next key so the button's key can be read off the booth's own
   * hardware rather than guessed.
   *
   * Nobody has yet read what the red button sends, and `Space` is a default
   * rather than an answer. Enter is refused here as it is refused by the
   * column's CHECK and by the bundle schema: the park's USB badge scanner
   * types digits and then Enter, so a booth bound to Enter spins the wheel
   * every time a staff member scans a badge.
   */
  useEffect(() => {
    if (!listening) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      // The key is the booth's, not the page's: stopped here, in the capture
      // phase, so an Escape that ends the listening does not also close the
      // drawer this form sits in.
      e.stopPropagation();
      setListening(false);
      if (e.key === 'Escape') return;
      if (e.key === 'Enter') return;
      setSettings((s) => ({ ...s, buttonKey: e.key }));
    };
    window.addEventListener('keydown', onKey, { capture: true });
    return () => window.removeEventListener('keydown', onKey, { capture: true });
  }, [listening]);

  const dirty =
    settings.layoutId !== draft.settings.layoutId ||
    settings.eligibility !== draft.settings.eligibility ||
    settings.buttonKey !== draft.settings.buttonKey ||
    settings.dailySpinCap !== draft.settings.dailySpinCap ||
    settings.spinDurationSeconds !== boothSpinDurationSeconds(draft.settings) ||
    (settings.staffSessionMinutes ?? null) !== (draft.settings.staffSessionMinutes ?? null);

  /**
   * The session length is typed in hours and stored in minutes. Empty is the
   * box's own twelve hours; anything else is more than nothing and at most the
   * box's ceiling of a day, which the API refuses past as well.
   */
  const sessionMinutes = settings.staffSessionMinutes ?? null;
  const spinDuration = settings.spinDurationSeconds;
  const spinDurationValid = typeof spinDuration === 'number' && Number.isInteger(spinDuration) &&
    spinDuration >= BOOTH_SPIN_DURATION_MIN_SECONDS && spinDuration <= BOOTH_SPIN_DURATION_MAX_SECONDS;
  const sessionValid =
    sessionMinutes === null ||
    (Number.isInteger(sessionMinutes) &&
      sessionMinutes >= 1 &&
      sessionMinutes <= BOOTH_STAFF_SESSION_MAX_MINUTES);

  return (
    <Drawer
      title="Booth settings"
      subtitle={`${draft.booth.name} · Saved here, applied at the booth only when a version is published.`}
      onClose={onClose}
      footer={
        <div className="flex flex-wrap gap-2 items-center">
          <Button
            onClick={() => onSave(settings)}
            disabled={!dirty || !sessionValid || !spinDurationValid || saving || unavailable || readOnly}
          >
            {saving ? 'Saving…' : 'Save settings'}
          </Button>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          {readOnly ? (
            <span className="text-xs text-muted-foreground">
              Changing these needs <code className="font-mono">admin:booth:manage</code>.
            </span>
          ) : (
            dirty &&
            !saving && (
              <span className="text-xs text-muted-foreground">
                Unsaved. Saving changes the draft; only a published version can reach the booth.
              </span>
            )
          )}
        </div>
      }
    >
      {unavailable && (
        <RouteUnavailable
          what="Saving booth settings"
          detail="The form is built and the settings route is not deployed here yet — SCRUM-200."
        />
      )}
      {error && <ErrorNote message={error} />}

      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          label="Layout"
          hint="The design the television draws the wheel with. A booth cannot be published without one."
        >
          <Select
            value={settings.layoutId ?? ''}
            onChange={(v) => setSettings({ ...settings, layoutId: v === '' ? null : v })}
            placeholder="— none chosen —"
            options={layouts.map((l) => ({
              value: l.id,
              label: l.active ? `${l.name} (v${l.version})` : `${l.name} (v${l.version}) — inactive`,
            }))}
          />
        </Field>

        <Field
          label="Spins per day"
          hint="Left empty there is no cap. With a number, the box stops the wheel for the rest of the day once that many spins have been played at this booth — counted on the box itself, shown on the tile above — and the cap reaches the box with the next published version."
        >
          <NumberInput
            value={settings.dailySpinCap}
            min={1}
            placeholder="no cap"
            onChange={(dailySpinCap) => setSettings({ ...settings, dailySpinCap })}
          />
        </Field>

        <Field
          label="Spin duration (seconds)"
          hint={spinDurationValid
            ? 'Whole seconds from 2 to 20. Reaches the booth with the next published version.'
            : <span style={{ color: 'hsl(var(--status-down))' }}>Choose a whole number from 2 to 20.</span>}
        >
          <NumberInput
            value={spinDuration ?? null}
            min={BOOTH_SPIN_DURATION_MIN_SECONDS}
            onChange={(seconds) => setSettings({ ...settings, spinDurationSeconds: seconds ?? undefined })}
          />
        </Field>

        <Field
          label="Staff session length"
          hint={
            sessionValid ? (
              `How long a sign-in at the booth lasts before it ends by itself — never because nobody pressed anything. Hours; left empty it is ${BOOTH_STAFF_SESSION_DEFAULT_MINUTES / 60}, at most ${BOOTH_STAFF_SESSION_MAX_MINUTES / 60}. Reaches the booth with the next published version.`
            ) : (
              <span style={{ color: 'hsl(var(--status-down))' }}>
                More than nothing and at most {BOOTH_STAFF_SESSION_MAX_MINUTES / 60} hours.
              </span>
            )
          }
        >
          <div className="flex items-center gap-2">
            <NumberInput
              value={sessionMinutes === null ? null : sessionMinutes / 60}
              min={1}
              placeholder={`${BOOTH_STAFF_SESSION_DEFAULT_MINUTES / 60} (default)`}
              onChange={(hours) =>
                setSettings({
                  ...settings,
                  staffSessionMinutes: hours === null ? null : Math.round(hours * 60),
                })
              }
            />
            <span className="text-sm text-muted-foreground shrink-0">hours</span>
          </div>
        </Field>

        <Field
          label="Button key"
          hint={
            <>
              What the red button sends. Never Enter — that is the badge scanner’s key.{' '}
              {listening ? 'Press the booth’s button now, or Escape to stop.' : ''}
            </>
          }
        >
          <div className="flex items-center gap-2">
            <code className="rounded-md border px-2.5 h-9 inline-flex items-center font-mono text-sm min-w-[5rem] justify-center">
              {settings.buttonKey === ' ' ? 'Space' : settings.buttonKey}
            </code>
            <Button
              variant={listening ? 'default' : 'outline'}
              size="sm"
              onClick={() => setListening((v) => !v)}
            >
              <Keyboard className="w-4 h-4" />
              {listening ? 'Listening…' : 'Read a key'}
            </Button>
          </div>
        </Field>

        <Field
          label="Who may spin"
          hint={
            settings.eligibility === 'none' ? (
              'Anybody who walks up to the booth. The only mode a mall booth can use.'
            ) : (
              <span style={{ color: 'hsl(var(--status-down))' }}>
                This mode is {ELIGIBILITY_REFUSAL} — publishing will refuse it.
              </span>
            )
          }
        >
          <ChoiceRow
            value={settings.eligibility}
            onChange={(v) => setSettings({ ...settings, eligibility: v as BoothEligibilityMode })}
            options={BOOTH_ELIGIBILITY_MODES.map((mode) => ({
              value: mode,
              label: eligibilityLabel(mode),
            }))}
          />
        </Field>
      </div>
    </Drawer>
  );
}

/** The editable half of the settings the API returns. */
function edit(settings: BoothSettingsDraft): BoothSettingsEdit {
  return {
    layoutId: settings.layoutId,
    buttonKey: settings.buttonKey,
    eligibility: settings.eligibility,
    dailySpinCap: settings.dailySpinCap,
    spinDurationSeconds: boothSpinDurationSeconds(settings),
    staffSessionMinutes: settings.staffSessionMinutes ?? null,
  };
}
