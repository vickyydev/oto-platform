import { useMemo } from 'react';
import { SupervisionPolicy, ChildFoodProvision, ContactChannel } from '@/types';
import { getDropOffPricing } from '@/mockApi';
import { resolveDropOffPricing } from '@/lib/dropoff';
import { resolveGroupRequirements, resolveSupervisionOutcome, sortedConfirmations } from '@/lib/supervision';
import { Input } from '@/components/ui/input';
import { PhoneInput } from '@/components/shared/PhoneInput';
import { Textarea } from '@/components/ui/textarea';
import { Checkbox } from '@/components/ui/checkbox';
import { CameraCapture } from '@/components/shared/CameraCapture';
import { ChildFoodProvisionPicker } from '@/components/shared/ChildFoodProvisionPicker';
import { Badge } from '@/components/ui/badge';
import { slotAge, type SupervisedSlot } from './SupervisionGate';
import { ChildDobPicker } from '@/components/shared/ChildDobPicker';
import { useLanguage } from '@/i18n/LanguageContext';
import { LanguageSwitcher } from '@/components/shared/LanguageSwitcher';
import {
  ShieldCheck,
  ShieldAlert,
  Camera,
  UtensilsCrossed,
  HeartPulse,
  Baby,
  UserCheck,
  Phone,
  ClipboardCheck,
} from 'lucide-react';

const DEFAULT_PROVISION: ChildFoodProvision = { mode: 'none', paidTHB: 0 };

interface ConsentCaptureProps {
  /** Public booking captures the protected visit photo at reception. */
  photoAtReception?: boolean;
  // EVERY child on the unaccompanied sale — the parent types names + ages here on
  // their own screen, and those flow (via the lifted draft) straight into the
  // staff gate's requirement resolution. Consent fields then appear per child for
  // exactly those who still need supervision.
  slots: SupervisedSlot[];
  parentName: string;
  consentAck: boolean;
  policy: SupervisionPolicy;
  // Parent contact details — captured here so the auto-send WA confirmation fires
  // immediately at registration. Optional: component hides the fields when the
  // callbacks are not provided (e.g. non-drop-off flows that don't need this).
  parentPhone?: string;
  parentContactMethod?: ContactChannel;
  onParentPhoneChange?: (v: string) => void;
  onParentContactMethodChange?: (v: ContactChannel) => void;
  onParentNameChange: (v: string) => void;
  onConsentAckChange: (v: boolean) => void;
  onUpdateChild: (id: string, patch: Partial<SupervisedSlot>) => void;
  // Confirmations checklist (admin-configurable, policy.confirmations). Shown
  // for ANY unaccompanied child registration — even when none of them ends up
  // needing a paid nanny/drop-off service (e.g. an all-9+ group) — so it's
  // driven off `slots.length > 0`, not `anyNeedsConsent`.
  acknowledgedConfirmationIds: string[];
  onToggleConfirmation: (id: string) => void;
}

/**
 * Customer-facing entry + consent screen for an unaccompanied drop-off. Reads and
 * writes the SAME lifted supervision draft the staff gate uses (single source of
 * truth across both screens), so the parent can enter each child's name + age
 * themselves. For every child who still needs supervision (after any staff
 * waiver) it collects allergies/medical, dietary notes, a prepaid food provision
 * (three-way: no food / prepaid credit / prepaid items), and a real camera photo
 * of the child TOGETHER WITH the parent / guardian (one shot covers both for
 * pickup-safety matching); the parent gives their name + an explicit
 * acknowledgement once for the whole booking.
 */
