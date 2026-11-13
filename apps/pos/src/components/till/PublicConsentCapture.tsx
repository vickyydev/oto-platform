import { formatStoredPhone } from '@/lib/phoneUtils';
import { useEffect, useRef, useState } from 'react';
import { CONSENT_FORM_STEPS, type ConsentAction, type ConsentFormStep, type ConsentPrompt, type FilledConsentSlot } from '@oto/shared';
import { ShieldCheck, ShieldAlert, UserCheck, ClipboardCheck, Baby, HeartPulse, UtensilsCrossed, Camera, Phone, Users, Eye } from 'lucide-react';
import { Checkbox } from '@/components/ui/checkbox';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { ChildDobPicker } from '@/components/shared/ChildDobPicker';
import { LanguageSwitcher } from '@/components/shared/LanguageSwitcher';
import { PhoneInput } from '@/components/shared/PhoneInput';
import { TouchText } from './TouchText';
import { DISPLAY_TOUCH, NARROW_BAR, NARROW_HEAD, NARROW_HEAD_TOUCH, NARROW_LINE, PLAYING_TODAY_CLEAR, SHORT_HIDE } from './consentFormLayout';
import { useLanguage } from '@/i18n/LanguageContext';
import { consentFormPhone, consentPhoneShown, messagingPhoneProblem } from '@/lib/consentForm';
import { clearConsentDraft, keepConsentDraft, readConsentDraft } from '@/lib/consentDraftStore';
import { consentMissing, consentMissingLine } from '@/lib/consentFinish';
import { CHANNEL_LABEL } from '@/lib/contactChannel';
import type { DisplayPhotoForm } from '@/api/consentPhoto';
import { DisplayChildPhoto, MirrorChildPhoto, useCameraPresence } from './DisplayChildPhoto';
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
 *
 * SCRUM-857 — the family must explicitly confirm that the number is the one
 * for the chosen channel (the owner's ruling of 8 November): a tick-box line
 * under the number that names the channel, cleared when the number or the
 * channel changes, carried to the till with every step, and required before
 * Done. Shown only on a form whose till asks for it (`contactConfirmed` in
 * the prompt): a till from before the tick, or a station between that drops
 * the field, gets a form that asks for nothing and sends nothing new.
 *
 * SCRUM-857 — STAFF WATCH THE FORM AS IT IS FILLED (the owner's ruling of 12
 * November, Tom's point: the form opened and staff just kept waiting). The
 * family's entries travel to the till as they type, not only when a step is
 * finished: a `fill` goes a few hundred milliseconds after they stop typing
 * (at the latest every second while they keep typing), at once for a choice
 * (a tick, the age, the channel, a step), and at once when a box loses focus.
 * One answer is out at a time, and the form never locks for a `fill`: the
 * family keeps typing while the till takes the last one, and what they typed
 * since goes next. The step they are on goes with it (`step`, on a form whose
 * till follows it: `familyStep` in the prompt), so the till's copy of this
 * same form (`mirror`) opens on that step for staff, read-only, and a display
 * that re-pairs mid-form comes back to it with everything the till holds.
 *
 * WHO WINS A FIELD (`mergeConsentDraft`). The station and the till take a
 * `fill` only for the copy of the form it was based on (its request id), so a
 * family fill based on an older copy is never laid over a newer staff edit.
 * When the till's newer copy arrives, each field is settled on its own: the
 * till's value where the family has not changed the field; the family's where
 * the till still holds the value it had, or any value this screen sent on
 * that copy (their newer typing goes next, and an older fill of theirs that
 * the station took late never pulls their text back); and the till's where it
 * changed the field to something else meanwhile. The last change the station
 * accepted wins, so typing that had not reached the till before staff changed
 * the same field gives way to staff's, which the family then sees.
 *
 * SCRUM-857 — the family takes each child's photo here, with the camera
 * button the till's own customer half has (the owner's ruling of 8
 * November). Shown for a child the till marks `photo` (needed or taken) on a
 * screen that can send it (`sendPhoto`); the picture goes to the platform
 * for this form and child, then a `photo` answer names it to the till. With
 * no camera, a refused camera or no mark (an older till or station), the
 * screen says reception will take the photo, and staff take it on the till.
 *
 * SCRUM-857 / SCRUM-875 — the family's Done moves the sale on by itself (no
 * staff confirmation): while the till writes the registration the finished
 * form says so (`finishing`), and if the write could not be made the form
 * opens again and says the team will check it with them (`notSaved`). Until
 * Done can be pressed, a short line under the agreements says what is still
 * missing: each child's details, the name and consent, the confirmations, the
 * number confirmation, a photo of each child.
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
  /** SCRUM-857 — the family's tick that the number is the one for the channel; absent on a form whose till does not ask. */
  contactConfirmed?: boolean;
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
    ...(prompt.contactConfirmed !== undefined ? { contactConfirmed: prompt.contactConfirmed } : {}),
    consentAcknowledged: prompt.consentAcknowledged,
    confirmations: prompt.confirmations.filter((item) => item.acknowledged).map((item) => item.id),
  };
}

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
const isText = (value: unknown): value is string => typeof value === 'string';
/** SCRUM-874 — a draft read back from this tab's storage is checked before it is used. */
function isFormDraft(value: unknown): value is FormDraft {
  if (!value || typeof value !== 'object') return false;
  const form = value as Record<string, unknown>;
  const slots = form.slots;
  return !!slots && typeof slots === 'object' && Object.values(slots as Record<string, unknown>).every((entry) => {
    const child = entry as Record<string, unknown> | null;
    return !!child && typeof child === 'object' && isText(child.name) && (child.dateOfBirth === null || isText(child.dateOfBirth))
      && (child.ageYears === null || typeof child.ageYears === 'number') && isText(child.allergiesMedical) && isText(child.foodRestrictions);
  }) && isText(form.guardianName) && isText(form.guardianPhone)
    && (form.contactChannel === undefined || form.contactChannel === 'whatsapp' || form.contactChannel === 'telegram' || form.contactChannel === 'line')
    && (form.contactConfirmed === undefined || typeof form.contactConfirmed === 'boolean')
    && typeof form.consentAcknowledged === 'boolean' && Array.isArray(form.confirmations) && form.confirmations.every(isText);
}
/**
 * The form as it is sent and as the till keeps it (`fillOf` below sends
 * exactly this), so what the family typed and the till's copy of it read as
 * the same form: a name with a space still being typed after it, a number
 * typed with its leading zero, a tick the till cannot take yet.
 */
