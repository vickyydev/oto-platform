import { useState, useRef, useEffect } from 'react';
import { Building2, ChevronDown, Check } from 'lucide-react';
import { useBranch } from '@/branch/BranchContext';

/**
 * Compact branch switcher used in the iPad StationHeader and the mobile top bar.
 * Shows the active branch name (abbreviated to save space) and a dropdown to
 * switch between registered branches.
 */
export function BranchSwitcher() {
  const { branch, branches, setActiveBranchId } = useBranch();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  if (branches.length <= 1) {
    return (
      <span className="flex items-center gap-1.5 text-xs text-muted-foreground px-2 h-8">
        <Building2 className="w-3.5 h-3.5 shrink-0" />
        <span className="truncate max-w-[110px]">{branch.name}</span>
      </span>
    );
  }

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-1.5 text-xs font-medium rounded-md px-2 h-8 bg-muted/60 hover:bg-muted transition-colors text-foreground"
        title="Switch branch"
      >
        <Building2 className="w-3.5 h-3.5 shrink-0 text-muted-foreground" />
        <span className="truncate max-w-[110px]">{branch.name}</span>
        <ChevronDown className={`w-3 h-3 shrink-0 text-muted-foreground transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && (
        <div className="absolute left-0 top-full mt-1 z-50 min-w-[160px] rounded-lg border bg-card shadow-lg py-1">
          {branches.map((b) => (
            <button
              key={b.id}
              type="button"
              onClick={() => { setActiveBranchId(b.id); setOpen(false); }}
              className="w-full flex items-center gap-2 px-3 py-2 text-sm hover:bg-muted/60 transition-colors text-left"
            >
              <Check className={`w-3.5 h-3.5 shrink-0 ${b.id === branch.id ? 'text-primary' : 'text-transparent'}`} />
              <span className="truncate">{b.name}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