export function ConsentCapture({
  photoAtReception = false,
  slots,
  parentName,
  consentAck,
  policy,
  parentPhone,
  parentContactMethod = 'whatsapp',
  onParentPhoneChange,
  onParentContactMethodChange,
  onParentNameChange,
  onConsentAckChange,
  onUpdateChild,
  acknowledgedConfirmationIds,
  onToggleConfirmation,
}: ConsentCaptureProps) {
  const { t } = useLanguage();
  // Customer-friendly wording for each resolved requirement (parents read this,
  // so it's warmer than the staff gate's terse "Nanny required").
  const REQUIREMENT_META = {
    nanny: { label: t('superviseConsent.reqNanny'), icon: UserCheck, badge: 'destructive' as const },
    drop_off: { label: t('superviseConsent.reqDropOff'), icon: ShieldAlert, badge: 'destructive' as const },
    none: { label: t('superviseConsent.reqNone'), icon: ShieldCheck, badge: 'secondary' as const },
  };
  const confirmations = useMemo(() => sortedConfirmations(policy), [policy]);
  const resolved = resolveGroupRequirements(
    slots
      .filter((s) => slotAge(s) !== null)
      .map((s) => ({ id: s.id, age: slotAge(s)! })),
    policy,
  );
  const reqById = new Map(resolved.map((r) => [r.id, r.requirement]));

  // Parents need to know each requirement is non-negotiable (set by the venue's
  // age rules) and what it adds to the bill, so the badge carries a plain-language
  // mandatory + cost note. Pricing comes from the same config the till charges.
  const pricing = useMemo(() => resolveDropOffPricing(getDropOffPricing()), []);
  const requirementNote: Record<'nanny' | 'drop_off' | 'none', string | null> = {
    nanny: t('superviseConsent.requiredNannyRate', { rate: pricing.nannyHourlyRateTHB }),
    drop_off: t('superviseConsent.requiredOneTimeFee', { fee: pricing.oneTimeFeeTHB }),
    none: null,
  };

  const rows = slots.map((slot) => {
    const aged = slotAge(slot) !== null;
    const outcome = aged
      ? resolveSupervisionOutcome(reqById.get(slot.id) ?? 'none', slot.waived, slot.optIn)
      : { effective: 'none' as const, needsConsent: false, service: null };
    return { slot, aged, effective: outcome.effective, needsConsent: outcome.needsConsent };
  });
  const anyNeedsConsent = rows.some((r) => r.needsConsent);
  const allAged = rows.every((r) => r.aged);

  return (
    <div className="relative flex h-full w-full flex-col bg-[image:var(--cd-gradient)] text-foreground">
      <div className="absolute top-4 right-4 z-40">
        <LanguageSwitcher variant="dark" />
      </div>
      <div className="shrink-0 px-8 pt-8 pb-4 text-center">
        <div className="mb-2 inline-flex items-center gap-2 text-primary">
          <ShieldCheck className="h-6 w-6" />
          <span className="text-sm font-bold uppercase tracking-widest">{t('superviseConsent.playingToday')}</span>
        </div>
        <h2 className="text-4xl font-black">
          {slots.length === 1 ? t('superviseConsent.titleOne') : t('superviseConsent.titleMany')}
        </h2>
        <p className="mt-1 text-lg text-foreground/60">
          {t('superviseConsent.subtitle')}
        </p>
      </div>

      <div className="flex-1 space-y-5 overflow-y-auto px-8 pb-6">
        {rows.map(({ slot, aged, effective, needsConsent }) => {
        const meta = REQUIREMENT_META[effective];
        const ReqIcon = meta.icon;
        return (
          <div key={slot.id} className="rounded-3xl border border-foreground/10 bg-foreground/5 p-6">
            {/* Name + age — entered here by the parent, mirrored to the staff gate. */}
            <div className="flex flex-col gap-4 sm:flex-row">
              <div className="flex-1">
                <label className="flex items-center gap-2 text-lg text-foreground/70">
                  <Baby className="h-5 w-5" /> {t('superviseConsent.childName')}
                </label>
                <Input
                  value={slot.name}
                  onChange={(e) => onUpdateChild(slot.id, { name: e.target.value })}
                  placeholder={t('superviseConsent.fullName')}
                  className="mt-2 h-14 border-foreground/10 bg-foreground/5 px-4 text-2xl text-foreground placeholder:text-foreground/30"
                />
              </div>
              <div className="sm:w-40">
                <label className="text-lg text-foreground/70">{t('superviseConsent.age')}</label>
                <ChildDobPicker
                  dateOfBirth={slot.dateOfBirth}
                  age={slotAge(slot)}
                  childName={slot.name}
                  onChange={({ dateOfBirth, age }) =>
                    onUpdateChild(slot.id, { dateOfBirth, age: String(age) })
                  }
                  className="mt-2"
                />
              </div>
            </div>

            {/* Requirement badge — appears the moment the age is entered so the
                parent sees what's needed (nanny / drop-off / none) as they type. */}
            {aged && (
              <div className="mt-4 flex flex-wrap items-center gap-x-3 gap-y-1.5">
                <Badge variant={meta.badge} className="gap-1.5 px-3 py-1.5 text-base">
                  <ReqIcon className="h-4 w-4" />
                  {meta.label}
                </Badge>
                {requirementNote[effective] && (
                  <span className="text-base font-medium text-foreground/70">
                    {requirementNote[effective]}
                  </span>
                )}
                {effective === 'none' && needsConsent && (
                  <span className="text-base font-medium text-foreground/70">
                    {t('superviseConsent.registeredNoFee')}
                  </span>
                )}
              </div>
            )}

            {/* Consent details appear only for a child who still needs supervision. */}
            {needsConsent && (
              <div className="mt-5 space-y-5 border-t border-foreground/10 pt-5">
                <div className="grid gap-5 lg:grid-cols-2">
                  <div>
                    <label className="flex items-center gap-2 text-lg text-foreground/70">
                      <Camera className="h-5 w-5" /> {t('superviseConsent.photoTitle')}
                    </label>
                    <p className="mt-1 text-sm text-foreground/50">
                      {t('superviseConsent.photoInstructions')}
                    </p>
                    {photoAtReception ? <p className="mt-2 text-sm text-foreground/70">Reception will take the child and guardian photo when you arrive, for pickup verification.</p> : <CameraCapture
                      className="mt-2"
                      value={slot.childPhotoUrl}
                      onCapture={(dataUrl) => onUpdateChild(slot.id, { childPhotoUrl: dataUrl })}
                      onClear={() => onUpdateChild(slot.id, { childPhotoUrl: undefined })}
                    />}
                  </div>

                  <div className="space-y-4">
                    <div>
                      <label className="flex items-center gap-2 text-lg text-foreground/70">
                        <HeartPulse className="h-5 w-5" /> {t('superviseConsent.allergiesMedical')}
                      </label>
                      <Textarea
                        value={slot.allergiesMedical}
                        onChange={(e) => onUpdateChild(slot.id, { allergiesMedical: e.target.value })}
                        placeholder={t('superviseConsent.allergiesPlaceholder')}
                        className="mt-2 min-h-[88px] border-foreground/10 bg-foreground/5 text-lg text-foreground placeholder:text-foreground/30"
                      />
                    </div>
                    <div>
                      <label className="flex items-center gap-2 text-lg text-foreground/70">
                        <UtensilsCrossed className="h-5 w-5" /> {t('superviseConsent.dietaryNotes')}
                      </label>
                      <Input
                        value={slot.foodRestrictions}
                        onChange={(e) => onUpdateChild(slot.id, { foodRestrictions: e.target.value })}
                        placeholder={t('superviseConsent.dietaryPlaceholder')}
                        className="mt-2 h-12 border-foreground/10 bg-foreground/5 px-4 text-lg text-foreground placeholder:text-foreground/30"
                      />
                    </div>
                  </div>
                </div>

                {/* Food provision — replaces the old toggle with the 3-way prepaid picker. */}
                <div className="rounded-2xl border border-foreground/10 bg-foreground/5 p-5">
                  <label className="mb-3 flex items-center gap-2 text-lg font-semibold text-foreground/80">
                    <UtensilsCrossed className="h-5 w-5 text-primary" />
                    {t('superviseConsent.foodDrinksFor', { name: slot.name || t('superviseConsent.thisChild') })}
                  </label>
                  <ChildFoodProvisionPicker
                    childName={slot.name}
                    allergiesMedical={slot.allergiesMedical}
                    value={slot.foodProvision ?? DEFAULT_PROVISION}
                    onChange={(fp) => {
                      // mayOrderFood is true ONLY when the provision carries an
                      // actual paid amount — mode set but paidTHB = 0 (e.g. credit
                      // mode with an empty input, or items mode with nothing added)
                      // is treated the same as 'none' at the registration seam.
                      const mayOrder = fp.mode !== 'none' && fp.paidTHB > 0;
                      onUpdateChild(slot.id, {
                        foodProvision: fp,
                        mayOrderFood: mayOrder,
                      });
                    }}
                    variant="dark"
                  />
                </div>
              </div>
            )}
          </div>
        );
        })}

        {/* Booking-level consent: only when at least one child needs supervision. */}
        {anyNeedsConsent && (
          <div className="rounded-3xl border border-foreground/10 bg-foreground/5 p-6 space-y-5">
            <div>
              <label className="text-lg text-foreground/70">{t('superviseConsent.parentGuardianName')}</label>
              <Input
                value={parentName}
                onChange={(e) => onParentNameChange(e.target.value)}
                placeholder={t('superviseConsent.yourFullName')}
                className="mt-2 h-14 border-foreground/10 bg-foreground/5 px-4 text-2xl text-foreground placeholder:text-foreground/30"
              />
            </div>

            {/* Phone + contact method: shown when the parent handlers are provided.
                Capturing here lets autoSendWaConfirmation fire immediately on registration. */}
            {onParentPhoneChange && (
              <div className="space-y-3">
                <label className="flex items-center gap-2 text-lg text-foreground/70">
                  <Phone className="h-5 w-5" /> {t('superviseConsent.phoneNumber')}
                </label>
                <PhoneInput
                  value={parentPhone ?? ''}
                  onChange={onParentPhoneChange}
                  label=""
                  inputClassName="h-14 border-foreground/10 bg-foreground/5 px-4 text-2xl text-foreground"
                  channel={onParentContactMethodChange ? parentContactMethod : undefined}
                  onChannelChange={onParentContactMethodChange}
                  translate
                />
              </div>
            )}
            <button
              type="button"
              onClick={() => onConsentAckChange(!consentAck)}
              className="flex w-full items-start gap-4 rounded-2xl border border-foreground/10 bg-foreground/5 p-4 text-left"
            >
              <Checkbox
                checked={consentAck}
                onCheckedChange={(v) => onConsentAckChange(v === true)}
                className="mt-1 h-6 w-6 border-foreground/30 data-[state=checked]:bg-primary"
              />
              <span className="text-lg leading-snug text-foreground/80">
                {t('superviseConsent.consentText')}
              </span>
            </button>
          </div>
        )}

        {/* Confirmations checklist — shown for ANY unaccompanied child
            registration (not gated by anyNeedsConsent), including the no-fee
            9+ flow, since these are safety/venue acknowledgements independent
            of whether a paid service applies. Gated on `allAged` so it only
            appears once every child's age is entered (as part of the consent
            step below), not prematurely on the empty name/age entry. */}
        {slots.length > 0 && allAged && confirmations.length > 0 && (
          <div className="rounded-3xl border border-foreground/10 bg-foreground/5 p-6 space-y-3">
            <label className="flex items-center gap-2 text-lg font-semibold text-foreground/80">
              <ClipboardCheck className="h-5 w-5 text-primary" />
              {t('superviseConsent.pleaseConfirm')}
            </label>
            {confirmations.map((c) => {
              const checked = acknowledgedConfirmationIds.includes(c.id);
              return (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => onToggleConfirmation(c.id)}
                  className="flex w-full items-start gap-4 rounded-2xl border border-foreground/10 bg-foreground/5 p-4 text-left"
                >
                  <Checkbox
                    checked={checked}
                    onCheckedChange={() => onToggleConfirmation(c.id)}
                    className="mt-1 h-6 w-6 border-foreground/30 data-[state=checked]:bg-primary"
                  />
                  <span className="text-lg leading-snug text-foreground/80">
                    {c.text}
                    {!c.required && (
                      <span className="ml-2 text-sm text-foreground/40">({t('superviseConsent.optional')})</span>
                    )}
                  </span>
                </button>
              );
            })}
          </div>
        )}

        {/* All children entered and none need supervision — reassure the parent. */}
        {allAged && !anyNeedsConsent && (
          <div className="flex flex-col items-center gap-2 rounded-3xl border border-emerald-500/20 bg-emerald-500/5 p-8 text-center">
            <ShieldCheck className="h-12 w-12 text-(--cd-success)" />
            <h3 className="text-2xl font-bold">{t('superviseConsent.allSetTitle')}</h3>
            <p className="max-w-md text-lg text-foreground/60">
              {t('superviseConsent.allSetSubtitle')}
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
