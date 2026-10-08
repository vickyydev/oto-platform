import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase } from '@oto/db/testing';

/**
 * S2-17b round 5 (SCRUM-193 under SCRUM-191) — ATTENDANCE AND OPERATIONS AS
 * THE APP DOES THEM, proved (docs/progress/plans/otoapp-lift/PLAN.md section 8
 * round 5; hazards H13-H15; questions Q1, Q2, Q9, Q10 and Q38-Q45).
 *
 *  A. Leave approval restored (Q1, H14), read off the code: the two 503s gone,
 *     the app's sick-day step back in the create route with its coverage
 *     alert written to the person's park group, the later approve back in the
 *     update route, the rota's `approved: true` back in the client, and
 *     nothing stored (no migration, no approval column).
 *  B. A rota row always has a shift group (Q2, H15): the rule's words, and
 *     each of the four doors that would leave a row ungrouped refusing before
 *     it writes.
 *  C. Face "off" refuses instead of matching (H13): the switch read exactly as
 *     the face service reads it; every face-road door stands down first thing,
 *     identify-face before any matcher or enrolment read; the matcher module
 *     and the midnight auto clock-out's FACE label (Q10) unchanged.
 *  D. The reception tablet: a kiosk code only for the caller's own park
 *     group's branch, and the tablet's two reads held to its park group.
 *  E. CI's OTO App job runs the attendance check; the plan carries round 5's
 *     questions with their defaults.
 *  F. The real app (when its node_modules are present): the app's
 *     attendance check over HTTP (apps/oto-app/tests/attendance.check.ts —
 *     H13, H14 and H15 each by name, the casual worker's path, the configured
 *     reception tablet, and the restricted-branch proof per module with its
 *     FINDINGs pinned) against a fresh database, read back clean after.
 */

const REPO = fileURLToPath(new URL('../../../', import.meta.url));
const APP_DIR = fileURLToPath(new URL('../../oto-app/', import.meta.url));
const APP_SERVER = join(APP_DIR, 'server');
const APP_MIGRATIONS = join(APP_DIR, 'migrations');
const APP_NODE_MODULES = join(APP_DIR, 'node_modules');
const HAS_APP_RUNTIME = ['express', 'pg', 'tsx', 'drizzle-orm'].every((m) =>
  existsSync(join(APP_NODE_MODULES, m, 'package.json')),
);
const READBACK = join(APP_DIR, 'script', 'tenant-ownership-readback.mjs');

/** Comments out, so a sentence in a comment never stands in for code. */
const code = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
const routesText = () => code(readFileSync(join(APP_SERVER, 'routes.ts'), 'utf8'));

/** One route's handler, from its registration to the next registration. */
function route(text: string, method: string, path: string): string {
  const start = text.indexOf(`app.${method}("${path}"`);
  expect(start, `${method.toUpperCase()} ${path} is registered`).toBeGreaterThan(-1);
  const next = text.indexOf('\n  app.', start + 10);
  return text.slice(start, next === -1 ? undefined : next);
}

/** The first statement of a handler after its `try {`. */
const firstStatement = (body: string) => body.slice(body.indexOf('try {') + 5).trim().split('\n')[0]!.trim();

const plan = () => readFileSync(join(REPO, 'docs', 'progress', 'plans', 'otoapp-lift', 'PLAN.md'), 'utf8');
const question = (n: number) => {
  const text = plan();
  const start = text.indexOf(`- **Q${n}.`);
  expect(start, `Q${n} is in the plan`).toBeGreaterThan(-1);
  const end = text.indexOf('\n- **Q', start + 5);
  return text.slice(start, end === -1 ? text.indexOf('\n## ', start) : end);
};

// =============================================================================
// A. Leave approval restored (Q1, H14)
// =============================================================================

