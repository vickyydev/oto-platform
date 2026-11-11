import { formatStoredPhone } from '@/lib/phoneUtils';
import { useEffect, useRef, useState } from 'react';
import type { ConsentAction, ConsentPrompt, FilledConsentSlot } from '@oto/shared';
import { ShieldCheck, ShieldAlert, UserCheck, ClipboardCheck, Baby, HeartPulse, UtensilsCrossed, Camera, Phone, Users } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Checkbox } from '@/components/ui/checkbox';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { ChildDobPicker } from '@/components/shared/ChildDobPicker';
import { LanguageSwitcher } from '@/components/shared/LanguageSwitcher';
import { PhoneInput } from '@/components/shared/PhoneInput';
import { ScreenKeyboard } from './ScreenKeyboard';
import { useLanguage } from '@/i18n/LanguageContext';
import { consentFormPhone } from '@/lib/consentForm';
import { kioskFlags } from '@/lib/kioskFlags';
import { cn } from '@/lib/utils';

/**
 * SCRUM-764 — THE DROP-OFF AND NANNY FORMS ON THE CUSTOMER SCREEN.
 *
 * Agreed with the park as the original design (Mariia, 30 October; Tony, 4
 * November): the family fills the form on their own screen, in their language,
 * and the till follows it so reception can help. Three steps — the children
 * (name and age, with what each one needs and what it costs), their care notes,
 * and the agreements — each sent to the till as it is finished (`fill`), where
 * the staff gate and the private details show it. Staff may type a child's
 * details on the till when the family asks; those arrive here too, without
 * overwriting anything the family is still typing. The agreement ticks are the
 * family's alone: only this screen gives them.
 *
 * What stays at the till: the photo of child and guardian, the food choice
 * (money), waivers and every policy decision. A child from the family's saved
 * profile keeps their care notes off this public screen.
 *
 * SCRUM-863 — the parent's block asks for the WhatsApp, LINE or Telegram
 * number as the prototype's form does (components/till/ConsentCapture.tsx):
 * it starts from the number and channel given on the first screen, the family
 * confirms or changes them, and both go to the till with every step. Asking
 * the number once (SCRUM-762) is the ordinary sale's rule, not this form's.
 */

interface ChildDraft {
  name: string;
  dateOfBirth: string | null;
  ageYears: number | null;
  allergiesMedical: string;
  foodRestrictions: string;
}
interface FormDraft {
  slots: Record<string, ChildDraft>;
  guardianName: string;
  guardianPhone: string;
  /** SCRUM-863 — absent on a form whose till does not take the number and channel back. */
  contactChannel?: NonNullable<ConsentPrompt['contactChannel']>;
  consentAcknowledged: boolean;
  confirmations: string[];
}

function draftOf(prompt: ConsentPrompt): FormDraft {
  return {
    slots: Object.fromEntries(prompt.slots.map((slot) => [slot.id, {
      name: slot.name, dateOfBirth: slot.dateOfBirth ?? null, ageYears: slot.ageYears,
      allergiesMedical: slot.allergiesMedical ?? '', foodRestrictions: slot.foodRestrictions ?? '',
    }])),
    guardianName: prompt.guardianName,
    guardianPhone: prompt.guardianPhone ?? '',
    ...(prompt.contactChannel ? { contactChannel: prompt.contactChannel } : {}),
    consentAcknowledged: prompt.consentAcknowledged,
    confirmations: prompt.confirmations.filter((item) => item.acknowledged).map((item) => item.id),
  };
}

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
const trimmed = (draft: FormDraft): FormDraft => ({
  ...draft,
  guardianName: draft.guardianName.trim(),
  // The number as it is sent and as the till keeps it, so a number typed with
  // its leading zero is the same one once the till's copy comes back.
  guardianPhone: consentFormPhone(draft.guardianPhone),
  confirmations: [...draft.confirmations].sort(),
  slots: Object.fromEntries(Object.entries(draft.slots).map(([id, child]) => [id, { ...child, name: child.name.trim() }])),
});

/**
 * The till's newer copy of the form, laid over what is on this screen: a field
 * the family has not touched since the last copy takes the till's value (staff
 * helping, or the family's own step coming back); a field they are still
 * typing in keeps what they typed.
 */
