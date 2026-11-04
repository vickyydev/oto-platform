import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import { z } from 'zod';
import { appRegistry, deployEvent, SUITE_APP_KEYS, type Db, type SuiteAppKey } from '@oto/db';
import { newId } from '@oto/shared';
import { audit } from './audit';
import { JobFailedError } from './job-failure';
import type { JobDefinition, JobDeps } from './jobs';
import { withTx, type Tx } from './tx';

/**
 * SCRUM-672 — THE RELEASE FEED: what the Console's Releases page was waiting for.
 *
 * WHERE IT RUNS, AND WHY THERE. In the api's own job runner, as one more timer
 * on a process that already exists: no new service, no webhook endpoint, no
 * write credential. The other ways in were each worse:
 *
 *   - a step in CI cannot know: Render deploys after the commit's checks pass
 *     (`autoDeployTrigger: checksPass`), so a step that waited for the deploy
 *     would itself be a check holding the deploy back, and a green build is
 *     not a completed deployment. It would also put a key to the Render
 *     workspace in reach of anyone who can push a workflow file, which
 *     `.github/workflows/ci.yml` says in as many words is why there is none;
 *   - Render's webhooks need a higher plan, and their deploy event carries no
 *     commit, so they would still need this read and add a public endpoint;
 *   - a service reporting itself sees neither a failed deploy nor a static site.
 *
 * WHAT IT DOES. Reads each configured service's recent deployments from Render,
 * reads the commit's check runs from GitHub, and records each deployment that
 * has ENDED, once. It only ever GETs (`get` below is the one place it reaches
 * out and the method there is a literal), so it cannot start, cancel or roll
 * back anything, and it holds no credential that the Console or a person can
 * reach.
 *
 * WHAT IT WILL NOT SAY. Nothing is inferred:
 *   - STATUS is Render's. `live` is a deployment that went live; Render later
 *     calls the same deployment `deactivated` when a newer one replaces it,
 *     which is the same fact, so it is recorded as `live` at its own finish
 *     time either way. A deployment that ended any other way keeps Render's
 *     word for it and has no `deployedAt`. One still in progress is not recorded.
 *   - COMMIT is the exact forty characters or nothing.
 *   - CI is what GitHub says of that commit's check runs: true when every run
 *     completed well, false when any completed badly, and null, unknown, when
 *     there are none, one is still going, or GitHub could not be read. A
 *     deployment that happened does not make its build green, and a green
 *     build does not make a deployment. A later pass may fill a null in; it
 *     never changes a result already recorded.
 *
 * IDENTITY. Render's deployment id, under `source = 'render'`, with a unique
 * index beneath it: however often a deployment is read, or from however many
 * instances, it is one row. Read again with different facts it is a conflict:
 * refused, counted, the first record standing.
 *
 * SECRETS. The Render key and the GitHub token live in this file's closures for
 * one pass. They go in an Authorization header and nowhere else, redirects are
 * refused so neither follows a response anywhere, and a failure is recorded as
 * the service and the status code, never a body or a header.
 */

export const RELEASE_FEED_JOB = 'job:release.feed';
export const RELEASE_FEED_INTERVAL_S = 300;
export const RELEASE_FEED_SOURCE = 'render';
/** How far back a pass reads each service: comfortably more than deploy per five minutes, and what bounds a late CI fill. */
export const RELEASE_FEED_LOOKBACK = 10;
/** GitHub's anonymous allowance is 60 an hour per address, and a host's address is shared. */
export const RELEASE_FEED_CI_READS_PER_PASS = 20;
const TIMEOUT_MS = 10_000;
const RENDER_API = 'https://api.render.com/v1';
const GITHUB_API = 'https://api.github.com';

export interface ReleaseFeedConfig {
  renderApiKey: string;
  /** Which Render service files under which suite app. An app may have more than one. */
  services: { app: SuiteAppKey; service: string }[];
  /** Optional: the repository is public, so this only lifts the anonymous rate limit. */
  githubToken: string | null;
}

export class ReleaseFeedConfigError extends Error {}

