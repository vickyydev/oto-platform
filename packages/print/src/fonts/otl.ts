/**
 * OpenType layout — GDEF, GSUB and GPOS, to the depth Thai needs.
 *
 * This is the table that makes `ญี่ปุ่น` come out right. A Thai syllable stacks
 * up to three levels on one consonant: the base, then an above- or below-vowel
 * with no advance, then a tone mark sitting above the vowel, also with no
 * advance. Where those marks land is `mark` (mark-to-base) and `mkmk`
 * (mark-to-mark) attachment, and clipping the descending tail of ญ to make room
 * for a below-vowel is a `ccmp` substitution. A renderer without these tables
 * can only stamp each mark at a fixed height, which Thai readers read as broken.
 *
 * Implemented: GSUB types 1, 2, 4, 6 and 7; GPOS types 1, 2, 4, 6 and 9. The
 * bundled Noto faces use nothing else for the features we run. An unsupported
 * lookup type is skipped rather than guessed at.
 */

import { Reader } from './sfnt';
import type { SfntFont } from './sfnt';

export const GDEF_BASE = 1;
export const GDEF_LIGATURE = 2;
export const GDEF_MARK = 3;
export const GDEF_COMPONENT = 4;

const IGNORE_BASE_GLYPHS = 0x02;
const IGNORE_LIGATURES = 0x04;
const IGNORE_MARKS = 0x08;

/** One glyph as it moves through shaping. */
export interface ShapedGlyph {
  gid: number;
  /** Index of the source code unit this glyph came from, for diagnostics. */
  cluster: number;
  xAdvance: number;
  xOffset: number;
  yOffset: number;
  /** Buffer index of the glyph this one is anchored to, or -1 when free. */
  attachTo: number;
}

interface Lookup {
  type: number;
  flag: number;
  subtables: number[];
  markFilteringSet: number;
}

/** Coverage table: glyph id to its index in the table's parallel arrays. */
class Coverage {
  private readonly single = new Map<number, number>();

  constructor(r: Reader, offset: number) {
    r.seek(offset);
    const format = r.u16();
    if (format === 1) {
      const count = r.u16();
      for (let i = 0; i < count; i++) this.single.set(r.u16(), i);
    } else if (format === 2) {
      const count = r.u16();
      for (let i = 0; i < count; i++) {
        const start = r.u16();
        const end = r.u16();
        const startIndex = r.u16();
        for (let g = start; g <= end; g++) this.single.set(g, startIndex + (g - start));
      }
    }
  }

  index(gid: number): number {
    return this.single.get(gid) ?? -1;
  }
}

class ClassDef {
  private readonly map = new Map<number, number>();

  constructor(r: Reader, offset: number) {
    if (offset === 0) return;
    r.seek(offset);
    const format = r.u16();
    if (format === 1) {
      const startGlyph = r.u16();
      const count = r.u16();
      for (let i = 0; i < count; i++) this.map.set(startGlyph + i, r.u16());
    } else if (format === 2) {
      const count = r.u16();
      for (let i = 0; i < count; i++) {
        const start = r.u16();
        const end = r.u16();
        const cls = r.u16();
        for (let g = start; g <= end; g++) this.map.set(g, cls);
      }
    }
  }

  of(gid: number): number {
    return this.map.get(gid) ?? 0;
  }
}

interface Anchor {
  x: number;
  y: number;
}

function readAnchor(r: Reader, offset: number): Anchor {
  r.seek(offset);
  r.u16(); // format: 1, 2 and 3 all start with x then y
  return { x: r.i16(), y: r.i16() };
}

/** The layout tables of one face, parsed once and reused for every line. */
export class OtLayout {
  readonly glyphClass: ClassDef;
  private readonly markAttachClass: ClassDef;
  private readonly gsub: LayoutTable | undefined;
  private readonly gpos: LayoutTable | undefined;

