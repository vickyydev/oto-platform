import { randomBytes } from 'node:crypto';
import { inArray } from 'drizzle-orm';
import { opsLast, type Db } from '@oto/db';
import { readEvidence, type ReadAvailability } from './health-evidence';
import { recordRun } from './ops';

/**
 * THE INTEGRATION TEST BUTTONS (SCRUM-645, planner ruling Q26; S2-23
 * Integrations: "a test button that performs a harmless round trip").
 *
 * Each test is a SEAM — a narrow interface for exactly the round trip the
 * button promises — with a fake, in-process adapter behind it. **No live
 * adapter exists in this ticket.** Nothing here opens a socket, sends a
 * message, mints a real payment token or touches a bucket: the ruling enables
 * each live adapter per environment later, as its own decision, and until then
 * a press proves the plumbing — the gate, the permission, the `ops_run` row
 * kind `integration`, the audit — and says plainly that it ran the fake.
 *
 *   gateway  Payment Token mint, then its immediate cancel (2C2P)
 *   sms      one message to the pressing staff member (the SMS adapter)
 *   storage  put, get and delete of a scratch object (object storage)
 *   otlp     one export probe (OpenTelemetry / HyperDX)
 *   webhook  one ping (the alert webhook)
 *
 * Nothing personal reaches a record: the run's detail carries the steps and
 * their outcomes, never a phone, a token, a body or an address.
 */

export const INTEGRATION_TEST_KEYS = ['gateway', 'sms', 'storage', 'otlp', 'webhook'] as const;
export type IntegrationTestKey = (typeof INTEGRATION_TEST_KEYS)[number];

/** The seams, one per button. Each method is the provider call the live adapter will make. */
export interface GatewayTokenSeam {
  mintToken(): Promise<{ tokenRef: string }>;
  cancelToken(tokenRef: string): Promise<void>;
}
export interface SmsTestSeam {
  /** `recipientRef` names the staff member (an account id), never a phone number. */
  send(recipientRef: string, text: string): Promise<{ messageRef: string }>;
}
export interface ScratchStorageSeam {
  put(key: string, bytes: Uint8Array): Promise<void>;
  get(key: string): Promise<Uint8Array | null>;
  delete(key: string): Promise<void>;
}
export interface OtlpProbeSeam {
  exportProbe(name: string): Promise<void>;
}
export interface WebhookPingSeam {
  ping(event: string): Promise<{ status: number }>;
}

export interface IntegrationTestSeams {
  /** What is behind the seams — `fake` for every one in this ticket. */
  mode: 'fake';
  gateway: GatewayTokenSeam;
  sms: SmsTestSeam;
  storage: ScratchStorageSeam;
  otlp: OtlpProbeSeam;
  webhook: WebhookPingSeam;
}

/** What each fake captured, in memory only — read by tests, never persisted. */
export interface FakeCapture {
  gateway: { minted: string[]; cancelled: string[] };
  sms: Array<{ recipientRef: string; text: string }>;
  storage: Map<string, Uint8Array>;
  otlp: string[];
  webhook: string[];
}

/** The local adapters: every call lands in `capture` and nowhere else. */
export function createFakeIntegrationSeams(): IntegrationTestSeams & { capture: FakeCapture } {
  const capture: FakeCapture = { gateway: { minted: [], cancelled: [] }, sms: [], storage: new Map(), otlp: [], webhook: [] };
  return {
    mode: 'fake',
    capture,
    gateway: {
      async mintToken() {
        const tokenRef = `fake-token-${randomBytes(6).toString('hex')}`;
        capture.gateway.minted.push(tokenRef);
        return { tokenRef };
      },
      async cancelToken(tokenRef) {
        if (!capture.gateway.minted.includes(tokenRef)) throw new Error('the fake gateway never minted that token');
        capture.gateway.cancelled.push(tokenRef);
      },
    },
    sms: {
      async send(recipientRef, text) {
        capture.sms.push({ recipientRef, text });
        return { messageRef: `fake-sms-${capture.sms.length}` };
      },
    },
    storage: {
      async put(key, bytes) {
        capture.storage.set(key, Uint8Array.from(bytes));
      },
      async get(key) {
        return capture.storage.get(key) ?? null;
      },
      async delete(key) {
        capture.storage.delete(key);
      },
    },
    otlp: {
      async exportProbe(name) {
        capture.otlp.push(name);
      },
    },
    webhook: {
      async ping(event) {
        capture.webhook.push(event);
        return { status: 200 };
      },
    },
  };
}

