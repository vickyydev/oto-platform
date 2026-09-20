/**
 * A TrueType reader, cut down to what a 203 dpi thermal head needs.
 *
 * Why we parse fonts ourselves rather than lean on a shaping library: the
 * renderer has to produce the same dots on a Raspberry Pi in the park and on a
 * cloud instance, with no node-gyp step and no WASM to load, so the usual
 * candidates (node-canvas, skia, harfbuzzjs) are out. What is left is the file
 * format, and the file format is small once you only need `glyf` outlines,
 * `cmap` coverage and the two OpenType layout tables Thai actually uses.
 *
 * Only what is used is implemented. Where a table has formats we never meet in
 * the bundled Noto faces, the reader says so loudly instead of guessing: a
 * silently mis-read font shows up as a receipt with the money missing, which is
 * exactly the failure this package exists to prevent.
 */

/** Big-endian cursor over a font's bytes. */
export class Reader {
  readonly view: DataView;
  pos = 0;

  constructor(
    readonly data: Uint8Array,
    offset = 0,
  ) {
    this.view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    this.pos = offset;
  }

  seek(pos: number): this {
    this.pos = pos;
    return this;
  }

  u8(): number {
    return this.view.getUint8(this.pos++);
  }

  u16(): number {
    const v = this.view.getUint16(this.pos);
    this.pos += 2;
    return v;
  }

  i16(): number {
    const v = this.view.getInt16(this.pos);
    this.pos += 2;
    return v;
  }

  u32(): number {
    const v = this.view.getUint32(this.pos);
    this.pos += 4;
    return v;
  }

  i32(): number {
    const v = this.view.getInt32(this.pos);
    this.pos += 4;
    return v;
  }

  /** F2Dot14 — the fixed-point form component scales and variation axes use. */
  f2dot14(): number {
    return this.i16() / 16384;
  }

  tag(): string {
    let s = '';
    for (let i = 0; i < 4; i++) s += String.fromCharCode(this.u8());
    return s;
  }

  u16At(pos: number): number {
    return this.view.getUint16(pos);
  }

  u32At(pos: number): number {
    return this.view.getUint32(pos);
  }
}

export interface TableRecord {
  offset: number;
  length: number;
}

export interface FontHead {
  unitsPerEm: number;
  indexToLocFormat: number;
  xMin: number;
  yMin: number;
  xMax: number;
  yMax: number;
}

/** A parsed font file: tables located, the hot ones decoded eagerly. */
export class SfntFont {
  readonly tables = new Map<string, TableRecord>();
  readonly head: FontHead;
  readonly numGlyphs: number;
  readonly unitsPerEm: number;
  readonly ascender: number;
  readonly descender: number;
  readonly lineGap: number;

  private readonly loca: Uint32Array;
  private readonly advances: Uint16Array;
  private readonly cmapUnicode = new Map<number, number>();
  private readonly glyfRec: TableRecord | undefined;
  private readonly glyphCache = new Map<number, Glyph>();

  constructor(
    readonly data: Uint8Array,
    readonly familyName: string,
  ) {
    const r = new Reader(data);
    const version = r.u32();
    if (version === 0x74746366) {
      throw new Error('TrueType collections (.ttc) are not supported; extract a single face first');
    }
    if (version !== 0x00010000 && version !== 0x4f54544f) {
      throw new Error(`not a TrueType/OpenType file (sfnt version 0x${version.toString(16)})`);
    }
    if (version === 0x4f54544f) {
      // CFF outlines. Noto Sans, Noto Sans Thai and the bundled SC subset are
      // all glyf-flavoured; a CFF face would need a charstring interpreter we
      // have no reason to carry.
      throw new Error(`${familyName}: CFF (OTF) outlines are not supported, use the TTF build`);
    }
    const numTables = r.u16();
    r.pos += 6;
    for (let i = 0; i < numTables; i++) {
      const tag = r.tag();
      r.pos += 4; // checksum
      const offset = r.u32();
      const length = r.u32();
      this.tables.set(tag, { offset, length });
    }

    const head = this.require('head');
    r.seek(head.offset + 18);
    const unitsPerEm = r.u16();
    r.seek(head.offset + 36);
    const xMin = r.i16();
    const yMin = r.i16();
    const xMax = r.i16();
    const yMax = r.i16();
    r.seek(head.offset + 50);
    const indexToLocFormat = r.i16();
    this.head = { unitsPerEm, indexToLocFormat, xMin, yMin, xMax, yMax };
    this.unitsPerEm = unitsPerEm;

    const maxp = this.require('maxp');
    this.numGlyphs = r.seek(maxp.offset + 4).u16();

    const hhea = this.require('hhea');
    r.seek(hhea.offset + 4);
    this.ascender = r.i16();
    this.descender = r.i16();
    this.lineGap = r.i16();
    const numberOfHMetrics = r.seek(hhea.offset + 34).u16();

    this.advances = this.readHmtx(numberOfHMetrics);
    this.loca = this.readLoca();
    this.glyfRec = this.tables.get('glyf');
    this.readCmap();
  }

