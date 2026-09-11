import { buildQrMatrix } from '@/lib/qr';

// Render the discount's QR matrix to a PNG and trigger a download. The matrix is
// the same stylised internal pattern the on-screen <QrCode> draws, so the
// downloaded image matches what staff see in the console. An optional `label`
// (the discount's name) is printed small and faint under the code — readable up
// close, but unobtrusive.
export function downloadDiscountQr(
  seed: string,
  filename: string,
  label?: string
): void {
  const { size, cells, isFinder } = buildQrMatrix(seed);
  const cell = 24;
  const quiet = 2; // quiet zone, in cells
  const dim = (size + quiet * 2) * cell;
  const caption = label?.trim();
  // Extra strip below the matrix for the faint name caption.
  const captionH = caption ? cell * 2 : 0;

  const canvas = document.createElement('canvas');
  canvas.width = dim;
  canvas.height = dim + captionH;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#0f172a'; // slate-900, matches the on-screen QrCode

  for (let i = 0; i < cells.length; i++) {
    const r = Math.floor(i / size);
    const c = i % size;
    if (isFinder(r, c) || cells[i]) {
      ctx.fillRect((c + quiet) * cell, (r + quiet) * cell, cell, cell);
    }
  }

  if (caption) {
    ctx.fillStyle = '#aab2c0'; // faint slate — readable but not loud on white
    ctx.font = `${Math.round(cell * 0.7)}px ui-sans-serif, system-ui, -apple-system, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(caption, dim / 2, dim + captionH / 2, dim - cell * 2);
  }

  canvas.toBlob((blob) => {
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }, 'image/png');
}
