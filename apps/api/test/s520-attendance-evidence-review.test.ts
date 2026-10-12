import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { canReadAttendanceEvidence, persistAttendanceEvidence } from '../../oto-app/server/attendance-evidence';

const read = (name: string) => readFileSync(fileURLToPath(new URL(`../../oto-app/${name}`, import.meta.url)), 'utf8');
const routes = read('server/routes.ts');
const file = { buffer: Buffer.from('%PDF-1.4'), originalname: 'ZZ TEST proof.pdf', mimetype: 'application/pdf', size: 8 };
const objects = () => ({
  upload: vi.fn(async (_buffer: Buffer, _folder: string, _name: string, _type: string) => '/not-a-public-capability'),
  remove: vi.fn(async (_folder: string, _name: string) => true),
});

/**
 * SCRUM-520 review: optional evidence uses the existing confirmation identity
 * and approval rules. No face route is enabled by this suite.
 * FINDING 1 (high, resolved): an upload must not run before the disabled-face
 * refusal. Prescribed fix: keep the refusal ahead of multipart parsing.
 * FINDING 2 (high, resolved): object-prefix checks alone do not establish reader
 * access. Prescribed fix: require a manager and the exact issue's park/branch.
 * FINDING 3 (medium, resolved): an unsuccessful issue write must not leave its
 * uploaded object behind. Prescribed fix: transactionally persist the issue and
 * time entry, and remove only that request's generated object on failure.
 * FINDING 4 (medium, resolved): a two-part parser limit refused a valid file
 * and payload. Prescribed fix: allow the closing boundary while retaining one
 * file and one field; the app attendance-evidence.check.ts drives the actual
 * multipart parser over local HTTP with no clock route or database.
 */