  private require(tag: string): TableRecord {
    const t = this.tables.get(tag);
    if (!t) throw new Error(`${this.familyName}: required table '${tag}' is missing`);
    return t;
  }

  table(tag: string): TableRecord | undefined {
    return this.tables.get(tag);
  }

  private readHmtx(numberOfHMetrics: number): Uint16Array {
    const hmtx = this.require('hmtx');
    const out = new Uint16Array(this.numGlyphs);
    const r = new Reader(this.data, hmtx.offset);
    let last = 0;
    for (let i = 0; i < this.numGlyphs; i++) {
      if (i < numberOfHMetrics) {
        last = r.u16();
        r.pos += 2; // lsb
      }
      out[i] = last;
    }
    return out;
  }

  private readLoca(): Uint32Array {
    const loca = this.require('loca');
    const out = new Uint32Array(this.numGlyphs + 1);
    const r = new Reader(this.data, loca.offset);
    const short = this.head.indexToLocFormat === 0;
    for (let i = 0; i <= this.numGlyphs; i++) {
      out[i] = short ? r.u16() * 2 : r.u32();
    }
    return out;
  }

  private readCmap(): void {
    const cmap = this.require('cmap');
    const r = new Reader(this.data, cmap.offset + 2);
    const numSubtables = r.u16();
    let best = -1;
    let bestScore = -1;
    for (let i = 0; i < numSubtables; i++) {
      const platform = r.u16();
      const encoding = r.u16();
      const offset = r.u32();
      // Prefer a full-repertoire table; fall back to the BMP one.
      const score =
        platform === 3 && encoding === 10
          ? 5
          : platform === 0 && encoding >= 4
            ? 4
            : platform === 3 && encoding === 1
              ? 3
              : platform === 0
                ? 2
                : 0;
      if (score > bestScore) {
        bestScore = score;
        best = cmap.offset + offset;
      }
    }
    if (best < 0) throw new Error(`${this.familyName}: no usable cmap subtable`);
    const s = new Reader(this.data, best);
    const format = s.u16();
    if (format === 4) this.readCmap4(s, best);
    else if (format === 12) this.readCmap12(s);
    else throw new Error(`${this.familyName}: cmap format ${format} is not supported`);
  }

  private readCmap4(s: Reader, base: number): void {
    s.pos += 4; // length, language
    const segCountX2 = s.u16();
    const segCount = segCountX2 / 2;
    s.pos += 6; // searchRange, entrySelector, rangeShift
    const endBase = s.pos;
    const startBase = endBase + segCountX2 + 2;
    const deltaBase = startBase + segCountX2;
    const rangeBase = deltaBase + segCountX2;
    for (let seg = 0; seg < segCount; seg++) {
      const end = s.u16At(endBase + seg * 2);
      const start = s.u16At(startBase + seg * 2);
      const delta = new DataView(this.data.buffer, this.data.byteOffset).getInt16(
        deltaBase + seg * 2,
      );
      const rangeOffset = s.u16At(rangeBase + seg * 2);
      if (start === 0xffff) continue;
      for (let cp = start; cp <= end && cp !== 0x10000; cp++) {
        let gid: number;
        if (rangeOffset === 0) {
          gid = (cp + delta) & 0xffff;
        } else {
          const gidAddr = rangeBase + seg * 2 + rangeOffset + (cp - start) * 2;
          if (gidAddr + 1 >= base + this.data.byteLength) continue;
          gid = s.u16At(gidAddr);
          if (gid !== 0) gid = (gid + delta) & 0xffff;
        }
        if (gid !== 0) this.cmapUnicode.set(cp, gid);
      }
    }
  }

