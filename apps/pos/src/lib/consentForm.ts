import { normalizePhone, validateMessagingPhone, type ConsentAction, type ConsentFormStep, type FilledConsentSlot } from '@oto/shared';
import type { SupervisedSlot } from '@/components/till/SupervisionGate';
import type { ContactChannel } from '@/types';

/**
 * SCRUM-764 — A STEP OF THE DROP-OFF OR NANNY FORM, AS THE TILL TAKES IT IN.
 *
 * The family fills the form on the customer screen and each step arrives at
 * the till; this is what that step changes on the till's own copy of each
 * child, so the staff gate and the private details show it. Only children on
 * this form are touched. A child from the family's saved profile keeps the care
 * notes the profile holds: those are changed with staff, never from the public
 * screen. Nothing staff decide — the photo, the food choice, a waiver — is in
 * a filled step at all.
 */
export function consentSlotPatches(
  slots: readonly SupervisedSlot[],
  filled: readonly FilledConsentSlot[],
): { id: string; patch: Partial<SupervisedSlot> }[] {
  return filled.flatMap((child) => {
    const slot = slots.find((item) => item.id === child.id);
    if (!slot) return [];
    const patch: Partial<SupervisedSlot> = {
      name: child.name,
      dateOfBirth: child.dateOfBirth ?? undefined,
      age: child.ageYears === null ? '' : String(child.ageYears),
      ...(slot.savedChildId ? {} : { allergiesMedical: child.allergiesMedical, foodRestrictions: child.foodRestrictions }),
    };
    return [{ id: slot.id, patch }];
  });
}

/**
 * SCRUM-863 — the parent's number as the form sends it and the till keeps it:
 * the stored form when it reads as a number, what was typed when it does not
 * yet. The display and the till both use this, so the form the till publishes
 * back is the one the family's screen is waiting for.
 */
export function consentFormPhone(typed: string): string {
  const trimmed = typed.trim();
  return (normalizePhone(trimmed) ?? trimmed).slice(0, 32);
}

/**
 * SCRUM-943 — THE NUMBER AS THE FORM DRAWS IT. A number typed with its trunk
 * 0 (0898943002 after +66) is the number the till keeps without it, and the
 * till's copy of the form and the check-in board draw it so (+66 898943002),
 * as the prototype's keypad asks for it (its placeholder is 8X XXX XXXX). So
 * once what was typed reads as a number that can take messages, the form
 * draws it the same way; while it is still being typed, as typed.
 */
export function consentPhoneShown(typed: string): string {
  return messagingPhoneProblem(typed) === null ? consentFormPhone(typed) : typed;
}

/**
 * SCRUM-857 — THE FAMILY'S CONFIRMATION THAT THE NUMBER IS THE ONE FOR THE
 * CHANNEL (the owner's ruling of 8 November).
 *
 * Kept with the number and the channel it was given for, so the till never
 * has to clear it by hand: a confirmation stands only while the form still
 * holds that number and that channel (`contactConfirmationStands`), and an
 * edit to either — by the family on their screen, by staff on the till — is
 * what un-confirms it. `by` says who gave the tick: the family on their own
 * screen (the till's customer half, or the paired display), or staff on the
 * till with the family beside them, where the display could not show the
 * tick. The time is the till's clock, taken when the tick arrived.
 */
export interface ContactConfirmation {
  at: string;
  by: 'family' | 'staff';
  /** The number as the form keeps it (`consentFormPhone`). */
  phone: string;
  channel: ContactChannel;
}

/** True while the form still holds the number and channel the confirmation was given for. */
export function contactConfirmationStands(
  confirmation: ContactConfirmation | null,
  phone: string,
  channel: ContactChannel,
): boolean {
  return !!confirmation && !!confirmation.phone && confirmation.phone === consentFormPhone(phone) && confirmation.channel === channel;
}

/**
 * SCRUM-914 — a change on the form that withdraws the family's confirmation:
 * any other number (as the form keeps it) or any other channel. The tick is
 * then cleared and stays cleared until the family ticks again, on every
 * screen alike, however the number or channel is changed back afterwards.
 */
export function contactChangeWithdraws(
  from: { phone: string; channel: ContactChannel },
  to: { phone: string; channel: ContactChannel },
): boolean {
  return consentFormPhone(to.phone) !== consentFormPhone(from.phone) || to.channel !== from.channel;
}

/**
 * SCRUM-857 — why the number on the form cannot be confirmed yet, in the
 * form's own terms: nothing typed, or something that cannot take a family's
 * messages (the shared check, which the api repeats). Null when it can.
 */
export function messagingPhoneProblem(phone: string): 'empty' | 'invalid' | null {
  const checked = validateMessagingPhone(phone);
  if (checked.ok) return null;
  return checked.problem === 'empty' ? 'empty' : 'invalid';
}

