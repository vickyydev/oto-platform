import { readFileSync } from 'node:fs';
import { and, eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auditLog, deployEvent, type SuiteAppKey } from '@oto/db';
import { newId } from '@oto/shared';
import { JobFailedError } from '../src/services/job-failure';
import type { FastifyBaseLogger } from 'fastify';
import {
  RELEASE_FEED_CI_READS_PER_PASS, RELEASE_FEED_JOB, buildReleaseFeedJobs, ciResultOf, observeDeployments, releaseFeedConfigOf,
  type FeedFetch, type ReleaseFeedConfig,
} from '../src/services/release-feed';
import { buildDefaultJobs } from '../src/services/jobs';
import { ADMIN, RECEPTION, createTestContext, signInAs, teardownAll, type TestContext } from './helpers';

/**
 * SCRUM-672 — the release feed against a scripted Render and GitHub, recording
 * into a real database and read back through the Console's own route. The
 * outside world is the one seam (`FeedFetch`); every other line runs as it does
 * in the job runner.
 */

const RENDER_KEY = 'zz-render-key-never-to-be-seen-0123456789';
const GITHUB_TOKEN = 'zz-github-token-never-to-be-seen-0123456789';
const REPO = 'https://github.com/zz-owner/zz-repo';
const commitOf = (n: number) => n.toString(16).padStart(40, 'a');

interface Deploy { id: string; status: string; commit?: { id?: string | null; message?: string } | null; finishedAt?: string | null; [unknown: string]: unknown }
interface Call { method: string; url: string; headers: Record<string, string>; redirect: string }

/** Render and GitHub as this feed reads them. Everything a test does not set answers as a healthy provider would. */
class Outside {
  readonly calls: Call[] = [];
  readonly deploys = new Map<string, Deploy[]>();
  readonly checks = new Map<string, { total_count: number; check_runs: Array<{ status: string; conclusion: string | null; name?: string }> } | number>();
  readonly servicesDown = new Set<string>();
  readonly fetch: FeedFetch = async (url, init) => {
    this.calls.push({ method: init.method, url, headers: init.headers, redirect: init.redirect });
    const answer = (status: number, body: unknown) => ({ status, text: async () => JSON.stringify(body) });
    const parsed = new URL(url);
    if (parsed.host === 'api.render.com') {
      const name = parsed.searchParams.get('name');
      if (parsed.pathname === '/v1/services' && name) {
        if (this.servicesDown.has(name)) return answer(500, { message: `render failed with ${init.headers.authorization}` });
        // A near match first: the feed must take the exact name.
        return answer(200, [
          { service: { id: `srv-near-${name}`, name: `${name}-near`, repo: REPO }, cursor: 'c0' },
          ...(this.deploys.has(name) ? [{ service: { id: `srv-${name}`, name, repo: REPO, brandNewField: { nested: true } }, cursor: 'c1' }] : []),
        ]);
      }
      const match = /^\/v1\/services\/srv-(.+)\/deploys$/.exec(parsed.pathname);
      if (match) return answer(200, (this.deploys.get(match[1]!) ?? []).map(deploy => ({ deploy, cursor: 'c' })));
    }
    if (parsed.host === 'api.github.com') {
      const match = /^\/repos\/zz-owner\/zz-repo\/commits\/([0-9a-f]+)\/check-runs$/.exec(parsed.pathname);
      const check = match ? this.checks.get(match[1]!) : undefined;
      if (typeof check === 'number') return answer(check, { message: 'refused' });
      return answer(200, check ?? { total_count: 2, check_runs: [{ name: 'ci', status: 'completed', conclusion: 'success' }, { name: 'oto-app', status: 'completed', conclusion: 'skipped' }] });
    }
    throw new Error(`the feed reached somewhere it should not: ${url}`);
  };
}

let ctx: TestContext;
let admin: string;
const logLines: string[] = [];
const log = {
  warn: (...args: unknown[]) => void logLines.push(JSON.stringify(args)),
  error: (...args: unknown[]) => void logLines.push(JSON.stringify(args)),
  info: (...args: unknown[]) => void logLines.push(JSON.stringify(args)),
} as unknown as FastifyBaseLogger;

const service = (label: string) => `zz-${label}-${newId().slice(-8)}`;
const configOf = (services: Array<{ app: SuiteAppKey; service: string }>, githubToken: string | null = null): ReleaseFeedConfig => ({ renderApiKey: RENDER_KEY, services, githubToken });
const pass = (outside: Outside, config: ReleaseFeedConfig) => observeDeployments(ctx.db, { config, fetch: outside.fetch, log });
const rowsOf = (name: string) => ctx.db.select().from(deployEvent).where(eq(deployEvent.service, name));
const auditsOf = (ids: string[]) => ids.length === 0 ? Promise.resolve([]) : ctx.db.select().from(auditLog).where(and(eq(auditLog.entityType, 'deploy_event'), inArray(auditLog.entityId, ids)));

