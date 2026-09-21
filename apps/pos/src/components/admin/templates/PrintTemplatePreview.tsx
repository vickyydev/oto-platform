import { useEffect, useRef, useState } from 'react';
import { Loader2 } from 'lucide-react';
import type { PrintTemplate } from '@/types';
import { printApi } from '@/api/platform';
import { ApiError } from '@/api/client';

interface PrintTemplatePreviewProps {
  /** The draft on the editor's left-hand side, saved or not. */
  template: PrintTemplate;
  /** True when this row is on the platform and can really be rendered. */
  live: boolean;
  /** Which till to lay the sample out for; null lets the branch decide. */
  stationId?: string | null;
}

/**
 * The printed sample, drawn by the renderer that drives the printer.
 *
 * This used to be a faux printout in HTML — a receipt-shaped `div` with its
 * own barcode, its own QR, its own sample content and its own idea of line
 * breaking. It looked right and it was not: nothing about it came from
 * `@oto/print`, so the one question a preview exists to answer — will what
 * comes off the paper look like this — it could not answer, and the editor's
 * Test print button was comparing against a drawing rather than a proof.
 *
 * `@oto/print` runs on Node (bundled font files, `node:zlib`) and cannot be
 * imported into a browser bundle, so the picture is rendered by the platform
 * and fetched. **That is the whole reason this is an image.** There is now one
 * path from a template to dots, and both the preview and the paper are on it.
 *
 * WHAT IT COSTS, AND WHAT IS DONE ABOUT IT. A render is a round trip, and a
 * template editor is a screen somebody types into. So it asks only once typing
 * stops (`DEBOUNCE_MS`), aborts a render that an edit has already overtaken,
 * and keeps the last picture on screen while the next one is drawn — the panel
 * never blanks between keystrokes.
 */
const DEBOUNCE_MS = 350;

export function PrintTemplatePreview({ template, live, stationId }: PrintTemplatePreviewProps) {
  const [src, setSrc] = useState<string | null>(null);
  const [drawing, setDrawing] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  /** The object URL currently on screen, so it can be released when replaced. */
  const held = useRef<string | null>(null);

  /**
   * The request body, as one string.
   *
   * It is both what is sent and what the effect below depends on, so a
   * re-render that changed nothing the printer would draw — the template's
   * name, a parent's state — does not spend a round trip. The type is not in
   * it: which printout this is comes from the saved row and the editor cannot
   * change it.
   */
  const draft = JSON.stringify({
    showLogo: template.showLogo,
    headerText: template.headerText ?? null,
    footerText: template.footerText ?? null,
    fields: template.fields,
    stationId: stationId ?? null,
  });

  useEffect(() => {
    if (!live) {
      if (held.current) URL.revokeObjectURL(held.current);
      held.current = null;
      setSrc(null);
      setFailed(null);
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => {
      setDrawing(true);
      void (async () => {
        try {
          const blob = await printApi.previewPng(
            template.id,
            JSON.parse(draft) as Parameters<typeof printApi.previewPng>[1],
            controller.signal,
          );
          if (controller.signal.aborted) return;
          const url = URL.createObjectURL(blob);
          if (held.current) URL.revokeObjectURL(held.current);
          held.current = url;
          setSrc(url);
          setFailed(null);
        } catch (err) {
          if (controller.signal.aborted) return;
          setFailed(err instanceof ApiError ? err.message : 'The preview could not be drawn.');
        } finally {
          if (!controller.signal.aborted) setDrawing(false);
        }
      })();
    }, DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [draft, live, template.id]);

  // Release the last picture when the editor closes.
  useEffect(
    () => () => {
      if (held.current) URL.revokeObjectURL(held.current);
      held.current = null;
    },
    [],
  );

  return (
    <div className="mx-auto w-[280px] max-w-full rounded-lg bg-stone-50 p-2 shadow-xl shadow-black/40 ring-1 ring-black/10">
      {src ? (
        <img
          src={src}
          alt={`${template.name}, as it prints`}
          /* One bit per pixel at 203 dpi. Smoothing it turns crisp thermal
             dots into grey mush, so the browser is told not to interpolate —
             the same treatment the Console's printout panel gives it. */
          className={`block w-full h-auto [image-rendering:pixelated] transition-opacity ${
            drawing ? 'opacity-60' : ''
          }`}
        />
      ) : (
        <div className="flex min-h-[180px] items-center justify-center px-4 py-8 text-center text-[11px] leading-snug text-stone-500">
          {!live ? (
            'Connect this branch to the platform to see this printout drawn.'
          ) : failed ? (
            failed
          ) : (
            <span className="inline-flex items-center gap-2">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              Drawing this printout…
            </span>
          )}
        </div>
      )}
      {src && failed && (
        <div className="px-1 pt-1 text-[11px] text-stone-500">{failed}</div>
      )}
    </div>
  );
}
