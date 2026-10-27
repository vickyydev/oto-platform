import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import type { FastifyRequest } from 'fastify';
import { ALERT_RECIPIENT_CHANNELS, alertRecipient, branch as branchTable } from '@oto/db';
import { newId } from '@oto/shared';
import type { App } from '../app';
import { errors } from '../lib/errors';
import { audit } from '../services/audit';
import { branchReach } from '../services/access-control';
import { isPlatformWide } from '../services/permissions';
import { opCtx, withTx } from '../services/tx';
import {
  ALERT_DELIVERY_NOTE,
  ALERT_MUTE_DEFAULT_MINUTES,
  ALERT_MUTE_MAX_MINUTES,
  DELIVERED_CHANNELS,
  activeMutes,
  findRecipient,
  fingerprintOwner,
  liftMute,
  listRecipients,
  muteFingerprint,
  muteView,
  recipientView,
} from '../services/alert-routing';

/**
 * SCRUM-644, planner ruling Q25 — the Failures page's fingerprint mutes and
 * the alert recipient list, under `/ops`.
 *
 * Doors: `admin:health:read` still reads (the Failures page's existing door,
 * so a reader sees that a condition is muted and why); every write, and the
 * recipient list itself, is `console:alert:manage` held operator-wide. A
 * platform condition's mute, or a platform-wide recipient row, is a
 * platform-wide caller's alone — the same line `findRun` and `findAlert` draw
 * (SCRUM-607).
 *
 * Nothing here delivers anything. The watchdog reads these rows
 * (`deliverRoutedAlert`); delivery stays console-only, and the answers say so.
 */

const MuteSchema = z.object({
  id: z.string().uuid(),
  fingerprint: z.string(),
  scope: z.enum(['operator', 'platform']),
  reason: z.string(),
  startsAt: z.string().datetime(),
  mutedUntil: z.string().datetime(),
  createdByAccountId: z.string().uuid(),
  createdByName: z.string().nullable(),
  heldBack: z.number().int().nonnegative(),
});

