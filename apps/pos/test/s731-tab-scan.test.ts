import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, type RenderedHook } from './support/hooks';
import { readBenefitScan, readProductScan, readTabScan, readVoucherScan, type StationScanEvent } from '@/lib/scanChannel';
import {
  decideCounterTabScan,
  decideHistoryTabScan,
  ticketTillTabScanWords,
  useCounterTabScan,
  type CounterStage,
} from '@/lib/tabScan';
import { parseHistorySearch } from '@/api/history';
import { toast } from '@/hooks/use-toast';

/**
 * SCRUM-731 — a wristband or a credit voucher read at the counter's scanner.
 *
 * With the cradle in the box a band reached the till and nothing heard it, and a
 * credit voucher did not reach it at all. It now opens what the same code opens
 * when typed, through the same form, and only where a typed code could: so the
 * same child gets the same allergy banner, and the sale on screen is never
 * changed by a scan. Everything else says so in words.
 */
vi.mock('react', () => import('./support/hooks'));
vi.mock('@/hooks/use-toast', () => ({ toast: vi.fn() }));

const event = (over: Partial<StationScanEvent>): StationScanEvent => ({
  kind: 'scan',
  source: 'box_hid',
  codeKind: 'band',
  codeFingerprint: 'f'.repeat(16),
  outcome: 'handled',
  handler: 'band',
  errorCode: null,
  detail: { band: { bandId: 'b', prefix: 'T1', shortCode: 'T1-7KMQ4X', mintedAt: null }, message: 'Band T1-7KMQ4X' },
  actionId: null,
  scannedAt: new Date().toISOString(),
  ...over,
});
const BAND = event({});
const WALLET_KEY = `QR-${'A'.repeat(20)}`;
const WALLET = event({ codeKind: 'wallet', handler: 'wallet-qr', detail: { walletKey: WALLET_KEY } });

describe('what the box says a tab scan is', () => {
  it('a band it checked is its short code, what a person would type', () => {
    expect(readTabScan(BAND)).toEqual({ ok: true, what: 'band', key: 'T1-7KMQ4X' });
  });

  it('the short code read on its own opens what it opens when typed', () => {
    const scan = readTabScan(
      event({ outcome: 'refused', handler: 'band', errorCode: 'BAND_SHORT_CODE', detail: { message: 'scan the QR', shortCode: 'T1-7KMQ4X' } }),
    );
    expect(scan).toEqual({ ok: true, what: 'band', key: 'T1-7KMQ4X' });
  });

  it('a band the box refused, or could not check, is its words and no key', () => {
    for (const refused of [
      { outcome: 'refused', errorCode: 'BAND_SIGNATURE_INVALID', detail: { message: 'Not a band this park printed' } },
      { outcome: 'refused', errorCode: 'BAND_CODE_MALFORMED', detail: { message: 'A character is missing' } },
      { outcome: 'error', errorCode: 'BAND_KEY_MISSING', detail: { message: 'This box has no band key yet' } },
    ]) {
      expect(readTabScan(event(refused))).toEqual({ ok: false, what: 'band', message: refused.detail.message });
    }
    const silent = readTabScan(event({ outcome: 'error', errorCode: 'SCAN_HANDLER_FAILED', detail: null }));
    expect(silent).toMatchObject({ ok: false, what: 'band' });
    expect((silent as { message: string }).message.length).toBeGreaterThan(0);
  });

  it('a credit voucher is its key', () => {
    expect(readTabScan(WALLET)).toEqual({ ok: true, what: 'wallet', key: WALLET_KEY });
  });

  it('leaves every other scan to its own reader, and those readers leave these alone', () => {
    for (const other of ['voucher', 'booking', 'benefit', 'product', 'unknown']) {
      expect(readTabScan(event({ codeKind: other, handler: other, detail: {} }))).toBeNull();
    }
    for (const scan of [BAND, WALLET]) {
      expect(readVoucherScan(scan)).toBeNull();
      expect(readBenefitScan(scan)).toBeNull();
      expect(readProductScan(scan)).toBeNull();
    }
  });

  it('the short code it hands over is one History reads as a bracelet', () => {
    expect(parseHistorySearch('T1-7KMQ4X')).toEqual({ kind: 'band', code: 'T1-7KMQ4X', label: 'T1-7KMQ4X' });
  });
});

