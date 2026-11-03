import { and, eq, inArray, or } from "drizzle-orm";
import { z } from "zod";
import { branches, type UserWithBranchAccess } from "@shared/schema";
import { canUserAccessBranch } from "../auth-middleware";
import { db } from "../db";
import { checklistAttachments } from "../db/coreSchema";
import { log } from "../lib/logger";
import { storage } from "../storage";
import { requestedChecklistAssignees } from "./checklistAssignees";

/**
 * Making a checklist, and making an independent copy of one (SCRUM-659).
 *
 * Creating a checklist for two branches has always made one template per
 * branch. Editing one and adding a branch only widens `branch_ids` on the same
 * row, which is one shared template. The owner's ruling of 3 November 2026
 * keeps both and lets the editor choose: a copy goes through exactly the path a
 * new checklist goes through, so there is one set of checks and one storage
 * call, and the only things it adds are what it takes from the original and the
 * original's reference media.
 */

type BranchBound = { branchId?: string | null; branchIds?: string[] | null };

export type ChecklistRefusal = { status: number; message: string };

/**
 * The branches a template runs at: its list, else its one branch. None means
 * every branch. The same reading as the recurring run creator and the media
 * routes.
 */
export function checklistTemplateBranches(template: BranchBound): string[] {
  if (template.branchIds?.length) return template.branchIds;
  return template.branchId ? [template.branchId] : [];
}

/**
 * Whether a person can reach this template at all: any one of its branches, or
 * a template bound to no branch. Staff at the second branch of a shared
 * checklist run it and open its media, so they can read it and copy it too.
 */
export function canReachChecklistTemplate(user: UserWithBranchAccess, template: BranchBound): boolean {
  const named = [...(template.branchId ? [template.branchId] : []), ...(template.branchIds ?? [])];
  return named.length === 0 || named.some((branchId) => canUserAccessBranch(user, branchId));
}

export type PreparedChecklistTemplates = {
  fields: Omit<Parameters<typeof storage.createChecklistTemplate>[0], "tenantId" | "branchId" | "createdBy">;
  // Items arrive from the client as it sent them; the storage call reads the fields it knows.
  items: any[];
  selectedBranchIds: string[];
  branchesToCreate: Array<string | null>;
};

