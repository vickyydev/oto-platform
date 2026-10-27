import { and, eq } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import {
  INTEGRATION_EXPIRY_KEYS,
  integrationCredentialExpiry,
  type Db,
  type IntegrationExpiryKey,
} from '@oto/db';
import { newId } from '@oto/shared';
import { readEvidence, type ReadAvailability } from './health-evidence';
import type { JobDefinition, JobDeps } from './jobs';
import { deliverAlert, raiseAlert, resolveAlert, type AlertChannel } from './ops';
import type { Exec } from './tx';

/**
 * THE CREDENTIAL AND CERTIFICATE EXPIRY WATCH (SCRUM-645, planner ruling Q26;
 * S2-23 Integrations: "any integration whose token or key has a known
 * lifetime … carries an `expires_on` the owner sets, and the watchdog opens an
 * alert 30 and 7 days before").
 *
 * OWNER-SUPPLIED METADATA ONLY. The date comes from a person who was told it
 * when the credential was issued, through an audited write, and the watch
 * reads that row and nothing else. Nothing here calls a provider, inspects a
 * token or guesses a lifetime: a credential nobody has dated is shown as
 * "not set", which is an honest unknown, never a green.
 *
 * The alerts go through the platform's existing raise-and-deliver path in
 * `services/ops.ts`, exactly as the watchdog's do — opened once, repeated
 * silently while true, resolved when the date moves or is cleared — so the
 * recipient routing that path gains (Q25) applies to these without anything
 * here changing.
 */

export interface IntegrationExpiryCatalogueEntry {
  key: IntegrationExpiryKey;
  name: string;
  purpose: string;
}

/** The integrations whose credential has a lifetime the owner can know. */
export const INTEGRATION_EXPIRY_CATALOGUE: readonly IntegrationExpiryCatalogueEntry[] = [
  {
    key: 'meta_channel_token',
    name: 'Meta channel tokens',
    purpose: "The WhatsApp, Messenger and Instagram access tokens the Inbox's channels send with.",
  },
  {
    key: 'pgw_maintenance_key',
    name: '2C2P maintenance keys',
    purpose: "The 2C2P Payment Maintenance host's keys, used for refunds and settlement queries.",
  },
  {
    key: 'otoapp_directory_key',
    name: 'OTO App Directory API key',
    purpose: "The key the platform reads the OTO App's staff, events and night jobs with.",
  },
];

if (INTEGRATION_EXPIRY_CATALOGUE.length !== INTEGRATION_EXPIRY_KEYS.length) {
  throw new Error('INTEGRATION_EXPIRY_CATALOGUE must name every key in INTEGRATION_EXPIRY_KEYS');
}

/** The two windows the ruling names: an alert at 30 days, and another at 7. */
export const EXPIRY_WINDOWS = [
  { days: 30, severity: 'warning' as const },
  { days: 7, severity: 'critical' as const },
];

export const INTEGRATION_EXPIRY_JOB = 'job:integration.expiry';

/**
 * Hourly. The watch's answer only changes at a date boundary or when the
 * owner edits a date, so a minute's cadence would be 1,440 run rows a day for
 * the same verdict; an hour opens a new window's alert within the hour it
 * becomes true.
 */
export const INTEGRATION_EXPIRY_INTERVAL_S = 3_600;

export type ExpiryWindow = 'not_set' | 'ok' | '30_days' | '7_days' | 'expired';

const DAY_MS = 86_400_000;

/**
 * Whole days from today to the expiry date, both read as UTC calendar dates.
 * The row is an operator's, and an operator has no single timezone of its own;
 * UTC is what the stored DATE means everywhere else in this file, so a
 * Bangkok-evening edit cannot land a day apart from the watch that reads it.
 */
export function daysUntil(expiresOn: string, now: Date): number {
  const [y, m, d] = expiresOn.split('-').map(Number) as [number, number, number];
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Math.round((Date.UTC(y, m - 1, d) - today) / DAY_MS);
}

export function expiryWindow(expiresOn: string | null, now: Date): { window: ExpiryWindow; daysLeft: number | null } {
  if (!expiresOn) return { window: 'not_set', daysLeft: null };
  const daysLeft = daysUntil(expiresOn, now);
  if (daysLeft < 0) return { window: 'expired', daysLeft };
  if (daysLeft <= 7) return { window: '7_days', daysLeft };
  if (daysLeft <= 30) return { window: '30_days', daysLeft };
  return { window: 'ok', daysLeft };
}

