/**
 * A QR reader, for tests only: matrix in, text out.
 *
 * It walks the format the other way from the encoder — read the format bits to
 * find the mask, unmask, pull the data modules out in the same zigzag,
 * de-interleave the blocks and read the bit stream — so an encoder bug that
 * would stop a band scanning at the gate shows up here instead.
 *
 * Error correction is not applied: the matrix comes straight from the encoder,
 * so any corruption is a bug on our side and should fail loudly.
 */

import type { QrEcc, QrMatrix } from '../src/codes/qr';

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

function rawDataModules(version: number): number {
  let result = (16 * version + 128) * version + 64;
  if (version >= 2) {
    const numAlign = Math.floor(version / 7) + 2;
    result -= (25 * numAlign - 10) * numAlign - 55;
    if (version >= 7) result -= 36;
  }
  return result;
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

function reservedMap(version: number): boolean[] {
  const size = version * 4 + 17;
  const reserved = new Array<boolean>(size * size).fill(false);
  const mark = (x: number, y: number) => {
    if (x >= 0 && y >= 0 && x < size && y < size) reserved[y * size + x] = true;
  };
  for (let i = 0; i < size; i++) {
    mark(6, i);
    mark(i, 6);
  }
  for (const [fx, fy] of [
    [0, 0],
    [size - 7, 0],
    [0, size - 7],
  ] as const) {
    for (let dy = -1; dy <= 7; dy++) for (let dx = -1; dx <= 7; dx++) mark(fx + dx, fy + dy);
  }
  const positions = alignmentPositions(version);
  for (let i = 0; i < positions.length; i++) {
    for (let j = 0; j < positions.length; j++) {
      const corner =
        (i === 0 && j === 0) ||
        (i === 0 && j === positions.length - 1) ||
        (i === positions.length - 1 && j === 0);
      if (corner) continue;
      for (let dy = -2; dy <= 2; dy++)
        for (let dx = -2; dx <= 2; dx++) mark((positions[i] ?? 0) + dx, (positions[j] ?? 0) + dy);
    }
  }
  for (let i = 0; i < 9; i++) {
    mark(i, 8);
    mark(8, i);
  }
  for (let i = 0; i < 8; i++) {
    mark(size - 1 - i, 8);
    mark(8, size - 1 - i);
  }
  mark(8, size - 8);
  if (version >= 7) {
    for (let i = 0; i < 18; i++) {
      mark(size - 11 + (i % 3), Math.floor(i / 3));
      mark(Math.floor(i / 3), size - 11 + (i % 3));
    }
  }
  return reserved;
}

function maskBit(mask: number, x: number, y: number): boolean {
  switch (mask) {
    case 0:
      return (x + y) % 2 === 0;
    case 1:
      return y % 2 === 0;
    case 2:
      return x % 3 === 0;
    case 3:
      return (x + y) % 3 === 0;
    case 4:
      return (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0;
    case 5:
      return ((x * y) % 2) + ((x * y) % 3) === 0;
    case 6:
      return (((x * y) % 2) + ((x * y) % 3)) % 2 === 0;
    default:
      return (((x + y) % 2) + ((x * y) % 3)) % 2 === 0;
  }
}

/** Read the mask number back out of the format information. */
function readMask(matrix: QrMatrix): number {
  let bits = 0;
  for (let i = 0; i <= 5; i++) if (matrix.get(8, i)) bits |= 1 << i;
  if (matrix.get(8, 7)) bits |= 1 << 6;
  if (matrix.get(8, 8)) bits |= 1 << 7;
  if (matrix.get(7, 8)) bits |= 1 << 8;
  for (let i = 9; i < 15; i++) if (matrix.get(14 - i, 8)) bits |= 1 << i;
  const data = (bits ^ 0x5412) >>> 10;
  return data & 0b111;
}

export function decodeQrMatrix(matrix: QrMatrix): string {
  const { size, version, ecc } = matrix;
  const mask = readMask(matrix);
  const reserved = reservedMap(version);

  const bits: number[] = [];
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? size - 1 - vert : vert;
        if (reserved[y * size + x]) continue;
        const dark = matrix.get(x, y) !== maskBit(mask, x, y);
        bits.push(dark ? 1 : 0);
      }
    }
  }

  const interleaved = new Uint8Array(bits.length >> 3);
  bits.forEach((bit, i) => {
    if (bit) interleaved[i >> 3] = (interleaved[i >> 3] ?? 0) | (0x80 >> (i & 7));
  });

  // Undo the block interleave to recover the data codewords in order.
  const numBlocks = NUM_ECC_BLOCKS[ecc][version] ?? 1;
  const blockEccLen = ECC_CODEWORDS_PER_BLOCK[ecc][version] ?? 0;
  const rawCodewords = Math.floor(rawDataModules(version) / 8);
  const numShortBlocks = numBlocks - (rawCodewords % numBlocks);
  const shortBlockLen = Math.floor(rawCodewords / numBlocks);

  const blockData: number[][] = Array.from({ length: numBlocks }, () =>
    new Array<number>(shortBlockLen + 1).fill(0),
  );
  let at = 0;
  for (let i = 0; i <= shortBlockLen; i++) {
    for (let j = 0; j < numBlocks; j++) {
      if (i === shortBlockLen - blockEccLen && j < numShortBlocks) continue;
      const block = blockData[j];
      if (block) block[i] = interleaved[at++] ?? 0;
    }
  }
  const data = blockData.flatMap((block, j) =>
    block.slice(0, shortBlockLen - blockEccLen + (j < numShortBlocks ? 0 : 1)),
  );

  // Byte mode: 4-bit mode indicator, then the length, then the bytes.
  let bitAt = 0;
  const readBits = (n: number): number => {
    let value = 0;
    for (let i = 0; i < n; i++) {
      const byte = data[bitAt >> 3] ?? 0;
      value = (value << 1) | ((byte >> (7 - (bitAt & 7))) & 1);
      bitAt++;
    }
    return value;
  };
  const mode = readBits(4);
  if (mode !== 0b0100) throw new Error(`expected byte mode, got mode ${mode.toString(2)}`);
  const length = readBits(version <= 9 ? 8 : 16);
  const bytes = new Uint8Array(length);
  for (let i = 0; i < length; i++) bytes[i] = readBits(8);
  return new TextDecoder().decode(bytes);
}
