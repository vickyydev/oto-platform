export type AssignmentValidationResult = {
  ok: boolean;
  reasonCode?: 'ROLE_MISMATCH' | 'DEPT_MISMATCH' | 'ON_LEAVE' | 'OVERLAP' | 'DAY_OFF' | 'HOURS_LIMIT' | 'ALREADY_ASSIGNED';
  message?: string;
  conflictingShift?: {
    shiftRowId: string;
    startTime: string;
    endTime: string;
  };
};

export const VALIDATION_MESSAGES: Record<string, string> = {
  ROLE_MISMATCH: "Can't assign: employee isn't qualified for the required role.",
  DEPT_MISMATCH: "Can't assign: employee isn't in this department.",
  ON_LEAVE: "Can't assign: employee is on leave or holiday.",
  DAY_OFF: "Can't assign: this is the employee's scheduled day off.",
  OVERLAP: "Can't assign: employee already has an overlapping shift.",
  HOURS_LIMIT: "Can't assign: exceeds maximum hour limit.",
  ALREADY_ASSIGNED: "Can't assign: employee is already assigned to this shift.",
};

export function timeToMinutes(time: string): number {
  const [hours, minutes] = time.split(':').map(Number);
  return hours * 60 + minutes;
}

export function hasTimeOverlap(
  startA: string,
  endA: string,
  startB: string,
  endB: string
): boolean {
  const startAMin = timeToMinutes(startA);
  const endAMin = timeToMinutes(endA);
  const startBMin = timeToMinutes(startB);
  const endBMin = timeToMinutes(endB);
  
  return startAMin < endBMin && startBMin < endAMin;
}
