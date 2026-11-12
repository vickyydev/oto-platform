import { useId, useMemo } from 'react';
import { SupervisionPolicy, ChildFoodProvision, ContactChannel } from '@/types';
import { cn } from '@/lib/utils';
import { CHANNEL_LABEL } from '@/lib/contactChannel';
import { messagingPhoneProblem } from '@/lib/consentForm';
import { consentMissing, consentMissingLine } from '@/lib/consentFinish';
import { Button } from '@/components/ui/button';
import { formatStoredPhone } from '@/lib/phoneUtils';
import { getDropOffPricing } from '@/mockApi';
import { resolveDropOffPricing } from '@/lib/dropoff';
import { resolveGroupRequirements, resolveSupervisionOutcome, sortedConfirmations } from '@/lib/supervision';
import { PhoneInput } from '@/components/shared/PhoneInput';
import { TouchText } from './TouchText';
import { NARROW_BAR, NARROW_HEAD, NARROW_LINE, SHORT_HIDE } from './consentFormLayout';
import { kioskFlags } from '@/lib/kioskFlags';
import { Checkbox } from '@/components/ui/checkbox';
import { CameraCapture } from '@/components/shared/CameraCapture';
import { ChildFoodProvisionPicker } from '@/components/shared/ChildFoodProvisionPicker';
import { Badge } from '@/components/ui/badge';
import { slotAge, type SupervisedSlot } from './SupervisionGate';
import { ChildDobPicker } from '@/components/shared/ChildDobPicker';
import { tFor, useLanguage } from '@/i18n/LanguageContext';
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
  CircleDashed,
  CheckCircle2,
} from 'lucide-react';

const DEFAULT_PROVISION: ChildFoodProvision = { mode: 'none', paidTHB: 0 };
/** One tickable line: the consent and each "Please confirm" item. */
const LINE = 'flex w-full items-start gap-4 rounded-2xl border border-foreground/10 bg-foreground/5 p-4 text-left';

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
  // SCRUM-863 — the till starts both from what was given on the first screen,
  // and the family confirms or changes them here, as the prototype's form asks.
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
  /**
   * This copy is the till's private dialog, on the staff screen: English,
   * whatever the customer's half is set to (SCRUM-698, SCRUM-729).
   */
  staffScreen?: boolean;
  /**
   * SCRUM-764 — the agreement ticks are the family's alone, given on their own
   * screen. Staff see whether each one is ticked; they cannot tick it.
   */
  ticksReadOnly?: boolean;
  /**
   * SCRUM-857 — the family's confirmation that the number above is the one
   * for the chosen channel (the owner's ruling of 8 November). The line is
   * shown when the till takes the tick (`onContactConfirmedChange`), beside
   * the number; it cannot be ticked while the number is missing or cannot
   * take messages. On the staff copy the tick is read-only unless the till
   * says staff may give it with the family beside them (`contactConfirmTickable`):
   * when the display cannot show the form, or does not know the tick.
   */
  contactConfirmed?: boolean;
  onContactConfirmedChange?: (v: boolean) => void;
  contactConfirmTickable?: boolean;
  /**
   * SCRUM-857 / SCRUM-875 — the family's Done on the till's own customer half
   * (the owner's ruling of 8 November: no staff confirmation once every check
   * passes). Given only there: Done writes the registration and moves the sale
   * on, as the staff's Continue does. Until it can be pressed (`doneReady`, the
   * till's own reading of every check) a short line says what is still
   * missing; while the till writes (`doneBusy`) the bar says it is saving, and
   * a Done that could not be saved says so (`doneNotSaved`).
   */
  onDone?: () => void;
  doneReady?: boolean;
  doneBusy?: boolean;
  doneNotSaved?: boolean;
}

/**
 * SCRUM-764 — the agreements as the family has ticked them on the customer
 * screen, for reception to follow. Staff English, like the rest of the till.
 */
