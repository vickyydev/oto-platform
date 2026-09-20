import { Check, Loader2, UserCheck, Users } from 'lucide-react';
import type { StaffCandidate, StationAccessScope } from '@/api/platform';
import { ModeOption } from '@/components/station/ModeOption';
import { cn } from '@/lib/utils';

/**
 * Who may work this station.
 *
 * The choice drives visibility and not merely permission: an `all_staff`
 * station is in every signed-in member's picker, and a `selected_staff` one is
 * in the pickers of the people named here and in nobody else's. That is the
 * point of naming them — somebody who cannot use the booth till should not be
 * looking at it and wondering why it turns them away.
 *
 * The list offered is the staff of this branch, because a station stands in one
 * branch and nobody from another is going to be standing at it.
 */
export function StaffAccessPicker({
  scope,
  onScopeChange,
  staff,
  loading,
  branchFiltered,
  selected,
  onToggle,
  compact,
}: {
  scope: StationAccessScope;
  onScopeChange: (scope: StationAccessScope) => void;
  staff: StaffCandidate[] | null;
  loading: boolean;
  /**
   * False when the list is the whole operator's staff rather than this
   * branch's, because the API route that narrows it is not deployed here yet.
   * An unfiltered list that looks filtered is how somebody at the other branch
   * ends up on a till they will never stand at, so the screen says which it is.
   */
  branchFiltered: boolean;
  selected: string[];
  onToggle: (accountId: string) => void;
  compact?: boolean;
}) {
  return (
    <>
      <div className={cn('flex flex-col gap-3', compact ? 'mb-3' : 'mb-4')}>
        <ModeOption
          active={scope === 'all_staff'}
          icon={<Users className="w-5 h-5" />}
          label="Open to all staff"
          description="Anyone signed in at this branch sees it and can take it."
          onClick={() => onScopeChange('all_staff')}
        />
        <ModeOption
          active={scope === 'selected_staff'}
          icon={<UserCheck className="w-5 h-5" />}
          label="Only the staff I name"
          description="Everybody else does not see this station at all."
          onClick={() => onScopeChange('selected_staff')}
        />
      </div>

      {scope === 'selected_staff' && (
        <>
          {staff === null || loading ? (
            <div className="flex justify-center py-6">
              <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
            </div>
          ) : staff.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Nobody is assigned to this branch yet. Add staff under Access, then come back.
            </p>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {staff.map((person) => {
                const active = selected.includes(person.accountId);
                const name = person.name ?? person.phone ?? person.accountId;
                return (
                  <button
                    key={person.accountId}
                    type="button"
                    onClick={() => onToggle(person.accountId)}
                    className={cn(
                      'rounded-xl border p-4 text-left transition-colors min-h-[72px]',
                      active ? 'border-primary bg-primary/10' : 'hover:bg-muted',
                    )}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className={cn('font-semibold truncate', active && 'text-primary')}>
                        {name}
                      </span>
                      {active && <Check className="w-5 h-5 text-primary shrink-0" />}
                    </div>
                    <div className="text-xs text-muted-foreground mt-1">{person.phone ?? ''}</div>
                  </button>
                );
              })}
            </div>
          )}
          {!branchFiltered && staff !== null && staff.length > 0 && (
            <p className="text-xs text-muted-foreground mt-3">
              This is every account on the operator, not only this branch's staff — the API route
              that narrows it is not on this deployment yet.
            </p>
          )}
          {selected.length === 0 && staff !== null && staff.length > 0 && (
            <p className="text-xs text-muted-foreground mt-3">
              Nobody is named yet, so this station is in nobody's picker — not even yours.
            </p>
          )}
        </>
      )}
    </>
  );
}
