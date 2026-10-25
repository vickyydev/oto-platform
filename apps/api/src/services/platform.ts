import { and, desc, isNotNull, isNull, sql } from 'drizzle-orm';
import { alert, type Db } from '@oto/db';
import type { Env } from '../env';
import { jobRegister, type AlertRow, type EnvVariable, type HealthDeps, type JobStatus } from './ops';

export interface PlatformAlertQuery {
  state: 'open' | 'resolved' | 'all';
  limit: number;
  offset: number;
}
export interface PlatformAlerts {
  generatedAt: string;
  alerts: AlertRow[];
  total: number;
  limit: number;
  offset: number;
}
export interface PlatformJobs { generatedAt: string; jobs: JobStatus[] }
export interface PlatformEnvironment { generatedAt: string; variables: EnvVariable[] }

/** A null-operator page, with the native alert wording and one consistent count/page snapshot. */
export async function platformAlertsOf(db: Db, input: PlatformAlertQuery, now = new Date()): Promise<PlatformAlerts> {
  return db.transaction(async tx => {
    const scope = and(isNull(alert.operatorId),
      ...(input.state === 'open' ? [isNull(alert.resolvedAt)] : input.state === 'resolved' ? [isNotNull(alert.resolvedAt)] : []));
    const [count] = await tx.select({ total: sql<number>`count(*)::integer`.mapWith(Number) }).from(alert).where(scope);
    const rows = await tx.select({
      id: alert.id, key: alert.key, severity: alert.severity, summary: alert.summary, subject: alert.subject,
      firstSeenAt: alert.firstSeenAt, acknowledgedAt: alert.acknowledgedAt, resolvedAt: alert.resolvedAt,
      occurrences: alert.occurrences, reopenCount: alert.reopenCount,
    }).from(alert).where(scope).orderBy(desc(alert.lastSeenAt), desc(alert.id)).limit(input.limit).offset(input.offset);
    return {
      generatedAt: now.toISOString(), total: count!.total, limit: input.limit, offset: input.offset,
      // Same safe projection as ops.openAlerts; raw JSON detail stays in storage.
      alerts: rows.map(row => ({
        id: row.id, key: row.key, severity: row.severity, title: row.summary,
        detail: [row.subject, row.reopenCount > 0 ? `recovered and broke again ${row.reopenCount}×` : null].filter(Boolean).join(' · '),
        openedAt: row.firstSeenAt.toISOString(), acknowledgedAt: row.acknowledgedAt?.toISOString() ?? null,
        resolvedAt: row.resolvedAt?.toISOString() ?? null, count: row.occurrences,
      })),
    };
  }, { isolationLevel: 'repeatable read', accessMode: 'read only' });
}

/** The existing persisted register; reading it never constructs or starts a job runner. */
export async function platformJobsOf(deps: HealthDeps, now = new Date()): Promise<PlatformJobs> {
  return { generatedAt: now.toISOString(), jobs: await jobRegister(deps, now.getTime()) };
}

/** The native Integrations variable catalogue/presence rule from ops.integrationsSnapshot. */
export function platformEnvironmentOf(env: Pick<Env, 'DEPLOY_ENV' | 'SMS_ADAPTER'>, now = new Date()): PlatformEnvironment {
  const onDeployment = env.DEPLOY_ENV !== 'local';
  const twilio = env.SMS_ADAPTER === 'twilio';
  const variables: EnvVariable[] = [
    { name: 'DATABASE_URL', required: true, provider: null, purpose: 'The database this deployment reads and writes.' },
    { name: 'ALLOWED_ORIGINS', required: onDeployment, provider: null, purpose: 'Browser origins allowed to send a state-changing request.' },
    { name: 'SMS_ADAPTER', required: true, provider: 'sms', purpose: 'Which SMS adapter delivers verification codes.' },
    { name: 'TWILIO_ACCOUNT_SID', required: twilio, provider: 'sms', purpose: 'Names the Twilio account in the request path.' },
    { name: 'TWILIO_API_KEY_SID', required: false, provider: 'sms', purpose: 'The credential shape to prefer — revoked and rotated on its own.' },
    { name: 'TWILIO_API_KEY_SECRET', required: false, provider: 'sms', purpose: 'The other half of the API key.' },
    { name: 'TWILIO_AUTH_TOKEN', required: false, provider: 'sms', purpose: 'The account master password — the fallback when no API key exists.' },
    { name: 'TWILIO_FROM', required: twilio, provider: 'sms', purpose: 'The sending number, or a Messaging Service SID.' },
    { name: 'MINIO_ENDPOINT', required: onDeployment, provider: 'storage', purpose: 'The bare S3 host — no scheme, no path.' },
    { name: 'MINIO_PORT', required: onDeployment, provider: 'storage', purpose: '443 for an S3 endpoint over TLS.' },
    { name: 'MINIO_USE_SSL', required: onDeployment, provider: 'storage', purpose: 'A presigned URL is a bearer credential; it must not travel in the clear.' },
    { name: 'MINIO_ACCESS_KEY', required: onDeployment, provider: 'storage', purpose: 'Object storage credential.' },
    { name: 'MINIO_SECRET_KEY', required: onDeployment, provider: 'storage', purpose: 'Object storage credential.' },
    { name: 'MINIO_BUCKET', required: onDeployment, provider: 'storage', purpose: 'The bucket uploads land in. Created by a person, never by the api.' },
    { name: 'MINIO_REGION', required: false, provider: 'storage', purpose: 'Signing region — "auto" for Cloudflare R2.' },
    { name: 'HANDOFF_SIGNING_KEY', required: false, provider: null, purpose: 'Signs the suite hand-off; empty means the launcher hand-off is off.' },
    { name: 'HANDOFF_APP_ORIGINS', required: false, provider: null, purpose: 'Where each app lives, so a token for the till cannot be spent on the console.' },
    { name: 'ALERT_CHANNELS', required: false, provider: 'alerts', purpose: 'Where an alert is delivered. Console until a channel is chosen.' },
    { name: 'SENTRY_DSN', required: false, provider: 'sentry', purpose: 'Error reporting. A no-op while unset.' },
  ].map(variable => ({ ...variable, present: Boolean(process.env[variable.name]?.trim()) }));
  return { generatedAt: now.toISOString(), variables };
}
