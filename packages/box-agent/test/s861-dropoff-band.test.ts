import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { PrintJob } from '@oto/print';
import type { BoxCommandHandout, BoxConfigBundle } from '../src/protocol';
import { DROPOFF_BAND_ROLE, ROLE_FOR_KIND, bandRoleFor, routeTo } from '../src/printing/queue';
import {
  STATION_ID,
  TILL_KIDS_BAND_PRINTER,
  TILL_RECEIPT_PRINTER,
  fakeBoxCloud,
  openTestAgent,
  tillBundle,
} from './_support';

/**
 * SCRUM-861 — DROP-OFF BANDS ON THEIR OWN PRINTER, as the box sees it.
 *
 * The platform decides the role (`routeJob` in `sale-printing.ts`) and the
 * command carries it as a string, which is the contract this box has always
 * had: `routeTo` matches the role against the bundle's devices by name and
 * knows no list of roles. So a box from before this ticket already prints a
 * `dropoff_band` job on the printer the command names, and a box of this
 * build prints a `kids_band` job from an older platform on the kids printer.
 * What is NEW on the box is `bandRoleFor`: the role a band the box composes
 * itself — an offline sale's, an offline "Check in now"'s — prints on, read
 * from its own paper.
 */

const DROPOFF_PRINTER = '018f0000-0000-7000-8000-00000000de04';

function withDropoffPrinter(bundle: BoxConfigBundle): BoxConfigBundle {
  const station = bundle.stations[0]!;
  const kids = station.devices.find((d) => d.id === TILL_KIDS_BAND_PRINTER)!;
  return {
    ...bundle,
    stations: [
      {
        ...station,
        devices: [
          ...station.devices,
          { ...kids, id: DROPOFF_PRINTER, role: DROPOFF_BAND_ROLE, label: 'dropoff_band printer', address: '10.0.0.14:9100' },
        ],
      },
    ],
  };
}

const DROPOFF_BAND: PrintJob = {
  kind: 'kids_wristband',
  data: {
    holderName: 'Mint',
    duration: '2 hours · valid until 16:05',
    allergy: 'Peanuts',
    supervisionMode: 'DROP-OFF',
    bandCode: 'T1ABCDEFGHJKMNPQRSTVWXYZ0.ABCDEFGHJKMN',
    shortCode: 'T1-ABCDEF',
  },
};

const NANNY_BAND: PrintJob = {
  kind: 'kids_wristband',
  data: { ...DROPOFF_BAND.data, holderName: 'Kai', supervisionMode: 'NANNY', assignedNannyName: 'Pim' },
};

const PLAIN_BAND: PrintJob = {
  kind: 'kids_wristband',
  data: { holderName: 'Ton', duration: '2 hours · valid until 16:05', bandCode: DROPOFF_BAND.data.bandCode, shortCode: 'T1-ABCDEG' },
};

const ADULT_BAND: PrintJob = {
  kind: 'adult_wristband',
  data: { holderName: 'Ploy', duration: '2 hours · valid until 16:05', bandCode: DROPOFF_BAND.data.bandCode, shortCode: 'T1-ABCDEH' },
};

/** The command the platform writes for one band job (`writeJob` in `sale-printing.ts`). */
function bandCommand(jobId: string, role: string, deviceId: string): BoxCommandHandout {
  return {
    id: `cmd-${jobId.slice(-4)}`,
    kind: 'test_print',
    payload: {
      printJobId: jobId,
      kind: 'kids_wristband',
      role,
      stationId: STATION_ID,
      deviceId,
      copies: 1,
      document: 'platform',
      subjectType: 'band',
      saleId: '018f0000-0000-7000-8000-00000000aa10',
    },
    actionId: 'sale-finalise-0861',
    attempts: 1,
    expiresAt: null,
    createdAt: new Date().toISOString(),
  };
}

function platformDocument(jobId: string, role: string, job: PrintJob) {
  return {
    status: 200,
    body: { printJobId: jobId, kind: job.kind, role, stationId: STATION_ID, templateId: null, templateVersion: null, reprintOf: null, job },
  };
}

test('the role a band this box composes prints on: drop-off to the drop-off printer when the station has one, else the kids printer', () => {
  const plain = tillBundle();
  const withPrinter = withDropoffPrinter(tillBundle());

  // The matrix: (drop-off, nanny, plain child, adult) × (printer assigned, not assigned).
  assert.equal(bandRoleFor(withPrinter, 'kids_wristband', DROPOFF_BAND, STATION_ID), DROPOFF_BAND_ROLE);
  assert.equal(bandRoleFor(plain, 'kids_wristband', DROPOFF_BAND, STATION_ID), 'kids_band', 'no drop-off printer: the kids printer, as before');
  for (const bundle of [plain, withPrinter]) {
    assert.equal(bandRoleFor(bundle, 'kids_wristband', NANNY_BAND, STATION_ID), 'kids_band', 'a nanny child keeps the kids printer');
    assert.equal(bandRoleFor(bundle, 'kids_wristband', PLAIN_BAND, STATION_ID), 'kids_band');
    assert.equal(bandRoleFor(bundle, 'adult_wristband', ADULT_BAND, STATION_ID), 'adult_band');
  }
  // Only the station's own printer counts, as for every role (`routeTo`).
  assert.equal(bandRoleFor(withPrinter, 'kids_wristband', DROPOFF_BAND, 'another-station'), 'kids_band');
  // No bundle at all (a box before its first config pull): the kinds' own roles.
  assert.equal(bandRoleFor(null, 'kids_wristband', DROPOFF_BAND, STATION_ID), 'kids_band');
  // Everything that is not a kids band is untouched.
  for (const kind of Object.keys(ROLE_FOR_KIND) as Array<keyof typeof ROLE_FOR_KIND>) {
    if (kind === 'kids_wristband') continue;
    assert.equal(bandRoleFor(withPrinter, kind, { kind, data: DROPOFF_BAND.data } as PrintJob, STATION_ID), ROLE_FOR_KIND[kind]);
  }
});

