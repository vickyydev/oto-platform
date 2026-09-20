/**
 * Build `fonts/OtoPrintSC-Regular.ttf` from an upstream Noto Sans SC.
 *
 * Why a subset: the full face is about 17 MB per weight and a thermal head
 * needs a few dozen Chinese glyphs. Why a rename: subsetting is modification
 * under OFL 1.1 and "Noto" is a Reserved Font Name, so a modified build may not
 * carry it. `fonts/LICENSES.md` records the source, the version and this
 * script, which is what makes the rename honest rather than a dodge.
 *
 * Run:
 *   node --experimental-transform-types scripts/subset-cjk.ts <NotoSansSC.ttf>
 *
 * Widening the repertoire is one line below plus a re-run; nothing else in the
 * package knows which glyphs are in it.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { SfntFont } from '../src/fonts/sfnt';
import { applyGvar, normalizeAxis, readSimpleGlyph, writeSimpleGlyph } from './instance';

/**
 * The weight to instance at. The source's default instance is Thin (wght 100),
 * which on a 203 dpi head next to Regular Latin and Thai looks like a printer
 * fault rather than a typeface choice.
 */
const TARGET_WEIGHT = 400;

/**
 * The Chinese the park actually prints. The test page proves the CJK path
 * works; the rest are the words a receipt or a band would carry for a
 * Chinese-reading visitor.
 */
const REPERTOIRE = [
  '欢迎光临', // the test page's fixture line
  '谢谢', // thank you
  '儿童成人', // child / adult
  '收据小票', // receipt
  '手环门票', // wristband / ticket
  '合计总计数量单价', // money rows
  '日期时间', // date / time
  '餐饮饮料食品', // F&B
  '泰铢', // baht
  '过敏', // allergy
  // ★ and ☆ are not Chinese, but they are on the booth voucher the park is
  // already handing out ("★ YOU WON ★", DEVICE_INVENTORY §7) and Noto Sans does
  // not have them. This face does, so they ride along rather than costing a
  // fourth font or a hand-drawn vector.
  '★☆',
].join('');

const FAMILY = 'OtoPrintSC';

function main(): void {
  const source = process.argv[2];
  if (!source) {
    process.stderr.write('usage: subset-cjk.ts <NotoSansSC.ttf>\n');
    process.exit(2);
  }
  const font = new SfntFont(readFileSync(source), 'NotoSansSC');

  // Closure: every wanted glyph, plus the components of any composite.
  const wanted = new Set<number>([0]);
  const codeToGid = new Map<number, number>();
  for (const ch of REPERTOIRE) {
    const cp = ch.codePointAt(0);
    if (cp === undefined) continue;
    const gid = font.glyphFor(cp);
    if (gid === 0) {
      process.stderr.write(`source font does not cover U+${cp.toString(16)} (${ch})\n`);
      process.exit(1);
    }
    codeToGid.set(cp, gid);
    wanted.add(gid);
  }
  for (const gid of [...wanted]) for (const c of font.componentsOf(gid)) wanted.add(c);

  const oldGids = [...wanted].sort((a, b) => a - b);
  const remap = new Map<number, number>();
  oldGids.forEach((old, i) => remap.set(old, i));

  // glyf + loca. Long loca throughout so records need no even-offset dance.
  const coord = normalizeAxis(font, TARGET_WEIGHT);
  const records: Uint8Array[] = [];
  const offsets: number[] = [0];
  let total = 0;
  let instanced = 0;
  for (const old of oldGids) {
    const simple = readSimpleGlyph(font.glyphBytes(old));
    let bytes: Uint8Array;
    if (simple && simple.points.length > 0) {
      bytes = writeSimpleGlyph(applyGvar(font, old, simple, coord));
      instanced++;
    } else {
      // Blank or composite: copied through, component ids remapped.
      bytes = remapComposite(font.glyphBytes(old), remap);
    }
    const padded = new Uint8Array(Math.ceil(bytes.length / 4) * 4);
    padded.set(bytes);
    records.push(padded);
    total += padded.length;
    offsets.push(total);
  }
  const glyf = new Uint8Array(total);
  let at = 0;
  for (const rec of records) {
    glyf.set(rec, at);
    at += rec.length;
  }
  const loca = new Uint8Array((oldGids.length + 1) * 4);
  const locaView = new DataView(loca.buffer);
  offsets.forEach((o, i) => locaView.setUint32(i * 4, o));

  // hmtx: one long metric per glyph keeps it simple and costs 4 bytes each.
  const hmtx = new Uint8Array(oldGids.length * 4);
  const hmtxView = new DataView(hmtx.buffer);
  oldGids.forEach((old, i) => {
    hmtxView.setUint16(i * 4, font.advanceOf(old));
    hmtxView.setInt16(i * 4 + 2, font.glyph(old).xMin);
  });

  const head = patched(font, 'head', (view) => {
    view.setUint32(8, 0); // checkSumAdjustment; nothing downstream verifies it
    view.setInt16(50, 1); // indexToLocFormat: long
  });
  const hhea = patched(font, 'hhea', (view) => {
    view.setUint16(34, oldGids.length); // numberOfHMetrics
  });
  const maxp = patched(font, 'maxp', (view) => {
    view.setUint16(4, oldGids.length); // numGlyphs
  });

  const tables: [string, Uint8Array][] = [
    ['cmap', buildCmap4(codeToGid, remap)],
    ['glyf', glyf],
    ['head', head],
    ['hhea', hhea],
    ['hmtx', hmtx],
    ['loca', loca],
    ['maxp', maxp],
    ['name', buildName(FAMILY)],
    ['post', buildPost()],
  ];

  const out = assemble(tables);
  const target = fileURLToPath(new URL(`../fonts/${FAMILY}-Regular.ttf`, import.meta.url));
  writeFileSync(target, out);
  process.stdout.write(
    `${target}\n  ${oldGids.length} glyphs (${instanced} instanced at wght ${TARGET_WEIGHT}, ` +
      `normalised ${coord.toFixed(4)}), ${codeToGid.size} code points, ${out.length} bytes\n`,
  );
}

