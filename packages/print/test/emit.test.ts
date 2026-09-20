import { describe, expect, it } from 'vitest';
import {
  decodeLabelStatus,
  decodeStatus,
  drawerKick,
  emitEscpos,
  emitTspl,
  feedDots,
  layoutDocument,
  render,
  renderJob,
  statusQuery,
  ESCPOS,
  TSPL,
} from '../src/index';
import { parseEscpos, parseTsplBitmap, tsplSetupLines } from './escpos-reader';
import { PROFILES, TEMPLATES } from './fixtures';
import { FIXTURES } from './fixtures';
import { fixtureJob } from './render-fixture';

const escpos576 = PROFILES.escpos576!;
const escpos512 = PROFILES.escpos512!;
const tspl400 = PROFILES.tspl400!;

describe('the emitted bytes are the rendered bitmap', () => {
  // This proves the emitters carry the rendered dots and nothing else: parse
  // the wire format back and it is the same bitmap. It does *not* prove there
  // is only one renderer — add `previewHtml()` or a second rasteriser and
  // every assertion here stays green, because nothing here looks at the
  // preview. `single-renderer.test.ts` is what enforces that.
  for (const fixture of FIXTURES) {
    for (const profileKey of fixture.profiles) {
      const device = PROFILES[profileKey]!;
      it(`${fixture.name} on ${profileKey} round-trips through the wire format`, () => {
        const job = renderJob(fixtureJob(fixture, profileKey), { device, templates: TEMPLATES });
        const back =
          device.language === 'tspl2'
            ? parseTsplBitmap(job.bytes, device.widthDots)
            : parseEscpos(job.bytes, device.widthDots).bitmap;
        expect(back.width).toBe(job.bitmap.width);
        expect(back.height).toBeGreaterThanOrEqual(job.bitmap.height);
        expect(back.data.subarray(0, job.bitmap.data.length)).toEqual(job.bitmap.data);
      });
    }
  }
});

describe('ESC/POS job frame', () => {
  const job = renderJob(
    { kind: 'receipt', data: { title: 'Receipt', lines: [], total: '฿0' } },
    { device: escpos576, templates: TEMPLATES, finish: { drawerKick: { pin: 0, onMs: 50, offMs: 500 } } },
  );
  const parsed = parseEscpos(job.bytes, 576);

  it('initialises, bands the image and cuts once', () => {
    expect(parsed.initialised).toBe(true);
    expect(parsed.bands).toBeGreaterThan(0);
    expect(parsed.cuts).toBe(1);
    expect(parsed.unknown).toEqual([]);
  });

  it('kicks the drawer before the cut', () => {
    const kickAt = indexOfSequence(job.bytes, drawerKick(0, 50, 500));
    const cutAt = indexOfSequence(job.bytes, ESCPOS.partialCut);
    expect(kickAt).toBeGreaterThan(-1);
    expect(cutAt).toBeGreaterThan(kickAt);
    expect(parsed.drawerKicks).toEqual([{ pin: 0, onMs: 50, offMs: 500 }]);
  });

  it('feeds dots before the cut, because feedDots is dots', () => {
    // ESC d feeds *lines* — about 33.8 dots each at 203 dpi — so the old
    // `ESC d ceil(96/24)` fed roughly 135 dots for a field that asked for 96.
    const feed = renderJob(
      { kind: 'receipt', data: { title: 'Receipt', lines: [], total: '฿0' } },
      { device: escpos576, templates: TEMPLATES, finish: { feedDots: 96, cut: 'partial' } },
    );
    const back = parseEscpos(feed.bytes, 576);
    expect(back.dotFeeds).toEqual([96]);
    expect(back.feeds).toEqual([]);
    expect(back.unknown).toEqual([]);
  });

  it('splits a feed longer than one ESC J byte', () => {
    // ESC J takes a single byte, so 600 dots is 255 + 255 + 90.
    expect([...feedDots(600)]).toEqual([0x1b, 0x4a, 255, 0x1b, 0x4a, 255, 0x1b, 0x4a, 90]);
    expect([...feedDots(0)]).toEqual([]);
  });

  it('bands at the device band height so a job stays inside the input buffer', () => {
    // 128 rows at 576 dots is 9216 bytes a band; the G4's buffer is 128 KB and
    // the XP-80 family's 64 or 256 KB (§9.3, §9.4).
    const tall = renderJob(
      { kind: 'receipt', data: { title: 'Receipt', lines: manyLines(120), total: '฿0' } },
      { device: escpos576, templates: TEMPLATES },
    );
    const back = parseEscpos(tall.bytes, 576);
    expect(back.bands).toBe(Math.ceil(tall.bitmap.height / 128));
  });

  it('refuses a bitmap wider than the head rather than letting GS v 0 drop it', () => {
    const wide = renderJob(
      { kind: 'receipt', data: { title: 'Receipt', lines: [], total: '฿0' } },
      { device: escpos576, templates: TEMPLATES },
    );
    expect(() => emitEscpos(wide.bitmap, { device: escpos512, finish: { cut: 'partial' } })).toThrow(
      /576 dots wide but .* prints 512/,
    );
  });

  it('never emits a full cut, which this hardware does not have', () => {
    expect(indexOfSequence(job.bytes, Uint8Array.from([0x1d, 0x56, 0x00]))).toBe(-1);
  });
});

