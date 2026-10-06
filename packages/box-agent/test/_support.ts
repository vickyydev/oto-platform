import { DatabaseSync } from 'node:sqlite';

import { createBoxAgent, type BoxAgent, type BoxAgentOptions } from '../src/agent';
import { memoryCredentialStore } from '../src/credentials';
import type { BoxCommandHandout, BoxCommandResultRequest, BoxConfigBundle } from '../src/protocol';
import { generateSyncKeyPair, sealEnvelope } from '../src/signing';
import { SqlBoxStore } from '../src/store-sql';
import { prepareSqliteBoxStore, sqliteBoxDriver } from '../src/store-sqlite';
import type { EnvelopeSealer } from '../src/store';
import type { AgentFetch, AgentResponse } from '../src/transport';

/**
 * A box store in memory, for tests.
 *
 * SQLite, not a hand-written fake: the point of these tests is that the SQL
 * the Pi runs does what the design says, and a fake would only prove the fake.
 * The Postgres dialect of the same statements is exercised from the api's
 * suite, which has a database.
 */
export const BOX_ID = '018f0000-0000-7000-8000-00000000b0c5';
export const STATION_ID = '018f0000-0000-7000-8000-0000000057a1';
export const OPERATOR_ID = '018f0000-0000-7000-8000-0000000000b1';
export const BRANCH_ID = '018f0000-0000-7000-8000-0000000000b2';

export interface TestStore {
  store: SqlBoxStore;
  keys: { privateKeyPem: string; publicKeyPem: string };
  seal: EnvelopeSealer;
  /** Moves the store's clock; every timestamp it writes follows this. */
  setNow(iso: string): void;
  now(): Date;
  close(): void;
}

export function openTestStore(startAt = '2026-09-20T03:00:00.000Z'): TestStore {
  const db = new DatabaseSync(':memory:');
  prepareSqliteBoxStore(db);
  let now = new Date(startAt);
  const store = new SqlBoxStore({ driver: sqliteBoxDriver(db), now: () => now });
  const keys = generateSyncKeyPair();
  return {
    store,
    keys,
    seal: (draft) => sealEnvelope(draft, BOX_ID, keys.privateKeyPem),
    setNow(iso) {
      now = new Date(iso);
    },
    now: () => now,
    close: () => db.close(),
  };
}

export function plus(iso: string, ms: number): string {
  return new Date(Date.parse(iso) + ms).toISOString();
}

/**
 * A seeded source of indices in `[0, maxExclusive)`, for a booth under test.
 *
 * Deterministic, so a failing run replays, and VARYING, as the box's own
 * source (`crypto.randomInt`) is. A constant source such as `() => 0` is not a
 * booth: every code it mints is the same, so a test cannot tell one voucher
 * from the next, and code minting that draws again when a draw will not do —
 * a check character that cannot be printed, say — waits for an answer a
 * constant source never gives, and gives up. mulberry32, as in
 * `spin-distribution.test.ts`: uniform enough that a failure is the booth's,
 * not the generator's.
 */
export function seededIndex(seed: number): (maxExclusive: number) => number {
  let state = seed >>> 0;
  return (maxExclusive) => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return Math.floor((((t ^ (t >>> 14)) >>> 0) / 4294967296) * maxExclusive);
  };
}

// --- A till's box against a cloud faked at the HTTP boundary (S2-11) ----------

/** One answer the fake cloud gives: a status and a JSON body. */
export interface CloudAnswer {
  status: number;
  body: unknown;
}

/**
 * The cloud as a box sees it, for the routes a sale's printouts and a scan
 * travel: the config pull, the command poll and its results, a print job's
 * document and its outcome. Everything else answers 503, which keeps whatever
 * the box would send there on the box.
 */
export interface FakeBoxCloud {
  fetch: AgentFetch;
  /** What `GET /box/v1/config` answers. Change it and call `syncConfig` again. */
  bundle: BoxConfigBundle;
  /** Handed out by the next poll, and drained as they are. */
  commands: BoxCommandHandout[];
  /** `GET /box/v1/print-jobs/:id/document`, by job id; a job not here is a 404. */
  documents: Map<string, CloudAnswer>;
  /** Every document the box asked for, by job id, in order. */
  documentsAsked: string[];
  /** Every print outcome the box reported (`POST /box/v1/print-jobs/:id/result`). */
  printResults: Array<{ jobId: string; body: Record<string, unknown> }>;
  /** Every command result the box reported (`POST /box/v1/commands/:id/result`). */
  commandResults: Array<{ commandId: string; body: BoxCommandResultRequest }>;
}

export const TILL_RECEIPT_PRINTER = '018f0000-0000-7000-8000-00000000de01';
export const TILL_KIDS_BAND_PRINTER = '018f0000-0000-7000-8000-00000000de02';
export const TILL_KITCHEN_PRINTER = '018f0000-0000-7000-8000-00000000de03';

