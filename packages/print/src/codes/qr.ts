/**
 * QR encoding — byte mode, versions 1 to 40, all four error-correction levels.
 *
 * The prototype's `QrCode.tsx` draws a `buildQrMatrix` mock that encodes
 * nothing, so there was nothing to port. This is the real thing, because a band
 * whose QR does not scan is a visitor stuck at the gate.
 *
 * ISO/IEC 18004. Output is a boolean matrix; drawing modules at an integer
 * number of dots is the caller's job and is not optional — a QR resampled by a
 * non-integer factor at 203 dpi fails to scan, and the failure looks like a bad
 * printer rather than a bad renderer.
 */

export type QrEcc = 'L' | 'M' | 'Q' | 'H';

const ECC_ORDER: QrEcc[] = ['L', 'M', 'Q', 'H'];
/** Format-info bits per level; not the same order as the table index. */
const ECC_FORMAT_BITS: Record<QrEcc, number> = { L: 1, M: 0, Q: 3, H: 2 };

// Index 0 is unused so version numbers index directly.
const ECC_CODEWORDS_PER_BLOCK: Record<QrEcc, number[]> = {
  // prettier-ignore
  L: [-1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  // prettier-ignore
  M: [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28],
  // prettier-ignore
  Q: [-1, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30, 28, 30, 30, 30, 30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  // prettier-ignore
  H: [-1, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28, 30, 24, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
};

const NUM_ECC_BLOCKS: Record<QrEcc, number[]> = {
  // prettier-ignore
  L: [-1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25],
  // prettier-ignore
  M: [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49],
  // prettier-ignore
  Q: [-1, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34, 34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68],
  // prettier-ignore
  H: [-1, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35, 37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81],
};

export interface QrMatrix {
  size: number;
  version: number;
  ecc: QrEcc;
  /** Row-major; true means a dark module. */
  modules: boolean[];
  get(x: number, y: number): boolean;
}

/** Total codewords a version holds, data and error correction together. */
function rawDataModules(version: number): number {
  let result = (16 * version + 128) * version + 64;
  if (version >= 2) {
    const numAlign = Math.floor(version / 7) + 2;
    result -= (25 * numAlign - 10) * numAlign - 55;
    if (version >= 7) result -= 36;
  }
  return result;
}

function dataCodewords(version: number, ecc: QrEcc): number {
  return (
    Math.floor(rawDataModules(version) / 8) -
    (ECC_CODEWORDS_PER_BLOCK[ecc][version] ?? 0) * (NUM_ECC_BLOCKS[ecc][version] ?? 0)
  );
}

function alignmentPositions(version: number): number[] {
  if (version === 1) return [];
  const numAlign = Math.floor(version / 7) + 2;
  const size = version * 4 + 17;
  const step = version === 32 ? 26 : Math.ceil((version * 4 + 4) / (numAlign * 2 - 2)) * 2;
  const result = [6];
  for (let pos = size - 7; result.length < numAlign; pos -= step) result.splice(1, 0, pos);
  return result;
}

// ---- GF(256), primitive polynomial 0x11D -----------------------------------

const GF_EXP = new Uint8Array(512);
const GF_LOG = new Uint8Array(256);
{
  let x = 1;
  for (let i = 0; i < 255; i++) {
    GF_EXP[i] = x;
    GF_LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) GF_EXP[i] = GF_EXP[i - 255] ?? 0;
}

function gfMul(a: number, b: number): number {
  if (a === 0 || b === 0) return 0;
  return GF_EXP[(GF_LOG[a] ?? 0) + (GF_LOG[b] ?? 0)] ?? 0;
}

function rsGenerator(degree: number): Uint8Array {
  const poly = new Uint8Array(degree);
  poly[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < degree; j++) {
      poly[j] = gfMul(poly[j] ?? 0, root);
      if (j + 1 < degree) poly[j] = (poly[j] ?? 0) ^ (poly[j + 1] ?? 0);
    }
    root = gfMul(root, 2);
  }
  return poly;
}

function rsRemainder(data: Uint8Array, generator: Uint8Array): Uint8Array {
  const result = new Uint8Array(generator.length);
  for (const byte of data) {
    const factor = byte ^ (result[0] ?? 0);
    result.copyWithin(0, 1);
    result[result.length - 1] = 0;
    for (let i = 0; i < result.length; i++) {
      result[i] = (result[i] ?? 0) ^ gfMul(generator[i] ?? 0, factor);
    }
  }
  return result;
}

// ---- Encoding ---------------------------------------------------------------

class BitBuffer {
  readonly bits: number[] = [];

  push(value: number, length: number): void {
    for (let i = length - 1; i >= 0; i--) this.bits.push((value >>> i) & 1);
  }
}

/**
 * Encode `text` as UTF-8 in byte mode.
 *
 * Byte mode rather than alphanumeric even for an all-digit code: the band code
 * is a station prefix plus a ULID plus an HMAC, and mode switching to save a few
 * modules on the digits would mean two code paths to be wrong in.
 */
export function encodeQr(text: string, ecc: QrEcc = 'M', minVersion = 1): QrMatrix {
  const data = new TextEncoder().encode(text);

  let version = -1;
  for (let v = Math.max(1, minVersion); v <= 40; v++) {
    const capacityBits = dataCodewords(v, ecc) * 8;
    const countBits = v <= 9 ? 8 : 16;
    if (4 + countBits + data.length * 8 <= capacityBits) {
      version = v;
      break;
    }
  }
  if (version < 0) {
    throw new Error(
      `QR payload of ${data.length} bytes does not fit version 40 at error correction ${ecc}`,
    );
  }

  const bb = new BitBuffer();
  bb.push(0b0100, 4); // byte mode
  bb.push(data.length, version <= 9 ? 8 : 16);
  for (const b of data) bb.push(b, 8);

  const capacityBits = dataCodewords(version, ecc) * 8;
  bb.push(0, Math.min(4, capacityBits - bb.bits.length));
  bb.push(0, (8 - (bb.bits.length % 8)) % 8);
  for (let pad = 0xec; bb.bits.length < capacityBits; pad ^= 0xec ^ 0x11) bb.push(pad, 8);

  const codewords = new Uint8Array(bb.bits.length / 8);
  bb.bits.forEach((bit, i) => {
    if (bit) codewords[i >>> 3] = (codewords[i >>> 3] ?? 0) | (0x80 >>> (i & 7));
  });

  const allCodewords = addEccAndInterleave(codewords, version, ecc);
  return buildMatrix(allCodewords, version, ecc);
}

function addEccAndInterleave(data: Uint8Array, version: number, ecc: QrEcc): Uint8Array {
  const numBlocks = NUM_ECC_BLOCKS[ecc][version] ?? 1;
  const blockEccLen = ECC_CODEWORDS_PER_BLOCK[ecc][version] ?? 0;
  const rawCodewords = Math.floor(rawDataModules(version) / 8);
  const numShortBlocks = numBlocks - (rawCodewords % numBlocks);
  const shortBlockLen = Math.floor(rawCodewords / numBlocks);

  const generator = rsGenerator(blockEccLen);
  // Every block is padded to the same length so one interleaving pass covers
  // data and error correction together. The padding byte sits at the index a
  // short block has no data codeword for, and the interleave skips exactly
  // that index — get this wrong and the symbol still looks like a QR code and
  // decodes to noise.
  const blocks: Uint8Array[] = [];
  for (let i = 0, k = 0; i < numBlocks; i++) {
    const dataLen = shortBlockLen - blockEccLen + (i < numShortBlocks ? 0 : 1);
    const dat = data.subarray(k, k + dataLen);
    k += dataLen;
    const block = new Uint8Array(shortBlockLen + 1);
    block.set(dat);
    block.set(rsRemainder(dat, generator), shortBlockLen + 1 - blockEccLen);
    blocks.push(block);
  }

  const out = new Uint8Array(rawCodewords);
  let at = 0;
  for (let i = 0; i <= shortBlockLen; i++) {
    for (let j = 0; j < blocks.length; j++) {
      if (i === shortBlockLen - blockEccLen && j < numShortBlocks) continue;
      out[at++] = blocks[j]?.[i] ?? 0;
    }
  }
  return out;
}

function buildMatrix(codewords: Uint8Array, version: number, ecc: QrEcc): QrMatrix {
  const size = version * 4 + 17;
  const modules = new Array<boolean>(size * size).fill(false);
  const reserved = new Array<boolean>(size * size).fill(false);
  const idx = (x: number, y: number) => y * size + x;
  const put = (x: number, y: number, dark: boolean) => {
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    modules[idx(x, y)] = dark;
    reserved[idx(x, y)] = true;
  };

  // Timing patterns.
  for (let i = 0; i < size; i++) {
    put(6, i, i % 2 === 0);
    put(i, 6, i % 2 === 0);
  }

  // Finder patterns plus their separators.
  for (const [fx, fy] of [
    [0, 0],
    [size - 7, 0],
    [0, size - 7],
  ] as const) {
    for (let dy = -1; dy <= 7; dy++) {
      for (let dx = -1; dx <= 7; dx++) {
        const x = fx + dx;
        const y = fy + dy;
        if (x < 0 || y < 0 || x >= size || y >= size) continue;
        const d = Math.max(Math.abs(dx - 3), Math.abs(dy - 3));
        put(x, y, d !== 2 && d <= 3);
      }
    }
  }

  // Alignment patterns, skipping the three finder corners.
  const positions = alignmentPositions(version);
  for (let i = 0; i < positions.length; i++) {
    for (let j = 0; j < positions.length; j++) {
      const corner =
        (i === 0 && j === 0) ||
        (i === 0 && j === positions.length - 1) ||
        (i === positions.length - 1 && j === 0);
      if (corner) continue;
      const cx = positions[i] ?? 0;
      const cy = positions[j] ?? 0;
      for (let dy = -2; dy <= 2; dy++)
        for (let dx = -2; dx <= 2; dx++)
          put(cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    }
  }

  // Reserve the format areas; the dark module is always set.
  for (let i = 0; i < 9; i++) {
    put(i, 8, false);
    put(8, i, false);
  }
  for (let i = 0; i < 8; i++) {
    put(size - 1 - i, 8, false);
    put(8, size - 1 - i, false);
  }
  put(8, size - 8, true);

  if (version >= 7) {
    let rem = version;
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    const bits = (version << 12) | rem;
    for (let i = 0; i < 18; i++) {
      const dark = ((bits >>> i) & 1) !== 0;
      put(size - 11 + (i % 3), Math.floor(i / 3), dark);
      put(Math.floor(i / 3), size - 11 + (i % 3), dark);
    }
  }

  // Data, in the two-column zigzag from the bottom right.
  let bitIndex = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? size - 1 - vert : vert;
        if (reserved[idx(x, y)]) continue;
        const byte = codewords[bitIndex >>> 3] ?? 0;
        modules[idx(x, y)] = ((byte >>> (7 - (bitIndex & 7))) & 1) !== 0;
        bitIndex++;
      }
    }
  }

  // Try every mask, keep the least penalised — the standard's own rule.
  let bestMask = 0;
  let bestPenalty = Infinity;
  let bestModules = modules;
  for (let mask = 0; mask < 8; mask++) {
    const candidate = modules.slice();
    applyMask(candidate, reserved, size, mask);
    drawFormatBits(candidate, size, ecc, mask);
    const penalty = penaltyScore(candidate, size);
    if (penalty < bestPenalty) {
      bestPenalty = penalty;
      bestMask = mask;
      bestModules = candidate;
    }
  }
  void bestMask;

  const final = bestModules;
  return {
    size,
    version,
    ecc,
    modules: final,
    get: (x, y) => (x < 0 || y < 0 || x >= size || y >= size ? false : (final[y * size + x] ?? false)),
  };
}