let seams: IntegrationTestSeams = createFakeIntegrationSeams();

/** The seams the routes press. Fake everywhere until a live adapter is enabled per environment. */
export function integrationTestSeams(): IntegrationTestSeams {
  return seams;
}

/** Tests only: put a capturing or failing set behind the seams, and get the previous one back. */
export function replaceIntegrationTestSeamsForTest(next: IntegrationTestSeams): IntegrationTestSeams {
  const previous = seams;
  seams = next;
  return previous;
}

export interface IntegrationTestCatalogueEntry {
  key: IntegrationTestKey;
  label: string;
  description: string;
}

export const INTEGRATION_TEST_CATALOGUE: readonly IntegrationTestCatalogueEntry[] = [
  { key: 'gateway', label: 'Payment gateway: mint and cancel a token', description: 'Mints a Payment Token and cancels it at once.' },
  { key: 'sms', label: 'SMS: send a test message to me', description: 'Sends one test message addressed to the person pressing.' },
  { key: 'storage', label: 'Object storage: scratch round trip', description: 'Puts a scratch object, reads it back, deletes it, and checks it is gone.' },
  { key: 'otlp', label: 'Telemetry: export probe', description: 'Exports one probe span to the telemetry collector.' },
  { key: 'webhook', label: 'Alert webhook: ping', description: 'Sends one ping to the alert webhook.' },
];

export const integrationTestRunName = (key: IntegrationTestKey): string => `integration:${key}.test`;

export interface IntegrationTestHistoryRow extends Omit<IntegrationTestCatalogueEntry, 'key'> {
  integration: IntegrationTestKey;
  lastRunAt: string | null;
  lastOutcome: string | null;
  lastOkAt: string | null;
  lastFailedAt: string | null;
}

/**
 * Each button with when it last ran, from `ops_last`. A refused or failed
 * read leaves every row's history null and says so in `availability` — it is
 * not "never run".
 */
export async function integrationTestHistory(db: Db): Promise<{
  adapter: IntegrationTestSeams['mode'];
  availability: ReadAvailability;
  tests: IntegrationTestHistoryRow[];
}> {
  const read = await readEvidence(() =>
    db.select().from(opsLast).where(inArray(opsLast.name, INTEGRATION_TEST_CATALOGUE.map((t) => integrationTestRunName(t.key)))),
  );
  const byName = new Map((read.ok ? read.value : []).map((row) => [row.name, row]));
  const iso = (value: Date | null | undefined) => (value ? value.toISOString() : null);
  return {
    adapter: integrationTestSeams().mode,
    availability: read.ok ? 'ok' : read.availability,
    tests: INTEGRATION_TEST_CATALOGUE.map((entry) => {
      const last = byName.get(integrationTestRunName(entry.key));
      return {
        integration: entry.key,
        label: entry.label,
        description: entry.description,
        lastRunAt: iso(last?.lastFinishedAt ?? last?.lastStartedAt),
        lastOutcome: last?.lastOutcome ?? null,
        lastOkAt: iso(last?.lastOkAt),
        lastFailedAt: iso(last?.lastFailedAt),
      };
    }),
  };
}

export interface IntegrationTestStep {
  step: string;
  outcome: 'ok' | 'failed';
}