beforeAll(async () => {
  ctx = await createTestContext({ env: { PROCESS_ROLES: 'api' } });
  admin = await signInAs(ctx.app, ADMIN.phone, ADMIN.password);
}, 300_000);
afterAll(async () => { try { await ctx?.close(); } finally { await teardownAll(); } });

describe('a deployment that went live', () => {
  it('is recorded once with its exact commit, service, CI result and real time, and the Console shows it once', async () => {
    const outside = new Outside();
    const name = service('live');
    const id = `dep-${newId()}`;
    outside.deploys.set(name, [{ id, status: 'live', trigger: 'new_commit', commit: { id: commitOf(1), message: 'zz' }, createdAt: '2030-01-01T00:00:00Z', finishedAt: '2030-01-01T00:05:07.250Z', aFutureField: 1 }]);
    const summary = await pass(outside, configOf([{ app: 'pos', service: name }]));
    expect(summary).toMatchObject({ services: 1, servicesFailed: [], deploymentsRead: 1, recorded: 1, replayed: 0, conflicts: [], ciReads: 1 });

    const [row, ...others] = await rowsOf(name);
    expect(others).toEqual([]);
    expect(row).toMatchObject({ app: 'pos', service: name, source: 'render', sourceEventId: id, status: 'live', commit: commitOf(1), ciGreen: true,
      actorAccountId: null, version: null, deployedAt: new Date('2030-01-01T00:05:07.250Z'), finishedAt: new Date('2030-01-01T00:05:07.250Z') });
    const audits = await auditsOf([row!.id]);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ action: 'deploy_event.record', actorAccountId: null, targetApp: 'pos', origin: 'job' });
    expect(audits[0]!.after).toMatchObject({ commit: commitOf(1), status: 'live', source: 'render', sourceEventId: id, deployedAt: '2030-01-01T00:05:07.250Z' });

    const history = await ctx.app.inject({ method: 'GET', url: '/console/releases?app=pos&limit=100', headers: { cookie: admin } });
    expect(history.statusCode, history.body).toBe(200);
    const mine = (history.json() as { deployments: Array<{ id: string }> }).deployments.filter(d => d.id === row!.id);
    expect(mine).toEqual([expect.objectContaining({ commit: commitOf(1), ciGreen: true, status: 'live', service: name, source: 'render', sourceEventId: id,
      deployedAt: '2030-01-01T00:05:07.250Z', finishedAt: '2030-01-01T00:05:07.250Z', actorAccountId: null, version: null })]);
  });

  it('stays one event when it is read again, and when Render later calls it deactivated', async () => {
    const outside = new Outside();
    const name = service('replay');
    const id = `dep-${newId()}`;
    const finishedAt = '2030-01-02T00:05:00.000Z';
    outside.deploys.set(name, [{ id, status: 'live', commit: { id: commitOf(2) }, finishedAt }]);
    const config = configOf([{ app: 'console', service: name }]);
    expect((await pass(outside, config)).recorded).toBe(1);
    const [first] = await rowsOf(name);
    const again = await pass(outside, config);
    expect(again).toMatchObject({ recorded: 0, replayed: 1, conflicts: [], ciReads: 0 });
    outside.deploys.set(name, [
      { id: `dep-${newId()}`, status: 'live', commit: { id: commitOf(3) }, finishedAt: '2030-01-02T01:00:00.000Z' },
      { id, status: 'deactivated', commit: { id: commitOf(2) }, finishedAt },
    ]);
    const third = await pass(outside, config);
    expect(third).toMatchObject({ recorded: 1, replayed: 1, conflicts: [] });
    const rows = await rowsOf(name);
    expect(rows).toHaveLength(2);
    expect(rows.find(r => r.sourceEventId === id)).toEqual(first);
    expect(await auditsOf([first!.id])).toHaveLength(1);
    // Two instances reading at once are still one event each.
    const fresh = service('race');
    outside.deploys.set(fresh, [{ id: `dep-${newId()}`, status: 'live', commit: { id: commitOf(4) }, finishedAt }]);
    const both = configOf([{ app: 'pos', service: fresh }]);
    await Promise.all([pass(outside, both), pass(outside, both), pass(outside, both)]);
    expect(await rowsOf(fresh)).toHaveLength(1);
  });

  it('records a deployment first seen as already replaced as the live one it was, oldest first', async () => {
    const outside = new Outside();
    const name = service('history');
    const older = `dep-${newId()}`;
    const newer = `dep-${newId()}`;
    outside.deploys.set(name, [
      { id: newer, status: 'live', commit: { id: commitOf(6) }, finishedAt: '2030-01-03T01:00:00.000Z' },
      { id: older, status: 'deactivated', commit: { id: commitOf(5) }, finishedAt: '2030-01-03T00:00:00.000Z' },
    ]);
    await pass(outside, configOf([{ app: 'booth', service: name }]));
    const rows = await rowsOf(name);
    expect(rows.find(r => r.sourceEventId === older)).toMatchObject({ status: 'live', deployedAt: new Date('2030-01-03T00:00:00.000Z') });
    // Oldest first, so the history reads in the order it happened.
    const sorted = [...rows].sort((a, b) => a.id < b.id ? -1 : 1);
    expect(sorted.map(r => r.sourceEventId)).toEqual([older, newer]);
  });
});

