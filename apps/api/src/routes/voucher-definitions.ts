import { z } from 'zod';
import { VOUCHER_KINDS, VOUCHER_OFFLINE_POLICIES, VOUCHER_VALUE_TYPES } from '@oto/db';
import type { App } from '../app';
import {
  archiveVoucherDefinition,
  createVoucherDefinition,
  listVoucherDefinitions,
  loadVoucherDefinition,
  restoreVoucherDefinition,
  updateVoucherDefinition,
  voucherDefinitionLinkOptions,
} from '../services/voucher-definitions';
import { opCtx } from '../services/tx';

/**
 * Voucher types in the Console (SCRUM-400, S2-07d): what a booth prize is
 * worth and what its slip says, created and edited by the park.
 *
 * GET, POST and PATCH `/voucher-definitions` moved here from `routes/booth.ts`
 * with their paths and permissions unchanged. Their answers changed: a
 * definition is now `VoucherDefinitionView` — no `operatorId`, the slip's
 * title and instruction beside the terms, the linked `product` or
 * `ticketPackage` named, and `usedBy` listing the prizes that point at it —
 * the list is ordered by English name rather than by code, and every route
 * declares its response schema. A save is now checked whole
 * (`settleValue`), where before only a missing amount or percentage was
 * refused, and a PATCH with nothing in it is refused rather than audited.
 * This file adds the archive, the restore and the pickers' read. The rules
 * are in `services/voucher-definitions.ts`, which says what each field does
 * and when it takes effect.
 *
 * **Operator-wide, like the wheel designs.** A definition is shared by every
 * booth of the operator, so these routes name no branch: the guard checks the
 * permission against the caller's operator and session branch, and every
 * by-id route loads the row inside the caller's operator before it acts
 * (`loadVoucherDefinition`), so another operator's id is a 404.
 *
 * **Two permissions, the booth family's own.** `admin:booth:read` to look —
 * the Booths page's prize picker already reads the list with it — and
 * `admin:booth:manage` to change, the same permission that edits the prizes
 * pointing at these rows. No catalogue permission is involved: the products
 * and packages a definition links to are named here, never changed.
 */

/** Words that go on paper. Capped so a slip stays a slip; the service trims them. */
const Words = (max: number) => z.string().max(max).nullable().optional();

const DefinitionBody = z.object({
  /**
   * The stable slug imports and reports name a definition by. Unique for the
   * life of the operator — archiving does not free it.
   */
  code: z
    .string()
    .regex(/^[a-z0-9][a-z0-9-]{1,60}$/, 'A code is lower-case letters, digits and hyphens'),
  nameEn: z
    .string()
    .max(120)
    .refine((name) => name.trim().length > 0, { message: 'A voucher type needs a name' }),
  nameTh: z.string().max(120).nullable().optional(),
  kind: z.enum(VOUCHER_KINDS),
  valueType: z.enum(VOUCHER_VALUE_TYPES).optional(),
  valueSatang: z.number().int().min(0).nullable().optional(),
  valueBp: z.number().int().min(0).max(10_000).nullable().optional(),
  /** What a free product hands over: one of the operator's products. */
  productId: z.string().uuid().nullable().optional(),
  /** What a 1+1 kids ticket applies to: one of the operator's ticket packages. */
  ticketPackageId: z.string().uuid().nullable().optional(),
  /**
   * Days, counted from the moment a voucher is won. Null never expires, which
   * the owner allows per prize. Capped at a century: a larger number is a
   * typo, and one past about a hundred million days is a date no box can
   * print.
   */
  expiryDays: z.number().int().positive().max(36_500).nullable().optional(),
  /** Governs the legacy import and manual issue. A booth voucher is online only, whatever this says. */
  offlinePolicy: z.enum(VOUCHER_OFFLINE_POLICIES).optional(),
  singleUse: z.boolean().optional(),
  costSatang: z.number().int().min(0).optional(),
  /** The slip's title and instruction line, exactly as they print. */
  titleEn: Words(80),
  titleTh: Words(80),
  instructionEn: Words(240),
  instructionTh: Words(240),
  /** The small print, a line each at the foot of the slip. */
  termsEn: Words(2000),
  termsTh: Words(2000),
  active: z.boolean().optional(),
});

const LinkSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  code: z.string().nullable(),
  branchId: z.string().uuid().nullable(),
  branchName: z.string().nullable(),
  live: z.boolean(),
});

const DefinitionSchema = z.object({
  id: z.string().uuid(),
  code: z.string(),
  nameEn: z.string(),
  nameTh: z.string().nullable(),
  kind: z.enum(VOUCHER_KINDS),
  valueType: z.enum(VOUCHER_VALUE_TYPES),
  valueSatang: z.number().int().nullable(),
  valueBp: z.number().int().nullable(),
  productId: z.string().uuid().nullable(),
  ticketPackageId: z.string().uuid().nullable(),
  expiryDays: z.number().int().nullable(),
  offlinePolicy: z.enum(VOUCHER_OFFLINE_POLICIES),
  singleUse: z.boolean(),
  costSatang: z.number().int(),
  titleEn: z.string().nullable(),
  titleTh: z.string().nullable(),
  instructionEn: z.string().nullable(),
  instructionTh: z.string().nullable(),
  termsEn: z.string().nullable(),
  termsTh: z.string().nullable(),
  active: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
  archivedAt: z.string().nullable(),
  product: LinkSchema.nullable(),
  ticketPackage: LinkSchema.nullable(),
  usedBy: z.array(
    z.object({
      boothId: z.string().uuid(),
      boothName: z.string(),
      branchId: z.string().uuid(),
      prizeId: z.string().uuid(),
      prizeName: z.string(),
      prizeNameTh: z.string().nullable(),
      active: z.boolean(),
    }),
  ),
});

const OneDefinition = z.object({ definition: DefinitionSchema });
const IdParams = z.object({ id: z.string().uuid() });

