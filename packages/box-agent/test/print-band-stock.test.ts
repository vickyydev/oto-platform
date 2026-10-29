import assert from 'node:assert/strict';
import { test } from 'node:test';

import { renderJob } from '@oto/print';
import type { BoxConfigDevice } from '../src/protocol';
import { profileFor } from '../src/printing/queue';
import { TILL_KIDS_BAND_PRINTER, tillBundle } from './_support';

/**
 * The band printer's roll, as its row describes it, reaches the TSPL job.
 *
 * The park's wristband stock carries a black mark on the back of each band
 * rather than a gap between labels, and is pre-printed with a white window
 * part-way along its length. Neither is something the printer can tell on its
 * own, so `settings.label` says so and `profileFor` carries it into the
 * profile the renderer emits from.
 */

const BAND = {
  kind: 'kids_wristband' as const,
  data: { holderName: 'Mali', bandCode: 'HKT1:01J8Z4M2QR', shortCode: 'HKT1-4821' },
};

function kidsBandPrinter(settings: unknown): BoxConfigDevice {
  const device = tillBundle().stations[0]!.devices.find((d) => d.id === TILL_KIDS_BAND_PRINTER);
  assert.ok(device, 'the till bundle has a kids band printer');
  return { ...device, settings };
}

/** The job's TSPL setup, the lines before the bitmap. */
function setupLines(bytes: Uint8Array): string[] {
  const text = new TextDecoder('latin1').decode(bytes);
  const bitmapAt = text.indexOf('BITMAP ');
  assert.ok(bitmapAt > 0, 'the job carries a bitmap');
  return text.slice(0, bitmapAt).split('\r\n').filter((line) => line.length > 0);
}

test('a row that says black mark prints with BLINE and the mark height, never GAP', () => {
  const device = kidsBandPrinter({ label: { sensing: 'bline', gapMm: 3 } });
  const profile = profileFor(device);
  assert.equal(profile.media?.sensing, 'bline');
  assert.equal(profile.media?.gapMm, 3);

  const setup = setupLines(renderJob(BAND, { device: profile, templates: [] }).bytes);
  assert.ok(setup.includes('BLINE 3 mm,0 mm'), setup.join(' | '));
  assert.ok(!setup.some((line) => line.startsWith('GAP ')), setup.join(' | '));
});

test('a row that says nothing about sensing keeps the gap default', () => {
  const device = kidsBandPrinter({ label: { gapMm: 3 } });
  const setup = setupLines(renderJob(BAND, { device: profileFor(device), templates: [] }).bytes);
  assert.ok(setup.includes('GAP 3 mm,0 mm'), setup.join(' | '));
  assert.ok(!setup.some((line) => line.startsWith('BLINE ')), setup.join(' | '));
});

test('the print window moves the origin down the band and bounds the layout', () => {
  const device = kidsBandPrinter({
    label: { labelWidthMm: 25, labelHeightMm: 254, sensing: 'bline', gapMm: 3, printOffsetMm: 60, printLengthMm: 120 },
  });
  const profile = profileFor(device);
  assert.equal(profile.media?.printOffsetMm, 60);
  assert.equal(profile.media?.printLengthMm, 120);

  const job = renderJob(BAND, { device: profile, templates: [] });
  const setup = setupLines(job.bytes);
  // The printer still feeds the whole band to the next mark.
  assert.ok(setup.includes('SIZE 25 mm,254 mm'), setup.join(' | '));
  // 60 mm at 8 dots/mm.
  assert.ok(setup.includes('REFERENCE 0,480'), setup.join(' | '));
  // The content was fitted to the window, not to the band.
  assert.equal(job.document.media.heightDots, 960);
  assert.ok(job.layout.heightDots <= 960, `content is ${job.layout.heightDots} dots tall`);
  assert.deepEqual(job.overflow, []);
});

test('no window on the row means the origin at the top and the whole band', () => {
  const profile = profileFor(kidsBandPrinter({ label: { labelHeightMm: 254 } }));
  assert.equal(profile.media?.printOffsetMm, undefined);
  assert.equal(profile.media?.printLengthMm, undefined);
  const job = renderJob(BAND, { device: profile, templates: [] });
  assert.ok(setupLines(job.bytes).includes('REFERENCE 0,0'));
  assert.equal(job.document.media.heightDots, 2032);
});
