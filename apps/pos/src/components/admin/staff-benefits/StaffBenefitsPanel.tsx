import { useState, useSyncExternalStore } from 'react';
import { ClipboardList, Info, QrCode as QrCodeIcon, Settings2, ShieldCheck } from 'lucide-react';
import { Operator, RoleBenefitTemplate } from '@/types';
import { useCatalogStore } from '@/store/CatalogStoreContext';
import {
  getEnrolledOperators,
  getEffectiveBenefitProfile,
  subscribeOperators,
  getBenefitAuditLog,
} from '@/mockApi';
import { isEmptyBenefitProfile } from '@/lib/benefits';
import { formatDiscountTargetLabel } from '@/lib/discountTarget';
import { Button } from '@/components/ui/button';
import { BenefitProfileFields } from './BenefitProfileFields';
import { BenefitQrDialog } from './BenefitQrDialog';
import { OperatorOverrideDialog } from './OperatorOverrideDialog';

const ROLE_ORDER: RoleBenefitTemplate['role'][] = ['owner', 'manager', 'staff'];

/** Human summary of a resolved BenefitProfile, for compact list rows. */
function summarizeProfile(profile: ReturnType<typeof getEffectiveBenefitProfile>): string {
  if (isEmptyBenefitProfile(profile)) return 'No benefit configured';
  if (profile.comp) return 'Full comp';
  const parts: string[] = [];
  for (const fi of profile.freeItems ?? []) {
    parts.push(`${fi.quotaPerPeriod}x ${fi.label} / ${fi.period === 'daily' ? 'day' : 'mo'}`);
  }
  if (profile.credit) {
    parts.push(
      `฿${profile.credit.amountTHB} credit (${formatDiscountTargetLabel(profile.credit.target)}) / ${
        profile.credit.period === 'daily' ? 'day' : 'mo'
      }`
    );
  }
  if (profile.standingDiscount) {
    parts.push(
      `${profile.standingDiscount.percent}% off ${formatDiscountTargetLabel(profile.standingDiscount.target)}`
    );
  }
  return parts.join(' · ');
}

/**
 * Admin editing screen for Task #231 staff benefits: the three seeded role
 * templates (Owner/Manager/Staff) plus a per-operator view showing each
 * staff member's effective benefit, their scannable QR, and an override
 * editor. All F&B-only — the engine (lib/benefits.ts) only ever runs at the
 * order station.
 */
export function StaffBenefitsPanel() {
  const { roleBenefitTemplates, menuCategories, mutators } = useCatalogStore();
  const operators = useSyncExternalStore(subscribeOperators, getEnrolledOperators);

  const [qrOperator, setQrOperator] = useState<Operator | null>(null);
  const [overrideOperator, setOverrideOperator] = useState<Operator | null>(null);
  // Audit log is append-only and only ever written from the F&B order station;
  // a fresh read on panel mount/navigation is enough for this admin view.
  const [auditLog] = useState(() => getBenefitAuditLog());

  const templateFor = (role: RoleBenefitTemplate['role']) =>
    roleBenefitTemplates.find((t) => t.role === role);

  return (
    <div className="flex flex-col gap-8">
      <section className="flex flex-col gap-4">
        <div className="flex items-center gap-2">
          <ShieldCheck className="w-4 h-4 text-foreground/60" />
          <h2 className="text-lg font-bold">Role templates</h2>
        </div>
        <p className="text-sm text-foreground/50">
          Every staff member inherits their role's template unless they have a
          personal override below. Applied only at the F&amp;B order station,
          in order: comp → free items → credit → standing % discount.
        </p>
        <div className="flex flex-col gap-4">
          {ROLE_ORDER.map((role) => {
            const template = templateFor(role);
            if (!template) return null;
            return (
              <div
                key={role}
                className="rounded-2xl border border-foreground/10 bg-foreground/[0.02] p-4"
              >
                <div className="mb-3 font-semibold">{template.name}</div>
                <BenefitProfileFields
                  profile={template.profile}
                  categories={menuCategories}
                  onChange={(next) =>
                    mutators.setRoleBenefitTemplate({ ...template, profile: next })
                  }
                />
              </div>
            );
          })}
        </div>
      </section>

      <section className="flex flex-col gap-4">
        <div className="flex items-center gap-2">
          <QrCodeIcon className="w-4 h-4 text-foreground/60" />
          <h2 className="text-lg font-bold">Staff</h2>
          <span className="text-sm text-foreground/40">({operators.length})</span>
        </div>
        <div className="flex flex-col gap-2">
          {operators.map((op) => {
            const profile = getEffectiveBenefitProfile(op);
            return (
              <div
                key={op.id}
                className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-foreground/10 bg-foreground/[0.02] p-4"
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-medium">{op.name}</span>
                    <span className="rounded-full bg-foreground/5 px-2 py-0.5 text-xs capitalize text-foreground/60">
                      {op.benefitRole ?? 'staff'}
                    </span>
                    {op.benefitProfileOverride && (
                      <span className="rounded-full bg-amber-400/10 px-2 py-0.5 text-xs text-amber-300">
                        Override
                      </span>
                    )}
                  </div>
                  <div className="text-sm text-foreground/50">{summarizeProfile(profile)}</div>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setOverrideOperator(op)}
                  >
                    <Settings2 className="w-4 h-4" />
                    Override
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setQrOperator(op)}
                    disabled={!op.benefitQrCode}
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

      <p className="flex items-center gap-2 text-xs text-foreground/40">
        <Info className="w-3.5 h-3.5 shrink-0" />
        Changes are kept in memory for this prototype and reset on page reload.
      </p>

      <BenefitQrDialog
        operator={qrOperator}
        open={qrOperator !== null}
        onOpenChange={(open) => !open && setQrOperator(null)}
      />
      <OperatorOverrideDialog
        operator={overrideOperator}
        categories={menuCategories}
        open={overrideOperator !== null}
        onOpenChange={(open) => !open && setOverrideOperator(null)}
      />
    </div>
  );
}