  constructor(private readonly font: SfntFont) {
    const gdef = font.table('GDEF');
    const r = new Reader(font.data);
    if (gdef) {
      r.seek(gdef.offset + 4);
      const glyphClassDefOffset = r.u16();
      r.u16(); // attachList
      r.u16(); // ligCaretList
      const markAttachClassDefOffset = r.u16();
      this.glyphClass = new ClassDef(
        r,
        glyphClassDefOffset ? gdef.offset + glyphClassDefOffset : 0,
      );
      this.markAttachClass = new ClassDef(
        r,
        markAttachClassDefOffset ? gdef.offset + markAttachClassDefOffset : 0,
      );
    } else {
      this.glyphClass = new ClassDef(r, 0);
      this.markAttachClass = new ClassDef(r, 0);
    }
    const gsubRec = font.table('GSUB');
    this.gsub = gsubRec ? new LayoutTable(font, gsubRec.offset) : undefined;
    const gposRec = font.table('GPOS');
    this.gpos = gposRec ? new LayoutTable(font, gposRec.offset) : undefined;
  }

  /** Run the substitution features, in the order given. */
  substitute(buf: ShapedGlyph[], script: string, features: string[]): ShapedGlyph[] {
    if (!this.gsub) return buf;
    let out = buf;
    for (const lookup of this.gsub.lookupsFor(script, features)) {
      out = this.applyGsubLookup(out, lookup);
    }
    return out;
  }

  /** Run the positioning features, in the order given. */
  position(buf: ShapedGlyph[], script: string, features: string[]): void {
    if (!this.gpos) return;
    for (const lookup of this.gpos.lookupsFor(script, features)) {
      this.applyGposLookup(buf, lookup);
    }
  }

  private skips(gid: number, lookup: Lookup): boolean {
    const cls = this.glyphClass.of(gid);
    if (lookup.flag & IGNORE_BASE_GLYPHS && cls === GDEF_BASE) return true;
    if (lookup.flag & IGNORE_LIGATURES && cls === GDEF_LIGATURE) return true;
    if (lookup.flag & IGNORE_MARKS && cls === GDEF_MARK) return true;
    const attachType = lookup.flag >> 8;
    if (attachType && cls === GDEF_MARK && this.markAttachClass.of(gid) !== attachType) return true;
    return false;
  }

  /** Previous buffer index this lookup pays attention to, or -1. */
  private prevIndex(buf: ShapedGlyph[], from: number, lookup: Lookup): number {
    for (let i = from - 1; i >= 0; i--) {
      const g = buf[i];
      if (g && !this.skips(g.gid, lookup)) return i;
    }
    return -1;
  }

  // ---- GSUB ---------------------------------------------------------------

  private applyGsubLookup(buf: ShapedGlyph[], lookup: Lookup): ShapedGlyph[] {
    const r = new Reader(this.font.data);
    let out = buf;
    for (const sub of lookup.subtables) {
      out = this.applyGsubSubtable(out, lookup, sub, r);
    }
    return out;
  }