export async function voucherDefinitionRoutes(app: App): Promise<void> {
  app.get(
    '/voucher-definitions',
    {
      config: { permission: 'admin:booth:read' },
      schema: {
        description:
          'What the park gives away: the template behind every voucher — kind and value, the product or ticket package it hands over, the slip’s title, instruction and terms in English and Thai, and its expiry (null never expires) — each with the product or package named and the booth prizes that point at it. What a voucher is worth is read from here when it is redeemed, so editing the value changes vouchers already printed. What a slip says follows the wheel version its booth is running, not this row as it is now: a type that version carries words for (it had a title or an instruction when the version was published) prints that version’s title, instruction and terms until the booth’s next publish, whatever is edited meanwhile; any other type — one given its first title or instruction since included — prints the prize’s names, the standard line and these terms as of the box’s last pull. The expiry is read from here when a voucher is won — by the box, from its last pull, when the prize names no days of its own — counted from that moment and copied onto the voucher, so a change applies to vouchers won after the box’s next pull.',
        querystring: z.object({ includeArchived: z.enum(['true', 'false']).default('false') }),
        response: { 200: z.object({ definitions: z.array(DefinitionSchema) }) },
      },
    },
    async (req) => {
      const auth = req.requireAuth();
      return listVoucherDefinitions(app.db, auth.operatorId, req.query.includeArchived === 'true');
    },
  );

  app.get(
    '/voucher-definitions/link-options',
    {
      config: { permission: 'admin:booth:read' },
      schema: {
        description:
          'What a voucher type can point at: the operator’s products on sale and its live ticket packages, each with its branch. A 1+1’s package is honoured at any park with a live ticket package of the same name, so its branch is only where the link was made. A free product is honoured only where it is on sale — its own park, or every park when it belongs to no branch — and, once it is archived, at a park with a live product of its own with the same code.',
        response: {
          200: z.object({
            products: z.array(
              z.object({
                id: z.string().uuid(),
                name: z.string(),
                code: z.string().nullable(),
                kind: z.string(),
                branchId: z.string().uuid().nullable(),
                branchName: z.string().nullable(),
                priceSatang: z.number().int(),
              }),
            ),
            packages: z.array(
              z.object({
                id: z.string().uuid(),
                name: z.string(),
                branchId: z.string().uuid(),
                branchName: z.string(),
              }),
            ),
          }),
        },
      },
    },
    async (req) => {
      const auth = req.requireAuth();
      return voucherDefinitionLinkOptions(app.db, auth.operatorId);
    },
  );

  app.post(
    '/voucher-definitions',
    {
      config: { permission: 'admin:booth:manage' },
      schema: {
        description:
          'Create a voucher type. Refused unless it is whole: an amount off needs an amount above zero, a percentage off a percentage above zero, a free product one of this operator’s products, and a 1+1 kids ticket one of its ticket packages. Answers 201; a replay of the same Idempotency-Key answers 200 with the same body.',
        body: DefinitionBody,
        response: { 200: OneDefinition, 201: OneDefinition },
      },
    },
    async (req, reply) => {
      const auth = req.requireAuth();
      const created = await createVoucherDefinition(
        app.db,
        opCtx(req),
        { accountId: auth.accountId, operatorId: auth.operatorId },
        req.body,
      );
      return reply.code(201).send(created);
    },
  );

  app.patch(
    '/voucher-definitions/:id',
    {
      config: { permission: 'admin:booth:manage' },
      schema: {
        description:
          'Edit a voucher type. Checked as it will be after the edit, by the same rules as create, and the fields its kind does not read are cleared. Switching one off is refused at publish for any active prize pointing at it. An archived type is refused (409 VOUCHER_DEFINITION_ARCHIVED) until it is restored. A body naming no field is refused (400, "Nothing to change") and writes nothing, like the booth settings route.',
        params: IdParams,
        // An empty patch would otherwise write an audit row and move
        // `updatedAt` for an edit nobody made.
        body: DefinitionBody.partial().refine((body) => Object.keys(body).length > 0, {
          message: 'Nothing to change',
        }),
        response: { 200: OneDefinition },
      },
    },
    async (req) => {
      const auth = req.requireAuth();
      const before = await loadVoucherDefinition(app.db, auth.operatorId, req.params.id);
      return updateVoucherDefinition(
        app.db,
        opCtx(req),
        { accountId: auth.accountId, operatorId: auth.operatorId },
        before,
        req.body,
      );
    },
  );

  app.delete(
    '/voucher-definitions/:id',
    {
      config: { permission: 'admin:booth:manage' },
      schema: {
        description:
          'Archive a voucher type — never deleted, because its vouchers point at it and the ones in families’ hands are still honoured. A booth prize pointing at it cannot be published afterwards; the booths keep what they are running until then. Archiving one already archived answers with it and records nothing.',
        params: IdParams,
        response: { 200: OneDefinition },
      },
    },
    async (req) => {
      const auth = req.requireAuth();
      const before = await loadVoucherDefinition(app.db, auth.operatorId, req.params.id);
      return archiveVoucherDefinition(
        app.db,
        opCtx(req),
        { accountId: auth.accountId, operatorId: auth.operatorId },
        before,
      );
    },
  );

  app.post(
    '/voucher-definitions/:id/restore',
    {
      config: { permission: 'admin:booth:manage' },
      schema: {
        description:
          'Bring an archived voucher type back, switched on. One that is not archived answers with itself and records nothing.',
        params: IdParams,
        response: { 200: OneDefinition },
      },
    },
    async (req) => {
      const auth = req.requireAuth();
      const before = await loadVoucherDefinition(app.db, auth.operatorId, req.params.id);
      return restoreVoucherDefinition(
        app.db,
        opCtx(req),
        { accountId: auth.accountId, operatorId: auth.operatorId },
        before,
      );
    },
  );
}
