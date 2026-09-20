/**
 * `@oto/print` — template to layout model to ESC/POS or TSPL2 bytes.
 *
 * The pure part of the print pipeline. It owns no socket, no clock and no
 * network, and no filesystem beyond the bundled fonts, which is what lets the
 * same input produce the same device bytes on a Raspberry Pi in the park and on
 * a cloud instance — and is the reason this is a package rather than a function
 * inside the box agent.
 *
 * **This package runs on Node only.** It reads the bundled faces with
 * `node:fs` through an `import.meta.url` path (`fonts/stack.ts`) and compresses
 * the preview PNG with `node:zlib` (`emit/preview.ts`). It therefore cannot be
 * imported by the admin console or by any browser bundle: the console shows a
 * preview by asking the API or the box for the PNG, never by rendering one
 * itself. That is a constraint on the rest of S2-06, not an accident — see
 * `README.md` in this package for what it means for the test-print flow and for
 * the box agent's build.
 *
 * What lives elsewhere: the `print_job` table, the adapters that open TCP 9100,
 * the simulators, the admin panel and the retry queue (the rest of S2-06); the
 * device record and its addresses (S2-04); sale-specific jobs and reprints
 * (S2-11); booth voucher content (S2-07a).
 */

import type { DeviceProfile, Finish, PrintDocument } from './document';
import type { Bitmap1 } from './raster/bitmap';
import { layoutDocument } from './layout/layout';
import type { LayoutModel, LayoutOptions } from './layout/layout';
import { render } from './render';
import { emitEscpos } from './emit/escpos';
import { emitTspl } from './emit/tspl';
import { previewPng } from './emit/preview';
import {
  TEMPLATE_FOR_KIND,
  resolveTemplate,
} from './templates/model';
import type { PrintKind, PrintTemplate } from './templates/model';
import { buildReceipt } from './templates/receipt';
import { buildPrepTicket } from './templates/prep';
import { buildBand } from './templates/band';
import { buildCreditVoucher, buildItemVoucher } from './templates/voucher';
import { buildBoothVoucher } from './templates/booth';
import { buildTestPage } from './templates/test-page';
import type {
  BandData,
  BoothVoucherData,
  CreditVoucherData,
  ItemVoucherData,
  PrepTicketData,
  ReceiptData,
  TestPageData,
} from './templates/data';

export * from './document';
export * from './devices';
export * from './templates/model';
export type * from './templates/data';
export { Bitmap1 } from './raster/bitmap';
export { layoutDocument, resolveCellWidths } from './layout/layout';
export type { LayoutItem, LayoutModel, LayoutOptions } from './layout/layout';
export { render } from './render';
export { previewPng } from './emit/preview';
export {
  ESCPOS,
  DEFAULT_BAND_ROWS,
  DEFAULT_FEED_DOTS,
  decodeStatus,
  drawerKick,
  emitEscpos,
  feedDots,
  feedLines,
  rasterBand,
  statusQuery,
} from './emit/escpos';
export type { PrinterStatus } from './emit/escpos';
export { TSPL, bitmapCommand, decodeLabelStatus, emitTspl } from './emit/tspl';
export type { LabelStatus } from './emit/tspl';
export { encodeQr } from './codes/qr';
export type { QrEcc, QrMatrix } from './codes/qr';
export { encodeCode128 } from './codes/code128';
export { shapeText, measureText, describeCodePoint, tofuBox } from './fonts/shape';
export type { ShapedText, PlacedGlyph, TofuBox } from './fonts/shape';
export { fontStack, bundledFontIds } from './fonts/stack';
export type { FontStack, FontWeight, LoadedFont } from './fonts/stack';
export { wrapText, wrapTextDetailed, breakOpportunities } from './layout/wrap';
export type { WrappedText, WrapOptions } from './layout/wrap';

/** What this renderer is, printed on the test page and stamped on a fixture. */
export const RENDERER_VERSION = 'oto-print/0.1.0';

/** One job to print. `kind` picks the builder; `data` is that builder's input. */
export type PrintJob =
  | { kind: 'receipt'; data: ReceiptData }
  | { kind: 'kitchen_ticket'; data: PrepTicketData }
  | { kind: 'bar_ticket'; data: PrepTicketData }
  | { kind: 'kids_wristband'; data: BandData }
  | { kind: 'adult_wristband'; data: BandData }
  | { kind: 'credit_voucher'; data: CreditVoucherData }
  | { kind: 'item_voucher'; data: ItemVoucherData }
  | { kind: 'booth_voucher'; data: BoothVoucherData }
  | { kind: 'test_page'; data: TestPageData };

export interface RenderJobOptions extends LayoutOptions {
  device: DeviceProfile;
  /**
   * The branch's templates. Lookup is by type and takes the first match, as
   * `catalogStore.getPrintTemplate` does; an empty list means every section
   * prints, which is what a freshly created branch does today.
   */
  templates?: readonly PrintTemplate[];
  /** Drawer kick, copies and cut, overriding the template's own finish. */
  finish?: Partial<Finish>;
}

