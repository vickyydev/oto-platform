import { createHash, randomUUID } from "node:crypto";
import { and, desc, eq, lt, sql } from "drizzle-orm";
import { db } from "./db";
import { branches, sopArticles, sopArticleRevisions, type SopArticle, type SopContent,
  type InsertSopArticle, type UserWithBranchAccess } from "@shared/schema";

export class SopChangeError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Actor = { user: UserWithBranchAccess; tenantId: string };
export type SopChange = { expectedVersion?: number; mutationId?: string } & (
  { changes: Partial<InsertSopArticle>; restoreRevisionId?: never } |
  { restoreRevisionId: string; changes?: never }
);

const contentKeys = ["title", "body", "departments", "readingTime", "coverImageUrl", "summary",
  "structuredSteps", "steps", "rules", "commonMistakes", "unsureTips"] as const;
const contentOf = (article: SopArticle): SopContent => Object.fromEntries(
  contentKeys.map(key => [key, article[key]]),
) as SopContent;

function canonical(value: unknown): string {
  if (value === undefined) return "null";
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value)
    .filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  return JSON.stringify(value);
}

async function assertScope(tx: Transaction, actor: Actor, article: SopArticle) {
  if (article.tenantId !== actor.tenantId || !["admin", "global_admin", "operator_admin"].includes(actor.user.role))
    throw new SopChangeError(404, "SOP article not found");
  if (article.scope === "GLOBAL" && article.branchIds.length === 0) return;
  if (article.scope !== "BRANCHES" || !article.branchIds.length ||
      (!actor.user.hasAllBranchesAccess && article.branchIds.some(id => !actor.user.allowedBranchIds.includes(id))))
    throw new SopChangeError(404, "SOP article not found");
  for (const id of article.branchIds) {
    const [branch] = await tx.select({ tenantId: branches.tenantId }).from(branches).where(eq(branches.id, id));
    if (branch?.tenantId !== actor.tenantId) throw new SopChangeError(404, "SOP article not found");
  }
}

async function lockedArticle(tx: Transaction, id: string, actor: Actor, mode: "update" | "share") {
  const [article] = await tx.select().from(sopArticles)
    .where(and(eq(sopArticles.id, id), eq(sopArticles.tenantId, actor.tenantId))).for(mode);
  if (!article) throw new SopChangeError(404, "SOP article not found");
  await assertScope(tx, actor, article);
  return article;
}

/** Snapshot and replacement share one row lock, including retries and restores. */
export async function changeSopArticle(id: string, actor: Actor, change: SopChange) {
  const requestHash = createHash("sha256").update(canonical(change)).digest("hex");
  return db.transaction(async tx => {
    const existing = await lockedArticle(tx, id, actor, "update");
    if (change.mutationId) {
      const [replay] = await tx.select().from(sopArticleRevisions).where(and(
        eq(sopArticleRevisions.articleId, id), eq(sopArticleRevisions.mutationId, change.mutationId),
      ));
      if (replay) {
        if (replay.savedById !== actor.user.id || replay.requestHash !== requestHash)
          throw new SopChangeError(409, "This save identifier was already used. Reload the SOP before saving.");
        return replay.result;
      }
    }
    if (change.expectedVersion !== undefined && existing.editVersion !== change.expectedVersion)
      throw new SopChangeError(409, "This SOP has changed. Reload it before saving.");
    let changes: Partial<InsertSopArticle>;
    if (change.restoreRevisionId) {
      const [revision] = await tx.select().from(sopArticleRevisions).where(and(
        eq(sopArticleRevisions.id, change.restoreRevisionId), eq(sopArticleRevisions.articleId, id),
        eq(sopArticleRevisions.tenantId, actor.tenantId),
      ));
      if (!revision) throw new SopChangeError(404, "SOP revision not found");
      // Restore only content. Current publication and branch visibility remain in force.
      changes = revision.content;
    } else {
      changes = change.changes ?? {};
    }
    const next = { ...existing, ...changes, tenantId: existing.tenantId };
    await assertScope(tx, actor, next);
    const changed = Object.entries(changes).some(([key, value]) =>
      canonical(existing[key as keyof SopArticle]) !== canonical(value));
    // Older callers without mutation metadata retain their ordinary update contract.
    if (!changed && !change.mutationId) return existing;
    const [updated] = await tx.update(sopArticles).set({ ...changes, tenantId: existing.tenantId,
      editVersion: existing.editVersion + 1, lastUpdated: new Date() })
      .where(eq(sopArticles.id, id)).returning();
    await tx.insert(sopArticleRevisions).values({ articleId: id, tenantId: actor.tenantId,
      version: existing.editVersion, content: contentOf(existing), previousStatus: existing.status,
      savedById: actor.user.id, savedByName: actor.user.fullName, mutationId: change.mutationId ?? randomUUID(),
      requestHash, result: updated });
    return updated;
  });
}

export async function listSopRevisions(id: string, actor: Actor, beforeVersion?: number) {
  return db.transaction(async tx => {
    await lockedArticle(tx, id, actor, "share");
    const rows = await tx.select({ id: sopArticleRevisions.id, version: sopArticleRevisions.version,
      previousStatus: sopArticleRevisions.previousStatus, savedById: sopArticleRevisions.savedById,
      savedByName: sopArticleRevisions.savedByName, savedAt: sopArticleRevisions.savedAt,
      title: sql<string>`${sopArticleRevisions.content}->>'title'` }).from(sopArticleRevisions).where(and(
      eq(sopArticleRevisions.articleId, id), eq(sopArticleRevisions.tenantId, actor.tenantId),
      beforeVersion === undefined ? undefined : lt(sopArticleRevisions.version, beforeVersion),
    )).orderBy(desc(sopArticleRevisions.version)).limit(50);
    return { items: rows,
      nextBeforeVersion: rows.length === 50 ? rows[rows.length - 1].version : null };
  });
}

export async function getSopRevision(id: string, revisionId: string, actor: Actor) {
  return db.transaction(async tx => {
    await lockedArticle(tx, id, actor, "share");
    const [row] = await tx.select({ id: sopArticleRevisions.id, version: sopArticleRevisions.version,
      content: sopArticleRevisions.content, previousStatus: sopArticleRevisions.previousStatus,
      savedById: sopArticleRevisions.savedById, savedByName: sopArticleRevisions.savedByName,
      savedAt: sopArticleRevisions.savedAt }).from(sopArticleRevisions).where(and(
      eq(sopArticleRevisions.id, revisionId), eq(sopArticleRevisions.articleId, id),
      eq(sopArticleRevisions.tenantId, actor.tenantId),
    ));
    if (!row) throw new SopChangeError(404, "SOP revision not found");
    return row;
  });
}
