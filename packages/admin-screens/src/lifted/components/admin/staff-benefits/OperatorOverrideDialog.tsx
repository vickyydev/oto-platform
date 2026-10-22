import { useAdminScreenRuntime } from '../../../runtime/AdminScreenRuntime';
import { useEffect, useRef, useState } from "react";
import { type BenefitRole } from "@oto/shared";
import { type BenefitProfile, type MenuCategoryDef } from "../../../model/types";
import { profileFromApi, profileToApi, type BenefitTemplateRow, type StaffBenefitRow, type StaffBenefitVersion } from "../../../api/benefits";

import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "../../ui/dialog";
import { Button } from "../../ui/button";
import { Input } from "../../ui/input";
import { Switch } from "../../ui/switch";
import { Label } from "../../ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../ui/select";
import { BenefitProfileFieldsWithPorts } from "./BenefitProfileFields";
import { BenefitHistoryList, type BenefitHistoryEntry } from "./BenefitHistoryList";
import { useBenefitIdentity, type BenefitDialogPorts } from '../../../runtime/benefits';
import { idemKey } from '../../../api/client';


const NO_ROLE = 'none';
type RoleChoice = BenefitRole | typeof NO_ROLE;

/** A person's version as a history row: their role, and the override when one was on. */
function staffEntry(v: StaffBenefitVersion, templates: BenefitTemplateRow[], summarizeProfile: (profile: BenefitProfile) => string): BenefitHistoryEntry {
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
interface OverrideProps {
  staff: StaffBenefitRow | null;
  templates: BenefitTemplateRow[];
  today: string;
  canManage: boolean;
  categories: MenuCategoryDef[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void | Promise<void>;
}
export function OperatorOverrideDialog(props: OverrideProps) {
  const runtime = useAdminScreenRuntime();
  return <OperatorOverrideDialogWithPorts {...props} ports={{ contextKey: runtime.session.operator?.id ?? '', api: runtime.api.benefits, menu: runtime.domain.menu, summarizeProfile: runtime.domain.benefitSummary.summarizeProfile, toast: runtime.toast }} />;
}
export function OperatorOverrideDialogWithPorts({ staff, templates, today, canManage, categories, open, onOpenChange, onSaved, ports }: OverrideProps & { ports: BenefitDialogPorts }) {
  const benefitsApi = ports.api, summarizeProfile = ports.summarizeProfile, toast = ports.toast;
  const identity = useBenefitIdentity(ports.contextKey + '|' + (staff?.employeeId ?? '') + '|' + open);
  const identityRef = useRef(identity), staffRef = useRef(staff?.employeeId), openRef = useRef(open), manageRef = useRef(canManage), mounted = useRef(true), savingRef = useRef(false);
  identityRef.current = identity; staffRef.current = staff?.employeeId; openRef.current = open; manageRef.current = canManage;
  const intentRef = useRef<{ identity: string; bodyKey: string; key: string; confirmed: boolean; changed?: boolean } | null>(null);
  const inputRef = useRef({ staff, today, templates, summarizeProfile });
  inputRef.current = { staff, today, templates, summarizeProfile };
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  const [role, setRole] = useState<RoleChoice>(NO_ROLE);
  const [enabled, setEnabled] = useState(false);
  const [profile, setProfile] = useState<BenefitProfile>({});
  const [effectiveFrom, setEffectiveFrom] = useState(today);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [history, setHistory] = useState<{
    entries: BenefitHistoryEntry[];
    loading: boolean;
    error: string | null;
  }>({ entries: [], loading: false, error: null });

  useEffect(() => {
    const { staff, today, templates, summarizeProfile } = inputRef.current;
    if (!staff) return;
    const requestIdentity = identityRef.current;
    intentRef.current = null;
    savingRef.current = false;
    setSaving(false);
    setError(null);
    setRole(staff.current?.benefitRole ?? NO_ROLE);
    setEnabled(!!staff.current?.override);
    setProfile(profileFromApi(staff.current?.override ?? staff.effectiveProfile));
    setEffectiveFrom(today);
    setHistory({ entries: [], loading: true, error: null });
    let live = true;
    benefitsApi
      .staffHistory(staff.employeeId)
      .then((res) => {
        if (live && mounted.current && identityRef.current === requestIdentity)
          setHistory({
            entries: res.versions.map((v) => staffEntry(v, templates, summarizeProfile)),
            loading: false,
            error: null,
          });
      })
      .catch((err: unknown) => {
        if (live && mounted.current && identityRef.current === requestIdentity) {
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
    // New catalogue objects only name history; they must not replace a draft.
  }, [identity, benefitsApi]);

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
    if (!staff || savingRef.current || !manageRef.current || !openRef.current || !mounted.current || identityRef.current !== identity || staffRef.current !== staff.employeeId) return;
    const requestIdentity = identity, employeeId = staff.employeeId;
    const owns = () => mounted.current && identityRef.current === requestIdentity && staffRef.current === employeeId && openRef.current && manageRef.current;
    const benefitRole = role === NO_ROLE ? null : role;
    const body = { benefitRole, override: benefitRole && enabled ? profileToApi(profile) : null, effectiveFrom: effectiveFrom || today };
    const bodyKey = JSON.stringify(body);
    if (intentRef.current?.identity !== requestIdentity || intentRef.current.bodyKey !== bodyKey)
      intentRef.current = { identity: requestIdentity, bodyKey, key: idemKey(), confirmed: false };
    const intent = intentRef.current;
    savingRef.current = true;
    setSaving(true);
    setError(null);
    try {
      if (!intent.confirmed) {
        const res = await benefitsApi.saveStaff(employeeId, body, intent.key);
        intent.confirmed = true;
        intent.changed = res.changed;
      }
      if (!owns()) return;
      await onSaved();
      if (!owns()) return;
      toast({
        title: intent.changed ? `${staff.name} — benefit saved` : 'Nothing to change',
        description:
          intent.changed && effectiveFrom && effectiveFrom !== today
            ? `Takes effect on ${effectiveFrom}; today is unchanged.`
            : undefined,
      });
      intentRef.current = null;
      onOpenChange(false);
    } catch (err) {
      if (!owns()) return;
      if (intent.confirmed) { setError('Saved, but the current benefit could not be read. Save again to retry the read without another change.'); return; }
      toast({
        title: 'Not saved',
        description: err instanceof Error ? err.message : 'The benefit could not be saved',
        variant: 'destructive',
      });
    } finally {
      if (identityRef.current === requestIdentity && mounted.current) { savingRef.current = false; setSaving(false); }
    }
  };
  const changeOpen = (next: boolean) => {
    if (!next) { identityRef.current += '|closed'; openRef.current = false; }
    onOpenChange(next);
  };

  return (
    <Dialog open={open} onOpenChange={changeOpen}>
      <DialogContent className="max-w-lg max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{staff.name} — benefit override</DialogTitle>
          <DialogDescription>
            Overrides replace this staff member's role template entirely while enabled.
          </DialogDescription>
        </DialogHeader>
        {error && <p className="text-sm text-destructive">{error}</p>}

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
                <BenefitProfileFieldsWithPorts
                  profile={profile}
                  categories={categories}
                  onChange={setProfile}
                  ports={{ menu: ports.menu }}
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
          <Button variant="outline" onClick={() => changeOpen(false)}>
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
