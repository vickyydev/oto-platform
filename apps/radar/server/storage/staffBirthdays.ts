import { and, asc, eq, inArray } from "drizzle-orm";
import { db } from "../db";
import {
  staffBirthdays,
  insertStaffBirthdaySchema,
  type StaffBirthday,
  type InsertStaffBirthday,
  type StaffBirthdayBranch,
} from "@shared/schema";

export async function listBirthdays(branches?: StaffBirthdayBranch[]): Promise<StaffBirthday[]> {
  if (branches && branches.length > 0) {
    return db
      .select()
      .from(staffBirthdays)
      .where(inArray(staffBirthdays.branch, branches))
      .orderBy(asc(staffBirthdays.birthMonth), asc(staffBirthdays.birthDay));
  }
  return db
    .select()
    .from(staffBirthdays)
    .orderBy(asc(staffBirthdays.birthMonth), asc(staffBirthdays.birthDay));
}

export async function createBirthday(input: InsertStaffBirthday): Promise<StaffBirthday> {
  const parsed = insertStaffBirthdaySchema.parse(input);
  const [row] = await db.insert(staffBirthdays).values(parsed).returning();
  return row;
}

export async function updateBirthday(id: string, input: Partial<InsertStaffBirthday>): Promise<StaffBirthday | null> {
  const parsed = insertStaffBirthdaySchema.partial().parse(input);
  const [row] = await db.update(staffBirthdays).set(parsed).where(eq(staffBirthdays.id, id)).returning();
  return row ?? null;
}

export async function deleteBirthday(id: string): Promise<void> {
  await db.delete(staffBirthdays).where(eq(staffBirthdays.id, id));
}
