/**
 * The only path from a layout to dots.
 *
 * This is deliberately the *single* drawing function in the package. The
 * ESC/POS emitter slices the bitmap it returns into `GS v 0` bands, the TSPL
 * emitter inverts it into one `BITMAP`, and the preview wraps it in a PNG.
 * There is no second renderer and no HTML preview, so the picture the admin
 * panel shows and the dots the head lays down cannot drift apart.
 *
 * Two tests hold that, and it is worth being exact about which holds what,
 * because a comment claiming a guarantee is not one:
 *
 *  - `test/single-renderer.test.ts` reads the source and fails if any module
 *    other than this one imports `raster/fill`, which is the only code that
 *    turns outlines into coverage. That is the structural half: a second
 *    drawing path cannot be added without failing the build.
 *  - `test/emit.test.ts` parses the emitted ESC/POS and TSPL back into a
 *    bitmap and asserts it is byte-identical to the one `render` produced.
 *    That is the transport half: the emitters carry these dots faithfully. It
 *    would stay green if a second rasteriser appeared, which is why the first
 *    test exists.
 */

import { CoverageCanvas, glyphPolygons, warningTrianglePolygons } from './raster/fill';
import { Bitmap1 } from './raster/bitmap';
import type { LayoutItem, LayoutModel } from './layout/layout';

export function render(model: LayoutModel): Bitmap1 {
  const height = Math.max(1, Math.ceil(model.heightDots));
  const canvas = new CoverageCanvas(model.widthDots, height);
  const inverts: LayoutItem[] = [];
  const images: LayoutItem[] = [];

  for (const item of model.items) {
    switch (item.k) {
      case 'text': {
        for (const g of item.shaped.glyphs) {
          if (g.tofu) {
            // A character no bundled face covers. Drawn here rather than
            // looked up, for the same reason as the warning triangle: it is a
            // rectangle, and a rectangle does not need a font.
            const t = Math.max(1, Math.round(g.sizeDots / 16));
            const left = item.x + g.x;
            const top = item.baselineY - g.tofu.heightDots;
            const { widthDots: w, heightDots: h } = g.tofu;
            canvas.fillRect(left, top, w, t);
            canvas.fillRect(left, top + h - t, w, t);
            canvas.fillRect(left, top, t, h);
            canvas.fillRect(left + w - t, top, t, h);
            continue;
          }
          if (!g.font) continue;
          const outline = g.font.sfnt.glyph(g.gid);
          if (outline.contours.length === 0) continue;
          canvas.fillPolygons(
            glyphPolygons(
              outline,
              g.font.sfnt.unitsPerEm,
              g.sizeDots,
              item.x + g.x,
              item.baselineY,
              g.y,
            ),
          );
        }
        break;
      }
      case 'rect':
        canvas.fillRect(item.x, item.y, item.w, item.h);
        break;
      case 'stroke': {
        const t = item.thickness;
        canvas.fillRect(item.x, item.y, item.w, t);
        canvas.fillRect(item.x, item.y + item.h - t, item.w, t);
        canvas.fillRect(item.x, item.y, t, item.h);
        canvas.fillRect(item.x + item.w - t, item.y, t, item.h);
        break;
      }
      case 'dashes': {
        // The prototype's `Divider` is a dashed rule; 4 dots on, 4 off reads as
        // a dashed line at 203 dpi without wasting head energy.
        for (let dx = 0; dx + 4 <= item.w; dx += 8) {
          canvas.fillRect(item.x + dx, item.y, 4, item.thickness);
        }
        break;
      }
      case 'warning':
        canvas.fillPolygons(warningTrianglePolygons(item.x, item.y, item.size));
        break;
      case 'qr': {
        const { matrix, moduleDots } = item;
        for (let my = 0; my < matrix.size; my++) {
          for (let mx = 0; mx < matrix.size; mx++) {
            if (!matrix.get(mx, my)) continue;
            canvas.fillRect(
              item.x + mx * moduleDots,
              item.y + my * moduleDots,
              moduleDots,
              moduleDots,
            );
          }
        }
        break;
      }
      case 'barcode': {
        let run = 0;
        while (run < item.modules.length) {
          if (!item.modules[run]) {
            run++;
            continue;
          }
          let end = run;
          while (end < item.modules.length && item.modules[end]) end++;
          canvas.fillRect(
            item.x + run * item.moduleDots,
            item.y,
            (end - run) * item.moduleDots,
            item.heightDots,
          );
          run = end;
        }
        break;
      }
      case 'image':
        images.push(item);
        break;
      case 'invert':
        inverts.push(item);
        break;
    }
  }

  const bmp = canvas.toBitmap();
  // Images are already 1 bpp; blitting them after the threshold keeps a
  // halftoned logo exactly as the halftoner left it.
  for (const item of images) {
    if (item.k === 'image') bmp.blit(item.bitmap, item.x, item.y);
  }
  // Inversion is a post-threshold operation — a white-on-black badge is dots
  // flipped, not coverage subtracted.
  for (const item of inverts) {
    if (item.k === 'invert') bmp.invertRect(item.x, item.y, item.w, item.h);
  }
  return bmp;
}
