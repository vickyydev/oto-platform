import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http';
import { createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';

import { hash as argonHash } from '@node-rs/argon2';
import type { AgentFetch, AgentResponse } from '../src/transport';
import { createKioskServer, markServedByBox } from '../src/runner/kiosk-server';
import { RunnerError, claimBox, loadArgon2Verifier, startRunner, type RunningBox } from '../src/runner/runtime';
import { readRunnerState, runnerPaths } from '../src/runner/home';
import { BRANCH_ID, OPERATOR_ID } from './_support';

/**
 * SCRUM-223 — the booth box as a Raspberry Pi runs it: `oto-box claim`, then
 * `oto-box run` with its loopback server, against a cloud that is faked at the
 * HTTP boundary and a printer that is a real TCP socket on this machine.
 *
 * The agent is the real one. It could not be loaded here before this ticket —
 * `@oto/print` has TypeScript Node's strip-only mode refuses — and the test
 * script now runs with `--experimental-transform-types`, so what is proved here
 * is the program a Pi runs, not a stand-in for it.
 */

const CODE = 'BENCH-CLAIM-1';
const BOX = '018f1d2c-0000-7000-8000-0000000b0c01';
const STATION_A = '018f1d2c-0000-7000-8000-0000000057d1';
const STATION_B = '018f1d2c-0000-7000-8000-0000000057d2';
const PRINTER = '018f1d2c-0000-7000-8000-0000000de0d1';
const ACCOUNT = '018f1d2c-0000-7000-8000-00000000fb21';
const quiet = { info() {}, warn() {}, error() {} };

function tempHome(): string {
  return mkdtempSync(join(tmpdir(), 'oto-box-home-'));
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A port nothing is listening on, for a server whose address a test needs before it starts. */
async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address() as { port: number };
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

/**
 * A cloud that takes the connection and never says a word — a hung instance,
 * a captive portal holding the request, a half-open path — on a real socket.
 */
async function silentCloud(): Promise<{
  url: string;
  connections(): number;
  /** `POST /box/v1/heartbeat`: the request line of every call that reached it. */
  requests(): string[];
  close(): Promise<void>;
}> {
  const sockets = new Set<Socket>();
  const requests: string[] = [];
  let connections = 0;
  const server: Server = createServer((socket) => {
    connections += 1;
    sockets.add(socket);
    let head = '';
    socket.on('data', (chunk: Buffer) => {
      if (head.includes('\r\n')) return;
      head += chunk.toString('latin1');
      const line = head.split('\r\n')[0] ?? '';
      if (head.includes('\r\n')) requests.push(line.split(' ').slice(0, 2).join(' '));
    });
    socket.on('error', () => {});
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    connections: () => connections,
    requests: () => [...requests],
    close: () =>
      new Promise((resolve) => {
        for (const s of sockets) s.destroy();
        server.close(() => resolve());
      }),
  };
}

function boothEntry(stationId: string, prefixName: string) {
  return {
    stationId,
    configVersionId: stationId.replace(/57d/, 'fc0'),
    version: 3,
    bundleHash: (stationId === STATION_A ? 'a' : 'b').repeat(64),
    allowedStaff: [ACCOUNT],
    voucherDefinitions: [],
    bundle: {
      schemaVersion: 1,
      settings: { eligibility: 'none', buttonKey: 'Space', dailySpinCap: null },
      layout: {
        id: '018f1d2c-0000-7000-8000-00000000fa00',
        name: 'Classic wheel',
        version: 1,
        design: {},
        assetManifest: {},
      },
      prizes: [
        {
          id: `${stationId.slice(0, -2)}e1`,
          nameEn: `${prefixName} voucher`,
          nameTh: null,
          wheelLabel: null,
          weightBp: 10_000,
          active: true,
          dailyCap: null,
          expiryDays: 14,
          costSatang: 10_000,
          sliceColor: null,
          textColor: null,
          sortOrder: 0,
          voucherDefinitionId: '018f1d2c-0000-7000-8000-00000000fd01',
        },
        {
          id: `${stationId.slice(0, -2)}e2`,
          nameEn: 'Mystery Box',
          nameTh: null,
          wheelLabel: null,
          weightBp: 0,
          active: false,
          dailyCap: null,
          expiryDays: 14,
          costSatang: 0,
          sliceColor: null,
          textColor: null,
          sortOrder: 1,
          voucherDefinitionId: '018f1d2c-0000-7000-8000-00000000fd01',
        },
      ],
    },
  };
}

function station(id: string, name: string, prefix: string, withPrinter: boolean) {
  return {
    id,
    name,
    kind: 'booth',
    codePrefix: prefix,
    capabilities: [],
    configVersion: 1,
    paymentRouting: null,
    offlineWalletCapSatang: null,
    accessScope: 'all_staff',
    devices: withPrinter
      ? [
          {
            id: PRINTER,
            role: 'receipt',
            kind: 'receipt_printer',
            label: 'Booth printer',
            transport: 'simulated',
            address: '192.168.88.207:9100',
            model: 'Xprinter XP-80',
            protocol: 'escpos',
            serialNumber: null,
            terminalId: null,
            merchantId: null,
            settings: {},
          },
        ]
      : [],
  };
}

interface FakeCloud {
  fetch: AgentFetch;
  calls: Array<{ method: string; path: string; body: unknown }>;
  /** Everything after this throws, as a dropped mall line does. */
  down: boolean;
  twoBooths: boolean;
  verifyAnswer: { status: number; body: unknown };
}

async function fakeCloud(): Promise<FakeCloud> {
  const pinHash = await argonHash('73910');
  const cloud: FakeCloud = {
    calls: [],
    down: false,
    twoBooths: false,
    verifyAnswer: {
      status: 200,
      body: { accountId: ACCOUNT, displayName: 'Nok', staffCode: 'S-7KMQ' },
    },
    fetch: async (url, init) => {
      if (cloud.down) throw new TypeError('fetch failed');
      const path = new URL(url).pathname;
      const body = init.body ? (JSON.parse(init.body) as unknown) : undefined;
      cloud.calls.push({ method: init.method, path, body });
      const reply = (status: number, json: unknown, etag?: string): AgentResponse => ({
        status,
        json: async () => json,
        text: async () => JSON.stringify(json),
        header: (name) => (name.toLowerCase() === 'etag' ? (etag ?? null) : null),
      });
      const bundle = {
        configVersion: cloud.twoBooths ? 'cfg-two' : 'cfg-one',
        box: { id: BOX, name: 'Bench box', slot: 'bench-1', role: 'booth', epoch: 1, status: 'online' },
        branch: {
          id: BRANCH_ID,
          code: 'hkt-central',
          name: 'Oto Play Park, Central Floresta',
          operatorId: OPERATOR_ID,
          timezone: 'Asia/Bangkok',
          openingHours: null,
          businessDayStart: '05:00',
        },
        stations: cloud.twoBooths
          ? [station(STATION_A, 'Bench Booth A', 'BA', true), station(STATION_B, 'Bench Booth B', 'BB', true)]
          : [station(STATION_A, 'Bench Booth A', 'BA', true)],
        printTemplates: [],
        signingKeys: [],
        heartbeatIntervalS: 60,
        minSupportedAgentVersion: '0.1.0',
      };
      switch (path) {
        case '/box/v1/register': {
          const claim = (body as { claimCode?: string; syncPublicKey?: string }) ?? {};
          if (claim.claimCode !== CODE) return reply(401, { error: { code: 'BOX_CLAIM_INVALID' } });
          assert.match(claim.syncPublicKey ?? '', /BEGIN PUBLIC KEY/, 'a new box offers its public key');
          return reply(200, {
            boxId: BOX,
            secret: 'fake-secret-for-tests-only',
            name: 'Bench box',
            slot: 'bench-1',
            role: 'booth',
            branchId: BRANCH_ID,
            operatorId: OPERATOR_ID,
            epoch: 1,
            heartbeatIntervalS: 60,
            minSupportedAgentVersion: '0.1.0',
          });
        }
        case '/box/v1/config':
          return reply(200, bundle, `"${bundle.configVersion}"`);
        case '/box/v1/cache':
          return reply(200, {
            schemaVersion: 1,
            bundleVersion: cloud.twoBooths ? 'cache-two' : 'cache-one',
            cursorSeq: 4,
            truncated: [],
            scopes: {
              deny_list: { items: [{ revokedAccountIds: [], revokedTokenIds: [] }], nextCursor: null },
              staff: {
                items: [
                  {
                    accountId: ACCOUNT,
                    passwordHash: null,
                    status: 'active',
                    mustChangePassword: false,
                    lastTokenAt: null,
                    pinHash,
                    staffCode: 'S-7KMQ',
                    displayName: 'Nok',
                  },
                ],
                nextCursor: null,
              },
              booth: {
                items: cloud.twoBooths
                  ? [boothEntry(STATION_A, 'Booth A'), boothEntry(STATION_B, 'Booth B')]
                  : [boothEntry(STATION_A, 'Booth A')],
                nextCursor: null,
              },
              receipt_series: { items: [], nextCursor: null },
            },
          });
        case '/box/v1/heartbeat':
          return reply(200, {
            receivedAt: new Date().toISOString(),
            serverTime: new Date().toISOString(),
            clockOffsetMs: 0,
            configVersion: bundle.configVersion,
            minSupportedAgentVersion: '0.1.0',
            heartbeatIntervalS: 60,
            commandsPending: 0,
            epoch: 1,
            devicesMatched: 1,
            devicesUnknown: 0,
          });
        case '/box/v1/commands/poll':
          return reply(200, { commands: [], serverTime: new Date().toISOString() });
        case '/box/v1/booth/staff/verify':
          return reply(cloud.verifyAnswer.status, cloud.verifyAnswer.body);
        default:
          // The outbox push and the print-result route: not what this file is
          // about, and a 503 makes the agent keep its facts and try later.
          return reply(503, { error: { code: 'NOT_HERE' } });
      }
    },
  };
  return cloud;
}

interface FakePrinter {
  port: number;
  received(): Buffer;
  /** Slips: sessions that carried a raster, which a status probe never does. */
  slips(): number;
  close(): Promise<void>;
}

/** An 80 mm ESC/POS printer on TCP: answers `DLE EOT n` with "all clear" and keeps what it is sent. */
async function fakePrinter(): Promise<FakePrinter> {
  return fakePrinterOn(0);
}

/** `GS v 0`, the raster command every slip is drawn with. */
const RASTER = Buffer.from([0x1d, 0x76, 0x30, 0x00]);

async function fakePrinterOn(wanted: number): Promise<FakePrinter> {
  const chunks: Buffer[] = [];
  const sockets = new Set<Socket>();
  let slips = 0;
  const server: Server = createServer((socket) => {
    const session: Buffer[] = [];
    sockets.add(socket);
    socket.on('close', () => {
      sockets.delete(socket);
      if (Buffer.concat(session).indexOf(RASTER) >= 0) slips += 1;
    });
    socket.on('data', (data: Buffer) => {
      chunks.push(data);
      session.push(data);
      for (let i = 0; i + 2 < data.length; i += 1) {
        if (data[i] === 0x10 && data[i + 1] === 0x04) socket.write(Buffer.from([0x12]));
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(wanted, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  return {
    port,
    received: () => Buffer.concat(chunks),
    slips: () => slips,
    close: () =>
      new Promise((resolve) => {
        for (const s of sockets) s.destroy();
        server.close(() => resolve());
      }),
  };
}

function pageDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'oto-box-page-'));
  mkdirSync(join(dir, 'assets'));
  writeFileSync(
    join(dir, 'index.html'),
    '<!doctype html><html><head><meta name="oto-booth-host" content="paired" /><title>Booth</title></head><body><div id="root"></div></body></html>',
  );
  writeFileSync(join(dir, 'assets', 'app-1234.js'), 'console.log("booth")');
  return dir;
}

interface Hit {
  status: number;
  body: string;
  json: () => unknown;
  headers: Record<string, string | string[] | undefined>;
}

function hit(
  port: number,
  method: string,
  path: string,
  opts: { body?: unknown; headers?: Record<string, string>; host?: string } = {},
): Promise<Hit> {
  return new Promise((resolve, reject) => {
    const payload = opts.body === undefined ? undefined : JSON.stringify(opts.body);
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port,
        method,
        path,
        headers: {
          host: opts.host ?? `127.0.0.1:${port}`,
          ...(payload === undefined ? {} : { 'content-type': 'application/json' }),
          ...opts.headers,
        },
      },
      (res) => {
        const parts: Buffer[] = [];
        res.on('data', (c: Buffer) => parts.push(c));
        res.on('end', () => {
          const text = Buffer.concat(parts).toString('utf8');
          resolve({ status: res.statusCode ?? 0, body: text, json: () => JSON.parse(text), headers: res.headers });
        });
      },
    );
    req.on('error', reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

async function run(
  home: string,
  cloud: FakeCloud,
  extra: Partial<Parameters<typeof startRunner>[0]> = {},
): Promise<RunningBox> {
  return startRunner({
    home,
    apiBaseUrl: 'http://cloud.test',
    port: 0,
    pageDir: extra.pageDir ?? pageDir(),
    fetch: cloud.fetch,
    log: quiet,
    verifySecret: extra.verifySecret,
    ...extra,
  });
}

// --- oto-box claim ----------------------------------------------------------

test('claim registers the box with the Console’s code and writes an owner-only credential', async () => {
  const home = tempHome();
  const cloud = await fakeCloud();

  await assert.rejects(
    () => claimBox({ home, apiBaseUrl: 'http://cloud.test', code: 'WRONG-CODE-9', fetch: cloud.fetch, log: quiet }),
    (err: unknown) => err instanceof RunnerError && /refused/.test(err.message),
  );
  assert.equal(existsSync(runnerPaths(home).credential), false, 'nothing written for a refused code');

  const { boxId } = await claimBox({ home, apiBaseUrl: 'http://cloud.test/', code: CODE, fetch: cloud.fetch, log: quiet });
  assert.equal(boxId, BOX);
  const paths = runnerPaths(home);
  const held = JSON.parse(readFileSync(paths.credential, 'utf8')) as Record<string, unknown>;
  assert.equal(held.boxId, BOX);
  assert.match(String(held.syncPrivateKeyPem), /BEGIN PRIVATE KEY/, 'the signing key never leaves the box');
  if (process.platform !== 'win32') {
    assert.equal(statSync(paths.credential).mode & 0o777, 0o600);
  }
  assert.deepEqual(await readRunnerState(paths), { apiBaseUrl: 'http://cloud.test', stationId: null });

  await assert.rejects(
    () => claimBox({ home, apiBaseUrl: 'http://cloud.test', code: CODE, fetch: cloud.fetch, log: quiet }),
    (err: unknown) => err instanceof RunnerError && /already registered/.test(err.message),
  );
  const again = await claimBox({ home, apiBaseUrl: 'http://cloud.test', code: CODE, fetch: cloud.fetch, log: quiet, force: true });
  assert.equal(again.boxId, BOX);

  cloud.down = true;
  const fresh = tempHome();
  await assert.rejects(
    () => claimBox({ home: fresh, apiBaseUrl: 'http://cloud.test', code: CODE, fetch: cloud.fetch, log: quiet }),
    (err: unknown) => err instanceof RunnerError && /did not answer/.test(err.message),
  );
});

// --- oto-box run: first boot ------------------------------------------------

test('a box with no credential serves the claim screen, takes the code, and starts', async () => {
  const cloud = await fakeCloud();
  const box = await run(tempHome(), cloud);
  try {
    const before = (await hit(box.port, 'GET', '/kiosk/state')).json() as {
      registered: boolean;
      booths: unknown[];
    };
    assert.equal(before.registered, false);
    assert.deepEqual(before.booths, []);
    assert.equal(
      (await hit(box.port, 'GET', '/booth/config')).status,
      409,
      'no booth to answer for yet',
    );

    const wrong = await hit(box.port, 'POST', '/kiosk/claim', { body: { code: 'WRONG-CODE-9' } });
    assert.deepEqual(wrong.json(), { ok: false, reason: 'refused' });
    const right = await hit(box.port, 'POST', '/kiosk/claim', { body: { code: CODE } });
    assert.deepEqual(right.json(), { ok: true });

    const after = (await hit(box.port, 'GET', '/kiosk/state')).json() as {
      registered: boolean;
      booths: Array<{ stationId: string; name: string }>;
      selectedStationId: string | null;
    };
    assert.equal(after.registered, true);
    assert.deepEqual(after.booths.map((b) => b.name), ['Bench Booth A']);
    assert.equal(after.selectedStationId, STATION_A, 'one booth: straight in');
    const config = (await hit(box.port, 'GET', '/booth/config')).json() as { version: number };
    assert.equal(config.version, 3);
    const twice = (await hit(box.port, 'POST', '/kiosk/claim', { body: { code: CODE } })).json() as { reason?: string };
    assert.equal(twice.reason, 'already_registered');
  } finally {
    await box.stop();
  }
});

test('a claim made in a terminal while the box runs unclaimed restarts it; one typed on the television does not', async () => {
  const cloud = await fakeCloud();

  // The service is up and showing the claim screen; somebody runs
  // `oto-box claim <code>` over SSH instead of typing it on the television.
  const home = tempHome();
  let restarts = 0;
  const box = await run(home, cloud, { credentialPollMs: 25, onRestartNeeded: () => (restarts += 1) });
  try {
    await claimBox({ home, apiBaseUrl: 'http://cloud.test', code: CODE, fetch: cloud.fetch, log: quiet });
    for (let i = 0; i < 40 && restarts === 0; i += 1) await wait(25);
    assert.equal(restarts, 1, 'the running box asks for a fresh process to use the new credential');
  } finally {
    await box.stop();
  }

  // Claimed on the television instead: the same file is written from inside
  // the process, and that is no reason to restart.
  let kioskRestarts = 0;
  const other = await run(tempHome(), cloud, { credentialPollMs: 25, onRestartNeeded: () => (kioskRestarts += 1) });
  try {
    const right = await hit(other.port, 'POST', '/kiosk/claim', { body: { code: CODE } });
    assert.deepEqual(right.json(), { ok: true });
    await wait(200);
    assert.equal(kioskRestarts, 0);
  } finally {
    await other.stop();
  }
});

// --- The loopback server ----------------------------------------------------

test('the kiosk serves the page marked as served by a box, and its assets', async () => {
  const cloud = await fakeCloud();
  const box = await run(tempHome(), cloud);
  try {
    const page = await hit(box.port, 'GET', '/');
    assert.equal(page.status, 200);
    assert.match(page.body, /<meta name="oto-booth-host" content="box" \/>/);
    assert.equal(page.headers['cache-control'], 'no-cache');
    const deep = await hit(box.port, 'GET', '/some/client/route');
    assert.match(deep.body, /content="box"/, 'a client route is the page');
    const asset = await hit(box.port, 'GET', '/assets/app-1234.js');
    assert.equal(asset.status, 200);
    assert.match(String(asset.headers['content-type']), /javascript/);
    assert.equal((await hit(box.port, 'GET', '/assets/missing.js')).status, 404);
    // However the path is spelled, nothing outside the page's folder.
    assert.equal((await hit(box.port, 'GET', '/..%2f..%2fcredential.json')).status, 404);
    assert.equal((await hit(box.port, 'GET', '/%2e%2e/%2e%2e/runner.json')).status, 404);
    assert.equal(((await hit(box.port, 'GET', '/kiosk/health')).json() as { ok: boolean }).ok, true);
  } finally {
    await box.stop();
  }
});

test('the kiosk answers only this machine, by its own name, and writes only from its own page', async () => {
  const cloud = await fakeCloud();
  const box = await run(tempHome(), cloud);
  try {
    // DNS rebinding: a name that resolved here is still not this machine's name.
    assert.equal((await hit(box.port, 'GET', '/kiosk/state', { host: 'evil.example:80' })).status, 403);
    assert.equal((await hit(box.port, 'GET', '/kiosk/state', { host: `localhost:${box.port}` })).status, 200);
    // Another site in a browser on the box cannot post to it.
    const foreign = await hit(box.port, 'POST', '/booth/spin', {
      body: { idempotencyKey: 'x' },
      headers: { origin: 'https://evil.example' },
    });
    assert.equal(foreign.status, 403);
    const crossSite = await hit(box.port, 'POST', '/booth/spin', {
      body: { idempotencyKey: 'x' },
      headers: { 'sec-fetch-site': 'cross-site' },
    });
    assert.equal(crossSite.status, 403);
    // A form post is not JSON, so it never reaches the booth.
    const form = await hit(box.port, 'POST', '/kiosk/claim', {
      headers: { 'content-type': 'text/plain' },
    });
    assert.equal(form.status, 415);
  } finally {
    await box.stop();
  }
});

test('a request from off the box is refused, and the server will not bind off loopback', async () => {
  const kiosk = createKioskServer({
    port: 8780,
    pageDir: null,
    booth: () => null,
    state: async () => ({ registered: false, online: false, booths: [], selectedStationId: null, agentVersion: 'test' }),
    claim: async () => ({ ok: false, reason: 'refused' }),
    selectBooth: async () => false,
  });
  let status = 0;
  let sent = '';
  const res = {
    statusCode: 0,
    headersSent: false,
    setHeader() {},
    end(this: { statusCode: number }, chunk?: string) {
      status = this.statusCode;
      sent = chunk ?? '';
    },
  } as unknown as ServerResponse;
  const req = {
    socket: { remoteAddress: '192.168.1.23' },
    headers: { host: '127.0.0.1:8780' },
    method: 'GET',
    url: '/kiosk/state',
  } as unknown as IncomingMessage;
  await kiosk.handle(req, res);
  assert.equal(status, 403);
  assert.match(sent, /loopback_only/);

  const open = createKioskServer({
    port: 0,
    host: '0.0.0.0',
    pageDir: null,
    booth: () => null,
    state: async () => ({ registered: false, online: false, booths: [], selectedStationId: null, agentVersion: 'test' }),
    claim: async () => ({ ok: false, reason: 'refused' }),
    selectBooth: async () => false,
  });
  await assert.rejects(() => open.listen(), /loopback only/);
  assert.match(markServedByBox('<html><head><title>x</title></head></html>'), /content="box"/);
});

// --- Two booths on one box --------------------------------------------------

test('a box with two booths asks which one, remembers the choice, and runs that booth', async () => {
  const home = tempHome();
  const cloud = await fakeCloud();
  await claimBox({ home, apiBaseUrl: 'http://cloud.test', code: CODE, fetch: cloud.fetch, log: quiet });
  cloud.twoBooths = true;
  const box = await run(home, cloud, { verifySecret: null });
  try {
    const state = (await hit(box.port, 'GET', '/kiosk/state')).json() as {
      booths: Array<{ stationId: string }>;
      selectedStationId: string | null;
    };
    assert.equal(state.booths.length, 2);
    assert.equal(state.selectedStationId, null, 'two booths and no choice: the picker');
    assert.equal(
      ((await hit(box.port, 'GET', '/booth/config')).json() as { version: unknown }).version,
      null,
    );

    assert.equal(
      (
        await hit(box.port, 'POST', '/kiosk/booth', {
          body: { stationId: '018f1d2c-0000-7000-8000-0000000000ff' },
        })
      ).status,
      404,
    );
    assert.equal(
      (await hit(box.port, 'POST', '/kiosk/booth', { body: { stationId: STATION_B } })).status,
      200,
    );
    assert.equal((await readRunnerState(box.paths)).stationId, STATION_B, 'kept on disk');

    const config = (await hit(box.port, 'GET', '/booth/config')).json() as {
      bundle: { prizes: Array<{ nameEn: string }> };
    };
    assert.equal(config.bundle.prizes[0]?.nameEn, 'Booth B voucher');
    const spin = (
      await hit(box.port, 'POST', '/booth/spin', { body: { idempotencyKey: 'b-1' } })
    ).json() as { voucherCode: string };
    assert.match(spin.voucherCode, /^BB/);
  } finally {
    await box.stop();
  }
});

// --- Offline, from the first second ------------------------------------------

test('a box that boots with no internet still plays: the config copy on disk carries it', async () => {
  const home = tempHome();
  const cloud = await fakeCloud();
  const first = await run(home, cloud);
  await hit(first.port, 'POST', '/kiosk/claim', { body: { code: CODE } });
  assert.equal(
    ((await hit(first.port, 'GET', '/booth/config')).json() as { version: number }).version,
    3,
  );
  await first.stop();
  const onDisk = JSON.parse(readFileSync(runnerPaths(home).configBundle, 'utf8')) as {
    configVersion: string;
  };
  assert.equal(onDisk.configVersion, 'cfg-one');

  // The mall's router is still coming up.
  cloud.down = true;
  const second = await run(home, cloud);
  try {
    const state = (await hit(second.port, 'GET', '/kiosk/state')).json() as {
      registered: boolean;
      online: boolean;
      selectedStationId: string;
    };
    assert.equal(state.registered, true);
    assert.equal(state.online, false);
    assert.equal(state.selectedStationId, STATION_A);
    const spin = await hit(second.port, 'POST', '/booth/spin', {
      body: { idempotencyKey: 'offline-1' },
    });
    assert.equal(spin.status, 200);
    const won = spin.json() as { voucherCode: string; printState: string };
    assert.match(won.voucherCode, /^BA/, 'minted on the box, with no internet');
    const status = (await hit(second.port, 'GET', '/booth/status')).json() as {
      online: boolean;
      vouchersPending: number;
    };
    assert.equal(status.online, false, 'the dot is off');
    assert.ok(status.vouchersPending >= 2, 'and the spin and voucher wait for the line');

    // An account sign-in needs the cloud: refused with the words for the PIN.
    const account = await hit(second.port, 'POST', '/booth/staff/sign-in', {
      body: { mode: 'account', phone: '0812345678', password: 'pw' },
    });
    assert.deepEqual(account.json(), { ok: false, reason: 'offline' });
    // The PIN is checked on the box, against the real argon2 hash.
    const pin = await hit(second.port, 'POST', '/booth/staff/sign-in', { body: { mode: 'pin', pin: '73910' } });
    assert.deepEqual(pin.json(), { ok: true });
  } finally {
    await second.stop();
  }
});

test('a cloud that takes the connection and never answers: the television is up at once and the wheel plays', async () => {
  const home = tempHome();
  const cloud = await fakeCloud();
  // A box that has run before: claimed, with its config and its wheel on the card.
  const first = await run(home, cloud);
  await hit(first.port, 'POST', '/kiosk/claim', { body: { code: CODE } });
  await first.stop();

  // The mall's line is up to the router, and the far end has stalled.
  const stalled = await silentCloud();
  const port = await freePort();
  const lines: string[] = [];
  const log = {
    info: (o: Record<string, unknown>, m: string) => lines.push(`${m} ${JSON.stringify(o)}`),
    warn: (o: Record<string, unknown>, m: string) => lines.push(`${m} ${JSON.stringify(o)}`),
    error: (o: Record<string, unknown>, m: string) => lines.push(`${m} ${JSON.stringify(o)}`),
  };
  const began = Date.now();
  let startedAfter: number | null = null;
  // The real transport, with a short allowance so the test does not wait
  // four times fifteen seconds; the rule under test is the order, not the number.
  const booting = startRunner({
    home,
    apiBaseUrl: stalled.url,
    port,
    pageDir: pageDir(),
    log,
    cloudTimeoutMs: 400,
  }).then((box) => {
    startedAfter = Date.now() - began;
    return box;
  });
  try {
    let health = 0;
    while (health !== 200 && Date.now() - began < 5_000) {
      health = await hit(port, 'GET', '/kiosk/health').then(
        (r) => r.status,
        () => 0,
      );
      if (health !== 200) await wait(20);
    }
    const upAfter = Date.now() - began;
    assert.equal(health, 200, 'the kiosk answers');
    assert.equal(startedAfter, null, `…while start is still waiting on the cloud (up after ${upAfter} ms)`);

    const state = (await hit(port, 'GET', '/kiosk/state')).json() as {
      registered: boolean;
      online: boolean;
      selectedStationId: string | null;
    };
    assert.equal(state.registered, true);
    assert.equal(state.online, false, 'the dot says what is true');
    assert.equal(state.selectedStationId, STATION_A);
    const config = (await hit(port, 'GET', '/booth/config')).json() as { version: number };
    assert.equal(config.version, 3, 'the wheel held on the card, not "not set up"');
    const spin = await hit(port, 'POST', '/booth/spin', { body: { idempotencyKey: 'stall-1' } });
    assert.equal(spin.status, 200);
    assert.match((spin.json() as { voucherCode: string }).voucherCode, /^BA/);

    // A PIN is the box's to check; an account sign-in asks the cloud, gives up
    // inside the allowance, and says so rather than hanging the panel.
    const pin = await hit(port, 'POST', '/booth/staff/sign-in', { body: { mode: 'pin', pin: '73910' } });
    assert.deepEqual(pin.json(), { ok: true });
    const askedAt = Date.now();
    const account = await hit(port, 'POST', '/booth/staff/sign-in', {
      body: { mode: 'account', phone: '0812345678', password: 'pw' },
    });
    assert.deepEqual(account.json(), { ok: false, reason: 'offline' });
    assert.ok(Date.now() - askedAt < 3_000, 'answered inside the allowance');

    const box = await booting;
    assert.ok(startedAfter !== null && startedAfter >= 1_200, `start gave up on four calls (${startedAfter} ms)`);
    assert.ok(stalled.connections() >= 4, 'config, cache, heartbeat and commands each tried');
    assert.equal(box.agent.state.linkUp, false);
    assert.ok(
      lines.some((l) => /config could not be pulled at start/.test(l) && /TimeoutError/.test(l)),
      'the log names the timeout',
    );
    assert.ok(lines.some((l) => /box agent started/.test(l)), 'and the timers are set: it tries again');
  } finally {
    // Stopped once, however the test ended; a start that failed has nothing to stop.
    await booting.then(
      (box) => box.stop(),
      () => undefined,
    );
    await stalled.close();
  }
});

// --- One press, one slip -------------------------------------------------------

/** The booth's print outcomes in a stopped box's outbox, oldest first. */
function printFacts(home: string): Array<{ printJobId: string; status: string }> {
  const db = new DatabaseSync(runnerPaths(home).database);
  try {
    const rows = db
      .prepare(`select payload from box_outbox where type = 'booth.voucher_printed' order by box_seq`)
      .all() as Array<{ payload: string }>;
    return rows.map((row) => JSON.parse(row.payload) as { printJobId: string; status: string });
  } finally {
    db.close();
  }
}

/** A box that has run before: claimed, its wheel on the card, printing to `printer`. */
async function claimedHome(cloud: FakeCloud, printer: FakePrinter): Promise<{ home: string; first: RunningBox }> {
  const home = tempHome();
  writeFileSync(
    runnerPaths(home).overrides,
    JSON.stringify({ printer: { host: '127.0.0.1', port: printer.port } }),
  );
  const first = await run(home, cloud);
  await hit(first.port, 'POST', '/kiosk/claim', { body: { code: CODE } });
  return { home, first };
}

/**
 * The first press after a boot, before anything has ticked the print queue.
 *
 * The spin writes its voucher's print job in its own transaction and then hands
 * it to the queue, whose first act is to pick up what is on the card — that
 * very row. Both copies were queued: the slip printed at the press and again at
 * the next tick, and the second outcome, by then no longer the booth's, went to
 * the cloud's print-result route rather than the outbox (SCRUM-223, the gate's
 * G1). The boot order that serves the television before `start` has finished
 * with the cloud is what made the press come first.
 */
test('a press while start still waits on a silent cloud prints one slip; the first heartbeat prints no second', async () => {
  const cloud = await fakeCloud();
  const printer = await fakePrinter();
  const { home, first } = await claimedHome(cloud, printer);
  await first.stop();

  const stalled = await silentCloud();
  const port = await freePort();
  let started = false;
  const booting = startRunner({
    home,
    apiBaseUrl: stalled.url,
    port,
    pageDir: null,
    log: quiet,
    // Four calls at a second each: time enough for the press to land first.
    cloudTimeoutMs: 1_000,
  }).then((box) => {
    started = true;
    return box;
  });
  try {
    const began = Date.now();
    let health = 0;
    while (health !== 200 && Date.now() - began < 5_000) {
      health = await hit(port, 'GET', '/kiosk/health').then(
        (r) => r.status,
        () => 0,
      );
      if (health !== 200) await wait(20);
    }
    const spin = await hit(port, 'POST', '/booth/spin', {
      body: { idempotencyKey: 'stall-press-1' },
    });
    assert.equal(spin.status, 200);
    assert.equal((spin.json() as { printState: string }).printState, 'queued');
    assert.equal(printer.slips(), 0, 'no paper before the reveal');
    const printed = await hit(port, 'POST', '/booth/print', {
      body: { spinId: (spin.json() as { spinId: string }).spinId },
    });
    assert.equal((printed.json() as { printState: string }).printState, 'printed');
    assert.equal(
      started,
      false,
      'the press came before start, so before its heartbeat ticked the queue',
    );

    const box = await booting;
    // `start` is done, and its heartbeat has ticked the print queue; one more
    // heartbeat is the next tick a Pi would run.
    await box.agent.heartbeat().catch(() => null);
    await wait(200);
    assert.equal(printer.slips(), 1, 'one press, one slip');
    assert.deepEqual(box.agent.printing()?.jobs.pending() ?? [], [], 'and nothing left waiting to print');
    assert.equal(
      stalled.requests().some((line) => line.includes('/box/v1/print-jobs/')),
      false,
      'no outcome went to the cloud’s print route',
    );
  } finally {
    await booting.then(
      (box) => box.stop(),
      () => undefined,
    );
    await stalled.close();
    await printer.close();
  }
  assert.deepEqual(
    printFacts(home).map((fact) => fact.status),
    ['printed'],
    'the slip is one fact in the outbox',
  );
});

test('the Console’s offline switch on at boot: a press, back online, one heartbeat — one slip', async () => {
  const cloud = await fakeCloud();
  const printer = await fakePrinter();
  const { home, first } = await claimedHome(cloud, printer);
  // As the Console's switch sets it: kept in the store, so the box boots with
  // it on, and a heartbeat while it is on returns before it ticks the queue.
  await first.agent.setOffline(true, { reason: 'offline switch' });
  await first.stop();

  const box = await run(home, cloud);
  try {
    assert.equal(box.agent.state.offline, true, 'it came back with the switch on');
    const spin = await hit(box.port, 'POST', '/booth/spin', {
      body: { idempotencyKey: 'offline-press-1' },
    });
    assert.equal((spin.json() as { printState: string }).printState, 'queued');
    assert.equal(printer.slips(), 0, 'no paper before the reveal');
    const printed = await hit(box.port, 'POST', '/booth/print', {
      body: { spinId: (spin.json() as { spinId: string }).spinId },
    });
    assert.equal((printed.json() as { printState: string }).printState, 'printed');
    await wait(200);
    assert.equal(printer.slips(), 1);

    await box.agent.setOffline(false);
    await box.agent.heartbeat();
    await wait(200);
    assert.equal(printer.slips(), 1, 'coming back online printed nothing more');
    assert.deepEqual(box.agent.printing()?.jobs.pending() ?? [], []);
    assert.equal(
      cloud.calls.some((call) => call.path.startsWith('/box/v1/print-jobs/')),
      false,
      'no outcome went to the cloud’s print route',
    );
  } finally {
    await box.stop();
    await printer.close();
  }
  assert.deepEqual(printFacts(home).map((fact) => fact.status), ['printed']);
});

// --- Signing in and printing --------------------------------------------------

test('an account sign-in goes to the cloud under the box credential, and names the person', async () => {
  const home = tempHome();
  const cloud = await fakeCloud();
  const box = await run(home, cloud);
  try {
    await hit(box.port, 'POST', '/kiosk/claim', { body: { code: CODE } });
    const signed = await hit(box.port, 'POST', '/booth/staff/sign-in', {
      body: { mode: 'account', phone: '0812345678', password: 'secret-pw' },
    });
    assert.deepEqual(signed.json(), { ok: true });
    const asked = cloud.calls.find((c) => c.path === '/box/v1/booth/staff/verify');
    assert.deepEqual(asked?.body, {
      stationId: STATION_A,
      phone: '0812345678',
      password: 'secret-pw',
    });
    const status = (await hit(box.port, 'GET', '/booth/status')).json() as {
      staff: { name: string; code: string; method: string };
    };
    assert.deepEqual(
      { name: status.staff.name, code: status.staff.code, method: status.staff.method },
      { name: 'Nok', code: 'S-7KMQ', method: 'account' },
    );

    cloud.verifyAnswer = {
      status: 403,
      body: { error: { code: 'BOOTH_STAFF_NOT_ASSIGNED', message: 'x' } },
    };
    const refused = await hit(box.port, 'POST', '/booth/staff/sign-in', {
      body: { mode: 'account', phone: '0899999999', password: 'pw' },
    });
    assert.deepEqual(refused.json(), { ok: false, reason: 'not_assigned' });
  } finally {
    await box.stop();
  }
});

test('a sign-in the cloud refuses because of the BOX says so, and is not "no internet"', async () => {
  const home = tempHome();
  const cloud = await fakeCloud();
  const box = await run(home, cloud);
  try {
    await hit(box.port, 'POST', '/kiosk/claim', { body: { code: CODE } });
    const signIn = async () =>
      (
        await hit(box.port, 'POST', '/booth/staff/sign-in', {
          body: { mode: 'account', phone: '0812345678', password: 'pw' },
        })
      ).json();

    // This box's credential revoked or replaced in the Console.
    cloud.verifyAnswer = { status: 401, body: { error: { code: 'BOX_UNAUTHORIZED', message: 'x' } } };
    assert.deepEqual(await signIn(), { ok: false, reason: 'box_refused' });
    // This box taken out of service.
    cloud.verifyAnswer = { status: 403, body: { error: { code: 'BOX_DISABLED', message: 'x' } } };
    assert.deepEqual(await signIn(), { ok: false, reason: 'box_refused' });
    // The booth moved to another box, or archived.
    cloud.verifyAnswer = { status: 404, body: { error: { code: 'BOOTH_NOT_ON_THIS_BOX', message: 'x' } } };
    assert.deepEqual(await signIn(), { ok: false, reason: 'booth_not_on_box' });
    // A wrong password is still only a wrong password.
    cloud.verifyAnswer = { status: 401, body: { error: { code: 'INVALID_CREDENTIALS', message: 'x' } } };
    assert.deepEqual(await signIn(), { ok: false });
    // Answering the panel is not the refusal path: the credential stays for
    // the heartbeat to test, once a minute at most.
    assert.equal(box.agent.state.registered, true);
  } finally {
    await box.stop();
  }
});

test('the booth prints over TCP 9100 to the printer config.json names, at its width', async () => {
  const home = tempHome();
  const printer = await fakePrinter();
  const cloud = await fakeCloud();
  writeFileSync(
    runnerPaths(home).overrides,
    JSON.stringify({ printer: { host: '127.0.0.1', port: printer.port, widthDots: 512 } }),
  );
  const box = await run(home, cloud);
  try {
    await hit(box.port, 'POST', '/kiosk/claim', { body: { code: CODE } });
    const spin = (
      await hit(box.port, 'POST', '/booth/spin', { body: { idempotencyKey: 'tcp-1' } })
    ).json() as {
      spinId: string;
      printState: string;
      voucherCode: string;
    };
    assert.equal(spin.printState, 'queued');
    const printed = await hit(box.port, 'POST', '/booth/print', { body: { spinId: spin.spinId } });
    assert.equal((printed.json() as { printState: string }).printState, 'printed');
    const bytes = printer.received();
    // GS v 0: the raster command, at 512 dots = 64 bytes a row.
    const raster = bytes.indexOf(Buffer.from([0x1d, 0x76, 0x30, 0x00]));
    assert.ok(raster >= 0, 'a raster reached the printer');
    assert.equal(bytes[raster + 4], 64, 'drawn for a 512-dot head, as config.json says');

    // The copy on disk is what the cloud sent: the override is applied, not saved.
    const onDisk = JSON.parse(readFileSync(runnerPaths(home).configBundle, 'utf8')) as {
      stations: Array<{ devices: Array<{ transport: string; address: string }> }>;
    };
    assert.equal(onDisk.stations[0]?.devices[0]?.transport, 'simulated');
    assert.equal(onDisk.stations[0]?.devices[0]?.address, '192.168.88.207:9100');

    // Staff reprint the voucher: the same code comes out of the same printer.
    await hit(box.port, 'POST', '/booth/staff/sign-in', { body: { mode: 'pin', pin: '73910' } });
    const before = printer.received().length;
    const reprint = (await hit(box.port, 'POST', '/booth/reprint', { body: {} })).json() as {
      printState: string;
    };
    assert.equal(reprint.printState, 'printed');
    assert.ok(printer.received().length > before, 'a second slip went to the printer');
  } finally {
    await box.stop();
    await printer.close();
  }
});

test('with no printer answering the code goes to the screen and the job waits on disk', async () => {
  const home = tempHome();
  const cloud = await fakeCloud();
  const dead = await fakePrinter();
  const deadPort = dead.port;
  await dead.close();
  writeFileSync(runnerPaths(home).overrides, JSON.stringify({ printer: { host: '127.0.0.1', port: deadPort } }));
  const lines: string[] = [];
  const log = {
    info: (o: Record<string, unknown>, m: string) => lines.push(`${m} ${JSON.stringify(o)}`),
    warn: (o: Record<string, unknown>, m: string) => lines.push(`${m} ${JSON.stringify(o)}`),
    error: (o: Record<string, unknown>, m: string) => lines.push(`${m} ${JSON.stringify(o)}`),
  };
  const box = await run(home, cloud, { log, printRetryDelayMs: 200 });
  try {
    await hit(box.port, 'POST', '/kiosk/claim', { body: { code: CODE } });
    const spin = (
      await hit(box.port, 'POST', '/booth/spin', { body: { idempotencyKey: 'dead-1' } })
    ).json() as {
      spinId: string;
      printState: string;
      voucherCode: string | null;
    };
    await hit(box.port, 'POST', '/booth/print', { body: { spinId: spin.spinId } });
    assert.notEqual(spin.printState, 'printed');
    assert.match(spin.voucherCode ?? '', /^BA/, 'the television shows the code and its QR instead');
    const pending = box.agent.printing()?.jobs.pending() ?? [];
    assert.equal(pending.length, 1, 'the voucher waits in the queue');
    assert.ok(
      lines.some((l) => /PRINTER_UNREACHABLE|unreachable/i.test(l)),
      'the failure is in the log',
    );
    assert.equal(
      lines.some((l) => /no durable print queue/.test(l)),
      false,
      'the queue is on the card, not in memory',
    );
  } finally {
    await box.stop();
  }

  // The power goes, the printer comes back, the box boots again: the slip that
  // was waiting comes out, the same code.
  // Past the slip's retry time, as a restart after a power cut always is.
  await new Promise((resolve) => setTimeout(resolve, 400));
  const back = await fakePrinterOn(deadPort);
  const again = await run(home, cloud, { printRetryDelayMs: 200 });
  try {
    const until = Date.now() + 10_000;
    while (back.received().indexOf(Buffer.from([0x1d, 0x76, 0x30, 0x00])) < 0 && Date.now() < until) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.ok(
      back.received().indexOf(Buffer.from([0x1d, 0x76, 0x30, 0x00])) >= 0,
      'the queued voucher printed after the restart',
    );
    assert.deepEqual(again.agent.printing()?.jobs.pending() ?? [], [], 'and left the queue');
  } finally {
    await again.stop();
    await back.close();
  }
});

test('the PIN verifier is @node-rs/argon2, and it checks the hashes the api writes', async () => {
  const verify = await loadArgon2Verifier(quiet);
  assert.ok(verify, 'the native module loaded on this machine');
  const stored = await argonHash('73910');
  assert.equal(await verify!(stored, '73910'), true);
  assert.equal(await verify!(stored, '1357'), false);
  assert.equal(await verify!('not-a-hash', '73910'), false, 'a malformed hash is a no, not a crash');
});
