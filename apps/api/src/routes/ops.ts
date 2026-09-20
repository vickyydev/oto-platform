import { z } from 'zod';
import type { FastifyRequest } from 'fastify';
import { OPS_KINDS } from '@oto/db';
import type { App } from '../app';
import { errors } from '../lib/errors';
import { audit } from '../services/audit';
import { opCtx, withTx } from '../services/tx';
import { isPlatformWide } from '../services/permissions';
import { DEMO_RESET_CONFIRMATION, resetDemoData } from '../services/demo-reset';
import { createJobRunner, WATCHDOG_JOB, type JobRunner } from '../services/jobs';
import { boxSettings, virtualBoxAgent } from '../services/box';
import {
  acknowledgeAlert,
  buildAlertChannels,
  deliverAlert,
  failureGroups,
  findRun,
  healthSnapshot,
  integrationsSnapshot,
  raiseAlert,
  recordRun,
  runsForFingerprint,
} from '../services/ops';

/**
 * What the Console reads about how the platform is running (S2-03), and the
 * operational controls a staging deployment offers (S2-01c).
 *
 * The read routes are guarded by `admin:health:read` and answer with names,
 * states and counts only. Whoever is on call reads these pages on a screen in
 * a back office: no phone, no child's note, no credential and no part of one
 * reaches them — not a masked key, not a key's length.
 *
 * The controls keep the two gates the demo reset already had, both required.
 * `OPS_TEST_CONTROLS` is the DEPLOYMENT saying it is a playground, and the
 * platform-wide assignment is the CALLER saying who they are; neither
 * substitutes for the other, so a control simply does not exist on production
 * even for the platform admin who built it.
 */
