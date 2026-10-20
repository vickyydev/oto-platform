import { and, asc, eq, isNull, ne, or, sql, type SQL } from 'drizzle-orm';
import { branch, fileObject, template, type Db } from '@oto/db';
import {
  templateVariables,
  type InboxManagedTemplate,
  type InboxTemplateCreate,
  type InboxTemplatePatch,
} from '@oto/shared';
import { AppError, errors } from '../../lib/errors';
import { audit } from '../audit';
import { claimClientId, markReplay } from '../client-id';
import type { FileStorage } from '../files';
import type { Exec, Tx } from '../tx';

/**
 * THE INBOX'S TEMPLATES, MANAGED (S2-19 I2f, SCRUM-585; plan §3.3
 * "POST/PATCH /inbox/templates", `docs/features/inbox.md` "Templates").
 *
 * A template is one KEY (the eight the briefs define) in one LANGUAGE,
 * optionally narrowed to one CHANNEL and one BRANCH — the variants. Only one
 * live row may stand for a (key, language, channel, branch), which the
 * database's partial unique index holds; a second answers 409
 * `TEMPLATE_EXISTS`.
 *
 * `approval_status` is the provider's verdict on `provider_template_name`:
 * `not_required` on a channel with no approvals (the simulator, until a Meta
 * account exists), else `pending` → `approved` or `rejected`. It decides
 * whether the template may open a closed 24-hour window (`@oto/shared`
 * `templateQualifiesOutsideWindow`). Recording Meta's verdict is an edit here;
 * nothing submits a template to Meta in this story.
 *
 * DEACTIVATE is `active=false` (the composer stops offering it, the row
 * stays editable); ARCHIVE retires it for good and frees its variant for a
 * new row. Nothing is deleted. Every write is one transaction with its audit
 * row; the audit row names the key, language, channel, branch and status, and
 * the body's length — never the body.
 *
 * The brief's seeded set (`platformSync`, insert-if-absent) is untouched by
 * any of this: an edit here is never overwritten by a deploy.
 */

type TemplateRow = typeof template.$inferSelect;

export function managedTemplate(t: TemplateRow): InboxManagedTemplate {
  return {
    id: t.id,
    key: t.key,
    language: t.language,
    channel: t.channel,
    branchId: t.branchId,
    body: t.body,
    attachmentFileIds: t.attachmentFileIds,
    approvalStatus: t.approvalStatus,
    needsTranslation: t.needsTranslation,
    providerTemplateName: t.providerTemplateName,
    active: t.active,
    variables: templateVariables(t.body),
    updatedByAccountId: t.updatedByAccountId,
    updatedAt: t.updatedAt.toISOString(),
    archivedAt: t.archivedAt?.toISOString() ?? null,
  };
}

/** What an audit row may say about a template: never its words. */
function auditShape(t: Pick<TemplateRow, 'key' | 'language' | 'channel' | 'branchId' | 'approvalStatus' | 'active' | 'providerTemplateName' | 'body' | 'archivedAt'>) {
  return {
    key: t.key,
    language: t.language,
    channel: t.channel,
    branchId: t.branchId,
    approvalStatus: t.approvalStatus,
    active: t.active,
    providerTemplateName: t.providerTemplateName,
    length: [...t.body].length,
    variables: templateVariables(t.body),
    archived: t.archivedAt !== null,
  };
}

export async function listManagedTemplates(
  db: Db,
  operatorId: string,
  query: { key?: string; language?: string; archived?: 'true' | 'false' },
): Promise<{ templates: InboxManagedTemplate[] }> {
  const where: SQL[] = [eq(template.operatorId, operatorId)];
  if (query.archived !== 'true') where.push(isNull(template.archivedAt));
  if (query.key) where.push(eq(template.key, query.key as TemplateRow['key']));
  if (query.language) where.push(eq(template.language, query.language));
  const rows = await db
    .select()
    .from(template)
    .where(and(...where))
    .orderBy(asc(template.key), asc(template.language), asc(sql`coalesce(${template.channel}, '')`), asc(template.id));
  return { templates: rows.map(managedTemplate) };
}