function applyMask(modules: boolean[], reserved: boolean[], size: number, mask: number): void {
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      if (reserved[i]) continue;
      let invert: boolean;
      switch (mask) {
        case 0:
          invert = (x + y) % 2 === 0;
          break;
        case 1:
          invert = y % 2 === 0;
          break;
        case 2:
          invert = x % 3 === 0;
          break;
        case 3:
          invert = (x + y) % 3 === 0;
          break;
        case 4:
          invert = (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0;
          break;
        case 5:
          invert = ((x * y) % 2) + ((x * y) % 3) === 0;
          break;
        case 6:
          invert = (((x * y) % 2) + ((x * y) % 3)) % 2 === 0;
          break;
        default:
          invert = (((x + y) % 2) + ((x * y) % 3)) % 2 === 0;
          break;
      }
      if (invert) modules[i] = !modules[i];
    }
  }
}

function drawFormatBits(modules: boolean[], size: number, ecc: QrEcc, mask: number): void {
  const data = (ECC_FORMAT_BITS[ecc] << 3) | mask;
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  const bits = ((data << 10) | rem) ^ 0x5412;
  const set = (x: number, y: number, dark: boolean) => {
    modules[y * size + x] = dark;
  };
  for (let i = 0; i <= 5; i++) set(8, i, ((bits >>> i) & 1) !== 0);
  set(8, 7, ((bits >>> 6) & 1) !== 0);
  set(8, 8, ((bits >>> 7) & 1) !== 0);
  set(7, 8, ((bits >>> 8) & 1) !== 0);
  for (let i = 9; i < 15; i++) set(14 - i, 8, ((bits >>> i) & 1) !== 0);
  for (let i = 0; i < 8; i++) set(size - 1 - i, 8, ((bits >>> i) & 1) !== 0);
  for (let i = 8; i < 15; i++) set(8, size - 15 + i, ((bits >>> i) & 1) !== 0);
  set(8, size - 8, true);
}