const trimmed = (draft: FormDraft): FormDraft => ({
  ...draft,
  guardianName: draft.guardianName.trim().slice(0, 100),
  // The number as it is sent and as the till keeps it, so a number typed with
  // its leading zero is the same one once the till's copy comes back.
  guardianPhone: consentFormPhone(draft.guardianPhone),
  ...(draft.contactConfirmed !== undefined
    ? { contactConfirmed: draft.contactConfirmed && messagingPhoneProblem(draft.guardianPhone) === null } : {}),
  // A tick without a name is not one the till can take (`fillOf`).
  consentAcknowledged: draft.consentAcknowledged && !!draft.guardianName.trim(),
  confirmations: [...draft.confirmations].sort(),
  slots: Object.fromEntries(Object.entries(draft.slots).map(([id, child]) => [id, { ...child,
    name: child.name.trim().slice(0, 100), allergiesMedical: child.allergiesMedical.slice(0, 500),
    foodRestrictions: child.foodRestrictions.slice(0, 200) }])),
});

/**
 * The till's newer copy of the form (`next`), laid over what is on this
 * screen (`local`), field by field. `base` is the copy the family last had;
 * `sent` is every form this screen sent on that copy (`trimmed`), oldest
 * first: `next` is the till's answer to one of them (whichever the station
 * took first; a lost reply retried, or one the station still held, may be an
 * older one than the last), or to a staff edit.
 *
 * - The family has not changed the field: the till's value (staff helping, or
 *   the family's own entry coming back).
 * - The till holds a value this screen sent on that copy, or still holds the
 *   value it had: the family's, so what they typed since stays on their
 *   screen and goes next — never a flicker back to their own older text.
 * - The till changed it to something else (staff on the till): the till's. The
 *   station took that change first; the family's typing in that field, not yet
 *   at the till, was done before they could see it, and gives way.
 * - The family's number tick is never settled apart from the number and the
 *   channel it confirms: where the till's number or channel wins, so does the
 *   till's tick (which staff's change cleared).
 */
export function mergeConsentDraft(local: FormDraft, base: FormDraft, next: FormDraft,
  sent: FormDraft | readonly FormDraft[] = []): FormDraft {
  const history: readonly FormDraft[] = Array.isArray(sent) ? sent : [sent as FormDraft];
  const pick = <T,>(mine: T, was: T, theirs: T, sentValues: readonly (T | undefined)[], eq: (a: T, b: T) => boolean = same): T => {
    if (eq(mine, theirs)) return mine;
    if (sentValues.some((value) => value !== undefined && eq(theirs, value))) return mine;
    return eq(theirs, was) ? mine : theirs;
  };
  // A name is the same name with a space still being typed after it.
  const text = (a: string, b: string) => a.trim() === b.trim();
  const slots: Record<string, ChildDraft> = {};
  for (const [id, theirs] of Object.entries(next.slots)) {
    const mine = local.slots[id];
    const was = base.slots[id];
    const gone = history.map((form) => form.slots[id]);
    if (!mine || !was) { slots[id] = theirs; continue; }
    slots[id] = {
      name: pick(mine.name, was.name, theirs.name, gone.map((child) => child?.name), text),
      // The date and the age move together: one picker sets both.
      ...pick({ dateOfBirth: mine.dateOfBirth, ageYears: mine.ageYears }, { dateOfBirth: was.dateOfBirth, ageYears: was.ageYears },
        { dateOfBirth: theirs.dateOfBirth, ageYears: theirs.ageYears },
        gone.map((child) => child ? { dateOfBirth: child.dateOfBirth, ageYears: child.ageYears } : undefined)),
      allergiesMedical: pick(mine.allergiesMedical, was.allergiesMedical, theirs.allergiesMedical, gone.map((child) => child?.allergiesMedical)),
      foodRestrictions: pick(mine.foodRestrictions, was.foodRestrictions, theirs.foodRestrictions, gone.map((child) => child?.foodRestrictions)),
    };
  }
  // SCRUM-863 — a number is the same number typed with its leading zero or
  // in its stored form.
  const number = (a: string, b: string) => consentFormPhone(a) === consentFormPhone(b);
  const sorted = (ids: string[]) => [...ids].sort();
  const all = <K extends keyof FormDraft>(key: K) => history.map((form) => form[key]);
  const guardianPhone = pick(local.guardianPhone, base.guardianPhone, next.guardianPhone, all('guardianPhone'), number);
  const contactChannel = next.contactChannel
    ? pick(local.contactChannel, base.contactChannel, next.contactChannel, all('contactChannel')) : undefined;
  // SCRUM-857 — the family's tick confirms the number and channel on their
  // own screen, so it is settled with them, never apart: where the till's
  // number or channel wins (staff changed it on the till), the tick is the
  // till's too, which that change cleared. The family's tick is never kept
  // for a number or channel they did not confirm.
  const contactMoved = !number(guardianPhone, local.guardianPhone)
    || (contactChannel !== undefined && contactChannel !== local.contactChannel);
  return {
    slots,
    guardianName: pick(local.guardianName, base.guardianName, next.guardianName, all('guardianName'), text),
    guardianPhone,
    ...(contactChannel ? { contactChannel } : {}),
    ...(next.contactConfirmed !== undefined
      ? { contactConfirmed: contactMoved ? next.contactConfirmed
        : pick(local.contactConfirmed, base.contactConfirmed, next.contactConfirmed, all('contactConfirmed')) } : {}),
    consentAcknowledged: pick(local.consentAcknowledged, base.consentAcknowledged, next.consentAcknowledged, all('consentAcknowledged')),
    confirmations: pick(local.confirmations, base.confirmations, next.confirmations, all('confirmations'),
      (a, b) => same(sorted(a), sorted(b))),
  };
}

