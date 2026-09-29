import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import {
  BOX_COMMAND_KINDS as DB_BOX_COMMAND_KINDS,
  auditLog,
  box,
  boxCommand,
  branch,
  device,
  opsRun,
  printJob,
  printTemplate,
  station,
  stationDevice,
} from '@oto/db';
import {
  BOX_COMMAND_KINDS as AGENT_BOX_COMMAND_KINDS,
  createBoxAgent,
  memoryCredentialStore,
  type AgentFetch,
  ROLE_FOR_KIND,
  profileFor,
  testPrintJob,
  type BoxAgent,
} from '@oto/box-agent';
import { previewPng, renderJob } from '@oto/print';
import {
  APPLICABLE_FIELDS,
  PRINT_KINDS,
  PRINT_TEMPLATE_TYPES,
  PRINT_TEMPLATE_TYPE_ORDER,
  TEMPLATE_FOR_KIND,
  newId,
} from '@oto/shared';
import {
  createTestContext,
  signInAs,
  teardownAll,
  ADMIN,
  CENTRAL_BRANCH_CODE,
  type TestContext,
} from './helpers';
import { attachInProcessBox, provisionVirtualBox } from '../src/services/box';
// The Console's own URL rule, not a copy of it — see `fromBrowser` below.
import { apiUrl } from '../../console/src/api/url';

/**
 * S2-06 — printing, driven through the routes a person's button actually hits.
 *
 * Nothing here calls a service directly. A test print is `POST` to the route
 * the Print Templates panel posts to; the box that takes it is the agent from
 * `@oto/box-agent`, the same file a Raspberry Pi runs, pointed at this api
 * through `app.inject`; the printer at the far end is the simulator, which
 * parses the bytes with the renderer's own reader. So a green test here is a
 * statement about the whole path — Console, cloud, command queue, box,
 * adapter, socket, paper, and the outcome coming back up.
 *
 * That is the shape this sprint learned to insist on three times: a service
 * with no caller is not built, and a test that mirrors one side of a seam
 * proves nothing about the seam.
 */

let ctx: TestContext;
let cookie: string;

beforeAll(async () => {
  ctx = await createTestContext();
  cookie = await signInAs(ctx.app, ADMIN.phone, ADMIN.password);
});
afterAll(async () => {
  await ctx.close();
  await teardownAll();
});

function injectTransport(): AgentFetch {
  return async (url, init) => {
    const path = url.replace(/^https?:\/\/[^/]+/, '');
    const res = await ctx.app.inject({
      method: init.method as 'GET',
      url: path,
      headers: init.headers,
      payload: init.body,
    });
    return {
      status: res.statusCode,
      json: async () => (res.body ? JSON.parse(res.body) : null),
      text: async () => res.body,
      header: (name) => {
        const value = res.headers[name.toLowerCase()];
        return typeof value === 'string' ? value : null;
      },
    };
  };
}

/**
 * The agent, with its print retry loop tightened so a test need not wait, and
 * its credential captured.
 *
 * The credential is read off the wire rather than out of the store, because
 * that is how the box's own transport carries it: the test speaks as the box
 * in exactly the form the box does, and it breaks if the format changes, which
 * is the right thing for it to do.
 */
interface TestBox {
  agent: BoxAgent;
  credential: string;
}

async function buildAgent(claimCode?: () => Promise<string | null>): Promise<TestBox> {
  const transport = injectTransport();
  let credential = '';
  const agent = createBoxAgent({
    apiBaseUrl: 'http://print.test',
    credentials: memoryCredentialStore(),
    hostname: 'virtual-print-test',
    fetch: async (url, init) => {
      const auth = init.headers?.authorization;
      if (typeof auth === 'string' && auth.startsWith('Bearer ')) {
        credential = auth.slice('Bearer '.length);
      }
      return transport(url, init);
    },
    claimCode:
      claimCode ?? (async () => (await provisionVirtualBox(ctx.db, ctx.app.log))?.claimCode ?? null),
    printing: { retryDelayMs: 0 },
  });
  await agent.ensureRegistered();
  await agent.syncConfig();
  /**
   * Say that this agent is running in this process, which is what lets the
   * preview routes read its simulators. `startVirtualBox` makes the same claim
   * about the box it brings up; a test driving an agent against this api is
   * the same kind of process making the same claim.
   */
  attachInProcessBox(agent);
  return {
    agent,
    get credential() {
      return credential;
    },
  };
}

/** Which station carries the printer for this printout's role. */
async function stationForKind(type: string): Promise<string> {
  const role = ROLE_FOR_KIND[type as keyof typeof ROLE_FOR_KIND];
  const [row] = await ctx.db
    .select({ stationId: stationDevice.stationId })
    .from(stationDevice)
    .where(eq(stationDevice.role, role as never))
    .limit(1);
  if (!row) throw new Error(`nothing in the seeded fleet carries the ${role} role`);
  return row.stationId;
}

/**
 * The second virtual box, which is where the park's bar printer actually is.
 *
 * `provisionVirtualBox` only ever provisions the slot this deployment is
 * configured for, so box 2 is claimed the way an administrator claims a real
 * Raspberry Pi: reissue its claim code on the Console's own route, then let
 * the agent register with it.
 */