export async function opsRoutes(app: App): Promise<void> {
  const requirePlatform = async (req: FastifyRequest) => {
    const auth = req.requireAuth();
    if (!app.env.OPS_TEST_CONTROLS) {
      throw errors.forbidden('Operational test controls are off on this deployment');
    }
    const effective = await req.effectivePermissions();
    if (!isPlatformWide(effective)) throw errors.forbidden('Platform administrator only');
    return auth;
  };

  /**
   * A runner for the things a person presses — running a job now, retrying
   * one. Built on first use rather than at registration: constructing it
   * validates `ALERT_CHANNELS`, and a route file is not where a deployment
   * should discover that its configuration is wrong.
   *
   * It starts no timers. Whether it may run anything at all is `PROCESS_ROLES`
   * on THIS process, and the advisory-lock claim in `services/jobs.ts` is what
   * keeps a pressed button from colliding with the schedule or with another
   * instance. Nothing on the read side uses it: the Health page reads the
   * register from the database precisely so an instance without the jobs role
   * still answers correctly.
   */
  let runner: JobRunner | null = null;
  const jobRunner = (): JobRunner =>
    (runner ??= createJobRunner({ db: app.db, env: app.env, log: app.log }));

  const health = () => ({
    db: app.db,
    watchdogJob: WATCHDOG_JOB,
    watchdogIntervalSeconds: app.env.WATCHDOG_INTERVAL_S,
    failureThreshold: app.env.ALERT_FAILURE_THRESHOLD,
  });

  // --- Health -------------------------------------------------------------

  app.get(
    '/health',
    {
      config: { permission: 'admin:health:read' },
      schema: {
        description:
          'Dependency checks, the job register, every box with its devices, and open alerts — read from the database, not from this process',
      },
    },
    async (req) => {
      const auth = req.requireAuth();
      return healthSnapshot({ ...health(), operatorId: auth.operatorId });
    },
  );

  app.post(
    '/alerts/:alertId/acknowledge',
    {
      config: { permission: 'admin:ops:manage' },
      schema: {
        description: 'Take an alert — says somebody is on it, and never that it is resolved',
        params: z.object({ alertId: z.string().uuid() }),
      },
    },
    async (req) => {
      const auth = req.requireAuth();
      return withTx(app.db, opCtx(req), 'ops.alert_acknowledge', async (tx) => {
        const taken = await acknowledgeAlert(tx, req.params.alertId, auth.accountId);
        // Gone, already resolved, or already taken by somebody else — none of
        // which is an error worth a stack trace, and all of which the page
        // fixes by refreshing.
        if (!taken) throw errors.notFound('That alert is not open and unacknowledged');
        await audit.record(tx, {
          actorAccountId: auth.accountId,
          operatorId: auth.operatorId,
          branchId: auth.branchId,
          action: 'ops.alert_acknowledge',
          entityType: 'alert',
          entityId: taken.id,
          after: { key: taken.key },
          requestId: req.id,
        });
        return { ok: true as const };
      });
    },
  );

  // --- Failures -----------------------------------------------------------

  app.get(
    '/failures',
    {
      config: { permission: 'admin:health:read' },
      schema: {
        description: 'Runs that failed in the window, grouped by fingerprint, newest first',
        querystring: z.object({
          /** The page offers an hour, a day and a week; the cap is the
           *  retention window, past which there is nothing to find. */
          windowHours: z.coerce.number().int().min(1).max(24 * 90).default(24),
          kind: z.enum(OPS_KINDS).optional(),
          cursor: z.string().max(200).optional(),
          limit: z.coerce.number().int().min(1).max(200).default(50),
        }),
      },
    },
    async (req) => {
      const auth = req.requireAuth();
      return failureGroups(app.db, { ...req.query, operatorId: auth.operatorId });
    },
  );

  app.get(
    '/runs',
    {
      config: { permission: 'admin:health:read' },
      schema: {
        description: 'The individual runs behind one fingerprint, newest first',
        querystring: z.object({
          fingerprint: z.string().min(4).max(64),
          limit: z.coerce.number().int().min(1).max(200).default(20),
        }),
      },
    },
    async (req) => {
      const auth = req.requireAuth();
      const runs = await runsForFingerprint(app.db, { ...req.query, operatorId: auth.operatorId });
      return { runs };
    },
  );

  app.post(
    '/runs/:runId/retry',
    {
      config: { permission: 'admin:ops:manage' },
      schema: {
        description: 'Run a failed scheduled job again. Only jobs; nothing else is safe from here',
        params: z.object({ runId: z.string().uuid() }),
      },
    },
    async (req) => {
      const auth = req.requireAuth();
      const run = await findRun(app.db, req.params.runId);
      if (!run) throw errors.notFound('No such run');
      /**
       * A job is a sweep: running it again is the whole design. Everything
       * else recorded here — a request, a device call, an adapter — has
       * already half-happened by the time it failed, and re-running it from a
       * console is how one failure becomes two events. The Failures page is
       * told the same thing through `retryable`, so the button is not offered.
       */
      if (run.kind !== 'job') {
        throw errors.badRequest(`A ${run.kind} run is not safe to re-run from here`);
      }
      /**
       * A run outlives the build that made it: a job renamed or removed in a
       * later deploy still has failures on the page. That is a conflict with a
       * sentence somebody can read, not an unhandled throw from the runner.
       */
      if (!jobRunner().jobs.some((j) => j.name === run.name)) {
        throw errors.conflict(
          'JOB_NOT_REGISTERED',
          `${run.name} is not a job this build registers, so there is nothing to run again`,
        );
      }

      const outcome = await jobRunner().runJob(run.name, { force: true });
      if (outcome === 'disabled') {
        throw errors.conflict(
          'JOBS_ROLE_ABSENT',
          'This api instance does not carry the jobs role, so nothing ran',
        );
      }
      if (outcome === 'locked') {
        throw errors.conflict('JOB_RUNNING', 'That job is already running');
      }

      await withTx(app.db, opCtx(req), 'ops.run_retry', async (tx) => {
        await audit.record(tx, {
          actorAccountId: auth.accountId,
          operatorId: auth.operatorId,
          branchId: auth.branchId,
          action: 'ops.run_retry',
          entityType: 'ops_run',
          entityId: run.id,
          after: { job: run.name, outcome },
          requestId: req.id,
        });
      });
      // `ok` is "the retry was accepted and ran", not "it worked" — a job that
      // failed again has a run of its own saying so.
      return { ok: true as const, outcome };
    },
  );

  // --- Integrations -------------------------------------------------------

  app.get(
    '/integrations',
    {
      config: { permission: 'admin:health:read' },
      schema: {
        description: 'Outside services: a name, a state, what is unset by name, and when each last ran',
      },
    },
    async (req) => {
      req.requireAuth();
      return integrationsSnapshot({
        db: app.db,
        env: app.env,
        storage: app.fileStorage,
        watchdogJob: WATCHDOG_JOB,
      });
    },
  );

  // --- Test controls ------------------------------------------------------

  /**
   * The controls that make something go wrong on purpose, so the alerting can
   * be watched doing its job.
   *
   * The demo reset is deliberately NOT one of them: it needs a typed
   * confirmation phrase, which a one-press control cannot carry, and it has
   * its own pair of routes below.
   */
  const TEST_CONTROLS = [
    {
      key: 'watchdog.run',
      label: 'Run the watchdog now',
      description: 'Compares what should have run with what did, without waiting for the next tick.',
      sticky: false,
    },
    {
      key: 'alert.test',
      label: 'Send a test alert',
      description: 'Raises an info alert and delivers it through every configured channel. It stays open until acknowledged.',
      sticky: true,
    },
    {
      key: 'job.fail',
      label: 'Record a failed job run',
      description: 'Writes the same failure record a broken job would, so the Failures page can be watched grouping them.',
      sticky: true,
    },
    /**
     * The fleet controls (S2-04). They act on the virtual box running inside
     * this process — the ordinary agent from `@oto/box-agent` pointed at
     * loopback — so what they exercise is the real registration, the real
     * heartbeat and the real watchdog rules, with nothing simulated but the
     * hardware.
     *
     * Each is a separate control rather than one that toggles, because a
     * button labelled "Stop heartbeats" that resumes them on the second press
     * is a button that lies about what it is about to do.
     */
    {
      key: 'box.heartbeats.stop',
      label: 'Stop heartbeats',
      description:
        'The virtual box stops calling home. Run the watchdog after it: during opening hours the box goes offline and opens an alert.',
      sticky: true,
    },
    {
      key: 'box.heartbeats.start',
      label: 'Resume heartbeats',
      description: 'The virtual box calls home again at once, which closes the offline alert.',
      sticky: false,
    },
    {
      key: 'box.clock.advance',
      label: 'Advance box clock',
      description:
        'Moves the virtual box two minutes ahead of us — past the minute the watchdog allows, and well short of the fifteen that make a heartbeat refusable.',
      sticky: true,
    },
    {
      key: 'box.clock.reset',
      label: 'Put the box clock back',
      description: 'Returns the virtual box to our time, which closes the clock alert.',
      sticky: false,
    },
  ] as const;

  /**
   * Answered rather than refused, exactly as `GET /demo-reset` is: the console
   * hides the section without every page load by the staff who will never see
   * it recording a denial.
   */
  app.get(
    '/test-controls',
    {
      config: { auth: 'session' },
      schema: { description: 'Which staging-only controls this deployment offers this caller' },
    },
    async (req) => {
      req.requireAuth();
      const effective = await req.effectivePermissions();
      const available = app.env.OPS_TEST_CONTROLS && isPlatformWide(effective);
      return { available, controls: available ? TEST_CONTROLS.map((c) => ({ ...c })) : [] };
    },
  );

  app.post(
    '/test-controls/:key',
    {
      config: { platformWide: true },
      schema: {
        description: 'Run one staging-only control',
        params: z.object({ key: z.string().max(40) }),
      },
    },
    async (req) => {
      const auth = await requirePlatform(req);
      const key = req.params.key;
      if (!TEST_CONTROLS.some((c) => c.key === key)) throw errors.notFound('No such control');

      const message = await runTestControl(key);
      await withTx(app.db, opCtx(req), 'ops.test_control', async (tx) => {
        await audit.record(tx, {
          actorAccountId: auth.accountId,
          operatorId: auth.operatorId,
          branchId: auth.branchId,
          action: 'ops.test_control',
          entityType: 'operation',
          entityId: req.id,
          after: { control: key },
          requestId: req.id,
        });
      });
      return { ok: true as const, message };
    },
  );

  async function runTestControl(key: string): Promise<string> {
    if (key === 'watchdog.run') {
      const outcome = await jobRunner().runJob(WATCHDOG_JOB, { force: true });
      if (outcome === 'disabled') {
        throw errors.conflict(
          'JOBS_ROLE_ABSENT',
          'This api instance does not carry the jobs role, so nothing ran',
        );
      }
      return `The watchdog ran (${outcome}).`;
    }

    if (key === 'alert.test') {
      const channels = buildAlertChannels(app.env.ALERT_CHANNELS, app.log);
      const raised = await raiseAlert(
        app.db,
        {
          key: 'ops.test:alert',
          category: 'ops.test',
          severity: 'info',
          subject: 'test alert',
          summary: 'A test alert, raised from the Console. Nothing is wrong.',
        },
        { flapWindowSeconds: app.env.ALERT_FLAP_WINDOW_S },
      );
      await deliverAlert(
        app.db,
        channels,
        {
          alertId: raised.id,
          key: 'ops.test:alert',
          category: 'ops.test',
          severity: 'info',
          subject: 'test alert',
          summary: 'A test alert, raised from the Console. Nothing is wrong.',
          event: 'test',
        },
        app.log,
      );
      return `Delivered to ${channels.map((c) => c.name).join(', ') || 'nowhere — ALERT_CHANNELS is empty'}. It is open on Health until acknowledged.`;
    }

    if (key.startsWith('box.')) return runFleetControl(key);

    /**
     * `job.fail` writes the failure record a broken job would write, rather
     * than registering a deliberately broken job in the runner. A registered
     * job is one the watchdog then expects to succeed on a schedule, so every
     * deploy of staging would open an alert nobody asked for. The record is
     * written through the same `recordRun` every real failure goes through, so
     * the Failures page groups it by fingerprint exactly as it would the real
     * thing.
     */
    const startedAt = new Date();
    await recordRun(app.db, {
      kind: 'job',
      name: 'job:demo.fail',
      outcome: 'failed',
      startedAt,
      error: new Error('Deliberate failure, from the Console test controls'),
      detail: { deliberate: true },
    });
    return 'Recorded a failed run of job:demo.fail. It is on the Failures page.';
  }

  /**
   * Two minutes. Past the minute the watchdog's clock rule allows, and a long
   * way short of the fifteen at which `recordHeartbeat` stops believing a box's
   * clock at all — a refused heartbeat would make the box go silent, which is a
   * different fault from the one this control exists to demonstrate.
   */
  const CLOCK_STEP_MS = 120_000;

  /**
   * The controls that make the virtual box misbehave.
   *
   * They reach the ordinary agent from `@oto/box-agent` running inside this
   * process, so what they exercise is the real registration, the real heartbeat
   * and the real watchdog rules, with nothing simulated but the hardware. On an
   * instance that does not carry the `edge` role there is no box here to stop,
   * and saying so is more use than a success that moved nothing.
   */
  async function runFleetControl(key: string): Promise<string> {
    const agent = virtualBoxAgent();
    if (!agent) {
      throw errors.conflict(
        'VIRTUAL_BOX_ABSENT',
        'No virtual box is running in this process — PROCESS_ROLES does not name edge, so there is nothing here to stop or to move',
      );
    }

    /**
     * Each control sends a heartbeat itself rather than leaving somebody
     * watching a page for up to a minute. A stopped box answers null, which is
     * the whole point of stopping it and is said rather than swallowed.
     */
    const beat = async (): Promise<boolean> => {
      try {
        return (await agent.heartbeat()) !== null;
      } catch (err) {
        app.log.warn({ err }, 'the virtual box could not be made to call home from a test control');
        return false;
      }
    };

    if (key === 'box.heartbeats.stop') {
      agent.pauseHeartbeats(true);
      return `The virtual box has stopped calling home. After ${boxSettings().offlineAfterS}s of silence the watchdog calls it offline, and during opening hours it opens a box.offline alert.`;
    }

    if (key === 'box.heartbeats.start') {
      agent.pauseHeartbeats(false);
      return (await beat())
        ? 'The virtual box is calling home again. The next watchdog run closes the alert with box.online.'
        : 'Heartbeats are on again, but the box could not reach the api just now — it tries again on its own timer.';
    }

    if (key === 'box.clock.advance') {
      agent.advanceClock(CLOCK_STEP_MS);
      const sent = await beat();
      const skewSeconds = Math.round(agent.state.clockSkewMs / 1000);
      return sent
        ? `The virtual box's clock is now ${skewSeconds}s ahead of ours, which the next watchdog run raises as box.clock.`
        : `The virtual box's clock is now ${skewSeconds}s ahead of ours, but its heartbeats are stopped, so nothing has reported the offset yet.`;
    }

    // box.clock.reset — the only one left, and the way back from the one above.
    agent.advanceClock(-agent.state.clockSkewMs);
    await beat();
    return 'The virtual box is back on our time. The next watchdog run closes the clock alert.';
  }

  // --- The demo reset (S2-01c) --------------------------------------------

  /**
   * Whether this caller, on this deployment, may reset. Answered rather than
   * refused so the console can hide the control without every admin console
   * load recording a denial for the staff who will never see it.
   */
  app.get(
    '/demo-reset',
    {
      config: { auth: 'session' },
      schema: { description: 'Whether the demo reset is available to this caller' },
    },
    async (req) => {
      req.requireAuth();
      const effective = await req.effectivePermissions();
      return {
        available: app.env.OPS_TEST_CONTROLS && isPlatformWide(effective),
        confirmationPhrase: DEMO_RESET_CONFIRMATION,
      };
    },
  );

  app.post(
    '/demo-reset',
    {
      config: { platformWide: true },
      schema: {
        description: 'Delete the demo facts, keeping accounts and the catalogue',
        body: z.object({ confirm: z.string() }).strict(),
      },
    },
    async (req) => {
      const auth = await requirePlatform(req);
      if (req.body.confirm !== DEMO_RESET_CONFIRMATION) {
        throw errors.badRequest(`Type "${DEMO_RESET_CONFIRMATION}" to confirm`);
      }
      // One transaction: a reset that half ran would leave the deployment in a
      // state neither the seed nor the person who ran it can describe.
      return withTx(app.db, opCtx(req), 'ops.demo_reset', async (tx) => {
        const deleted = await resetDemoData(tx);
        await audit.record(tx, {
          actorAccountId: auth.accountId,
          operatorId: auth.operatorId,
          branchId: auth.branchId,
          action: 'ops.demo_reset',
          entityType: 'operation',
          entityId: req.id,
          after: { deleted },
          requestId: req.id,
        });
        return { deleted };
      });
    },
  );
}