/**
 * The till's side of the form, as `takeConsentAction` changes it. The setters
 * are the till's own state; `answered` moves the customer screen on to a new
 * request (`TicketDisplayState.answerRevision`).
 */
export interface ConsentFormTill {
  /** The till's copy of each child, for a filled step's patches. */
  slots: readonly SupervisedSlot[];
  /** The parent's number the till holds for the registration: the one given at the start, until it is changed. */
  guardianPhone: string;
  /** The form as it is shown now, which a `done` marks finished. */
  signature: string;
  updateSlot: (id: string, patch: Partial<SupervisedSlot>) => void;
  setGuardianName: (name: string) => void;
  setGuardianPhone: (phone: string) => void;
  /** SCRUM-863 — the channel the check-in confirmation goes to, as the family chose it on the form. */
  setContactChannel: (channel: ContactChannel) => void;
  setConsentAcknowledged: (value: boolean) => void;
  setAcknowledgedConfirmationIds: (ids: string[]) => void;
  setCompletedSignature: (signature: string | null) => void;
  askedForHelp: () => void;
  answered: () => void;
  /**
   * SCRUM-857 — the till's side of the number confirmation. All optional, so
   * a till (or a test's model of one) from before the field is unchanged.
   */
  /** The channel the till holds now, for a step that sends none. */
  contactChannel?: ContactChannel;
  /** The form the till published asks for the tick (`contactConfirmed` was sent). */
  asksContactConfirmation?: boolean;
  /** The tick stands on the till for the number and channel the form holds. */
  contactConfirmed?: boolean;
  /** The family's tick (or its removal) for this number and channel, as the step carried it. */
  setContactConfirmed?: (confirmed: boolean, contact: { phone: string; channel: ContactChannel }) => void;
  /**
   * A step arrived without the tick although the form asked for it: the
   * display, or the station between, is from before the field and cannot
   * show it. Staff confirm the number with the family on the till instead.
   */
  contactConfirmationUnsupported?: () => void;
  /**
   * SCRUM-857 — the step the family is on, as their `fill` carried it, so
   * the till's copy of the form opens on it for staff (and a display that
   * re-pairs comes back to it). Optional, like the confirmation above.
   */
  setFamilyStep?: (step: ConsentFormStep | null) => void;
  /**
   * SCRUM-857 — the family took a child's photo on the display: collect the
   * stored file and keep it where a photo staff take is kept. Optional, so a
   * till (or a test's model of one) from before it is unchanged; such a till
   * never publishes a form that asks the display for a photo.
   */
  takePhoto?: (slotId: string, fileId: string) => void;
  /**
   * SCRUM-943 — what the family's screen said about its camera with this
   * step: none, refused, or nothing to say (null). Optional, like the above.
   */
  setDisplayCamera?: (camera: 'none' | 'refused' | null) => void;
}

/**
 * SCRUM-764 — AN ANSWER FROM THE FAMILY'S FORM, TAKEN IN BY THE TILL.
 *
 * The station keeps an answer on the customer's screen until the till
 * publishes the form under a new request, and the screen stays still while it
 * does ("please wait for the team"). A step that changes nothing on the till —
 * Back then Continue, the same date of birth chosen again — leaves the form as
 * it was, so nothing would republish it and the family's screen would wait for
 * ever. Every answer taken therefore ends with `answered`, which moves the
 * screen on to a new request whether or not the form changed.
 *
 * The caller has already checked the answer belongs to this form
 * (`consentActionAllowed`). The agreement ticks come only from here: staff's
 * copy of the form shows them and cannot change them while the family has it.
 */
