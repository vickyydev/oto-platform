/**
 * The Voucher slip card's model (SCRUM-471): what the form holds, what it
 * sends, and whether what was saved is in the booth's published wheel.
 *
 * Kept out of the component so the arithmetic of "changed", "valid" and
 * "published" is tested in Node (`test/voucher-slip.test.ts`) rather than
 * read off a screen.
 *
 * The rules are the platform's, not restated ones: the limits are
 * `BOOTH_VOUCHER_HEADER_MAX_CHARS` and `BOOTH_VOUCHER_FOOTER_MAX_CHARS`, blank
 * text is "no line" (`boothVoucherText`), and what a published wheel prints is
 * `boothVoucherSlip` over its settings — the same function the box runs.
 */
import {
  BOOTH_VOUCHER_FOOTER_MAX_CHARS,
  BOOTH_VOUCHER_HEADER_MAX_CHARS,
  boothVoucherSlip,
  boothVoucherText,
  type BoothVoucherSlip,
} from '@oto/shared';
import type { BoothDraft, BoothSettingsDraft, VoucherSlipInput } from './boothApi';

export { BOOTH_VOUCHER_FOOTER_MAX_CHARS, BOOTH_VOUCHER_HEADER_MAX_CHARS };

/** What the form holds: the two lines as typed, the three switches. */
export interface VoucherSlipEdit {
  showLogo: boolean;
  headerText: string;
  footerText: string;
  showStaff: boolean;
  showTerms: boolean;
}

/**
 * The saved slip as the form starts from, or null when this deployment does
 * not send the slip at all (older than migration 0039) — which the card says,
 * rather than offering a form whose save the API would not understand.
 */
export function slipFromSettings(settings: BoothSettingsDraft): VoucherSlipEdit | null {
  if (typeof settings.voucherShowLogo !== 'boolean') return null;
  const slip = savedSlip(settings);
  return {
    showLogo: slip.showLogo,
    headerText: slip.headerText ?? '',
    footerText: slip.footerText ?? '',
    showStaff: slip.showStaff,
    showTerms: slip.showTerms,
  };
}

/** The saved slip, resolved: what a publish now would send the box. */
export function savedSlip(settings: BoothSettingsDraft): BoothVoucherSlip {
  return boothVoucherSlip(settings);
}

/** The body the settings route and the preview route take: trimmed, blank as null. */
export function slipInput(edit: VoucherSlipEdit): VoucherSlipInput {
  return {
    voucherShowLogo: edit.showLogo,
    voucherHeaderText: boothVoucherText(edit.headerText),
    voucherFooterText: boothVoucherText(edit.footerText),
    voucherShowStaff: edit.showStaff,
    voucherShowTerms: edit.showTerms,
  };
}

/** Two slips that print the same paper are the same slip, whatever spaces were typed. */
export function sameSlip(a: BoothVoucherSlip, b: BoothVoucherSlip): boolean {
  return (
    a.showLogo === b.showLogo &&
    boothVoucherText(a.headerText) === boothVoucherText(b.headerText) &&
    boothVoucherText(a.footerText) === boothVoucherText(b.footerText) &&
    a.showStaff === b.showStaff &&
    a.showTerms === b.showTerms
  );
}

/** The form's edit, as the slip it would print. */
export function editedSlip(edit: VoucherSlipEdit): BoothVoucherSlip {
  const input = slipInput(edit);
  return {
    showLogo: input.voucherShowLogo,
    headerText: input.voucherHeaderText,
    footerText: input.voucherFooterText,
    showStaff: input.voucherShowStaff,
    showTerms: input.voucherShowTerms,
  };
}

/** Whether the form differs from what is saved. */
export function slipDirty(edit: VoucherSlipEdit, settings: BoothSettingsDraft): boolean {
  return !sameSlip(editedSlip(edit), savedSlip(settings));
}