async function buildSecondBox(): Promise<TestBox> {
  const [box2] = await ctx.db.select().from(box).where(eq(box.slot, 'virtual-2')).limit(1);
  if (!box2) throw new Error('the seed no longer carries a second box');
  return buildAgent(async () => {
    const res = await post(`/boxes/${box2.id}/claim-code`);
    if (res.statusCode !== 200) throw new Error(`claim code refused: ${res.body}`);
    return res.json().claimCode as string;
  });
}

async function get(url: string) {
  return ctx.app.inject({ method: 'GET', url, headers: { cookie } });
}

/**
 * Follow a URL the API handed out the way a browser would, and hand the result
 * to Fastify the way the proxy does.
 *
 * **`app.inject` does not prove a browser can reach a route.** It speaks to
 * this server directly, at its own root, and never sees the `/api` prefix that
 * every front end's origin actually uses — so a URL that is unreachable from a
 * page passes here unchanged. That is how the Console's printout preview
 * shipped as a broken image: `previewUrl` went straight into an `<img src>`,
 * the browser asked the Console's own origin for `/devices/…`, and the test
 * that "proved" the PNG was fetched had gone round the front door.
 *
 * So this does both halves. `apiUrl` is the Console's real function, imported
 * rather than copied, and the rewrite below is the one in every front end's
 * vite config (`rewrite: (p) => p.replace(/^\/api/, '')`), which is also what
 * the static site does in staging. A URL that cannot survive the round trip
 * fails here.
 */
function fromBrowser(url: string): string {
  const fetched = apiUrl(url);
  expect(fetched, 'only /api is forwarded to this server').toMatch(/^\/api\//);
  return fetched.replace(/^\/api/, '');
}
async function post(url: string, payload?: unknown, headers: Record<string, string> = {}) {
  return ctx.app.inject({ method: 'POST', url, headers: { cookie, ...headers }, payload: payload as never });
}
async function patch(url: string, payload: unknown) {
  return ctx.app.inject({ method: 'PATCH', url, headers: { cookie }, payload: payload as never });
}

/**
 * Inject a fault exactly the way the Console's Simulators panel does.
 *
 * It rides the ordinary command queue — `POST /boxes/:id/commands` with kind
 * `simulate` — because that is the one door, and the checks it needs live in
 * `queueCommand` behind it rather than on a route of its own.
 */
async function simulate(boxId: string, action: Record<string, unknown>) {
  return post(`/boxes/${boxId}/commands`, { kind: 'simulate', payload: { action } });
}

/**
 * The seeded fleet at Central Floresta.
 *
 * Every lookup is scoped to that branch. Station names and device labels are
 * only unique WITHIN a branch — `station_name_unique` is keyed on
 * (branch, name), and a device is found by (box, label) — and both parks name
 * their first counter "Reception Till 1" and its printer "Receipt Printer 1",
 * exactly as two real sites would. Without the branch filter these queries are
 * `limit(1)` over two matching rows with no ordering, so they can return
 * Robinson Chalong's till or its printer, and a command queued against a
 * printer on another park's box is a command this branch's agent will never
 * run.
 */
async function seededIds() {
  const [central] = await ctx.db
    .select({ id: branch.id })
    .from(branch)
    .where(eq(branch.code, CENTRAL_BRANCH_CODE))
    .limit(1);
  const branchId = central!.id;
  const stationNamed = async (name: string) => {
    const [row] = await ctx.db
      .select()
      .from(station)
      .where(and(eq(station.branchId, branchId), eq(station.name, name)))
      .limit(1);
    return row!;
  };
  const deviceLabelled = async (label: string) => {
    const [row] = await ctx.db
      .select()
      .from(device)
      .where(and(eq(device.branchId, branchId), eq(device.label, label)))
      .limit(1);
    return row!;
  };
  return {
    till: await stationNamed('Reception Till 1'),
    booth: await stationNamed('Booth 1'),
    receipt: await deviceLabelled('Receipt Printer 1'),
    kidsBand: await deviceLabelled('Band Printer (kids)'),
  };
}

// --- The vocabulary, in the one place both copies are importable ------------

describe('the vocabularies that exist twice (S2-06)', () => {
  /**
   * `PrintKind` is declared in `@oto/print/templates/model.ts`, which is
   * authoritative for rendering and cannot be imported by a browser bundle,
   * and again in `@oto/shared/print.ts`, which the Console and the POS read.
   * Neither package can import the other's copy, so the comparison belongs
   * here — the api is the one place both are reachable.
   */
  it('the renderer and the shared package agree on the nine printouts', async () => {
    const renderer = await import('@oto/print/templates');
    // The nine kinds, and which editable template each of them reads.
    expect(renderer.TEMPLATE_FOR_KIND).toEqual(TEMPLATE_FOR_KIND);
    expect(Object.keys(renderer.TEMPLATE_FOR_KIND).sort()).toEqual([...PRINT_KINDS].sort());
    // The six editable types, and the order the panel lists them in.
    expect([...renderer.TEMPLATE_TYPE_ORDER]).toEqual([...PRINT_TEMPLATE_TYPE_ORDER]);
    expect(Object.keys(renderer.APPLICABLE_FIELDS).sort()).toEqual([...PRINT_TEMPLATE_TYPES].sort());
    // Which toggles are meaningful per type, in the order they print. A field
    // added to one copy and not the other is a toggle the editor offers and
    // the paper ignores, which is exactly the drift nothing else would catch.
    for (const type of PRINT_TEMPLATE_TYPES) {
      expect([...renderer.APPLICABLE_FIELDS[type]], type).toEqual([...APPLICABLE_FIELDS[type]]);
    }
  });

  /**
   * The command vocabulary is a CHECK constraint, so a kind the Console offers
   * and the database refuses is a 500 on a button press. The agent's copy and
   * the schema's copy are compared here for the same reason as above.
   */
  it('the agent and the database agree on what a box can be asked to do', () => {
    expect([...AGENT_BOX_COMMAND_KINDS].sort()).toEqual([...DB_BOX_COMMAND_KINDS].sort());
    expect([...AGENT_BOX_COMMAND_KINDS]).toContain('simulate');
  });
});

// --- Templates --------------------------------------------------------------

describe('the Print Templates panel (S2-06)', () => {
  it('lists the six seeded templates in the panel’s own order', async () => {
    const { till } = await seededIds();
    const res = await get(`/branches/${till.branchId}/print-templates`);
    expect(res.statusCode).toBe(200);
    const templates = res.json().templates as { type: string; name: string; version: number }[];
    expect(templates.map((t) => t.type)).toEqual([
      'receipt',
      'kids_wristband',
      'adult_wristband',
      'kitchen_ticket',
      'bar_ticket',
      'credit_voucher',
    ]);
    expect(templates.every((t) => t.version >= 1)).toBe(true);
  });

  it('an edit bumps the version, is audited, and reaches the box with no redeploy', async () => {
    const { agent } = await buildAgent();
    const before = agent.state.configVersion;
    const { till } = await seededIds();
    const [receiptTemplate] = await ctx.db
      .select()
      .from(printTemplate)
      .where(and(eq(printTemplate.branchId, till.branchId), eq(printTemplate.type, 'receipt')))
      .limit(1);

    const res = await patch(`/print-templates/${receiptTemplate!.id}`, {
      showLogo: false,
      footerText: 'ขอบคุณค่ะ · Thank you',
      fields: { itemizedLines: true, taxServiceBreakdown: false, voucherInfo: false },
    });
    expect(res.statusCode).toBe(200);
    const updated = res.json().template as { version: number; showLogo: boolean; footerText: string };
    expect(updated.version).toBe(receiptTemplate!.version + 1);
    expect(updated.showLogo).toBe(false);

    const [row] = await ctx.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.entityId, receiptTemplate!.id), eq(auditLog.action, 'print_template.update')))
      .limit(1);
    expect(row).toBeTruthy();

    // The route a box takes to a changed template: the bundle's hash moved, so
    // the next config pull brings the new footer. Nothing was redeployed.
    expect(await agent.syncConfig()).toBe(true);
    expect(agent.state.configVersion).not.toBe(before);
    const carried = agent.config()!.printTemplates!.find((t) => t.type === 'receipt')!;
    expect(carried.footerText).toBe('ขอบคุณค่ะ · Thank you');
    expect(carried.showLogo).toBe(false);
    expect(carried.version).toBe(updated.version);
  });

  it('refuses a field the editor does not know about rather than storing it', async () => {
    const { till } = await seededIds();
    const [tpl] = await ctx.db
      .select()
      .from(printTemplate)
      .where(and(eq(printTemplate.branchId, till.branchId), eq(printTemplate.type, 'bar_ticket')))
      .limit(1);
    const res = await patch(`/print-templates/${tpl!.id}`, { fields: { madeUpToggle: true } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION');
  });
});

