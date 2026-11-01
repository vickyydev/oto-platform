import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ScannerHealthLine } from '@/components/devices/BoxDrawer';
import type { ScannerHealthView } from '@/lib/scannerSetup';

/**
 * SCRUM-700 — the scanner's line on the box drawer's device panel: what the
 * box last said about the cradle it reads, in words a person at the counter
 * can act on.
 */

const markup = (health: ScannerHealthView) =>
  renderToStaticMarkup(createElement(ScannerHealthLine, { health, timezone: 'Asia/Bangkok' }));

describe('ScannerHealthLine', () => {
  it('says the box is reading the scanner, and when it last read a code', () => {
    const html = markup({
      mode: 'hid',
      present: true,
      open: true,
      path: '/dev/input/event4',
      lastScanAt: new Date(Date.now() - 120_000).toISOString(),
      scans: 3,
      dropped: 0,
    });
    expect(html).toContain('Reading /dev/input/event4');
    expect(html).toMatch(/last scan 2m ago/);
    expect(html).not.toContain('dropped');
  });

  it('says it is not plugged in, that nothing was read, and counts dropped partial scans', () => {
    const html = markup({
      mode: 'cdc',
      present: false,
      open: false,
      path: null,
      lastScanAt: null,
      scans: 0,
      dropped: 2,
    });
    expect(html).toContain('Not plugged into this box');
    expect(html).toContain('no scan since the box started');
    expect(html).toContain('2 partial scans dropped');
  });
});