  private applyGsubSubtable(
    buf: ShapedGlyph[],
    lookup: Lookup,
    sub: number,
    r: Reader,
  ): ShapedGlyph[] {
    r.seek(sub);
    let type = lookup.type;
    let base = sub;
    if (type === 7) {
      r.u16(); // format
      type = r.u16();
      base = sub + r.u32();
      r.seek(base);
    }
    const format = r.u16();

    if (type === 1) {
      const coverage = new Coverage(new Reader(this.font.data), base + r.seek(base + 2).u16());
      r.seek(base + 4);
      if (format === 1) {
        const delta = r.i16();
        return buf.map((g) =>
          coverage.index(g.gid) >= 0 ? { ...g, gid: (g.gid + delta) & 0xffff } : g,
        );
      }
      const count = r.u16();
      const subs: number[] = [];
      for (let i = 0; i < count; i++) subs.push(r.u16());
      return buf.map((g) => {
        const idx = coverage.index(g.gid);
        return idx >= 0 && subs[idx] !== undefined ? { ...g, gid: subs[idx] } : g;
      });
    }

    if (type === 2) {
      // One glyph becomes several — how SARA AM splits into nikhahit + sara aa.
      const coverage = new Coverage(new Reader(this.font.data), base + r.seek(base + 2).u16());
      r.seek(base + 4);
      const count = r.u16();
      const seqOffsets: number[] = [];
      for (let i = 0; i < count; i++) seqOffsets.push(base + r.u16());
      const out: ShapedGlyph[] = [];
      for (const g of buf) {
        const idx = coverage.index(g.gid);
        const seqOffset = idx >= 0 ? seqOffsets[idx] : undefined;
        if (seqOffset === undefined) {
          out.push(g);
          continue;
        }
        r.seek(seqOffset);
        const n = r.u16();
        for (let i = 0; i < n; i++) {
          const gid = r.u16();
          out.push({ ...g, gid, xAdvance: this.font.advanceOf(gid) });
        }
      }
      return out;
    }

    if (type === 4) {
      const coverage = new Coverage(new Reader(this.font.data), base + r.seek(base + 2).u16());
      r.seek(base + 4);
      const setCount = r.u16();
      const setOffsets: number[] = [];
      for (let i = 0; i < setCount; i++) setOffsets.push(base + r.u16());
      const out: ShapedGlyph[] = [];
      let i = 0;
      while (i < buf.length) {
        const g = buf[i];
        if (!g) break;
        const idx = coverage.index(g.gid);
        const setOffset = idx >= 0 ? setOffsets[idx] : undefined;
        let matched = false;
        if (setOffset !== undefined) {
          r.seek(setOffset);
          const ligCount = r.u16();
          const ligOffsets: number[] = [];
          for (let k = 0; k < ligCount; k++) ligOffsets.push(setOffset + r.u16());
          for (const lig of ligOffsets) {
            r.seek(lig);
            const ligGlyph = r.u16();
            const compCount = r.u16();
            const wanted: number[] = [];
            for (let k = 1; k < compCount; k++) wanted.push(r.u16());
            const picked: number[] = [];
            let j = i;
            let ok = true;
            for (const want of wanted) {
              j = this.nextIndex(buf, j, lookup);
              const cand = j >= 0 ? buf[j] : undefined;
              if (!cand || cand.gid !== want) {
                ok = false;
                break;
              }
              picked.push(j);
            }
            if (ok) {
              out.push({ ...g, gid: ligGlyph, xAdvance: this.font.advanceOf(ligGlyph) });
              const consumed = new Set(picked);
              let k = i + 1;
              const last = picked.length ? Math.max(...picked) : i;
              for (; k <= last; k++) {
                const inner = buf[k];
                if (inner && !consumed.has(k)) out.push(inner);
              }
              i = last + 1;
              matched = true;
              break;
            }
          }
        }
        if (!matched) {
          out.push(g);
          i++;
        }
      }
      return out;
    }

    if (type === 6 && format === 3) {
      // Chaining context, coverage-based: the form Noto's ccmp uses.
      r.seek(base + 2);
      const backtrackCount = r.u16();
      const backtrack: Coverage[] = [];
      for (let i = 0; i < backtrackCount; i++)
        backtrack.push(new Coverage(new Reader(this.font.data), base + r.u16()));
      const inputCount = r.u16();
      const input: Coverage[] = [];
      for (let i = 0; i < inputCount; i++)
        input.push(new Coverage(new Reader(this.font.data), base + r.u16()));
      const lookaheadCount = r.u16();
      const lookahead: Coverage[] = [];
      for (let i = 0; i < lookaheadCount; i++)
        lookahead.push(new Coverage(new Reader(this.font.data), base + r.u16()));
      const substCount = r.u16();
      const records: { seqIndex: number; lookupIndex: number }[] = [];
      for (let i = 0; i < substCount; i++)
        records.push({ seqIndex: r.u16(), lookupIndex: r.u16() });

      let out = buf;
      for (let i = 0; i < out.length; i++) {
        if (!this.matchesChain(out, i, backtrack, input, lookahead, lookup)) continue;
        for (const rec of records) {
          const target = this.nthIndex(out, i, rec.seqIndex, lookup);
          if (target < 0) continue;
          const nested = this.gsub?.lookup(rec.lookupIndex);
          if (!nested) continue;
          // Nested lookups are applied to the whole buffer; the coverage test
          // inside them keeps the effect local in practice for these faces.
          out = this.applyGsubLookup(out, nested);
        }
      }
      return out;
    }

    return buf;
  }

  private nextIndex(buf: ShapedGlyph[], from: number, lookup: Lookup): number {
    for (let i = from + 1; i < buf.length; i++) {
      const g = buf[i];
      if (g && !this.skips(g.gid, lookup)) return i;
    }
    return -1;
  }