describe('a deployment that did not go live', () => {
  it.each(['build_failed', 'update_failed', 'pre_deploy_failed', 'canceled'])('keeps Render’s word %s and has no deployment time', async (status) => {
    const outside = new Outside();
    const name = service('failed');
    outside.deploys.set(name, [{ id: `dep-${newId()}`, status, commit: { id: commitOf(7) }, finishedAt: '2030-01-04T00:05:00.000Z' }]);
    await pass(outside, configOf([{ app: 'inbox', service: name }]));
    const [row] = await rowsOf(name);
    // A green build, and a deployment that did not complete: the two facts stay apart.
    expect(row).toMatchObject({ status, ciGreen: true, deployedAt: null, finishedAt: new Date('2030-01-04T00:05:00.000Z') });
  });

  it('records nothing while it is still going, however green its build, and records it once it ends', async () => {
    const outside = new Outside();
    const name = service('going');
    const id = `dep-${newId()}`;
    const config = configOf([{ app: 'pos', service: name }]);
    for (const status of ['created', 'queued', 'build_in_progress', 'pre_deploy_in_progress', 'update_in_progress']) {
      outside.deploys.set(name, [{ id, status, commit: { id: commitOf(8) } }]);
      const summary = await pass(outside, config);
      expect(summary).toMatchObject({ recorded: 0, stillGoing: 1, ciReads: 0 });
    }
    expect(await rowsOf(name)).toEqual([]);
    outside.deploys.set(name, [{ id, status: 'live', commit: { id: commitOf(8) }, finishedAt: '2030-01-05T00:00:00.000Z' }]);
    expect((await pass(outside, config)).recorded).toBe(1);
  });

  it('records nothing for a status it does not know, and says which', async () => {
    const outside = new Outside();
    const name = service('novel');
    outside.deploys.set(name, [{ id: `dep-${newId()}`, status: 'some_new_state', commit: { id: commitOf(9) }, finishedAt: '2030-01-05T00:00:00.000Z' }]);
    const summary = await pass(outside, configOf([{ app: 'pos', service: name }]));
    expect(summary).toMatchObject({ recorded: 0, unknownStatuses: ['some_new_state'] });
    expect(await rowsOf(name)).toEqual([]);
  });
});

