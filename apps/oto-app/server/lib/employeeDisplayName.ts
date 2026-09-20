/**
 * Server-side helper for getting employee display name with nickname preference.
 * Ensures "undefined" never appears in any display strings.
 */

type EmployeeLike = {
  id?: string;
  nickname?: string | null;
  preferredName?: string | null;
  fullName?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  name?: string | null;
};

type DisplayContext = "default" | "employee_page" | "official_document";

/**
 * Returns a safe display name for an employee, preferring nickname for default context.
 * Never returns "undefined" or null - always returns a safe fallback.
 */
export function getEmployeeDisplayName(
  employee: EmployeeLike | null | undefined,
  context: DisplayContext = "default"
): string {
  if (!employee) return "Unknown";

  let fullName = employee.fullName;
  if (!fullName && employee.firstName && employee.lastName) {
    fullName = `${employee.firstName} ${employee.lastName}`;
  }
  if (!fullName) {
    fullName = employee.firstName || employee.lastName || employee.name || null;
  }

  if (context === "employee_page" || context === "official_document") {
    return sanitizeName(fullName) || "Unknown";
  }

  const nickname = employee.nickname?.trim();
  if (nickname) {
    return sanitizeName(nickname) || sanitizeName(fullName) || "Unknown";
  }

  const preferredName = employee.preferredName?.trim();
  if (preferredName) {
    return sanitizeName(preferredName) || sanitizeName(fullName) || "Unknown";
  }

  return sanitizeName(fullName) || "Unknown";
}

function sanitizeName(name: string | null | undefined): string | null {
  if (!name) return null;
  const trimmed = name.trim();
  
  if (
    trimmed === "" ||
    trimmed === "undefined" ||
    trimmed === "null" ||
    trimmed === "undefined undefined" ||
    trimmed.includes("undefined")
  ) {
    return null;
  }
  
  return trimmed;
}

export function createSafeSummaryText(template: string, replacements: Record<string, string | null | undefined>): string {
  let result = template;
  
  for (const [key, value] of Object.entries(replacements)) {
    const safeValue = sanitizeName(value) || "Unknown";
    result = result.replace(new RegExp(`\\{${key}\\}`, 'g'), safeValue);
  }
  
  result = result.replace(/undefined undefined/g, "Unknown");
  result = result.replace(/undefined/g, "Unknown");
  
  return result;
}
