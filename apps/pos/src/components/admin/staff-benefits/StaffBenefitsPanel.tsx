import { useCallback, useEffect, useState } from 'react';
import {
  ClipboardList,
  History,
  QrCode as QrCodeIcon,
  Save,
  Settings2,
  ShieldCheck,
} from 'lucide-react';
import type { BenefitRole } from '@oto/shared';
import type { BenefitProfile } from '@/types';
import { useCatalogStore } from '@/store/CatalogStoreContext';
import { useOperator } from '@/auth/OperatorContext';
import { getBenefitAuditLog } from '@/mockApi';
import {
  benefitsApi,
  inForceOn,
  profileFromApi,
  profileToApi,
  sameProfile,
  type BenefitTemplateRow,
  type BenefitTemplateVersion,
  type StaffBenefitRow,
} from '@/api/benefits';
import { toast } from '@/hooks/use-toast';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { BenefitProfileFields } from './BenefitProfileFields';
import { OperatorOverrideDialog } from './OperatorOverrideDialog';
import { BenefitHistoryList, type BenefitHistoryEntry } from './BenefitHistoryList';
import { summarizeProfile } from './summary';

const ROLE_ORDER: BenefitRole[] = ['owner', 'manager', 'staff'];

/** A template version as a history row. */
const templateEntry = (v: BenefitTemplateVersion): BenefitHistoryEntry => ({
  ...v,
  summary: summarizeProfile(profileFromApi(v.profile)),
});

/**
 * Admin editing screen for Task #231 staff benefits: the three role templates
 * (Owner/Manager/Staff) plus a per-operator view showing each staff member's
 * effective benefit, their scannable QR, and an override editor. All
 * F&B-only — the engine (`@oto/shared` benefits.ts) only ever runs at the
 * order station.
 *
 * S2-21 round 1 (SCRUM-218): on real data. The templates and each person's
 * benefit are the platform's (`/benefits/*`), versioned by the trading day a
 * change counts from; the staff list is `core.employee`, read only, because
 * the OTO App is the employee master. What the prototype saved on every
 * keystroke now saves on Save, with the day it starts — the UI additions are
 * that date, Save, the scheduled-change line and the history, each in the
 * panel's own card style. The Audit log section is still the till's in-memory
 * record until the benefit is applied on the platform (rounds 3 and 4); the QR
 * is issued in round 2.
 */