  private readCmap12(s: Reader): void {
    s.pos += 10; // reserved, length, language
    const nGroups = s.u32();
    for (let i = 0; i < nGroups; i++) {
      const start = s.u32();
      const end = s.u32();
      const startGid = s.u32();
      // Noto Sans SC has ranges in the tens of thousands; walking them is fine
      // because a font is parsed once per process.
      for (let cp = start; cp <= end; cp++) this.cmapUnicode.set(cp, startGid + (cp - start));
    }
  }

  /** Glyph id for a code point, or 0 when the face does not cover it. */
  glyphFor(codePoint: number): number {
    return this.cmapUnicode.get(codePoint) ?? 0;
  }

  covers(codePoint: number): boolean {
    return this.cmapUnicode.has(codePoint);
  }

  advanceOf(gid: number): number {
    return this.advances[gid] ?? 0;
  }

  /** The raw `glyf` record for a glyph; empty for a blank one. */
  glyphBytes(gid: number): Uint8Array {
    if (!this.glyfRec) return new Uint8Array(0);
    const start = this.loca[gid] ?? 0;
    const end = this.loca[gid + 1] ?? 0;
    if (end <= start) return new Uint8Array(0);
    return this.data.subarray(this.glyfRec.offset + start, this.glyfRec.offset + end);
  }

  /** Component glyph ids of a composite, for subsetting closure. */
  componentsOf(gid: number): number[] {
    const bytes = this.glyphBytes(gid);
    if (bytes.length < 10) return [];
    const r = new Reader(bytes);
    if (r.i16() >= 0) return [];
    r.seek(10);
    const out: number[] = [];
    for (;;) {
      const flags = r.u16();
      out.push(r.u16());
      r.pos += flags & 0x0001 ? 4 : 2;
      if (flags & 0x0008) r.pos += 2;
      else if (flags & 0x0040) r.pos += 4;
      else if (flags & 0x0080) r.pos += 8;
      if (!(flags & 0x0020)) break;
    }
    return out;
  }

  /** Outline in font units, with composites resolved. */
  glyph(gid: number): Glyph {
    const cached = this.glyphCache.get(gid);
    if (cached) return cached;
    const g = this.readGlyph(gid, 0);
    this.glyphCache.set(gid, g);
    return g;
  }

  private readGlyph(gid: number, depth: number): Glyph {
    if (depth > 5) throw new Error(`${this.familyName}: composite glyph nesting too deep`);
    const empty: Glyph = { contours: [], xMin: 0, yMin: 0, xMax: 0, yMax: 0 };
    if (!this.glyfRec || gid < 0 || gid >= this.numGlyphs) return empty;
    const start = this.loca[gid] ?? 0;
    const end = this.loca[gid + 1] ?? 0;
    if (end <= start) return empty;
    const r = new Reader(this.data, this.glyfRec.offset + start);
    const numberOfContours = r.i16();
    const xMin = r.i16();
    const yMin = r.i16();
    const xMax = r.i16();
    const yMax = r.i16();
    const contours =
      numberOfContours >= 0
        ? readSimpleGlyph(r, numberOfContours)
        : this.readCompositeGlyph(r, depth);
    return { contours, xMin, yMin, xMax, yMax };
  }

