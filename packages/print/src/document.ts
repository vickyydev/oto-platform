/**
 * `PrintDocument` — the declarative middle of the pipeline.
 *
 *   resolve : (template, data, device) -> PrintDocument
 *   layout  : (PrintDocument, fonts)   -> LayoutModel
 *   render  : (LayoutModel)            -> Bitmap1
 *   emit    : (Bitmap1, device)        -> Uint8Array   (ESC/POS or TSPL2)
 *   preview : (Bitmap1)                -> PNG bytes
 *
 * Every block here exists because the prototype's preview draws it: the dashed
 * `Divider` is `rule`, the money rows are `columns`, the boxed allergy line is
 * `frame`, the DROP-OFF pill is `invert`, the band's scan mark is `barcode` and
 * `qr`.
 *
 * Nothing in this package reads a clock, a locale or the network. Dates, times
 * and money arrive already formatted — money from `formatTHB` in `@oto/shared`,
 * times from the caller's branch-timezone helpers. That is what makes the
 * fixtures byte-stable and what lets the same code run on a box with no RTC.
 */

import type { Bitmap1 } from './raster/bitmap';
import type { FontWeight } from './fonts/stack';
import type { QrEcc } from './codes/qr';

export type Align = 'left' | 'center' | 'right';

export interface TextStyle {
  /** Em size in dots. 203 dpi: 20 is small print, 25 body, 34 a heading. */
  sizeDots: number;
  weight: FontWeight;
  /** Extra dots between glyphs; the prototype's tracked small caps. */
  tracking?: number;
}

export interface InlineRun {
  text: string;
  style?: Partial<TextStyle>;
}

export interface Cell {
  runs: InlineRun[];
  align: Align;
  style: TextStyle;
  /** Fixed width in dots. Omit to share what the fixed cells leave. */
  widthDots?: number;
  /** Relative share of the remaining width; defaults to 1. */
  flex?: number;
}

export interface DrawerPulse {
  /** 0 for drawer pin 2, 1 for pin 5 — `ESC p m t1 t2`. */
  pin: 0 | 1;
  onMs: number;
  offMs: number;
}

export type Block =
  | { k: 'text'; runs: InlineRun[]; align: Align; style: TextStyle; leading?: number }
  | { k: 'columns'; cells: Cell[]; gapDots?: number }
  | { k: 'rule'; style: 'solid' | 'dashed'; thicknessDots?: number }
  | { k: 'space'; dots: number }
  | {
      k: 'image';
      source: Bitmap1;
      align: Align;
      maxWidthDots?: number;
      halftone: 'threshold' | 'atkinson';
    }
  | {
      k: 'barcode';
      symbology: 'code128';
      value: string;
      heightDots: number;
      moduleDots: number;
      hri: 'none' | 'below';
      align: Align;
    }
  | {
      k: 'qr';
      value: string;
      moduleDots: number;
      ecc: QrEcc;
      align: Align;
      caption?: InlineRun[];
    }
  /**
   * A warning triangle followed by text, on one hanging indent.
   *
   * Its own block because U+26A0 is not in Noto Sans — it lives in Noto Sans
   * Symbols — and the prototype already disagrees with itself about it: the
   * routing string starts with the character (`printRouting.tsx:206`) while the
   * preview draws an icon instead (`PrintTemplatePreview.tsx:194`). Drawing it
   * as vectors settles that without adding a fourth font.
   */
  | { k: 'warning'; sizeDots: number; runs: InlineRun[]; style: TextStyle }
  | { k: 'frame'; border: 'box'; padDots: number; children: Block[] }
  | { k: 'invert'; children: Block[]; padDots?: number; inline?: boolean }
  | { k: 'group'; children: Block[] };

export interface Finish {
  /**
   * Dots to feed before the cut, clearing the blade. Emitted as `ESC J`, which
   * feeds dots; `ESC d` feeds lines and is not this. At 203 dpi, 96 dots is
   * about 12 mm.
   */
  feedDots?: number;
  cut?: 'partial' | 'none';
  drawerKick?: DrawerPulse;
  copies?: number;
}

export interface PrintMedia {
  kind: 'receipt' | 'label';
  widthDots: number;
  /** Required for a label: a band is a fixed die-cut and cannot grow. */
  heightDots?: number;
  dpi: 203;
}

export interface PrintDocument {
  media: PrintMedia;
  blocks: Block[];
  finish: Finish;
  /** Side margin in dots; 0 on a band, a few dots on a receipt. */
  paddingDots?: number;
}

/**
 * One physical printer, as the renderer needs to know it.
 *
 * `widthDots` is a property of the *device*, never of the template. The XP-80
 * family ships as 576 or 512 dots per line and `GS v 0` data wider than the
 * print area is discarded silently — a receipt laid out at 576 and sent to a
 * 512-dot unit loses its right-hand 8 mm, which is where the price column
 * sits, with no error anywhere. So layout is re-run per device and a rendered
 * document is never cached against a template alone.
 */
export interface DeviceProfile {
  id: string;
  label: string;
  /** From the self-test page, not the Windows driver name (D6). */
  model: string;
  language: 'escpos' | 'tspl2';
  widthDots: number;
  dpi: 203;
  /** `GS v 0` slice height. 128 rows keeps a job inside the input buffer. */
  bandRows?: number;
  hasCutter?: boolean;
  hasDrawer?: boolean;
  /** Label media, for TSPL only. Measure the park's band stock. */
  media?: {
    widthMm: number;
    lengthMm: number;
    gapMm: number;
    sensing: 'gap' | 'bline';
  };
  /** TSPL darkness 0-15 (factory 8) and speed in ips (factory 5). */
  density?: number;
  speed?: number;
  /** `SET RESPONSE ON` is firmware >= V7.09 and unconfirmed on these units. */
  perLabelAck?: boolean;
}