test('a platform job for the drop-off role prints on the printer the command names — the role is a string the box never had to know', async () => {
  const bundle = withDropoffPrinter(tillBundle());
  assert.equal(routeTo(bundle, DROPOFF_BAND_ROLE, STATION_ID)?.device.id, DROPOFF_PRINTER);
  const cloud = fakeBoxCloud(bundle);
  const JOB = '018f0000-0000-7000-8000-00000000f861';
  cloud.documents.set(JOB, platformDocument(JOB, DROPOFF_BAND_ROLE, DROPOFF_BAND));
  cloud.commands.push(bandCommand(JOB, DROPOFF_BAND_ROLE, DROPOFF_PRINTER));
  const box = await openTestAgent(cloud);
  try {
    assert.equal(await box.agent.runPendingCommands(), 1);
    assert.deepEqual(
      cloud.printResults.map((r) => [r.jobId, r.body.status, r.body.role, r.body.deviceId]),
      [[JOB, 'printed', DROPOFF_BAND_ROLE, DROPOFF_PRINTER]],
    );
    const printing = box.agent.printing()!;
    assert.equal(printing.printouts(DROPOFF_PRINTER).length, 1, 'the drop-off printer took it');
    assert.equal(printing.printouts(TILL_KIDS_BAND_PRINTER).length, 0, 'and the kids printer did not');
  } finally {
    box.close();
  }
});

test('the fallback: the same drop-off band on the kids band role prints on the kids printer, and the bytes are the bytes of today', async () => {
  // A station with no drop-off printer: the platform sends `kids_band`, as it
  // did before this role existed (`routeJob`), and the box has nothing new to
  // learn. The printout is compared with one of the same document on the same
  // printer under the role name alone — the role is routing, never layout.
  const JOB_A = '018f0000-0000-7000-8000-00000000f862';
  const JOB_B = '018f0000-0000-7000-8000-00000000f863';
  const cloud = fakeBoxCloud(tillBundle());
  cloud.documents.set(JOB_A, platformDocument(JOB_A, 'kids_band', DROPOFF_BAND));
  cloud.documents.set(JOB_B, platformDocument(JOB_B, 'kids_band', PLAIN_BAND));
  cloud.commands.push(bandCommand(JOB_A, 'kids_band', TILL_KIDS_BAND_PRINTER), bandCommand(JOB_B, 'kids_band', TILL_KIDS_BAND_PRINTER));
  const box = await openTestAgent(cloud);
  try {
    assert.equal(await box.agent.runPendingCommands(), 2);
    assert.deepEqual(
      cloud.printResults.map((r) => [r.jobId, r.body.status, r.body.role, r.body.deviceId]),
      [
        [JOB_A, 'printed', 'kids_band', TILL_KIDS_BAND_PRINTER],
        [JOB_B, 'printed', 'kids_band', TILL_KIDS_BAND_PRINTER],
      ],
    );
    const printouts = box.agent.printing()!.printouts(TILL_KIDS_BAND_PRINTER);
    assert.equal(printouts.length, 2);
    assert.equal(printouts[0]!.truncated, false);
    // The DROP-OFF badge is on the paper — the fallback changed where it came out, not what it says.
    assert.notDeepEqual(printouts[0]!.preview, printouts[1]!.preview, 'a badged band and a plain one are different paper');
  } finally {
    box.close();
  }
});

test('a drop-off printer that is assigned but does not answer holds the job for a retry, exactly as any band printer does — never the kids printer', async () => {
  const bundle = withDropoffPrinter(tillBundle());
  const cloud = fakeBoxCloud(bundle);
  const JOB = '018f0000-0000-7000-8000-00000000f864';
  cloud.documents.set(JOB, platformDocument(JOB, DROPOFF_BAND_ROLE, DROPOFF_BAND));
  cloud.commands.push(bandCommand(JOB, DROPOFF_BAND_ROLE, DROPOFF_PRINTER));
  const box = await openTestAgent(cloud);
  try {
    const printing = box.agent.printing()!;
    // The simulator's own fault: the printer stops answering (a cable out, a unit off).
    assert.equal(printing.setFault(DROPOFF_PRINTER, 'unreachable'), true);
    assert.equal(await box.agent.runPendingCommands(), 1);
    const [result] = cloud.printResults;
    assert.ok(result, 'the box reported the job');
    assert.equal(result.jobId, JOB);
    assert.equal(result.body.deviceId, DROPOFF_PRINTER, 'the drop-off printer, not the kids one');
    assert.equal(result.body.role, DROPOFF_BAND_ROLE);
    // The existing rule for a printer that does not answer (`queue.ts`, case
    // 1): the job stays queued and is retried, up to the queue's cap.
    assert.equal(result.body.status, 'queued');
    assert.equal(result.body.errorCode, 'PRINTER_UNREACHABLE');
    assert.equal(printing.printouts(TILL_KIDS_BAND_PRINTER).length, 0, 'nothing was redirected to the kids printer');
    assert.equal(printing.printouts(TILL_RECEIPT_PRINTER).length, 0);
  } finally {
    box.close();
  }
});