/** Everything a new checklist is checked against, before anything is written. */
export function prepareChecklistTemplates(
  user: UserWithBranchAccess,
  // The create route's body, unvalidated beyond what is checked here.
  body: any,
): { refusal: ChecklistRefusal } | { prepared: PreparedChecklistTemplates } {
  const {
    name, description, branchId, branchIds, departmentId, recurrence, scheduledTime,
    items, assignedRoleId, assignedDepartmentId,
    locationId, requiresPhotoEvidence, referenceMediaUrls, weeklyDays, monthlyDay,
    // Checker-specific fields
    checklistType, checkerRounds, scheduleTime1, scheduleTime2, scheduleTime3, scheduleTime4, scheduleTime5, allowedCheckerRoles,
  } = body;

  if (!name) {
    return { refusal: { status: 400, message: "Name is required" } };
  }
  // The employees it names: `assignedEmployeeIds`, or the older single
  // `assignedEmployeeId` (SCRUM-658).
  const assignedEmployeeIds = requestedChecklistAssignees(body) ?? [];

  // Handle branchIds array (new multi-select) or legacy branchId
  const selectedBranchIds: string[] = branchIds && branchIds.length > 0 ? branchIds : (branchId ? [branchId] : []);

  // Validate branch access for non-admins
  let effectiveBranchId: string | null = selectedBranchIds.length > 0 ? selectedBranchIds[0] : null;
  if (!user.hasAllBranchesAccess) {
    // Non-admins cannot create global (null branchId) templates
    if (!effectiveBranchId) {
      // Default to user's first accessible branch
      if (user.allowedBranchIds.length === 0) {
        return { refusal: { status: 403, message: "No branch access configured" } };
      }
      effectiveBranchId = user.allowedBranchIds[0];
    } else {
      // Verify access to all specified branches
      for (const bid of selectedBranchIds) {
        if (!canUserAccessBranch(user, bid)) {
          return { refusal: { status: 403, message: "Access denied to create templates for one or more branches" } };
        }
      }
    }
  }

  const isChecker = checklistType === "checker";
  const itemWithInvalidEvidenceFlags = Array.isArray(items)
    ? items.find((item: any) =>
        (item.requiresPhoto !== undefined && typeof item.requiresPhoto !== "boolean")
        || (item.cameraEnabled !== undefined && typeof item.cameraEnabled !== "boolean")
        || (item.galleryEnabled !== undefined && typeof item.galleryEnabled !== "boolean")
      )
    : null;
  if (itemWithInvalidEvidenceFlags) {
    return { refusal: { status: 400, message: "Checklist item photo settings must be true or false" } };
  }
  const sanitizedItems = Array.isArray(items)
    ? items.map((item: any) => {
        const galleryEnabled = item.galleryEnabled ?? false;
        const configuredCameraEnabled = item.cameraEnabled ?? true;
        return {
          ...item,
          requiresPhoto: item.requiresPhoto === true || requiresPhotoEvidence === true,
          cameraEnabled: requiresPhotoEvidence === true
            && configuredCameraEnabled === false
            && galleryEnabled === false
            ? true
            : configuredCameraEnabled,
          galleryEnabled,
          linkedToFix: isChecker ? false : item.linkedToFix === true,
        };
      })
    : [];

  const invalidPhotoItem = sanitizedItems.find((item: any) =>
    item.requiresPhoto === true && item.cameraEnabled === false
    && item.galleryEnabled === false
  );
  if (invalidPhotoItem) {
    return { refusal: { status: 400, message: `"${invalidPhotoItem.title || "Checklist item"}" requires a photo, so enable Camera or Gallery` } };
  }

  // Multi-branch support: Create a template for each selected branch
  // For non-admins, ensure at least one branch is used (no global templates)
  const branchesToCreate = selectedBranchIds.length > 0
    ? selectedBranchIds
    : (effectiveBranchId ? [effectiveBranchId] : [null]);

  return {
    prepared: {
      fields: {
        name,
        description: description || null,
        departmentId: departmentId || null,
        checklistType: checklistType || "operational",
        recurrence: recurrence || "once",
        scheduledTime: scheduledTime || null,
        checkerRounds: checkerRounds || null,
        scheduleTime1: scheduleTime1 || null,
        scheduleTime2: scheduleTime2 || null,
        scheduleTime3: scheduleTime3 || null,
        scheduleTime4: scheduleTime4 || null,
        scheduleTime5: scheduleTime5 || null,
        assignedEmployeeId: assignedEmployeeIds[0] ?? null,
        assignedEmployeeIds,
        assignedRoleId: assignedRoleId || null,
        assignedDepartmentId: assignedDepartmentId || null,
        allowedCheckerRoles: allowedCheckerRoles || [],
        locationId: locationId || null,
        referenceMediaUrls: referenceMediaUrls || [],
        weeklyDays: weeklyDays || [],
        monthlyDay: monthlyDay || null,
      },
      items: sanitizedItems,
      selectedBranchIds,
      branchesToCreate,
    },
  };
}

/** The one place a checklist template is created: one independent template per branch. */
export async function createPreparedChecklistTemplates(
  tenantId: string,
  createdBy: string,
  prepared: PreparedChecklistTemplates,
): Promise<any[]> {
  const created: any[] = [];
  for (const branchId of prepared.branchesToCreate) {
    created.push(
      await storage.createChecklistTemplate({ ...prepared.fields, tenantId, branchId, createdBy }, prepared.items),
    );
  }
  return created;
}

const COPY_SOURCE_ID = z.string().uuid();
const COPY_BRANCH_LIST = z.array(z.string().min(1)).optional();

/** The original a "save as a new checklist" names, or why it cannot be copied. */
export async function loadChecklistCopySource(
  user: UserWithBranchAccess,
  tenantId: string,
  sourceId: unknown,
): Promise<{ refusal: ChecklistRefusal } | { source: any }> {
  const id = COPY_SOURCE_ID.safeParse(sourceId);
  if (!id.success) return { refusal: { status: 400, message: "copiedFromTemplateId must be a checklist id" } };
  const source = await storage.getChecklistTemplateWithItems(id.data, tenantId);
  if (!source) return { refusal: { status: 404, message: "Checklist template not found" } };
  if (!canReachChecklistTemplate(user, source)) {
    return { refusal: { status: 403, message: "Access denied to this checklist" } };
  }
  return { source };
}