/**
 * Off (null) until its key is set. A key with an unusable service list is not
 * off: the job runs and fails with this, by the variable's name, on the
 * Failures page, rather than a typo stopping the api from booting.
 */
export function releaseFeedConfigOf(raw: Record<string, string | undefined>): ReleaseFeedConfig | null {
  const renderApiKey = raw.RELEASE_FEED_RENDER_API_KEY?.trim();
  if (!renderApiKey) return null;
  const services: ReleaseFeedConfig['services'] = [];
  for (const entry of (raw.RELEASE_FEED_SERVICES ?? '').split(',').map((e) => e.trim()).filter(Boolean)) {
    const match = /^([a-z_]+)=([A-Za-z0-9._-]+)$/.exec(entry);
    const app = match?.[1] as SuiteAppKey | undefined;
    if (!match || !app || !SUITE_APP_KEYS.includes(app)) {
      throw new ReleaseFeedConfigError(`RELEASE_FEED_SERVICES: "${entry}" is not <app>=<render service name>, with app one of ${SUITE_APP_KEYS.join(', ')}`);
    }
    services.push({ app, service: match[2]! });
  }
  if (services.length === 0) throw new ReleaseFeedConfigError('RELEASE_FEED_SERVICES: at least one <app>=<render service name> is required');
  return { renderApiKey, services, githubToken: raw.RELEASE_FEED_GITHUB_TOKEN?.trim() || null };
}

// --- Reading -----------------------------------------------------------------

/** The narrow slice of `fetch` this file uses, so a test supplies the whole outside world. */
export type FeedFetch = (url: string, init: {
  method: 'GET'; headers: Record<string, string>; redirect: 'error'; signal: AbortSignal;
}) => Promise<{ status: number; text(): Promise<string> }>;

class ReadFailed extends Error {
  constructor(readonly status: number | null) {
    super('a release feed read failed');
    this.name = 'ReadFailed';
  }
}

async function get(fetcher: FeedFetch, url: string, headers: Record<string, string>): Promise<unknown> {
  let status: number;
  let text: string;
  try {
    const res = await fetcher(url, { method: 'GET', headers, redirect: 'error', signal: AbortSignal.timeout(TIMEOUT_MS) });
    status = res.status;
    text = await res.text();
  } catch {
    // Nothing of the thrown value is read: a client error can carry the URL and the headers.
    throw new ReadFailed(null);
  }
  if (status !== 200) throw new ReadFailed(status);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new ReadFailed(status);
  }
}

/** Only what this reads; every other field Render or GitHub sends is passed over, today's or tomorrow's. */
const ServiceList = z.array(z.object({ service: z.object({ id: z.string().min(1), name: z.string(), repo: z.string().nullish() }).passthrough() }).passthrough());
const DeployRow = z.object({
  deploy: z.object({
    id: z.string().min(1),
    status: z.string().min(1),
    commit: z.object({ id: z.string().nullish() }).passthrough().nullish(),
    finishedAt: z.string().nullish(),
  }).passthrough(),
}).passthrough();
const CheckRuns = z.object({
  total_count: z.number().int(),
  check_runs: z.array(z.object({ status: z.string(), conclusion: z.string().nullish() }).passthrough()),
}).passthrough();

