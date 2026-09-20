const departmentColorClasses = [
  "bg-emerald-600 dark:bg-emerald-700",
  "bg-blue-600 dark:bg-blue-700",
  "bg-violet-600 dark:bg-violet-700",
  "bg-amber-600 dark:bg-amber-700",
  "bg-cyan-600 dark:bg-cyan-700",
  "bg-rose-600 dark:bg-rose-700",
];

const shiftColorClasses = [
  "bg-blue-600 dark:bg-blue-700",
  "bg-emerald-600 dark:bg-emerald-700",
  "bg-violet-600 dark:bg-violet-700",
  "bg-amber-600 dark:bg-amber-700",
  "bg-rose-600 dark:bg-rose-700",
  "bg-cyan-600 dark:bg-cyan-700",
  "bg-indigo-600 dark:bg-indigo-700",
  "bg-teal-600 dark:bg-teal-700",
  "bg-orange-600 dark:bg-orange-700",
  "bg-pink-600 dark:bg-pink-700",
];

export function getDepartmentColor(deptId?: string): string {
  if (!deptId) return departmentColorClasses[0];
  const hash = deptId.split('').reduce((a, b) => a + b.charCodeAt(0), 0);
  return departmentColorClasses[hash % departmentColorClasses.length];
}

export function getShiftColor(shiftRowId?: string): string {
  if (!shiftRowId) return shiftColorClasses[0];
  const hash = shiftRowId.split('').reduce((a, b) => a + b.charCodeAt(0), 0);
  return shiftColorClasses[hash % shiftColorClasses.length];
}

export function getShiftColorByIndex(colorIndex?: number | null): string {
  if (colorIndex == null) return shiftColorClasses[0];
  return shiftColorClasses[colorIndex % shiftColorClasses.length];
}

const employeeColorClasses = [
  "bg-blue-600 dark:bg-blue-700",
  "bg-emerald-600 dark:bg-emerald-700",
  "bg-violet-600 dark:bg-violet-700",
  "bg-cyan-600 dark:bg-cyan-700",
  "bg-indigo-600 dark:bg-indigo-700",
  "bg-teal-600 dark:bg-teal-700",
  "bg-sky-600 dark:bg-sky-700",
  "bg-purple-600 dark:bg-purple-700",
  "bg-slate-600 dark:bg-slate-700",
  "bg-fuchsia-600 dark:bg-fuchsia-700",
  "bg-green-600 dark:bg-green-700",
  "bg-blue-500 dark:bg-blue-600",
];

export function getEmployeeColor(employeeId?: string): string {
  if (!employeeId) return employeeColorClasses[0];
  const hash = employeeId.split('').reduce((a, b) => a + b.charCodeAt(0), 0);
  return employeeColorClasses[hash % employeeColorClasses.length];
}

export function formatCompactStartTime(time: string): string {
  const [hours, minutes] = time.split(':');
  const h = parseInt(hours, 10);
  if (minutes === '00') {
    return String(h);
  }
  return `${h}:${minutes}`;
}

/**
 * Format time range for Employee View
 * Rules:
 * - If both start and end have :00 minutes, show h–h (e.g., 9–17)
 * - If either has minutes ≠ :00, show h:mm–h:mm (e.g., 9:30–18)
 * - No left padding unless needed for minutes
 */
export function formatTimeRange(startTime: string, endTime: string): string {
  const [startHours, startMins] = startTime.split(':');
  const [endHours, endMins] = endTime.split(':');
  
  const startH = parseInt(startHours, 10);
  const endH = parseInt(endHours, 10);
  const startM = startMins || '00';
  const endM = endMins || '00';
  
  if (startM === '00' && endM === '00') {
    return `${startH}–${endH}`;
  }
  
  const startStr = startM === '00' ? String(startH) : `${startH}:${startM}`;
  const endStr = endM === '00' ? String(endH) : `${endH}:${endM}`;
  return `${startStr}–${endStr}`;
}

export type NameDisplayMode = 'full' | 'abbreviated' | 'initials';

export function formatEmployeeName(fullName: string, mode: NameDisplayMode): string {
  if (!fullName) return '';
  
  const parts = fullName.trim().split(/\s+/);
  
  switch (mode) {
    case 'full':
      return fullName;
    case 'abbreviated':
      if (parts.length === 1) {
        return parts[0];
      }
      const firstName = parts[0];
      const lastInitial = parts[parts.length - 1][0]?.toUpperCase() || '';
      return `${firstName} ${lastInitial}`;
    case 'initials':
      if (parts.length === 1) {
        return parts[0][0]?.toUpperCase() || '';
      }
      const firstInitial = parts[0][0]?.toUpperCase() || '';
      const lastInit = parts[parts.length - 1][0]?.toUpperCase() || '';
      return `${firstInitial}${lastInit}`;
    default:
      return fullName;
  }
}

export function getInitials(fullName: string): string {
  if (!fullName) return '';
  const parts = fullName.trim().split(/\s+/);
  return parts
    .map((n) => n[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();
}