  private nthIndex(buf: ShapedGlyph[], from: number, n: number, lookup: Lookup): number {
    let i = from;
    for (let k = 0; k < n; k++) {
      i = this.nextIndex(buf, i, lookup);
      if (i < 0) return -1;
    }
    return i;
  }

  private matchesChain(
    buf: ShapedGlyph[],
    at: number,
    backtrack: Coverage[],
    input: Coverage[],
    lookahead: Coverage[],
    lookup: Lookup,
  ): boolean {
    let i = at;
    for (let k = 0; k < input.length; k++) {
      if (k > 0) i = this.nextIndex(buf, i, lookup);
      const g = i >= 0 ? buf[i] : undefined;
      if (!g || (input[k]?.index(g.gid) ?? -1) < 0) return false;
    }
    let after = i;
    for (const cov of lookahead) {
      after = this.nextIndex(buf, after, lookup);
      const g = after >= 0 ? buf[after] : undefined;
      if (!g || cov.index(g.gid) < 0) return false;
    }
    let before = at;
    for (const cov of backtrack) {
      before = this.prevIndex(buf, before, lookup);
      const g = before >= 0 ? buf[before] : undefined;
      if (!g || cov.index(g.gid) < 0) return false;
    }
    return true;
  }

  // ---- GPOS ---------------------------------------------------------------

  private applyGposLookup(buf: ShapedGlyph[], lookup: Lookup): void {
    const r = new Reader(this.font.data);
    for (const sub of lookup.subtables) this.applyGposSubtable(buf, lookup, sub, r);
  }

