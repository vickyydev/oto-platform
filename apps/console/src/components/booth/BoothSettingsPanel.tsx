import { useEffect, useState } from 'react';
import { Keyboard } from 'lucide-react';
import { BOOTH_ELIGIBILITY_MODES, type BoothEligibilityMode } from '@oto/shared';
import { Panel, ErrorNote, Fact, RouteUnavailable } from '@/components/Panel';
import { Button } from '@/components/ui/button';
import { ChoiceRow, Field, NumberInput, Select } from '@/components/Form';
import { ELIGIBILITY_REFUSAL } from './publishPlan';
import type { BoothDraft, BoothLayoutRow, BoothSettingsDraft } from './boothApi';

/** What the settings form can actually change. `layoutName` is the API's to say. */
export type BoothSettingsEdit = Omit<BoothSettingsDraft, 'layoutName'>;

/**
 * The booth's own settings: the design it draws, who may spin, the key the red
 * button sends, and how many spins a day it will allow.
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
  layouts,
  saving,
  unavailable,
  readOnly = false,
  error,
  onSave,
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
    settings.dailySpinCap !== draft.settings.dailySpinCap;

  return (
    <Panel
      title="Booth settings"
      description="Saved here, applied at the booth only when a version is published."
    >
      {unavailable && (
        <RouteUnavailable
          what="Saving booth settings"
          detail="The form is built and the settings route is not deployed here yet — SCRUM-200."
        />
      )}
      {error && <ErrorNote message={error} />}

      <dl className="grid gap-3 sm:grid-cols-3 mb-4">
        <Fact label="Booth">{draft.booth.name}</Fact>
        <Fact label="Design in use">{draft.settings.layoutName ?? 'none chosen'}</Fact>
        <Fact label="Published">
          {draft.published ? `version ${draft.published.version}` : 'never'}
        </Fact>
      </dl>
      <p className="-mt-2 mb-4 text-xs text-muted-foreground">
        The booth’s name, its branch, its box and whether it is in service belong to the station and
        are changed on Devices, with the rest of the park’s stations.
      </p>

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
              label:
                mode === 'none'
                  ? 'Anybody'
                  : mode === 'band'
                    ? 'One spin per wristband'
                    : 'One spin per phone',
            }))}
          />
        </Field>
      </div>

      <div className="mt-4 flex flex-wrap gap-2 items-center">
        <Button
          onClick={() => onSave(settings)}
          disabled={!dirty || saving || unavailable || readOnly}
        >
          {saving ? 'Saving…' : 'Save settings'}
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
    </Panel>
  );
}

/** The editable half of the settings the API returns. */
function edit(settings: BoothSettingsDraft): BoothSettingsEdit {
  return {
    layoutId: settings.layoutId,
    buttonKey: settings.buttonKey,
    eligibility: settings.eligibility,
    dailySpinCap: settings.dailySpinCap,
  };
}