export function mergeConsentDraft(local: FormDraft, base: FormDraft, next: FormDraft): FormDraft {
  const pick = <T,>(mine: T, was: T, theirs: T): T => (same(mine, was) ? theirs : mine);
  const slots: Record<string, ChildDraft> = {};
  for (const [id, theirs] of Object.entries(next.slots)) {
    const mine = local.slots[id];
    const was = base.slots[id];
    if (!mine || !was) { slots[id] = theirs; continue; }
    slots[id] = {
      name: pick(mine.name, was.name, theirs.name),
      // The date and the age move together: one picker sets both.
      ...pick({ dateOfBirth: mine.dateOfBirth, ageYears: mine.ageYears }, { dateOfBirth: was.dateOfBirth, ageYears: was.ageYears },
        { dateOfBirth: theirs.dateOfBirth, ageYears: theirs.ageYears }),
      allergiesMedical: pick(mine.allergiesMedical, was.allergiesMedical, theirs.allergiesMedical),
      foodRestrictions: pick(mine.foodRestrictions, was.foodRestrictions, theirs.foodRestrictions),
    };
  }
  return {
    slots,
    guardianName: pick(local.guardianName, base.guardianName, next.guardianName),
    guardianPhone: pick(local.guardianPhone, base.guardianPhone, next.guardianPhone),
    ...(next.contactChannel ? { contactChannel: pick(local.contactChannel, base.contactChannel, next.contactChannel) } : {}),
    consentAcknowledged: pick(local.consentAcknowledged, base.consentAcknowledged, next.consentAcknowledged),
    confirmations: pick(local.confirmations, base.confirmations, next.confirmations),
  };
}

/** A text box that opens the on-screen keyboard on a display that has none (SCRUM-711). */
function TouchText({ value, onChange, placeholder, className, id, disabled, maxLength }: {
  value: string; onChange: (next: string) => void; placeholder?: string; className?: string; id?: string;
  disabled?: boolean; maxLength?: number;
}) {
  const { t } = useLanguage();
  const [open, setOpen] = useState(false);
  if (!kioskFlags.screenKeyboard) {
    return <Input id={id} value={value} maxLength={maxLength} disabled={disabled} placeholder={placeholder}
      onChange={(event) => onChange(event.target.value)} className={className} />;
  }
  return (
    <div>
      <Input id={id} value={value} maxLength={maxLength} disabled={disabled} placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)} onClick={() => setOpen(true)}
        className={cn(className, 'md:text-2xl')} inputMode="none" autoComplete="off" spellCheck={false} />
      {open && !disabled && (
        <ScreenKeyboard value={value} onChange={(next) => onChange(maxLength ? next.slice(0, maxLength) : next)}
          onDone={() => setOpen(false)} doneLabel={t('common.done')}
          spaceLabel={t('display.keyboard.space')} backspaceLabel={t('display.keyboard.backspace')} />
      )}
    </div>
  );
}

const FIELD = 'mt-2 h-14 border-foreground/10 bg-foreground/5 px-4 text-2xl text-foreground placeholder:text-foreground/30';
const STEPS = ['children', 'care', 'agreements'] as const;
type Step = (typeof STEPS)[number];

