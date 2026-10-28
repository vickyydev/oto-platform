import type { BoxRow, StationRow } from '@/api/fleet';
import { boxRoleWord, capabilityWord, stationKindWord } from '@/lib/fleetWords';

export type FleetStatusFilter = 'all' | 'online' | 'offline' | 'unclaimed';
const matchesText = (query: string, fields: Array<string | null | undefined>) =>
  fields.join(' ').toLocaleLowerCase().includes(query.trim().toLocaleLowerCase());

/** Refine the selected park's native reading; status is never inferred from heartbeat age. */
export function boxCardsForView(boxes: readonly BoxRow[], query: string, status: FleetStatusFilter): BoxRow[] {
  return boxes.filter(box => (status === 'all' || box.status === status)
    && matchesText(query, [box.name, box.id, box.slot, box.hostname, boxRoleWord(box.role)]));
}

export function stationCardsForView(stations: readonly StationRow[], boxes: readonly BoxRow[], query: string, status: FleetStatusFilter): StationRow[] {
  return stations.filter(station => {
    const nativeStatus = station.boxStatus ?? boxes.find(box => box.id === station.boxId)?.status;
    return (status === 'all' || nativeStatus === status)
      && matchesText(query, [station.name, station.id, station.codePrefix, station.boxName,
        stationKindWord(station.kind), ...(station.capabilities ?? []).map(capabilityWord)]);
  });
}
