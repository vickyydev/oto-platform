import { useState } from 'react';
import {
  Building2,
  Copy,
  ChevronDown,
  AlertTriangle,
  CheckCircle2,
  Clock,
} from 'lucide-react';
import { useCatalogStore } from '@/store/CatalogStoreContext';
import { useBranch } from '@/branch/BranchContext';
import { useOperator } from '@/auth/OperatorContext';

type CloneStep = 'idle' | 'pick-source' | 'confirm-overwrite' | 'done';

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
        <div className="px-5 py-4 border-b border-foreground/10 bg-foreground/[0.02]">
          <h2 className="font-semibold text-sm">Registered branches</h2>
          <p className="text-xs text-foreground/50 mt-0.5">
            All locations sharing this management console. Members are global; each
            branch has its own independent catalog after seeding or cloning.
          </p>
        </div>
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
