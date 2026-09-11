import { useState, useMemo } from 'react';
import {
  Plus,
  Trash2,
  ShieldCheck,
  AlertTriangle,
  Baby,
  Info,
  Infinity as InfinityIcon,
  ClipboardCheck,
  ArrowUp,
  ArrowDown,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { useCatalogStore } from '@/store/CatalogStoreContext';
import type {
  SupervisionBand,
  SupervisionRequirement,
  SiblingWaiver,
  ConfirmationItem,
} from '@/types';
import { TextInput, SelectInput } from '../discounts/fields';

const REQUIREMENT_OPTIONS: { value: SupervisionRequirement; label: string }[] = [
  { value: 'nanny', label: 'Nanny required' },
  { value: 'drop_off', label: 'Drop-off required' },
  { value: 'none', label: 'No requirement' },
];

const requirementLabel = (r: SupervisionRequirement) =>
  REQUIREMENT_OPTIONS.find((o) => o.value === r)?.label ?? r;

// Validate that the bands cover every age 0–18 with exactly one band: no gaps,
// no overlaps. Returns human-readable problems (empty = valid). Open-ended top
// band (maxAge null) is allowed only as the highest band.
function validateBands(bands: SupervisionBand[]): string[] {
  const problems: string[] = [];
  if (bands.length === 0) {
    return ['Add at least one age band so every child resolves to a rule.'];
  }

  for (const b of bands) {
    if (!Number.isFinite(b.minAge) || b.minAge < 0) {
      problems.push(`“${b.label || 'Unnamed band'}” has an invalid minimum age.`);
    }
    if (b.maxAge !== null && b.maxAge < b.minAge) {
      problems.push(
        `“${b.label || 'Unnamed band'}” has a maximum age below its minimum.`
      );
    }
  }

  const sorted = [...bands].sort((a, b) => a.minAge - b.minAge);

  // Exactly one open-ended (top) band, and it must be the last one.
  const openCount = sorted.filter((b) => b.maxAge === null).length;
  if (openCount > 1) {
    problems.push('Only the highest band may have no upper bound.');
  } else if (openCount === 1 && sorted[sorted.length - 1].maxAge !== null) {
    problems.push('The band with no upper bound must be the highest one.');
  }

  // Must start at age 0.
  if (sorted[0].minAge !== 0) {
    problems.push(`Bands should start at age 0 (lowest band starts at ${sorted[0].minAge}).`);
  }

  // Contiguous, non-overlapping: each band starts exactly where the previous ended +1.
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1];
    const cur = sorted[i];
    if (prev.maxAge === null) {
      problems.push('A band with no upper bound must be last — ages after it can never resolve.');
      break;
    }
    if (cur.minAge <= prev.maxAge) {
      problems.push(
        `“${prev.label || prev.minAge}” and “${cur.label || cur.minAge}” overlap at age ${cur.minAge}.`
      );
    } else if (cur.minAge > prev.maxAge + 1) {
      problems.push(
        `Gap between ages ${prev.maxAge} and ${cur.minAge} — no band covers ${prev.maxAge + 1}.`
      );
    }
  }

  // Top band should cover the upper end (18) so older kids resolve.
  const top = sorted[sorted.length - 1];
  if (top.maxAge !== null && top.maxAge < 18) {
    problems.push(`No band covers ages above ${top.maxAge} — add an open-ended top band or extend it.`);
  }

  return problems;
}

let bandSeq = 0;
const newBandId = () =>
  typeof crypto !== 'undefined' && crypto.randomUUID
    ? crypto.randomUUID()
    : `band-${Date.now()}-${bandSeq++}`;

let confirmationSeq = 0;
const newConfirmationId = () =>
  typeof crypto !== 'undefined' && crypto.randomUUID
    ? crypto.randomUUID()
    : `confirmation-${Date.now()}-${confirmationSeq++}`;

/**
 * Admin editor for the configurable child-supervision policy: the age → required
 * service bands and the staff sibling-waiver rule. Reads/writes the live shared
 * store via useCatalogStore so edits take effect in-session (the door flow that
 * enforces them is wired in a later prompt).
 */