/** Rewrite the component glyph ids inside a composite record. */
function remapComposite(bytes: Uint8Array, remap: Map<number, number>): Uint8Array {
  if (bytes.length < 10) return bytes;
  const copy = new Uint8Array(bytes);
  const view = new DataView(copy.buffer);
  if (view.getInt16(0) >= 0) return copy;
  let pos = 10;
  for (;;) {
    const flags = view.getUint16(pos);
    const oldIndex = view.getUint16(pos + 2);
    view.setUint16(pos + 2, remap.get(oldIndex) ?? 0);
    pos += 4;
    pos += flags & 0x0001 ? 4 : 2;
    if (flags & 0x0008) pos += 2;
    else if (flags & 0x0040) pos += 4;
    else if (flags & 0x0080) pos += 8;
    if (!(flags & 0x0020)) break;
  }
  return copy;
}

function patched(font: SfntFont, tag: string, edit: (view: DataView) => void): Uint8Array {
  const rec = font.table(tag);
  if (!rec) throw new Error(`source font has no ${tag}`);
  const copy = new Uint8Array(font.data.subarray(rec.offset, rec.offset + rec.length));
  edit(new DataView(copy.buffer));
  return copy;
}

function buildCmap4(codeToGid: Map<number, number>, remap: Map<number, number>): Uint8Array {
  const entries = [...codeToGid.entries()]
    .map(([cp, gid]) => [cp, remap.get(gid) ?? 0] as const)
    .sort((a, b) => a[0] - b[0]);
  // One segment per code point plus the mandatory 0xFFFF terminator. The
  // repertoire is small, so the simplest encoding is also the smallest.
  const segCount = entries.length + 1;
  const glyphIdArrayLen = 0;
  const subtableLen = 16 + segCount * 8 + glyphIdArrayLen;
  const buf = new Uint8Array(4 + 8 + subtableLen);
  const v = new DataView(buf.buffer);
  v.setUint16(0, 0); // version
  v.setUint16(2, 1); // numTables
  v.setUint16(4, 3); // platform: Windows
  v.setUint16(6, 1); // encoding: BMP
  v.setUint32(8, 12); // offset
  const s = 12;
  v.setUint16(s, 4);
  v.setUint16(s + 2, subtableLen);
  v.setUint16(s + 4, 0); // language
  v.setUint16(s + 6, segCount * 2);
  const entrySelector = Math.floor(Math.log2(segCount));
  v.setUint16(s + 8, 2 ** entrySelector * 2);
  v.setUint16(s + 10, entrySelector);
  v.setUint16(s + 12, segCount * 2 - 2 ** entrySelector * 2);
  const endBase = s + 14;
  const startBase = endBase + segCount * 2 + 2;
  const deltaBase = startBase + segCount * 2;
  const rangeBase = deltaBase + segCount * 2;
  entries.forEach(([cp, gid], i) => {
    v.setUint16(endBase + i * 2, cp);
    v.setUint16(startBase + i * 2, cp);
    v.setInt16(deltaBase + i * 2, ((gid - cp) << 16) >> 16);
    v.setUint16(rangeBase + i * 2, 0);
  });
  const last = entries.length;
  v.setUint16(endBase + last * 2, 0xffff);
  v.setUint16(startBase + last * 2, 0xffff);
  v.setInt16(deltaBase + last * 2, 1);
  v.setUint16(rangeBase + last * 2, 0);
  return buf;
}