function penaltyScore(modules: boolean[], size: number): number {
  const at = (x: number, y: number) => modules[y * size + x] ?? false;
  let score = 0;

  // Rule 1: runs of five or more of the same colour, in both directions.
  for (let y = 0; y < size; y++) {
    let run = 1;
    for (let x = 1; x < size; x++) {
      if (at(x, y) === at(x - 1, y)) {
        run++;
        if (run === 5) score += 3;
        else if (run > 5) score += 1;
      } else run = 1;
    }
  }
  for (let x = 0; x < size; x++) {
    let run = 1;
    for (let y = 1; y < size; y++) {
      if (at(x, y) === at(x, y - 1)) {
        run++;
        if (run === 5) score += 3;
        else if (run > 5) score += 1;
      } else run = 1;
    }
  }

  // Rule 2: 2x2 blocks of one colour.
  for (let y = 0; y < size - 1; y++)
    for (let x = 0; x < size - 1; x++)
      if (at(x, y) === at(x + 1, y) && at(x, y) === at(x, y + 1) && at(x, y) === at(x + 1, y + 1))
        score += 3;

  // Rule 3: the finder-like 1:1:3:1:1 pattern with four light modules beside it.
  const pattern = [true, false, true, true, true, false, true];
  const matches = (get: (i: number) => boolean, start: number, len: number): boolean => {
    for (let i = 0; i < 7; i++) if (get(start + i) !== pattern[i]) return false;
    let before = true;
    for (let i = start - 4; i < start; i++) if (i >= 0 && get(i)) before = false;
    let after = true;
    for (let i = start + 7; i < start + 11; i++) if (i < len && get(i)) after = false;
    return before || after;
  };
  for (let y = 0; y < size; y++)
    for (let x = 0; x <= size - 7; x++)
      if (matches((i) => at(i, y), x, size)) score += 40;
  for (let x = 0; x < size; x++)
    for (let y = 0; y <= size - 7; y++)
      if (matches((i) => at(x, i), y, size)) score += 40;

  // Rule 4: deviation from an even split of dark and light.
  let dark = 0;
  for (const m of modules) if (m) dark++;
  const total = size * size;
  const k = Math.floor((Math.abs(dark * 20 - total * 10) * 10) / total);
  score += k * 10;

  return score;
}

export { ECC_ORDER };
