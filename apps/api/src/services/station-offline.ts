import { and, eq } from 'drizzle-orm';
import { box, boxState, station, type Db } from '@oto/db';
import type { AuthContext } from '../plugins/session';

/** The selected station's deliberate test state, never watchdog silence. */
export async function forcedOfflineStation(
  db: Db,
  auth: Pick<AuthContext, 'operatorId' | 'stationId'>,
): Promise<{ stationId: string; boxId: string } | null> {
  if (!auth.stationId) return null;
  const [row] = await db
    .select({ stationId: station.id, boxId: box.id })
    .from(station)
    .innerJoin(box, eq(station.boxId, box.id))
    .innerJoin(boxState, eq(boxState.boxId, box.id))
    .where(and(
      eq(station.id, auth.stationId),
      eq(station.operatorId, auth.operatorId),
      eq(box.operatorId, auth.operatorId),
      eq(box.role, 'virtual'),
      eq(boxState.offline, true),
    ))
    .limit(1);
  return row ?? null;
}
