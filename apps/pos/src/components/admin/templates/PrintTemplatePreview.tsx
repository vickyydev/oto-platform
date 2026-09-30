import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Loader2 } from 'lucide-react';
import type { PrintTemplate } from '@/types';
import { ApiError } from '@/api/client';
import { templatesApi } from './templatesApi';
import { paperLabel, previewRequest } from './templateDraft';
import { DEFAULT_PREVIEW_SAMPLE, type PreviewSampleId } from './previewSamples';

interface PrintTemplatePreviewProps {
  /** The draft on the editor's left-hand side, saved or not. */
  template: PrintTemplate;
  /** True when this row is on the platform and can really be rendered. */
  live: boolean;
  /** Which till to lay the sample out for; null lets the branch decide. */
  stationId?: string | null;
  /** Which of the platform's sample scenarios to fill it with (SCRUM-472). */
  sample?: PreviewSampleId;
  /**
   * The frame's lower toolbar (SCRUM-472): the editor's Test print, attached
   * to the picture it would put on paper rather than to the form.
   */
  footer?: ReactNode;
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

/**
 * How large a printer dot is drawn, in CSS pixels per dot (SCRUM-470).
 *
 * The frame used to be 280px wide, which showed a 576-dot receipt at about
 * 0.46 — a scale that lines up with no grid, so a one-dot rule (the line
 * under a total, the thin bars of a barcode) fell between two screen pixels
 * and was not drawn at all. Fit is exactly a half: two dots per CSS pixel,
 * one per device pixel on a 2x screen, every row on the same footing. 100%
 * puts one CSS pixel on every dot and 200% four, for the person checking
 * that a rule or a barcode is really there.
 */
type Zoom = 'fit' | 'full' | 'double';
const ZOOMS: ReadonlyArray<{ id: Zoom; label: string; scale: number; title: string }> = [
  { id: 'fit', label: 'Fit', scale: 0.5, title: 'Half size — two dots per pixel' },
  { id: 'full', label: '100%', scale: 1, title: 'Actual size — one pixel per dot' },
  { id: 'double', label: '200%', scale: 2, title: 'Double size — four pixels per dot' },
];
const FIT_SCALE = 0.5;

/** A rendered picture and its width in dots, which is its width in pixels. */
interface Picture {
  url: string;
  dots: number;
}

/**
 * Fetch, measure and hold one rendered picture, re-asking when the request
 * changes. `active` false holds off without clearing (a thumbnail not yet
 * scrolled into view); `live` false clears (a row the platform does not hold).
 */
function usePreviewPicture(
  templateId: string,
  request: string,
  live: boolean,
  active: boolean,
  debounceMs: number,
) {
  const [picture, setPicture] = useState<Picture | null>(null);
  const [drawing, setDrawing] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  /** The object URL currently on screen, so it can be released when replaced. */
  const held = useRef<string | null>(null);

  useEffect(() => {
    if (!live) {
      if (held.current) URL.revokeObjectURL(held.current);
      held.current = null;
      setPicture(null);
      setFailed(null);
      return;
    }
    if (!active) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      setDrawing(true);
      void (async () => {
        try {
          const blob = await templatesApi.previewPng(templateId, request, controller.signal);
          if (controller.signal.aborted) return;
          const url = URL.createObjectURL(blob);
          let dots: number;
          try {
            dots = await measure(url);
          } catch (err) {
            URL.revokeObjectURL(url);
            throw err;
          }
          if (controller.signal.aborted) {
            URL.revokeObjectURL(url);
            return;
          }
          if (held.current) URL.revokeObjectURL(held.current);
          held.current = url;
          setPicture({ url, dots });
          setFailed(null);
        } catch (err) {
          if (controller.signal.aborted) return;
          setFailed(err instanceof ApiError ? err.message : 'The preview could not be drawn.');
        } finally {
          if (!controller.signal.aborted) setDrawing(false);
        }
      })();
    }, debounceMs);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [request, live, active, templateId, debounceMs]);

  // Release the last picture when the component goes.
  useEffect(
    () => () => {
      if (held.current) URL.revokeObjectURL(held.current);
      held.current = null;
    },
    [],
  );

  return { picture, drawing, failed };
}