export interface CredentialExpiryView {
  integration: IntegrationExpiryKey;
  name: string;
  purpose: string;
  expiresOn: string | null;
  daysLeft: number | null;
  window: ExpiryWindow;
  setAt: string | null;
}

export interface CredentialExpiryList {
  /** Whether the stored dates were read; `not_set` below means nothing when they were not. */
  availability: ReadAvailability;
  detail: string | null;
  credentials: CredentialExpiryView[];
}

function viewOf(
  entry: IntegrationExpiryCatalogueEntry,
  row: { expiresOn: string | null; setAt: Date | null } | undefined,
  now: Date,
): CredentialExpiryView {
  const expiresOn = row?.expiresOn ?? null;
  return {
    integration: entry.key,
    name: entry.name,
    purpose: entry.purpose,
    expiresOn,
    ...expiryWindow(expiresOn, now),
    setAt: row?.setAt ? row.setAt.toISOString() : null,
  };
}

/** Every known integration for one operator, dated or not. */
export async function listCredentialExpiries(db: Db, operatorId: string, now: Date): Promise<CredentialExpiryList> {
  const read = await readEvidence(() =>
    db
      .select({
        key: integrationCredentialExpiry.integrationKey,
        expiresOn: integrationCredentialExpiry.expiresOn,
        setAt: integrationCredentialExpiry.setAt,
      })
      .from(integrationCredentialExpiry)
      .where(eq(integrationCredentialExpiry.operatorId, operatorId)),
  );
  if (!read.ok) {
    // Not "not set": the dates exist or do not, and this read cannot say which.
    return { availability: read.availability, detail: read.detail, credentials: [] };
  }
  const byKey = new Map(read.value.map((row) => [row.key, row]));
  return {
    availability: 'ok',
    detail: null,
    credentials: INTEGRATION_EXPIRY_CATALOGUE.map((entry) => viewOf(entry, byKey.get(entry.key), now)),
  };
}

export interface SetCredentialExpiryInput {
  operatorId: string;
  accountId: string;
  key: IntegrationExpiryKey;
  expiresOn: string | null;
  now: Date;
}

/**
 * Upsert the owner's date for one integration, inside the caller's
 * transaction. Answers the view before and after for the audit row. The row is
 * named by (operator, integration) — its id is internal and never referred to.
 */
export async function setCredentialExpiry(
  tx: Exec,
  input: SetCredentialExpiryInput,
): Promise<{ id: string; before: CredentialExpiryView; after: CredentialExpiryView }> {
  const entry = INTEGRATION_EXPIRY_CATALOGUE.find((e) => e.key === input.key)!;
  const where = and(
    eq(integrationCredentialExpiry.operatorId, input.operatorId),
    eq(integrationCredentialExpiry.integrationKey, input.key),
  );
  const [existing] = await tx
    .select({ expiresOn: integrationCredentialExpiry.expiresOn, setAt: integrationCredentialExpiry.setAt })
    .from(integrationCredentialExpiry)
    .where(where)
    .for('update');
  const [saved] = await tx
    .insert(integrationCredentialExpiry)
    .values({
      id: newId(),
      operatorId: input.operatorId,
      integrationKey: input.key,
      expiresOn: input.expiresOn,
      setByAccountId: input.accountId,
      setAt: input.now,
    })
    .onConflictDoUpdate({
      target: [integrationCredentialExpiry.operatorId, integrationCredentialExpiry.integrationKey],
      set: { expiresOn: input.expiresOn, setByAccountId: input.accountId, setAt: input.now, updatedAt: input.now },
    })
    .returning({ id: integrationCredentialExpiry.id, expiresOn: integrationCredentialExpiry.expiresOn, setAt: integrationCredentialExpiry.setAt });
  return { id: saved!.id, before: viewOf(entry, existing, input.now), after: viewOf(entry, saved, input.now) };
}

// --- The watch ---------------------------------------------------------------

export function expiryAlertKey(operatorId: string, key: IntegrationExpiryKey, days: number): string {
  return `integration.expiry:${key}:${days}d:${operatorId}`;
}