const FULL_COMMIT = /^[0-9a-f]{40}$/;
const GITHUB_REPO = /^https:\/\/github\.com\/([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?$/;

/** Render's words for a deployment that went live: `deactivated` is one a newer deployment has since replaced. */
const WENT_LIVE: ReadonlySet<string> = new Set(['live', 'deactivated']);
/** Render's words for one that ended without going live. Anything else is still going, or a word this does not know yet. */
const ENDED_OTHERWISE: ReadonlySet<string> = new Set(['build_failed', 'update_failed', 'pre_deploy_failed', 'canceled']);
const STILL_GOING: ReadonlySet<string> = new Set(['created', 'queued', 'build_in_progress', 'update_in_progress', 'pre_deploy_in_progress']);
const WELL: ReadonlySet<string> = new Set(['success', 'skipped', 'neutral']);

/** GitHub's check runs as one answer: unknown unless every run has finished and the list is whole. */
export function ciResultOf(body: z.infer<typeof CheckRuns>): boolean | null {
  const runs = body.check_runs;
  if (runs.length === 0 || runs.length < body.total_count) return null;
  if (runs.some((run) => run.status !== 'completed')) return null;
  return runs.every((run) => WELL.has(run.conclusion ?? ''));
}

const instant = (value: string | null | undefined): Date | null => {
  if (!value) return null;
  const at = new Date(value);
  return Number.isNaN(at.getTime()) ? null : at;
};

// --- Recording ---------------------------------------------------------------

export interface ObservedDeployment {
  app: SuiteAppKey;
  service: string;
  sourceEventId: string;
  status: string;
  commit: string | null;
  ciGreen: boolean | null;
  deployedAt: Date | null;
  finishedAt: Date | null;
}

export type ObservedOutcome = 'recorded' | 'replay' | 'ci_filled' | 'conflict' | 'unknown_app';

const same = (a: Date | null, b: Date | null) => (a?.getTime() ?? null) === (b?.getTime() ?? null);

/**
 * One deployment, once. The first read writes the row and its audit row; a
 * repeat with the same facts writes nothing, except that a CI result still
 * unknown may be filled in, audited; a repeat with different facts writes
 * nothing and answers `conflict`.
 */
export async function recordObservedDeployment(tx: Tx, ctx: { requestId?: string }, input: ObservedDeployment): Promise<ObservedOutcome> {
  const [app] = await tx.select({ key: appRegistry.key }).from(appRegistry)
    .where(and(eq(appRegistry.key, input.app), isNull(appRegistry.archivedAt))).for('share');
  if (!app) return 'unknown_app';
  const values = {
    app: input.app, service: input.service, source: RELEASE_FEED_SOURCE, sourceEventId: input.sourceEventId, status: input.status,
    commit: input.commit, ciGreen: input.ciGreen, deployedAt: input.deployedAt, finishedAt: input.finishedAt,
  };
  const [inserted] = await tx.insert(deployEvent).values({ id: newId(), actorAccountId: null, version: null, ...values })
    .onConflictDoNothing({ target: [deployEvent.source, deployEvent.sourceEventId], where: sql`${deployEvent.sourceEventId} is not null` })
    .returning();
  if (inserted) {
    await audit.record(tx, {
      actorAccountId: null, operatorId: null, action: 'deploy_event.record', entityType: 'deploy_event', entityId: inserted.id,
      requestId: ctx.requestId ?? null, targetApp: input.app, origin: 'job',
      after: { ...values, deployedAt: input.deployedAt?.toISOString() ?? null, finishedAt: input.finishedAt?.toISOString() ?? null },
    });
    return 'recorded';
  }
  const [existing] = await tx.select().from(deployEvent)
    .where(and(eq(deployEvent.source, RELEASE_FEED_SOURCE), eq(deployEvent.sourceEventId, input.sourceEventId))).for('update');
  if (!existing) throw new Error('a deploy event that conflicted is gone');
  const agrees = existing.app === input.app && existing.service === input.service && existing.status === input.status
    && existing.commit === input.commit && same(existing.deployedAt, input.deployedAt) && same(existing.finishedAt, input.finishedAt);
  if (!agrees) return 'conflict';
  if (existing.ciGreen !== null || input.ciGreen === null) return 'replay';
  await tx.update(deployEvent).set({ ciGreen: input.ciGreen, updatedAt: new Date() }).where(eq(deployEvent.id, existing.id));
  await audit.record(tx, {
    actorAccountId: null, operatorId: null, action: 'deploy_event.ci_observed', entityType: 'deploy_event', entityId: existing.id,
    requestId: ctx.requestId ?? null, targetApp: input.app, origin: 'job', before: { ciGreen: null }, after: { ciGreen: input.ciGreen },
  });
  return 'ci_filled';
}

// --- One pass ----------------------------------------------------------------

export interface ReleaseFeedSummary extends Record<string, unknown> {
  services: number;
  servicesFailed: string[];
  deploymentsRead: number;
  recorded: number;
  replayed: number;
  ciFilled: number;
  conflicts: string[];
  unknownApps: number;
  stillGoing: number;
  /** Render statuses this does not know: not recorded, and listed so they are seen. */
  unknownStatuses: string[];
  unreadableRows: number;
  ciReads: number;
  ciReadsFailed: number;
}

export async function observeDeployments(db: Db, deps: {
  config: ReleaseFeedConfig;
  fetch?: FeedFetch;
  log?: FastifyBaseLogger;
}): Promise<ReleaseFeedSummary> {
  const { config, log } = deps;
  const fetcher: FeedFetch = deps.fetch ?? (async (url, init) => globalThis.fetch(url, init));
  const renderHeaders = { authorization: `Bearer ${config.renderApiKey}`, accept: 'application/json' };
  const githubHeaders = {
    accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'user-agent': 'oto-platform-release-feed',
    ...(config.githubToken ? { authorization: `Bearer ${config.githubToken}` } : {}),
  };
  const summary: ReleaseFeedSummary = {
    services: config.services.length, servicesFailed: [], deploymentsRead: 0, recorded: 0, replayed: 0, ciFilled: 0, conflicts: [],
    unknownApps: 0, stillGoing: 0, unknownStatuses: [], unreadableRows: 0, ciReads: 0, ciReadsFailed: 0,
  };
  const ciByCommit = new Map<string, boolean | null>();
  let ciStopped = false;

  /** Read once per commit in a pass; after a refusal the rest of the pass leaves CI unknown. */
  const ciOf = async (repo: { owner: string; name: string } | null, commit: string | null): Promise<boolean | null> => {
    if (!commit || !repo) return null;
    if (ciByCommit.has(commit)) return ciByCommit.get(commit)!;
    if (ciStopped || summary.ciReads >= RELEASE_FEED_CI_READS_PER_PASS) return null;
    summary.ciReads += 1;
    try {
      const body = CheckRuns.parse(await get(fetcher, `${GITHUB_API}/repos/${repo.owner}/${repo.name}/commits/${commit}/check-runs?per_page=100`, githubHeaders));
      const result = ciResultOf(body);
      ciByCommit.set(commit, result);
      return result;
    } catch (err) {
      summary.ciReadsFailed += 1;
      const status = err instanceof ReadFailed ? err.status : null;
      if (status === 403 || status === 429) ciStopped = true;
      log?.warn({ status }, 'the release feed could not read a commit’s checks');
      return null;
    }
  };

  for (const { app, service } of config.services) {
    let rows: unknown;
    let repo: { owner: string; name: string } | null = null;
    let serviceId: string;
    try {
      const listed = ServiceList.parse(await get(fetcher, `${RENDER_API}/services?name=${encodeURIComponent(service)}&limit=20`, renderHeaders));
      const found = listed.map((row) => row.service).find((s) => s.name === service);
      if (!found) throw new ReadFailed(404);
      serviceId = found.id;
      const repoMatch = GITHUB_REPO.exec(found.repo ?? '');
      if (repoMatch) repo = { owner: repoMatch[1]!, name: repoMatch[2]! };
      rows = await get(fetcher, `${RENDER_API}/services/${encodeURIComponent(serviceId)}/deploys?limit=${RELEASE_FEED_LOOKBACK}`, renderHeaders);
      if (!Array.isArray(rows)) throw new ReadFailed(200);
    } catch (err) {
      summary.servicesFailed.push(service);
      log?.warn({ service, status: err instanceof ReadFailed ? err.status : null }, 'the release feed could not read a service’s deployments');
      continue;
    }

    // Oldest first, so a first pass records a service's history in the order it happened.
    const deployments = (rows as unknown[]).map((row) => DeployRow.safeParse(row));
    summary.unreadableRows += deployments.filter((row) => !row.success).length;
    const readable = deployments.flatMap((row) => (row.success ? [row.data.deploy] : [])).reverse();
    summary.deploymentsRead += readable.length;

    // A deployment whose CI is already known costs no GitHub read.
    const known = readable.length === 0 ? [] : await db.select({ id: deployEvent.sourceEventId, ciGreen: deployEvent.ciGreen }).from(deployEvent)
      .where(and(eq(deployEvent.source, RELEASE_FEED_SOURCE), inArray(deployEvent.sourceEventId, readable.map((d) => d.id))));
    const knownCi = new Map(known.map((row) => [row.id, row.ciGreen]));

    for (const deploy of readable) {
      const wentLive = WENT_LIVE.has(deploy.status);
      if (!wentLive && !ENDED_OTHERWISE.has(deploy.status)) {
        if (STILL_GOING.has(deploy.status)) summary.stillGoing += 1;
        else if (!summary.unknownStatuses.includes(deploy.status)) summary.unknownStatuses.push(deploy.status.slice(0, 40));
        continue;
      }
      const commit = deploy.commit?.id && FULL_COMMIT.test(deploy.commit.id) ? deploy.commit.id : null;
      const seenCi = knownCi.get(deploy.id);
      const ciGreen = seenCi === true || seenCi === false ? seenCi : await ciOf(repo, commit);
      const finishedAt = instant(deploy.finishedAt);
      const outcome = await withTx(db, {}, 'deploy_event.observe', (tx) => recordObservedDeployment(tx, {}, {
        app, service, sourceEventId: deploy.id, status: wentLive ? 'live' : deploy.status, commit, ciGreen,
        deployedAt: wentLive ? finishedAt : null, finishedAt,
      }));
      if (outcome === 'recorded') summary.recorded += 1;
      else if (outcome === 'replay') summary.replayed += 1;
      else if (outcome === 'ci_filled') summary.ciFilled += 1;
      else if (outcome === 'unknown_app') summary.unknownApps += 1;
      else summary.conflicts.push(deploy.id);
    }
  }
  if (summary.conflicts.length > 0) log?.warn({ conflicts: summary.conflicts }, 'the release feed refused deployments that disagree with their record');
  return summary;
}

// --- The job -----------------------------------------------------------------

/**
 * Registered only once its key is set: a deployment without one keeps an empty
 * history, which the page says plainly, and no job that can never succeed.
 */
export function buildReleaseFeedJobs(
  deps: Pick<JobDeps, 'log'> & { releaseFeedFetch?: FeedFetch },
  raw: Record<string, string | undefined> = process.env,
): JobDefinition[] {
  if (!raw.RELEASE_FEED_RENDER_API_KEY?.trim()) return [];
  return [{
    name: RELEASE_FEED_JOB,
    description: 'Records each finished deployment of the configured Render services in the Console’s release history, with its exact commit, CI result and time. Reads only: it can start nothing.',
    intervalSeconds: RELEASE_FEED_INTERVAL_S,
    severity: 'warning',
    run: async ({ db, log }) => {
      let config: ReleaseFeedConfig | null;
      try {
        config = releaseFeedConfigOf(raw);
      } catch (err) {
        if (err instanceof ReleaseFeedConfigError) throw new JobFailedError('RELEASE_FEED_CONFIG', err.message, {});
        throw err;
      }
      if (!config) return { detail: { off: true } };
      const summary = await observeDeployments(db, { config, log, ...(deps.releaseFeedFetch ? { fetch: deps.releaseFeedFetch } : {}) });
      // What the pass did read is recorded either way; the run says what it could not do, on the Failures page.
      if (summary.servicesFailed.length > 0) {
        throw new JobFailedError('RELEASE_FEED_UNREADABLE', `Render could not be read for ${summary.servicesFailed.join(', ')}.`, summary);
      }
      if (summary.conflicts.length > 0) {
        throw new JobFailedError('RELEASE_FEED_CONFLICT', `Render reports ${summary.conflicts.join(', ')} differently from the recorded deployment; the record stands.`, summary);
      }
      return { detail: summary };
    },
  }];
}