/** Reception Till 1, as the park's seed has it: a receipt printer, a kids band printer, a kitchen printer — all simulated. */
export function tillBundle(extra: Partial<BoxConfigBundle> = {}): BoxConfigBundle {
  const printer = (id: string, role: string, kind: string, address: string, protocol: string) => ({
    id,
    role,
    kind,
    label: `${role} printer`,
    transport: 'simulated',
    address,
    model: protocol === 'tspl2' ? '4B-2082A' : 'Xprinter XP-80',
    protocol,
    serialNumber: null,
    terminalId: null,
    merchantId: null,
    settings: {},
  });
  return {
    configVersion: 'cfg-till',
    box: { id: BOX_ID, name: 'Till box', slot: 'till-1', role: 'virtual', epoch: 1, status: 'online' },
    branch: {
      id: BRANCH_ID,
      code: 'hkt-central',
      name: 'HKT Central',
      operatorId: OPERATOR_ID,
      timezone: 'Asia/Bangkok',
      openingHours: null,
      businessDayStart: '05:00',
    },
    stations: [
      {
        id: STATION_ID,
        name: 'Reception Till 1',
        kind: 'till',
        codePrefix: 'T1',
        capabilities: [],
        configVersion: 1,
        paymentRouting: null,
        offlineWalletCapSatang: null,
        accessScope: 'all_staff',
        devices: [
          printer(TILL_RECEIPT_PRINTER, 'receipt', 'receipt_printer', '10.0.0.11:9100', 'escpos'),
          printer(TILL_KIDS_BAND_PRINTER, 'kids_band', 'band_printer', '10.0.0.12:9100', 'tspl2'),
          printer(TILL_KITCHEN_PRINTER, 'kitchen', 'receipt_printer', '10.0.0.13:9100', 'escpos'),
        ],
      },
    ],
    printTemplates: [],
    signingKeys: [],
    heartbeatIntervalS: 60,
    minSupportedAgentVersion: '0.1.0',
    ...extra,
  } as BoxConfigBundle;
}

export function fakeBoxCloud(bundle: BoxConfigBundle): FakeBoxCloud {
  const reply = (status: number, json: unknown): AgentResponse => ({
    status,
    json: async () => json,
    text: async () => JSON.stringify(json),
    header: () => null,
  });
  const cloud: FakeBoxCloud = {
    bundle,
    commands: [],
    documents: new Map(),
    documentsAsked: [],
    printResults: [],
    commandResults: [],
    fetch: async (url, init) => {
      const path = new URL(url).pathname;
      const body = init.body ? (JSON.parse(init.body) as unknown) : undefined;
      if (path === '/box/v1/config') return reply(200, cloud.bundle);
      if (path === '/box/v1/commands/poll') {
        const commands = cloud.commands.splice(0, cloud.commands.length);
        return reply(200, { commands, serverTime: new Date().toISOString() });
      }
      let match = /^\/box\/v1\/commands\/([^/]+)\/result$/.exec(path);
      if (match) {
        cloud.commandResults.push({ commandId: match[1]!, body: body as BoxCommandResultRequest });
        return reply(200, { id: match[1], state: 'done', replayed: false, epoch: 1 });
      }
      match = /^\/box\/v1\/print-jobs\/([^/]+)\/document$/.exec(path);
      if (match) {
        const jobId = decodeURIComponent(match[1]!);
        cloud.documentsAsked.push(jobId);
        const answer = cloud.documents.get(jobId) ?? {
          status: 404,
          body: { error: { code: 'PRINT_JOB_NOT_FOUND', message: 'No such print job on this box' } },
        };
        return reply(answer.status, answer.body);
      }
      match = /^\/box\/v1\/print-jobs\/([^/]+)\/result$/.exec(path);
      if (match) {
        cloud.printResults.push({ jobId: match[1]!, body: body as Record<string, unknown> });
        return reply(200, { job: { id: match[1] }, replayed: false });
      }
      return reply(503, { error: { code: 'NOT_HERE', message: 'not faked' } });
    },
  };
  return cloud;
}

const quietLog = { info() {}, warn() {}, error() {} };

/**
 * The real agent, on a real SQLite store, holding a credential already — a
 * till's box that registered on an earlier day — with its config pulled from
 * `cloud`. Terminals and the booth are off; printing is on, with no retry
 * delay, so a job waiting on paper is due as soon as the paper is back.
 */
export async function openTestAgent(
  cloud: FakeBoxCloud,
  options: Pick<BoxAgentOptions, 'bands'> = {},
): Promise<{ agent: BoxAgent; harness: TestStore; close(): void }> {
  const harness = openTestStore();
  await harness.store.init(BOX_ID);
  const agent = createBoxAgent({
    apiBaseUrl: 'http://cloud.test',
    credentials: memoryCredentialStore({
      boxId: BOX_ID,
      secret: 'till-box-test-secret',
      syncPrivateKeyPem: harness.keys.privateKeyPem,
    }),
    fetch: cloud.fetch,
    log: quietLog,
    store: harness.store,
    printing: { retryDelayMs: 0 },
    terminal: { enabled: false },
    booth: { enabled: false },
    ...options,
  });
  await agent.ensureRegistered();
  await agent.syncConfig();
  return {
    agent,
    harness,
    close() {
      agent.stop();
      harness.close();
    },
  };
}
