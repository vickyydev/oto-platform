import { and, asc, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { payrollMonthRuns, payrollPayingEntities, payrollRunVersions } from "@shared/schema";
import { db } from "../db";

const monthStatusSchema = z.object({
  month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/),
  entities: z.array(z.object({
    id: z.string().uuid(),
    name: z.string(),
    version: z.number().int().positive().nullable(),
    status: z.enum(["not-started", "draft", "gm-confirmed", "locked", "paid", "superseded"]),
  }).strict()),
}).strict();

export type PayrollMonthStatus = z.infer<typeof monthStatusSchema>;

/** Current company month state only: no setup seeding, calculation or financial operands. */
export async function loadPayrollMonthStatus(tenantId: string, month: string): Promise<PayrollMonthStatus> {
  const rows = await db.select({
    id: payrollPayingEntities.id,
    name: payrollPayingEntities.name,
    runId: payrollMonthRuns.id,
    version: payrollRunVersions.version,
    status: payrollRunVersions.status,
  }).from(payrollPayingEntities)
    .leftJoin(payrollMonthRuns, and(
      eq(payrollMonthRuns.tenantId, tenantId),
      eq(payrollMonthRuns.entityId, payrollPayingEntities.id),
      eq(payrollMonthRuns.month, month),
    ))
    .leftJoin(payrollRunVersions, and(
      eq(payrollRunVersions.tenantId, tenantId),
      eq(payrollRunVersions.runId, payrollMonthRuns.id),
      eq(payrollRunVersions.version, payrollMonthRuns.currentVersion),
    ))
    .where(and(eq(payrollPayingEntities.tenantId, tenantId), isNull(payrollPayingEntities.archivedAt)))
    .orderBy(asc(payrollPayingEntities.name), asc(payrollPayingEntities.id));

  return monthStatusSchema.parse({
    month,
    entities: rows.map(row => {
      if (row.runId !== null && (row.version === null || row.status === null)) {
        throw new Error("Payroll month status is unavailable");
      }
      return { id: row.id, name: row.name, version: row.version, status: row.status ?? "not-started" };
    }),
  });
}
