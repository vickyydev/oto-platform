import { useState } from 'react';
import {
  Building2,
  Copy,
  ChevronDown,
  AlertTriangle,
  CheckCircle2,
  Clock,
  Plus,
} from 'lucide-react';
import { useCatalogStore } from '@/store/CatalogStoreContext';
import { useBranch } from '@/branch/BranchContext';
import { useOperator } from '@/auth/OperatorContext';
import { NotSavedNotice } from '../NotSavedNotice';

type CloneStep = 'idle' | 'pick-source' | 'confirm-overwrite' | 'done';

/**
 * The zones a branch can trade in. Taken from the browser's own IANA database
 * rather than a list typed here: the zone decides which day a sale belongs to
 * and whether today prices as a weekend, and a name that is close but not
 * exact ("Asia/Phuket") is accepted by the text column and then silently
 * resolves to nothing. Older engines without `supportedValuesOf` fall back to
 * the zones the park and its neighbours actually use.
 */
function timezoneOptions(): string[] {
  const intl = Intl as typeof Intl & { supportedValuesOf?: (key: string) => string[] };
  const all = intl.supportedValuesOf?.('timeZone');
  if (all?.length) return all;
  return [
    'Asia/Bangkok',
    'Asia/Singapore',
    'Asia/Kuala_Lumpur',
    'Asia/Jakarta',
    'Asia/Ho_Chi_Minh',
    'Asia/Manila',
    'Asia/Hong_Kong',
    'Asia/Tokyo',
    'Asia/Dubai',
    'Europe/London',
    'UTC',
  ];
}