describe('ESC/POS status', () => {
  it('builds the four DLE EOT queries', () => {
    expect([...statusQuery(1)]).toEqual([0x10, 0x04, 1]);
    expect([...statusQuery(4)]).toEqual([0x10, 0x04, 4]);
  });

  it('reads an idle reply as 0x12', () => {
    expect(decodeStatus(1, 0x12)).toEqual({ drawerOpen: false, offline: false });
  });

  it('reads paper out and cover open', () => {
    expect(decodeStatus(2, 0x12 | 0x20).paperEnd).toBe(true);
    expect(decodeStatus(2, 0x12 | 0x04).coverOpen).toBe(true);
    expect(decodeStatus(4, 0x12 | 0x60).paperEnd).toBe(true);
    expect(decodeStatus(4, 0x12 | 0x0c).paperNearEnd).toBe(true);
    expect(decodeStatus(3, 0x12 | 0x08).cutterError).toBe(true);
  });

  it('refuses a byte that is not a status reply', () => {
    // Bits 1 and 4 are always set and 0 and 7 always clear; 0x00 is the tail of
    // something else, not a printer that is fine.
    expect(() => decodeStatus(1, 0x00)).toThrow(/not a DLE EOT reply/);
  });
});

describe('TSPL2 job', () => {
  const job = renderJob(
    {
      kind: 'kids_wristband',
      data: { holderName: 'Mali', bandCode: 'HKT1:01J8Z4M2QR', shortCode: 'HKT1-4821' },
    },
    { device: tspl400, templates: TEMPLATES },
  );
  const setup = tsplSetupLines(job.bytes);

  it('declares the media, then clears the buffer', () => {
    expect(setup).toEqual([
      'SIZE 50 mm,250 mm',
      'GAP 3 mm,0 mm',
      'DIRECTION 1',
      'REFERENCE 0,0',
      'DENSITY 10',
      'SPEED 4',
      'SET TEAR ON',
      'CLS',
    ]);
  });

  it('omits SET RESPONSE unless the profile says the firmware has it', () => {
    expect(setup).not.toContain('SET RESPONSE ON');
    const withAck = emitTspl(job.bitmap, {
      device: { ...tspl400, perLabelAck: true },
      finish: { copies: 1 },
    });
    expect(tsplSetupLines(withAck)).toContain('SET RESPONSE ON');
  });

  it('ends with PRINT', () => {
    const text = new TextDecoder('latin1').decode(job.bytes);
    expect(text.endsWith('PRINT 1,1\r\n')).toBe(true);
  });

  it('inverts the bitmap, because a 0 bit prints black in TSPL', () => {
    const layout = layoutDocument(job.document);
    const bitmap = render(layout);
    const raw = job.bytes;
    const marker = new TextEncoder().encode('BITMAP ');
    const at = indexOfSequence(raw, marker);
    // Find the byte after the fifth comma and compare it to the inverse.
    let commas = 0;
    let i = at;
    while (commas < 5) {
      if (raw[i] === 0x2c) commas++;
      i++;
    }
    expect(raw[i]).toBe(~(bitmap.data[0] ?? 0) & 0xff);
  });

  it('reads the single status byte ESC ! ? returns', () => {
    expect([...TSPL.statusQuery]).toEqual([0x1b, 0x21, 0x3f]);
    expect(decodeLabelStatus(0x00).ready).toBe(true);
    expect(decodeLabelStatus(0x04).paperOut).toBe(true);
    expect(decodeLabelStatus(0x01).headOpen).toBe(true);
    expect(decodeLabelStatus(0x05)).toMatchObject({ headOpen: true, paperOut: true, ready: false });
  });

  it('refuses a label job with no media size on the profile', () => {
    const { media: _media, ...noMedia } = tspl400;
    expect(() => emitTspl(job.bitmap, { device: noMedia, finish: {} })).toThrow(/no media size/);
  });
});

function indexOfSequence(haystack: Uint8Array, needle: Uint8Array): number {
  outer: for (let i = 0; i + needle.length <= haystack.length; i++) {
    for (let k = 0; k < needle.length; k++) if (haystack[i + k] !== needle[k]) continue outer;
    return i;
  }
  return -1;
}

function manyLines(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    qty: 1,
    name: `Item ${i + 1}`,
    price: '฿100',
  }));
}