describe('a fact nobody supplied stays unknown', () => {
  it('keeps a missing or partial commit, a missing time and a missing CI result null, and infers none of them', async () => {
    const outside = new Outside();
    const name = service('missing');
    const noCommit = `dep-${newId()}`, shortCommit = `dep-${newId()}`, noTime = `dep-${newId()}`;
    outside.deploys.set(name, [
      { id: noCommit, status: 'live', commit: null, finishedAt: '2030-01-06T00:00:00.000Z' },
      { id: shortCommit, status: 'live', commit: { id: 'abc1234' }, finishedAt: '2030-01-06T00:00:00.000Z' },
      { id: noTime, status: 'live', commit: { id: commitOf(10) } },
    ]);
    const summary = await pass(outside, configOf([{ app: 'pos', service: name }]));
    expect(summary.recorded).toBe(3);
    const rows = await rowsOf(name);
    expect(rows.find(r => r.sourceEventId === noCommit)).toMatchObject({ commit: null, ciGreen: null, deployedAt: new Date('2030-01-06T00:00:00.000Z') });
    expect(rows.find(r => r.sourceEventId === shortCommit)).toMatchObject({ commit: null, ciGreen: null });
    expect(rows.find(r => r.sourceEventId === noTime)).toMatchObject({ commit: commitOf(10), ciGreen: true, deployedAt: null, finishedAt: null });
    // No commit, nothing to ask GitHub about.
    expect(outside.calls.filter(c => c.url.includes('api.github.com'))).toHaveLength(1);
    for (const row of rows) expect(row.version).toBeNull();
  });

  it('reads CI as every check run: no runs, a run still going or a run that was not whole is unknown; any bad conclusion is false', () => {
    const run = (status: string, conclusion: string | null) => ({ status, conclusion });
    expect(ciResultOf({ total_count: 0, check_runs: [] })).toBeNull();
    expect(ciResultOf({ total_count: 2, check_runs: [run('completed', 'success'), run('in_progress', null)] })).toBeNull();
    expect(ciResultOf({ total_count: 3, check_runs: [run('completed', 'success')] })).toBeNull();
    expect(ciResultOf({ total_count: 3, check_runs: [run('completed', 'success'), run('completed', 'skipped'), run('completed', 'neutral')] })).toBe(true);
    for (const bad of ['failure', 'cancelled', 'timed_out', 'action_required', 'startup_failure', 'stale']) {
      expect(ciResultOf({ total_count: 2, check_runs: [run('completed', 'success'), run('completed', bad)] }), bad).toBe(false);
    }
  });

  it('fills an unknown CI result in once it is known, audited, and never changes one already recorded', async () => {
    const outside = new Outside();
    const name = service('cifill');
    const sha = commitOf(11);
    outside.deploys.set(name, [{ id: `dep-${newId()}`, status: 'live', commit: { id: sha }, finishedAt: '2030-01-07T00:00:00.000Z' }]);
    outside.checks.set(sha, 502);
    const config = configOf([{ app: 'pos', service: name }]);
    expect(await pass(outside, config)).toMatchObject({ recorded: 1, ciReadsFailed: 1 });
    const [row] = await rowsOf(name);
    expect(row!.ciGreen).toBeNull();
    outside.checks.set(sha, { total_count: 1, check_runs: [{ status: 'in_progress', conclusion: null }] });
    expect(await pass(outside, config)).toMatchObject({ replayed: 1, ciFilled: 0 });
    outside.checks.set(sha, { total_count: 1, check_runs: [{ status: 'completed', conclusion: 'failure' }] });
    expect(await pass(outside, config)).toMatchObject({ ciFilled: 1, conflicts: [] });
    const [filled] = await rowsOf(name);
    expect(filled).toMatchObject({ id: row!.id, ciGreen: false, status: 'live', commit: sha });
    const audits = await auditsOf([row!.id]);
    expect(audits.map(a => a.action).sort()).toEqual(['deploy_event.ci_observed', 'deploy_event.record']);
    expect(audits.find(a => a.action === 'deploy_event.ci_observed')).toMatchObject({ before: { ciGreen: null }, after: { ciGreen: false }, origin: 'job' });
    // Known now: a re-run turning green does not rewrite what the deployment went out on, and costs no read.
    outside.checks.set(sha, { total_count: 1, check_runs: [{ status: 'completed', conclusion: 'success' }] });
    expect(await pass(outside, config)).toMatchObject({ replayed: 1, ciFilled: 0, ciReads: 0 });
    expect((await rowsOf(name))[0]!.ciGreen).toBe(false);
  });

  it('fills in a time first read as unknown once Render supplies it, audited, as one more fact and not a conflict', async () => {
    const outside = new Outside();
    const name = service('timefill');
    const id = `dep-${newId()}`;
    const failedId = `dep-${newId()}`;
    const config = configOf([{ app: 'pos', service: name }]);
    outside.deploys.set(name, [{ id, status: 'live', commit: { id: commitOf(16) } }, { id: failedId, status: 'update_failed', commit: { id: commitOf(16) } }]);
    expect(await pass(outside, config)).toMatchObject({ recorded: 2, timeFilled: 0 });
    const before = await rowsOf(name);
    expect(before.find(r => r.sourceEventId === id)).toMatchObject({ deployedAt: null, finishedAt: null, ciGreen: true });

    // Still unknown: a repeat, and nothing written.
    expect(await pass(outside, config)).toMatchObject({ recorded: 0, replayed: 2, timeFilled: 0, conflicts: [] });

    const finishedAt = '2030-01-08T00:05:00.000Z';
    outside.deploys.set(name, [{ id, status: 'deactivated', commit: { id: commitOf(16) }, finishedAt }, { id: failedId, status: 'update_failed', commit: { id: commitOf(16) }, finishedAt }]);
    expect(await pass(outside, config)).toMatchObject({ recorded: 0, replayed: 0, timeFilled: 2, conflicts: [] });
    const rows = await rowsOf(name);
    const live = rows.find(r => r.sourceEventId === id)!;
    const failed = rows.find(r => r.sourceEventId === failedId)!;
    expect(live).toMatchObject({ id: before.find(r => r.sourceEventId === id)!.id, status: 'live', commit: commitOf(16), deployedAt: new Date(finishedAt), finishedAt: new Date(finishedAt) });
    // One that did not go live still has no deployment time: only the time it ended.
    expect(failed).toMatchObject({ status: 'update_failed', deployedAt: null, finishedAt: new Date(finishedAt) });
    const audits = await auditsOf([live.id, failed.id]);
    expect(audits.filter(a => a.entityId === live.id).find(a => a.action === 'deploy_event.time_observed')).toMatchObject({ origin: 'job', actorAccountId: null, targetApp: 'pos',
      before: { deployedAt: null, finishedAt: null }, after: { deployedAt: finishedAt, finishedAt } });
    expect(audits.filter(a => a.entityId === failed.id).find(a => a.action === 'deploy_event.time_observed')).toMatchObject({ before: { finishedAt: null }, after: { finishedAt } });

    // Once known, a repeat writes nothing; a read with the time missing says nothing against it; a different time is a conflict and the record stands.
    expect(await pass(outside, config)).toMatchObject({ replayed: 2, timeFilled: 0, conflicts: [] });
    outside.deploys.set(name, [{ id, status: 'live', commit: { id: commitOf(16) }, finishedAt: null }]);
    expect(await pass(outside, config)).toMatchObject({ replayed: 1, timeFilled: 0, conflicts: [] });
    outside.deploys.set(name, [{ id, status: 'live', commit: { id: commitOf(16) }, finishedAt: '2030-01-08T09:00:00.000Z' }]);
    expect(await pass(outside, config)).toMatchObject({ replayed: 0, timeFilled: 0, conflicts: [id] });
    expect((await rowsOf(name)).find(r => r.sourceEventId === id)).toEqual(live);
    expect(await auditsOf([live.id, failed.id])).toHaveLength(audits.length);
  });

  it('fills an unknown CI result and an unknown time together on one pass, with a row for each', async () => {
    const outside = new Outside();
    const name = service('bothfill');
    const sha = commitOf(17);
    const id = `dep-${newId()}`;
    const config = configOf([{ app: 'pos', service: name }]);
    outside.deploys.set(name, [{ id, status: 'live', commit: { id: sha } }]);
    outside.checks.set(sha, 502);
    expect(await pass(outside, config)).toMatchObject({ recorded: 1 });
    const finishedAt = '2030-01-09T00:05:00.000Z';
    outside.deploys.set(name, [{ id, status: 'live', commit: { id: sha }, finishedAt }]);
    outside.checks.set(sha, { total_count: 1, check_runs: [{ status: 'completed', conclusion: 'success' }] });
    expect(await pass(outside, config)).toMatchObject({ ciFilled: 1, timeFilled: 1, conflicts: [] });
    const [row] = await rowsOf(name);
    expect(row).toMatchObject({ ciGreen: true, deployedAt: new Date(finishedAt), finishedAt: new Date(finishedAt) });
    expect((await auditsOf([row!.id])).map(a => a.action).sort()).toEqual(['deploy_event.ci_observed', 'deploy_event.record', 'deploy_event.time_observed']);
  });

  it('stops asking GitHub for the pass once it refuses, and stays within its budget', async () => {
    const outside = new Outside();
    const name = service('refused');
    outside.deploys.set(name, [
      { id: `dep-${newId()}`, status: 'live', commit: { id: commitOf(12) }, finishedAt: '2030-01-08T00:00:00.000Z' },
      { id: `dep-${newId()}`, status: 'deactivated', commit: { id: commitOf(13) }, finishedAt: '2030-01-07T00:00:00.000Z' },
    ]);
    outside.checks.set(commitOf(12), 403);
    outside.checks.set(commitOf(13), 403);
    const summary = await pass(outside, configOf([{ app: 'pos', service: name }]));
    expect(summary).toMatchObject({ recorded: 2, ciReads: 1, ciReadsFailed: 1 });
    for (const row of await rowsOf(name)) expect(row.ciGreen).toBeNull();

    const many = service('budget');
    outside.deploys.set(many, Array.from({ length: 10 }, (_, i) => ({ id: `dep-${newId()}`, status: 'deactivated', commit: { id: commitOf(100 + i) }, finishedAt: '2030-01-09T00:00:00.000Z' })));
    const names = [many];
    const others = Array.from({ length: 3 }, () => service('budget'));
    others.forEach((other, n) => outside.deploys.set(other, Array.from({ length: 10 }, (_, i) => ({ id: `dep-${newId()}`, status: 'deactivated', commit: { id: commitOf(200 + n * 20 + i) }, finishedAt: '2030-01-09T00:00:00.000Z' }))));
    names.push(...others);
    const big = await pass(outside, configOf(names.map(s => ({ app: 'pos' as const, service: s }))));
    expect(big.recorded).toBe(40);
    expect(big.ciReads).toBe(RELEASE_FEED_CI_READS_PER_PASS);
  });
});