export function StaffBenefitsPanel() {
  const { menuCategories } = useCatalogStore();
  const { can } = useOperator();
  const canManage = can('admin:benefit:manage');

  const [today, setToday] = useState<string>('');
  const [templates, setTemplates] = useState<BenefitTemplateRow[]>([]);
  const [staff, setStaff] = useState<StaffBenefitRow[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  /** The editor's draft of each template and the day a save would start. */
  const [drafts, setDrafts] = useState<Partial<Record<BenefitRole, BenefitProfile>>>({});
  const [dates, setDates] = useState<Partial<Record<BenefitRole, string>>>({});
  const [saving, setSaving] = useState<BenefitRole | null>(null);
  const [historyOpen, setHistoryOpen] = useState<BenefitRole | null>(null);
  const [history, setHistory] = useState<{
    entries: BenefitHistoryEntry[];
    loading: boolean;
    error: string | null;
  }>({ entries: [], loading: false, error: null });

  const [overrideOperator, setOverrideOperator] = useState<StaffBenefitRow | null>(null);
  // Audit log is append-only and only ever written from the F&B order station;
  // a fresh read on panel mount/navigation is enough for this admin view.
  const [auditLog] = useState(() => getBenefitAuditLog());

  const reload = useCallback(async () => {
    setLoadError(null);
    try {
      const [t, s] = await Promise.all([benefitsApi.templates(), benefitsApi.staff()]);
      setToday(t.today);
      setTemplates(t.templates);
      setStaff(s.staff);
      setDrafts(
        Object.fromEntries(
          t.templates.map((row) => [row.role, profileFromApi(row.current?.profile ?? {})]),
        ),
      );
      setDates(Object.fromEntries(t.templates.map((row) => [row.role, t.today])));
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : 'Could not load staff benefits');
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const loadHistory = useCallback(async (role: BenefitRole) => {
    setHistory({ entries: [], loading: true, error: null });
    try {
      const res = await benefitsApi.templateHistory(role);
      setHistory({ entries: res.versions.map(templateEntry), loading: false, error: null });
    } catch (err) {
      setHistory({
        entries: [],
        loading: false,
        error: err instanceof Error ? err.message : 'Could not load history',
      });
    }
  }, []);

  const toggleHistory = (role: BenefitRole) => {
    if (historyOpen === role) {
      setHistoryOpen(null);
      return;
    }
    setHistoryOpen(role);
    void loadHistory(role);
  };

  const saveTemplate = async (template: BenefitTemplateRow) => {
    const draft = drafts[template.role];
    const effectiveFrom = dates[template.role] || today;
    if (!draft) return;
    setSaving(template.role);
    try {
      const res = await benefitsApi.saveTemplate(template.role, {
        profile: profileToApi(draft),
        effectiveFrom,
      });
      toast({
        title: res.changed ? `${template.name} template saved` : 'Nothing to change',
        description: res.changed
          ? effectiveFrom === today
            ? 'In force from today.'
            : `Takes effect on ${effectiveFrom}; today is unchanged.`
          : undefined,
      });
      await reload();
      if (historyOpen === template.role) void loadHistory(template.role);
    } catch (err) {
      toast({
        title: 'Not saved',
        description: err instanceof Error ? err.message : 'The template could not be saved',
        variant: 'destructive',
      });
    } finally {
      setSaving(null);
    }
  };

  const templateFor = (role: BenefitRole) => templates.find((t) => t.role === role);

  return (
    <div className="flex flex-col gap-8">
      {loadError && (
        <p className="rounded-xl border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          {loadError}
        </p>
      )}

      <section className="flex flex-col gap-4">
        <div className="flex items-center gap-2">
          <ShieldCheck className="w-4 h-4 text-foreground/60" />
          <h2 className="text-lg font-bold">Role templates</h2>
        </div>
        <p className="text-sm text-foreground/50">
          Every staff member inherits their role's template unless they have a personal override
          below. Applied only at the F&amp;B order station, in order: comp → free items → credit →
          standing % discount.
        </p>
        <div className="flex flex-col gap-4">
          {ROLE_ORDER.map((role) => {
            const template = templateFor(role);
            const draft = drafts[role];
            if (!template || !draft) return null;
            // Against the version that would be in force on the chosen day, which is
            // what the platform compares a save with: a change scheduled for that
            // day can be undone by saving today's profile for it.
            const on = dates[role] || today;
            const inForce = inForceOn(
              [...(template.current ? [template.current] : []), ...template.upcoming],
              on,
            );
            const dirty = !sameProfile(profileToApi(draft), inForce?.profile ?? {});
            return (
              <div
                key={role}
                className="rounded-2xl border border-foreground/10 bg-foreground/[0.02] p-4"
              >
                <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                  <div className="font-semibold">{template.name}</div>
                  <Button variant="outline" size="sm" onClick={() => toggleHistory(role)}>
                    <History className="w-4 h-4" />
                    History
                  </Button>
                </div>
                {template.upcoming.map((v) => (
                  <div key={v.id} className="mb-3 flex flex-wrap items-center gap-2 text-sm">
                    <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-xs text-amber-600">
                      From {v.effectiveFrom}
                    </span>
                    <span className="text-foreground/50">
                      {summarizeProfile(profileFromApi(v.profile))}
                    </span>
                  </div>
                ))}
                <fieldset
                  disabled={!canManage || saving === role}
                  className="m-0 min-w-0 border-0 p-0"
                >
                  <BenefitProfileFields
                    profile={draft}
                    categories={menuCategories}
                    onChange={(next) => setDrafts((d) => ({ ...d, [role]: next }))}
                  />
                  {canManage && (
                    <div className="mt-4 flex flex-wrap items-end justify-end gap-3 border-t border-foreground/10 pt-4">
                      <div className="flex flex-col gap-1">
                        <Label
                          htmlFor={`benefit-from-${role}`}
                          className="text-xs text-foreground/50"
                        >
                          Effective from
                        </Label>
                        <Input
                          id={`benefit-from-${role}`}
                          type="date"
                          min={today}
                          value={dates[role] ?? today}
                          onChange={(e) => setDates((d) => ({ ...d, [role]: e.target.value }))}
                          className="w-40"
                        />
                      </div>
                      <Button
                        onClick={() => void saveTemplate(template)}
                        disabled={!dirty || saving === role}
                      >
                        <Save className="w-4 h-4" />
                        Save
                      </Button>
                    </div>
                  )}
                </fieldset>
                {historyOpen === role && (
                  <div className="mt-4 border-t border-foreground/10 pt-4">
                    <BenefitHistoryList
                      entries={history.entries}
                      today={today}
                      loading={history.loading}
                      error={history.error}
                    />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </section>

      <section className="flex flex-col gap-4">
        <div className="flex items-center gap-2">
          <QrCodeIcon className="w-4 h-4 text-foreground/60" />
          <h2 className="text-lg font-bold">Staff</h2>
          <span className="text-sm text-foreground/40">({staff.length})</span>
        </div>
        {loaded && !loadError && staff.length === 0 && (
          <p className="text-sm text-foreground/50">No staff members on record.</p>
        )}
        <div className="flex flex-col gap-2">
          {staff.map((op) => {
            const role = op.current?.benefitRole ?? null;
            return (
              <div
                key={op.employeeId}
                className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-foreground/10 bg-foreground/[0.02] p-4"
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-medium">{op.name}</span>
                    <span className="rounded-full bg-foreground/5 px-2 py-0.5 text-xs capitalize text-foreground/60">
                      {role ?? 'none'}
                    </span>
                    {op.current?.override && (
                      <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-xs text-amber-600">
                        Override
                      </span>
                    )}
                  </div>
                  <div className="text-sm text-foreground/50">
                    {summarizeProfile(profileFromApi(op.effectiveProfile))}
                  </div>
                  {op.upcoming.map((v) => (
                    <div
                      key={v.id}
                      className="mt-1 flex flex-wrap items-center gap-2 text-xs text-foreground/50"
                    >
                      <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-amber-600">
                        From {v.effectiveFrom}
                      </span>
                      <span className="capitalize">{v.benefitRole ?? 'none'}</span>
                      {v.override && <span>· Override</span>}
                    </div>
                  ))}
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <Button variant="outline" size="sm" onClick={() => setOverrideOperator(op)}>
                    <Settings2 className="w-4 h-4" />
                    Override
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    // The benefit QR is issued by the platform in round 2
                    // (plan §8); until then nobody has one to show, which is
                    // the prototype's own rule for a person without a code.
                    disabled
                  >
                    <QrCodeIcon className="w-4 h-4" />
                    QR
                  </Button>
                </div>
              </div>
            );
          })}
        </div>
      </section>

      <section className="flex flex-col gap-4">
        <div className="flex items-center gap-2">
          <ClipboardList className="w-4 h-4 text-foreground/60" />
          <h2 className="text-lg font-bold">Audit log</h2>
          <span className="text-sm text-foreground/40">({auditLog.length})</span>
        </div>
        {auditLog.length === 0 ? (
          <p className="text-sm text-foreground/50">No staff benefits applied yet.</p>
        ) : (
          <div className="flex flex-col gap-2">
            {auditLog.map((entry) => (
              <div
                key={entry.id}
                className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-foreground/10 bg-foreground/[0.02] p-4 text-sm"
              >
                <div className="min-w-0">
                  <div className="font-medium">
                    {entry.scannedOperatorName}{' '}
                    <span className="text-foreground/40 capitalize">({entry.benefitRole})</span>
                  </div>
                  <div className="text-foreground/50">
                    {entry.isComp ? 'Full comp' : `฿${entry.totalReliefTHB} relief`} · processed by{' '}
                    {entry.processedByName} · {new Date(entry.at).toLocaleString()}
                    {entry.orderId && <> · order #{entry.orderId}</>}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      <OperatorOverrideDialog
        staff={overrideOperator}
        templates={templates}
        today={today}
        canManage={canManage}
        categories={menuCategories}
        open={overrideOperator !== null}
        onOpenChange={(open) => !open && setOverrideOperator(null)}
        onSaved={() => void reload()}
      />
    </div>
  );
}
