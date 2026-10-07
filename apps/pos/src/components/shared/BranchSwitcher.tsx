import { useState, useRef, useEffect } from 'react';
import { Building2, ChevronDown, Check } from 'lucide-react';
import { useBranch } from '@/branch/BranchContext';

/**
 * SCRUM-443 — HOW THE CHIP SHOWS A PARK'S NAME. The parks are named "Oto Play
 * Park, Central Floresta" and "Oto Play Park, Robinson Chalong", and a single
 * 110px line cut both to "Oto Play Park, Ce…", which names neither. The chip
 * may not simply grow to fit: the header's nav is already short of room at
 * 1600px (`StationHeader`), so every pixel the chip takes is a tab scrolled out
 * of sight. Instead the name wraps onto a second line inside the chip's own
 * 32px height — both parks read in full for barely more width than before —
 * and a name longer than two lines is clamped and given in full on hover.
 */
const BRANCH_NAME_CLASS ='line-clamp-2 max-w-[120px] break-words text-left leading-tight';

/**
 * Compact branch switcher used in the iPad StationHeader and the mobile top bar.
 * Shows the active branch name (on up to two lines, see `BRANCH_NAME_CLASS`)
 * and a dropdown to switch between registered branches.
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
        <span className={BRANCH_NAME_CLASS} title={branch.name}>{branch.name}</span>
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
        <span className={BRANCH_NAME_CLASS} title={branch.name}>{branch.name}</span>
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