const FIELD = 'mt-2 h-14 border-foreground/10 bg-foreground/5 px-4 text-2xl text-foreground placeholder:text-foreground/30';
const STEPS = CONSENT_FORM_STEPS;
type Step = ConsentFormStep;
/** SCRUM-857 — a `fill` goes this long after the family stops typing… */
export const LIVE_FILL_MS = 300;
/** …and at the latest this long after their first unsent change, while they keep typing. */
export const LIVE_FILL_MAX_MS = 1_000;
/**
 * A `fill` the station did not take is tried again after this long, a few
 * times for each copy of the form and each new change the family makes.
 */
const LIVE_RETRY_MS = 1_000;
const LIVE_TRIES = 3;
/**
 * The till took the same form this many times in a row without keeping it
 * (a value it reads differently, such as an age from a date of birth): the
 * form stops sending it until the family changes something or presses on.
 */
const LIVE_IGNORED = 2;
/**
 * SCRUM-857 — a picture named to the till while the till still shows no
 * photo for that child this long after is named again (the answer was lost
 * or refused on its way, or the till could not collect it), up to this many
 * times in all; the till keeps the same file once.
 */
export const PHOTO_RESEND_MS = 5_000;
export const PHOTO_TRIES = 3;
/** SCRUM-875 — Done waits on a change still on its way to the till; past this long, the line under the form says so. */
export const SLOW_SEND_MS = 1_500;

