/**
 * `Bitmap1` — one bit per dot, MSB first, rows padded to a byte.
 *
 * This is deliberately the exact memory layout ESC/POS `GS v 0` wants, so the
 * emitter slices rather than converts. TSPL's `BITMAP` wants the inverse
 * polarity (a 0 bit prints black there, a 1 bit prints black here), which is
 * one XOR in that emitter and nothing here.
 *
 * A set bit means ink.
 */
export class Bitmap1 {
  readonly stride: number;
  readonly data: Uint8Array;

  constructor(
    readonly width: number,
    readonly height: number,
    data?: Uint8Array,
  ) {
    if (width <= 0 || height < 0) throw new Error(`bad bitmap size ${width}x${height}`);
    this.stride = (width + 7) >> 3;
    this.data = data ?? new Uint8Array(this.stride * height);
  }

  get(x: number, y: number): boolean {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return false;
    const byte = this.data[y * this.stride + (x >> 3)] ?? 0;
    return (byte & (0x80 >> (x & 7))) !== 0;
  }

  set(x: number, y: number, on: boolean): void {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return;
    const i = y * this.stride + (x >> 3);
    const mask = 0x80 >> (x & 7);
    const byte = this.data[i] ?? 0;
    this.data[i] = on ? byte | mask : byte & ~mask;
  }

  fillRect(x: number, y: number, w: number, h: number, on = true): void {
    for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) this.set(xx, yy, on);
  }

  /** Outline of a rectangle, `t` dots thick, drawn inside the bounds. */
  strokeRect(x: number, y: number, w: number, h: number, t = 1): void {
    this.fillRect(x, y, w, t);
    this.fillRect(x, y + h - t, w, t);
    this.fillRect(x, y, t, h);
    this.fillRect(x + w - t, y, t, h);
  }

  /** Flip every dot in a region — the native form of the DROP-OFF badge. */
  invertRect(x: number, y: number, w: number, h: number): void {
    for (let yy = y; yy < y + h; yy++)
      for (let xx = x; xx < x + w; xx++) this.set(xx, yy, !this.get(xx, yy));
    }

  blit(src: Bitmap1, dx: number, dy: number): void {
    for (let y = 0; y < src.height; y++)
      for (let x = 0; x < src.width; x++) if (src.get(x, y)) this.set(dx + x, dy + y, true);
  }

  /** A new bitmap of `height` rows starting at `top`; used to band a job. */
  slice(top: number, height: number): Bitmap1 {
    const out = new Bitmap1(this.width, height);
    const from = top * this.stride;
    out.data.set(this.data.subarray(from, from + height * this.stride));
    return out;
  }

  /** Same dots, a different number of rows. Extra rows are blank. */
  resizeHeight(height: number): Bitmap1 {
    const out = new Bitmap1(this.width, height);
    out.data.set(this.data.subarray(0, Math.min(this.data.length, out.data.length)));
    return out;
  }

  /** Last row with any ink, plus one. Lets a receipt end where its text ends. */
  inkHeight(): number {
    for (let y = this.height - 1; y >= 0; y--) {
      const row = y * this.stride;
      for (let b = 0; b < this.stride; b++) if ((this.data[row + b] ?? 0) !== 0) return y + 1;
    }
    return 0;
  }

  countInk(): number {
    let n = 0;
    for (const byte of this.data) {
      let b = byte;
      while (b) {
        n += b & 1;
        b >>= 1;
      }
    }
    return n;
  }
}