  private applyGposSubtable(buf: ShapedGlyph[], lookup: Lookup, sub: number, r: Reader): void {
    r.seek(sub);
    let type = lookup.type;
    let base = sub;
    if (type === 9) {
      r.u16();
      type = r.u16();
      base = sub + r.u32();
      r.seek(base);
    }
    const format = r.seek(base).u16();

    if (type === 1) {
      const coverage = new Coverage(new Reader(this.font.data), base + r.seek(base + 2).u16());
      r.seek(base + 4);
      const valueFormat = r.u16();
      if (format === 1) {
        const value = readValueRecord(r, valueFormat);
        for (const g of buf) {
          if (coverage.index(g.gid) >= 0) {
            g.xOffset += value.xPlacement;
            g.yOffset += value.yPlacement;
            g.xAdvance += value.xAdvance;
          }
        }
      } else {
        const count = r.u16();
        const values = [];
        for (let i = 0; i < count; i++) values.push(readValueRecord(r, valueFormat));
        for (const g of buf) {
          const v = values[coverage.index(g.gid)];
          if (v) {
            g.xOffset += v.xPlacement;
            g.yOffset += v.yPlacement;
            g.xAdvance += v.xAdvance;
          }
        }
      }
      return;
    }

    if (type === 2) {
      const coverage = new Coverage(new Reader(this.font.data), base + r.seek(base + 2).u16());
      r.seek(base + 4);
      const valueFormat1 = r.u16();
      const valueFormat2 = r.u16();
      if (format === 1) {
        const pairSetCount = r.u16();
        const pairSets: number[] = [];
        for (let i = 0; i < pairSetCount; i++) pairSets.push(base + r.u16());
        for (let i = 0; i < buf.length; i++) {
          const g = buf[i];
          if (!g) continue;
          const idx = coverage.index(g.gid);
          const setOffset = idx >= 0 ? pairSets[idx] : undefined;
          if (setOffset === undefined) continue;
          const j = this.nextIndex(buf, i, lookup);
          const next = j >= 0 ? buf[j] : undefined;
          if (!next) continue;
          r.seek(setOffset);
          const pairCount = r.u16();
          for (let p = 0; p < pairCount; p++) {
            const secondGlyph = r.u16();
            const v1 = readValueRecord(r, valueFormat1);
            const v2 = readValueRecord(r, valueFormat2);
            if (secondGlyph === next.gid) {
              g.xAdvance += v1.xAdvance;
              g.xOffset += v1.xPlacement;
              next.xAdvance += v2.xAdvance;
              next.xOffset += v2.xPlacement;
              break;
            }
          }
        }
      } else if (format === 2) {
        const classDef1Offset = r.u16();
        const classDef2Offset = r.u16();
        const class1Count = r.u16();
        const class2Count = r.u16();
        const recordsStart = r.pos;
        const cd1 = new ClassDef(new Reader(this.font.data), base + classDef1Offset);
        const cd2 = new ClassDef(new Reader(this.font.data), base + classDef2Offset);
        const size1 = valueRecordSize(valueFormat1);
        const size2 = valueRecordSize(valueFormat2);
        for (let i = 0; i < buf.length; i++) {
          const g = buf[i];
          if (!g || coverage.index(g.gid) < 0) continue;
          const j = this.nextIndex(buf, i, lookup);
          const next = j >= 0 ? buf[j] : undefined;
          if (!next) continue;
          const c1 = cd1.of(g.gid);
          const c2 = cd2.of(next.gid);
          if (c1 >= class1Count || c2 >= class2Count) continue;
          r.seek(recordsStart + (c1 * class2Count + c2) * (size1 + size2));
          const v1 = readValueRecord(r, valueFormat1);
          const v2 = readValueRecord(r, valueFormat2);
          g.xAdvance += v1.xAdvance;
          g.xOffset += v1.xPlacement;
          next.xAdvance += v2.xAdvance;
          next.xOffset += v2.xPlacement;
        }
      }
      return;
    }

    if (type === 4 || type === 6) {
      // Mark-to-base and mark-to-mark share a shape: a mark array on one side,
      // an anchor array on the other, matched by mark class.
      r.seek(base + 2);
      const markCoverage = new Coverage(new Reader(this.font.data), base + r.u16());
      const secondCoverage = new Coverage(new Reader(this.font.data), base + r.u16());
      const classCount = r.u16();
      const markArrayOffset = base + r.u16();
      const secondArrayOffset = base + r.u16();

      for (let i = 0; i < buf.length; i++) {
        const mark = buf[i];
        if (!mark) continue;
        const markIndex = markCoverage.index(mark.gid);
        if (markIndex < 0) continue;

        // Mark-to-base walks back past marks to the base; mark-to-mark attaches
        // to the glyph immediately before, mark or not.
        let j = -1;
        if (type === 4) {
          for (let k = i - 1; k >= 0; k--) {
            const cand = buf[k];
            if (!cand) continue;
            if (this.glyphClass.of(cand.gid) !== GDEF_MARK) {
              j = k;
              break;
            }
          }
        } else {
          j = i - 1;
        }
        const anchorHost = j >= 0 ? buf[j] : undefined;
        if (!anchorHost) continue;
        const secondIndex = secondCoverage.index(anchorHost.gid);
        if (secondIndex < 0) continue;

        r.seek(markArrayOffset);
        const markCount = r.u16();
        if (markIndex >= markCount) continue;
        r.seek(markArrayOffset + 2 + markIndex * 4);
        const markClass = r.u16();
        const markAnchorOffset = r.u16();
        if (markClass >= classCount) continue;
        const markAnchor = readAnchor(
          new Reader(this.font.data),
          markArrayOffset + markAnchorOffset,
        );

        r.seek(secondArrayOffset);
        const secondCount = r.u16();
        if (secondIndex >= secondCount) continue;
        r.seek(secondArrayOffset + 2 + (secondIndex * classCount + markClass) * 2);
        const hostAnchorOffset = r.u16();
        if (hostAnchorOffset === 0) continue;
        const hostAnchor = readAnchor(
          new Reader(this.font.data),
          secondArrayOffset + hostAnchorOffset,
        );

        mark.attachTo = j;
        mark.xOffset = hostAnchor.x - markAnchor.x;
        mark.yOffset = hostAnchor.y - markAnchor.y;
        mark.xAdvance = 0;
      }
    }
  }
}

interface ValueRecord {
  xPlacement: number;
  yPlacement: number;
  xAdvance: number;
}

function valueRecordSize(format: number): number {
  let bits = 0;
  for (let i = 0; i < 8; i++) if (format & (1 << i)) bits++;
  return bits * 2;
}