/**
 * The create request for a copy: the edited values where the request sends
 * them, the original's where it does not. The editor does not send the older
 * department, the checker's allowed roles or the template's own media URLs, and
 * sends weekly days and the month day only when they apply, so a copy takes
 * those from the original, exactly as a save of the same form leaves them
 * standing on the original. Branches come from the request; with none named at
 * all, the copy is for the original's branches.
 */
export function checklistCopyRequest(source: any, body: any): any {
  const pick = (key: string) => (body[key] !== undefined ? body[key] : source[key]);
  return {
    name: pick("name"),
    description: pick("description"),
    departmentId: pick("departmentId"),
    locationId: pick("locationId"),
    checklistType: pick("checklistType"),
    recurrence: pick("recurrence"),
    weeklyDays: pick("weeklyDays"),
    monthlyDay: pick("monthlyDay"),
    scheduledTime: pick("scheduledTime"),
    checkerRounds: pick("checkerRounds"),
    scheduleTime1: pick("scheduleTime1"),
    scheduleTime2: pick("scheduleTime2"),
    scheduleTime3: pick("scheduleTime3"),
    scheduleTime4: pick("scheduleTime4"),
    scheduleTime5: pick("scheduleTime5"),
    assignedRoleId: pick("assignedRoleId"),
    assignedDepartmentId: pick("assignedDepartmentId"),
    allowedCheckerRoles: pick("allowedCheckerRoles"),
    referenceMediaUrls: pick("referenceMediaUrls"),
    assignedEmployeeIds: requestedChecklistAssignees(body) ?? source.assignedEmployeeIds ?? [],
    items: Array.isArray(body.items) ? body.items : source.items,
    branchIds: Array.isArray(body.branchIds)
      ? [...new Set(body.branchIds)]
      : body.branchIds !== undefined
        ? body.branchIds
        : body.branchId
          ? [body.branchId]
          : checklistTemplateBranches(source),
  };
}

/**
 * Every branch a copy goes to must be a branch of this park group, whoever asks
 * and whatever the screen sends. The create route's own check is the person's
 * reach, and an all-branches account passes that without the branch being read.
 */
export async function checklistCopyBranchRefusal(tenantId: string, branchIds: string[]): Promise<ChecklistRefusal | null> {
  if (branchIds.length === 0) return null;
  const found = await db
    .select({ id: branches.id })
    .from(branches)
    .where(and(eq(branches.tenantId, tenantId), inArray(branches.id, branchIds)));
  return new Set(found.map((b) => b.id)).size === new Set(branchIds).size
    ? null
    : { status: 403, message: "Access denied to create templates for one or more branches" };
}

/**
 * What a request naming the "separate copy" choice comes to: which branches are
 * new (one copy each), and what the original's own branches become. Removing a
 * branch behaves as a plain edit does; a request that keeps none of the
 * original's branches leaves them as they are, as a plain edit with no branch
 * selected does. `originalBranchIds` is null when they do not change.
 */
export function planBranchCopies(
  existing: BranchBound,
  body: { branchId?: unknown; branchIds?: unknown },
): { refusal: ChecklistRefusal } | { addedBranchIds: string[]; originalBranchIds: string[] | null } {
  const list = COPY_BRANCH_LIST.safeParse(body.branchIds);
  if (!list.success) return { refusal: { status: 400, message: "branchIds must be a list of branches" } };
  const current = checklistTemplateBranches(existing);
  const requested = list.data ?? (typeof body.branchId === "string" && body.branchId ? [body.branchId] : current);
  const added = [...new Set(requested.filter((id) => !current.includes(id)))];
  const kept = [...new Set(requested.filter((id) => current.includes(id)))];
  const unchanged = kept.length === 0 || kept.length === current.length;
  return { addedBranchIds: added, originalBranchIds: unchanged ? null : kept };
}

const sameValue = (a: unknown, b: unknown): boolean => {
  const blank = (v: unknown) => v === null || v === undefined || v === "" || (Array.isArray(v) && v.length === 0);
  return (blank(a) && blank(b)) || JSON.stringify(a) === JSON.stringify(b);
};