describe('the F&B and shop counters', () => {
  const opened = { ok: true, what: 'band', key: 'T1-7KMQ4X' } as const;
  const credit = { ok: true, what: 'wallet', key: WALLET_KEY } as const;

  it('open a tab on the first screen, where a typed code can', () => {
    expect(decideCounterTabScan(opened, 'scan', null, 'order')).toEqual({ kind: 'open', key: 'T1-7KMQ4X' });
    expect(decideCounterTabScan(credit, 'scan', null, 'sale')).toEqual({ kind: 'open', key: WALLET_KEY });
  });

  it('never open one during an order, a payment or on a finished sale, and say so', () => {
    for (const stage of ['order', 'payment', 'confirmation'] as CounterStage[]) {
      for (const scan of [opened, credit]) {
        const decision = decideCounterTabScan(scan, stage, { code: 'T2-AAAAAA' }, 'order');
        expect(decision.kind, stage).toBe('say');
        expect((decision as { description: string }).description).toContain('Nothing changed');
      }
    }
  });

  it('say a band already on the order is already open, however it was first read', () => {
    const signed = 'T1' + '2'.repeat(21) + '7KMQ4X.' + 'A'.repeat(12);
    for (const held of [{ code: 'T1-7KMQ4X' }, { code: 't1-7kmq4x ' }, { code: signed }]) {
      expect(decideCounterTabScan(opened, 'order', held, 'order')).toMatchObject({
        kind: 'say',
        title: 'This wristband is already open',
      });
    }
    expect(decideCounterTabScan(credit, 'order', { code: 'T1-7KMQ4X', qrCode: WALLET_KEY }, 'sale')).toMatchObject({
      title: 'This credit voucher is already open',
    });
  });

  it('say the box’s words when it refused the code, at any stage', () => {
    for (const stage of ['scan', 'order', 'payment', 'confirmation'] as CounterStage[]) {
      expect(decideCounterTabScan({ ok: false, what: 'band', message: 'Not a band this park printed' }, stage, null, 'order')).toMatchObject({
        kind: 'say',
        description: 'Not a band this park printed',
        variant: 'destructive',
      });
    }
  });
});

describe('the ticket till and History', () => {
  it('the ticket till takes neither, and says where each one goes', () => {
    expect(ticketTillTabScanWords({ ok: true, what: 'band', key: 'T1-7KMQ4X' }).description).toContain('F&B, the shop or History');
    expect(ticketTillTabScanWords({ ok: true, what: 'wallet', key: WALLET_KEY }).description).toContain('F&B or the shop');
    expect(ticketTillTabScanWords({ ok: true, what: 'wallet', key: WALLET_KEY }).title).not.toContain(WALLET_KEY);
    expect(ticketTillTabScanWords({ ok: false, what: 'band', message: 'No key' }).description).toBe('No key');
  });

  it('History opens a band, as its typed form does', () => {
    expect(decideHistoryTabScan({ ok: true, what: 'band', key: 'T1-7KMQ4X' }, false)).toEqual({ kind: 'open', key: 'T1-7KMQ4X' });
  });

  it('History does not take a sale off the screen, where a refund may be under way', () => {
    expect(decideHistoryTabScan({ ok: true, what: 'band', key: 'T1-7KMQ4X' }, true)).toMatchObject({
      kind: 'say',
      variant: 'destructive',
    });
  });

  it('History says a credit voucher is not a bracelet, as its typed form does', () => {
    const decision = decideHistoryTabScan({ ok: true, what: 'wallet', key: WALLET_KEY }, false);
    expect(decision).toMatchObject({ kind: 'say' });
    expect(JSON.stringify(decision)).not.toContain(WALLET_KEY);
  });
});

