// Deterministic mock QR pattern used by the on-screen <QrCode> for INTERNAL
// codes (booking reference, bracelets/credit grants redeemed at reception). These
// are scanned by the venue's own system, so a stylised pattern is fine.
// For payment QRs that must be scanned by external banking apps, use a real
// encoder instead (see lib/promptpay.ts + the `qrcode` package).

export interface QrMatrix {
  size: number;
  cells: boolean[];
  isFinder: (r: number, c: number) => boolean;
}

export function buildQrMatrix(seed: string, size = 11): QrMatrix {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  const cells: boolean[] = [];
  for (let i = 0; i < size * size; i++) {
    h = (Math.imul(h, 1103515245) + 12345) >>> 0;
    cells.push((h & 64) !== 0);
  }
  const isFinder = (r: number, c: number) => {
    const inBox = (br: number, bc: number) =>
      r >= br && r < br + 3 && c >= bc && c < bc + 3;
    return inBox(0, 0) || inBox(0, size - 3) || inBox(size - 3, 0);
  };
  return { size, cells, isFinder };
}
