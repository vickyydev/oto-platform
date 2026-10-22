import { useAdminScreenRuntime } from '../../../runtime/AdminScreenRuntime';
import { useCallback, useEffect, useRef, useState } from "react";
import { ClipboardList, History, QrCode as QrCodeIcon, Save, Settings2, ShieldCheck } from "lucide-react";
import { type BenefitRole } from "@oto/shared";
import { type BenefitProfile } from "../../../model/types";
import { useCatalogStore } from "../../../runtime/AdminScreenRuntime";
import { useOperator } from "../../../runtime/AdminScreenRuntime";
import { type BenefitAuditEntry } from "../../../model/types";
import { type BenefitApplicationLogRow, inForceOn, profileFromApi, profileToApi, sameProfile, type BenefitTemplateRow, type BenefitTemplateVersion, type StaffBenefitRow } from "../../../api/benefits";

import { Button } from "../../ui/button";
import { Input } from "../../ui/input";
import { Label } from "../../ui/label";
import { BenefitProfileFieldsWithPorts } from "./BenefitProfileFields";
import { OperatorOverrideDialogWithPorts } from "./OperatorOverrideDialog";
import { BenefitQrDialogWithPorts } from "./BenefitQrDialog";
import { BenefitHistoryList, type BenefitHistoryEntry } from "./BenefitHistoryList";
import { StaffSourceChip } from "./StaffSourceChip";
import { useBenefitIdentity, useBenefitsCapabilities, type StaffBenefitsPanelPorts } from '../../../runtime/benefits';
import { idemKey } from '../../../api/client';


const ROLE_ORDER: BenefitRole[] = ['owner', 'manager', 'staff'];

/**
 * A platform application as the prototype's Audit log entry (S2-21 round 3):
 * the same fields the panel always drew, in baht, with the order named by its
 * receipt number.
 */
