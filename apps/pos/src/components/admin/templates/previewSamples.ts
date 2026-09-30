/**
 * The scenarios the template preview can be filled with (SCRUM-472).
 *
 * Names and labels only — never content. The samples themselves are
 * `@oto/print`'s (`packages/print/src/samples.ts`), rendered by the platform;
 * this browser only says which one to draw. The ids are the preview route's
 * zod enum, and `apps/api/test/print-preview-samples.test.ts` imports this list
 * to hold the two to the same spelling, so this file has no imports of its own.
 */
export const PREVIEW_SAMPLES = [
  {
    id: 'standard',
    label: 'Test print sample',
    hint: 'What the Test print button puts on paper',
  },
  { id: 'simple', label: 'Simple sale', hint: 'One child, one line, cash' },
  {
    id: 'full',
    label: 'Fuller sale',
    hint: 'A party’s worth of lines, service charge, credit issued',
  },
  { id: 'long_names', label: 'Long names', hint: 'Names and items that wrap, in both scripts' },
] as const;

export type PreviewSampleId = (typeof PREVIEW_SAMPLES)[number]['id'];

/** The sample a preview shows until someone picks another. */
export const DEFAULT_PREVIEW_SAMPLE: PreviewSampleId = 'standard';
