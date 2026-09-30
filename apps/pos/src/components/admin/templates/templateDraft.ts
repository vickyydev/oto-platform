import type { PrintTemplate, PrintTemplateType } from '@/types';
import type { ApiPrintJob, ApiPrintTemplate } from '@/api/platform';
import { isBandType } from './templateFields';
import { DEFAULT_PREVIEW_SAMPLE, type PreviewSampleId } from './previewSamples';

/**
 * The template editor's pure parts (SCRUM-472): what counts as a change, what
 * the preview is asked for, what the paper chip says, and how a test print's
 * answer is put into words. Kept apart from the components so each rule has a
 * test (`apps/pos/test/template-editor.test.ts`) rather than living in a
 * handler.
 */

/**
 * The stored row as the editor's components want it.
 *
 * The API is explicit about absence (`null`) and the prototype's type is
 * explicit about omission (`undefined`); they mean the same thing here and the
 * conversion happens once, at the boundary, rather than in every reader.
 */
export function fromApi(row: ApiPrintTemplate): PrintTemplate {
  return {
    id: row.id,
    type: row.type,
    name: row.name,
    showLogo: row.showLogo,
    headerText: row.headerText ?? undefined,
    footerText: row.footerText ?? undefined,
    fields: row.fields as PrintTemplate['fields'],
  };
}

/**
 * Does the draft differ from the loaded template in anything a save would
 * store?
 *
 * A section that was never set and one switched off print the same — nothing
 * (`fieldOn` in `@oto/print` reads `!!fields[key]`) — so turning one on and
 * back off is not a change, and the save bar goes away again. An empty text
 * line and an absent one are the same for the same reason.
 */
export function isDirty(loaded: PrintTemplate, draft: PrintTemplate): boolean {
  if (loaded.name !== draft.name) return true;
  if (loaded.showLogo !== draft.showLogo) return true;
  if ((loaded.headerText ?? '') !== (draft.headerText ?? '')) return true;
  if ((loaded.footerText ?? '') !== (draft.footerText ?? '')) return true;
  const keys = new Set([...Object.keys(loaded.fields), ...Object.keys(draft.fields)]) as Set<
    keyof PrintTemplate['fields']
  >;
  for (const key of keys) {
    if (!!loaded.fields[key] !== !!draft.fields[key]) return true;
  }
  return false;
}

/**
 * What the save bar shows.
 *
 * It is there while there is something to save, and while a save is in flight
 * so "Saving…" can be read. A failed save does not keep it up on its own: a
 * person who flips the change back by hand after a failure has nothing to
 * save, and a bar still offering Save would send a PATCH that changes nothing
 * but the template's version — and with it the branch's config hash, so every
 * box on the branch pulls again. The error is only shown against a draft that
 * still differs, for the same reason.
 */
export function saveBarView(state: {
  dirty: boolean;
  saving: boolean;
  saveError: string | null;
}): { shown: boolean; error: string | null } {
  return {
    shown: state.dirty || state.saving,
    error: state.dirty ? state.saveError : null,
  };
}

/** What `PATCH /print-templates/:id` is sent for this draft. */
export function saveBody(draft: PrintTemplate) {
  return {
    name: draft.name.trim(),
    showLogo: draft.showLogo,
    headerText: draft.headerText ?? null,
    footerText: draft.footerText ?? null,
    fields: draft.fields,
  };
}

/**
 * The preview request for a draft, as one string.
 *
 * It is both what is sent and what the preview's effect depends on, so a
 * re-render that changed nothing the printer would draw — the template's name,
 * a parent's state — does not spend a round trip. The type is not in it: which
 * printout this is comes from the saved row and the editor cannot change it.
 * The scenario is only named when it is not the default, so a preview of the
 * Test print's own sample is the same request it always was.
 */
export function previewRequest(
  template: PrintTemplate,
  stationId: string | null,
  sample: PreviewSampleId = DEFAULT_PREVIEW_SAMPLE,
): string {
  return JSON.stringify({
    showLogo: template.showLogo,
    headerText: template.headerText ?? null,
    footerText: template.footerText ?? null,
    fields: template.fields,
    stationId,
    ...(sample === DEFAULT_PREVIEW_SAMPLE ? {} : { sample }),
  });
}

/**
 * The paper a preview is drawn for, from its width in dots.
 *
 * Receipt heads come in two rolls: 80 mm paper carries 576 dots (or 512 on the
 * narrower XP-80 build), 58 mm paper 384. A band printer lays down 8 dots a
 * millimetre across the band itself, so its width in dots is the band's.
 */
export function paperLabel(type: PrintTemplateType, dots: number): string {
  if (isBandType(type)) return `${Math.round(dots / 8)} mm band`;
  return dots > 440 ? '80 mm' : '58 mm';
}

export type OutcomeTone = 'ok' | 'warn' | 'error';

/** A test print's answer, as one line under the button. */
export function testPrintOutcome(
  job: Pick<ApiPrintJob, 'status' | 'deviceLabel' | 'errorMessage'>,
  destination: string | null,
): { tone: OutcomeTone; text: string } {
  const printer = job.deviceLabel ?? destination ?? 'the assigned printer';
  switch (job.status) {
    case 'skipped':
      return {
        tone: 'warn',
        text: `Not printed — ${job.errorMessage ?? 'no printer is assigned for this printout'}.`,
      };
    case 'failed':
      return {
        tone: 'error',
        text: `Failed on ${printer} — ${job.errorMessage ?? 'the printer did not take it'}.`,
      };
    case 'printed':
      return { tone: 'ok', text: `Printed on ${printer}.` };
    default:
      // The job is queued on the box, and a printer out of paper holds it until
      // the roll is changed: "sent" is the truth, not a hedge.
      return { tone: 'ok', text: `Sent to ${printer}. It prints as soon as the box picks it up.` };
  }
}
