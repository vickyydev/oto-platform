import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, stopTestServer } from '@oto/db/testing';

/**
 * SCRUM-548: the reporting assistant stores evidence, explains it and queues
 * one QA record. It receives no capability to change reported business data.
 * These controls run the real QA route/store child and an independent bounded
 * source reader. The route fixture supplies authenticated identities; full
 * launcher/Passport entry remains a separate staged acceptance requirement.
 * App CI must install the app dependencies and run this whole file. API shards
 * without that dependency tree retain the established conditional boundary.
 */
const APP = fileURLToPath(new URL('../../oto-app/', import.meta.url));
const TSX = join(APP, 'node_modules/tsx/dist/cli.mjs');
const available = existsSync(TSX);
type Proof = Record<string, boolean>;

function childProof(script: string, marker: string, env: NodeJS.ProcessEnv, resultField?: string): Proof {
  const run = spawnSync(process.execPath, [TSX, script], {
    cwd: APP, env, encoding: 'utf8', timeout: 180_000, maxBuffer: 2 * 1024 * 1024,
  });
  // Never print child logs: provider errors, synthetic session data and SQL
  // connection options are not evidence. Only the allowlisted boolean map is.
  expect(run.error?.name, `${script}: child starts without an execution error`).toBeUndefined();
  const payload = (run.stdout ?? '').split(/\r?\n/).find(line => line.startsWith(`${marker}=`))?.slice(marker.length + 1);
  let failedControls: string[] = [];
  try {
    const parsed = JSON.parse(payload ?? '{}');
    const controls = resultField ? parsed[resultField] : parsed;
    failedControls = Object.entries(controls ?? {}).filter(([key, value]) => /^[a-zA-Z][a-zA-Z0-9]{0,80}$/.test(key) && value === false).map(([key]) => key);
  } catch { /* Only allowlisted control names become diagnostics. */ }
  const setup = (run.stdout ?? '').split(/\r?\n/).find(line => /^QA_REPORT_SETUP_ERROR=[a-zA-Z0-9_-]{1,50}$/.test(line)) ?? 'no setup failure tag';
  expect(run.status, `${script}: child completes; failed controls: ${failedControls.join(', ') || 'none reported'}; ${setup}`).toBe(0);
  expect(payload, `${script}: result marker exists`).toBeTruthy();
  if (!payload) throw new Error('QA child did not publish its result marker');
  const decoded: unknown = JSON.parse(payload);
  expect(decoded && typeof decoded === 'object' && !Array.isArray(decoded), 'QA results are a boolean map').toBe(true);
  const values = (resultField ? (decoded as Record<string, unknown>)[resultField] : decoded) as Record<string, unknown>;
  expect(values && typeof values === 'object' && !Array.isArray(values), 'QA proof map exists').toBe(true);
  expect(Object.values(values).every(value => typeof value === 'boolean'), 'QA results contain booleans only').toBe(true);
  return values as Proof;
}

describe.skipIf(!available)('SCRUM-548 independent source boundary review', () => {
  let proof: Proof;
  beforeAll(() => {
    proof = childProof('tests/qa-review-boundaries.check.ts', 'QA_BOUNDARY_RESULTS', { ...process.env, NODE_ENV: 'test' });
  }, 200_000);
  it('source selection excludes environment, configuration, seed and traversal paths', () => expect(proof.sourceAllowlist).toBe(true));
  it('source redaction removes credential lines and URL queries without changing the file', () => expect(proof.sourceRedaction && proof.bundleReadOnlyAndScoped).toBe(true));
  it('a different release or changed source digest cannot become report evidence', () => expect(proof.sourceVersionAndDigest).toBe(true));
  it('untrusted source indexes cannot widen paths, line ranges or excerpt sizes', () => expect(proof.untrustedIndexRefusal).toBe(true));
  it('prompt text can rank only approved excerpts within the document and character budgets', () => expect(proof.selectionBounded).toBe(true));
  it('model output cannot introduce tool commands or claim support outside supplied release excerpts', () => expect(proof.citationsAndStructuredBoundary).toBe(true));
  it('FINDING 3 medium: a long initial report cannot hide the latest correction; prescribed fix applied: retain bounded first and newest turns with an omission note', () => expect(proof.latestFollowupRetained).toBe(true));
  it('FINDING 4 medium: model wording cannot claim a deployed fix or completed runtime test; prescribed fix applied: downgrade unsupported execution claims', () => expect(proof.noInventedRuntime).toBe(true));
  it('Jira comments require both the configured parent and the exact report marker before any write', () => expect(proof.jiraPlacementBound).toBe(true));
  it('a lost Jira comment response is reconciled before retrying the same saved comment', () => expect(proof.jiraCommentLostResponse).toBe(true));
});