/** A template of this operator by id, archived or not; 404 for anyone else's. */
export async function loadTemplate(db: Exec, operatorId: string, id: string): Promise<TemplateRow> {
  const [row] = await db
    .select()
    .from(template)
    .where(and(eq(template.operatorId, operatorId), eq(template.id, id)))
    .limit(1);
  if (!row) throw errors.notFound('Template not found');
  return row;
}

async function assertBranchInOperator(db: Exec, operatorId: string, branchId: string | null | undefined): Promise<void> {
  if (!branchId) return;
  const [row] = await db
    .select({ id: branch.id })
    .from(branch)
    .where(and(eq(branch.id, branchId), eq(branch.operatorId, operatorId)))
    .limit(1);
  if (!row) throw errors.notFound('No such branch');
}

/** The live row that already stands for this variant, other than `exceptId`. */
async function variantTaken(
  tx: Tx,
  operatorId: string,
  v: { key: string; language: string; channel: string | null; branchId: string | null },
  exceptId?: string,
): Promise<boolean> {
  const [row] = await tx
    .select({ id: template.id })
    .from(template)
    .where(
      and(
        eq(template.operatorId, operatorId),
        eq(template.key, v.key as TemplateRow['key']),
        eq(template.language, v.language),
        v.channel === null ? isNull(template.channel) : eq(template.channel, v.channel as NonNullable<TemplateRow['channel']>),
        v.branchId === null ? isNull(template.branchId) : eq(template.branchId, v.branchId),
        isNull(template.archivedAt),
        ...(exceptId ? [ne(template.id, exceptId)] : []),
      ),
    )
    .limit(1);
  return Boolean(row);
}

const taken = () =>
  errors.conflict(
    'TEMPLATE_EXISTS',
    'A live template already stands for this key, language, channel and branch — edit that one, or archive it first.',
  );

export interface TemplateWriteCtx {
  operatorId: string;
  accountId: string;
  requestId: string;
  now: Date;
}

export async function createTemplate(
  tx: Tx,
  ctx: TemplateWriteCtx,
  input: InboxTemplateCreate,
): Promise<InboxManagedTemplate> {
  const channel = input.channel ?? null;
  const branchId = input.branchId ?? null;
  // A body id names the row: the same id again is this template, answered as it stands.
  const claim = await claimClientId(
    input.id,
    async (id) => (await tx.select().from(template).where(eq(template.id, id)).limit(1))[0],
    (row) => row.operatorId === ctx.operatorId && row.key === input.key && row.language === input.language,
  );
  if (claim.replay) return markReplay(managedTemplate(claim.row));
  await assertBranchInOperator(tx, ctx.operatorId, branchId);
  if (await variantTaken(tx, ctx.operatorId, { key: input.key, language: input.language, channel, branchId })) {
    throw taken();
  }
  const [made] = await tx
    .insert(template)
    .values({
      id: claim.id,
      operatorId: ctx.operatorId,
      key: input.key,
      language: input.language,
      channel,
      branchId,
      body: input.body,
      providerTemplateName: input.providerTemplateName ?? null,
      approvalStatus: input.approvalStatus ?? 'not_required',
      needsTranslation: input.needsTranslation ?? false,
      active: input.active ?? true,
      updatedByAccountId: ctx.accountId,
      createdAt: ctx.now,
      updatedAt: ctx.now,
    })
    .returning();
  await audit.record(tx, {
    actorAccountId: ctx.accountId,
    action: 'inbox.template.create',
    entityType: 'inbox.template',
    entityId: made!.id,
    operatorId: ctx.operatorId,
    branchId,
    requestId: ctx.requestId,
    after: auditShape(made!),
  });
  return managedTemplate(made!);
}