export function PrintTemplatePreview({
  template,
  live,
  stationId,
  sample = DEFAULT_PREVIEW_SAMPLE,
  footer,
}: PrintTemplatePreviewProps) {
  const [zoom, setZoom] = useState<Zoom>('fit');
  const request = previewRequest(template, stationId ?? null, sample);
  const { picture, drawing, failed } = usePreviewPicture(
    template.id,
    request,
    live,
    true,
    DEBOUNCE_MS,
  );

  const scale = ZOOMS.find((z) => z.id === zoom)?.scale ?? FIT_SCALE;

  return (
    <div className="mx-auto w-fit min-w-[280px] max-w-full rounded-lg bg-stone-50 p-2 shadow-xl shadow-black/40 ring-1 ring-black/10">
      {/* The frame's toolbar: the paper this is drawn for (SCRUM-472) beside
          the zoom (SCRUM-470). Both sit above the scrolling area rather than
          over the paper, so neither ever covers a header. */}
      <div className="mb-1.5 flex items-center justify-between gap-2">
        {picture ? (
          <span
            className="rounded-full bg-stone-200/70 px-2 py-0.5 text-[11px] font-semibold tabular-nums text-stone-600"
            title={`${picture.dots} dots across`}
          >
            {paperLabel(template.type, picture.dots)}
          </span>
        ) : (
          <span />
        )}
        <div
          role="group"
          aria-label="Preview zoom"
          className="inline-flex rounded-full bg-stone-200/70 p-0.5"
        >
          {ZOOMS.map((z) => (
            <button
              key={z.id}
              type="button"
              aria-pressed={zoom === z.id}
              title={z.title}
              onClick={() => setZoom(z.id)}
              className={`rounded-full px-2 py-0.5 text-[11px] font-semibold tabular-nums transition-colors ${
                zoom === z.id
                  ? 'bg-white text-stone-800 shadow-sm'
                  : 'text-stone-500 hover:text-stone-700'
              }`}
            >
              {z.label}
            </button>
          ))}
        </div>
      </div>
      {/* The paper scrolls inside the frame at 100% and 200%, in both
          directions, rather than the column growing to fit it. */}
      <div className="max-h-[70vh] overflow-auto">
        {picture ? (
          <img
            src={picture.url}
            alt={`${template.name}, as it prints`}
            /* One bit per pixel at 203 dpi. Smoothing it turns crisp thermal
               dots into grey mush, so the browser is told not to interpolate —
               the same treatment the Console's printout panel gives it. The
               width is the picture's own dot count at the chosen scale;
               `max-w-none` because the stylesheet's reset caps every image at
               its column, which would fold 100% and 200% back into Fit. */
            style={{ width: picture.dots * scale }}
            className={`mx-auto block h-auto max-w-none [image-rendering:pixelated] transition-opacity ${
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
      </div>
      {picture && failed && (
        <div className="px-1 pt-1 text-[11px] text-stone-500">{failed}</div>
      )}
      {footer && <div className="mt-2 border-t border-stone-200 pt-2">{footer}</div>}
    </div>
  );
}

/**
 * A template card's thumbnail (SCRUM-472): the SAVED template's printout, the
 * Test print's own sample, drawn by the same renderer at Fit — two dots per
 * pixel, the one downscale that keeps a one-dot rule — and cropped to the head
 * of the paper rather than shrunk to fit the card, because shrinking further
 * is exactly the blur SCRUM-470 removed.
 *
 * Asked for only once the card scrolls into view, so opening the list costs
 * the renders somebody can see and no more. It reports the picture's width in
 * dots so the card can name the paper.
 */
export function PrintTemplateThumbnail({
  template,
  live,
  stationId,
  onDots,
}: {
  template: PrintTemplate;
  live: boolean;
  stationId?: string | null;
  onDots?: (dots: number) => void;
}) {
  const box = useRef<HTMLDivElement | null>(null);
  const [seen, setSeen] = useState(false);

  useEffect(() => {
    const node = box.current;
    if (!node || seen) return;
    if (typeof IntersectionObserver === 'undefined') {
      setSeen(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setSeen(true);
          observer.disconnect();
        }
      },
      { rootMargin: '120px' },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [seen]);

  const request = previewRequest(template, stationId ?? null);
  const { picture, failed } = usePreviewPicture(template.id, request, live, seen, 0);

  useEffect(() => {
    if (picture) onDots?.(picture.dots);
  }, [picture, onDots]);

  return (
    <div
      ref={box}
      className="relative flex h-36 justify-center overflow-hidden rounded-xl bg-stone-100 pt-3"
    >
      {picture ? (
        <img
          src={picture.url}
          alt=""
          aria-hidden
          loading="lazy"
          style={{ width: picture.dots * FIT_SCALE }}
          className="block h-auto max-w-none self-start rounded-sm bg-white shadow-md shadow-black/15 ring-1 ring-black/5 [image-rendering:pixelated]"
        />
      ) : (
        <div className="flex items-center text-[11px] text-stone-400">
          {!live ? 'No preview' : failed ? 'Preview unavailable' : <Loader2 className="h-4 w-4 animate-spin" />}
        </div>
      )}
      {/* The paper runs on past the card; a fade says so rather than a hard cut. */}
      <div className="pointer-events-none absolute inset-x-0 bottom-0 h-10 bg-gradient-to-t from-stone-100 to-transparent" />
    </div>
  );
}

/**
 * The picture's width in dots, read before it is shown.
 *
 * The `<img>` above is sized from it, so a picture is laid out at its zoom on
 * the first frame it appears rather than at natural size and then snapped —
 * and a 58mm printer's 384-dot slip is never first drawn as wide as an 80mm
 * receipt. Decoding it here also means the `<img>` shows it from cache, with
 * no blank between the old picture and the new one.
 */
function measure(url: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = new Image();
    probe.onload = () => resolve(probe.naturalWidth);
    probe.onerror = () => reject(new Error('The preview picture could not be decoded.'));
    probe.src = url;
  });
}
