import { randomUUID } from "node:crypto";
import { ATTENDANCE_EVIDENCE_MAX_BYTES, type AttendanceEvidence } from "../shared/attendance-evidence";

export const ATTENDANCE_EVIDENCE_FOLDER = "attendance-evidence";

const extensions: Record<string, string> = {
  "image/jpeg": ".jpg", "image/png": ".png", "image/gif": ".gif", "application/pdf": ".pdf",
};
interface EvidenceFile { buffer: Buffer; originalname: string; mimetype: string; size: number }
interface EvidenceStorage {
  upload: (buffer: Buffer, folder: string, name: string, type: string) => Promise<string>;
  remove: (folder: string, name: string) => Promise<boolean>;
}

// Object names are always server-generated. The caller binds the metadata and
// time entry to one issue in a database transaction before this returns.
export async function persistAttendanceEvidence<T>(
  file: EvidenceFile | undefined,
  persist: (evidence: AttendanceEvidence | null) => Promise<T>,
  objects: EvidenceStorage,
): Promise<T> {
  if (!file) return persist(null);
  const extension = extensions[file.mimetype];
  if (!extension || !file.size || file.size > ATTENDANCE_EVIDENCE_MAX_BYTES || file.buffer.length !== file.size) {
    throw new Error("Choose a JPEG, PNG, GIF or PDF no larger than 10 MB.");
  }
  const evidence: AttendanceEvidence = {
    objectName: `${randomUUID()}${extension}`,
    fileName: file.originalname.slice(0, 255), mimeType: file.mimetype, size: file.size,
  };
  await objects.upload(file.buffer, ATTENDANCE_EVIDENCE_FOLDER, evidence.objectName, evidence.mimeType);
  try {
    return await persist(evidence);
  } catch (error) {
    await objects.remove(ATTENDANCE_EVIDENCE_FOLDER, evidence.objectName);
    throw error;
  }
}

export function canReadAttendanceEvidence(
  issue: { tenantId: string; branchId: string } | undefined,
  tenantId: string | undefined,
  branches: { accessScope: string; branchId: string | null }[],
): boolean {
  return !!issue && !!tenantId && issue.tenantId === tenantId &&
    branches.some(branch => branch.accessScope === "all_branches" || branch.branchId === issue.branchId);
}
