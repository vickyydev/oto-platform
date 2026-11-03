import type { Db } from '@oto/db';
import type { FastifyBaseLogger } from 'fastify';
import { AppError } from '../lib/errors';
import type { AuthContext } from '../plugins/session';
import {
  openOtoAppSession,
  otoAppEnvelope,
  OtoAppCallTimeout,
  OtoAppUnavailable,
} from './assistant/call-otoapp';
import type { GetRouteTemplate } from './assistant/call-platform';
import type { HandoffConfig } from './handoff';
import type { EffectivePermission } from './permissions';
import type { OpContext } from './tx';

/**
 * SCRUM-674 — THE OTO APP'S SECTION OF THE SUPPORT LOOKUP.
 *
 * The OTO App is a separate service with its own sessions, roles and tables,
 * so this never reads them: it opens the app AS THE PERSON ASKING, through the
 * one seam that exists for that (`assistant/call-otoapp.ts`, the suite
 * hand-off driven server side), calls the app's own reader
 * (`apps/oto-app/server/support-lookup-routes.ts`) and logs that session out.
 * What comes back is what the app's own fences say this person may see, and
 * the refusal, when there is one, is the app's own sentence.
 *
 * The hand-off's token and the app's cookie stay inside that seam. A failure is
 * recorded by class, never by its message, which could carry a URL.
 */

export const OTOAPP_SUPPORT_ROUTE: GetRouteTemplate = 'GET /api/support/by-phone';

/** All of it, hand-off to answer; `OTOAPP_DIRECTORY_TIMEOUT_MS` bounds each call within this. */
export const SUPPORT_OTOAPP_WALL_MS = 15_000;

const NOT_CONNECTED = 'The OTO App is not connected on this deployment, so its records could not be searched.';
const NO_ANSWER = 'The OTO App did not answer, so its records could not be searched.';

export interface OtoAppRecordsOutcome {
  status: 'found' | 'empty' | 'denied' | 'unavailable';
  rows: Record<string, unknown>[];
  note: string | null;
  /** The app refused, in its own words, a person the platform let through. */
  refusedByApp?: boolean;
}

export interface OtoAppRecordsInput {
  db: Db;
  ctx: OpContext;
  /** Throws `HANDOFF_NOT_CONFIGURED` on a deployment with no hand-off. */
  handoff: () => HandoffConfig;
  auth: AuthContext;
  effective: EffectivePermission[];
  /** The asker's own platform session token. */
  token: string;
  requestId: string;
  /** The per-call limit (`OTOAPP_DIRECTORY_TIMEOUT_MS`). */
  timeoutMs: number;
  /** E.164: the phone the lookup normalised. */
  phone: string;
  log?: FastifyBaseLogger;
  wallMs?: number;
}

const unavailable = (note: string): OtoAppRecordsOutcome => ({ status: 'unavailable', rows: [], note });

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export async function otoAppRecordsByPhone(input: OtoAppRecordsInput): Promise<OtoAppRecordsOutcome> {
  let handoff: HandoffConfig;
  try {
    handoff = input.handoff();
  } catch (err) {
    if (err instanceof AppError && err.code === 'HANDOFF_NOT_CONFIGURED') return unavailable(NOT_CONNECTED);
    throw err;
  }
  if (!handoff.origins.has('oto_app')) return unavailable(NOT_CONNECTED);

  const wallMs = input.wallMs ?? SUPPORT_OTOAPP_WALL_MS;
  const deadline = Date.now() + wallMs;
  const failed = (err: unknown): OtoAppRecordsOutcome => {
    if (!(err instanceof OtoAppUnavailable) && !(err instanceof OtoAppCallTimeout)) {
      input.log?.error({ error: err instanceof Error ? err.name : 'NonError' }, 'the support lookup could not read the OTO App');
    }
    return unavailable(NO_ANSWER);
  };

  let opened: Awaited<ReturnType<typeof openOtoAppSession>>;
  try {
    opened = await openOtoAppSession({
      db: input.db,
      ctx: input.ctx,
      handoff,
      auth: input.auth,
      effective: input.effective,
      token: input.token,
      requestId: input.requestId,
      askId: input.requestId,
      timeoutMs: input.timeoutMs,
      remainingMs: wallMs,
      log: input.log,
    });
  } catch (err) {
    return failed(err);
  }
  if (!opened.ok) return { status: 'denied', rows: [], note: opened.refusal.message, refusedByApp: opened.refusal.system === 'oto_app' };

  const { session } = opened;
  try {
    const res = await session.get({
      url: `/api/support/by-phone?phone=${encodeURIComponent(input.phone)}`,
      routes: [OTOAPP_SUPPORT_ROUTE],
      seq: 1,
      remainingMs: Math.max(0, deadline - Date.now()),
    });
    if (res.status === 401 || res.status === 403) {
      return { status: 'denied', rows: [], note: otoAppEnvelope(res.body).message ?? 'The OTO App refused this search.', refusedByApp: true };
    }
    if (res.status !== 200 || !isRecord(res.body) || !Array.isArray(res.body.records)) {
      return unavailable(`The OTO App answered ${res.status}, so its records could not be searched.`);
    }
    const rows = res.body.records.filter(isRecord);
    const limit = typeof res.body.limit === 'number' ? res.body.limit : null;
    return {
      status: rows.length > 0 ? 'found' : 'empty',
      rows,
      note: res.body.truncated === true && limit !== null ? `Showing the newest ${limit} of each kind.` : null,
    };
  } catch (err) {
    return failed(err);
  } finally {
    await session.close();
  }
}
