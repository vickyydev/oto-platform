import type { Request } from "express";
import { and, desc, eq } from "drizzle-orm";
import { xeroTokens } from "@shared/schema";
import { db } from "../db";

export class FinanceOrganisationAccessError extends Error {
  constructor(public readonly status: 400 | 403 | 404, message: string) {
    super(message);
  }
}

/** The authenticated middleware supplies the strict park-group placement. */
export function financeParkGroup(req: Request): string {
  const parkGroup = req.userWithAccess?.tenantId;
  if (!parkGroup) throw new FinanceOrganisationAccessError(403, "Finance access has no park group");
  return parkGroup;
}

export async function assertFinanceOrganisationOwner(
  parkGroup: string, organisation: string,
  database: Pick<typeof db, "select"> = db, allowNew = false,
): Promise<void> {
  const mappings = await database.select({ parkGroup: xeroTokens.tenantId })
    .from(xeroTokens).where(eq(xeroTokens.xeroTenantId, organisation));
  if ((!allowNew && mappings.length === 0) || mappings.some((mapping) => mapping.parkGroup !== parkGroup)) {
    throw new FinanceOrganisationAccessError(404, "Finance organisation not found");
  }
}

/** Xero organisation IDs are text; the signed-in park group is a separate UUID. */
export async function resolveFinanceOrganisation(req: Request): Promise<string> {
  const parkGroup = financeParkGroup(req);

  const requested = req.body?.tenantId || req.query?.tenantId;
  if (requested && (typeof requested !== "string" || !requested.trim())) {
    throw new FinanceOrganisationAccessError(400, "Choose a valid finance organisation");
  }
  let organisation = requested as string | undefined;
  if (!organisation) {
    const [token] = await db.select({ organisation: xeroTokens.xeroTenantId })
      .from(xeroTokens)
      .where(and(eq(xeroTokens.tenantId, parkGroup), eq(xeroTokens.isActive, true)))
      .orderBy(desc(xeroTokens.updatedAt))
      .limit(1);
    if (!token?.organisation) throw new Error("No active Xero connection found");
    organisation = token.organisation;
  }

  // The same ownership rule as Data Admin: any other or unplaced token makes
  // this organisation ambiguous. Inactive mappings still own historical reads.
  await assertFinanceOrganisationOwner(parkGroup, organisation);
  return organisation;
}