describe('SCRUM-520 attendance evidence review', () => {
  it('FINDING 1 fixed: the disabled-face refusal precedes multipart work', () => {
    const parser = read('server/attendance-evidence-upload.ts');
    expect(parser.indexOf('if (!faceEnabled())')).toBeLessThan(parser.indexOf('upload(req, res, error =>'));
    expect(routes).toContain('attendanceConfirmationBody(attendanceEvidenceUpload, faceClockInOn, FACE_CLOCK_OFF_REFUSAL)');
  });

  it('FINDING 2 fixed: another park and another branch cannot read an issue attachment', () => {
    const issue = { tenantId: 'park-a', branchId: 'branch-a' };
    expect(canReadAttendanceEvidence(issue, 'park-b', [{ accessScope: 'all_branches', branchId: null }])).toBe(false);
    expect(canReadAttendanceEvidence(issue, 'park-a', [{ accessScope: 'branch', branchId: 'branch-b' }])).toBe(false);
    expect(canReadAttendanceEvidence(issue, 'park-a', [])).toBe(false);
    expect(canReadAttendanceEvidence(undefined, 'park-a', [{ accessScope: 'all_branches', branchId: null }])).toBe(false);
    expect(canReadAttendanceEvidence(issue, 'park-a', [{ accessScope: 'branch', branchId: 'branch-a' }])).toBe(true);
    expect(canReadAttendanceEvidence(issue, 'park-a', [{ accessScope: 'all_branches', branchId: null }])).toBe(true);
  });

  it('FINDING 3 fixed: failed issue persistence removes exactly its generated object', async () => {
    const store = objects();
    await expect(persistAttendanceEvidence(file, async () => { throw new Error('persistence refused'); }, store)).rejects.toThrow('persistence refused');
    const uploaded = store.upload.mock.calls[0];
    expect(store.remove).toHaveBeenCalledExactlyOnceWith('attendance-evidence', uploaded?.[2]);
    expect(uploaded?.[2]).toMatch(/^[a-f0-9-]+\.pdf$/);
  });

  it('keeps replayed requests and another issue on distinct server-generated objects', async () => {
    const store = objects();
    const first = await persistAttendanceEvidence(file, async attachment => attachment, store);
    const second = await persistAttendanceEvidence(file, async attachment => attachment, store);
    expect(first?.objectName).not.toBe(second?.objectName);
    expect(first).toMatchObject({ fileName: file.originalname, mimeType: file.mimetype, size: file.size });
    expect(store.remove).not.toHaveBeenCalled();
  });

  it('needs no object write when attachment is omitted', async () => {
    const store = objects();
    const persist = vi.fn(async (attachment: unknown) => attachment);
    await expect(persistAttendanceEvidence(undefined, persist, store)).resolves.toBeNull();
    expect(store.upload).not.toHaveBeenCalled();
    expect(persist).toHaveBeenCalledExactlyOnceWith(null);
  });

  it('rejects unsupported, empty, oversized and inconsistent files before persistence', async () => {
    for (const change of [{ mimetype: 'text/html' }, { size: 0 }, { size: 10 * 1024 * 1024 + 1 }, { size: 3 }]) {
      const store = objects();
      const persist = vi.fn();
      await expect(persistAttendanceEvidence({ ...file, ...change }, persist, store)).rejects.toThrow('10 MB');
      expect(store.upload).not.toHaveBeenCalled();
      expect(persist).not.toHaveBeenCalled();
    }
  });

  it('holds both confirmation doors to device-derived park and branch before persistence', () => {
    for (const route of ['/api/kiosk/missed-clock/manual', '/api/kiosk/unscheduled-clock-in']) {
      const start = routes.indexOf(`app.post("${route}", parseAttendanceConfirmation, fixMulterFilenames, async`);
      expect(start).toBeGreaterThan(0);
      const block = routes.slice(start, routes.indexOf('\n  });', start));
      expect(block.indexOf('if (!faceClockInOn())')).toBeLessThan(block.indexOf('resolveKioskDevice(deviceSecret)'));
      expect(block).toContain('storage.getEmployeeInTenant(employeeId, device.tenantId)');
      expect(block).toContain('const branchId: string = device.branchId;');
      expect(block.indexOf('if (!employee)')).toBeLessThan(block.indexOf('persistAttendanceEvidence(req.file'));
      expect(block).toContain('attachment => db.transaction(async tx => {');
      expect(block).toContain('status: \'PENDING_APPROVAL\'');
      expect(block).toContain('status: \'OPEN\'');
      expect(block).toContain('linkedTimeEntryId: timeEntry.id');
    }
  });

  it('serves only the exact issue to authenticated managers with no public folder capability', () => {
    const start = routes.indexOf('app.get("/api/timekeeping/issues/:issueId/attachment", requireAuth, requireManager');
    expect(start).toBeGreaterThan(0);
    const block = routes.slice(start, routes.indexOf('\n  });', start));
    expect(block).toContain('storage.getTimekeepingIssue(req.params.issueId)');
    expect(block).toContain('canReadAttendanceEvidence(issue, tenantId, branches)');
    expect(block).toContain('getFileFromObjectStorage(ATTENDANCE_EVIDENCE_FOLDER, evidence.objectName)');
    expect(block).toContain('"private, no-store"');
    expect(block).toContain('"nosniff"');
    expect(block).toContain('`attachment; filename=');
    expect(routes).toContain('const publicFileFolders = ["branch-logos", "dropoff-photos", "invitations"];');
    expect(routes).toContain('const publicFolders = new Set(["branch-logos", "dropoff-photos", "invitations"]);');
    const review = read('server/timekeeping-review-routes.ts');
    expect(review).toContain('eq(timekeepingIssues.tenantId, tenantId)');
    expect(review).toContain('!allBranches ? inArray(timekeepingIssues.branchId, branchIds) : undefined');
    expect(review).toContain('attachment: attachment ? { fileName: attachment.fileName, mimeType: attachment.mimeType, size: attachment.size } : null');
    expect(review).not.toContain('objectName');
    expect(read('server/attendance-evidence-upload.ts')).toContain('files: 1, fields: 1, fieldSize: 16 * 1024, parts: 3');
  });

  it('adds only a nullable issue field and retains the existing selected-file removal control', () => {
    expect(read('migrations/0012_attendance_evidence.sql').trim()).toBe('ALTER TABLE "timekeeping_issues" ADD COLUMN "attachment" jsonb;');
    expect(read('client/src/components/attendance-evidence-input.tsx')).toContain('URL.revokeObjectURL(url)');
    expect(read('client/src/components/attendance-evidence-input.tsx')).toContain('onChange(null)');
    expect(read('client/src/pages/kiosk-page.tsx').match(/<AttendanceEvidenceInput /g)).toHaveLength(2);
  });
});