export async function updateTemplate(
  tx: Tx,
  ctx: TemplateWriteCtx,
  before: TemplateRow,
  patch: InboxTemplatePatch,
): Promise<InboxManagedTemplate> {
  if (before.archivedAt) throw errors.conflict('TEMPLATE_ARCHIVED', 'This template is archived and cannot be edited.');
  const next = {
    language: patch.language ?? before.language,
    channel: patch.channel === undefined ? before.channel : patch.channel,
    branchId: patch.branchId === undefined ? before.branchId : patch.branchId,
  };
  await assertBranchInOperator(tx, ctx.operatorId, next.branchId);
  if (await variantTaken(tx, ctx.operatorId, { key: before.key, ...next }, before.id)) throw taken();
  const [after] = await tx
    .update(template)
    .set({
      ...next,
      ...(patch.body !== undefined ? { body: patch.body } : {}),
      ...(patch.providerTemplateName !== undefined ? { providerTemplateName: patch.providerTemplateName } : {}),
      ...(patch.approvalStatus !== undefined ? { approvalStatus: patch.approvalStatus } : {}),
      ...(patch.active !== undefined ? { active: patch.active } : {}),
      ...(patch.needsTranslation !== undefined ? { needsTranslation: patch.needsTranslation } : {}),
      updatedByAccountId: ctx.accountId,
      updatedAt: ctx.now,
    })
    .where(and(eq(template.operatorId, ctx.operatorId), eq(template.id, before.id)))
    .returning();
  await audit.record(tx, {
    actorAccountId: ctx.accountId,
    action: patch.active === false && before.active ? 'inbox.template.deactivate' : 'inbox.template.update',
    entityType: 'inbox.template',
    entityId: before.id,
    operatorId: ctx.operatorId,
    branchId: after!.branchId,
    requestId: ctx.requestId,
    before: auditShape(before),
    after: { ...auditShape(after!), bodyChanged: patch.body !== undefined && patch.body !== before.body },
  });
  return managedTemplate(after!);
}

export async function archiveTemplate(
  tx: Tx,
  ctx: TemplateWriteCtx,
  before: TemplateRow,
): Promise<InboxManagedTemplate> {
  // Archiving twice is the same act: answered as it stands, written once.
  if (before.archivedAt) return managedTemplate(before);
  const [after] = await tx
    .update(template)
    .set({ archivedAt: ctx.now, active: false, updatedByAccountId: ctx.accountId, updatedAt: ctx.now })
    .where(and(eq(template.operatorId, ctx.operatorId), eq(template.id, before.id)))
    .returning();
  await audit.record(tx, {
    actorAccountId: ctx.accountId,
    action: 'inbox.template.archive',
    entityType: 'inbox.template',
    entityId: before.id,
    operatorId: ctx.operatorId,
    branchId: before.branchId,
    requestId: ctx.requestId,
    before: auditShape(before),
    after: auditShape(after!),
  });
  return managedTemplate(after!);
}

// --- The brochure (SCRUM-590 A3, plan §C.5) ------------------------------------------------

/** The largest brochure a template may carry. WhatsApp allows far more; a park's PDF is a few MB. */
export const INBOX_BROCHURE_MAX_BYTES = 10 * 1024 * 1024;

/** The types a brochure may be, each with its file signature and extension. */
export const INBOX_BROCHURE_TYPES: Record<string, { ext: string; matches: (b: Buffer) => boolean }> = {
  'application/pdf': { ext: 'pdf', matches: (b) => b.length >= 5 && b.toString('ascii', 0, 5) === '%PDF-' },
  'image/jpeg': { ext: 'jpg', matches: (b) => b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  'image/png': {
    ext: 'png',
    matches: (b) => b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])),
  },
  'image/webp': {
    ext: 'webp',
    matches: (b) => b.length >= 12 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP',
  },
};

export const BROCHURE_MESSAGES = {
  wrongType: 'A brochure must be a PDF or a JPEG, PNG or WebP image.',
  tooLarge: `A brochure can be at most ${INBOX_BROCHURE_MAX_BYTES / (1024 * 1024)} MB. Send a smaller file.`,
  empty: 'The file is empty. Choose the brochure file again.',
} as const;

export const brochureTooLarge = () => new AppError(413, 'BROCHURE_TOO_LARGE', BROCHURE_MESSAGES.tooLarge);
export const brochureWrongType = () => new AppError(415, 'BROCHURE_WRONG_TYPE', BROCHURE_MESSAGES.wrongType);

/** The type the bytes really are, checked against what the caller said; refused in a sentence otherwise. */
export function brochureTypeOf(contentTypeHeader: string | undefined, bytes: unknown): { contentType: string; ext: string } {
  const contentType = String(contentTypeHeader ?? '').split(';', 1)[0]!.trim().toLowerCase();
  const kind = INBOX_BROCHURE_TYPES[contentType];
  if (!kind || !Buffer.isBuffer(bytes)) throw brochureWrongType();
  if (bytes.length === 0) throw errors.badRequest(BROCHURE_MESSAGES.empty);
  if (bytes.length > INBOX_BROCHURE_MAX_BYTES) throw brochureTooLarge();
  if (!kind.matches(bytes)) throw brochureWrongType();
  return { contentType, ext: kind.ext };
}