export function ConsentTicksStatus({
  consentRequired,
  consentAcknowledged,
  confirmations,
  contact,
}: {
  consentRequired: boolean;
  consentAcknowledged: boolean;
  confirmations: { id: string; text: string; required: boolean; acknowledged: boolean }[];
  /**
   * SCRUM-857 — the number the child's messages go to, and whether the family
   * has confirmed it is the one for the channel (and who gave the tick).
   */
  contact?: {
    phone: string;
    channel: ContactChannel;
    confirmed: boolean;
    by: 'family' | 'staff' | null;
    problem: 'empty' | 'invalid' | null;
  };
}) {
  if (!consentRequired && confirmations.length === 0) return null;
  const Tick = ({ on }: { on: boolean }) =>
    on ? <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-500" /> : <CircleDashed className="h-4 w-4 shrink-0 text-muted-foreground" />;
  return (
    <div className="mb-3 rounded-xl border border-border bg-card/60 px-4 py-3 text-sm" data-testid="consent-ticks-status">
      <div className="mb-1.5 font-semibold">Agreements — ticked by the family on their screen</div>
      <ul className="space-y-1">
        {consentRequired && (
          <li className="flex items-center gap-2"><Tick on={consentAcknowledged} />
            Supervision and photo consent · {consentAcknowledged ? 'ticked' : 'not ticked yet'}</li>
        )}
        {consentRequired && contact && (
          <li className="flex items-center gap-2" data-testid="consent-contact-status"><Tick on={contact.confirmed} />
            <span className="min-w-0 truncate">{CHANNEL_LABEL[contact.channel]} number{contact.problem === 'empty' ? '' : ` ${formatStoredPhone(contact.phone)}`}</span>
            <span className="shrink-0 text-muted-foreground">· {contact.problem === 'empty' ? 'no number yet'
              : contact.problem === 'invalid' ? "doesn't look like a mobile that can receive messages"
              : contact.confirmed ? `confirmed by ${contact.by === 'staff' ? 'staff with the family' : 'the family'}` : 'not confirmed yet'}</span></li>
        )}
        {confirmations.map((item) => (
          <li key={item.id} className="flex items-center gap-2"><Tick on={item.acknowledged} />
            <span className="min-w-0 truncate">{item.text}</span>
            <span className="shrink-0 text-muted-foreground">· {item.acknowledged ? 'ticked' : item.required ? 'not ticked yet' : 'optional, not ticked'}</span></li>
        ))}
      </ul>
    </div>
  );
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
  staffScreen = false,
  ticksReadOnly = false,
  contactConfirmed = false,
  onContactConfirmedChange,
  contactConfirmTickable = true,
  onDone,
  doneReady = false,
  doneBusy = false,
  doneNotSaved = false,
}: ConsentCaptureProps) {
  const customer = useLanguage();
  // The till draws this form twice at once (the customer's half and the staff's
  // copy), so each copy's labels name their own boxes.
  const lineId = useId();
  const t = staffScreen ? tFor('en') : customer.t;
  const lang = staffScreen ? undefined : customer.lang;
  // SCRUM-893 — on a screen with no keyboard of its own the family's half
  // brings the on-screen keys for every box, as the paired display does; the
  // staff copy is on the till's own screen and never does.
  const screenKeyboard = !staffScreen && kioskFlags.screenKeyboard;
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
  // SCRUM-875 — what is still missing before the family's Done, in their language.
  const missingLine = onDone
    ? consentMissingLine(t, consentMissing({
      children: slots.map((s) => ({ name: s.name, ageYears: slotAge(s) })),
      consentRequired: anyNeedsConsent,
      guardianName: parentName,
      consentAcknowledged: consentAck,
      confirmations: confirmations.map((c) => ({ required: c.required, acknowledged: acknowledgedConfirmationIds.includes(c.id) })),
      ...(onContactConfirmedChange ? { contact: { confirmed: contactConfirmed, problem: messagingPhoneProblem(parentPhone ?? '') } } : {}),
      photosTaken: rows.every((r) => !r.needsConsent || !!r.slot.childPhotoUrl),
    }), CHANNEL_LABEL[parentContactMethod])
    : null;

  return (
    <div className="relative flex h-full w-full flex-col bg-[image:var(--cd-gradient)] text-foreground">
      <div className="absolute top-4 right-4 z-40">
        <LanguageSwitcher variant="dark" />
      </div>
      <div className={cn('shrink-0 px-8 pt-8 pb-4 text-center', NARROW_HEAD)}>
        <div className="mb-2 inline-flex items-center gap-2 text-primary">
          <ShieldCheck className="h-6 w-6" />
          <span className="text-sm font-bold uppercase tracking-widest">{t('superviseConsent.playingToday')}</span>
        </div>
        <h2 className="text-4xl font-black">
          {slots.length === 1 ? t('superviseConsent.titleOne') : t('superviseConsent.titleMany')}
        </h2>
        <p className={cn('mt-1 text-lg text-foreground/60', SHORT_HIDE)}>
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
                <TouchText
                  value={slot.name}
                  onChange={(name) => onUpdateChild(slot.id, { name })}
                  placeholder={t('superviseConsent.fullName')}
                  screenKeyboard={screenKeyboard} testId="consent-child-name"
                  className="mt-2 h-14 border-foreground/10 bg-foreground/5 px-4 text-2xl text-foreground placeholder:text-foreground/30"
                />
              </div>
              <div className="sm:w-40">
                <label className="text-lg text-foreground/70">{t('superviseConsent.age')}</label>
                <ChildDobPicker
                  lang={lang}
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
                    {photoAtReception ? (
                      <p className="mt-2 text-sm text-foreground/70">{t('superviseConsent.photoAtReception')}</p>
                    ) : (
                      <CameraCapture
                        lang={lang}
                        className="mt-2"
                        value={slot.childPhotoUrl}
                        onCapture={(dataUrl) => onUpdateChild(slot.id, { childPhotoUrl: dataUrl })}
                        onClear={() => onUpdateChild(slot.id, { childPhotoUrl: undefined })}
                      />
                    )}
                  </div>

                  <div className="space-y-4">
                    <div>
                      <label className="flex items-center gap-2 text-lg text-foreground/70">
                        <HeartPulse className="h-5 w-5" /> {t('superviseConsent.allergiesMedical')}
                      </label>
                      <TouchText
                        multiline
                        value={slot.allergiesMedical}
                        onChange={(allergiesMedical) => onUpdateChild(slot.id, { allergiesMedical })}
                        placeholder={t('superviseConsent.allergiesPlaceholder')}
                        screenKeyboard={screenKeyboard} testId="consent-allergies"
                        className="mt-2 min-h-[88px] border-foreground/10 bg-foreground/5 text-lg text-foreground placeholder:text-foreground/30"
                      />
                    </div>
                    <div>
                      <label className="flex items-center gap-2 text-lg text-foreground/70">
                        <UtensilsCrossed className="h-5 w-5" /> {t('superviseConsent.dietaryNotes')}
                      </label>
                      <TouchText
                        value={slot.foodRestrictions}
                        onChange={(foodRestrictions) => onUpdateChild(slot.id, { foodRestrictions })}
                        placeholder={t('superviseConsent.dietaryPlaceholder')}
                        screenKeyboard={screenKeyboard} testId="consent-dietary"
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
                    lang={lang}
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
              <TouchText
                value={parentName}
                onChange={onParentNameChange}
                placeholder={t('superviseConsent.yourFullName')}
                screenKeyboard={screenKeyboard} testId="consent-guardian"
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
                  showKeypad={screenKeyboard}
                  channel={onParentContactMethodChange ? parentContactMethod : undefined}
                  onChannelChange={onParentContactMethodChange}
                  translate={!staffScreen}
                />
                {/* SCRUM-857 — the family confirms that this number is the one for
                    the chosen channel; the line names the channel. Not tickable
                    while the number is missing or cannot take messages, and the
                    form says which. */}
                {onContactConfirmedChange && (() => {
                  const problem = messagingPhoneProblem(parentPhone ?? '');
                  const tickable = contactConfirmTickable && problem === null;
                  return (
                    <>
                      {problem === 'empty' && (
                        <p className="text-base text-foreground/60" data-testid="consent-contact-needed">{t('superviseConsent.phoneNeeded')}</p>
                      )}
                      {problem === 'invalid' && (
                        <p className="text-base text-(--cd-amber)" data-testid="consent-contact-invalid">{t('superviseConsent.phoneInvalid')}</p>
                      )}
                      <label
                        htmlFor={`${lineId}-contact`}
                        className={cn(LINE, tickable ? 'cursor-pointer' : 'cursor-default')}
                      >
                        <Checkbox
                          id={`${lineId}-contact`}
                          checked={contactConfirmed}
                          disabled={!tickable}
                          onCheckedChange={(v) => onContactConfirmedChange(v === true)}
                          className="mt-1 h-6 w-6 border-foreground/30 data-[state=checked]:bg-primary"
                          data-testid="consent-contact-confirm"
                        />
                        <span className="text-lg leading-snug text-foreground/80">
                          {t('superviseConsent.confirmContact', { channel: CHANNEL_LABEL[parentContactMethod] })}
                          {staffScreen && !contactConfirmTickable && <span className="ml-2 text-sm text-foreground/50">({contactConfirmed ? 'confirmed by the family' : 'the family confirms this on their screen'})</span>}
                          {staffScreen && contactConfirmTickable && <span className="ml-2 text-sm text-foreground/50">({contactConfirmed ? 'confirmed' : 'ask the family, then tick with them'})</span>}
                        </span>
                      </label>
                    </>
                  );
                })()}
              </div>
            )}
            {/* SCRUM-767: the whole line is the checkbox's label, and the box's
                own handler is the only one — a second on the line flipped a
                tap on the box straight back (as SCRUM-722 found on check-in). */}
            <label
              htmlFor={`${lineId}-consent`}
              className={cn(LINE, ticksReadOnly ? 'cursor-default' : 'cursor-pointer')}
            >
              <Checkbox
                id={`${lineId}-consent`}
                checked={consentAck}
                disabled={ticksReadOnly}
                onCheckedChange={(v) => onConsentAckChange(v === true)}
                className="mt-1 h-6 w-6 border-foreground/30 data-[state=checked]:bg-primary"
                data-testid="consent-ack"
              />
              <span className="text-lg leading-snug text-foreground/80">
                {t('superviseConsent.consentText')}
                {ticksReadOnly && <span className="ml-2 text-sm text-foreground/50">({consentAck ? 'ticked by the family' : 'the family ticks this on their screen'})</span>}
              </span>
            </label>
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
            {confirmations.map((c, index) => {
              const checked = acknowledgedConfirmationIds.includes(c.id);
              const boxId = `${lineId}-confirmation-${index}`;
              return (
                <label
                  key={c.id}
                  htmlFor={boxId}
                  className={cn(LINE, ticksReadOnly ? 'cursor-default' : 'cursor-pointer')}
                >
                  <Checkbox
                    id={boxId}
                    checked={checked}
                    disabled={ticksReadOnly}
                    onCheckedChange={() => onToggleConfirmation(c.id)}
                    className="mt-1 h-6 w-6 border-foreground/30 data-[state=checked]:bg-primary"
                    data-testid="consent-confirmation"
                  />
                  <span className="text-lg leading-snug text-foreground/80">
                    {c.text}
                    {!c.required && (
                      <span className="ml-2 text-sm text-foreground/40">({t('superviseConsent.optional')})</span>
                    )}
                    {ticksReadOnly && <span className="ml-2 text-sm text-foreground/50">({checked ? 'ticked by the family' : 'the family ticks this on their screen'})</span>}
                  </span>
                </label>
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

      {/* SCRUM-857 — the family's Done, on the till's own customer half. */}
      {onDone && (
        <div className={cn('shrink-0 border-t border-foreground/10 px-8 py-4 flex flex-wrap items-center justify-end gap-3', NARROW_BAR)} data-testid="consent-done-bar">
          {doneBusy ? <p role="status">{t('superviseConsent.finishing')}</p> : <>
            {doneNotSaved && <p role="status" className="w-full text-right text-base text-(--cd-amber)" data-testid="consent-not-saved">{t('superviseConsent.notSaved')}</p>}
            {missingLine && <p className={cn('w-full text-right text-base text-foreground/60', NARROW_LINE)} data-testid="consent-missing">{missingLine}</p>}
            <Button disabled={!doneReady} onClick={onDone}>{t('common.done')}</Button>
          </>}
        </div>
      )}
    </div>
  );
}