function buildName(family: string): Uint8Array {
  const ids = [1, 2, 4, 6];
  const strings = [family, 'Regular', `${family} Regular`, `${family}-Regular`];
  const utf16 = strings.map((s) => {
    const b = new Uint8Array(s.length * 2);
    for (let i = 0; i < s.length; i++) new DataView(b.buffer).setUint16(i * 2, s.charCodeAt(i));
    return b;
  });
  const storageLen = utf16.reduce((n, b) => n + b.length, 0);
  const buf = new Uint8Array(6 + ids.length * 12 + storageLen);
  const v = new DataView(buf.buffer);
  v.setUint16(0, 0);
  v.setUint16(2, ids.length);
  v.setUint16(4, 6 + ids.length * 12);
  let offset = 0;
  ids.forEach((id, i) => {
    const rec = 6 + i * 12;
    v.setUint16(rec, 3); // Windows
    v.setUint16(rec + 2, 1); // Unicode BMP
    v.setUint16(rec + 4, 0x0409); // en-US
    v.setUint16(rec + 6, id);
    const bytes = utf16[i];
    if (!bytes) return;
    v.setUint16(rec + 8, bytes.length);
    v.setUint16(rec + 10, offset);
    buf.set(bytes, 6 + ids.length * 12 + offset);
    offset += bytes.length;
  });
  return buf;
}

function buildPost(): Uint8Array {
  const buf = new Uint8Array(32);
  new DataView(buf.buffer).setUint32(0, 0x00030000);
  return buf;
}

function assemble(tables: [string, Uint8Array][]): Uint8Array {
  const numTables = tables.length;
  const dirLen = 12 + numTables * 16;
  let offset = dirLen;
  const placed = tables.map(([tag, data]) => {
    const rec = { tag, data, offset };
    offset += Math.ceil(data.length / 4) * 4;
    return rec;
  });
  const out = new Uint8Array(offset);
  const v = new DataView(out.buffer);
  v.setUint32(0, 0x00010000);
  v.setUint16(4, numTables);
  const entrySelector = Math.floor(Math.log2(numTables));
  v.setUint16(6, 2 ** entrySelector * 16);
  v.setUint16(8, entrySelector);
  v.setUint16(10, numTables * 16 - 2 ** entrySelector * 16);
  placed.forEach((rec, i) => {
    const at = 12 + i * 16;
    for (let c = 0; c < 4; c++) out[at + c] = rec.tag.charCodeAt(c);
    v.setUint32(at + 4, checksum(rec.data));
    v.setUint32(at + 8, rec.offset);
    v.setUint32(at + 12, rec.data.length);
    out.set(rec.data, rec.offset);
  });
  return out;
}

function checksum(data: Uint8Array): number {
  let sum = 0;
  const padded = new Uint8Array(Math.ceil(data.length / 4) * 4);
  padded.set(data);
  const v = new DataView(padded.buffer);
  for (let i = 0; i < padded.length; i += 4) sum = (sum + v.getUint32(i)) >>> 0;
  return sum;
}

main();