/** Why the form cannot be saved, per field, or nothing. */
export function slipProblems(edit: VoucherSlipEdit): { header?: string; footer?: string } {
  const problems: { header?: string; footer?: string } = {};
  if (edit.headerText.trim().length > BOOTH_VOUCHER_HEADER_MAX_CHARS) {
    problems.header = `At most ${BOOTH_VOUCHER_HEADER_MAX_CHARS} characters.`;
  }
  if (edit.footerText.trim().length > BOOTH_VOUCHER_FOOTER_MAX_CHARS) {
    problems.footer = `At most ${BOOTH_VOUCHER_FOOTER_MAX_CHARS} characters.`;
  }
  return problems;
}

/**
 * The slip in the booth's last PUBLISHED wheel, resolved the way the box
 * resolves it, or null when nothing has been published.
 *
 * Published, not printed: the box prints it only once it has taken that
 * version (on this build, when its agent restarts), and a box on older
 * software ignores the fields and prints the standard slip. What a booth is
 * running is the box's own report on `GET /booths/:id/status`, which this
 * card does not read (see `publishPlan.ts`, "It says PUBLISHED and never
 * 'running'").
 */
export function publishedSlip(draft: BoothDraft): BoothVoucherSlip | null {
  const published = draft.publishedBundle as { settings?: Record<string, unknown> } | null | undefined;
  if (!published || typeof published !== 'object') return null;
  const settings = published.settings ?? {};
  return boothVoucherSlip({
    voucherShowLogo: typeof settings.voucherShowLogo === 'boolean' ? settings.voucherShowLogo : undefined,
    voucherHeaderText: typeof settings.voucherHeaderText === 'string' ? settings.voucherHeaderText : null,
    voucherFooterText: typeof settings.voucherFooterText === 'string' ? settings.voucherFooterText : null,
    voucherShowStaff: typeof settings.voucherShowStaff === 'boolean' ? settings.voucherShowStaff : undefined,
    voucherShowTerms: typeof settings.voucherShowTerms === 'boolean' ? settings.voucherShowTerms : undefined,
  });
}

/**
 * Where the slip stands, for the card's chip:
 *
 *   - `unsaved` — the form holds an edit nobody has saved;
 *   - `unpublished` — saved to the draft, and different from the slip in the
 *     published wheel (or nothing has been published);
 *   - `published` — what is saved is the slip in the published wheel.
 *
 * It never says the booth is PRINTING the slip, for the reason on
 * `publishedSlip`: the card knows what was published, not what the box took.
 */
export type SlipStanding = 'unsaved' | 'unpublished' | 'published';

export function slipStanding(edit: VoucherSlipEdit, draft: BoothDraft): SlipStanding {
  if (slipDirty(edit, draft.settings)) return 'unsaved';
  const published = publishedSlip(draft);
  if (published === null || !sameSlip(published, savedSlip(draft.settings))) return 'unpublished';
  return 'published';
}

/** The chip's words and tone for each standing. None claims what the booth is printing. */
export const SLIP_STANDING: Readonly<Record<SlipStanding, { tone: 'ok' | 'warn' | 'idle'; label: string }>> = {
  unsaved: { tone: 'warn', label: 'Unsaved changes' },
  unpublished: { tone: 'idle', label: 'Saved · not yet published' },
  published: { tone: 'ok', label: 'In the published wheel' },
};

/**
 * The slip a publish would carry, in a few words for the publish review — or
 * null on a deployment that does not send the slip. Names only what differs
 * from the slip every booth printed before SCRUM-471.
 */
export function slipSummary(settings: BoothSettingsDraft): string | null {
  if (typeof settings.voucherShowLogo !== 'boolean') return null;
  const slip = savedSlip(settings);
  const parts = [
    slip.showLogo ? null : 'no logo',
    slip.headerText === null ? null : 'a header line',
    slip.footerText === null ? null : 'a footer line',
    slip.showStaff ? null : 'no Staff row',
    slip.showTerms ? null : 'no terms',
  ].filter((part): part is string => part !== null);
  return parts.length === 0 ? 'the standard slip' : parts.join(' · ');
}