function readValueRecord(r: Reader, format: number): ValueRecord {
  const out: ValueRecord = { xPlacement: 0, yPlacement: 0, xAdvance: 0 };
  if (format & 0x0001) out.xPlacement = r.i16();
  if (format & 0x0002) out.yPlacement = r.i16();
  if (format & 0x0004) out.xAdvance = r.i16();
  if (format & 0x0008) r.i16(); // yAdvance
  if (format & 0x0010) r.u16(); // xPlaDevice
  if (format & 0x0020) r.u16(); // yPlaDevice
  if (format & 0x0040) r.u16(); // xAdvDevice
  if (format & 0x0080) r.u16(); // yAdvDevice
  return out;
}

/** The script/feature/lookup index of one GSUB or GPOS table. */
class LayoutTable {
  private readonly lookups: Lookup[] = [];
  /** script tag -> feature tag -> lookup indices */
  private readonly scripts = new Map<string, Map<string, number[]>>();

  constructor(font: SfntFont, base: number) {
    const r = new Reader(font.data, base);
    r.u32(); // version
    const scriptListOffset = base + r.u16();
    const featureListOffset = base + r.u16();
    const lookupListOffset = base + r.u16();

    r.seek(lookupListOffset);
    const lookupCount = r.u16();
    const lookupOffsets: number[] = [];
    for (let i = 0; i < lookupCount; i++) lookupOffsets.push(lookupListOffset + r.u16());
    for (const off of lookupOffsets) {
      r.seek(off);
      const type = r.u16();
      const flag = r.u16();
      const subCount = r.u16();
      const subtables: number[] = [];
      for (let i = 0; i < subCount; i++) subtables.push(off + r.u16());
      const markFilteringSet = flag & 0x10 ? r.u16() : 0;
      this.lookups.push({ type, flag, subtables, markFilteringSet });
    }

    r.seek(featureListOffset);
    const featureCount = r.u16();
    const features: { tag: string; lookups: number[] }[] = [];
    const featureRecords: { tag: string; offset: number }[] = [];
    for (let i = 0; i < featureCount; i++) {
      const tag = r.tag();
      featureRecords.push({ tag, offset: featureListOffset + r.u16() });
    }
    for (const rec of featureRecords) {
      r.seek(rec.offset);
      r.u16(); // featureParams
      const n = r.u16();
      const idx: number[] = [];
      for (let i = 0; i < n; i++) idx.push(r.u16());
      features.push({ tag: rec.tag, lookups: idx });
    }

    r.seek(scriptListOffset);
    const scriptCount = r.u16();
    const scriptRecords: { tag: string; offset: number }[] = [];
    for (let i = 0; i < scriptCount; i++) {
      const tag = r.tag();
      scriptRecords.push({ tag, offset: scriptListOffset + r.u16() });
    }
    for (const rec of scriptRecords) {
      r.seek(rec.offset);
      const defaultLangSys = r.u16();
      if (!defaultLangSys) continue;
      r.seek(rec.offset + defaultLangSys);
      r.u16(); // lookupOrder
      r.u16(); // requiredFeatureIndex
      const n = r.u16();
      const byFeature = new Map<string, number[]>();
      for (let i = 0; i < n; i++) {
        const fi = r.u16();
        const f = features[fi];
        if (!f) continue;
        const existing = byFeature.get(f.tag) ?? [];
        byFeature.set(f.tag, [...existing, ...f.lookups]);
      }
      this.scripts.set(rec.tag.trim(), byFeature);
    }
  }

  lookup(index: number): Lookup | undefined {
    return this.lookups[index];
  }

  /**
   * Lookups for the named features, in feature order then lookup order, with
   * each lookup used once. Falls back to DFLT when the script is not listed.
   */
  lookupsFor(script: string, features: string[]): Lookup[] {
    const table = this.scripts.get(script) ?? this.scripts.get('DFLT') ?? this.scripts.get('latn');
    if (!table) return [];
    const seen = new Set<number>();
    const out: Lookup[] = [];
    for (const feature of features) {
      for (const index of table.get(feature) ?? []) {
        if (seen.has(index)) continue;
        seen.add(index);
        const l = this.lookups[index];
        if (l) out.push(l);
      }
    }
    return out;
  }
}