// --- The routed test print --------------------------------------------------

describe('a test print, cloud to box to paper (S2-06)', () => {
  it.each(['station', 'template'] as const)('replays the complete %s test-print answer without another print (SCRUM-387)', async (surface) => {
    const { agent } = await buildAgent();
    const { till } = await seededIds();
    const [template] = await ctx.db.select().from(printTemplate).where(and(
      eq(printTemplate.branchId, till.branchId), eq(printTemplate.type, 'receipt'),
    ));
    const actionId = newId();
    const url = surface === 'station' ? `/stations/${till.id}/test-print` : `/print-templates/${template!.id}/test-print`;
    const payload = surface === 'station' ? { kind: 'receipt' } : { stationId: till.id };
    const headers = { 'idempotency-key': `print-${actionId}`, 'x-oto-action-id': actionId };
    const first = await post(url, payload, headers);
    expect(first.statusCode, first.body).toBe(200);
    expect(first.json().printJob.status).toBe('queued');
    const second = await post(url, payload, headers);
    expect(second.statusCode, second.body).toBe(200);
    expect(second.headers['x-oto-replay']).toBe('true');
    expect(second.json()).toEqual(first.json());
    expect(await ctx.db.select().from(printJob).where(eq(printJob.actionId, actionId))).toHaveLength(1);
    expect(await ctx.db.select().from(boxCommand).where(eq(boxCommand.actionId, actionId))).toHaveLength(1);
    await agent.runPendingCommands();
  });

  /**
   * All six, each at the station whose printer actually carries its role.
   *
   * That is not a convenience: the park's **bar** printer is Counter 2's
   * 80 mm Xprinter on the SECOND box (DEVICE_INVENTORY §2 row 7, and the seed
   * says so), so a bar ticket fired at Reception Till 1 would correctly find
   * nothing. Driving each template at its own station is what makes this a
   * test of routing rather than a test of one till, and it needs both boxes
   * running, as the park does.
   */
  it('prints every editable template on the simulator, from the panel’s own route', async () => {
    const boxes = [await buildAgent(), await buildSecondBox()];
    const { till } = await seededIds();
    const templates = (await get(`/branches/${till.branchId}/print-templates`)).json()
      .templates as { id: string; type: string }[];

    const printed: string[] = [];
    /** Which machine each printout actually came out of. */
    const onDevice = new Map<string, string>();
    for (const template of templates) {
      const at = await stationForKind(template.type);
      const res = await post(`/print-templates/${template.id}/test-print`, { stationId: at });
      expect(res.statusCode, `${template.type}: ${res.body}`).toBe(200);
      const job = res.json().printJob as { id: string; status: string; kind: string };
      expect(job.status).toBe('queued');
      expect(job.kind).toBe(template.type);

      // Whichever box the station belongs to takes it; the other has nothing.
      const ran = (await Promise.all(boxes.map((b) => b.agent.runPendingCommands()))).reduce(
        (a, b) => a + b,
        0,
      );
      expect(ran, `${template.type} was collected by no box`).toBe(1);

      const [row] = await ctx.db.select().from(printJob).where(eq(printJob.id, job.id)).limit(1);
      expect(row!.status, `${template.type} ended ${row!.status} (${row!.errorCode})`).toBe('printed');
      expect(row!.finishedAt).toBeTruthy();
      expect(row!.attempts).toBe(1);
      expect(row!.templateId).toBe(template.id);
      onDevice.set(template.type, row!.deviceId!);
      printed.push(template.type);
    }
    expect(printed).toEqual([
      'receipt',
      'kids_wristband',
      'adult_wristband',
      'kitchen_ticket',
      'bar_ticket',
      'credit_voucher',
    ]);

    /**
     * And the paper is real. Each printout is asked for at the machine it
     * actually came out of — the receipt family shares one printer per
     * station and the bands have their own, so the set of devices here is the
     * routing, read back from the rows rather than assumed.
     */
    expect(new Set(onDevice.values()).size).toBeGreaterThanOrEqual(3);
    for (const [type, deviceId] of onDevice) {
      const list = await get(`/devices/${deviceId}/printouts?limit=20`);
      expect(list.statusCode, `${type}: ${list.body}`).toBe(200);
      const printouts = list.json().printouts as {
        seq: number;
        previewUrl: string;
        truncated: boolean;
        heightDots: number;
      }[];
      expect(printouts.length, type).toBeGreaterThanOrEqual(1);
      expect(printouts.every((p) => !p.truncated && p.heightDots > 0), type).toBe(true);

      const png = await get(fromBrowser(printouts[printouts.length - 1]!.previewUrl));
      expect(png.statusCode).toBe(200);
      expect(png.headers['content-type']).toBe('image/png');
      expect([...png.rawPayload.subarray(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
      // A picture of a receipt must not be cached by anything shared.
      expect(png.headers['cache-control']).toBe('private, no-store');
    }
  });

  /**
   * The claim the whole pipeline rests on, checked rather than asserted.
   *
   * The simulator never sees a bitmap: it receives device bytes and rebuilds
   * the picture from them with the renderer's own reader. So rendering the
   * same job independently here and comparing the two PNGs byte for byte says
   * three things at once — the emitter carried every dot, the transport lost
   * none of them, and the preview the panel shows IS what came off the paper.
   * `packages/print/test/single-renderer.test.ts` keeps there from being a
   * second drawing path; this keeps there from being a second ANSWER.
   *
   * It is also the regression for a defect this test found: the simulator
   * scanned the raster payload for real-time commands, so a receipt whose dots
   * happened to spell `DLE EOT` lost three bytes out of the middle of the
   * picture. One fixture did, one run in two.
   */
  it('the picture off the paper is byte for byte the picture the panel previews', async () => {
    const { agent } = await buildAgent();
    const { till, receipt } = await seededIds();

    await post(`/stations/${till.id}/test-print`, { kind: 'test_page' });
    expect(await agent.runPendingCommands()).toBe(1);

    const list = await get(`/devices/${receipt.id}/printouts?limit=1`);
    const printouts = list.json().printouts as { previewUrl: string }[];
    const served = await get(fromBrowser(printouts[0]!.previewUrl));
    expect(served.statusCode).toBe(200);

    const deviceRow = agent
      .config()!
      .stations.flatMap((s) => s.devices)
      .find((d) => d.id === receipt.id)!;
    const expected = previewPng(
      renderJob(await testPrintJob('test_page'), { device: profileFor(deviceRow) }).bitmap,
    );
    expect(Buffer.from(served.rawPayload).equals(Buffer.from(expected))).toBe(true);
  });

  /**
   * The Print Templates editor's preview, and the claim under it.
   *
   * The editor used to draw its own receipt in HTML — its own fonts, its own
   * wrapping, its own sample content — beside a "Test print" button whose
   * comment said both came from one renderer. They did not, and a preview that
   * is only a resemblance cannot answer the question it is on screen for: does
   * the Thai line have glyphs, does the name wrap, does the content fit the
   * band. So the preview is now a PNG from `@oto/print`, and this is what says
   * so: the picture the editor shows and the picture rebuilt from the bytes
   * the printer received are the same bytes.
   */
  it('the editor’s preview is the bitmap the printer is sent, to the byte', async () => {
    const { agent } = await buildAgent();
    const { till, receipt } = await seededIds();
    const templates = (await get(`/branches/${till.branchId}/print-templates`)).json()
      .templates as { id: string; type: string }[];
    const tpl = templates.find((t) => t.type === 'receipt')!;

    const preview = await post(`/print-templates/${tpl.id}/preview.png`, { stationId: till.id });
    expect(preview.statusCode, preview.body).toBe(200);
    expect(preview.headers['content-type']).toBe('image/png');
    expect(preview.headers['cache-control']).toBe('private, no-store');

    await post(`/stations/${till.id}/test-print`, { kind: 'receipt' });
    expect(await agent.runPendingCommands()).toBe(1);
    const list = await get(`/devices/${receipt.id}/printouts?limit=1`);
    const printouts = list.json().printouts as { previewUrl: string }[];
    const paper = await get(fromBrowser(printouts[0]!.previewUrl));

    expect(
      Buffer.from(preview.rawPayload).equals(Buffer.from(paper.rawPayload)),
      'the preview and the paper are one drawing path or they are two',
    ).toBe(true);
  });

  it('toggling a field changes the next preview, with nothing saved', async () => {
    const { till } = await seededIds();
    const templates = (await get(`/branches/${till.branchId}/print-templates`)).json()
      .templates as { id: string; type: string; showLogo: boolean; version: number }[];
    const tpl = templates.find((t) => t.type === 'receipt')!;

    const withLogo = await post(`/print-templates/${tpl.id}/preview.png`, { showLogo: true });
    const without = await post(`/print-templates/${tpl.id}/preview.png`, { showLogo: false });
    expect(withLogo.statusCode).toBe(200);
    expect(without.statusCode).toBe(200);
    expect(
      Buffer.from(withLogo.rawPayload).equals(Buffer.from(without.rawPayload)),
      'a toggle that changes nothing on the paper is a toggle that does nothing',
    ).toBe(false);

    // And previewing a draft changed nothing: it is a picture, not an edit.
    const after = (await get(`/branches/${till.branchId}/print-templates`)).json().templates as {
      id: string;
      showLogo: boolean;
      version: number;
    }[];
    const same = after.find((t) => t.id === tpl.id)!;
    expect(same.showLogo).toBe(tpl.showLogo);
    expect(same.version).toBe(tpl.version);
  });

  it('a band template previews at the band printer’s width, not the receipt’s', async () => {
    const { till, kidsBand } = await seededIds();
    const templates = (await get(`/branches/${till.branchId}/print-templates`)).json()
      .templates as { id: string; type: string }[];
    const band = templates.find((t) => t.type === 'kids_wristband')!;
    const receiptTpl = templates.find((t) => t.type === 'receipt')!;

    const bandPreview = await post(`/print-templates/${band.id}/preview.png`, {});
    const receiptPreview = await post(`/print-templates/${receiptTpl.id}/preview.png`, {});
    expect(bandPreview.statusCode, bandPreview.body).toBe(200);
    /**
     * The width is the printer's, so a preview says something true about
     * whether the content fits. The seeded kids band printer is TSPL2 label
     * stock and the receipt printer is 80 mm thermal; a preview drawn at one
     * width for both would be the old resemblance in a new place.
     */
    expect(bandPreview.headers['x-oto-preview-width-dots']).not.toBe(
      receiptPreview.headers['x-oto-preview-width-dots'],
    );
    expect(kidsBand.kind).toBe('band_printer');
  });

  it('a job for a role no printer is assigned to is skipped, not failed', async () => {
    const { booth } = await seededIds();
    const headers = { 'idempotency-key': `skipped-${newId()}` };
    const res = await post(`/stations/${booth.id}/test-print`, { kind: 'kids_wristband' }, headers);
    expect(res.statusCode).toBe(200);
    const job = res.json().printJob as { id: string; status: string; errorCode: string };
    expect(job.status).toBe('skipped');
    expect(job.errorCode).toBe('NO_DEVICE_FOR_ROLE');
    expect(res.json().commandId).toBe('');
    const replay = await post(`/stations/${booth.id}/test-print`, { kind: 'kids_wristband' }, headers);
    expect(replay.statusCode, replay.body).toBe(200);
    expect(replay.headers['x-oto-replay']).toBe('true');
    expect(replay.json()).toEqual(res.json());

    // Nothing was raised. A station with no band printer is a choice.
    const failures = await ctx.db
      .select()
      .from(opsRun)
      .where(eq(opsRun.name, 'device:printer.NO_DEVICE_FOR_ROLE'));
    expect(failures).toHaveLength(0);
  });
});

// --- Paper out --------------------------------------------------------------

describe('paper out, from the Simulators panel (S2-06)', () => {
  it('queues the job, turns the device red on the heartbeat, and prints on clearing', async () => {
    const { agent } = await buildAgent();
    const { till, receipt } = await seededIds();
    const [boxRow] = await ctx.db.select().from(box).where(eq(box.id, agent.state.boxId!)).limit(1);

    const injected = await simulate(boxRow!.id, {
      action: 'printer.fault',
      deviceId: receipt.id,
      fault: 'paper_out',
    });
    expect(injected.statusCode, injected.body).toBe(200);
    expect(await agent.runPendingCommands()).toBe(1);

    const started = await post(`/stations/${till.id}/test-print`, { kind: 'test_page' });
    const jobId = started.json().printJob.id as string;
    expect(await agent.runPendingCommands()).toBe(1);

    const [queued] = await ctx.db.select().from(printJob).where(eq(printJob.id, jobId)).limit(1);
    expect(queued!.status).toBe('queued');
    expect(queued!.errorCode).toBe('PRINTER_PAPER_OUT');
    expect(queued!.finishedAt).toBeNull();

    // The heartbeat is the schedule §7.3 names, so the indicator turns red
    // within one interval rather than when somebody notices a missing receipt.
    await agent.heartbeat();
    const [deviceRow] = await ctx.db.select().from(device).where(eq(device.id, receipt.id)).limit(1);
    expect(deviceRow!.paperStatus).toBe('out');

    // Clearing the paper is one gesture at the machine, not a list of faults.
    const cleared = await simulate(boxRow!.id, {
      action: 'printer.clear',
      deviceId: receipt.id,
    });
    expect(cleared.statusCode).toBe(200);
    expect(await agent.runPendingCommands()).toBe(1);

    // The queued job goes out on the next heartbeat, with no second button.
    await agent.heartbeat();
    const [printed] = await ctx.db.select().from(printJob).where(eq(printJob.id, jobId)).limit(1);
    expect(printed!.status).toBe('printed');
    expect(printed!.attempts).toBeGreaterThanOrEqual(2);

    const [afterRow] = await ctx.db.select().from(device).where(eq(device.id, receipt.id)).limit(1);
    expect(afterRow!.paperStatus).toBe('ok');
  });

  it('a fault cannot be injected into a real printer', async () => {
    const { agent } = await buildAgent();
    const [boxRow] = await ctx.db.select().from(box).where(eq(box.id, agent.state.boxId!)).limit(1);
    const { receipt } = await seededIds();
    await ctx.db.update(device).set({ transport: 'lan' }).where(eq(device.id, receipt.id));
    try {
      await simulate(boxRow!.id, {
        action: 'printer.fault',
        deviceId: receipt.id,
        fault: 'paper_out',
      });
      await agent.syncConfig();
      expect(await agent.runPendingCommands()).toBe(1);
      const commands = (await get(`/boxes/${boxRow!.id}/commands?limit=1`)).json().commands as {
        state: string;
        errorCode: string | null;
      }[];
      expect(commands[0]!.state).toBe('failed');
      expect(commands[0]!.errorCode).toBe('DEVICE_NOT_SIMULATED');
    } finally {
      await ctx.db.update(device).set({ transport: 'simulated' }).where(eq(device.id, receipt.id));
    }
  });

  it('a badge or a PIN is refused rather than written into a stored payload', async () => {
    const { agent } = await buildAgent();
    const [boxRow] = await ctx.db.select().from(box).where(eq(box.id, agent.state.boxId!)).limit(1);
    const { till } = await seededIds();
    const res = await simulate(boxRow!.id, {
      action: 'pin.enter',
      stationId: till.id,
      pin: '1234',
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('SIMULATOR_ACTION_CARRIES_SECRET');
  });
});

// --- Failure, the record, and the reprint -----------------------------------

describe('what a failure leaves behind (S2-06)', () => {
  it('an unreachable printer ends the job failed and files one ops_run', async () => {
    const { agent, credential } = await buildAgent();
    const { till, receipt } = await seededIds();
    const [boxRow] = await ctx.db.select().from(box).where(eq(box.id, agent.state.boxId!)).limit(1);

    await simulate(boxRow!.id, {
      action: 'printer.fault',
      deviceId: receipt.id,
      fault: 'unreachable',
    });
    await agent.runPendingCommands();

    const started = await post(`/stations/${till.id}/test-print`, { kind: 'test_page' });
    const jobId = started.json().printJob.id as string;
    await agent.runPendingCommands();

    /**
     * An unreachable printer is retryable — the cable may be back in a minute
     * — so the job queues. It only becomes `failed` when the box gives up,
     * which is what the attempt ceiling is for; here it is forced by reporting
     * the terminal outcome the box would eventually send.
     */
    const reported = await ctx.app.inject({
      method: 'POST',
      url: `/box/v1/print-jobs/${jobId}/result`,
      headers: { authorization: `Bearer ${credential}` },
      payload: {
        status: 'failed',
        attempts: 20,
        deviceId: receipt.id,
        errorCode: 'PRINTER_UNREACHABLE',
        errorMessage: 'Receipt Printer 1 does not answer',
      } as never,
    });
    expect(reported.statusCode, reported.body).toBe(200);
    expect(reported.json().replayed).toBe(false);

    const [row] = await ctx.db.select().from(printJob).where(eq(printJob.id, jobId)).limit(1);
    expect(row!.status).toBe('failed');
    expect(row!.errorCode).toBe('PRINTER_UNREACHABLE');

    const runs = await ctx.db
      .select()
      .from(opsRun)
      .where(eq(opsRun.name, 'device:printer.PRINTER_UNREACHABLE'));
    expect(runs).toHaveLength(1);
    expect(runs[0]!.outcome).toBe('failed');
    // Sixty of these read as one problem on the Failures page.
    expect(runs[0]!.fingerprint).toBeTruthy();

    // A second report of a terminal job changes nothing and says so, which is
    // what stops a box whose acknowledgement was lost retrying for ever.
    const again = await ctx.app.inject({
      method: 'POST',
      url: `/box/v1/print-jobs/${jobId}/result`,
      headers: { authorization: `Bearer ${credential}` },
      payload: { status: 'printed', attempts: 21 } as never,
    });
    expect(again.json().replayed).toBe(true);
    const [unchanged] = await ctx.db.select().from(printJob).where(eq(printJob.id, jobId)).limit(1);
    expect(unchanged!.status).toBe('failed');

    await simulate(boxRow!.id, {
      action: 'printer.clear',
      deviceId: receipt.id,
    });
    await agent.runPendingCommands();
  });

  it('a reprint is a new job pointing at the original, with a reason', async () => {
    const { agent } = await buildAgent();
    const { till } = await seededIds();
    const first = await post(`/stations/${till.id}/test-print`, { kind: 'receipt' });
    const original = first.json().printJob.id as string;
    await agent.runPendingCommands();

    const headers = { 'idempotency-key': `reprint-${newId()}` };
    const res = await post(`/print-jobs/${original}/reprint`, { reason: 'The guest asked for a copy' }, headers);
    expect(res.statusCode, res.body).toBe(200);
    const copy = res.json().printJob as { id: string; reprintOf: string };
    expect(copy.reprintOf).toBe(original);
    const replay = await post(`/print-jobs/${original}/reprint`, { reason: 'The guest asked for a copy' }, headers);
    expect(replay.statusCode, replay.body).toBe(200);
    expect(replay.headers['x-oto-replay']).toBe('true');
    expect(replay.json()).toEqual(res.json());
    expect(await ctx.db.select().from(printJob).where(eq(printJob.reprintOf, original))).toHaveLength(1);
    await agent.runPendingCommands();

    // A copy of the copy still points at the ORIGINAL, so counting the copies
    // of one receipt is one indexed query rather than a walk down a chain the
    // retention sweep may already have broken.
    const third = await post(`/print-jobs/${copy.id}/reprint`, { reason: 'And another' });
    expect(third.json().printJob.reprintOf).toBe(original);
  });

  it('a box may only speak about its own print jobs', async () => {
    const { credential } = await buildAgent();
    const { till } = await seededIds();
    const started = await post(`/stations/${till.id}/test-print`, { kind: 'test_page' });
    const jobId = started.json().printJob.id as string;

    // Point the row at another box; the same credential must no longer reach
    // it — and it must answer 404, never 403, so an id cannot be confirmed.
    const [other] = await ctx.db
      .select()
      .from(box)
      .where(eq(box.slot, 'virtual-2'))
      .limit(1);
    await ctx.db.update(printJob).set({ boxId: other!.id }).where(eq(printJob.id, jobId));

    const res = await ctx.app.inject({
      method: 'POST',
      url: `/box/v1/print-jobs/${jobId}/result`,
      headers: { authorization: `Bearer ${credential}` },
      payload: { status: 'printed', attempts: 1 } as never,
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('PRINT_JOB_NOT_FOUND');
  });
});

// --- The queue, as the Console reads it -------------------------------------

describe('the print record (S2-06)', () => {
  it('lists a branch’s jobs newest first and filters by status', async () => {
    const { till } = await seededIds();
    const all = await get(`/branches/${till.branchId}/print-jobs?limit=200`);
    expect(all.statusCode).toBe(200);
    const jobs = all.json().jobs as { queuedAt: string; status: string; deviceLabel: string | null }[];
    expect(jobs.length).toBeGreaterThan(0);
    const times = jobs.map((j) => Date.parse(j.queuedAt));
    expect([...times].sort((a, b) => b - a)).toEqual(times);

    const skipped = await get(`/branches/${till.branchId}/print-jobs?status=skipped`);
    expect((skipped.json().jobs as { status: string }[]).every((j) => j.status === 'skipped')).toBe(true);

    // The label is joined, so the Console can say which machine without a
    // second round trip per row.
    expect(jobs.some((j) => j.deviceLabel === 'Receipt Printer 1')).toBe(true);
  });

  it('the seeded bar role exists, so the bar ticket has somewhere to go', async () => {
    const rows = await ctx.db
      .select({ role: stationDevice.role, label: device.label })
      .from(stationDevice)
      .innerJoin(device, eq(stationDevice.deviceId, device.id))
      .where(eq(stationDevice.role, 'bar'));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.label).toBe('Receipt Printer 3');
  });
});

// --- The Console's Test print -----------------------------------------------

/**
 * SCRUM-364 — the Box drawer's Test print, and the row its outcome lands on.
 *
 * The drawer used to queue a bare `test_print` command, which is one row where
 * the flow needs two: the command the box collects, and the `edge.print_job`
 * the box's outcome is reported against. Paper came out, the command read
 * `succeeded`, the report was refused `PRINT_JOB_NOT_FOUND`, and the drawer's
 * Printing panel listed nothing — a control whose failure mode was being
 * quietly right-looking.
 *
 * So the drawer now presses `POST /stations/:id/test-print`, which is
 * `requestTestPrint`'s door and the only path that writes both rows. What
 * follows sends exactly what the drawer sends and then lets the box speak for
 * itself: no row is written here, and the assertion is that the outcome the
 * agent posts up `/box/v1/print-jobs/:id/result` is accepted and lands on the
 * job the press created.
 */
describe('the Console’s Test print (SCRUM-364)', () => {
  it('leaves a print job the box’s own outcome report lands on', async () => {
    const { agent } = await buildAgent();
    const { till, receipt } = await seededIds();

    /**
     * Whatever the cases above left queued on this box is collected first, so
     * the poll under test carries this press and the leftovers' own noise is
     * behind the mark — one of those cases repoints a job at the other box on
     * purpose, and the refusal that earns is a line in this agent's log that
     * says nothing about this case.
     */
    await agent.runPendingCommands();
    const logged = agent.recentLogs(500).length;

    /**
     * The drawer's two pickers, as a request body: the station it chose, and
     * the job that station's printer does. `station_device_role_unique` makes
     * (station, role) name one device, which is why the press need not — and
     * on the box, cannot — name a device id.
     */
    const pressed = await post(`/stations/${till.id}/test-print`, {
      kind: 'test_page',
      role: 'receipt',
    });
    expect(pressed.statusCode, pressed.body).toBe(200);
    const queuedJob = pressed.json().printJob as {
      id: string;
      boxId: string;
      status: string;
      deviceId: string | null;
      role: string | null;
    };
    const commandId = pressed.json().commandId as string;
    expect(queuedJob.status).toBe('queued');
    // The cloud's own routing of the same pair, on the row, so the panel can
    // say which machine it is waiting on rather than only that it is waiting.
    expect(queuedJob.deviceId).toBe(receipt.id);
    expect(queuedJob.role).toBe('receipt');

    /**
     * The link, which is the whole fix: the command the box collects carries
     * the id of the row written for it. Without it the box reports against its
     * own command id and the cloud has nothing to write on.
     */
    const commands = (await get(`/boxes/${queuedJob.boxId}/commands?limit=5`)).json()
      .commands as { id: string; kind: string; payload: Record<string, unknown> | null }[];
    const command = commands.find((c) => c.id === commandId);
    expect(command?.kind).toBe('test_print');
    expect(command?.payload?.printJobId).toBe(queuedJob.id);
    // SCRUM-358's behaviour, still on the payload: the box routes by the job a
    // printer does at a station, never by a device id.
    expect(command?.payload?.role).toBe('receipt');
    expect(command?.payload?.stationId).toBe(till.id);

    /**
     * The box takes it, prints it, and reports the outcome on its own route.
     * Counted as "at least this one" rather than exactly one: the cases above
     * share this box, and whatever they left queued is collected in the same
     * poll — which is why the state below is read off THIS command by id.
     */
    expect(await agent.runPendingCommands()).toBeGreaterThanOrEqual(1);
    const ran = (await get(`/boxes/${queuedJob.boxId}/commands?limit=25`)).json().commands as {
      id: string;
      state: string;
    }[];
    expect(ran.find((c) => c.id === commandId)?.state).toBe('succeeded');
    expect(
      agent
        .recentLogs(500)
        .slice(logged)
        .some((line) => line.includes('did not accept a print job outcome')),
      'the box was refused when it reported what happened to the paper',
    ).toBe(false);

    const [row] = await ctx.db.select().from(printJob).where(eq(printJob.id, queuedJob.id)).limit(1);
    expect(row!.status, `the job ended ${row!.status} (${row!.errorCode})`).toBe('printed');
    expect(row!.finishedAt).toBeTruthy();
    expect(row!.deviceId).toBe(receipt.id);
    expect(row!.attempts).toBe(1);

    /**
     * And what the drawer's Printing panel actually reads — `GET /boxes/:id/
     * print-jobs`, with the device label joined on, which is the line a person
     * looks at after pressing the button.
     */
    const listed = (await get(`/boxes/${queuedJob.boxId}/print-jobs?limit=12`)).json().jobs as {
      id: string;
      status: string;
      kind: string;
      deviceLabel: string | null;
      role: string | null;
    }[];
    expect(listed[0]).toMatchObject({
      id: queuedJob.id,
      status: 'printed',
      kind: 'test_page',
      deviceLabel: 'Receipt Printer 1',
      role: 'receipt',
    });
  });

  /**
   * The door the drawer no longer uses, and why — kept as a reading rather
   * than as a rule.
   *
   * `POST /boxes/:id/commands` queues the command and writes no print job, so
   * the box prints and is then refused when it says what happened. That is
   * still true of every caller of that route (the till's Station Setup screen
   * is one, `apps/pos/src/api/platform.ts`), which is why this is written down
   * here: whoever fixes those has this test to delete, and knows what it was
   * for.
   */
  it('a bare test_print command leaves no job, and the box’s report is refused', async () => {
    const { agent } = await buildAgent();
    const { receipt } = await seededIds();
    const [boxRow] = await ctx.db.select().from(box).where(eq(box.id, agent.state.boxId!)).limit(1);
    // As above: anything left queued is collected before the mark, so the log
    // line read afterwards belongs to this press.
    await agent.runPendingCommands();
    const logged = agent.recentLogs(500).length;
    const before = await ctx.db.select().from(printJob).where(eq(printJob.boxId, boxRow!.id));

    const queued = await post(`/boxes/${boxRow!.id}/commands`, {
      kind: 'test_print',
      payload: { deviceId: receipt.id },
    });
    expect(queued.statusCode, queued.body).toBe(200);
    expect(await agent.runPendingCommands()).toBeGreaterThanOrEqual(1);

    // The command itself is fine: the box understood it and paper came out.
    const commands = (await get(`/boxes/${boxRow!.id}/commands?limit=25`)).json().commands as {
      id: string;
      state: string;
    }[];
    expect(commands.find((c) => c.id === queued.json().commandId)?.state).toBe('succeeded');

    // And the platform has no record of the printout.
    const after = await ctx.db.select().from(printJob).where(eq(printJob.boxId, boxRow!.id));
    expect(after.length).toBe(before.length);
    expect(
      agent
        .recentLogs(500)
        .slice(logged)
        .some((line) => line.includes('did not accept a print job outcome')),
      'the box reported an outcome against a job the cloud never wrote',
    ).toBe(true);
  });
});
