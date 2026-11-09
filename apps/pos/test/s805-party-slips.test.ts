import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import React, { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PartySlipRecordView, PartySlipsView } from '@oto/shared';
import { api, ApiError, NetworkError } from '@/api/client';
import { EVENTS_NOT_LINKED } from '@/api/events';
import { partySlipWords, printPartySlipsOnPlatform, readPartySlipsOnPlatform } from '@/api/partySlips';
import { PartySlipsBlock } from '@/components/parties/PartySlipsCard';

/**
 * SCRUM-805 — the party page's "Kitchen & bar slips" (birthday plan §5; the
 * owner's decision 3): the slip time, each slip's state on the party's day —
 * Printed 11:00, No printer named for this park, Nothing to print — and "Print
 * party slips now", which asks the platform for a new run under the press's id.
 */

// The block is compiled with the classic JSX runtime, as the unit runner has no React plugin.
Object.assign(globalThis, { React });

const HKT_CENTRAL = '0190a0a0-0000-7000-8000-00000000b001';
const PARTY = '0190a0a0-0000-7000-8000-0000000e0e05';
const STATION = '0190a0a0-0000-7000-8000-00000000c001';

vi.mock('@/api/catalogBridge', () => ({
  apiBranchIdForSlug: (slug: string) => (slug === 'hkt-central' ? HKT_CENTRAL : null),
}));
vi.mock('@/api/client', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/api/client')>();
  return { ...original, api: { ...original.api, get: vi.fn(), post: vi.fn() } };
});

const getMock = vi.mocked(api.get);
const postMock = vi.mocked(api.post);

beforeEach(() => {
  getMock.mockReset();
  postMock.mockReset();
});

const record = (over: Partial<PartySlipRecordView> = {}): PartySlipRecordView => ({
  id: '0190a0a0-0000-7000-8000-0000000051a1',
  station: 'kitchen',
  run: 1,
  trigger: 'schedule',
  status: 'printed',
  at: '11:00',
  printJobId: '0190a0a0-0000-7000-8000-0000000051b1',
  jobStatus: 'queued',
  requestedByName: null,
  createdAt: '2026-11-10T04:00:00.000Z',
  ...over,
});

const slips = (over: Partial<PartySlipsView> = {}): PartySlipsView => ({
  partyDate: '2026-11-10',
  slipsTime: '11:00',
  station: { id: STATION, name: 'Reception Till 1' },
  latest: { kitchen: record(), bar: record({ station: 'bar' }) },
  records: [],
  ...over,
});

const markup = (view: PartySlipsView, busy = false) =>
  renderToStaticMarkup(createElement(PartySlipsBlock, { slips: view, busy, onPrint: () => {} }))
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, '&');

describe('the Kitchen & bar slips block', () => {
  it('shows the slip time, each slip printed at its time, and the button', () => {
    const html = markup(slips());
    expect(html).toContain('Kitchen & bar slips');
    expect(html).toContain('Slip time');
    expect(html).toContain('11:00');
    expect(html).toContain('Kitchen slip');
    expect(html).toContain('Bar slip');
    expect(html.match(/Printed 11:00/g)).toHaveLength(2);
    expect(html).toContain('Print party slips now');
    // Drawn as the page's other blocks are.
    expect(html).toContain('p-5 bg-card/50');
  });

  it('with no station named for the park, both slips say so', () => {
    const html = markup(
      slips({
        station: null,
        latest: {
          kitchen: record({ status: 'no_printer', printJobId: null, jobStatus: null }),
          bar: record({ station: 'bar', status: 'no_printer', printJobId: null, jobStatus: null }),
        },
      }),
    );
    expect(html.match(/No printer named for this park/g)).toHaveLength(2);
  });

  it('nothing to print, a station without a bar printer, and a day not printed yet each read as such', () => {
    const html = markup(
      slips({
        slipsTime: '12:30',
        latest: {
          kitchen: null,
          bar: record({ station: 'bar', status: 'no_printer', printJobId: null, jobStatus: null }),
        },
      }),
    );
    expect(html).toContain('12:30');
    expect(html).toContain('Not printed yet');
    expect(html).toContain('No bar printer at Reception Till 1');
    expect(partySlipWords(record({ status: 'nothing_to_print', printJobId: null }), null, 'bar')).toBe('Nothing to print');
  });

  it('holds the button while a press is on its way', () => {
    expect(markup(slips(), true)).toMatch(/<button[^>]*disabled/);
  });
});

describe('the slips on the platform', () => {
  it('reads the party’s slips from the party read, and none for a party without a plan or a till not linked', async () => {
    getMock.mockResolvedValueOnce({ slips: slips() });
    expect(await readPartySlipsOnPlatform({ id: PARTY, branchId: 'hkt-central' })).toEqual(slips());
    expect(getMock).toHaveBeenCalledWith(`/parties/${PARTY}?branchId=${HKT_CENTRAL}`);

    getMock.mockResolvedValueOnce({ slips: null });
    expect(await readPartySlipsOnPlatform({ id: PARTY, branchId: 'hkt-central' })).toBeNull();
    getMock.mockRejectedValueOnce(new NetworkError());
    expect(await readPartySlipsOnPlatform({ id: PARTY, branchId: 'hkt-central' })).toBeNull();
    expect(await readPartySlipsOnPlatform({ id: PARTY, branchId: 'elsewhere' })).toBeNull();
  });

  it('"Print party slips now" posts the branch and the press’s id, keyed by it', async () => {
    const answer = { printed: [record({ run: 2, trigger: 'reprint' })], slips: slips(), replayed: false };
    postMock.mockResolvedValueOnce(answer);
    const outcome = await printPartySlipsOnPlatform({ party: { id: PARTY, branchId: 'hkt-central' }, actionId: 'press-1' });
    expect(outcome).toEqual({ ok: true, answer });
    expect(postMock).toHaveBeenCalledWith(
      `/parties/${PARTY}/slips/print`,
      { branchId: HKT_CENTRAL, actionId: 'press-1' },
      { idempotencyKey: 'party-slips:press-1', headers: { 'x-oto-action-id': 'press-1' } },
    );
  });

  it('a refusal is final; no answer may be pressed again under the same id', async () => {
    postMock.mockRejectedValueOnce(new ApiError(409, 'PARTY_NO_PLAN', 'The OTO App has no birthday package for this party'));
    expect(await printPartySlipsOnPlatform({ party: { id: PARTY, branchId: 'hkt-central' }, actionId: 'a' })).toMatchObject({
      ok: false,
      retryable: false,
    });
    postMock.mockRejectedValueOnce(new NetworkError());
    expect(await printPartySlipsOnPlatform({ party: { id: PARTY, branchId: 'hkt-central' }, actionId: 'b' })).toMatchObject({
      ok: false,
      retryable: true,
    });
    expect(await printPartySlipsOnPlatform({ party: { id: PARTY, branchId: 'elsewhere' }, actionId: 'c' })).toEqual({
      ok: false,
      message: EVENTS_NOT_LINKED,
      retryable: false,
    });
  });
});

describe('the party page carries the block', () => {
  it('beside the bar plan, on the reception and the F&B surfaces', () => {
    const source = readFileSync(
      fileURLToPath(new URL('../src/components/parties/PartyDetail.tsx', import.meta.url)),
      'utf8',
    );
    expect(source).toContain("import { PartySlipsCard } from './PartySlipsCard';");
    expect(source).toContain('[kitchenSection, barSection, slipsSection, timelineSection]');
    expect(source).toContain('[kitchenSection, timelineSection, barSection, slipsSection, activitySection]');
  });
});
