import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { StationCard } from '@/pages/Devices';
import type { StationRow } from '@/api/fleet';
import { DisplayPresenceLine, PresenceChip, TillScreenPresence, presenceSentence } from '@/components/devices/ScreenPresence';
import { screenPresenceWord, toneForScreenPresence } from '@/lib/fleetWords';

/**
 * SCRUM-771 — a customer display's Online or Offline, and a till's own screen
 * with its scanner's last use, read on the Devices page the way a box is: the
 * status, then how long ago it was heard from, by the API's own count.
 */

vi.mock('@/lib/workingAuthority', () => ({ useWorkingAuthority: () => ({ isCurrent: () => true, run: (fn: () => unknown) => fn() }) }));
const noop = () => undefined;
const till: StationRow = {
  id: 'station', branchId: 'branch', boxId: 'box', boxName: 'ZZ TEST box', name: 'ZZ TEST till', kind: 'till',
  ready: true, reasons: [], codePrefix: 'T1',
};
const markup = (station: StationRow) =>
  renderToStaticMarkup(createElement(StationCard, { station, branchLabel: 'Park', onOpen: noop }));

describe('the words', () => {
  it('are the box’s words and colours', () => {
    expect(screenPresenceWord('online')).toBe('Online');
    expect(screenPresenceWord('offline')).toBe('Offline');
    expect(toneForScreenPresence('online')).toBe('ok');
    expect(toneForScreenPresence('offline')).toBe('down');
    expect(toneForScreenPresence('something new')).toBe('idle');
  });

  it('say how long ago, or that it never reported', () => {
    expect(presenceSentence({ state: 'online', lastSeenAgeSeconds: 20 })).toBe('Online · seen 20s ago');
    expect(presenceSentence({ state: 'offline', lastSeenAgeSeconds: 720 })).toBe('Offline · last seen 12m ago');
    expect(presenceSentence({ state: 'offline', lastSeenAgeSeconds: null })).toBe('Offline · never reported');
  });
});

describe('a till’s screen on its station card', () => {
  it('shows it online with the scanner’s last use, and says why that is the scanner’s only sign', () => {
    const html = markup({ ...till, screen: {
      state: 'online', lastSeenAgeSeconds: 20, offlineAfterSeconds: 180, scannerLastUsedAgeSeconds: 180,
    } });
    expect(html).toContain('Till screen online · seen 20s ago');
    expect(html).toContain('Scanner last used 3m ago.');
    expect(html).toContain('types like a keyboard, so the last code it typed is the only sign of it');
  });

  it('shows it offline, and a scanner that has not reported', () => {
    const html = markup({ ...till, screen: {
      state: 'offline', lastSeenAgeSeconds: 900, offlineAfterSeconds: 180, scannerLastUsedAgeSeconds: null,
    } });
    expect(html).toContain('Till screen offline · last seen 15m ago');
    expect(html).toContain('Scanner: no scan reported from this till screen yet.');
  });

  it('shows nothing for a station of another kind, an archived till, or an api without it', () => {
    const screen = { state: 'online', lastSeenAgeSeconds: 5, scannerLastUsedAgeSeconds: null };
    expect(markup({ ...till, kind: 'booth', screen })).not.toContain('Till screen');
    expect(markup({ ...till, archived: true, screen })).not.toContain('Till screen');
    expect(markup(till)).not.toContain('Till screen');
  });

  it('is the same block on its own', () => {
    const html = renderToStaticMarkup(createElement(TillScreenPresence, { screen: {
      state: 'offline', lastSeenAgeSeconds: null, scannerLastUsedAgeSeconds: 7_200,
    } }));
    expect(html).toContain('Till screen offline · never reported');
    expect(html).toContain('Scanner last used 2h ago.');
  });
});

describe('a paired display', () => {
  it('carries an Online or Offline badge', () => {
    expect(renderToStaticMarkup(createElement(PresenceChip, { presence: { state: 'offline' } }))).toContain('Offline');
    expect(renderToStaticMarkup(createElement(PresenceChip, { presence: { state: 'online' } }))).toContain('Online');
  });

  it('says how long it has been quiet, against the boxes’ threshold', () => {
    const html = renderToStaticMarkup(createElement(DisplayPresenceLine, {
      presence: { state: 'offline', lastSeenAgeSeconds: 1_800, offlineAfterSeconds: 180 },
    }));
    expect(html).toContain('Offline · last seen 30m ago — quiet for longer than 3m');
    const online = renderToStaticMarkup(createElement(DisplayPresenceLine, {
      presence: { state: 'online', lastSeenAgeSeconds: 1, offlineAfterSeconds: 180 },
    }));
    expect(online).toContain('Online · seen 1s ago');
    expect(online).not.toContain('quiet for longer');
  });

  it('reads one on a Pi box as reading through it, never Offline, in no alarming colour', () => {
    expect(screenPresenceWord('via_box')).toBe('Via box');
    expect(toneForScreenPresence('via_box')).toBe('idle');
    const chip = renderToStaticMarkup(createElement(PresenceChip, { presence: { state: 'via_box' } }));
    expect(chip).toContain('Via box');
    expect(chip).not.toContain('Offline');
    const html = renderToStaticMarkup(createElement(DisplayPresenceLine, {
      presence: { state: 'via_box', lastSeenAgeSeconds: 86_400, offlineAfterSeconds: 180, box: { id: 'box', name: 'Counter 1 box' } },
    }));
    expect(html).toContain('Reads through Counter 1 box; the box does not report its displays yet');
    expect(html).not.toContain('Offline');
    expect(html).not.toContain('quiet for longer');
    expect(renderToStaticMarkup(createElement(DisplayPresenceLine, {
      presence: { state: 'via_box', lastSeenAgeSeconds: null, box: null },
    }))).toContain('Its till is on no box, so nothing reports this display yet');
  });
});