/** "HKT Chalong" → "hkt-chalong", the slug shape the platform's code column takes. */
function slugify(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

interface CloneStamp {
  sourceName: string;
  targetName: string;
  by: string;
  at: string;
}

export function BranchesPanel() {
  const { branches, mutators } = useCatalogStore();
  const { branch: activeBranch, setActiveBranchId } = useBranch();
  const { operator } = useOperator();

  const [step, setStep] = useState<CloneStep>('idle');
  const [sourceId, setSourceId] = useState<string>('');
  const [stamp, setStamp] = useState<CloneStamp | null>(null);

  // Opening a branch (SCRUM-240). `POST /branches` and the write-through have
  // been here since Sprint 1 with no screen calling them, so an operator
  // created in the admin console had no branch and no way to get one.
  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState('');
  const [newCode, setNewCode] = useState('');
  const [codeEdited, setCodeEdited] = useState(false);
  const [newCountry, setNewCountry] = useState('TH');
  const [newTimezone, setNewTimezone] = useState('Asia/Bangkok');
  const zones = timezoneOptions();

  const code = codeEdited ? newCode.trim() : slugify(newName);
  const codeTaken = branches.some((b) => b.id === code);
  const codeValid = /^[a-z0-9-]{2,}$/.test(code);
  const canCreate = newName.trim().length > 0 && codeValid && !codeTaken;

  function resetAdd() {
    setAdding(false);
    setNewName('');
    setNewCode('');
    setCodeEdited(false);
    setNewCountry('TH');
    setNewTimezone('Asia/Bangkok');
  }

  function createBranch() {
    if (!canCreate) return;
    // Name, code, timezone and country — everything the schema needs that has
    // no sensible default. Opening hours are deliberately NOT set here: the
    // column is nullable and null means "nobody has said yet", which the box
    // watchdog reads as "do not raise". Guessing them would either page
    // somebody at two in the morning or stay quiet through a busy Saturday.
    mutators.upsertBranch({
      id: code,
      name: newName.trim(),
      country: newCountry.trim() || undefined,
      timezone: newTimezone,
      active: true,
    });
    resetAdd();
  }

  // Branches that can be cloned FROM (any branch except the active/target one).
  const sourceBranches = branches.filter((b) => b.id !== activeBranch.id);

  function startClone() {
    setSourceId(sourceBranches[0]?.id ?? '');
    setStep('pick-source');
    setStamp(null);
  }

  function confirmSource() {
    if (!sourceId) return;
    const hasData = mutators.branchHasCatalogData(activeBranch.id);
    if (hasData) {
      setStep('confirm-overwrite');
    } else {
      runClone();
    }
  }

  function runClone() {
    const result = mutators.cloneBranchCatalog(sourceId, activeBranch.id);
    const src = branches.find((b) => b.id === result.sourceBranchId);
    const tgt = branches.find((b) => b.id === result.targetBranchId);
    setStamp({
      sourceName: src?.name ?? result.sourceBranchId,
      targetName: tgt?.name ?? result.targetBranchId,
      by: operator?.name ?? 'Unknown',
      at: result.at,
    });
    setStep('done');
  }

  function cancel() {
    setStep('idle');
    setSourceId('');
  }

  return (
    <div className="flex flex-col gap-6">
      {/* Branch list */}
      <div className="rounded-2xl border border-foreground/10 overflow-hidden">
        <div className="flex items-start justify-between gap-4 px-5 py-4 border-b border-foreground/10 bg-foreground/[0.02]">
          <div>
            <h2 className="font-semibold text-sm">Registered branches</h2>
            <p className="text-xs text-foreground/50 mt-0.5">
              All locations sharing this management console. Members are global; each
              branch has its own independent catalog after seeding or cloning.
            </p>
          </div>
          {!adding && (
            <button
              type="button"
              onClick={() => setAdding(true)}
              className="shrink-0 inline-flex items-center gap-2 rounded-xl bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground hover:opacity-90 transition-opacity"
            >
              <Plus className="w-4 h-4" />
              Add a branch
            </button>
          )}
        </div>

        {adding && (
          <div className="border-b border-foreground/10 px-5 py-5 bg-foreground/[0.02]">
            <div className="grid gap-4 sm:grid-cols-2 max-w-2xl">
              <div className="flex flex-col gap-1.5">
                <label className="text-xs font-semibold text-foreground/60 uppercase tracking-wide">
                  Branch name
                </label>
                <input
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  placeholder="e.g. HKT Chalong"
                  className="w-full rounded-xl border border-foreground/15 bg-background px-4 py-2.5 text-sm focus:outline-none focus:border-primary"
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <label className="text-xs font-semibold text-foreground/60 uppercase tracking-wide">
                  Branch ID
                </label>
                <input
                  value={code}
                  onChange={(e) => {
                    setCodeEdited(true);
                    setNewCode(e.target.value);
                  }}
                  placeholder="hkt-chalong"
                  className="w-full rounded-xl border border-foreground/15 bg-background px-4 py-2.5 text-sm font-mono focus:outline-none focus:border-primary"
                />
                <p className="text-xs text-foreground/40">
                  {codeTaken ? (
                    <span className="text-amber-400">
                      Another branch already uses this ID.
                    </span>
                  ) : code && !codeValid ? (
                    <span className="text-amber-400">
                      Lowercase letters, numbers and hyphens only.
                    </span>
                  ) : (
                    'Stamped on every sale, wristband and device at this branch. It cannot be changed afterwards.'
                  )}
                </p>
              </div>
              <div className="flex flex-col gap-1.5">
                <label className="text-xs font-semibold text-foreground/60 uppercase tracking-wide">
                  Timezone
                </label>
                <div className="relative">
                  <select
                    value={newTimezone}
                    onChange={(e) => setNewTimezone(e.target.value)}
                    className="w-full appearance-none rounded-xl border border-foreground/15 bg-background px-4 py-2.5 text-sm pr-9 focus:outline-none focus:border-primary"
                  >
                    {zones.map((z) => (
                      <option key={z} value={z}>
                        {z}
                      </option>
                    ))}
                  </select>
                  <ChevronDown className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-foreground/40" />
                </div>
                <p className="text-xs text-foreground/40">
                  Decides which trading day a sale lands on and whether today prices as a
                  weekend.
                </p>
              </div>
              <div className="flex flex-col gap-1.5">
                <label className="text-xs font-semibold text-foreground/60 uppercase tracking-wide">
                  Country
                </label>
                <input
                  value={newCountry}
                  onChange={(e) => setNewCountry(e.target.value.toUpperCase().slice(0, 2))}
                  placeholder="TH"
                  className="w-full rounded-xl border border-foreground/15 bg-background px-4 py-2.5 text-sm font-mono uppercase focus:outline-none focus:border-primary"
                />
                <p className="text-xs text-foreground/40">Two-letter code, as HKT Central uses TH.</p>
              </div>
            </div>
            <p className="mt-4 text-xs text-foreground/40 max-w-2xl">
              The branch opens with an empty catalogue — no tickets, menu or tax rules. Switch
              to it and clone from an existing branch below, or build it up in the other admin
              screens. Opening hours are set later; until somebody sets them the watchdog
              treats them as unknown rather than closed.
            </p>
            <div className="flex gap-2 mt-4">
              <button
                type="button"
                onClick={createBranch}
                disabled={!canCreate}
                className="rounded-xl bg-primary px-4 py-2.5 text-sm font-semibold text-primary-foreground hover:opacity-90 transition-opacity disabled:opacity-40"
              >
                Create branch
              </button>
              <button
                type="button"
                onClick={resetAdd}
                className="rounded-xl border border-foreground/15 px-4 py-2.5 text-sm font-medium text-foreground/60 hover:text-foreground hover:border-foreground/30 transition-colors"
              >
                Cancel
              </button>
            </div>
          </div>
        )}
        <ul className="divide-y divide-foreground/8">
          {branches.map((b) => {
            const isActive = b.id === activeBranch.id;
            return (
              <li
                key={b.id}
                className={`flex items-center gap-4 px-5 py-4 ${
                  isActive ? 'bg-primary/5' : ''
                }`}
              >
                <span
                  className={`inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-xl ${
                    isActive
                      ? 'bg-primary/15 text-primary'
                      : 'bg-foreground/5 text-foreground/40'
                  }`}
                >
                  <Building2 className="w-4.5 h-4.5" />
                </span>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-sm truncate">{b.name}</span>
                    {isActive && (
                      <span className="inline-flex items-center rounded-full bg-primary/15 px-2 py-0.5 text-[10px] font-semibold text-primary">
                        Active
                      </span>
                    )}
                    {!b.active && (
                      <span className="inline-flex items-center rounded-full bg-foreground/10 px-2 py-0.5 text-[10px] font-semibold text-foreground/40">
                        Retired
                      </span>
                    )}
                  </div>
                  <div className="text-xs text-foreground/40 mt-0.5">
                    {b.country ? `${b.country} · ` : ''}
                    ID: <code className="font-mono">{b.id}</code>
                  </div>
                </div>
                {!isActive && b.active && (
                  <button
                    type="button"
                    onClick={() => setActiveBranchId(b.id)}
                    className="shrink-0 rounded-lg border border-foreground/15 px-3 py-1.5 text-xs font-medium text-foreground/60 hover:text-foreground hover:border-foreground/30 transition-colors"
                  >
                    Switch here
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      </div>

      {/* Clone section */}
      <div className="rounded-2xl border border-foreground/10 overflow-hidden">
        <div className="px-5 py-4 border-b border-foreground/10 bg-foreground/[0.02]">
          <h2 className="font-semibold text-sm">Clone from another branch</h2>
          <p className="text-xs text-foreground/50 mt-0.5">
            Copy the entire catalog (tickets, menu, tax, devices, etc.) from a source
            branch into <strong>{activeBranch.name}</strong>. After cloning the
            branches are fully independent — changing one never affects the other.
          </p>
        </div>

        <div className="px-5 py-5">
          {/* The branch list above is the platform's. The clone is not: it
              copies the in-memory catalogue only, so it gets its own notice
              rather than one over the whole screen. */}
          <div className="mb-4">
            <NotSavedNotice
              mutators={['cloneBranchCatalog']}
              what="the catalogue a clone copies into this branch"
            />
          </div>

          {step === 'idle' && (
            <div className="flex flex-col gap-3">
              {stamp && <CloneSuccessBanner stamp={stamp} />}
              {sourceBranches.length === 0 ? (
                <p className="text-sm text-foreground/50 italic">
                  No other branches to clone from. Add more branches to use this
                  feature.
                </p>
              ) : (
                <button
                  type="button"
                  onClick={startClone}
                  className="inline-flex items-center gap-2 self-start rounded-xl bg-primary px-4 py-2.5 text-sm font-semibold text-primary-foreground hover:opacity-90 transition-opacity"
                >
                  <Copy className="w-4 h-4" />
                  Clone into {activeBranch.name}…
                </button>
              )}
            </div>
          )}

          {step === 'pick-source' && (
            <div className="flex flex-col gap-4 max-w-sm">
              <div className="flex flex-col gap-1.5">
                <label className="text-xs font-semibold text-foreground/60 uppercase tracking-wide">
                  Clone from
                </label>
                <div className="relative">
                  <select
                    value={sourceId}
                    onChange={(e) => setSourceId(e.target.value)}
                    className="w-full appearance-none rounded-xl border border-foreground/15 bg-background px-4 py-2.5 text-sm pr-9 focus:outline-none focus:border-primary"
                  >
                    {sourceBranches.map((b) => (
                      <option key={b.id} value={b.id}>
                        {b.name}
                      </option>
                    ))}
                  </select>
                  <ChevronDown className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-foreground/40" />
                </div>
                <p className="text-xs text-foreground/40">
                  All catalog items (tickets, menu, tax rules, devices, etc.) from
                  this branch will be deep-copied into{' '}
                  <strong>{activeBranch.name}</strong>.
                </p>
              </div>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={confirmSource}
                  disabled={!sourceId}
                  className="rounded-xl bg-primary px-4 py-2.5 text-sm font-semibold text-primary-foreground hover:opacity-90 transition-opacity disabled:opacity-40"
                >
                  Continue
                </button>
                <button
                  type="button"
                  onClick={cancel}
                  className="rounded-xl border border-foreground/15 px-4 py-2.5 text-sm font-medium text-foreground/60 hover:text-foreground hover:border-foreground/30 transition-colors"
                >
                  Cancel
                </button>
              </div>
            </div>
          )}

          {step === 'confirm-overwrite' && (
            <div className="flex flex-col gap-4 max-w-sm rounded-2xl border border-amber-400/30 bg-amber-400/5 p-5">
              <div className="flex items-start gap-3">
                <AlertTriangle className="w-5 h-5 shrink-0 text-amber-400 mt-0.5" />
                <div>
                  <p className="text-sm font-semibold text-amber-300">
                    This will overwrite existing catalog data
                  </p>
                  <p className="text-xs text-foreground/60 mt-1">
                    <strong>{activeBranch.name}</strong> already has catalog items.
                    Cloning from{' '}
                    <strong>
                      {branches.find((b) => b.id === sourceId)?.name ?? sourceId}
                    </strong>{' '}
                    will replace all of them with fresh copies. This cannot be
                    undone in this session.
                  </p>
                </div>
              </div>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={runClone}
                  className="rounded-xl bg-amber-500 px-4 py-2.5 text-sm font-semibold text-black hover:opacity-90 transition-opacity"
                >
                  Yes, overwrite and clone
                </button>
                <button
                  type="button"
                  onClick={cancel}
                  className="rounded-xl border border-foreground/15 px-4 py-2.5 text-sm font-medium text-foreground/60 hover:text-foreground hover:border-foreground/30 transition-colors"
                >
                  Cancel
                </button>
              </div>
            </div>
          )}

          {step === 'done' && stamp && (
            <div className="flex flex-col gap-3">
              <CloneSuccessBanner stamp={stamp} />
              <button
                type="button"
                onClick={() => setStep('idle')}
                className="self-start rounded-xl border border-foreground/15 px-4 py-2.5 text-sm font-medium text-foreground/60 hover:text-foreground hover:border-foreground/30 transition-colors"
              >
                Done
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function CloneSuccessBanner({ stamp }: { stamp: CloneStamp }) {
  return (
    <div className="flex items-start gap-3 rounded-xl border border-emerald-500/20 bg-emerald-500/5 px-4 py-3">
      <CheckCircle2 className="w-5 h-5 shrink-0 text-emerald-400 mt-0.5" />
      <div className="flex flex-col gap-0.5">
        <p className="text-sm font-semibold text-emerald-300">Catalog cloned successfully</p>
        <p className="text-xs text-foreground/60">
          All items from <strong>{stamp.sourceName}</strong> were deep-copied into{' '}
          <strong>{stamp.targetName}</strong> with fresh IDs — the branches are now
          fully independent.
        </p>
        <div className="flex items-center gap-1 mt-1 text-xs text-foreground/40">
          <Clock className="w-3 h-3" />
          <span>
            {new Date(stamp.at).toLocaleString()} by {stamp.by}
          </span>
        </div>
      </div>
    </div>
  );
}
