import { useEffect, useState } from 'react';
import type { BenefitRole } from '@oto/shared';
import type { BenefitProfile, MenuCategoryDef } from '@/types';
import {
  benefitsApi,
  profileFromApi,
  profileToApi,
  type BenefitTemplateRow,
  type StaffBenefitRow,
  type StaffBenefitVersion,
} from '@/api/benefits';
import { toast } from '@/hooks/use-toast';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { BenefitProfileFields } from './BenefitProfileFields';
import { BenefitHistoryList, type BenefitHistoryEntry } from './BenefitHistoryList';
import { summarizeProfile } from './summary';

const NO_ROLE = 'none';
type RoleChoice = BenefitRole | typeof NO_ROLE;

/** A person's version as a history row: their role, and the override when one was on. */
function staffEntry(v: StaffBenefitVersion, templates: BenefitTemplateRow[]): BenefitHistoryEntry {
  const roleName = v.benefitRole
    ? (templates.find((t) => t.role === v.benefitRole)?.name ?? v.benefitRole)
    : null;
  const summary = !roleName
    ? 'No benefit configured'
    : v.override
      ? `${roleName} · Override: ${summarizeProfile(profileFromApi(v.override))}`
      : `${roleName} template`;
  return { ...v, summary };
}

/**
 * Per-operator override editor. Off = the operator inherits their role
 * template untouched. On = a custom BenefitProfile that is their whole
 * profile while it is on, pre-filled from their current effective profile so
 * switching it on doesn't silently blank out their benefit.
 *
 * S2-21 round 1 (SCRUM-218): saved to the platform for the person's
 * `core.employee` row. Three UI additions in the dialog's own style: the
 * benefit role (which the prototype's roster carried and its screen never
 * offered to change), the day the change counts from, and the history of
 * every change to this person's benefit.
 */
export function OperatorOverrideDialog({
  staff,
  templates,
  today,
  canManage,
  categories,
  open,
  onOpenChange,
  onSaved,
}: {
  staff: StaffBenefitRow | null;
  templates: BenefitTemplateRow[];
  today: string;
  canManage: boolean;
  categories: MenuCategoryDef[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
}) {
  const [role, setRole] = useState<RoleChoice>(NO_ROLE);
  const [enabled, setEnabled] = useState(false);
  const [profile, setProfile] = useState<BenefitProfile>({});
  const [effectiveFrom, setEffectiveFrom] = useState(today);
  const [saving, setSaving] = useState(false);
  const [history, setHistory] = useState<{
    entries: BenefitHistoryEntry[];
    loading: boolean;
    error: string | null;
  }>({ entries: [], loading: false, error: null });

  useEffect(() => {
    if (!staff) return;
    setRole(staff.current?.benefitRole ?? NO_ROLE);
    setEnabled(!!staff.current?.override);
    setProfile(profileFromApi(staff.current?.override ?? staff.effectiveProfile));
    setEffectiveFrom(today);
    setHistory({ entries: [], loading: true, error: null });
    let live = true;
    benefitsApi
      .staffHistory(staff.employeeId)
      .then((res) => {
        if (live)
          setHistory({
            entries: res.versions.map((v) => staffEntry(v, templates)),
            loading: false,
            error: null,
          });
      })
      .catch((err: unknown) => {
        if (live) {
          setHistory({
            entries: [],
            loading: false,
            error: err instanceof Error ? err.message : 'Could not load history',
          });
        }
      });
    return () => {
      live = false;
    };
    // `templates` only names the roles in the history; a reload of them must
    // not reset an edit in progress.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [staff, today]);

  if (!staff) return null;

  const templateName = (r: BenefitRole) => templates.find((t) => t.role === r)?.name ?? r;

  /** A new role, with the override off, shows that role's template as the starting point. */
  const chooseRole = (next: RoleChoice) => {
    setRole(next);
    if (!enabled && next !== NO_ROLE) {
      setProfile(profileFromApi(templates.find((t) => t.role === next)?.current?.profile ?? {}));
    }
  };

  const save = async () => {
    setSaving(true);
    try {
      const benefitRole = role === NO_ROLE ? null : role;
      const res = await benefitsApi.saveStaff(staff.employeeId, {
        benefitRole,
        override: benefitRole && enabled ? profileToApi(profile) : null,
        effectiveFrom: effectiveFrom || today,
      });
      toast({
        title: res.changed ? `${staff.name} — benefit saved` : 'Nothing to change',
        description:
          res.changed && effectiveFrom && effectiveFrom !== today
            ? `Takes effect on ${effectiveFrom}; today is unchanged.`
            : undefined,
      });
      onSaved();
      onOpenChange(false);
    } catch (err) {
      toast({
        title: 'Not saved',
        description: err instanceof Error ? err.message : 'The benefit could not be saved',
        variant: 'destructive',
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{staff.name} — benefit override</DialogTitle>
          <DialogDescription>
            Overrides replace this staff member's role template entirely while enabled.
          </DialogDescription>
        </DialogHeader>

        <fieldset
          disabled={!canManage || saving}
          className="m-0 flex min-w-0 flex-col gap-4 border-0 p-0"
        >
          <div className="flex items-center justify-between gap-3 rounded-xl border border-foreground/10 bg-foreground/[0.02] px-4 py-3">
            <Label className="text-sm font-semibold">Benefit role</Label>
            <Select value={role} onValueChange={(v) => chooseRole(v as RoleChoice)}>
              <SelectTrigger className="w-40">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {templates.map((t) => (
                  <SelectItem key={t.role} value={t.role}>
                    {t.name}
                  </SelectItem>
                ))}
                <SelectItem value={NO_ROLE}>No benefit</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {role === NO_ROLE ? (
            <p className="text-sm text-foreground/50">No benefit configured</p>
          ) : (
            <>
              <div className="flex items-center justify-between gap-3 rounded-xl border border-foreground/10 bg-foreground/[0.02] px-4 py-3">
                <Label className="text-sm font-semibold">Custom override</Label>
                <Switch checked={enabled} onCheckedChange={setEnabled} />
              </div>

              {enabled ? (
                <BenefitProfileFields
                  profile={profile}
                  categories={categories}
                  onChange={setProfile}
                />
              ) : (
                <p className="text-sm text-foreground/50">
                  Currently inheriting the “{templateName(role)}” role template.
                </p>
              )}
            </>
          )}

          {canManage && (
            <div className="flex items-center justify-between gap-3 rounded-xl border border-foreground/10 bg-foreground/[0.02] px-4 py-3">
              <Label htmlFor="benefit-person-from" className="text-sm font-semibold">
                Effective from
              </Label>
              <Input
                id="benefit-person-from"
                type="date"
                min={today}
                value={effectiveFrom}
                onChange={(e) => setEffectiveFrom(e.target.value)}
                className="w-40"
              />
            </div>
          )}
        </fieldset>

        <div className="flex flex-col gap-2 border-t border-foreground/10 pt-4">
          <Label className="text-sm font-semibold">History</Label>
          <BenefitHistoryList
            entries={history.entries}
            today={today}
            loading={history.loading}
            error={history.error}
          />
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          {canManage && (
            <Button onClick={() => void save()} disabled={saving}>
              Save
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