describe('useCounterTabScan — when the key waits for the form, and when it lets go', () => {
  type Props = { stage: CounterStage; locked: boolean; held: { code: string } | null };
  let hook: RenderedHook<Props, ReturnType<typeof useCounterTabScan>>;
  const start = (props: Partial<Props> = {}) => {
    hook = renderHook(
      (p: Props) => useCounterTabScan({ stage: p.stage, held: p.held, locked: p.locked, noun: 'order' }),
      { stage: 'scan', locked: false, held: null, ...props },
    );
  };
  beforeEach(() => vi.mocked(toast).mockClear());
  afterEach(() => hook.unmount());

  it('hands the form the key, once, on the first screen', () => {
    start();
    expect(hook.result.current.hear(BAND)).toBe(true);
    expect(hook.result.current.scanned).toBe('T1-7KMQ4X');
    hook.result.current.taken();
    expect(hook.result.current.scanned).toBeNull();
    expect(toast).not.toHaveBeenCalled();
  });

  it('claims nothing else, so the other readers on the page still run', () => {
    start();
    expect(hook.result.current.hear(event({ codeKind: 'product', handler: 'product-barcode', detail: {} }))).toBe(false);
    expect(hook.result.current.scanned).toBeNull();
  });

  it('mid-payment nothing waits for a form, and the screen says so', () => {
    start({ stage: 'payment', held: { code: 'T2-AAAAAA' } });
    expect(hook.result.current.hear(BAND)).toBe(true);
    expect(hook.result.current.scanned).toBeNull();
    expect(toast).toHaveBeenCalledTimes(1);
    expect(vi.mocked(toast).mock.calls[0]![0]).toMatchObject({ title: 'Wristband T1-7KMQ4X not opened' });
  });

  it('a locked station takes nothing and says nothing', () => {
    start({ locked: true });
    expect(hook.result.current.hear(BAND)).toBe(true);
    expect(hook.result.current.scanned).toBeNull();
    expect(toast).not.toHaveBeenCalled();
  });

  it('a key still waiting is let go when the station locks, so it cannot land after an unlock', () => {
    start();
    hook.result.current.hear(BAND);
    hook.rerender({ stage: 'scan', locked: true, held: null });
    expect(hook.result.current.scanned).toBeNull();
  });

  it('a key still waiting is let go when the first screen goes, so it cannot land on the next guest', () => {
    start();
    hook.result.current.hear(BAND);
    hook.rerender({ stage: 'order', locked: false, held: null });
    expect(hook.result.current.scanned).toBeNull();
    hook.rerender({ stage: 'scan', locked: false, held: null });
    expect(hook.result.current.scanned).toBeNull();
  });
});

describe('the screens are wired to it', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const source = (path: string) => readFileSync(join(here, '..', 'src', path), 'utf8');

  it('the typed form opens a keyboard with letters on it, since band codes carry them', () => {
    for (const path of ['components/fnb/ScanWristband.tsx', 'components/mobile/history/MobileBraceletScanner.tsx']) {
      expect(source(path), path).not.toContain('inputMode="numeric"');
      expect(source(path), path).toContain('inputMode="text"');
    }
  });

  it('F&B and the shop ask the channel about a tab scan first, and hand the key to the typed form', () => {
    for (const path of ['pages/OrderStation.tsx', 'pages/MerchStation.tsx']) {
      const text = source(path);
      expect(text, path).toContain('tabScan.hear(event)');
      expect(text, path).toContain('scanned={tabScan.scanned}');
      expect(text, path).toContain('onScannedTaken={tabScan.taken}');
    }
  });

  it('the form looks a scanned key up through the same call as a typed one', () => {
    const text = source('components/fnb/ScanWristband.tsx');
    expect(text).toContain('void submit(scanned, true)');
    expect(text.match(/await loadScannedTab\(/g)).toHaveLength(1);
  });

  it('History and the ticket till hear the channel for it', () => {
    expect(source('pages/History.tsx')).toContain('useStationScans(locked ? undefined : station?.stationId');
    expect(source('pages/History.tsx')).toContain('decideHistoryTabScan(scan, selected !== null)');
    expect(source('pages/Till.tsx')).toContain('toast(ticketTillTabScanWords(tabScan))');
  });
});