const RecipientSchema = z.object({
  id: z.string().uuid(),
  scope: z.enum(['operator', 'platform']),
  branchId: z.string().uuid().nullable(),
  category: z.string(),
  channel: z.enum(ALERT_RECIPIENT_CHANNELS),
  addressRef: z.string().nullable(),
  addressConfigured: z.boolean().nullable(),
  delivered: z.boolean(),
  label: z.string().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

const Fingerprint = z.string().trim().min(4).max(200);
const Reason = z.string().trim().min(1, 'A mute needs a reason').max(500);
const Minutes = z
  .number()
  .int()
  .min(1)
  .max(
    ALERT_MUTE_MAX_MINUTES,
    `A mute lasts at most 24 hours (${ALERT_MUTE_MAX_MINUTES} minutes); a longer silence is decided again each day`,
  );
const Category = z
  .string()
  .regex(/^(\*|[a-z][a-z0-9_]*(\.[a-z0-9_]+)*)$/, 'A category is an alert family such as ops.failing, or * for every family')
  .max(80);
/** An environment variable NAME, never an address: `ALERT_` plus upper-case letters, digits and underscores. */
const AddressRef = z
  .string()
  .regex(
    /^ALERT_[A-Z0-9_]{2,58}$/,
    'Name the environment variable that holds the address (for example ALERT_ONCALL_EMAIL), never the address itself',
  );
const Label = z.string().trim().max(120);

/** The console takes no address; every other channel names one, by reference. */
function checkAddress(channel: string, addressRef: string | null | undefined) {
  if (channel === 'console' && addressRef) throw errors.badRequest('The console channel takes no address reference');
  if (channel !== 'console' && !addressRef) {
    throw errors.badRequest('An email or webhook row names the environment variable that holds its address');
  }
}

export async function opsAlertRoutingRoutes(app: App): Promise<void> {
  const platformWideOf = async (req: FastifyRequest) => isPlatformWide(await req.effectivePermissions());

  // --- Mutes --------------------------------------------------------------

  app.get(
    '/alert-mutes',
    {
      config: { permission: 'admin:health:read' },
      schema: {
        description:
          'The fingerprint mutes in force: who muted what, why and until when, and how many deliveries each has held back (recorded, never dropped). At most 24 hours each',
        querystring: z.object({ fingerprint: z.string().min(4).max(200).optional() }),
        response: {
          200: z.object({
            mutes: z.array(MuteSchema),
            defaultMinutes: z.number().int(),
            maxMinutes: z.number().int(),
          }),
        },
      },
    },
    async (req) => {
      const auth = req.requireAuth();
      // The Failures page's own line: an estate-wide reader also sees the
      // platform's conditions, a branch reader sees this operator's only, and
      // a reader who holds the door nowhere sees nothing.
      const reach = branchReach(await req.effectivePermissions(), 'admin:health:read', auth.operatorId);
      const nothing = reach.kind === 'branches' && reach.branchIds.length === 0;
      const mutes = nothing
        ? []
        : await activeMutes(app.db, {
            operatorId: auth.operatorId,
            includePlatform: reach.kind === 'operator',
            fingerprint: req.query.fingerprint,
          });
      return { mutes, defaultMinutes: ALERT_MUTE_DEFAULT_MINUTES, maxMinutes: ALERT_MUTE_MAX_MINUTES };
    },
  );

  app.post(
    '/alert-mutes',
    {
      config: { permission: 'console:alert:manage', target: { operator: true } },
      schema: {
        description:
          'Mute one alert fingerprint: a reason is required, one hour unless told otherwise, at most 24 hours. The alert is still raised and listed; its deliveries are recorded as muted. A fresh mute replaces the one in force',
        body: z.object({
          fingerprint: Fingerprint,
          reason: Reason,
          minutes: Minutes.default(ALERT_MUTE_DEFAULT_MINUTES),
        }),
        response: { 200: z.object({ mute: MuteSchema }) },
      },
    },
    async (req) => {
      const auth = req.requireAuth();
      const { fingerprint, reason, minutes } = req.body;
      const owner = await fingerprintOwner(app.db, fingerprint, auth.operatorId);
      if (!owner) throw errors.notFound('No failure or alert with that fingerprint in your reach');
      if (owner === 'platform' && !(await platformWideOf(req))) {
        throw errors.forbidden('A platform condition is muted by a platform administrator');
      }
      const operatorId = owner === 'operator' ? auth.operatorId : null;
      return withTx(app.db, opCtx(req), 'ops.alert_mute', async (tx) => {
        const { row, superseded } = await muteFingerprint(tx, {
          fingerprint, operatorId, reason, minutes, actorAccountId: auth.accountId,
        });
        await audit.record(tx, {
          actorAccountId: auth.accountId,
          operatorId: auth.operatorId,
          branchId: null,
          action: 'ops.alert_mute',
          entityType: 'alert_mute',
          entityId: row.id,
          sourceApp: 'console',
          after: {
            fingerprint,
            scope: owner,
            reason: row.reason,
            minutes,
            mutedUntil: row.mutedUntil.toISOString(),
            superseded,
          },
          requestId: req.id,
        });
        return { mute: muteView(row) };
      });
    },
  );

  app.post(
    '/alert-mutes/:muteId/lift',
    {
      config: { permission: 'console:alert:manage', target: { operator: true } },
      schema: {
        description: 'End a fingerprint mute early. The mute row stays, with who lifted it and when',
        params: z.object({ muteId: z.string().uuid() }),
        response: { 200: z.object({ ok: z.literal(true), mute: MuteSchema }) },
      },
    },
    async (req) => {
      const auth = req.requireAuth();
      const platformWide = await platformWideOf(req);
      return withTx(app.db, opCtx(req), 'ops.alert_unmute', async (tx) => {
        const row = await liftMute(tx, {
          id: req.params.muteId, operatorId: auth.operatorId, platformWide, actorAccountId: auth.accountId,
        });
        if (!row) throw errors.notFound('That mute is not in force');
        await audit.record(tx, {
          actorAccountId: auth.accountId,
          operatorId: auth.operatorId,
          branchId: null,
          action: 'ops.alert_unmute',
          entityType: 'alert_mute',
          entityId: row.id,
          sourceApp: 'console',
          before: { fingerprint: row.fingerprint, mutedUntil: row.mutedUntil.toISOString() },
          after: { liftedAt: row.liftedAt?.toISOString() ?? null },
          requestId: req.id,
        });
        return { ok: true as const, mute: muteView(row) };
      });
    },
  );

  // --- Recipients -----------------------------------------------------------

  app.get(
    '/alert-recipients',
    {
      config: { permission: 'console:alert:manage', target: { operator: true } },
      schema: {
        description:
          'Alert recipients: category to channel and an address REFERENCE (an environment variable name). Says whether each name is set here, never its value. Delivery is console-only until a provider integration is its own ticket',
        response: {
          200: z.object({
            recipients: z.array(RecipientSchema),
            deliveredChannels: z.array(z.enum(ALERT_RECIPIENT_CHANNELS)),
            deliveryNote: z.string(),
          }),
        },
      },
    },
    async (req) => {
      const auth = req.requireAuth();
      const rows = await listRecipients(app.db, { operatorId: auth.operatorId, includePlatform: await platformWideOf(req) });
      return {
        recipients: rows.map(recipientView),
        deliveredChannels: [...DELIVERED_CHANNELS],
        deliveryNote: ALERT_DELIVERY_NOTE,
      };
    },
  );

  app.post(
    '/alert-recipients',
    {
      config: { permission: 'console:alert:manage', target: { operator: true } },
      schema: {
        description:
          'Add an alert recipient row. Email and webhook rows name an ALERT_ environment variable, never an address, and are recorded as not delivered until a provider integration exists',
        body: z.object({
          category: Category,
          channel: z.enum(ALERT_RECIPIENT_CHANNELS),
          addressRef: AddressRef.nullable().optional(),
          label: Label.nullable().optional(),
          branchId: z.string().uuid().nullable().optional(),
          /** `platform` is a platform-wide caller's row for the platform's own alerts. */
          scope: z.enum(['operator', 'platform']).default('operator'),
        }),
        response: { 200: z.object({ recipient: RecipientSchema }) },
      },
    },
    async (req) => {
      const auth = req.requireAuth();
      const body = req.body;
      checkAddress(body.channel, body.addressRef);
      if (body.scope === 'platform') {
        if (!(await platformWideOf(req))) throw errors.forbidden('A platform recipient is a platform administrator’s row');
        if (body.branchId) throw errors.badRequest('A platform recipient names no park');
      }
      if (body.branchId) {
        const [park] = await app.db
          .select({ id: branchTable.id })
          .from(branchTable)
          .where(and(eq(branchTable.id, body.branchId), eq(branchTable.operatorId, auth.operatorId)))
          .limit(1);
        if (!park) throw errors.notFound('No such park in this operator');
      }
      return withTx(app.db, opCtx(req), 'ops.alert_recipient_create', async (tx) => {
        const [row] = await tx
          .insert(alertRecipient)
          .values({
            id: newId(),
            operatorId: body.scope === 'platform' ? null : auth.operatorId,
            branchId: body.branchId ?? null,
            category: body.category,
            channel: body.channel,
            addressRef: body.addressRef ?? null,
            label: body.label || null,
            createdByAccountId: auth.accountId,
          })
          .returning();
        await audit.record(tx, {
          actorAccountId: auth.accountId,
          operatorId: auth.operatorId,
          branchId: row!.branchId,
          action: 'ops.alert_recipient_create',
          entityType: 'alert_recipient',
          entityId: row!.id,
          sourceApp: 'console',
          after: { category: row!.category, channel: row!.channel, addressRef: row!.addressRef, label: row!.label, scope: body.scope },
          requestId: req.id,
        });
        return { recipient: recipientView(row!) };
      });
    },
  );

  app.patch(
    '/alert-recipients/:recipientId',
    {
      config: { permission: 'console:alert:manage', target: { operator: true } },
      schema: {
        description: 'Change an alert recipient row: its category, channel, address reference or label',
        params: z.object({ recipientId: z.string().uuid() }),
        body: z.object({
          category: Category.optional(),
          channel: z.enum(ALERT_RECIPIENT_CHANNELS).optional(),
          addressRef: AddressRef.nullable().optional(),
          label: Label.nullable().optional(),
        }),
        response: { 200: z.object({ recipient: RecipientSchema }) },
      },
    },
    async (req) => {
      const auth = req.requireAuth();
      const existing = await findRecipient(app.db, {
        id: req.params.recipientId, operatorId: auth.operatorId, platformWide: await platformWideOf(req),
      });
      if (!existing) throw errors.notFound('No such alert recipient');
      const next = {
        category: req.body.category ?? existing.category,
        channel: req.body.channel ?? existing.channel,
        addressRef: req.body.addressRef !== undefined ? req.body.addressRef : existing.addressRef,
        label: req.body.label !== undefined ? req.body.label || null : existing.label,
      };
      checkAddress(next.channel, next.addressRef);
      return withTx(app.db, opCtx(req), 'ops.alert_recipient_update', async (tx) => {
        const [row] = await tx
          .update(alertRecipient)
          .set({ ...next, updatedByAccountId: auth.accountId, updatedAt: new Date() })
          .where(eq(alertRecipient.id, existing.id))
          .returning();
        await audit.record(tx, {
          actorAccountId: auth.accountId,
          operatorId: auth.operatorId,
          branchId: existing.branchId,
          action: 'ops.alert_recipient_update',
          entityType: 'alert_recipient',
          entityId: existing.id,
          sourceApp: 'console',
          before: { category: existing.category, channel: existing.channel, addressRef: existing.addressRef, label: existing.label },
          after: next,
          requestId: req.id,
        });
        return { recipient: recipientView(row!) };
      });
    },
  );

  app.post(
    '/alert-recipients/:recipientId/archive',
    {
      config: { permission: 'console:alert:manage', target: { operator: true } },
      schema: {
        description: 'Archive an alert recipient row. Archived rows are kept and no longer consulted',
        params: z.object({ recipientId: z.string().uuid() }),
        response: { 200: z.object({ ok: z.literal(true) }) },
      },
    },
    async (req) => {
      const auth = req.requireAuth();
      const existing = await findRecipient(app.db, {
        id: req.params.recipientId, operatorId: auth.operatorId, platformWide: await platformWideOf(req),
      });
      if (!existing) throw errors.notFound('No such alert recipient');
      return withTx(app.db, opCtx(req), 'ops.alert_recipient_archive', async (tx) => {
        const now = new Date();
        await tx
          .update(alertRecipient)
          .set({ archivedAt: now, updatedByAccountId: auth.accountId, updatedAt: now })
          .where(eq(alertRecipient.id, existing.id));
        await audit.record(tx, {
          actorAccountId: auth.accountId,
          operatorId: auth.operatorId,
          branchId: existing.branchId,
          action: 'ops.alert_recipient_archive',
          entityType: 'alert_recipient',
          entityId: existing.id,
          sourceApp: 'console',
          before: { category: existing.category, channel: existing.channel, addressRef: existing.addressRef },
          after: { archivedAt: now.toISOString() },
          requestId: req.id,
        });
        return { ok: true as const };
      });
    },
  );
}