describe.skipIf(!available)('SCRUM-548 worker capability and recovery review', () => {
  let proof: Proof;
  beforeAll(() => {
    proof = childProof('tests/qa-analysis.check.ts', 'QA_WORKER_RESULTS', {
      ...process.env, NODE_ENV: 'test', QA_REPORTS_ENABLED: 'false',
    }, 'results');
  }, 200_000);
  it('worker source evidence remains bound to the saved release', () => expect(proof.sourceVersion).toBe(true));
  it('worker conclusions cannot exceed supplied source citations', () => expect(proof.citationBounds).toBe(true));
  it('the latest user correction remains in the bounded model context', () => expect(proof.latestTurn).toBe(true));
  it('unsupported runtime and implementation claims are refused', () => expect(proof.runtimeClaims).toBe(true));
  it('Jira recording retains the entire bounded report text', () => expect(proof.jiraText).toBe(true));
  it('a different configured sprint is refused before a provider request', () => expect(proof.jiraPlacement).toBe(true));
  it('ambiguous Jira creation retains one reservation and recovers the existing issue', () => expect(proof.jiraAmbiguous).toBe(true));
  it('unavailable analysis still saves the Jira link and leaves an honest retry state', () => expect(proof.workerFallback).toBe(true));
  it('worker failure passes the original revision so newer evidence can be queued', () => expect(proof.newerRevisionFailureRequeues).toBe(true));
  it('FINDING 6 medium: accepted evidence cannot disappear at Jira publishing; prescribed fix applied: publish all ten accepted files independently of the model frame budget', () => expect(proof.allAcceptedEvidencePublishes).toBe(true));
});

describe.skipIf(!available)('SCRUM-548 report ownership and durable processing review', () => {
  let proof: Proof;
  afterAll(stopTestServer);
  beforeAll(async () => {
    const database = await createTestDatabase({ otoapp: true });
    try {
      proof = childProof('tests/qa-reports.check.ts', 'QA_REPORT_RESULTS', {
        ...process.env, DATABASE_URL: database.url, DB_SCHEMA: 'otoapp', NODE_ENV: 'test',
        APP_ENV: 'dev', DEPLOY_ENV: 'local', QA_REPORTS_ENABLED: 'false', TZ: 'UTC',
      });
    } finally { await database.drop(); }
  }, 300_000);
  it('owned report creation captures current server context and a durable first message', () => expect(proof.ownedDraftAndContext).toBe(true));
  it('another reporter or park cannot list, read, append, queue or attach to the report', () => expect(proof.foreignReporterAndPark).toBe(true));
  it('anonymous, inactive and cross-origin requests fail before report work', () => expect(proof.sameOriginAndCurrentAccess).toBe(true));
  it('FINDING 1 medium: lost-answer create replay survives a release change; prescribed fix applied: fingerprint client input and retain the original server source context', () => expect(proof.createReplayAndConflict).toBe(true));
  it('message replay retains one saved turn and altered text under the same key is refused', () => expect(proof.messageReplayAndConflict).toBe(true));
  it('FINDING 2 medium: lost-answer attachment retry retains one object and row; prescribed fix applied: stable upload key with exact content receipt before storage writes', () => expect(proof.privateAttachmentReplay).toBe(true));
  it('changed upload bytes and foreign attachment IDs cannot overwrite or remove original private evidence', () => expect(proof.privateAttachmentConflictAndForeign).toBe(true));
  it('FINDING 7 medium: a stalled evidence body cannot hold a request indefinitely; prescribed fix applied: bound bytes and total read time while preserving supported media', () => expect(proof.mediaTypes && proof.mediaMismatchAndLimit).toBe(true));
  it('concurrent workers claim one queued report and repeated queue requests retain it', () => expect(proof.queueAndSingleClaim).toBe(true));
  it('FINDING 5 medium: an older result or failure cannot pause a new follow-up; prescribed fix applied: compare revision under the report lock and queue current evidence', () => expect(proof.staleRevisionRequeues).toBe(true));
  it('an expired worker cannot renew, finish or replace the current worker result', () => expect(proof.expiredLeaseCannotWrite).toBe(true));
  it('the durable Jira create reservation survives a lost response and cannot be claimed twice', () => expect(proof.durableJiraReservation).toBe(true));
  it('automatic failure retries stop at the configured attempt bound', () => expect(proof.boundedRetries).toBe(true));
  it('analysis usage limits and cached results survive repeated processing', () => expect(proof.analysisBudgetAndCache).toBe(true));
  it('a saved draft interrupted before queue submission is recovered by the worker', () => expect(proof.interruptedDraftPickup).toBe(true));
  it('every additional runtime control is reported rather than silently discarded', () => {
    expect(Object.keys(proof).length).toBeGreaterThanOrEqual(16);
    expect(Object.entries(proof).filter(([, passed]) => !passed)).toEqual([]);
  });
});
