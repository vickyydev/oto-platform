import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, asc, eq, ne } from 'drizzle-orm';
import {
  box,
  boxCommand,
  branch,
  device,
  printJob,
  printTemplate,
  station,
  stationDevice,
} from '@oto/db';
import { newId } from '@oto/shared';
import { PRINT_SAMPLE_NAMES } from '@oto/print';
import { createBoxAgent, memoryCredentialStore, type AgentFetch } from '@oto/box-agent';
import { boxAuthFromRow, pollCommands, provisionVirtualBox } from '../src/services/box';
import { boxHoldsCurrentConfig } from '../src/services/print';
import {
  createTestContext,
  signInAs,
  teardownAll,
  ADMIN,
  CENTRAL_BRANCH_CODE,
  type TestContext,
} from './helpers';
// The editor's own list, not a copy of it — the two are held to one spelling.
import { PREVIEW_SAMPLES } from '../../pos/src/components/admin/templates/previewSamples';

/**
 * SCRUM-472 — the template editor's scenario switcher and its named Test print.
 *
 * The preview route takes a scenario by name, validated against `@oto/print`'s
 * own list, and the default is still the fixture a test print puts on paper —
 * so the byte-for-byte guarantee in `print-api.test.ts` is untouched by the
 * other scenarios existing. And the editor can ask, before anyone presses
 * anything, which printer a Test print from its station would reach: the same
 * routing the preview is laid out for and the test print itself takes.
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
    const res = await ctx.app.inject({
      method: init.method as 'GET',
      url: url.replace(/^https?:\/\/[^/]+/, ''),
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

async function get(url: string, withCookie = true) {
  return ctx.app.inject({ method: 'GET', url, headers: withCookie ? { cookie } : {} });
}
async function post(url: string, payload?: unknown, headers: Record<string, string> = {}) {
  return ctx.app.inject({
    method: 'POST',
    url,
    headers: { cookie, ...headers },
    payload: payload as never,
  });
}

/** The seeded fleet at Central, scoped to that branch (names repeat across parks). */
async function central() {
  const [row] = await ctx.db
    .select({ id: branch.id })
    .from(branch)
    .where(eq(branch.code, CENTRAL_BRANCH_CODE))
    .limit(1);
  const branchId = row!.id;
  const stationNamed = async (name: string) => {
    const [s] = await ctx.db
      .select()
      .from(station)
      .where(and(eq(station.branchId, branchId), eq(station.name, name)))
      .limit(1);
    return s!;
  };
  const [receiptPrinter] = await ctx.db
    .select()
    .from(device)
    .where(and(eq(device.branchId, branchId), eq(device.label, 'Receipt Printer 1')))
    .limit(1);
  const templates = (await get(`/branches/${branchId}/print-templates`)).json().templates as {
    id: string;
    type: string;
  }[];
  const template = (type: string) => templates.find((t) => t.type === type)!;
  return {
    branchId,
    till: await stationNamed('Reception Till 1'),
    booth: await stationNamed('Booth 1'),
    receiptPrinter: receiptPrinter!,
    template,
    templates,
  };
}

