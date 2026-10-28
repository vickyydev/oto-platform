import { describe, expect, it } from 'vitest';
import type { BoxRow, StationRow } from '@/api/fleet';
import { boxCardsForView, stationCardsForView } from '@/lib/fleetFilters';

const box = (id: string, status: string): BoxRow => ({ id, name: `ZZ TEST ${id}`, slot: id, role: 'counter', status });
const station = (id: string, boxId: string | null, boxStatus?: string | null): StationRow => ({
  id, branchId: 'own-park', name: `ZZ TEST ${id}`, kind: 'till', boxId, boxStatus,
});

describe('loaded fleet filters (SCRUM-683)', () => {
  it('combines text and exact native status, retaining source order and rows', () => {
    const rows = [box('Entry A', 'online'), box('Entry B', 'offline'), box('Reserve', 'unclaimed'), box('Disabled', 'disabled')];
    const before = JSON.stringify(rows);
    expect(boxCardsForView(rows, '  ENTRY  ', 'all')).toEqual(rows.slice(0, 2));
    expect(boxCardsForView(rows, 'entry', 'offline')).toEqual([rows[1]]);
    expect(boxCardsForView(rows, '', 'unclaimed')[0]).toBe(rows[2]);
    expect(boxCardsForView(rows, '', 'all')).toEqual(rows);
    expect(JSON.stringify(rows)).toBe(before);
  });
  it('searches native slot, hostname and role wording without converting an unknown status', () => {
    const rows = [{ ...box('first', 'online'), slot: 'north-entrance', hostname: 'zz-pi-a', heartbeatAgeSeconds: 10000 },
      { ...box('second', 'unknown'), role: 'standby', heartbeatAgeSeconds: 0 }];
    expect(boxCardsForView(rows, 'north', 'all')).toEqual([rows[0]]);
    expect(boxCardsForView(rows, 'zz-pi-a', 'online')).toEqual([rows[0]]);
    expect(boxCardsForView(rows, 'standby', 'all')).toEqual([rows[1]]);
    expect(boxCardsForView(rows, '', 'online')).toEqual([rows[0]]);
    expect(boxCardsForView(rows, '', 'offline')).toEqual([]);
  });
  it('uses a station native status, or the assigned box native status for older responses', () => {
    const boxes = [box('a', 'online'), box('b', 'unclaimed')];
    const rows = [station('native', 'a', 'offline'), station('older', 'b'), station('unassigned', null)];
    const before = JSON.stringify({ rows, boxes });
    expect(stationCardsForView(rows, boxes, '', 'offline')[0]).toBe(rows[0]);
    expect(stationCardsForView(rows, boxes, '', 'unclaimed')).toEqual([rows[1]]);
    expect(stationCardsForView(rows, boxes, '', 'online')).toEqual([]);
    expect(stationCardsForView(rows, boxes, '', 'all')).toEqual(rows);
    expect(JSON.stringify({ rows, boxes })).toBe(before);
  });
  it('searches native station kind, prefix, assigned box and capability labels', () => {
    const rows = [{ ...station('one', null), codePrefix: 'ZZ-GATE', kind: 'display', boxName: 'ZZ TEST North counter', capabilities: ['fnb'] }];
    for (const query of ['zz-gate', 'customer display', 'north', 'F&B']) expect(stationCardsForView(rows, [], query, 'all')).toEqual(rows);
    expect(stationCardsForView(rows, [], 'not loaded', 'all')).toEqual([]);
  });
});