/**
 * Put a brochure on a template: the bytes stored as a file OWNED by the
 * template (`inbox.template` — the send path links only `inbox.*` files), and
 * the template's `attachment_file_ids` set to exactly that file. A replace
 * uploads a new file and swaps the id; the previous file is left UNLINKED,
 * not deleted — a queued assistant line or a sent message may still name it,
 * and the send path would refuse a file that is gone. The object goes to
 * storage before the row; a rolled-back transaction leaves at most an
 * orphaned object, never a row naming nothing. Audit: ids only.
 */
export async function setTemplateBrochure(
  tx: Tx,
  storage: FileStorage,
  ctx: TemplateWriteCtx,
  before: TemplateRow,
  file: { id: string; bytes: Buffer; contentType: string; ext: string },
): Promise<InboxManagedTemplate> {
  if (before.archivedAt) throw errors.conflict('TEMPLATE_ARCHIVED', 'This template is archived and cannot be edited.');
  const objectKey = `${ctx.operatorId}/inbox.template/${before.id}/${file.id}.${file.ext}`;
  try {
    await storage.put(objectKey, file.bytes, file.contentType);
  } catch (err) {
    if (err instanceof AppError) throw err;
    throw new AppError(503, 'STORAGE_UNAVAILABLE', 'File storage is unavailable — try again in a moment');
  }
  await tx.insert(fileObject).values({
    id: file.id,
    operatorId: ctx.operatorId,
    bucket: storage.bucket,
    objectKey,
    contentType: file.contentType,
    size: file.bytes.length,
    ownerEntityType: 'inbox.template',
    ownerEntityId: before.id,
    uploadedByAccountId: ctx.accountId,
  });
  const [after] = await tx
    .update(template)
    .set({ attachmentFileIds: [file.id], updatedByAccountId: ctx.accountId, updatedAt: ctx.now })
    .where(and(eq(template.operatorId, ctx.operatorId), eq(template.id, before.id)))
    .returning();
  await audit.record(tx, {
    actorAccountId: ctx.accountId,
    action: 'inbox.template.brochure',
    entityType: 'inbox.template',
    entityId: before.id,
    operatorId: ctx.operatorId,
    branchId: before.branchId,
    requestId: ctx.requestId,
    before: { attachmentFileIds: before.attachmentFileIds },
    after: { attachmentFileIds: [file.id], key: before.key, language: before.language, contentType: file.contentType, size: file.bytes.length },
  });
  return managedTemplate(after!);
}

/**
 * The templates a thread may be sent from: live, active, of this operator, for
 * any channel or this one, any branch or this one. `outsideWindow` narrows to
 * the ones that may open a closed window. The customer's language first, then
 * English, then the rest; the more specific variant first.
 */
export async function templatesForThread(
  db: Exec,
  thread: { operatorId: string; channel: string; branchId: string | null; language: string | null },
  opts: { outsideWindow: boolean },
): Promise<TemplateRow[]> {
  const rows = await db
    .select()
    .from(template)
    .where(
      and(
        eq(template.operatorId, thread.operatorId),
        eq(template.active, true),
        isNull(template.archivedAt),
        or(isNull(template.channel), eq(template.channel, thread.channel as NonNullable<TemplateRow['channel']>)),
        thread.branchId ? or(isNull(template.branchId), eq(template.branchId, thread.branchId)) : isNull(template.branchId),
        ...(opts.outsideWindow ? [sql`${template.approvalStatus} in ('approved', 'not_required')`] : []),
      ),
    );
  const lang = (thread.language ?? 'en').toLowerCase();
  const rank = (t: TemplateRow) =>
    (t.language === lang ? 0 : t.language === 'en' ? 10 : 20) - (t.channel ? 2 : 0) - (t.branchId ? 1 : 0);
  return rows.sort((a, b) => rank(a) - rank(b) || a.key.localeCompare(b.key) || a.id.localeCompare(b.id));
}