describe('a conflicting identity', () => {
  it('is refused: the first record stands, nothing is written, and the id is reported', async () => {
    const outside = new Outside();
    const name = service('conflict');
    const id = `dep-${newId()}`;
    const finishedAt = '2030-01-10T00:00:00.000Z';
    const config = configOf([{ app: 'pos', service: name }]);
    outside.deploys.set(name, [{ id, status: 'live', commit: { id: commitOf(14) }, finishedAt }]);
    await pass(outside, config);
    const [first] = await rowsOf(name);

    for (const changed of [
      { id, status: 'live', commit: { id: commitOf(15) }, finishedAt },
      { id, status: 'update_failed', commit: { id: commitOf(14) }, finishedAt },
      { id, status: 'live', commit: { id: commitOf(14) }, finishedAt: '2030-01-10T09:00:00.000Z' },
    ]) {
      outside.deploys.set(name, [changed]);
      const summary = await pass(outside, config);
      expect(summary).toMatchObject({ recorded: 0, replayed: 0, conflicts: [id] });
    }
    // The same deployment filed under another app or service is another identity claim, and also refused.
    outside.deploys.set(name, [{ id, status: 'live', commit: { id: commitOf(14) }, finishedAt }]);
    expect((await pass(outside, configOf([{ app: 'console', service: name }]))).conflicts).toEqual([id]);

    expect(await rowsOf(name)).toEqual([first]);
    expect(await auditsOf([first!.id])).toHaveLength(1);
  });

  it('holds at the database as well, and a person’s row is untouched by the pair rule', async () => {
    const dup = { app: 'pos' as const, status: 'live', service: 'zz', source: 'render', sourceEventId: `dep-${newId()}` };
    await ctx.db.insert(deployEvent).values({ id: newId(), ...dup });
    await expect(ctx.db.insert(deployEvent).values({ id: newId(), ...dup })).rejects.toThrow();
    await expect(ctx.db.insert(deployEvent).values({ id: newId(), app: 'pos', status: 'live', source: 'render' })).rejects.toThrow();
    const twoPeople = { app: 'pos' as const, status: 'live' };
    await ctx.db.insert(deployEvent).values([{ id: newId(), ...twoPeople }, { id: newId(), ...twoPeople }]);
  });

  it('leaves the Console’s own deploy-event writer exactly as it was', async () => {
    const event = { id: newId(), app: 'pos', status: 'live', version: null, commit: 'abc1234', ciGreen: null, deployedAt: null };
    const post = (payload: unknown, key = newId()) => ctx.app.inject({ method: 'POST', url: '/console/deploy-events', headers: { cookie: admin, 'idempotency-key': key }, payload: payload as never });
    expect((await post(event)).json()).toEqual({ id: event.id, replay: false });
    expect((await post(event)).json()).toEqual({ id: event.id, replay: true });
    expect((await post({ ...event, status: 'failed' })).json().error.code).toBe('DEPLOY_EVENT_CONFLICT');
    const [row] = await ctx.db.select().from(deployEvent).where(eq(deployEvent.id, event.id));
    expect(row).toMatchObject({ service: null, source: null, sourceEventId: null, finishedAt: null });
    const reception = await signInAs(ctx.app, RECEPTION.phone, RECEPTION.password);
    expect((await ctx.app.inject({ method: 'GET', url: '/console/releases', headers: { cookie: reception } })).statusCode).toBe(403);
  });
});