describe('A. leave approval, restored as the app does it (Q1, H14)', () => {
  it('the two lift-era 503s are gone from the approval doors', () => {
    const routes = routesText();
    expect(routes).not.toMatch(/Time-off approval is unavailable until approval tracking is enabled/);
    expect(route(routes, 'post', '/api/time-off')).toMatch(/approved: z\.boolean\(\)\.default\(false\)/);
    expect(route(routes, 'patch', '/api/time-off/:id')).toMatch(/approved: z\.boolean\(\)\.optional\(\)/);
  });

  it('created as approved: after the app’s own conflict check and the save, SICK frees that person’s assignments on the Bangkok days and raises one coverage alert per freed shift, in the person’s park group', () => {
    const post = route(routesText(), 'post', '/api/time-off');
    const conflict = post.indexOf('hasEmployeeShiftOnDate(employeeId, dateStr)');
    const save = post.indexOf('storage.createEmployeeTimeOff(');
    const step = post.indexOf('if (timeOffType === "SICK" && approved) {');
    expect(conflict).toBeGreaterThan(-1);
    expect(save).toBeGreaterThan(conflict);
    expect(step).toBeGreaterThan(save);
    const block = post.slice(step);
    // The Bangkok calendar days the lift already computes for the conflict check.
    expect(block).toMatch(/deleteAssignmentsByEmployeeAndDateRange\(\s*employeeId,\s*startDateStr,\s*endDateStr\s*\)/);
    expect(block).toMatch(/for \(const assignment of removedAssignments\)/);
    const alert = block.slice(block.indexOf('createAttentionItem({'));
    expect(alert).toMatch(/^createAttentionItem\(\{\s*tenantId: employee\.tenantId,\s*branchId,\s*employeeId,\s*type: "SHIFT_NEEDS_COVERAGE",/);
    expect(alert).toMatch(/ruleKey: "SICK_LEAVE_COVERAGE",\s*entityKey: `\$\{assignment\.shiftRowId\}_\$\{assignment\.shiftDate\}`/);
    expect(alert).toMatch(/called in sick\. Shift at \$\{shiftRow\.department\?\.name \|\| "Unknown dept"\} needs coverage\./);
    expect(block).toMatch(/if \(ATTENTION_WRITES_READY\) await storage\.createAttentionItem\(/);
    // The older shift list, over the app's range (Q38), errors ignored as the app did.
    expect(block).toMatch(/getShifts\(\{\s*branchId,\s*dateFrom: dateOnlyUtc\(startDateStr\),\s*dateTo: dateOnlyUtc\(endDateStr\),\s*employeeId,\s*\}\)/);
    expect(block).toMatch(/unassignShiftEmployee\(shift\.id, true\)/);
  });

  it('approved later: SICK unassigns the person’s legacy shifts over the record’s range, and stamps nothing', () => {
    const patch = route(routesText(), 'patch', '/api/time-off/:id');
    expect(patch).toMatch(/const isNowApproved = validationResult\.data\.approved === true;/);
    expect(patch).toMatch(/if \(record\.type === "SICK" && isNowApproved\) \{/);
    expect(patch).toMatch(
      /getShifts\(\{\s*branchId: record\.branchId,\s*dateFrom: record\.startDate,\s*dateTo: record\.endDate,\s*employeeId: record\.employeeId,\s*\}\)/,
    );
    expect(patch).not.toMatch(/approvedBy|approvedAt|existing\.approved|timeOffType === "SICK"/);
    // The update writes only the four fields the lift mapped; `approved` is never one of them.
    expect(patch).toMatch(/const updateData: \{ type\?: [^;]+; note\?: string \| null; startDate\?: Date; endDate\?: Date \} = \{\};/);
  });

  it('the rota sends every day off it adds as approved again (the app’s client body)', () => {
    const page = readFileSync(join(APP_DIR, 'client', 'src', 'pages', 'scheduling-page.tsx'), 'utf8');
    const mutation = page.slice(page.indexOf('const createTimeOffMutation = useMutation'), page.indexOf('const deleteTimeOffMutation'));
    expect(mutation).toMatch(
      /apiRequest\("POST", "\/api\/time-off", \{\s*employeeId,\s*branchId,\s*timeOffType,\s*startDate: date,\s*endDate: date,\s*approved: true,\s*\}\)/,
    );
  });

  it('nothing is stored: no app migration in round 5, and the time-off table has no approval column', () => {
    const journal = JSON.parse(readFileSync(join(APP_MIGRATIONS, 'meta', '_journal.json'), 'utf8')) as { entries: { idx: number; tag: string }[] };
    expect(journal.entries.at(-1)).toMatchObject({ idx: 7, tag: '0007_tenant_ownership_contract' });
    expect(readdirSync(APP_MIGRATIONS).filter((f) => /^\d{4}_.*\.sql$/.test(f))).toHaveLength(8);
    const schema = readFileSync(join(APP_DIR, 'shared', 'schema.ts'), 'utf8');
    const table = schema.slice(schema.indexOf('export const employeeTimeOff = pgTable('), schema.indexOf('export const employeeTimeOffRelations'));
    expect(table).not.toMatch(/approv/i);
  });
});

// =============================================================================
// B. A rota row always has a shift group (Q2, H15)
// =============================================================================

interface ShiftGroupRules {
  SHIFT_GROUP_REQUIRED: { reason: string; message: string };
  SHIFT_GROUP_DELETE_NEEDS_TARGET: { reason: string; message: string };
  noShiftGroup: (value: unknown) => boolean;
}

describe('B. a rota row always has a shift group (Q2, H15)', () => {
  let rules: ShiftGroupRules;
  beforeAll(async () => {
    rules = (await import(/* @vite-ignore */ pathToFileURL(join(APP_SERVER, 'lib', 'shiftGroupRequired.ts')).href)) as ShiftGroupRules;
  });

  it('the words: "Choose a shift group first", and an absent, null or empty group is none', () => {
    expect(rules.SHIFT_GROUP_REQUIRED).toEqual({ reason: 'shift_group_required', message: 'Choose a shift group first' });
    expect(rules.SHIFT_GROUP_DELETE_NEEDS_TARGET.message).toMatch(/^Choose a shift group first: /);
    for (const none of [undefined, null, '', '   ']) expect(rules.noShiftGroup(none), String(none)).toBe(true);
    expect(rules.noShiftGroup('b6c1f8f4-0000-4000-8000-000000000000')).toBe(false);
  });

  it('every door that would leave a row ungrouped refuses before it writes: create, edit, drag, and deleting a group with rows and no target', () => {
    const routes = routesText();
    const doors: Array<[string, string, string, string]> = [
      ['post', '/api/schedule/shift-rows', 'if (noShiftGroup(shiftGroupId))', 'storage.createShiftRow('],
      ['patch', '/api/schedule/shift-rows/:id', 'if (shiftGroupId !== undefined && noShiftGroup(shiftGroupId))', 'storage.updateShiftRow('],
      ['patch', '/api/schedule/shift-rows/:id/move-group', 'if (shiftGroupId !== undefined && noShiftGroup(shiftGroupId))', 'storage.updateShiftRow('],
      ['delete', '/api/schedule/shift-groups/:id', 'if (shiftsInGroup.length > 0 && noShiftGroup(targetGroupId))', 'storage.updateShiftRow('],
    ];
    for (const [method, path, guard, write] of doors) {
      const body = route(routes, method, path);
      const at = body.indexOf(guard);
      expect(at, `${path} refuses`).toBeGreaterThan(-1);
      expect(body.indexOf(write), `${path} refuses before it writes`).toBeGreaterThan(at);
      expect(body.slice(at, at + 200)).toMatch(/return res\.status\(400\)\.json\(SHIFT_GROUP_(REQUIRED|DELETE_NEEDS_TARGET)\)/);
    }
    // Nothing else about grouping changed: the create still stores the group it is given.
    expect(route(routes, 'post', '/api/schedule/shift-rows')).toMatch(/shiftGroupId: shiftGroupId \|\| null,/);
  });
});

// =============================================================================
// C. Face "off" refuses instead of matching (H13)
// =============================================================================

interface FaceOffRules {
  faceClockInOn: (env?: Record<string, string | undefined>) => boolean;
  FACE_OFF_NO_MATCH: { success: boolean; matched: boolean; confidence: number; message: string };
  FACE_CLOCK_OFF_REFUSAL: { reason: string; message: string };
  FACE_ENROLMENT_OFF_REFUSAL: { reason: string; message: string };
}

describe('C. face clock-in off, meaning off (H13)', () => {
  let rules: FaceOffRules;
  beforeAll(async () => {
    rules = (await import(/* @vite-ignore */ pathToFileURL(join(APP_SERVER, 'lib', 'faceOff.ts')).href)) as FaceOffRules;
  });

  it('the switch is the app’s own, read exactly as the face service reads it: on only for "true"', () => {
    expect(rules.faceClockInOn({ USE_AWS_REKOGNITION: 'true' })).toBe(true);
    for (const off of [undefined, '', 'false', 'TRUE', '1', 'yes']) {
      expect(rules.faceClockInOn({ USE_AWS_REKOGNITION: off }), String(off)).toBe(false);
    }
    const face = readFileSync(join(APP_SERVER, 'face-recognition.ts'), 'utf8');
    expect(face).toMatch(/const useAWS = process\.env\.USE_AWS_REKOGNITION === "true";/);
    expect(readFileSync(join(APP_SERVER, 'lib', 'faceOff.ts'), 'utf8')).toMatch(/return env\.USE_AWS_REKOGNITION === "true";/);
  });

  it('identify-face answers the app’s own no-match words while off — after the kiosk credential, before liveness, the enrolled list and the matcher', () => {
    expect(rules.FACE_OFF_NO_MATCH).toEqual({ success: true, matched: false, confidence: 0, message: 'No matching face found. Please use PIN entry.' });
    const routes = routesText();
    // The app's own sentence, which the tablet turns into its PIN fallback.
    expect(routes).toMatch(/: "No matching face found\. Please use PIN entry\."/);
    const body = route(routes, 'post', '/api/kiosk/identify-face');
    const off = body.indexOf('if (!faceClockInOn()) {');
    expect(off).toBeGreaterThan(body.indexOf('resolveKioskDevice(deviceSecret)'));
    expect(body.slice(off, off + 80)).toMatch(/return res\.json\(FACE_OFF_NO_MATCH\);/);
    for (const later of ['verifyMultiFrameLiveness(', 'getEnrolledEmployeesInTenant(', 'searchFace(']) {
      expect(body.indexOf(later), later).toBeGreaterThan(off);
    }
  });

  it('every door of the face road that writes a time event refuses first thing while off', () => {
    const routes = routesText();
    for (const path of ['/api/kiosk/clock', '/api/kiosk/missed-clock/auto-fix', '/api/kiosk/missed-clock/manual', '/api/kiosk/unscheduled-clock-in', '/api/kiosk/advisor-clock']) {
      expect(firstStatement(route(routes, 'post', path)), path).toBe('if (!faceClockInOn()) return res.status(403).json(FACE_CLOCK_OFF_REFUSAL);');
    }
  });

  it('enrolment is refused first thing at each of its four doors while off', () => {
    const routes = routesText();
    for (const path of [
      '/api/employees/:employeeId/enrollment-session',
      '/api/people/:personId/advisor-enrollment-session',
      '/api/kiosk/verify-enrollment-token',
      '/api/kiosk/complete-enrollment',
    ]) {
      expect(firstStatement(route(routes, 'post', path)), path).toBe('if (!faceClockInOn()) return res.status(403).json(FACE_ENROLMENT_OFF_REFUSAL);');
    }
  });

  it('every call of the face service sits behind the switch, but a face removal (reset), which matches nobody', () => {
    const routes = routesText();
    const handlers = routes.split('\n  app.').slice(1);
    const calls = handlers.filter((h) => /faceRecognitionService[,.]/.test(h));
    const unguarded = calls.filter((h) => !/if \(!faceClockInOn\(\)\)/.test(h)).map((h) => h.slice(0, h.indexOf('"', h.indexOf('"') + 1) + 1));
    expect(unguarded).toEqual(['post("/api/employees/:employeeId/reset-face-enrollment"']);
    expect(route(routes, 'post', '/api/employees/:employeeId/reset-face-enrollment')).not.toMatch(/enrollFace|searchFace|Liveness/);
  });

  it('PIN and phone are untouched, and the midnight auto clock-out keeps its FACE label (Q10)', () => {
    const routes = routesText();
    for (const path of ['/api/kiosk/clock-pin', '/api/kiosk/clock-phone']) expect(route(routes, 'post', path)).not.toMatch(/faceClockInOn/);
    const jobs = code(readFileSync(join(APP_SERVER, 'scheduled-jobs.ts'), 'utf8'));
    const autoOut = jobs.slice(jobs.indexOf('Auto-clocked out at midnight') - 600, jobs.indexOf('Auto-clocked out at midnight') + 100);
    expect(autoOut).toMatch(/authMethod: "FACE",/);
  });
});

// =============================================================================
// D. The reception tablet
// =============================================================================

describe('D. the reception tablet, configured for its own park group', () => {
  it('a kiosk code is minted only for a branch of the caller’s own park group (the app’s 404 words otherwise)', () => {
    const body = route(routesText(), 'post', '/api/branches/:branchId/kiosk-code');
    const check = body.indexOf('if (!branch || !tenantId || branch.tenantId !== tenantId) {');
    expect(check).toBeGreaterThan(-1);
    expect(body.indexOf('createKioskCode(')).toBeGreaterThan(check);
    expect(body.slice(check, check + 200)).toMatch(/res\.status\(404\)\.json\(\{ message: "Branch not found" \}\)/);
  });

  it('the tablet’s branch and board reads are held to its park group', () => {
    const routes = routesText();
    expect(route(routes, 'get', '/api/kiosk-reception/branch')).toMatch(/if \(!branch \|\| branch\.tenantId !== session\.tenantId\) \{/);
    expect(route(routes, 'get', '/api/kiosk-reception/checkins')).toMatch(
      /eq\(serviceCheckins\.tenantId, session\.tenantId\),\s*eq\(serviceCheckins\.branchId, session\.branchId\),/,
    );
  });
});

// =============================================================================
// E. CI and the plan
// =============================================================================

describe('E. CI and the plan', () => {
  it("CI's OTO App job runs the attendance check after the Attention check and before the read-back; the two new libs count as the seam", () => {
    const ci = readFileSync(join(REPO, '.github', 'workflows', 'ci.yml'), 'utf8');
    const job = ci.slice(ci.indexOf('\n  oto-app:'));
    expect(job).toMatch(/run: npx tsx tests\/attendance\.check\.ts/);
    expect(job.indexOf('tests/attendance.check.ts')).toBeGreaterThan(job.indexOf('tests/attention.check.ts'));
    expect(job.indexOf('tenant:readback')).toBeGreaterThan(job.indexOf('tests/attendance.check.ts'));
    const seam = new RegExp(/APP_SEAM='([^']+)'/.exec(ci)![1]!);
    for (const lib of ['faceOff', 'shiftGroupRequired']) expect(seam.test(`apps/oto-app/server/lib/${lib}.ts`), lib).toBe(true);
    expect([...ci.matchAll(/APP_SEAM='([^']+)'/g)].map((m) => m[1])).toEqual(Array(3).fill(/APP_SEAM='([^']+)'/.exec(ci)![1]));
  });

  it('the plan carries round 5’s questions, Q38 to Q45, each with its default', () => {
    for (let n = 38; n <= 45; n += 1) expect(question(n), `Q${n}`).toMatch(/Default: /);
    expect(plan()).toMatch(/\*\*As built in round 5/);
  });
});

// =============================================================================
// F. The real app
// =============================================================================

describe.skipIf(!HAS_APP_RUNTIME)('F. the real app: the attendance check over HTTP', () => {
  it('apps/oto-app/tests/attendance.check.ts passes against a fresh database (H13, H14, H15 by name), and every row it wrote reads back clean', async () => {
    const { url, drop } = await createTestDatabase({ otoapp: true });
    try {
      const result = spawnSync(process.execPath, [join(APP_NODE_MODULES, 'tsx', 'dist', 'cli.mjs'), 'tests/attendance.check.ts'], {
        cwd: APP_DIR,
        env: { ...process.env, DATABASE_URL: url },
        encoding: 'utf8',
        timeout: 280_000,
      });
      const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
      expect(result.status, output).toBe(0);
      expect(output).toMatch(/attendance\.check: 30 checks passed/);
      for (const hazard of ['(Q1, H14)', '(Q2, H15)', '(H13)']) expect(output, hazard).toContain(hazard);
      for (const finding of ['FINDING Q39', 'FINDING Q40', 'FINDING Q41']) expect(output, finding).toContain(finding);
      const back = spawnSync(process.execPath, [READBACK], { env: { ...process.env, DATABASE_URL: url }, encoding: 'utf8' });
      expect(back.status, `${back.stdout}\n${back.stderr}`).toBe(0);
    } finally {
      await drop();
    }
  }, 300_000);
});