export function SupervisionPanel() {
  const { supervisionPolicy, mutators } = useCatalogStore();
  const { bands, siblingWaiver, confirmations } = supervisionPolicy;
  const sortedConfirmations = useMemo(
    () => [...confirmations].sort((a, b) => a.order - b.order),
    [confirmations],
  );

  const problems = useMemo(() => validateBands(bands), [bands]);
  const sorted = useMemo(
    () => [...bands].sort((a, b) => a.minAge - b.minAge),
    [bands]
  );

  const patchBand = (id: string, fields: Partial<SupervisionBand>) => {
    mutators.updateSupervisionPolicy({
      bands: bands.map((b) => (b.id === id ? { ...b, ...fields } : b)),
    });
  };

  const addBand = () => {
    // Start the new band one above the current highest bounded band.
    const maxBounded = bands.reduce(
      (m, b) => (b.maxAge !== null && b.maxAge > m ? b.maxAge : m),
      -1
    );
    const minAge = maxBounded + 1;
    const band: SupervisionBand = {
      id: newBandId(),
      label: `${minAge}+`,
      minAge,
      maxAge: null,
      requirement: 'none',
    };
    mutators.updateSupervisionPolicy({ bands: [...bands, band] });
  };

  const removeBand = (id: string) => {
    mutators.updateSupervisionPolicy({ bands: bands.filter((b) => b.id !== id) });
  };

  const patchWaiver = (fields: Partial<SiblingWaiver>) => {
    mutators.updateSupervisionPolicy({
      siblingWaiver: { ...siblingWaiver, ...fields },
    });
  };

  const patchConfirmation = (id: string, fields: Partial<ConfirmationItem>) => {
    mutators.updateSupervisionPolicy({
      confirmations: confirmations.map((c) => (c.id === id ? { ...c, ...fields } : c)),
    });
  };

  const addConfirmation = () => {
    const maxOrder = confirmations.reduce((m, c) => Math.max(m, c.order), -1);
    const item: ConfirmationItem = {
      id: newConfirmationId(),
      text: '',
      required: true,
      order: maxOrder + 1,
    };
    mutators.updateSupervisionPolicy({ confirmations: [...confirmations, item] });
  };

  const removeConfirmation = (id: string) => {
    mutators.updateSupervisionPolicy({
      confirmations: confirmations.filter((c) => c.id !== id),
    });
  };

  const moveConfirmation = (id: string, direction: -1 | 1) => {
    const idx = sortedConfirmations.findIndex((c) => c.id === id);
    const swapIdx = idx + direction;
    if (idx < 0 || swapIdx < 0 || swapIdx >= sortedConfirmations.length) return;
    const a = sortedConfirmations[idx];
    const b = sortedConfirmations[swapIdx];
    mutators.updateSupervisionPolicy({
      confirmations: confirmations.map((c) => {
        if (c.id === a.id) return { ...c, order: b.order };
        if (c.id === b.id) return { ...c, order: a.order };
        return c;
      }),
    });
  };

  return (
    <div className="flex flex-col gap-6">
      {/* Age bands */}
      <section className="rounded-3xl border border-foreground/10 bg-foreground/[0.02] p-5 sm:p-6">
        <div className="flex items-center gap-2">
          <Baby className="w-4 h-4 text-foreground/50" />
          <h2 className="text-lg font-bold">Age bands</h2>
        </div>
        <p className="mt-1 text-sm text-foreground/50">
          Map a child's age to the supervision the park requires. Bands must be
          contiguous and non-overlapping so every age resolves to exactly one
          rule. Use “No upper bound” for the highest band.
        </p>

        {problems.length > 0 && (
          <div className="mt-4 rounded-2xl border border-amber-400/40 bg-amber-400/10 p-3">
            <div className="flex items-center gap-2 text-amber-300">
              <AlertTriangle className="w-4 h-4" />
              <span className="text-sm font-semibold">
                Fix these so every age resolves cleanly:
              </span>
            </div>
            <ul className="mt-2 list-disc space-y-1 pl-6 text-xs text-amber-200/90">
              {problems.map((p, i) => (
                <li key={i}>{p}</li>
              ))}
            </ul>
          </div>
        )}

        <div className="mt-5 flex flex-col gap-2">
          {/* Header row (desktop) */}
          <div className="hidden gap-2 px-3 text-xs font-semibold uppercase tracking-wider text-foreground/40 sm:grid sm:grid-cols-[1fr_5rem_5rem_1fr_2.5rem]">
            <span>Label</span>
            <span>Min age</span>
            <span>Max age</span>
            <span>Requirement</span>
            <span />
          </div>

          {sorted.map((b) => (
            <div
              key={b.id}
              className="grid grid-cols-1 gap-2 rounded-2xl border border-foreground/10 bg-black/20 px-3 py-3 sm:grid-cols-[1fr_5rem_5rem_1fr_2.5rem] sm:items-center sm:py-2"
            >
              <TextInput
                value={b.label}
                placeholder="e.g. 0–4"
                aria-label="Band label"
                onChange={(e) => patchBand(b.id, { label: e.target.value })}
              />
              <TextInput
                type="number"
                inputMode="numeric"
                min={0}
                value={String(b.minAge)}
                aria-label="Minimum age"
                onChange={(e) =>
                  patchBand(b.id, { minAge: Math.max(0, Number(e.target.value) || 0) })
                }
              />
              {b.maxAge === null ? (
                <button
                  type="button"
                  onClick={() => patchBand(b.id, { maxAge: Math.max(b.minAge, 0) })}
                  className="inline-flex h-10 items-center justify-center gap-1.5 rounded-xl border border-foreground/10 bg-black/20 px-3 text-xs text-foreground/50 hover:text-foreground"
                  title="Click to set an upper bound"
                >
                  <InfinityIcon className="w-4 h-4" /> No max
                </button>
              ) : (
                <div className="flex items-center gap-1">
                  <TextInput
                    type="number"
                    inputMode="numeric"
                    min={b.minAge}
                    value={String(b.maxAge)}
                    aria-label="Maximum age"
                    onChange={(e) =>
                      patchBand(b.id, { maxAge: Number(e.target.value) || 0 })
                    }
                  />
                  <button
                    type="button"
                    onClick={() => patchBand(b.id, { maxAge: null })}
                    aria-label="No upper bound"
                    title="No upper bound"
                    className="inline-flex h-10 w-9 shrink-0 items-center justify-center rounded-xl border border-foreground/10 text-foreground/40 hover:text-foreground"
                  >
                    <InfinityIcon className="w-4 h-4" />
                  </button>
                </div>
              )}
              <SelectInput
                value={b.requirement}
                aria-label="Requirement"
                onChange={(e) =>
                  patchBand(b.id, {
                    requirement: e.target.value as SupervisionRequirement,
                  })
                }
              >
                {REQUIREMENT_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </SelectInput>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => removeBand(b.id)}
                aria-label="Remove band"
                className="justify-self-end text-rose-300 hover:text-rose-200"
              >
                <Trash2 className="w-4 h-4" />
              </Button>
            </div>
          ))}
        </div>

        <Button onClick={addBand} variant="outline" className="mt-4">
          <Plus className="w-4 h-4" />
          Add band
        </Button>
      </section>

      {/* Confirmations checklist */}
      <section className="rounded-3xl border border-foreground/10 bg-foreground/[0.02] p-5 sm:p-6">
        <div className="flex items-center gap-2">
          <ClipboardCheck className="w-4 h-4 text-foreground/50" />
          <h2 className="text-lg font-bold">Confirmations</h2>
        </div>
        <p className="mt-1 text-sm text-foreground/50">
          Shown as a checklist on the drop-off/nanny consent screen — at the door
          and on the public booking site — for every unaccompanied child
          registration, whether or not a service fee applies. Required items
          must all be ticked before the parent can continue.
        </p>

        <div className="mt-5 flex flex-col gap-2">
          {sortedConfirmations.length === 0 && (
            <p className="text-sm text-foreground/40">No confirmations configured yet.</p>
          )}
          {sortedConfirmations.map((c, i) => (
            <div
              key={c.id}
              className="grid grid-cols-1 gap-2 rounded-2xl border border-foreground/10 bg-black/20 px-3 py-3 sm:grid-cols-[1fr_5rem_5.5rem_2.5rem] sm:items-center sm:py-2"
            >
              <TextInput
                value={c.text}
                placeholder="e.g. I will remain within 15 minutes of the venue"
                aria-label="Confirmation text"
                onChange={(e) => patchConfirmation(c.id, { text: e.target.value })}
              />
              <label className="flex items-center justify-center gap-2 text-xs text-foreground/60 sm:justify-self-center">
                <Checkbox
                  checked={c.required}
                  onCheckedChange={(v) => patchConfirmation(c.id, { required: v === true })}
                />
                Required
              </label>
              <div className="flex items-center justify-center gap-1 sm:justify-self-center">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => moveConfirmation(c.id, -1)}
                  disabled={i === 0}
                  aria-label="Move up"
                  className="h-9 w-9 p-0"
                >
                  <ArrowUp className="w-4 h-4" />
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => moveConfirmation(c.id, 1)}
                  disabled={i === sortedConfirmations.length - 1}
                  aria-label="Move down"
                  className="h-9 w-9 p-0"
                >
                  <ArrowDown className="w-4 h-4" />
                </Button>
              </div>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => removeConfirmation(c.id)}
                aria-label="Remove confirmation"
                className="justify-self-end text-rose-300 hover:text-rose-200"
              >
                <Trash2 className="w-4 h-4" />
              </Button>
            </div>
          ))}
        </div>

        <Button onClick={addConfirmation} variant="outline" className="mt-4">
          <Plus className="w-4 h-4" />
          Add confirmation
        </Button>
      </section>

      {/* Sibling waiver */}
      <section className="rounded-3xl border border-foreground/10 bg-foreground/[0.02] p-5 sm:p-6">
        <div className="flex items-center gap-2">
          <ShieldCheck className="w-4 h-4 text-foreground/50" />
          <h2 className="text-lg font-bold">Sibling waiver</h2>
        </div>
        <p className="mt-1 text-sm text-foreground/50">
          Let an older sibling “cover” a younger one so staff can waive the
          younger child's requirement at the door. The waiver is offered, never
          applied automatically — staff must choose it, and the action is
          audited with the operator.
        </p>

        <div className="mt-5 flex flex-col gap-4">
          <label className="flex items-center justify-between gap-3 rounded-2xl border border-foreground/10 bg-black/20 px-4 py-3">
            <div>
              <div className="text-sm font-semibold">Enable sibling waiver</div>
              <div className="text-xs text-foreground/40">
                When off, no requirement can be waived by a sibling.
              </div>
            </div>
            <input
              type="checkbox"
              checked={siblingWaiver.enabled}
              onChange={(e) => patchWaiver({ enabled: e.target.checked })}
              className="h-5 w-5 accent-primary"
            />
          </label>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <label className="flex flex-col gap-1.5">
              <span className="text-xs font-semibold uppercase tracking-wider text-foreground/50">
                Guardian minimum age
              </span>
              <TextInput
                type="number"
                inputMode="numeric"
                min={0}
                disabled={!siblingWaiver.enabled}
                value={String(siblingWaiver.guardianMinAge)}
                onChange={(e) =>
                  patchWaiver({
                    guardianMinAge: Math.max(0, Number(e.target.value) || 0),
                  })
                }
              />
              <span className="text-xs text-foreground/35">
                A sibling this age or older can cover a younger child.
              </span>
            </label>

            <label className="flex flex-col gap-1.5">
              <span className="text-xs font-semibold uppercase tracking-wider text-foreground/50">
                Waivable requirement
              </span>
              <SelectInput
                disabled={!siblingWaiver.enabled}
                value={siblingWaiver.waivableRequirement}
                onChange={(e) =>
                  patchWaiver({
                    waivableRequirement: e.target
                      .value as SupervisionRequirement,
                  })
                }
              >
                {REQUIREMENT_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </SelectInput>
              <span className="text-xs text-foreground/35">
                Only {requirementLabel(siblingWaiver.waivableRequirement).toLowerCase()} can be waived this way.
              </span>
            </label>
          </div>

          <label className="flex items-center justify-between gap-3 rounded-2xl border border-foreground/10 bg-black/20 px-4 py-3">
            <div>
              <div className="text-sm font-semibold">Staff-only (at the door)</div>
              <div className="text-xs text-foreground/40">
                When on, the waiver is never offered on customer self-booking —
                only staff at the door may authorize it.
              </div>
            </div>
            <input
              type="checkbox"
              checked={siblingWaiver.staffOnly}
              onChange={(e) => patchWaiver({ staffOnly: e.target.checked })}
              disabled={!siblingWaiver.enabled}
              className="h-5 w-5 accent-primary"
            />
          </label>
        </div>
      </section>

      <p className="flex items-center gap-2 text-xs text-foreground/40">
        <Info className="w-3.5 h-3.5 shrink-0" />
        Changes save instantly to the shared store and are kept in memory for
        this prototype (they reset on page reload). Enforcement in the booking
        and door flows is wired up separately.
      </p>
    </div>
  );
}