  private readCompositeGlyph(r: Reader, depth: number): Contour[] {
    const out: Contour[] = [];
    for (;;) {
      const flags = r.u16();
      const glyphIndex = r.u16();
      const ARG_1_AND_2_ARE_WORDS = 0x0001;
      const ARGS_ARE_XY_VALUES = 0x0002;
      const WE_HAVE_A_SCALE = 0x0008;
      const MORE_COMPONENTS = 0x0020;
      const WE_HAVE_AN_X_AND_Y_SCALE = 0x0040;
      const WE_HAVE_A_TWO_BY_TWO = 0x0080;
      let dx = 0;
      let dy = 0;
      if (flags & ARG_1_AND_2_ARE_WORDS) {
        dx = r.i16();
        dy = r.i16();
      } else {
        dx = (r.u8() << 24) >> 24;
        dy = (r.u8() << 24) >> 24;
      }
      if (!(flags & ARGS_ARE_XY_VALUES)) {
        // Point matching: unused by the bundled faces, and getting it silently
        // wrong would shift a component by an arbitrary amount.
        dx = 0;
        dy = 0;
      }
      let a = 1;
      let b = 0;
      let c = 0;
      let d = 1;
      if (flags & WE_HAVE_A_SCALE) {
        a = d = r.f2dot14();
      } else if (flags & WE_HAVE_AN_X_AND_Y_SCALE) {
        a = r.f2dot14();
        d = r.f2dot14();
      } else if (flags & WE_HAVE_A_TWO_BY_TWO) {
        a = r.f2dot14();
        b = r.f2dot14();
        c = r.f2dot14();
        d = r.f2dot14();
      }
      const sub = this.readGlyph(glyphIndex, depth + 1);
      for (const contour of sub.contours) {
        out.push(
          contour.map((p) => ({
            x: a * p.x + c * p.y + dx,
            y: b * p.x + d * p.y + dy,
            on: p.on,
          })),
        );
      }
      if (!(flags & MORE_COMPONENTS)) break;
    }
    return out;
  }
}

export interface GlyphPoint {
  x: number;
  y: number;
  on: boolean;
}

export type Contour = GlyphPoint[];

export interface Glyph {
  contours: Contour[];
  xMin: number;
  yMin: number;
  xMax: number;
  yMax: number;
}

function readSimpleGlyph(r: Reader, numberOfContours: number): Contour[] {
  const endPts: number[] = [];
  for (let i = 0; i < numberOfContours; i++) endPts.push(r.u16());
  const numPoints = numberOfContours === 0 ? 0 : (endPts[numberOfContours - 1] ?? -1) + 1;
  const instructionLength = r.u16();
  r.pos += instructionLength;

  const ON_CURVE = 0x01;
  const X_SHORT = 0x02;
  const Y_SHORT = 0x04;
  const REPEAT = 0x08;
  const X_SAME_OR_POSITIVE = 0x10;
  const Y_SAME_OR_POSITIVE = 0x20;

  const flags = new Uint8Array(numPoints);
  for (let i = 0; i < numPoints; ) {
    const f = r.u8();
    flags[i++] = f;
    if (f & REPEAT) {
      let repeat = r.u8();
      while (repeat-- > 0 && i < numPoints) flags[i++] = f;
    }
  }

  const xs = new Int16Array(numPoints);
  let x = 0;
  for (let i = 0; i < numPoints; i++) {
    const f = flags[i] ?? 0;
    if (f & X_SHORT) {
      const v = r.u8();
      x += f & X_SAME_OR_POSITIVE ? v : -v;
    } else if (!(f & X_SAME_OR_POSITIVE)) {
      x += r.i16();
    }
    xs[i] = x;
  }
  const ys = new Int16Array(numPoints);
  let y = 0;
  for (let i = 0; i < numPoints; i++) {
    const f = flags[i] ?? 0;
    if (f & Y_SHORT) {
      const v = r.u8();
      y += f & Y_SAME_OR_POSITIVE ? v : -v;
    } else if (!(f & Y_SAME_OR_POSITIVE)) {
      y += r.i16();
    }
    ys[i] = y;
  }

  const contours: Contour[] = [];
  let startPt = 0;
  for (let ci = 0; ci < numberOfContours; ci++) {
    const endPt = endPts[ci] ?? -1;
    const contour: Contour = [];
    for (let i = startPt; i <= endPt; i++) {
      contour.push({ x: xs[i] ?? 0, y: ys[i] ?? 0, on: ((flags[i] ?? 0) & ON_CURVE) !== 0 });
    }
    if (contour.length > 0) contours.push(contour);
    startPt = endPt + 1;
  }
  return contours;
}
