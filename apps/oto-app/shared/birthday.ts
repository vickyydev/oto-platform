import { z } from "zod";

// February 29 is celebrated on February 28 in non-leap years.
export const birthdaySchema = z.object({
  month: z.number().int().nullable(),
  day: z.number().int().nullable(),
  year: z.number().int().min(1).max(9999).nullable(),
}).strict().superRefine(({ month, day, year }, ctx) => {
  if (month === null && day === null && year === null) return;
  if (month === null || day === null) {
    ctx.addIssue({ code: "custom", message: "Select both a birthday month and day" });
    return;
  }
  // A yearless February 29 is valid; the actual year must be a leap year if provided.
  const referenceYear = year ?? 2000;
  if (month < 1 || month > 12 || day < 1 ||
      day > new Date(Date.UTC(referenceYear, month, 0)).getUTCDate()) {
    ctx.addIssue({ code: "custom", message: "Enter a valid birthday date" });
  }
});

export type Birthday = z.infer<typeof birthdaySchema>;

export function birthdayDateInYear(month: number, day: number, year: number): string {
  const observedDay = month === 2 && day === 29 &&
    new Date(Date.UTC(year, 1, 29)).getUTCMonth() !== 1 ? 28 : day;
  return `${year}-${String(month).padStart(2, "0")}-${String(observedDay).padStart(2, "0")}`;
}