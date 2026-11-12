import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApiSalePrintJob } from '@/api/history';
import { printApi, type ApiStationPrinter } from '@/api/platform';
import { ReprintHistory } from '@/components/history/SaleDetail';
import { PrinterHealthIndicator } from '@/components/shared/PrinterHealthIndicator';
import { platformPrintOutcome } from '@/lib/salePrinting';
import { settle } from './support/fixtures';
import { renderHook } from './support/hooks';

/**
 * SCRUM-899 — WHERE THE BOX SKIPS A JOB BECAUSE ITS PRINTER HAS NO ADDRESS,
 * THE TILL SAYS SO.
 *
 * The box skips every job routed to a printer saved without an address
 * (`DEVICE_NO_ADDRESS`, packages/box-agent/src/printing/queue.ts). Until now
 * the till read any skipped job as "no printer at this station" — sending
 * somebody to look for a printer that is there — and its header said nothing
 * at all. The Console's print queue already printed the box's own sentence
 * ("… has no address, so there is nothing to open") and is left as it was.
 */

vi.mock('react', async (original) => ({ ...await original<typeof import('react')>(), ...await import('./support/hooks') }));
vi.mock('@/station/StationContext', () => ({ useStation: () => ({ station: { stationId: 'station-1' }, active: { id: 'station-1' } }) }));
vi.mock('wouter', () => ({ useLocation: () => ['/', vi.fn()] }));
vi.mock('@/auth/OperatorContext', () => ({
  useOperator: () => ({ operator: { id: 'acc-som', name: 'Som' }, can: () => true, offlineUnlock: null }),
}));

beforeEach(() => {
  vi.stubGlobal('React', React);
});
afterEach(() => {
  vi.restoreAllMocks();
});

const job = (overrides: Partial<ApiSalePrintJob> & Pick<ApiSalePrintJob, 'id' | 'kind' | 'status'>): ApiSalePrintJob => ({
  role: 'dropoff_band',
  stationId: 'station-1',
  deviceId: 'device-1',
  deviceLabel: 'ZZ TEST drop-off band printer',
  subjectType: 'band',
  subjectId: 'band-1',
  reprintOf: null,
  reprintReason: null,
  requestedByName: null,
  errorCode: null,
  errorMessage: null,
  queuedAt: '2026-11-12T07:00:00.000Z',
  finishedAt: null,
  ...overrides,
});

const noAddress = (overrides: Partial<ApiSalePrintJob> = {}) =>
  job({
    id: 'j1',
    kind: 'kids_wristband',
    status: 'skipped',
    errorCode: 'DEVICE_NO_ADDRESS',
    errorMessage: 'ZZ TEST drop-off band printer has no address, so there is nothing to open',
    ...overrides,
  });

describe('the till’s print toast', () => {
  it('names the printer and says it has no address, instead of "no printer at this station"', () => {
    expect(platformPrintOutcome([noAddress()]).notPrinted).toEqual([
      'Kids bracelet not printed — ZZ TEST drop-off band printer has no address, so nothing prints on it',
    ]);
    // Said even beside the platform's own notes, which cannot know of the box's skip.
    expect(platformPrintOutcome([noAddress()], ['Bar ticket not printed — no bar printer at this station']).notPrinted).toEqual([
      'Bar ticket not printed — no bar printer at this station',
      'Kids bracelet not printed — ZZ TEST drop-off band printer has no address, so nothing prints on it',
    ]);
    // With no label on the job, the printer is named by its job.
    expect(platformPrintOutcome([noAddress({ deviceLabel: null, role: 'kids_band' })]).notPrinted).toEqual([
      'Kids bracelet not printed — Kids band printer has no address, so nothing prints on it',
    ]);
  });

  it('leaves a job skipped for want of a printer as it was', () => {
    const skipped = job({ id: 'j2', kind: 'bar_ticket', status: 'skipped', role: 'bar', deviceId: null, deviceLabel: null });
    expect(platformPrintOutcome([skipped]).notPrinted).toEqual(['Bar ticket not printed — no bar printer at this station']);
  });
});

describe('History’s reprint card', () => {
  it('says a copy skipped for a printer without an address was not printed for that reason, and names the printer', () => {
    const original = job({ id: 'j0', kind: 'kids_wristband', status: 'printed', deviceLabel: 'Band Printer (kids)' });
    const html = renderToStaticMarkup(
      React.createElement(ReprintHistory, {
        jobs: [original, noAddress({ id: 'j3', reprintOf: 'j0' })],
        bands: [],
        madeBy: {},
        fmt: (iso: string) => iso.slice(11, 16),
      }),
    );
    expect(html).toContain('Not printed — this printer has no address · ZZ TEST drop-off band printer');
    expect(html).not.toContain('no printer for it here');
  });

  it('keeps "no printer for it here" for a copy no printer was assigned for', () => {
    const original = job({ id: 'j0', kind: 'receipt', status: 'printed' });
    const html = renderToStaticMarkup(
      React.createElement(ReprintHistory, {
        jobs: [original, job({ id: 'j4', kind: 'receipt', status: 'skipped', reprintOf: 'j0', deviceLabel: null })],
        bands: [],
        madeBy: {},
        fmt: (iso: string) => iso.slice(11, 16),
      }),
    );
    expect(html).toContain('Not printed — no printer for it here');
  });
});

describe('the printer light in the till’s header', () => {
  const printer = (over: Partial<ApiStationPrinter>): ApiStationPrinter => ({
    deviceId: '01965000-0000-7000-8000-000000000001',
    label: 'ZZ TEST drop-off band printer',
    role: 'dropoff_band',
    kind: 'band_printer',
    reachability: 'unknown',
    paperStatus: 'unknown',
    lastError: null,
    lastSeenAt: null,
    queued: 0,
    ...over,
  });

  async function light(printers: ApiStationPrinter[]) {
    vi.spyOn(printApi, 'stationPrinters').mockResolvedValue({ printers });
    const hook = renderHook(() => PrinterHealthIndicator());
    await settle();
    const shown = hook.result.current as React.ReactElement<{ title?: string }> | null;
    hook.unmount();
    return shown?.props.title ?? null;
  }

  it('turns red and says the printer has no address, as the box reported it', async () => {
    expect(await light([printer({ lastError: 'DEVICE_NO_ADDRESS' })])).toBe('ZZ TEST drop-off band printer: no address set');
  });

  it('stays quiet for a printer that is well', async () => {
    expect(await light([printer({ reachability: 'reachable', paperStatus: 'ok' })])).toBeNull();
  });
});