export interface ExpiryWatchSummary extends Record<string, unknown> {
  examined: number;
  opened: number;
  repeated: number;
  resolved: number;
}

export interface ExpiryWatchDeps {
  db: Db;
  channels: AlertChannel[];
  log?: FastifyBaseLogger;
  flapWindowSeconds: number;
  now: Date;
}

/**
 * One pass over every stored date. For each window a credential is inside,
 * the window's alert is raised (opened and delivered once, repeated silently
 * afterwards); for each it is outside — the date moved later, or was cleared —
 * the window's alert is resolved. The two windows are two alerts, so the
 * 7-day one arrives as news even if the 30-day one was acknowledged weeks ago.
 */
export async function runIntegrationExpiryWatch(deps: ExpiryWatchDeps): Promise<ExpiryWatchSummary> {
  const { db, channels, log, now } = deps;
  const rows = await db
    .select({
      operatorId: integrationCredentialExpiry.operatorId,
      key: integrationCredentialExpiry.integrationKey,
      expiresOn: integrationCredentialExpiry.expiresOn,
    })
    .from(integrationCredentialExpiry);
  const summary: ExpiryWatchSummary = { examined: rows.length, opened: 0, repeated: 0, resolved: 0 };

  for (const row of rows) {
    const entry = INTEGRATION_EXPIRY_CATALOGUE.find((e) => e.key === row.key);
    if (!entry) continue;
    const { daysLeft } = expiryWindow(row.expiresOn, now);
    for (const window of EXPIRY_WINDOWS) {
      const key = expiryAlertKey(row.operatorId, row.key, window.days);
      const category = 'integration.expiry';
      const subject = entry.name;
      if (daysLeft !== null && daysLeft <= window.days) {
        const summaryLine = daysLeft < 0
          ? `${entry.name} expired on ${row.expiresOn} (${-daysLeft} day${daysLeft === -1 ? '' : 's'} ago) — renew it and record the new date`
          : `${entry.name} expire${daysLeft === 0 ? ' today' : ` in ${daysLeft} day${daysLeft === 1 ? '' : 's'}`}, on ${row.expiresOn} — within the ${window.days}-day warning`;
        const raised = await raiseAlert(
          db,
          {
            key,
            category,
            severity: window.severity,
            subject,
            summary: summaryLine,
            detail: { integration: row.key, expiresOn: row.expiresOn, daysLeft, windowDays: window.days },
            operatorId: row.operatorId,
          },
          { flapWindowSeconds: deps.flapWindowSeconds },
        );
        if (raised.outcome === 'opened') {
          summary.opened += 1;
          await deliverAlert(
            db,
            channels,
            { alertId: raised.id, key, category, severity: window.severity, subject, summary: summaryLine, event: 'opened' },
            log,
          );
        } else {
          summary.repeated += 1;
        }
      } else {
        const resolved = await resolveAlert(db, key, row.expiresOn ? 'renewed' : 'cleared');
        if (!resolved) continue;
        summary.resolved += 1;
        if (resolved.wasNotified) {
          await deliverAlert(
            db,
            channels,
            {
              alertId: resolved.id,
              key,
              category,
              severity: 'info',
              subject,
              summary: row.expiresOn
                ? `${entry.name} now expire on ${row.expiresOn}, outside the ${window.days}-day warning`
                : `${entry.name} no longer has an expiry date recorded`,
              event: 'resolved',
            },
            log,
          );
        }
      }
    }
  }
  return summary;
}

/**
 * The watch as a scheduled job, registered by `buildDefaultJobs` with one
 * line. Every deployment runs it: with no dates stored it reads an empty table
 * and opens nothing.
 */
export function buildIntegrationExpiryJobs(deps: Pick<JobDeps, 'channels' | 'log' | 'env'>): JobDefinition[] {
  return [
    {
      name: INTEGRATION_EXPIRY_JOB,
      description:
        'Opens an alert 30 days and again 7 days before each integration credential expires, from the dates the owner recorded; it never asks a provider',
      intervalSeconds: INTEGRATION_EXPIRY_INTERVAL_S,
      run: async ({ db, env, log, now }) => ({
        detail: await runIntegrationExpiryWatch({
          db,
          channels: deps.channels,
          log,
          flapWindowSeconds: env.ALERT_FLAP_WINDOW_S,
          now,
        }),
      }),
    },
  ];
}
