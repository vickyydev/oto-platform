export const ATTENDANCE_EVIDENCE_MAX_BYTES = 10 * 1024 * 1024;
export const ATTENDANCE_EVIDENCE_TYPES = ["image/jpeg", "image/png", "image/gif", "application/pdf"] as const;

export interface AttendanceEvidence {
  objectName: string;
  fileName: string;
  mimeType: string;
  size: number;
}