describe('a provider that fails', () => {
  it('fails one service, not the pass, and recovers on the next', async () => {
    const outside = new Outside();
    const up = service('up'), down = service('down'), absent = service('absent');
    outside.deploys.set(up, [{ id: `dep-${newId()}`, status: 'live', commit: { id: commitOf(16) }, finishedAt: '2030-01-11T00:00:00.000Z' }]);
    outside.deploys.set(down, [{ id: `dep-${newId()}`, status: 'live', commit: { id: commitOf(17) }, finishedAt: '2030-01-11T00:00:00.000Z' }]);
    outside.servicesDown.add(down);
    const config = configOf([{ app: 'pos', service: down }, { app: 'pos', service: absent }, { app: 'pos', service: up }]);
    const summary = await pass(outside, config);
    expect(summary).toMatchObject({ services: 3, servicesFailed: [down, absent], recorded: 1 });
    expect(await rowsOf(down)).toEqual([]);
    outside.servicesDown.delete(down);
    expect((await pass(outside, config)).recorded).toBe(1);
    expect(await rowsOf(down)).toHaveLength(1);
  });

  it('skips a row it cannot read and keeps the rest', async () => {
    const outside = new Outside();
    const name = service('badrow');
    const fetcher: FeedFetch = async (url, init) => url.includes('/deploys')
      ? { status: 200, text: async () => JSON.stringify([{ nope: true }, { deploy: { id: `dep-${newId()}`, status: 'live', commit: { id: commitOf(18) }, finishedAt: '2030-01-12T00:00:00.000Z' } }]) }
      : outside.fetch(url, init);
    outside.deploys.set(name, []);
    const summary = await observeDeployments(ctx.db, { config: configOf([{ app: 'pos', service: name }]), fetch: fetcher, log });
    expect(summary).toMatchObject({ unreadableRows: 1, recorded: 1 });
  });

  it('holds together when a provider throws or sends something unreadable', async () => {
    const name = service('throws');
    const throwing: FeedFetch = async () => { throw new Error(`socket closed for ${RENDER_KEY}`); };
    const a = await observeDeployments(ctx.db, { config: configOf([{ app: 'pos', service: name }]), fetch: throwing, log });
    expect(a).toMatchObject({ servicesFailed: [name], recorded: 0 });
    const garbage: FeedFetch = async () => ({ status: 200, text: async () => '<html>not json</html>' });
    const b = await observeDeployments(ctx.db, { config: configOf([{ app: 'pos', service: name }]), fetch: garbage, log });
    expect(b).toMatchObject({ servicesFailed: [name], recorded: 0 });
  });
});