/** The public part of ConsentCapture: the family fills it; the photo and staff decisions remain at the till. */
export function PublicConsentCapture({ prompt, busy, onAction, answerPending = busy, mirror, sendPhoto }: {
  prompt: ConsentPrompt;
  /** The form is locked: the family pressed Done or asked something the till must answer first. */
  busy: boolean;
  onAction: (action: ConsentAction) => void;
  /**
   * SCRUM-857 — an answer from this screen is on its way to the till, or kept
   * by the station until the till takes it. The form stays open (a `fill`
   * never locks it); the next answer waits until this one is taken.
   */
  answerPending?: boolean;
  /**
   * SCRUM-857 — this is the till's own copy of the family's screen, for staff
   * to watch as it is filled: the form as the till holds it (`prompt`), on the
   * step the family is on, read-only. `step` is null when the family's screen
   * does not say (an older display, or a station between that drops it): every
   * step is shown, one under the other. `photos`: the photo the till holds
   * for each child, by slot, shown where the family's screen has its camera.
   */
  mirror?: { step: ConsentFormStep | null; photos?: Readonly<Record<string, string>> };
  /** SCRUM-857 — store the family's picture of a child; answered with the stored file's id. Absent, the photo stays at reception. */
  sendPhoto?: (form: DisplayPhotoForm, dataUrl: string) => Promise<string>;
}) {
  const { t, lang } = useLanguage();
  /**
   * SCRUM-874 — a form opening again for the same visitor (the display was
   * paused by a dropped connection, reloaded or paired again) lays the draft
   * it kept over the till's copy, as it would any newer copy, and sends what
   * the till is missing. A finished form keeps nothing.
   */
  const [restored] = useState(() => {
    if (mirror) return null;
    if (prompt.completed) { clearConsentDraft(); return null; }
    const stored = readConsentDraft(prompt.visitorId, isFormDraft);
    return stored ? { local: mergeConsentDraft(stored.local, stored.base, draftOf(prompt), stored.sent), step: stored.step, sent: stored.sent } : null;
  });
  const [localDraft, setDraft] = useState<FormDraft>(() => restored?.local ?? draftOf(prompt));
  const base = useRef<FormDraft>(draftOf(prompt));
  // SCRUM-857 — a display that re-paired mid-form opens where the family was.
  const [localStep, setStep] = useState<Step>(() => restored?.step ?? prompt.familyStep ?? 'children');
  const stepNow = useRef(localStep);
  stepNow.current = localStep;
  const draft = mirror ? draftOf(prompt) : localDraft;
  const step: Step = mirror ? mirror.step ?? 'children' : localStep;
  const shows = (name: Step) => (mirror && mirror.step === null) || step === name;
  // SCRUM-954 — each step opens at its top. The steps share one scrolling
  // part, which kept the last step's place: after a long care step the
  // agreements step opened at the confirmations, with the guardian's name and
  // number above the screen (the counter display, two children).
  const scroller = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (scroller.current) scroller.current.scrollTop = 0;
  }, [step]);
  const [helpAsked, setHelpAsked] = useState(false);
  const lastRequest = useRef(prompt.requestId);
  /** Every form this screen sent on the copy it has, until the till's next copy arrives (`mergeConsentDraft`). */
  const sent = useRef<FormDraft[]>(restored?.sent ?? []);
  /** SCRUM-874 — the draft as it stands, kept for this visitor. */
  const persist = (local: FormDraft, at: Step) => {
    if (mirror || prompt.completed) return;
    keepConsentDraft({ visitorId: prompt.visitorId, base: base.current, local, sent: sent.current, step: at, savedAt: Date.now() });
  };
  /** Copies in a row in which the till did not keep what was sent (`LIVE_IGNORED`). */
  const ignored = useRef(0);
  useEffect(() => {
    if (mirror || lastRequest.current === prompt.requestId) return;
    lastRequest.current = prompt.requestId;
    const next = draftOf(prompt);
    const gone = sent.current;
    const was = base.current;
    sent.current = [];
    // The till took a form from here but its copy is the one before, unchanged.
    ignored.current = gone.length > 0 && !gone.some((form) => same(trimmed(next), form))
      && same(trimmed(next), trimmed(was)) ? ignored.current + 1 : 0;
    base.current = next;
    // The copy the merge is laid against is taken now: React may run this
    // update later, when `base` already holds the newer copy.
    setDraft((local) => {
      const merged = mergeConsentDraft(local, was, next, gone);
      if (!prompt.completed) keepConsentDraft({ visitorId: prompt.visitorId, base: next, local: merged, sent: [], step: stepNow.current, savedAt: Date.now() });
      return merged;
    });
  }, [prompt, mirror]);
  // SCRUM-874 — kept as the family types and moves; cleared once the form is finished.
  useEffect(() => {
    if (mirror) return;
    if (prompt.completed) clearConsentDraft();
    else persist(localDraft, localStep);
  }, [localDraft, localStep, prompt.completed, mirror]); // eslint-disable-line react-hooks/exhaustive-deps -- persist reads the refs as they stand

  const fence = { requestId: prompt.requestId, visitorId: prompt.visitorId };
  const locked = busy || prompt.completed;
  /** SCRUM-943 — the till's copy for staff: nothing on it can be pressed, and it looks so. */
  const readOnly = !!mirror;
  /** SCRUM-954 — the family's own screen: its presses a finger's height; the till's copy keeps its sizes. */
  const touch = mirror ? undefined : DISPLAY_TOUCH;
  // SCRUM-857 — the family's photos: one file id per picture (a resend is the
  // same file), and each stored picture named to the till once the screen is
  // free to answer, the latest picture of a child replacing an earlier one.
  // Free means no answer of this screen's is out at all (`answerPending`), a
  // live `fill` included: the station takes one answer at a time. A picture
  // the till still shows no photo for a moment after it was named is named
  // again (`PHOTO_RESEND_MS`), so a name that was lost on its way between
  // two fills does not leave the child without a photo. The till's own copy
  // of this screen (`mirror`) never opens a camera: it shows the photo the
  // till holds.
  const marked = prompt.slots.some((slot) => slot.photo !== undefined);
  const takesPhotos = !mirror && !!sendPhoto && marked;
  const presence = useCameraPresence(takesPhotos);
  /**
   * SCRUM-943 — the till is told when this screen cannot take the photo it
   * asks for (`reportsCamera`): no camera here, or the camera was refused.
   * It goes with the next `fill`, and a change of it sends one by itself.
   */
  const [cameraTrouble, setCameraTrouble] = useState<'refused' | 'none' | null>(null);
  const reportsCamera = takesPhotos && prompt.reportsCamera === true;
  const camera: 'none' | 'refused' | null = !reportsCamera ? null : presence === 'none' ? 'none' : cameraTrouble;
  const cameraSent = useRef<'none' | 'refused' | null>(null);
  const photoIds = useRef(new Map<string, string>());
  const [photosToName, setPhotosToName] = useState<{ slotId: string; fileId: string }[]>([]);
  /** Each child's picture last named to the till, and how many times, until the till shows it holds a photo. */
  const named = useRef(new Map<string, { fileId: string; tries: number }>());
  useEffect(() => {
    // "Ask the team", waiting for the same free moment, goes first.
    if (answerPending || prompt.completed || photosToName.length === 0 || helpAsked && !helpSent.current) return;
    const [first, ...rest] = photosToName;
    setPhotosToName(rest);
    if (prompt.slots.some((slot) => slot.id === first!.slotId && slot.photo !== undefined)) {
      const before = named.current.get(first!.slotId);
      named.current.set(first!.slotId, { fileId: first!.fileId, tries: before?.fileId === first!.fileId ? before.tries + 1 : 1 });
      onAction({ ...fence, action: 'photo', slotId: first!.slotId, fileId: first!.fileId });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the fence and the answer callback follow the prompt and the parent's render
  }, [answerPending, prompt, photosToName, helpAsked]);
  useEffect(() => {
    for (const slotId of [...named.current.keys()]) {
      if (!prompt.slots.some((slot) => slot.id === slotId && slot.photo === 'needed')) named.current.delete(slotId);
    }
    if (answerPending || prompt.completed || photosToName.length > 0) return;
    const again = [...named.current].filter(([, item]) => item.tries < PHOTO_TRIES).map(([slotId, item]) => ({ slotId, fileId: item.fileId }));
    if (again.length === 0) return;
    const timer = setTimeout(() => setPhotosToName((queued) => [...queued,
      ...again.filter((item) => !queued.some((other) => other.slotId === item.slotId))]), PHOTO_RESEND_MS);
    return () => clearTimeout(timer);
  }, [answerPending, prompt, photosToName]);
  const uploadFor = (slotId: string) => async (dataUrl: string): Promise<string> => {
    const key = `${slotId}\n${dataUrl}`;
    const id = photoIds.current.get(key) ?? crypto.randomUUID();
    photoIds.current.set(key, id);
    return sendPhoto!({ id, visitorId: prompt.visitorId, slotId }, dataUrl);
  };
  const photoOf = (slot: ConsentPrompt['slots'][number]) => slot.photo === undefined ? null
    : mirror ? <MirrorChildPhoto mark={slot.photo} photo={mirror.photos?.[slot.id]} />
    : takesPhotos ? <DisplayChildPhoto mark={slot.photo} presence={presence} upload={uploadFor(slot.id)}
      onStored={(fileId) => setPhotosToName((queued) => [...queued.filter((item) => item.slotId !== slot.id), { slotId: slot.id, fileId }])}
      onCameraTrouble={setCameraTrouble} />
    : null;
  const saved = same(trimmed(draft), trimmed(draftOf(prompt)));
  // SCRUM-857 — a till that follows the family's step (`familyStep`) hears
  // every step change; one that does not is sent the form as before.
  const followsStep = !mirror && prompt.familyStep !== undefined;
  const stepSaved = !followsStep || prompt.familyStep === step;
  const unsent = !saved || !stepSaved || camera !== cameraSent.current;
  const sendable = !mirror && !locked && !answerPending;
  // SCRUM-863 — a till that sends the channel takes the number and the channel
  // back with every step, so the form asks for both. One that does not (an
  // older till, or a station that drops the field) would leave a changed
  // number unsaved and this screen waiting, so its form stays as it was: the
  // number fixed once one was given. A group with no child in care is an
  // ordinary sale: its number was asked once on the first screen and is not
  // asked again here (SCRUM-762), as on the till's own customer half, where
  // the parent's block shows only when a child needs consent.
  const takesContact = prompt.contactChannel !== undefined && prompt.consentRequired;
  const phoneKept = !takesContact && !!prompt.guardianPhone?.trim();
  // SCRUM-857 — a till that sends the tick asks for it: the family confirms
  // the number is the one for the channel, and the step carries the tick
  // back. A form without it (an older till, or a station that drops the
  // field) asks for nothing and sends nothing new, so an older station's
  // strict reading of the step is never tripped.
  const asksConfirm = takesContact && prompt.contactConfirmed !== undefined;
  const contactProblem = asksConfirm ? messagingPhoneProblem(draft.guardianPhone) : null;
  const contactChannel = draft.contactChannel ?? prompt.contactChannel ?? 'whatsapp';
  const childrenComplete = prompt.slots.every((slot) => {
    const child = draft.slots[slot.id];
    return !!child && child.name.trim().length > 0 && child.ageYears !== null;
  });
  const fillOf = (form: FormDraft, at: Step = step): ConsentAction => ({
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
    // SCRUM-857 — the tick, only on a form that asked for it, and only for a
    // number that can take messages (the till refuses the rest anyway).
    ...(asksConfirm ? { contactConfirmed: form.contactConfirmed === true && messagingPhoneProblem(form.guardianPhone) === null } : {}),
    // A tick without a name is not one the till can take; it is kept here until the name is in.
    consentAcknowledged: form.consentAcknowledged && !!form.guardianName.trim(),
    acknowledgedConfirmationIds: form.confirmations,
    // SCRUM-857 — where the family is, for the till's copy of this screen.
    ...(followsStep ? { step: at } : {}),
    // SCRUM-943 — this screen cannot take the photo, on a form whose till asks.
    ...(camera ? { camera } : {}),
  });

  /**
   * SCRUM-857 — THE FORM TRAVELS AS IT IS FILLED. One answer is out at a
   * time: while one is, the next waits (`urgent` sends it the moment the till
   * has taken the last), and the family keeps typing meanwhile.
   */
  const tries = useRef({ requestId: '', count: 0 });
  const dirtySince = useRef<number | null>(null);
  const urgent = useRef(false);
  const send = (form: FormDraft, at: Step) => {
    if (!sendable) { urgent.current = true; return; }
    if (tries.current.requestId !== prompt.requestId) tries.current = { requestId: prompt.requestId, count: 0 };
    tries.current.count += 1;
    urgent.current = false;
    dirtySince.current = null;
    sent.current = [...sent.current, trimmed(form)].slice(-20);
    persist(form, at);
    cameraSent.current = camera;
    onAction(fillOf(form, at));
  };
  const flush = useRef<() => void>(() => undefined);
  flush.current = () => { if (unsent) send(draft, step); };
  useEffect(() => {
    if (!unsent) { dirtySince.current = null; urgent.current = false; return; }
    if (!sendable || ignored.current >= LIVE_IGNORED) return;
    const tried = tries.current.requestId === prompt.requestId ? tries.current.count : 0;
    if (tried >= LIVE_TRIES) return;
    const now = Date.now();
    dirtySince.current ??= now;
    const delay = urgent.current ? 0 : tried > 0 ? LIVE_RETRY_MS
      : Math.min(LIVE_FILL_MS, Math.max(0, dirtySince.current + LIVE_FILL_MAX_MS - now));
    const timer = setTimeout(() => flush.current(), delay);
    return () => clearTimeout(timer);
  }, [draft, step, unsent, sendable, prompt.requestId, camera]);
  /** The family typed: sent a moment after they stop. */
  const edit = (update: (current: FormDraft) => FormDraft) => {
    // Something new to send: the tries on this copy start again.
    ignored.current = 0;
    tries.current.count = 0;
    setDraft(update);
  };
  /** The family chose something: sent at once. */
  const choose = (update: (current: FormDraft) => FormDraft) => {
    urgent.current = true;
    edit(update);
  };
  /** The family pressed on (Continue, a step, Back): whatever is unsent goes now, with the step. */
  const goTo = (to: Step) => {
    ignored.current = 0;
    if (!saved || followsStep && prompt.familyStep !== to) send(draft, to);
    setStep(to);
  };
  // "Ask the team" goes as soon as nothing else is out.
  const helpSent = useRef(false);
  useEffect(() => {
    if (!helpAsked || helpSent.current || !sendable) return;
    helpSent.current = true;
    onAction({ ...fence, action: 'staff_help' });
  });
  // SCRUM-875 — what is still missing before Done, from what the family has
  // entered here. The photos are the till's: each child it asks this screen
  // for is `taken` once it holds one, from the family or from staff (SCRUM-857);
  // a till that marks none says so in `staffReady`.
  const missingLine = consentMissingLine(t, consentMissing({
    children: prompt.slots.map((slot) => ({ name: draft.slots[slot.id]?.name ?? '', ageYears: draft.slots[slot.id]?.ageYears ?? null })),
    consentRequired: prompt.consentRequired,
    guardianName: draft.guardianName,
    consentAcknowledged: draft.consentAcknowledged,
    confirmations: prompt.confirmations.map((item) => ({ required: item.required, acknowledged: draft.confirmations.includes(item.id) })),
    ...(asksConfirm ? { contact: { confirmed: draft.contactConfirmed === true, problem: contactProblem } } : {}),
    photosTaken: marked ? prompt.slots.every((slot) => slot.photo !== 'needed') : prompt.staffReady,
  }), CHANNEL_LABEL[contactChannel]);
  // SCRUM-875 — with nothing missing, Done also waits while this screen's last
  // change is on its way to the till (it is pressed on the till's copy of the
  // form); when that takes more than a moment, the line says it is sending.
  const waitingOnTill = !mirror && saved && answerPending && !locked;
  const [slowSend, setSlowSend] = useState(false);
  useEffect(() => {
    if (!waitingOnTill) { setSlowSend(false); return; }
    const timer = setTimeout(() => setSlowSend(true), SLOW_SEND_MS);
    return () => clearTimeout(timer);
  }, [waitingOnTill]);
  const doneLine = missingLine ?? (slowSend ? t('display.sending') : null);
  const setChild = (id: string, patch: Partial<ChildDraft>) =>
    edit((current) => ({ ...current, slots: { ...current.slots, [id]: { ...current.slots[id]!, ...patch } } }));
  const index = STEPS.indexOf(step);
  const next = () => {
    if (index < STEPS.length - 1) goTo(STEPS[index + 1]!);
    else if (!saved) { ignored.current = 0; send(draft, step); }
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

  return <div className="relative flex h-full w-full min-h-0 flex-col bg-[image:var(--cd-gradient)] text-foreground"
    data-testid={mirror ? 'consent-mirror' : 'display-consent'} inert={mirror ? true : undefined}
    onBlurCapture={mirror ? undefined : () => { urgent.current = true; flush.current(); }}>
    {/* SCRUM-857 — staff's copy says whose screen this is, above the form
        (where the family's has its language button: staff read in theirs). */}
    {mirror
      ? <div className="shrink-0 flex justify-center px-8 pt-4"><div className="inline-flex items-center gap-2 rounded-full border border-foreground/15 bg-foreground/5 px-3 py-1.5 text-sm font-semibold text-foreground/70" data-testid="consent-mirror-status">
        <Eye className="h-4 w-4" />{t('superviseConsent.mirrorFilling')}</div></div>
      : <div className="absolute top-4 right-4 z-40"><LanguageSwitcher variant="dark" buttonClassName={DISPLAY_TOUCH} /></div>}
    {/* SCRUM-943 — at phone width the language button sits above the heading, not over it. */}
    <div className={cn('shrink-0 px-8 pb-4 text-center', mirror ? 'pt-3' : `pt-8 ${NARROW_HEAD} ${NARROW_HEAD_TOUCH}`)}>
      {/* SCRUM-975 — the line stays clear of the language button beside it
          (the reconnecting line's 9rem at each side), wrapping when long
          ("EN TRAIN DE JOUER CHEZ NOUS AUJOURD'HUI" at 600 wide). Under 520
          the heading already starts below the button (NARROW_HEAD). */}
      <div className={cn('mb-2 inline-flex items-center gap-2 text-primary', !mirror && PLAYING_TODAY_CLEAR)}><ShieldCheck className="h-6 w-6 shrink-0" />
        <span className="min-w-0 text-sm font-bold uppercase tracking-widest">{t('superviseConsent.playingToday')}</span></div>
      <h2 className="text-4xl font-black">{t(prompt.slots.length === 1 ? 'superviseConsent.titleOne' : 'superviseConsent.titleMany')}</h2>
      <p className={cn('mt-1 text-lg text-foreground/60', SHORT_HIDE)}>{t('superviseConsent.subtitle')}</p>
      <div className="mt-4 flex items-center justify-center gap-2" data-testid="consent-steps">
        {STEPS.map((name, at) => (
          <button key={name} type="button" disabled={locked || at > index && !childrenComplete}
            onClick={() => { if (at !== index) goTo(name); }}
            className={cn('rounded-full border px-4 py-1.5 text-base font-semibold transition-colors', touch,
              at === index ? 'border-primary bg-primary text-primary-foreground' : 'border-foreground/15 bg-foreground/5 text-foreground/70')}>
            {at + 1}. {t(name === 'children' ? 'superviseConsent.stepChildren' : name === 'care' ? 'superviseConsent.stepCare' : 'superviseConsent.stepAgreements')}
          </button>
        ))}
      </div>
      <p className="mt-2 text-sm text-foreground/50">{t('superviseConsent.stepOf', { n: index + 1, total: STEPS.length })} · {t('superviseConsent.teamFollowing')}</p>
    </div>

    <div ref={scroller} className="flex-1 min-h-0 space-y-5 overflow-y-auto px-8 pb-6">
      {shows('children') && prompt.slots.map((slot, at) => {
        const child = draft.slots[slot.id]!;
        const meta = requirementOf(slot);
        const Icon = meta.icon;
        return <div key={slot.id} className="rounded-3xl border border-foreground/10 bg-foreground/5 p-6" data-testid="consent-child">
          <div className="flex flex-col gap-4 sm:flex-row">
            <div className="flex-1">
              <label htmlFor={`consent-child-${at}`} className="flex items-center gap-2 text-lg text-foreground/70">
                <Baby className="h-5 w-5" /> {t('superviseConsent.childName')}</label>
              <TouchText id={`consent-child-${at}`} value={child.name} maxLength={100} disabled={locked} testId="consent-child-name"
                onChange={(name) => setChild(slot.id, { name })} placeholder={t('superviseConsent.fullName')} className={FIELD} />
            </div>
            <div className="sm:w-40">
              <label className="text-lg text-foreground/70">{t('superviseConsent.age')}</label>
              <ChildDobPicker lang={lang} dateOfBirth={child.dateOfBirth ?? undefined} age={child.ageYears} childName={child.name}
                disabled={locked} className="mt-2" matchSurface touch={!mirror}
                onChange={({ dateOfBirth, age }) => {
                  // An age is a choice, not typing: it goes to the till at once, so
                  // what this child needs is worked out there and shown here.
                  const chosen = { dateOfBirth, ageYears: Math.min(17, Math.max(0, age)) };
                  choose((current) => ({ ...current, slots: { ...current.slots, [slot.id]: { ...current.slots[slot.id]!, ...chosen } } }));
                }} />
            </div>
          </div>
          {slot.ageYears !== null && <div className="mt-4 flex flex-wrap items-center gap-x-3 gap-y-1.5">
            <Badge variant={meta.badge} className="gap-1.5 px-3 py-1.5 text-base"><Icon className="h-4 w-4" />{meta.label}</Badge>
            {meta.note && <span className="text-base font-medium text-foreground/70">{meta.note}</span>}
          </div>}
        </div>;
      })}
      {shows('children') && !childrenComplete && <p className="text-center text-base text-foreground/60">{t('superviseConsent.nameAndAgeFirst')}</p>}

      {shows('care') && <>
        {prompt.slots.map((slot) => {
          const child = draft.slots[slot.id]!;
          return <div key={slot.id} className="rounded-3xl border border-foreground/10 bg-foreground/5 p-6 space-y-4" data-testid="consent-care">
            <div className="flex items-center gap-2 text-xl font-semibold"><Baby className="h-5 w-5" />{child.name || t('superviseConsent.thisChild')}</div>
            {photoOf(slot)}
            {slot.saved ? <p className="text-lg text-foreground/70">{t('superviseConsent.savedOnProfile')}</p> : <>
              <div>
                <label className="flex items-center gap-2 text-lg text-foreground/70"><HeartPulse className="h-5 w-5" /> {t('superviseConsent.allergiesMedical')}</label>
                {/* SCRUM-893 — the allergies box opens the on-screen keyboard too. */}
                <TouchText multiline value={child.allergiesMedical} maxLength={500} disabled={locked} onChange={(allergiesMedical) => setChild(slot.id, { allergiesMedical })}
                  placeholder={t('superviseConsent.allergiesPlaceholder')} testId="consent-allergies"
                  className="mt-2 min-h-[88px] border-foreground/10 bg-foreground/5 text-lg text-foreground placeholder:text-foreground/30" />
              </div>
              <div>
                <label className="flex items-center gap-2 text-lg text-foreground/70"><UtensilsCrossed className="h-5 w-5" /> {t('superviseConsent.dietaryNotes')}</label>
                <TouchText value={child.foodRestrictions} maxLength={200} disabled={locked} onChange={(foodRestrictions) => setChild(slot.id, { foodRestrictions })} testId="consent-dietary"
                  placeholder={t('superviseConsent.dietaryPlaceholder')} className="mt-2 h-12 border-foreground/10 bg-foreground/5 px-4 text-lg text-foreground placeholder:text-foreground/30" />
              </div>
            </>}
          </div>;
        })}
        {prompt.consentRequired && !(mirror ? marked : takesPhotos) && <p className="flex items-center gap-2 text-base text-foreground/70"><Camera className="h-5 w-5 shrink-0" />{t('superviseConsent.photoAtReception')}</p>}
      </>}

      {shows('agreements') && <>
        <div className="rounded-3xl border border-foreground/10 bg-foreground/5 p-6 space-y-5">
          <div><label htmlFor="public-consent-guardian" className="text-lg text-foreground/70">{t('superviseConsent.parentGuardianName')}</label>
            <TouchText id="public-consent-guardian" value={draft.guardianName} maxLength={100} disabled={locked} testId="consent-guardian"
              onChange={(guardianName) => edit((current) => ({ ...current, guardianName }))}
              placeholder={t('superviseConsent.yourFullName')} className={FIELD} /></div>
          <div>
            <label className="flex items-center gap-2 text-lg text-foreground/70"><Phone className="h-5 w-5" /> {t('superviseConsent.phoneNumber')}</label>
            {phoneKept ? <div data-testid="consent-kept-phone">
              <div className="mt-2 flex h-14 items-center rounded-md border border-foreground/10 bg-foreground/5 px-4 text-2xl font-semibold tabular-nums">{formatStoredPhone(prompt.guardianPhone ?? '')}</div>
              <p className="mt-2 text-base text-foreground/50">{t('till.input.phoneKept')}</p>
            </div> : <PhoneInput value={consentPhoneShown(draft.guardianPhone)} onChange={(guardianPhone) => { if (!locked) edit((current) => ({ ...current, guardianPhone, ...(current.contactConfirmed !== undefined ? { contactConfirmed: false } : {}) })); }}
              label="" showKeypad={kioskFlags.screenKeyboard} disabled={locked} translate
              channel={takesContact ? draft.contactChannel ?? prompt.contactChannel : undefined}
              onChannelChange={takesContact ? (contactChannel) => { if (!locked) choose((current) => ({ ...current, contactChannel, ...(current.contactConfirmed !== undefined ? { contactConfirmed: false } : {}) })); } : undefined}
              // SCRUM-963 — WhatsApp, Telegram and LINE a finger's height on the family's screen.
              channelClassName={touch}
              inputClassName="h-14 border-foreground/10 bg-foreground/5 px-4 text-2xl text-foreground" />}
            {/* SCRUM-857 — the family confirms that this is the number for the
                channel they chose; a changed number or channel asks again. */}
            {asksConfirm && contactProblem === 'empty' && <p className="mt-3 text-base text-foreground/60" data-testid="consent-contact-needed">{t('superviseConsent.phoneNeeded')}</p>}
            {asksConfirm && contactProblem === 'invalid' && <p className="mt-3 text-base text-(--cd-amber)" data-testid="consent-contact-invalid">{t('superviseConsent.phoneInvalid')}</p>}
            {asksConfirm && <label className="mt-3 flex w-full items-start gap-4 rounded-2xl border border-foreground/10 bg-foreground/5 p-4 text-left">
              <Checkbox checked={draft.contactConfirmed === true} disabled={locked || contactProblem !== null} data-testid="public-consent-contact-confirm"
                onCheckedChange={(value) => choose((current) => ({ ...current, contactConfirmed: value === true }))}
                className="mt-1 h-6 w-6 border-foreground/30 data-[state=checked]:bg-primary" />
              <span className="text-lg leading-snug text-foreground/80">{t('superviseConsent.confirmContact', { channel: CHANNEL_LABEL[contactChannel] })}</span></label>}
          </div>
          {prompt.consentRequired && <label className="flex w-full items-start gap-4 rounded-2xl border border-foreground/10 bg-foreground/5 p-4 text-left">
            <Checkbox checked={draft.consentAcknowledged} disabled={locked} data-testid="public-consent-ack"
              onCheckedChange={(value) => choose((current) => ({ ...current, consentAcknowledged: value === true }))}
              className="mt-1 h-6 w-6 border-foreground/30 data-[state=checked]:bg-primary" />
            <span className="text-lg leading-snug text-foreground/80">{t('superviseConsent.consentText')}</span></label>}
        </div>
        {prompt.confirmations.length > 0 && <div className="rounded-3xl border border-foreground/10 bg-foreground/5 p-6 space-y-3">
          <div className="flex items-center gap-2 text-lg font-semibold text-foreground/80"><ClipboardCheck className="h-5 w-5" />{t('superviseConsent.pleaseConfirm')}</div>
          {prompt.confirmations.map((item) => <label key={item.id} className="flex w-full items-start gap-4 rounded-2xl border border-foreground/10 bg-foreground/5 p-4 text-left">
            <Checkbox checked={draft.confirmations.includes(item.id)} disabled={locked} onCheckedChange={(value) => choose((current) => ({
              ...current,
              confirmations: value === true ? [...current.confirmations.filter((id) => id !== item.id), item.id] : current.confirmations.filter((id) => id !== item.id),
            }))} className="mt-1 h-6 w-6 border-foreground/30 data-[state=checked]:bg-primary" />
            <span className="text-lg leading-snug text-foreground/80">{item.text}{!item.required && <span className="ml-2 text-sm text-foreground/40">({t('superviseConsent.optional')})</span>}</span>
          </label>)}
        </div>}
      </>}
    </div>

    <div className={cn('shrink-0 border-t border-foreground/10 px-8 py-4 flex flex-wrap items-center justify-end gap-3', NARROW_BAR)}>
      {prompt.completed ? <p role="status" data-testid="consent-finished">{t(prompt.finishing ? 'superviseConsent.finishing' : 'superviseConsent.waitForTeam')}</p> : <>
        {prompt.notSaved && <p role="status" className="w-full text-right text-base text-(--cd-amber)" data-testid="consent-not-saved">{t('superviseConsent.notSaved')}</p>}
        {shows('agreements') && doneLine && <p className={cn('w-full text-right text-base text-foreground/60', NARROW_LINE)} data-testid="consent-missing">{doneLine}</p>}
        {helpAsked && <p role="status" className="mr-auto flex items-center gap-2 text-base text-foreground/70"><Users className="h-5 w-5" />{t('superviseConsent.teamComing')}</p>}
        {/* SCRUM-943 — on the till's read-only copy (`mirror`) the family's
            buttons are drawn as not available: only their screen presses them. */}
        <Button variant="outline" className={touch} disabled={readOnly || busy || helpAsked} onClick={() => setHelpAsked(true)}>{t('superviseConsent.askTeam')}</Button>
        {index > 0 && <Button variant="outline" className={touch} disabled={readOnly || locked} onClick={() => goTo(STEPS[index - 1]!)}>{t('common.back')}</Button>}
        {step !== 'agreements'
          ? <Button className={touch} disabled={readOnly || locked || step === 'children' && !childrenComplete} onClick={next}>{t('common.continue')}</Button>
          : saved
            ? <Button className={touch} disabled={readOnly || locked || answerPending || !prompt.canContinue || asksConfirm && !prompt.contactConfirmed} onClick={() => onAction({ ...fence, action: 'done' })}>{t('common.done')}</Button>
            : <Button className={touch} disabled={readOnly || locked || prompt.consentRequired && draft.consentAcknowledged && !draft.guardianName.trim()} onClick={next}>{t('common.continue')}</Button>}
      </>}
    </div>
  </div>;
}