const auditEntryOf = (row: BenefitApplicationLogRow): BenefitAuditEntry & { refundedTHB: number } => ({
  id: row.id,
  at: row.at,
  scannedOperatorId: row.employeeId,
  scannedOperatorName: row.employeeName,
  benefitRole: row.benefitRole,
  processedById: row.processedByAccountId,
  processedByName: row.processedByName ?? '',
  isComp: row.isComp,
  compedTHB: row.compedSatang / 100,
  freeItemsTHB: row.freeItemsSatang / 100,
  creditTHB: row.creditSatang / 100,
  discountTHB: row.discountSatang / 100,
  totalReliefTHB: row.totalReliefSatang / 100,
  orderId: row.receiptNumber ?? row.saleId,
  branchId: row.branchId,
  // S2-21 round 4 — what the order has since given back in money. The entry
  // and the quota stay as they were (plan Q4's default).
  refundedTHB: row.refundedSatang / 100,
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
 * panel's own card style.
 *
 * S2-21 rounds 3 and 4: the Audit log is the platform's
 * (`GET /benefits/applications`), read by the reader's branch reach; an entry
 * whose order was since refunded says so ("· refunded ฿…", a UI addition) —
 * the relief and the quota stay as they were (plan Q4's default).
 *
 * S2-21 round 2: the QR button opens the prototype's QR dialog on the
 * platform's signed benefit QR — issued, printed and revoked there by whoever
 * holds `admin:benefit:credential_issue` (`BenefitQrDialog`).
 *
 * S2-17b round 2: the staff list is fed by the OTO App's copy
 * (`job:otoapp.employee_sync`), and each row says where its record is kept —
 * "OTO App" or "Platform" (`StaffSourceChip`, a UI addition).
 */
export function StaffBenefitsPanel() {
  const runtime = useAdminScreenRuntime();
  const { menuCategories } = useCatalogStore();
  const { operator } = useOperator();
  const scope = useBenefitsCapabilities(runtime.transport, operator?.id, operator, runtime.branch.branch.apiId);
  return <StaffBenefitsPanelWithPorts ports={{ contextKey: scope.contextKey, api: runtime.api.benefits, categories: menuCategories, menu: runtime.domain.menu, summarizeProfile: runtime.domain.benefitSummary.summarizeProfile, toast: runtime.toast, canManage: scope.canManage, canIssueQr: scope.canIssueQr }} />;
}
export function StaffBenefitsPanelWithPorts({ ports }: { ports: StaffBenefitsPanelPorts }) {
  const benefitsApi = ports.api, toast = ports.toast, summarizeProfile = ports.summarizeProfile, menuCategories = ports.categories, canManage = ports.canManage;
  const identity = useBenefitIdentity(ports.contextKey), contextRef = useRef(identity), mounted = useRef(true), readEpoch = useRef(0), historyEpoch = useRef(0), manageRef = useRef(canManage);
  contextRef.current = identity; manageRef.current = canManage;
  const baseDraftsRef = useRef<Partial<Record<BenefitRole, BenefitProfile>>>({}), baseDatesRef = useRef<Partial<Record<BenefitRole, string>>>({});
  const templateBusyRef = useRef(new Set<BenefitRole>());
  const intentsRef = useRef<Partial<Record<BenefitRole, { context: string; bodyKey: string; key: string; confirmed: boolean; changed?: boolean }>>>({});
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; readEpoch.current++; historyEpoch.current++; }; }, []);



/** A template version as a history row. */
const templateEntry = useCallback((v: BenefitTemplateVersion): BenefitHistoryEntry => ({
  ...v,
  summary: summarizeProfile(profileFromApi(v.profile)),
}), [summarizeProfile]);


  const [heldToday, setToday] = useState<string>('');
  const [heldTemplates, setTemplates] = useState<BenefitTemplateRow[]>([]);
  const [heldStaff, setStaff] = useState<StaffBenefitRow[]>([]);
  const [dataIdentity, setDataIdentity] = useState('');
  const today = dataIdentity === identity ? heldToday : '', templates = dataIdentity === identity ? heldTemplates : [], staff = dataIdentity === identity ? heldStaff : [];
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  /** The editor's draft of each template and the day a save would start. */
  const [drafts, setDrafts] = useState<Partial<Record<BenefitRole, BenefitProfile>>>({});
  const [dates, setDates] = useState<Partial<Record<BenefitRole, string>>>({});
  const draftsRef = useRef(drafts), datesRef = useRef(dates);
  draftsRef.current = drafts; datesRef.current = dates;
  const [saving, setSaving] = useState<ReadonlySet<BenefitRole>>(new Set());
  const [historyOpen, setHistoryOpen] = useState<BenefitRole | null>(null);
  const historyOpenRef = useRef(historyOpen);
  historyOpenRef.current = historyOpen;
  const [history, setHistory] = useState<{
    entries: BenefitHistoryEntry[];
    loading: boolean;
    error: string | null;
  }>({ entries: [], loading: false, error: null });

  const [overrideOperator, setOverrideOperator] = useState<StaffBenefitRow | null>(null);
  const [qrOperator, setQrOperator] = useState<StaffBenefitRow | null>(null);
  // Audit log is append-only and only ever written from the F&B order station;
  // a fresh read on panel mount/navigation is enough for this admin view.
  // S2-21 round 3 — read from the platform: every benefit applied to a
  // recorded order, the prototype's entry fields (`auditEntryOf`).
  const [heldAuditLog, setAuditLog] = useState<Array<BenefitAuditEntry & { refundedTHB: number }>>([]);
  const auditLog = dataIdentity === identity ? heldAuditLog : [];

  const reload = useCallback(async (adopt?: { role: BenefitRole; draft: BenefitProfile; date: string }) => {
    const request = ++readEpoch.current, context = contextRef.current;
    const owns = () => mounted.current && readEpoch.current === request && contextRef.current === context;
    setLoadError(null);
    let loadedCurrent = false;
    try {
      const [t, s] = await Promise.all([benefitsApi.templates(), benefitsApi.staff()]);
      if (!owns()) return false;
      setToday(t.today);
      setTemplates(t.templates);
      setStaff(s.staff);
      setDataIdentity(context);
      const canonicalDrafts = Object.fromEntries(t.templates.map(row => [row.role, profileFromApi(row.current?.profile ?? {})]));
      const previousDrafts = baseDraftsRef.current, previousDates = baseDatesRef.current;
      setDrafts(current => Object.fromEntries(t.templates.map(row => {
        const draft = current[row.role], previous = previousDrafts[row.role];
        return [row.role,
          !draft || draft === previous || previous && sameProfile(profileToApi(draft), profileToApi(previous)) || adopt?.role === row.role && draft === adopt.draft
            ? canonicalDrafts[row.role] : draft,
        ];
      })));
      setDates(current => Object.fromEntries(t.templates.map(row => [row.role,
        !current[row.role] || current[row.role] === previousDates[row.role] || adopt?.role === row.role && current[row.role] === adopt.date
          ? t.today : current[row.role],
      ])));
      baseDraftsRef.current = canonicalDrafts;
      baseDatesRef.current = Object.fromEntries(t.templates.map(row => [row.role, t.today]));
      for (const row of t.templates) {
        const intent = intentsRef.current[row.role];
        if (!intent?.confirmed || intent.context !== context) continue;
        const body = JSON.parse(intent.bodyKey) as { profile: Parameters<typeof sameProfile>[0]; effectiveFrom: string };
        const version = inForceOn(row.current ? [row.current, ...row.upcoming] : row.upcoming, body.effectiveFrom);
        if (version && sameProfile(version.profile, body.profile)) delete intentsRef.current[row.role];
      }
      loadedCurrent = true;
    } catch (err) {
      if (owns()) setLoadError(adopt ? 'Saved, but current staff benefits could not be read. Try again to refresh without another change.' : err instanceof Error ? err.message : 'Could not load staff benefits');
    } finally {
      if (owns()) setLoaded(true);
    }
    // The log is read on its own: a deployment that cannot answer it still
    // shows the templates and the staff, with the log empty.
    if (!owns()) return false;
    try {
      const log = await benefitsApi.applications();
      if (owns()) setAuditLog(log.applications.map(auditEntryOf));
    } catch {
      if (owns()) setAuditLog([]);
    }
    return loadedCurrent && owns();
  }, [benefitsApi]);

  useEffect(() => {
    readEpoch.current++; historyEpoch.current++;
    draftsRef.current = {}; datesRef.current = {}; baseDraftsRef.current = {}; baseDatesRef.current = {};
    intentsRef.current = {}; templateBusyRef.current.clear();
    setDrafts({}); setDates({}); setSaving(new Set()); setLoaded(false); setOverrideOperator(null); setQrOperator(null); setHistoryOpen(null); historyOpenRef.current = null;
    void reload();
  }, [reload, identity]);

  const loadHistory = useCallback(async (role: BenefitRole) => {
    const request = ++historyEpoch.current, context = contextRef.current;
    const owns = () => mounted.current && historyEpoch.current === request && contextRef.current === context && historyOpenRef.current === role;
    setHistory({ entries: [], loading: true, error: null });
    try {
      const res = await benefitsApi.templateHistory(role);
      if (owns()) setHistory({ entries: res.versions.map(templateEntry), loading: false, error: null });
    } catch (err) {
      if (owns()) setHistory({
        entries: [],
        loading: false,
        error: err instanceof Error ? err.message : 'Could not load history',
      });
    }
  }, [benefitsApi, templateEntry]);

  const toggleHistory = (role: BenefitRole) => {
    if (historyOpen === role) {
      historyEpoch.current++; historyOpenRef.current = null;
      setHistoryOpen(null);
      return;
    }
    setHistoryOpen(role);
    historyOpenRef.current = role;
    void loadHistory(role);
  };

  const saveTemplate = async (template: BenefitTemplateRow) => {
    const draft = drafts[template.role];
    const effectiveFrom = dates[template.role] || today;
    if (!draft || templateBusyRef.current.has(template.role) || !manageRef.current || !mounted.current || contextRef.current !== identity) return;
    const context = identity, body = { profile: profileToApi(draft), effectiveFrom }, bodyKey = JSON.stringify(body);
    const owns = () => mounted.current && contextRef.current === context && manageRef.current;
    if (intentsRef.current[template.role]?.context !== context || intentsRef.current[template.role]?.bodyKey !== bodyKey)
      intentsRef.current[template.role] = { context, bodyKey, key: idemKey(), confirmed: false };
    const intent = intentsRef.current[template.role]!;
    templateBusyRef.current.add(template.role); setSaving(new Set(templateBusyRef.current));
    try {
      if (!intent.confirmed) {
        const res = await benefitsApi.saveTemplate(template.role, body, intent.key);
        intent.confirmed = true; intent.changed = res.changed;
      }
      if (!owns()) return;
      toast({
        title: intent.changed ? `${template.name} template saved` : 'Nothing to change',
        description: intent.changed
          ? effectiveFrom === today
            ? 'In force from today.'
            : `Takes effect on ${effectiveFrom}; today is unchanged.`
          : undefined,
      });
      if (await reload({ role: template.role, draft, date: effectiveFrom }) && owns()) {
        if (intentsRef.current[template.role] === intent) delete intentsRef.current[template.role];
        if (historyOpenRef.current === template.role) void loadHistory(template.role);
      }
    } catch (err) {
      if (!owns()) return;
      toast({
        title: 'Not saved',
        description: err instanceof Error ? err.message : 'The template could not be saved',
        variant: 'destructive',
      });
    } finally {
      if (owns()) { templateBusyRef.current.delete(template.role); setSaving(new Set(templateBusyRef.current)); }
    }
  };

  const templateFor = (role: BenefitRole) => templates.find((t) => t.role === role);

  return (
    <div className="flex flex-col gap-8">
      {loadError && (
        <p className="rounded-xl border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          {loadError}
          <Button variant="outline" size="sm" onClick={() => void reload()}>Try again</Button>
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
                  disabled={!canManage || saving.has(role)}
                  className="m-0 min-w-0 border-0 p-0"
                >
                  <BenefitProfileFieldsWithPorts
                    profile={draft}
                    categories={menuCategories}
                    onChange={(next) => setDrafts((d) => ({ ...d, [role]: next }))}
                    ports={{ menu: ports.menu }}
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
                        disabled={!dirty || saving.has(role)}
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
                    <StaffSourceChip source={op.source} />
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
                    onClick={() => setQrOperator(op)}
                    // The prototype's rule for a person without a code: no
                    // benefit role, no benefit and no QR (types.ts:7-12).
                    disabled={!role && !op.upcoming.some((v) => v.benefitRole)}
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
                    {entry.refundedTHB > 0 && <> · refunded ฿{entry.refundedTHB}</>}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      <BenefitQrDialogWithPorts
        staff={qrOperator}
        canIssue={qrOperator ? ports.canIssueQr(qrOperator) : false}
        open={qrOperator !== null}
        onOpenChange={(open) => !open && setQrOperator(null)}
        ports={{ contextKey: identity, api: benefitsApi }}
      />
      <OperatorOverrideDialogWithPorts
        staff={overrideOperator}
        templates={templates}
        today={today}
        canManage={canManage}
        categories={menuCategories}
        open={overrideOperator !== null}
        onOpenChange={(open) => !open && setOverrideOperator(null)}
        onSaved={async () => { if (!await reload()) throw new Error('Current staff benefits could not be read'); }}
        ports={{ contextKey: identity, api: benefitsApi, menu: ports.menu, summarizeProfile, toast }}
      />
    </div>
  );
}