describe('the preview’s scenario switcher (SCRUM-472)', () => {
  it('the editor offers exactly the scenarios the renderer has, default first', () => {
    expect(PREVIEW_SAMPLES.map((s) => s.id)).toEqual([...PRINT_SAMPLE_NAMES]);
  });

  it('draws the receipt in every scenario, each its own picture, the default unchanged', async () => {
    const { till, template } = await central();
    const receipt = template('receipt');
    const pictures = new Map<string, Buffer>();
    for (const sample of PRINT_SAMPLE_NAMES) {
      const res = await post(`/print-templates/${receipt.id}/preview.png`, {
        stationId: till.id,
        sample,
      });
      expect(res.statusCode, `${sample}: ${res.body}`).toBe(200);
      expect(res.headers['content-type']).toBe('image/png');
      expect(res.headers['cache-control']).toBe('private, no-store');
      pictures.set(sample, Buffer.from(res.rawPayload));
    }
    const distinct = new Set([...pictures.values()].map((b) => b.toString('base64')));
    expect(distinct.size, 'a scenario that draws the same as another is not a scenario').toBe(
      PRINT_SAMPLE_NAMES.length,
    );

    // Naming no scenario is the fixture — the same request the editor sent
    // before scenarios existed, and the picture a test print matches.
    const plain = await post(`/print-templates/${receipt.id}/preview.png`, { stationId: till.id });
    expect(plain.statusCode).toBe(200);
    expect(Buffer.from(plain.rawPayload).equals(pictures.get('standard')!)).toBe(true);
  });

  it('every template draws in every scenario, at the width of its own printer', async () => {
    const { templates } = await central();
    expect(templates.length).toBeGreaterThanOrEqual(6);
    for (const tpl of templates) {
      const standard = await post(`/print-templates/${tpl.id}/preview.png`, {});
      expect(standard.statusCode, `${tpl.type}: ${standard.body}`).toBe(200);
      for (const sample of PRINT_SAMPLE_NAMES.filter((s) => s !== 'standard')) {
        const res = await post(`/print-templates/${tpl.id}/preview.png`, { sample });
        expect(res.statusCode, `${tpl.type} ${sample}: ${res.body}`).toBe(200);
        // The scenario changes what is printed, never the paper it is printed on.
        expect(res.headers['x-oto-preview-width-dots']).toBe(
          standard.headers['x-oto-preview-width-dots'],
        );
      }
    }
  });

  it('refuses a scenario the renderer does not have, rather than drawing the default', async () => {
    const { template } = await central();
    const res = await post(`/print-templates/${template('receipt').id}/preview.png`, {
      sample: 'birthday_blowout',
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION');
  });

  it('a scenario changes nothing stored: it is a picture, not an edit', async () => {
    const { branchId, template } = await central();
    const before = template('receipt') as unknown as { version: number };
    await post(`/print-templates/${template('receipt').id}/preview.png`, { sample: 'full' });
    const after = (await get(`/branches/${branchId}/print-templates`)).json().templates.find(
      (t: { type: string }) => t.type === 'receipt',
    ) as { version: number };
    expect(after.version).toBe(before.version);
  });
});

describe('where the editor’s Test print will come out (SCRUM-472)', () => {
  it('names the printer the station routes this printout to', async () => {
    const { till, template, receiptPrinter } = await central();
    const receipt = template('receipt');
    const res = await get(`/print-templates/${receipt.id}/test-print-target?stationId=${till.id}`);
    expect(res.statusCode, res.body).toBe(200);
    const target = res.json() as {
      printer: { deviceId: string; label: string } | null;
      note: string | null;
      widthDots: number;
    };
    expect(target.printer).toEqual({ deviceId: receiptPrinter.id, label: 'Receipt Printer 1' });
    expect(target.note).toBeNull();

    // The width it names is the width the preview is drawn at.
    const preview = await post(`/print-templates/${receipt.id}/preview.png`, { stationId: till.id });
    expect(String(target.widthDots)).toBe(preview.headers['x-oto-preview-width-dots']);
  });

  it('is the printer the test print then really goes to', async () => {
    // A test print needs a box that has registered; bring the till's up the
    // way `print-api.test.ts` does — the agent a Raspberry Pi runs, speaking
    // to this api through `app.inject`.
    const agent = createBoxAgent({
      apiBaseUrl: 'http://print-472.test',
      credentials: memoryCredentialStore(),
      hostname: 'virtual-print-472',
      fetch: injectTransport(),
      claimCode: async () => (await provisionVirtualBox(ctx.db, ctx.app.log))?.claimCode ?? null,
      printing: { retryDelayMs: 0 },
    });
    await agent.ensureRegistered();
    await agent.syncConfig();

    const { till, template } = await central();
    const receipt = template('receipt');
    const target = (
      await get(`/print-templates/${receipt.id}/test-print-target?stationId=${till.id}`)
    ).json() as { printer: { deviceId: string } | null };
    const printed = await post(`/print-templates/${receipt.id}/test-print`, { stationId: till.id });
    expect(printed.statusCode, printed.body).toBe(200);
    expect(printed.json().printJob.deviceId).toBe(target.printer!.deviceId);
  });

  it('says in words when a station has no printer for the printout', async () => {
    const { booth, template } = await central();
    const res = await get(
      `/print-templates/${template('kids_wristband').id}/test-print-target?stationId=${booth.id}`,
    );
    expect(res.statusCode, res.body).toBe(200);
    const target = res.json() as { printer: unknown; note: string | null; widthDots: number };
    expect(target.printer).toBeNull();
    expect(target.note).toBe('No kids band printer is assigned to this station');
    // Still a width: the preview falls back to the defaults for the kind.
    expect(target.widthDots).toBeGreaterThan(0);
  });

  it('asks nothing of a caller with no session', async () => {
    const { till, template } = await central();
    const res = await get(
      `/print-templates/${template('receipt').id}/test-print-target?stationId=${till.id}`,
      false,
    );
    expect(res.statusCode).toBe(401);
  });

  it('a station that is not one is a 400, not a guess', async () => {
    const { template } = await central();
    const res = await get(`/print-templates/${template('receipt').id}/test-print-target?stationId=nope`);
    expect(res.statusCode).toBe(400);
  });
});

/**
 * FIX ROUND — "Save & print test" printed the template as it was BEFORE the
 * save.
 *
 * The box renders a test print with the templates it cached at its last
 * config pull. It pulls when a heartbeat's answer names a newer version, once
 * a minute, or on a `config_apply`; the command poll runs every five seconds
 * and never looks at the version. So a save followed a second later by a test
 * print — the editor's one button — came out of the printer unchanged unless a
 * heartbeat happened to land between the two. The route now queues a pull
 * ahead of the print whenever the box has not confirmed the configuration it
 * would be handed now, and this drives the whole path: the agent a Pi runs,
 * the simulator at the far end, and the paper compared with the preview.
 */
describe('Save & print test puts the saved template on paper (SCRUM-472)', () => {
  it('queues a config pull ahead of the print, and the paper is the template as saved', async () => {
    const agent = createBoxAgent({
      apiBaseUrl: 'http://print-472-save.test',
      credentials: memoryCredentialStore(),
      hostname: 'virtual-print-472-save',
      fetch: injectTransport(),
      claimCode: async () => (await provisionVirtualBox(ctx.db, ctx.app.log))?.claimCode ?? null,
      printing: { retryDelayMs: 0 },
    });
    await agent.ensureRegistered();
    await agent.syncConfig();
    // Whatever an earlier test left queued on this box goes first.
    await agent.runPendingCommands();
    // The box confirms what it holds. Its own status (offline until it beats)
    // is part of the bundle, so the version moves under the first beat and the
    // box reports the one it then pulled on the beat after: beat until the
    // platform sees it holding the configuration it would be handed now.
    const holdsCurrent = async () => {
      const [row] = await ctx.db.select().from(box).where(eq(box.id, agent.state.boxId!)).limit(1);
      return boxHoldsCurrentConfig(ctx.db, row!);
    };
    for (let beat = 0; beat < 5 && !(await holdsCurrent()); beat += 1) await agent.heartbeat();
    expect(await holdsCurrent()).toBe(true);

    const { till, template, receiptPrinter } = await central();
    const receipt = template('receipt');
    const [original] = await ctx.db
      .select()
      .from(printTemplate)
      .where(eq(printTemplate.id, receipt.id))
      .limit(1);
    const kindsFor = async (actionId: string) =>
      (
        await ctx.db
          .select({ kind: boxCommand.kind })
          .from(boxCommand)
          .where(eq(boxCommand.actionId, actionId))
          .orderBy(asc(boxCommand.createdAt))
      ).map((r) => r.kind);

    try {
      // A box that holds the current configuration is not asked to pull.
      const plainAction = newId();
      const plain = await post(
        `/print-templates/${receipt.id}/test-print`,
        { stationId: till.id },
        { 'x-oto-action-id': plainAction },
      );
      expect(plain.statusCode, plain.body).toBe(200);
      expect(await kindsFor(plainAction)).toEqual(['test_print']);
      expect(await agent.runPendingCommands()).toBe(1);

      const before = await post(`/print-templates/${receipt.id}/preview.png`, { stationId: till.id });
      expect(before.statusCode).toBe(200);

      // The editor's "Save & print test": PATCH, then the print, at once.
      const saved = await ctx.app.inject({
        method: 'PATCH',
        url: `/print-templates/${receipt.id}`,
        headers: { cookie },
        payload: {
          showLogo: !original!.showLogo,
          fields: { ...(original!.fields as Record<string, boolean>), itemizedLines: false },
        },
      });
      expect(saved.statusCode, saved.body).toBe(200);
      const savedVersion = saved.json().template.version as number;

      const action = newId();
      const printed = await post(
        `/print-templates/${receipt.id}/test-print`,
        { stationId: till.id },
        { 'x-oto-action-id': action },
      );
      expect(printed.statusCode, printed.body).toBe(200);
      // The pull first, the print behind it, as one gesture.
      expect(await kindsFor(action)).toEqual(['config_apply', 'test_print']);
      expect(await agent.runPendingCommands()).toBe(2);

      const [job] = await ctx.db
        .select()
        .from(printJob)
        .where(eq(printJob.id, printed.json().printJob.id as string))
        .limit(1);
      expect(job!.status, `${job!.errorCode}`).toBe('printed');
      expect(job!.templateVersion).toBe(savedVersion);

      // The paper is the saved template, to the byte — not the one before it.
      const after = await post(`/print-templates/${receipt.id}/preview.png`, { stationId: till.id });
      expect(Buffer.from(after.rawPayload).equals(Buffer.from(before.rawPayload))).toBe(false);
      const [paper] = agent.printing()!.printouts(receiptPrinter.id, 1);
      expect(paper, 'nothing came out of the receipt printer').toBeTruthy();
      expect(
        Buffer.from(paper!.preview).equals(Buffer.from(after.rawPayload)),
        'the test print came out as the template was before the save',
      ).toBe(true);
    } finally {
      await ctx.db
        .update(printTemplate)
        .set({ showLogo: original!.showLogo, fields: original!.fields })
        .where(eq(printTemplate.id, receipt.id));
    }
  });

  it('a print that cannot be queued leaves no pull behind', async () => {
    // The booth has no kids band printer: the print is recorded skipped, in
    // the cloud, and the box is not woken for a pull it has no use for.
    const { booth, template } = await central();
    const action = newId();
    const res = await post(
      `/print-templates/${template('kids_wristband').id}/test-print`,
      { stationId: booth.id },
      { 'x-oto-action-id': action },
    );
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().printJob.status).toBe('skipped');
    expect(
      await ctx.db.select().from(boxCommand).where(eq(boxCommand.actionId, action)),
    ).toHaveLength(0);
  });
});

/**
 * FIX ROUND — a station of another branch.
 *
 * Every template route checks its permission against the TEMPLATE's branch,
 * and the station it was handed was looked up by operator only. So
 * `pos:print:read` at one branch could read the routed printer of a till at
 * another, and `admin:box:command` there could queue paper on the other
 * branch's box. The station must now be at the template's branch.
 */
describe('a station of another branch is not one of the template’s (SCRUM-472)', () => {
  async function foreignTill(centralBranchId: string) {
    const [home] = await ctx.db
      .select({ operatorId: branch.operatorId })
      .from(branch)
      .where(eq(branch.id, centralBranchId))
      .limit(1);
    const [row] = await ctx.db
      .select()
      .from(station)
      .where(
        and(
          eq(station.operatorId, home!.operatorId),
          ne(station.branchId, centralBranchId),
          eq(station.name, 'Reception Till 1'),
        ),
      )
      .limit(1);
    expect(row, 'the seed has a till at a second branch of this operator').toBeTruthy();
    // It does route a receipt printer — which is what could leak.
    const [routed] = await ctx.db
      .select({ deviceId: stationDevice.deviceId })
      .from(stationDevice)
      .where(and(eq(stationDevice.stationId, row!.id), eq(stationDevice.role, 'receipt')))
      .limit(1);
    expect(routed).toBeTruthy();
    return { station: row!, printerId: routed!.deviceId };
  }

  it('names no printer of that station, and says why', async () => {
    const { branchId, template } = await central();
    const foreign = await foreignTill(branchId);
    const res = await get(
      `/print-templates/${template('receipt').id}/test-print-target?stationId=${foreign.station.id}`,
    );
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().printer).toBeNull();
    expect(res.json().note).toBe('No such station at this branch');
    expect(res.body).not.toContain(foreign.printerId);
  });

  it('refuses the test print and queues nothing on the other branch’s box', async () => {
    const { branchId, template } = await central();
    const foreign = await foreignTill(branchId);
    const action = newId();
    const res = await post(
      `/print-templates/${template('receipt').id}/test-print`,
      { stationId: foreign.station.id },
      { 'x-oto-action-id': action },
    );
    expect(res.statusCode, res.body).toBe(404);
    expect(res.json().error.code).toBe('STATION_NOT_FOUND');
    expect(await ctx.db.select().from(printJob).where(eq(printJob.actionId, action))).toHaveLength(0);
    expect(await ctx.db.select().from(boxCommand).where(eq(boxCommand.actionId, action))).toHaveLength(0);
  });

  it('still previews, at the kind’s own paper rather than that station’s printer', async () => {
    const { branchId, template } = await central();
    const foreign = await foreignTill(branchId);
    const res = await post(`/print-templates/${template('receipt').id}/preview.png`, {
      stationId: foreign.station.id,
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.headers['content-type']).toBe('image/png');
  });
});

/**
 * FIX ROUND 2 — the poll handed a box its commands in no particular order.
 *
 * `pollCommands` claimed with `update … where id in (select … order by
 * created_at limit n …) returning …`. The inner `order by` picks WHICH rows
 * are taken, not the order they come back in: the update visits them through
 * a hash of their ids, and `returning` follows that. So the `config_apply`
 * queued ahead of a Save & print test could reach the box second, and the
 * paper came out as the template was before the save (the test above failed
 * about three runs in five). The claim now orders its final select.
 *
 * This pins that order without a printer or a race. Ten commands with the ids
 * running AGAINST their stamps (the largest id on the oldest command), written
 * to the table newest first, so an order taken from the ids, the primary key,
 * the table's physical order or a hash of the ids fails. Run against this
 * exact data, the old statement returned a different scramble each time, for
 * example 6, 3, 0, 4, 2, 1, 7, 5, 9, 8, and failed this test 5 runs in 5.
 */
describe('the box’s command poll hands commands out oldest first (SCRUM-472)', () => {
  it('by created_at, then id, whatever order the claim visits the rows in', async () => {
    const { branchId } = await central();
    const [row] = await ctx.db
      .select()
      .from(box)
      .where(eq(box.branchId, branchId))
      .orderBy(asc(box.slot))
      .limit(1);
    expect(row, 'no box is seeded at Central').toBeTruthy();

    const actionId = newId();
    const ids = Array.from({ length: 10 }, () => newId())
      .sort()
      .reverse();
    // Stamped long before anything else on this box's queue, so the claim
    // takes exactly these ten. The last two share a stamp: the smaller id then
    // goes first.
    const base = Date.parse('2000-01-01T00:00:00.000Z');
    const stamps = ids.map((_, i) => new Date(base + Math.min(i, 8)));
    // Written newest first, so the table's physical order is against the
    // stamps too: a plan that scans the table rather than hashing the ids
    // would otherwise hand them back in the right order by accident.
    await ctx.db.insert(boxCommand).values(
      ids
        .map((id, i) => ({
          id,
          boxId: row!.id,
          kind: 'collect_logs' as const,
          state: 'queued' as const,
          actionId,
          createdAt: stamps[i]!,
          updatedAt: stamps[i]!,
        }))
        .reverse(),
    );
    try {
      const handed = await pollCommands(ctx.db, boxAuthFromRow(row!), ids.length);
      expect(handed.map((c) => c.id)).toEqual([...ids.slice(0, 8), ids[9], ids[8]]);
      expect(handed.map((c) => c.createdAt)).toEqual(stamps.map((s) => s.toISOString()));
    } finally {
      // Taken off the queue whatever happened, so no later poll runs them.
      await ctx.db
        .update(boxCommand)
        .set({ state: 'cancelled', finishedAt: new Date(), updatedAt: new Date() })
        .where(eq(boxCommand.actionId, actionId));
    }
  });
});