describe('what the feed may do', () => {
  it('only GETs Render and GitHub, refuses redirects, and sends each credential to its own host alone', async () => {
    const outside = new Outside();
    const name = service('calls');
    outside.deploys.set(name, [{ id: `dep-${newId()}`, status: 'live', commit: { id: commitOf(19) }, finishedAt: '2030-01-13T00:00:00.000Z' }]);
    await pass(outside, configOf([{ app: 'pos', service: name }], GITHUB_TOKEN));
    expect(new Set(outside.calls.map(c => c.method))).toEqual(new Set(['GET']));
    expect(new Set(outside.calls.map(c => c.redirect))).toEqual(new Set(['error']));
    expect(outside.calls.length).toBe(3);
    for (const call of outside.calls) {
      const host = new URL(call.url).host;
      expect(['api.render.com', 'api.github.com']).toContain(host);
      expect(call.headers.authorization).toBe(host === 'api.render.com' ? `Bearer ${RENDER_KEY}` : `Bearer ${GITHUB_TOKEN}`);
      expect(call.url).not.toContain(RENDER_KEY);
      expect(call.url).not.toContain(GITHUB_TOKEN);
    }
    // With no token the public repository is read anonymously.
    const anonymous = new Outside();
    const other = service('anon');
    anonymous.deploys.set(other, [{ id: `dep-${newId()}`, status: 'live', commit: { id: commitOf(20) }, finishedAt: '2030-01-13T00:00:00.000Z' }]);
    await pass(anonymous, configOf([{ app: 'pos', service: other }]));
    expect(anonymous.calls.find(c => c.url.includes('api.github.com'))!.headers.authorization).toBeUndefined();
    // And no deploy, cancel or rollback path exists to call.
    const source = readFileSync(new URL('../src/services/release-feed.ts', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    expect(source).not.toMatch(/'(POST|PUT|PATCH|DELETE)'/);
    expect(source).not.toMatch(/\/cancel|\/rollback|\/suspend|\/resume/);
    expect([...source.matchAll(/\bfetcher\(/g)]).toHaveLength(1);
  });

  it('never lets a secret reach a log, a run’s detail, a record or an audit row', async () => {
    logLines.length = 0;
    const outside = new Outside();
    const name = service('secrets');
    const down = service('secrets-down');
    const sha = commitOf(21);
    outside.deploys.set(name, [{ id: `dep-${newId()}`, status: 'live', commit: { id: sha }, finishedAt: '2030-01-14T00:00:00.000Z' }]);
    outside.checks.set(sha, 500);
    outside.servicesDown.add(down);
    const throwing: FeedFetch = async (url, init) => {
      if (url.includes('zz-secrets-down')) throw new Error(`boom ${JSON.stringify(init.headers)}`);
      return outside.fetch(url, init);
    };
    const summary = await observeDeployments(ctx.db, { config: configOf([{ app: 'pos', service: down }, { app: 'pos', service: name }], GITHUB_TOKEN), fetch: throwing, log });
    expect(summary.servicesFailed).toEqual([down]);
    const [row] = await rowsOf(name);
    const written = JSON.stringify({ logLines, summary, row, audits: await auditsOf([row!.id]) });
    expect(logLines.length).toBeGreaterThan(0);
    expect(written).not.toContain(RENDER_KEY);
    expect(written).not.toContain(GITHUB_TOKEN);
    expect(written).not.toContain('Bearer');
  });
});

describe('the job', () => {
  const runCtx = () => ({ db: ctx.db, env: ctx.app.env, log, now: new Date() });

  it('does not exist until its key is set, so an unconfigured deployment keeps an empty history', () => {
    expect(buildReleaseFeedJobs({ log }, {})).toEqual([]);
    expect(buildReleaseFeedJobs({ log }, { RELEASE_FEED_RENDER_API_KEY: '   ', RELEASE_FEED_SERVICES: 'pos=x' })).toEqual([]);
    expect(releaseFeedConfigOf({ RELEASE_FEED_SERVICES: 'pos=x' })).toBeNull();
    const names = buildDefaultJobs({ db: ctx.db, env: ctx.app.env, log, channels: [] }).map(job => job.name);
    expect(names).not.toContain(RELEASE_FEED_JOB);
  });

  it('reads its settings by name: an app may hold several services, and a bad list fails the run, never the boot', async () => {
    expect(releaseFeedConfigOf({ RELEASE_FEED_RENDER_API_KEY: ' k ', RELEASE_FEED_SERVICES: ' pos=oto-api-staging , pos=oto-pos-web-staging,oto_app=oto-app-staging ', RELEASE_FEED_GITHUB_TOKEN: ' ' })).toEqual({
      renderApiKey: 'k', githubToken: null,
      services: [{ app: 'pos', service: 'oto-api-staging' }, { app: 'pos', service: 'oto-pos-web-staging' }, { app: 'oto_app', service: 'oto-app-staging' }],
    });
    for (const list of [undefined, '', 'nonsense', 'launcher=oto-launcher-staging', 'pos=', 'pos=a b']) {
      const [job] = buildReleaseFeedJobs({ log }, { RELEASE_FEED_RENDER_API_KEY: RENDER_KEY, RELEASE_FEED_SERVICES: list });
      const failure = await job!.run(runCtx()).then(() => null, (err: unknown) => err);
      expect(failure, String(list)).toBeInstanceOf(JobFailedError);
      expect((failure as JobFailedError).code).toBe('RELEASE_FEED_CONFIG');
      expect((failure as JobFailedError).message).toContain('RELEASE_FEED_SERVICES');
      expect((failure as JobFailedError).message).not.toContain(RENDER_KEY);
    }
  });

  it('runs a pass, returning counts; fails when no service could be read, without its key in the failure', async () => {
    const outside = new Outside();
    const name = service('job');
    outside.deploys.set(name, [{ id: `dep-${newId()}`, status: 'live', commit: { id: commitOf(22) }, finishedAt: '2030-01-15T00:00:00.000Z' }]);
    const raw = { RELEASE_FEED_RENDER_API_KEY: RENDER_KEY, RELEASE_FEED_SERVICES: `pos=${name}` };
    const [job] = buildReleaseFeedJobs({ log, releaseFeedFetch: outside.fetch }, raw);
    expect(job).toMatchObject({ name: RELEASE_FEED_JOB, intervalSeconds: 300 });
    const result = await job!.run(runCtx());
    expect(result).toMatchObject({ detail: { recorded: 1, servicesFailed: [] } });
    expect(await rowsOf(name)).toHaveLength(1);

    outside.servicesDown.add(name);
    const failure = await job!.run(runCtx()).then(() => null, (err: unknown) => err);
    expect((failure as JobFailedError).code).toBe('RELEASE_FEED_UNREADABLE');
    expect(JSON.stringify((failure as JobFailedError).detail)).not.toContain(RENDER_KEY);
    expect((failure as JobFailedError).message).not.toContain(RENDER_KEY);
  });

  it('fails the run when part of it could not be done, keeping what it recorded and saying what it could not', async () => {
    const outside = new Outside();
    const up = service('part'), down = service('part-down');
    const id = `dep-${newId()}`;
    outside.deploys.set(up, [{ id, status: 'live', commit: { id: commitOf(23) }, finishedAt: '2030-01-16T00:00:00.000Z' }]);
    outside.servicesDown.add(down);
    const raw = { RELEASE_FEED_RENDER_API_KEY: RENDER_KEY, RELEASE_FEED_SERVICES: `pos=${down},pos=${up}` };
    const [job] = buildReleaseFeedJobs({ log, releaseFeedFetch: outside.fetch }, raw);
    const failure = await job!.run(runCtx()).then(() => null, (err: unknown) => err) as JobFailedError;
    expect(failure.code).toBe('RELEASE_FEED_UNREADABLE');
    expect(failure.message).toContain(down);
    expect(failure.detail).toMatchObject({ recorded: 1, servicesFailed: [down] });
    expect(await rowsOf(up)).toHaveLength(1);

    // A deployment Render now reports differently: refused, and said out loud rather than left in a count.
    outside.servicesDown.delete(down);
    outside.deploys.set(down, []);
    outside.deploys.set(up, [{ id, status: 'live', commit: { id: commitOf(24) }, finishedAt: '2030-01-16T00:00:00.000Z' }]);
    const conflict = await job!.run(runCtx()).then(() => null, (err: unknown) => err) as JobFailedError;
    expect(conflict.code).toBe('RELEASE_FEED_CONFLICT');
    expect(conflict.message).toContain(id);
    expect((await rowsOf(up))[0]!.commit).toBe(commitOf(23));
  });
});