export function takeConsentAction(action: ConsentAction, till: ConsentFormTill): void {
  if (action.action === 'staff_help') till.askedForHelp();
  // SCRUM-857 — a photo is not a step of the form and never finishes it.
  else if (action.action === 'photo') till.takePhoto?.(action.slotId, action.fileId);
  else if (action.action === 'acknowledge') {
    till.setGuardianName(action.guardianName);
    till.setConsentAcknowledged(action.consentAcknowledged);
    till.setAcknowledgedConfirmationIds(action.acknowledgedConfirmationIds);
    till.setCompletedSignature(null);
  } else if (action.action === 'fill') {
    for (const { id, patch } of consentSlotPatches(till.slots, action.slots)) till.updateSlot(id, patch);
    till.setGuardianName(action.guardianName);
    // SCRUM-863 — the family confirms or changes their number and channel on
    // the form, and what they send is what the registration keeps: the stored
    // form of a number that reads as one, otherwise as typed, exactly as the
    // till's own copy of the form holds it (the registration refuses a number
    // that cannot be one). The customer's own number on the sale is not
    // touched. An older display sends a number only when none was given at the
    // start and never a channel: a step without either changes neither.
    if (action.guardianPhone !== undefined) {
      const phone = consentFormPhone(action.guardianPhone);
      if (phone !== till.guardianPhone.trim()) till.setGuardianPhone(phone);
    }
    if (action.contactChannel !== undefined) till.setContactChannel(action.contactChannel);
    // SCRUM-857 — where the family is on their screen; a step from a display
    // (or a station between) that does not send it leaves the till not knowing.
    till.setFamilyStep?.(action.step ?? null);
    // SCRUM-943 — the display's camera, as this step said (nothing said: no trouble).
    till.setDisplayCamera?.(action.camera ?? null);
    // SCRUM-857 — the family's tick that this number is the one for the
    // channel comes with the step, for the number and channel the step
    // carries (the till's own when the step carries none). A step without
    // the tick on a form that asked for it means the display, or the station
    // between, does not know the field: staff confirm with the family here.
    if (action.contactConfirmed !== undefined) {
      till.setContactConfirmed?.(action.contactConfirmed, {
        phone: action.guardianPhone !== undefined ? consentFormPhone(action.guardianPhone) : consentFormPhone(till.guardianPhone),
        channel: action.contactChannel ?? till.contactChannel ?? 'whatsapp',
      });
    } else if (till.asksContactConfirmation) till.contactConfirmationUnsupported?.();
    till.setConsentAcknowledged(action.consentAcknowledged);
    till.setAcknowledgedConfirmationIds(action.acknowledgedConfirmationIds);
    till.setCompletedSignature(null);
  } else if (till.asksContactConfirmation && !till.contactConfirmed) {
    // SCRUM-857 — a `done` while the number is unconfirmed can only come
    // through a display or station from before the field (a form that shows
    // the tick never offers Done without it): the form is not finished, and
    // staff confirm the number with the family on the till.
    till.contactConfirmationUnsupported?.();
  } else till.setCompletedSignature(till.signature);
  till.answered();
}

/**
 * SCRUM-764 — MAY STAFF TICK THE AGREEMENTS ON THEIR COPY OF THE FORM?
 *
 * Not while the family has the form on their own screen: the ticks are theirs,
 * and the till shows each one as ticked or not. When a display is paired but
 * cannot take the form — the till is working through the counter box with the
 * internet down, or the price is still being worked out — the family has no
 * screen to tick on, and staff go through the agreements with them on the till
 * as they did before the form moved to the display. Without that, nobody could
 * tick, and the child could not be registered until the connection came back.
 */
export function staffTicksAgreements(input: {
  /** The till is publishing the form to the paired display. */
  formPublished: boolean;
  displayConnected: boolean;
  displaySupported: boolean;
  displayError: boolean;
}): boolean {
  return !(input.formPublished && input.displayConnected && input.displaySupported && !input.displayError);
}

/**
 * SCRUM-857 — DOES THE FAMILY TAKE THIS CHILD'S PHOTO ON THE PAIRED DISPLAY?
 *
 * The owner's ruling of 8 November: the family takes the photo with a button
 * in the care details, instead of reception. The till marks each child the
 * photo is asked for (one who needs the consent) as `needed` until it holds a
 * photo and `taken` once it does, whoever took it. Only at a station whose
 * display follows the platform's own box: a counter box (the till's bridge
 * origin) has no route for the picture yet, so its display keeps "reception
 * will take the photo" and staff take it on the till, as they always have.
 * The answer is the slot's field as the form carries it: absent, or `photo`.
 */
export function consentSlotPhoto(input: {
  needsConsent: boolean;
  hasPhoto: boolean;
  /** The till stands at a station (the platform collects the picture for that station only). */
  stationId: string | null | undefined;
  /** The till publishes the display through a counter box. */
  throughCounterBox: boolean;
}): { photo?: 'needed' | 'taken' } {
  if (!input.needsConsent || !input.stationId || input.throughCounterBox) return {};
  return { photo: input.hasPhoto ? 'taken' : 'needed' };
}

/**
 * SCRUM-943 — WHAT STAFF ARE TOLD ABOUT THE PHOTO WHILE THE FAMILY FILLS THE
 * FORM ON THE PAIRED DISPLAY.
 *
 * A photo is still needed and the family's screen cannot take it: the till
 * does not ask the display for photos here (a counter box has no route for
 * the picture, `consentSlotPhoto`), or the display said it has no camera or
 * the camera was refused. The line says so, and that the photo is taken at
 * the till. Null when there is nothing to say. Staff's own English.
 */
export function staffCameraLine(input: {
  photoStillNeeded: boolean;
  /** The till asks the display for each child's photo. */
  displayAsked: boolean;
  /** What the display said about its camera with the family's last step. */
  displayCamera: 'none' | 'refused' | null;
}): string | null {
  if (!input.photoStillNeeded) return null;
  const here = "Take each child's photo with the family here, in Private child details.";
  if (!input.displayAsked) return `The display does not take the photo at this station. ${here}`;
  if (input.displayCamera === 'none') return `The display has no camera. ${here}`;
  if (input.displayCamera === 'refused') return `The camera on the display was refused. ${here}`;
  return null;
}
