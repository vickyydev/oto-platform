import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Router } from 'wouter';
import { describe, expect, it } from 'vitest';
import { ApiError } from '@/api/client';
import type { HealthBox } from '@/api/observability';
import { FleetSummary } from '@/components/devices/FleetSummary';
import { commandLabel } from '@/lib/fleetWords';
import { healthDeviceTone, readAsNotSetUp } from '@/lib/printerAddress';
import { STATION_CHANGED_WORDS, stationSaveRefusal } from '@/lib/stationForm';

/**
 * SCRUM-952 — the printers after their staging proof, as the Console shows
 * them.
 *
 * Point 3: one refusal, one wording. A station saved by somebody else since
 * the form was opened is refused by the platform as "This station was
 * changed…", and the till shows that sentence; the Console's drawer said
 * "This till was changed…", named after the station's kind (proof pictures
 * 04 and 08). It now says the platform's sentence, with the same next step.
 *
 * Point 6: a printer with no address is not healthy. The platform reads it
 * as its box does — reachability and paper unknown, `DEVICE_NO_ADDRESS` as
 * its last error — and the Health page's box list draws that as the box
 * drawer does: a "Failing" mark and "not set up", never the green dot a seed
 * left behind (proof pictures 11a, 11b).
 */

const API_FLEET = resolve(import.meta.dirname, '../../api/src/services/fleet.ts');

/**
 * Point 1: the test page is composed by the platform for the printer it runs
 * on, so its command now carries `document: 'platform'` like a sale's
 * receipt. In the box's command history it is still the test print somebody
 * pressed.
 */
describe('point 1 — a test page that carries the platform’s page keeps its name', () => {
  it('reads "Test print", not "Print test page"; a sale’s receipt still reads as what it printed', () => {
    expect(commandLabel({ kind: 'test_print', payload: { document: 'platform', kind: 'test_page', deviceId: 'd' } }))
      .toBe('Test print');
    expect(commandLabel({ kind: 'test_print', payload: { document: 'platform', kind: 'receipt' } })).toBe('Print receipt');
    expect(commandLabel({ kind: 'test_print', payload: { document: 'platform', kind: 'test_page', reprintOf: 'root' } }))
      .toBe('Reprint test page');
  });
});

describe('point 3 — the stale-save refusal in the platform’s words', () => {
  it('is the sentence the api refuses with, word for word', () => {
    const api = readFileSync(API_FLEET, 'utf8');
    expect(api.includes(`'${STATION_CHANGED_WORDS}'`)).toBe(true);
  });

  it('is the same sentence for every kind of station, with the next step kept', () => {
    const refused = new ApiError(409, 'STATION_CHANGED', 'any words the api sends');
    for (const kind of ['till', 'booth', 'kiosk', 'gate']) {
      const said = stationSaveRefusal(refused, kind, 'The station could not be saved');
      expect(said).toBe('This station was changed since you opened it. Close it and open it again.');
      expect(said.includes(`This ${kind} was changed`)).toBe(false);
    }
  });

  it('leaves every other refusal in the api’s own words', () => {
    const other = new ApiError(409, 'STATION_PREFIX_TAKEN', 'That code prefix is taken.');
    expect(stationSaveRefusal(other, 'till', 'fallback')).toBe('That code prefix is taken.');
  });
});

const notSetUp = {
  id: 'printer-no-address',
  kind: 'receipt_printer',
  label: 'ZZ TEST 952 printer without an address',
  reachability: 'unknown',
  paperStatus: 'unknown',
  lastError: 'DEVICE_NO_ADDRESS',
  lastSeenAt: null,
};
const addressed = {
  id: 'printer-addressed',
  kind: 'receipt_printer',
  label: 'ZZ TEST 952 printer with an address',
  reachability: 'reachable',
  paperStatus: 'ok',
  lastError: null,
  lastSeenAt: null,
};

function box(devices: Array<Record<string, unknown>>): HealthBox {
  return {
    id: 'box-1', name: 'ZZ TEST 952 box', slot: 'virtual-1', role: 'counter', status: 'active', state: 'ok',
    branchId: 'branch-1', branchName: 'ZZ TEST Park', openingHours: 'open', agentVersion: '0.1.0',
    minAgentVersion: '0.1.0', agentBelowMinimum: false, lastHeartbeatAt: null, heartbeatAgeSeconds: 20,
    uptimeSeconds: null, outboxDepth: null, oldestUnackedAgeS: null, quarantineOpen: null, lastSyncAt: null,
    clockOffsetMs: null, tempC: null, currentEpoch: 1, configVersion: null, devices, booths: [],
    conditions: [], detail: null,
  } as unknown as HealthBox;
}

function health(devices: Array<Record<string, unknown>>): string {
  return renderToStaticMarkup(createElement(Router, { ssrPath: '/health', children:
    createElement(FleetSummary, {
      boxes: [box(devices)], loading: false, missing: false, error: null, onRetry: () => undefined,
    }),
  }));
}

/** The markup of one device's entry on the box's line, from its mark to its label and chips. */
function deviceEntry(html: string, label: string): string {
  const at = html.indexOf(label);
  if (at < 0) throw new Error(`${label} is not on the page`);
  const start = html.lastIndexOf('<span', html.lastIndexOf('<svg', at));
  const next = html.indexOf('<span class="sr-only">', at);
  return html.slice(start, next);
}

describe('point 6 — the Health page reads a printer with no address as not set up', () => {
  it('draws it as failing and not set up, as the box drawer does', () => {
    const entry = deviceEntry(health([notSetUp, addressed]), notSetUp.label);
    expect(entry.includes('aria-label="Failing"')).toBe(true);
    expect(entry.includes('not set up')).toBe(true);
    expect(entry.includes('paper')).toBe(false);
  });

  it('draws a printer with an address exactly as before: healthy, no chip', () => {
    const entry = deviceEntry(health([notSetUp, addressed]), addressed.label);
    expect(entry.includes('aria-label="Healthy"')).toBe(true);
    expect(entry.includes('not set up')).toBe(false);
  });

  it('keeps the paper chip for a printer that is set up and low on paper', () => {
    const entry = deviceEntry(health([{ ...addressed, paperStatus: 'low' }]), addressed.label);
    expect(entry.includes('paper low')).toBe(true);
    expect(entry.includes('not set up')).toBe(false);
  });

  it('reads the platform’s code only on a printer; any other device keeps its reachability', () => {
    expect(readAsNotSetUp(notSetUp)).toBe(true);
    expect(readAsNotSetUp(addressed)).toBe(false);
    expect(readAsNotSetUp({ kind: 'scanner', lastError: 'DEVICE_NO_ADDRESS' })).toBe(false);
    expect(healthDeviceTone(notSetUp)).toBe('down');
    expect(healthDeviceTone(addressed)).toBe('ok');
    expect(healthDeviceTone({ kind: 'scanner', reachability: 'unknown', lastError: 'DEVICE_NO_ADDRESS' })).toBe('idle');
  });
});
