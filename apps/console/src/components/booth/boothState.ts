import type { Tone } from '@/components/Status';
import type {
  BoothArchivedPrize,
  BoothDraft,
  BoothStaffRow,
  BoothStatus,
  VoucherDefinitionRow,
} from './boothApi';

/**
 * The Booths page's readings that are words and arithmetic rather than
 * pictures (SCRUM-468): what the setup checklist ticks, what the header says
 * about the published wheel and the draft, and whether an archived prize can
 * be brought back. Pure, so the unit runner covers them (`test/booth-state.test.ts`);
 * the components only draw what these return.
 */

/** One step of "Set up this booth", with the section of the page it jumps to. */
export interface SetupStep {
  /** The element id on the Booths page the step links to. */
  id: string;
  label: string;
  done: boolean;
}

/**
 * The six steps, in the order a booth is set up, each ticked from the
 * readings the page holds.
 *
 * A reading that is not in hand — not read yet, failed, or kept from before a
 * failed refresh — is passed as null and ticks nothing: a tick is a claim
 * about the booth, and "the request did not answer" is not evidence for it.
 */
export function boothSetupSteps(
  draft: BoothDraft | null,
  status: BoothStatus | null,
  staff: readonly BoothStaffRow[] | null,
  now: number = Date.now(),
): SetupStep[] {
  const active = draft?.prizes.filter((p) => p.active) ?? [];
  return [
    { id: 'booth-printer', label: 'Printer added to the box', done: Boolean(status?.printer) },
    {
      id: 'booth-station',
      label: 'Booth station with its prefix',
      done: Boolean(draft && /^[A-Z0-9]{2}$/.test(draft.booth.codePrefix ?? '')),
    },
    {
      id: 'booth-settings',
      label: 'Layout and session length saved',
      done: Boolean(
        draft?.settings.layoutId &&
        (draft.settings.staffSessionMinutes == null || draft.settings.staffSessionMinutes > 0),
      ),
    },
    {
      id: 'booth-staff',
      label: 'Staff with PINs',
      done:
        staff !== null &&
        staff.length > 0 &&
        staff.every((p) => p.hasPin && (!p.pinExpiresAt || Date.parse(p.pinExpiresAt) > now)),
    },
    {
      id: 'booth-prizes',
      label: 'Prizes adding to 100%',
      done: active.length > 0 && active.reduce((sum, p) => sum + p.weightBp, 0) === 10_000,
    },
    {
      id: 'booth-publish',
      label: 'Published',
      done: Boolean(draft?.published && !draft.changed),
    },
  ];
}

/** A state chip: its tone and its words. */
export interface Standing {
  tone: Tone;
  label: string;
}

/**
 * What the header says about the wheel the booths are sent and the draft
 * behind it — two chips, because they are two different things.
 *
 * "Published" is what the cloud holds, never what a box is running: that is
 * the "Wheel version" reading under it, from the box's own heartbeat. The
 * words are the ones the Publish panel already uses. A booth never published
 * has one chip: its whole draft is unpublished, and saying so twice is noise.
 */
export function wheelStanding(draft: BoothDraft): { published: Standing; draft: Standing | null } {
  if (!draft.published) {
    return { published: { tone: 'warn', label: 'never published' }, draft: null };
  }
  return {
    published: { tone: 'ok', label: `version ${draft.published.version} published` },
    draft: draft.changed
      ? { tone: 'warn', label: 'draft has unpublished changes' }
      : { tone: 'ok', label: 'draft matches the published version' },
  };
}

/**
 * Why an archived prize cannot be restored yet, or null when it can.
 *
 * The API is the authority (`restoreBoothPrize`: 409 while the voucher type is
 * archived); this says the same thing before the press, from the voucher
 * types the page already holds, so a Restore that would be refused is not
 * offered as though it would work.
 */
export function restoreRefusal(
  prize: BoothArchivedPrize,
  definitions: readonly VoucherDefinitionRow[],
): string | null {
  if (!prize.voucherDefinitionId) return null;
  const type = definitions.find((d) => d.id === prize.voucherDefinitionId);
  if (!type?.archivedAt) return null;
  return `Its voucher type “${type.nameEn}” is archived. Restore that on Voucher types first.`;
}