export interface IntegrationTestResult {
  integration: IntegrationTestKey;
  runId: string;
  outcome: 'ok' | 'failed';
  adapter: 'fake';
  steps: IntegrationTestStep[];
  message: string;
}

class StepFailed extends Error {
  constructor(readonly step: string, readonly reason: unknown) {
    super(`${step} failed`);
    this.name = 'IntegrationTestStepFailed';
  }
}

async function exercise(key: IntegrationTestKey, impl: IntegrationTestSeams, recipientRef: string, steps: IntegrationTestStep[]) {
  const step = async <T>(name: string, work: () => Promise<T>): Promise<T> => {
    try {
      const value = await work();
      steps.push({ step: name, outcome: 'ok' });
      return value;
    } catch (err) {
      steps.push({ step: name, outcome: 'failed' });
      throw new StepFailed(name, err);
    }
  };
  if (key === 'gateway') {
    const { tokenRef } = await step('mint', () => impl.gateway.mintToken());
    await step('cancel', () => impl.gateway.cancelToken(tokenRef));
  } else if (key === 'sms') {
    await step('send', () => impl.sms.send(recipientRef, 'OTO test message from the Console. Nothing is wrong.'));
  } else if (key === 'storage') {
    const scratch = `scratch/integration-test-${randomBytes(8).toString('hex')}`;
    const bytes = randomBytes(32);
    await step('put', () => impl.storage.put(scratch, bytes));
    try {
      await step('get', async () => {
        const back = await impl.storage.get(scratch);
        if (!back || Buffer.compare(Buffer.from(back), bytes) !== 0) throw new Error('the object read back differs from the one written');
      });
    } finally {
      // The scratch object never outlives the test, even when the read failed.
      await step('delete', () => impl.storage.delete(scratch));
    }
    await step('confirm gone', async () => {
      if ((await impl.storage.get(scratch)) !== null) throw new Error('the scratch object is still there after delete');
    });
  } else if (key === 'otlp') {
    await step('export', () => impl.otlp.exportProbe('oto.integration.test'));
  } else {
    await step('ping', async () => {
      const { status } = await impl.webhook.ping('integration.test');
      if (status < 200 || status >= 300) throw new Error(`the webhook answered ${status}`);
    });
  }
}

/**
 * Press one test: run its round trip through the seam and record the run as
 * `ops_run` kind `integration` — written on the pool, after the attempt, so
 * the record of a failed attempt is never rolled back with it. The audit row
 * is the route's, in its own transaction.
 */
export async function runIntegrationTest(
  db: Db,
  key: IntegrationTestKey,
  ctx: { operatorId: string; accountId: string; requestId?: string | null },
): Promise<IntegrationTestResult> {
  const impl = integrationTestSeams();
  const steps: IntegrationTestStep[] = [];
  const startedAt = new Date();
  let error: unknown;
  try {
    await exercise(key, impl, ctx.accountId, steps);
  } catch (err) {
    error = err;
  }
  const outcome = error === undefined ? 'ok' : 'failed';
  const run = await recordRun(db, {
    kind: 'integration',
    name: integrationTestRunName(key),
    outcome,
    startedAt,
    ...(error === undefined ? {} : { error: error instanceof StepFailed ? new StepFailed(error.step, null) : error }),
    detail: { adapter: impl.mode, steps },
    requestId: ctx.requestId ?? null,
    operatorId: ctx.operatorId,
  });
  const failedStep = steps.find((s) => s.outcome === 'failed')?.step;
  return {
    integration: key,
    runId: run.id,
    outcome,
    adapter: impl.mode,
    steps,
    message:
      outcome === 'ok'
        ? `The ${impl.mode} adapter completed the round trip. No real provider was called: the live adapter is enabled per environment later.`
        : `The ${impl.mode} adapter failed at ${failedStep ?? 'its first step'}. No real provider was called.`,
  };
}