/** The public part of ConsentCapture: the family fills it; the photo and staff decisions remain at the till. */
export function PublicConsentCapture({ prompt, busy, onAction }: {
  prompt: ConsentPrompt; busy: boolean; onAction: (action: ConsentAction) => void;
}) {
  const { t, lang } = useLanguage();
  const [draft, setDraft] = useState<FormDraft>(() => draftOf(prompt));
  const base = useRef<FormDraft>(draftOf(prompt));
  const [step, setStep] = useState<Step>('children');
  const [helpAsked, setHelpAsked] = useState(false);
  const lastRequest = useRef(prompt.requestId);
  useEffect(() => {
    if (lastRequest.current === prompt.requestId) return;
    lastRequest.current = prompt.requestId;
    const next = draftOf(prompt);
    setDraft((local) => mergeConsentDraft(local, base.current, next));
    base.current = next;
  }, [prompt]);

  const fence = { requestId: prompt.requestId, visitorId: prompt.visitorId };
  const locked = busy || prompt.completed;
  const saved = same(trimmed(draft), trimmed(draftOf(prompt)));
  // SCRUM-863 — a till that sends the channel takes the number and the channel
  // back with every step, so the form asks for both. One that does not (an
  // older till, or a station that drops the field) would leave a changed
  // number unsaved and this screen waiting, so its form stays as it was: the
  // number fixed once one was given.
  const takesContact = prompt.contactChannel !== undefined;
  const phoneKept = !takesContact && !!prompt.guardianPhone?.trim();
  const childrenComplete = prompt.slots.every((slot) => {
    const child = draft.slots[slot.id];
    return !!child && child.name.trim().length > 0 && child.ageYears !== null;
  });
  const fillOf = (form: FormDraft): ConsentAction => ({
    ...fence,
    action: 'fill',
    slots: prompt.slots.map((slot): FilledConsentSlot => {
      const child = form.slots[slot.id]!;
      return {
        id: slot.id, name: child.name.trim().slice(0, 100), dateOfBirth: child.dateOfBirth, ageYears: child.ageYears,
        allergiesMedical: child.allergiesMedical.slice(0, 500), foodRestrictions: child.foodRestrictions.slice(0, 200),
      };
    }),
    guardianName: form.guardianName.trim().slice(0, 100),
    ...(takesContact
      ? { guardianPhone: consentFormPhone(form.guardianPhone), contactChannel: form.contactChannel ?? prompt.contactChannel }
      : !phoneKept && form.guardianPhone.trim() ? { guardianPhone: form.guardianPhone.trim().slice(0, 32) } : {}),
    // A tick without a name is not one the till can take; it is kept here until the name is in.
    consentAcknowledged: form.consentAcknowledged && !!form.guardianName.trim(),
    acknowledgedConfirmationIds: form.confirmations,
  });
  const fill = (): ConsentAction => fillOf(draft);
  const setChild = (id: string, patch: Partial<ChildDraft>) =>
    setDraft((current) => ({ ...current, slots: { ...current.slots, [id]: { ...current.slots[id]!, ...patch } } }));
  const index = STEPS.indexOf(step);
  const next = () => {
    if (!saved) onAction(fill());
    if (index < STEPS.length - 1) setStep(STEPS[index + 1]!);
  };

  const requirementOf = (slot: ConsentPrompt['slots'][number]) => {
    const meta = {
      nanny: { label: t('superviseConsent.reqNanny'), icon: UserCheck, badge: 'destructive' as const,
        note: prompt.fees ? t('superviseConsent.requiredNannyRate', { rate: prompt.fees.nannyHourlyTHB }) : null },
      drop_off: { label: t('superviseConsent.reqDropOff'), icon: ShieldAlert, badge: 'destructive' as const,
        note: prompt.fees ? t('superviseConsent.requiredOneTimeFee', { fee: prompt.fees.dropOffFeeTHB }) : null },
      none: { label: t('superviseConsent.reqNone'), icon: ShieldCheck, badge: 'secondary' as const, note: null },
    }[slot.requirement];
    return meta;
  };

  return <div className="relative flex h-full w-full min-h-0 flex-col bg-[image:var(--cd-gradient)] text-foreground" data-testid="display-consent">
    <div className="absolute top-4 right-4 z-40"><LanguageSwitcher variant="dark" /></div>
    <div className="shrink-0 px-8 pt-8 pb-4 text-center">
      <div className="mb-2 inline-flex items-center gap-2 text-primary"><ShieldCheck className="h-6 w-6" />
        <span className="text-sm font-bold uppercase tracking-widest">{t('superviseConsent.playingToday')}</span></div>
      <h2 className="text-4xl font-black">{t(prompt.slots.length === 1 ? 'superviseConsent.titleOne' : 'superviseConsent.titleMany')}</h2>
      <p className="mt-1 text-lg text-foreground/60">{t('superviseConsent.subtitle')}</p>
      <div className="mt-4 flex items-center justify-center gap-2" data-testid="consent-steps">
        {STEPS.map((name, at) => (
          <button key={name} type="button" disabled={locked || at > index && !childrenComplete}
            onClick={() => { if (at !== index) { if (!saved) onAction(fill()); setStep(name); } }}
            className={cn('rounded-full border px-4 py-1.5 text-base font-semibold transition-colors',
              at === index ? 'border-primary bg-primary text-primary-foreground' : 'border-foreground/15 bg-foreground/5 text-foreground/70')}>
            {at + 1}. {t(name === 'children' ? 'superviseConsent.stepChildren' : name === 'care' ? 'superviseConsent.stepCare' : 'superviseConsent.stepAgreements')}
          </button>
        ))}
      </div>
      <p className="mt-2 text-sm text-foreground/50">{t('superviseConsent.stepOf', { n: index + 1, total: STEPS.length })} · {t('superviseConsent.teamFollowing')}</p>
    </div>

    <div className="flex-1 min-h-0 space-y-5 overflow-y-auto px-8 pb-6">
      {step === 'children' && prompt.slots.map((slot, at) => {
        const child = draft.slots[slot.id]!;
        const meta = requirementOf(slot);
        const Icon = meta.icon;
        return <div key={slot.id} className="rounded-3xl border border-foreground/10 bg-foreground/5 p-6" data-testid="consent-child">
          <div className="flex flex-col gap-4 sm:flex-row">
            <div className="flex-1">
              <label htmlFor={`consent-child-${at}`} className="flex items-center gap-2 text-lg text-foreground/70">
                <Baby className="h-5 w-5" /> {t('superviseConsent.childName')}</label>
              <TouchText id={`consent-child-${at}`} value={child.name} maxLength={100} disabled={locked}
                onChange={(name) => setChild(slot.id, { name })} placeholder={t('superviseConsent.fullName')} className={FIELD} />
            </div>
            <div className="sm:w-40">
              <label className="text-lg text-foreground/70">{t('superviseConsent.age')}</label>
              <ChildDobPicker lang={lang} dateOfBirth={child.dateOfBirth ?? undefined} age={child.ageYears} childName={child.name}
                disabled={locked} className="mt-2"
                onChange={({ dateOfBirth, age }) => {
                  // An age is a choice, not typing: it goes to the till at once, so
                  // what this child needs is worked out there and shown here.
                  const chosen = { dateOfBirth, ageYears: Math.min(17, Math.max(0, age)) };
                  const form = { ...draft, slots: { ...draft.slots, [slot.id]: { ...child, ...chosen } } };
                  setDraft(form);
                  onAction(fillOf(form));
                }} />
            </div>
          </div>
          {slot.ageYears !== null && <div className="mt-4 flex flex-wrap items-center gap-x-3 gap-y-1.5">
            <Badge variant={meta.badge} className="gap-1.5 px-3 py-1.5 text-base"><Icon className="h-4 w-4" />{meta.label}</Badge>
            {meta.note && <span className="text-base font-medium text-foreground/70">{meta.note}</span>}
          </div>}
        </div>;
      })}
      {step === 'children' && !childrenComplete && <p className="text-center text-base text-foreground/60">{t('superviseConsent.nameAndAgeFirst')}</p>}

      {step === 'care' && <>
        {prompt.slots.map((slot) => {
          const child = draft.slots[slot.id]!;
          return <div key={slot.id} className="rounded-3xl border border-foreground/10 bg-foreground/5 p-6 space-y-4" data-testid="consent-care">
            <div className="flex items-center gap-2 text-xl font-semibold"><Baby className="h-5 w-5" />{child.name || t('superviseConsent.thisChild')}</div>
            {slot.saved ? <p className="text-lg text-foreground/70">{t('superviseConsent.savedOnProfile')}</p> : <>
              <div>
                <label className="flex items-center gap-2 text-lg text-foreground/70"><HeartPulse className="h-5 w-5" /> {t('superviseConsent.allergiesMedical')}</label>
                <Textarea value={child.allergiesMedical} maxLength={500} disabled={locked} onChange={(event) => setChild(slot.id, { allergiesMedical: event.target.value })}
                  placeholder={t('superviseConsent.allergiesPlaceholder')}
                  className="mt-2 min-h-[88px] border-foreground/10 bg-foreground/5 text-lg text-foreground placeholder:text-foreground/30" />
              </div>
              <div>
                <label className="flex items-center gap-2 text-lg text-foreground/70"><UtensilsCrossed className="h-5 w-5" /> {t('superviseConsent.dietaryNotes')}</label>
                <TouchText value={child.foodRestrictions} maxLength={200} disabled={locked} onChange={(foodRestrictions) => setChild(slot.id, { foodRestrictions })}
                  placeholder={t('superviseConsent.dietaryPlaceholder')} className="mt-2 h-12 border-foreground/10 bg-foreground/5 px-4 text-lg text-foreground placeholder:text-foreground/30" />
              </div>
            </>}
          </div>;
        })}
        {prompt.consentRequired && <p className="flex items-center gap-2 text-base text-foreground/70"><Camera className="h-5 w-5 shrink-0" />{t('superviseConsent.photoAtReception')}</p>}
      </>}

      {step === 'agreements' && <>
        <div className="rounded-3xl border border-foreground/10 bg-foreground/5 p-6 space-y-5">
          <div><label htmlFor="public-consent-guardian" className="text-lg text-foreground/70">{t('superviseConsent.parentGuardianName')}</label>
            <TouchText id="public-consent-guardian" value={draft.guardianName} maxLength={100} disabled={locked}
              onChange={(guardianName) => setDraft((current) => ({ ...current, guardianName }))}
              placeholder={t('superviseConsent.yourFullName')} className={FIELD} /></div>
          <div>
            <label className="flex items-center gap-2 text-lg text-foreground/70"><Phone className="h-5 w-5" /> {t('superviseConsent.phoneNumber')}</label>
            {phoneKept ? <div data-testid="consent-kept-phone">
              <div className="mt-2 flex h-14 items-center rounded-md border border-foreground/10 bg-foreground/5 px-4 text-2xl font-semibold tabular-nums">{formatStoredPhone(prompt.guardianPhone ?? '')}</div>
              <p className="mt-2 text-base text-foreground/50">{t('till.input.phoneKept')}</p>
            </div> : <PhoneInput value={draft.guardianPhone} onChange={(guardianPhone) => setDraft((current) => ({ ...current, guardianPhone }))}
              label="" showKeypad={kioskFlags.screenKeyboard} disabled={locked} translate
              channel={takesContact ? draft.contactChannel ?? prompt.contactChannel : undefined}
              onChannelChange={takesContact ? (contactChannel) => { if (!locked) setDraft((current) => ({ ...current, contactChannel })); } : undefined}
              inputClassName="h-14 border-foreground/10 bg-foreground/5 px-4 text-2xl text-foreground" />}
          </div>
          {prompt.consentRequired && <label className="flex w-full items-start gap-4 rounded-2xl border border-foreground/10 bg-foreground/5 p-4 text-left">
            <Checkbox checked={draft.consentAcknowledged} disabled={locked} data-testid="public-consent-ack"
              onCheckedChange={(value) => setDraft((current) => ({ ...current, consentAcknowledged: value === true }))}
              className="mt-1 h-6 w-6 border-foreground/30 data-[state=checked]:bg-primary" />
            <span className="text-lg leading-snug text-foreground/80">{t('superviseConsent.consentText')}</span></label>}
        </div>
        {prompt.confirmations.length > 0 && <div className="rounded-3xl border border-foreground/10 bg-foreground/5 p-6 space-y-3">
          <div className="flex items-center gap-2 text-lg font-semibold text-foreground/80"><ClipboardCheck className="h-5 w-5" />{t('superviseConsent.pleaseConfirm')}</div>
          {prompt.confirmations.map((item) => <label key={item.id} className="flex w-full items-start gap-4 rounded-2xl border border-foreground/10 bg-foreground/5 p-4 text-left">
            <Checkbox checked={draft.confirmations.includes(item.id)} disabled={locked} onCheckedChange={(value) => setDraft((current) => ({
              ...current,
              confirmations: value === true ? [...current.confirmations.filter((id) => id !== item.id), item.id] : current.confirmations.filter((id) => id !== item.id),
            }))} className="mt-1 h-6 w-6 border-foreground/30 data-[state=checked]:bg-primary" />
            <span className="text-lg leading-snug text-foreground/80">{item.text}{!item.required && <span className="ml-2 text-sm text-foreground/40">({t('superviseConsent.optional')})</span>}</span>
          </label>)}
        </div>}
      </>}
    </div>

    <div className="shrink-0 border-t border-foreground/10 px-8 py-4 flex flex-wrap items-center justify-end gap-3">
      {prompt.completed ? <p role="status">{t('superviseConsent.waitForTeam')}</p> : <>
        {helpAsked && <p role="status" className="mr-auto flex items-center gap-2 text-base text-foreground/70"><Users className="h-5 w-5" />{t('superviseConsent.teamComing')}</p>}
        <Button variant="outline" disabled={busy || helpAsked} onClick={() => { setHelpAsked(true); onAction({ ...fence, action: 'staff_help' }); }}>{t('superviseConsent.askTeam')}</Button>
        {index > 0 && <Button variant="outline" disabled={locked} onClick={() => setStep(STEPS[index - 1]!)}>{t('common.back')}</Button>}
        {step !== 'agreements'
          ? <Button disabled={locked || step === 'children' && !childrenComplete} onClick={next}>{t('common.continue')}</Button>
          : saved
            ? <Button disabled={locked || !prompt.canContinue} onClick={() => onAction({ ...fence, action: 'done' })}>{t('common.done')}</Button>
            : <Button disabled={locked || prompt.consentRequired && draft.consentAcknowledged && !draft.guardianName.trim()} onClick={next}>{t('common.continue')}</Button>}
      </>}
    </div>
  </div>;
}
