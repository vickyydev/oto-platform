import { and, asc, eq, isNull } from 'drizzle-orm';
import { box, branch, device, printJob, printTemplate, station } from '@oto/db';
import { formatDayTimeInTz } from '@oto/shared';
import { profileFor, testPrintJob, type BoxConfigDevice } from '@oto/box-agent';
import type { TestPageData } from '@oto/print';
import type { Exec } from './tx';

/**
 * SCRUM-952 — THE TEST PAGE NAMES THE PRINTER IT RAN ON.
 *
 * A test print from the till's or the Console's printer card used to print
 * the renderer's committed fixture whatever printer it ran on: "Device Main
 * counter, Model Welltech G4" and a park-network address — a printer of the
 * park's own network, on a ZZ TEST printer of the virtual box (SCRUM-930
 * proof, picture 02d). The box rendered that sample itself
 * (`testPrintJob` in `packages/box-agent/src/printing/index.ts`).
 *
 * Now the platform composes the page for the printer the job was routed to,
 * as it composes a sale's receipt, and the box fetches it by job id
 * (`document: 'platform'`, `GET /box/v1/print-jobs/:id/document`) — a path
 * every box already takes, so a Raspberry Pi prints it without an update.
 * In the page's own layout it carries:
 *
 *   - Device: the device's label, as the Console holds it;
 *   - Model: its model, or its kind in the Console's words when it has none;
 *   - Address: its address, or "no address";
 *   - Station and Box: the station the test was asked at and the box the
 *     printer is plugged into (rows a box draws once its renderer has them);
 *   - Time: when the test was asked for, on the branch's clock;
 *   - Transport and Dots/line: how the box reaches it, and the width the box
 *     renders at for it (`profileFor`, the box's own profile of the row);
 *   - the branch's own print templates, by name.
 *
 * What proves the renderer — the version, the fonts, the scripts, the money
 * column and the sample code — stays the fixture's.
 */

/** The Address row of a printer saved without one. */
export const NO_ADDRESS_ON_PAGE = 'no address';

/** The Console's words for a device's kind (`deviceKindWord` in `apps/console/src/lib/fleetWords.ts`). */
const KIND_WORDS: Record<string, string> = {
  receipt_printer: 'Receipt printer',
  band_printer: 'Band printer',
  kitchen_printer: 'Kitchen printer',
  bar_printer: 'Bar printer',
};

/** The Console's words for how the box reaches it (`transportWord`, the same file). */
const TRANSPORT_WORDS: Record<string, string> = {
  lan: 'LAN',
  usb: 'USB',
  serial: 'Serial',
  bluetooth: 'Bluetooth',
  simulated: 'Simulated',
};

const tidy = (value: string): string => value.replace(/_/g, ' ');

/**
 * The page for one station test print, or null when the job names no printer
 * to describe — a skipped job is never sent to a box, so the box asking for
 * one is answered as any job without a document is.
 */
export async function testPageDocumentOf(
  db: Exec,
  row: typeof printJob.$inferSelect,
): Promise<TestPageData | null> {
  if (!row.deviceId) return null;
  const [printer] = await db.select().from(device).where(eq(device.id, row.deviceId)).limit(1);
  if (!printer) return null;
  const [place] = await db
    .select({ boxName: box.name, timezone: branch.timezone })
    .from(box)
    .innerJoin(branch, eq(branch.id, row.branchId))
    .where(eq(box.id, row.boxId))
    .limit(1);
  const [at] = row.stationId
    ? await db.select({ name: station.name }).from(station).where(eq(station.id, row.stationId)).limit(1)
    : [];
  const templates = await db
    .select({ name: printTemplate.name })
    .from(printTemplate)
    .where(and(eq(printTemplate.branchId, row.branchId), isNull(printTemplate.archivedAt)))
    .orderBy(asc(printTemplate.type), asc(printTemplate.name));

  const sample = await testPrintJob('test_page');
  if (sample.kind !== 'test_page') return null;
  const profile = profileFor({
    id: printer.id,
    role: row.role ?? 'receipt',
    kind: printer.kind,
    label: printer.label,
    transport: printer.transport,
    address: printer.address,
    model: printer.model,
    protocol: printer.protocol,
    serialNumber: null,
    terminalId: null,
    merchantId: null,
    settings: printer.settings,
  } as BoxConfigDevice);
  const transport = TRANSPORT_WORDS[printer.transport] ?? tidy(printer.transport);

  return {
    ...sample.data,
    deviceLabel: printer.label,
    model: printer.model?.trim() || (KIND_WORDS[printer.kind] ?? tidy(printer.kind)),
    address: printer.address?.trim() || NO_ADDRESS_ON_PAGE,
    ...(at ? { station: at.name } : {}),
    ...(place ? { box: place.boxName, time: formatDayTimeInTz(row.queuedAt, place.timezone) } : {}),
    transport: printer.protocol ? `${transport} · ${printer.protocol}` : transport,
    widthDots: profile.widthDots,
    seededTemplates: templates.map((t) => t.name),
  };
}