export interface RenderedJob {
  kind: PrintKind;
  /** The template that was applied, if the branch has one for this kind. */
  template?: PrintTemplate;
  document: PrintDocument;
  layout: LayoutModel;
  bitmap: Bitmap1;
  /** ESC/POS or TSPL2, complete and ready for one TCP write. */
  bytes: Uint8Array;
  /**
   * Problems worth telling a human about: a line wider than its column, text
   * that had to be cut mid-word to fit, a character no bundled font covers
   * (printed as a box), a band whose content is longer than the stock, a QR
   * that had to shrink.
   *
   * **Never thrown, and nothing here stops the job.** A receipt with a note is
   * better than no receipt at a till, so every one of these degrades and
   * reports. The caller is expected to surface them — the print-job row and the
   * Box log drawer are the two places in S2-06 that should carry them, because
   * a receipt quietly missing a guest's name is its own kind of failure.
   */
  overflow: string[];
}

/** Resolve the template, build the document, lay it out, render and emit. */
export function renderJob(job: PrintJob, options: RenderJobOptions): RenderedJob {
  const { device, templates = [] } = options;
  const type = TEMPLATE_FOR_KIND[job.kind];
  const template = type ? resolveTemplate(templates, type) : undefined;

  const document = buildDocument(job, template, device);
  if (options.finish) Object.assign(document.finish, options.finish);

  const layout = layoutDocument(document, options);
  const bitmap = render(layout);
  const bytes =
    device.language === 'tspl2'
      ? emitTspl(bitmap, { device, finish: document.finish })
      : emitEscpos(bitmap, { device, finish: document.finish });

  return { kind: job.kind, template, document, layout, bitmap, bytes, overflow: layout.overflow };
}

/** The document only, for a caller that wants to inspect or adjust it first. */
export function buildDocument(
  job: PrintJob,
  template: PrintTemplate | undefined,
  device: DeviceProfile,
): PrintDocument {
  switch (job.kind) {
    case 'receipt':
      return buildReceipt({ template, data: job.data, device });
    case 'kitchen_ticket':
      return buildPrepTicket({ template, type: 'kitchen_ticket', data: job.data, device });
    case 'bar_ticket':
      return buildPrepTicket({ template, type: 'bar_ticket', data: job.data, device });
    case 'kids_wristband':
      return buildBand({ template, type: 'kids_wristband', data: job.data, device });
    case 'adult_wristband':
      return buildBand({ template, type: 'adult_wristband', data: job.data, device });
    case 'credit_voucher':
      return buildCreditVoucher({ template, data: job.data, device });
    case 'item_voucher':
      return buildItemVoucher({ template, data: job.data, device });
    case 'booth_voucher':
      return buildBoothVoucher({ data: job.data, device });
    case 'test_page':
      return buildTestPage({ data: job.data, device });
  }
}

/** The PNG the admin panel and the simulator both show. */
export function renderPreviewPng(job: PrintJob, options: RenderJobOptions): Uint8Array {
  return previewPng(renderJob(job, options).bitmap);
}

/**
 * A JSON-serialisable digest of a layout: every primitive as an integer
 * rectangle, glyph arrays dropped. This is the third fixture artefact next to
 * the PNG and the bytes, and the thing to diff when a fixture moves by a dot.
 */
export function layoutSummary(model: LayoutModel): unknown {
  return {
    widthDots: model.widthDots,
    heightDots: model.heightDots,
    overflow: model.overflow,
    items: model.items.map((item) => {
      switch (item.k) {
        case 'text':
          return {
            k: item.k,
            x: item.x,
            baselineY: item.baselineY,
            w: item.widthDots,
            sizeDots: item.style.sizeDots,
            weight: item.style.weight,
            text: item.text,
          };
        case 'qr':
          return {
            k: item.k,
            x: item.x,
            y: item.y,
            moduleDots: item.moduleDots,
            modules: item.matrix.size,
            version: item.matrix.version,
            ecc: item.matrix.ecc,
          };
        case 'barcode':
          return {
            k: item.k,
            x: item.x,
            y: item.y,
            moduleDots: item.moduleDots,
            heightDots: item.heightDots,
            bars: item.modules.length,
          };
        case 'image':
          return { k: item.k, x: item.x, y: item.y, w: item.bitmap.width, h: item.bitmap.height };
        case 'warning':
          return { k: item.k, x: item.x, y: item.y, size: item.size };
        case 'dashes':
          return { k: item.k, x: item.x, y: item.y, w: item.w, t: item.thickness };
        default:
          return { k: item.k, x: item.x, y: item.y, w: item.w, h: item.h };
      }
    }),
  };
}