/** The item fields a save writes, as it writes them. */
function checklistItemChanged(sent: any, stored: any, isChecker: boolean): boolean {
  return sent.id !== stored.id
    || !sameValue(sent.title, stored.title)
    || !sameValue(sent.description, stored.description)
    || !sameValue(sent.referenceMediaUrls, stored.referenceMediaUrls)
    || (sent.requiresNote === true) !== (stored.requiresNote === true)
    || (sent.requiresPhoto === true) !== (stored.requiresPhoto === true)
    || (sent.cameraEnabled ?? true) !== (stored.cameraEnabled ?? true)
    || (sent.galleryEnabled ?? false) !== (stored.galleryEnabled ?? false)
    || (sent.isCritical === true) !== (stored.isCritical === true)
    || (isChecker ? false : sent.linkedToFix === true) !== (stored.linkedToFix === true)
    || !sameValue(sent.departmentId, stored.departmentId)
    || !sameValue(sent.zoneLabel, stored.zoneLabel);
}

/**
 * Whether a separate-copy save has anything to write to the original, beyond
 * making its copies. The editor sends every field whether or not it changed, so
 * this reads what the save would write against what is stored. Nothing to write
 * means no write at all: no new version, and a run in progress is not touched.
 *
 * `update` is the save's field list; its timestamp and the older photo flag are
 * not changes the person made. `items` is the list the save would write, or null
 * when it writes none.
 */
export function checklistEditChangesOriginal(existing: any, update: Record<string, unknown>, items: any[] | null): boolean {
  const { updatedAt: _updatedAt, requiresPhotoEvidence: _requiresPhotoEvidence, ...fields } = update;
  if (Object.entries(fields).some(([key, value]) => !sameValue(value, existing[key]))) return true;
  if (!items) return false;
  const stored: any[] = existing.items ?? [];
  const isChecker = (update.checklistType ?? existing.checklistType) === "checker";
  return items.length !== stored.length
    || items.some((item, position) => checklistItemChanged(item, stored[position], isChecker));
}

/**
 * The original's reference media on each copy. A row binds a file to a template
 * or an item, and access follows the row, so each copy needs rows of its own for
 * staff at its branch to open them. The rows share the original's stored object;
 * the media routes know, and keep the object until the last row using it goes.
 *
 * `items` is what the request saved, in order: the copy's items were created in
 * that order, and an item that came from the original still carries its id.
 */
export async function carryChecklistMedia(
  tenantId: string,
  source: { id: string; items?: Array<{ id: string }> },
  items: Array<{ id?: unknown }>,
  copies: Array<{ id: string; items?: Array<{ id: string }> }>,
): Promise<void> {
  const sourceItemIds = new Set((source.items ?? []).map((item) => item.id));
  const rows = await db
    .select()
    .from(checklistAttachments)
    .where(and(
      eq(checklistAttachments.tenantId, tenantId),
      or(
        eq(checklistAttachments.checklistTemplateId, source.id),
        sourceItemIds.size > 0 ? inArray(checklistAttachments.checklistTemplateItemId, [...sourceItemIds]) : undefined,
      ),
    ));
  if (rows.length === 0) return;

  const inserts: Array<typeof checklistAttachments.$inferInsert> = [];
  for (const copy of copies) {
    const copyItemFor = new Map<string, string>();
    items.forEach((item, position) => {
      const copyItem = copy.items?.[position];
      if (typeof item.id === "string" && sourceItemIds.has(item.id) && copyItem) copyItemFor.set(item.id, copyItem.id);
    });
    for (const { id: _id, createdAt: _createdAt, ...row } of rows) {
      if (row.checklistTemplateId === source.id) {
        inserts.push({ ...row, checklistTemplateId: copy.id });
      } else if (row.checklistTemplateItemId && copyItemFor.has(row.checklistTemplateItemId)) {
        inserts.push({ ...row, checklistTemplateItemId: copyItemFor.get(row.checklistTemplateItemId)! });
      }
    }
  }
  if (inserts.length > 0) await db.insert(checklistAttachments).values(inserts);
}

/** Make the copies, carry the media and leave the line that says who made what from what. */
export async function createChecklistCopies(
  tenantId: string,
  createdBy: string,
  source: { id: string; items?: Array<{ id: string }> },
  prepared: PreparedChecklistTemplates,
): Promise<any[]> {
  const copies = await createPreparedChecklistTemplates(tenantId, createdBy, prepared);
  await carryChecklistMedia(tenantId, source, prepared.items, copies);
  log().info(
    { sourceTemplateId: source.id, copyTemplateIds: copies.map((copy) => copy.id), branchIds: prepared.branchesToCreate, userId: createdBy },
    "checklist copied",
  );
  return copies;
}
