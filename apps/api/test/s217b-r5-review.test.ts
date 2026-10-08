import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomBytes, randomUUID, scryptSync } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase } from '@oto/db/testing';

/**
 * S2-17b round 5 (SCRUM-193 under SCRUM-191) — THE REVIEW, from the attacking
 * side (docs/progress/plans/otoapp-lift/PLAN.md section 8 round 5; hazards
 * H13-H15; Q1, Q2, Q9, Q10 and the builder's Q38-Q45), on top of the builder's
 * s217b-r5.test.ts and apps/oto-app/tests/attendance.check.ts, which this does
 * not repeat.
 *
 *  A. FENCES AND SEAMS, read off the code: 0006 and 0007 byte for byte what
 *     staging applied, no app or platform migration in the round, the
 *     booth's rota declaration still agreeing with the app's NOT NULL group,
 *     nothing of round 5 named by the booth, POS, console, launcher, packages
 *     or services, and nothing of rounds 6 and 7 in the app.
 *  B. H14 OVER HTTP, attacked: the leave's Bangkok days at the 17:00 UTC
 *     boundary and across a month end, one coverage alert per freed shift and
 *     no more over a three-month range, the wrong person (a colleague and a
 *     casual worker on the same rows and days) untouched, the alerts in the
 *     sick person's park group and invisible to another's, a repeat refused
 *     with nothing more freed or raised, another park group's record refused;
 *     and the approve raced by the rota's own assignment write in the order
 *     the builder's trigger does not cover.
 *  C. H13 ADVERSARIALLY, with an ENROLLED person and the switch UNSET (not
 *     "false"): identify-face, /api/kiosk/clock with a face method named, a
 *     replayed enrolment session that is still live in the table, the
 *     advisor's clock and the follow-on doors — no matcher, no enrolment, no
 *     FACE time event or success anywhere in the database; PIN (with a face
 *     method smuggled in) and phone still clock.
 *  D. H15 AND CASUAL WORKERS: the words and status at the doors for a
 *     whitespace group and an empty target, the casual worker's assignment
 *     surviving all of it, and whether the words reach the screen.
 *  E. THE RESTRICTED-BRANCH PROOFS, verified rather than read: the doors the
 *     builder's "holds" did not drive, and the "no rule" claims re-driven.
 *
 * Findings are pinned with `it.fails` (the repo's review convention): each
 * states the behaviour that should hold and fails until it is fixed; the `it`
 * beside it proves the failure is the defect, not the arrangement. Seven; two
 * medium, none in the round's own H13-H15 code, none blocking the merge:
 *
 *  1. (medium) The older shift list's coverage read crosses park groups.
 *     `GET /api/shifts-needing-coverage` with no `branchId` answers every
 *     branch's and every park group's legacy shifts flagged for coverage
 *     (`storage.getShiftsNeedingCoverage(undefined)` filters nothing), to a
 *     branch-limited manager and to any park group's manager. Round 5's
 *     restored sick-day step is the writer of exactly those flags
 *     (`unassignShiftEmployee(id, true)`), and Q39 and section 10 say "the
 *     older shift list keep[s] to the branch". Prescribed fix: on our own
 *     authority (data fault), hold the read to the caller's park group (join
 *     `branches.tenant_id`, or `shifts.tenant_id`, to the caller's); put the
 *     branch half (a limited manager reading other branches with no
 *     `branchId`) to the owner beside Q39, default as the app; correct Q39's
 *     sentence.
 *  2. (medium) The sick-leave policy crosses park groups. `sick_leave_policies`
 *     carries a NOT NULL `tenant_id`, but `storage.getSickLeavePolicy`'s
 *     company-wide fallback ignores it, so `POST /api/sick-leave-policy` with
 *     no branch by one park group's admin REWRITES another park group's
 *     company-wide entitlement, `GET /api/sick-leave-policy` answers it to
 *     them, and every balance of a branch without its own policy is computed
 *     from whichever park group's row comes first. Beside it,
 *     `GET /api/employees/:id/leave-balance` reads another park group's
 *     employee for any admin (`storage.getEmployee`, no park group). Neither
 *     is in Q40 or the census. Prescribed fix: on our own authority, no
 *     migration needed — the fallback and `getOrCreateSickLeavePolicy` take
 *     the park group (the caller's on the policy routes, the employee's for a
 *     balance), and the leave-balance read uses `getEmployeeInTenant`; or, at
 *     the least, name both in Q40 with the slice that fences them.
 *  3. (low) Revoking a reception tablet signs out another park group's.
 *     `revokeKioskDevice` deletes the device's kiosk sessions BEFORE it checks
 *     the device's park group, so `DELETE /api/kiosk-devices/:id/revoke` by
 *     another park group's manager answers 200 `{ success: true }` and signs
 *     that park group's reception tablet out (its device stays active, so it
 *     can come back through refresh-session). Prescribed fix: update the
 *     device first, held to the park group, delete its sessions only when that
 *     matched, and answer the app's 404 otherwise.
 *  4. (low) The approve raced the other way round. A rota assignment whose
 *     eligibility read ran before the sick day was saved, and whose insert
 *     lands after the sick-day route's freeing step, leaves the person on a
 *     shift on an approved sick day with no coverage alert: neither route
 *     holds anything across its check and its write. The builder's trigger
 *     proves only the other order (the shift lands between the check and the
 *     save, and is freed). Pinned below with a trigger that holds the
 *     assignment's insert until the sick day has answered. Prescribed fix: a
 *     per-person transaction-scoped advisory lock taken by the time-off
 *     create and by the assignment creates (single and batch) around their
 *     check and write; or record the effect in section 10 beside Q44.
 *  5. (low) Q2's words never reach the screen where Q2 names them. The rota's
 *     create and edit row mutations show a fixed "Failed to create shift row"
 *     and "Failed to update shift row" (`scheduling-page.tsx`, both
 *     `onError`), exactly what the old 500 showed; only the drag and the
 *     group delete show the server's message. Section 1 says the park sees
 *     "Choose a shift group first", and the casual-worker walkthrough will
 *     not. Prescribed fix: the two `onError`s show the error's message when
 *     the server gives one (the app's own page, as its move and delete
 *     already do); or correct section 1 and Q2 to say what the screen shows.
 *  6. (low) The proof's "holds" says more than was driven. Same park group,
 *     branch-limited manager, all 200: `GET /api/checklists/checker-history/
 *     :templateId` answers another branch's checklist history (checklists
 *     "hold" in Q39/section 10's account), and `GET /api/branches/:id/
 *     kiosk-devices` plus `DELETE /api/kiosk-devices/:id/revoke` list and
 *     revoke another branch's reception tablet (Q41 names only activation).
 *     These are rule questions, so the app's behaviour stays; the plan does
 *     not name them. Prescribed fix: add them to Q39/Q41 (or a Q46) with the
 *     app as default, and pin them as FINDINGs in tests/attendance.check.ts.
 *  7. (low) Three of the round's own observations are not where the plan's
 *     law puts them. Q38's default is "as built" (the later approve RUNS),
 *     while the live app never ran it — the standing default is the app's
 *     behaviour, so Q38 should either default to the live app's no-op or say
 *     plainly that it departs from it because H14 asked for it. Q31 placed
 *     `leave_policies` in round 5 by default; Q40 says it is "still owed"
 *     without naming the round that now carries it. The reception board's
 *     "today" starting at 07:00 Bangkok (a UTC `setHours(0)` in
 *     `/api/kiosk-reception/checkins`) is in the hand-off report only, not in
 *     section 10 or a question. Prescribed fix: the three plan edits.
 *
 * The walkthrough debt (item 6 of the review brief): the round's acceptance
 * names ten walkthrough pages; the builder claims none and lists them as owed
 * in the hand-off, and docs/qa/SPRINT_2_ACCEPTANCE.md still reads "Testing"
 * for each (with the leave row's 503 and the casual row's 500 describing
 * staging as it runs today). Nothing is claimed that was not shown.
 *
 * Section A runs everywhere; B to E need the app's node_modules (present
 * locally and in CI's OTO App job).
 */

const REPO = fileURLToPath(new URL('../../../', import.meta.url));
const APP_DIR = fileURLToPath(new URL('../../oto-app/', import.meta.url));
const APP_SERVER = join(APP_DIR, 'server');
const APP_MIGRATIONS = join(APP_DIR, 'migrations');
const APP_NODE_MODULES = join(APP_DIR, 'node_modules');
const HAS_APP_RUNTIME = ['express', 'pg', 'tsx', 'drizzle-orm'].every((m) =>
  existsSync(join(APP_NODE_MODULES, m, 'package.json')),
);
const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
/** A file as committed (LF), whatever the checkout did to its line ends. */
const committed = (path: string) => readFileSync(path, 'utf8').replace(/\r\n/g, '\n');

const plan = () => committed(join(REPO, 'docs', 'progress', 'plans', 'otoapp-lift', 'PLAN.md'));
const question = (n: number) => {
  const text = plan();
  const start = text.indexOf(`- **Q${n}.`);
  expect(start, `Q${n} is in the plan`).toBeGreaterThan(-1);
  const end = text.indexOf('\n- **Q', start + 5);
  return text.slice(start, end === -1 ? text.indexOf('\n## ', start) : end);
};
const section = (heading: string) => {
  const text = plan();
  const start = text.indexOf(`\n## ${heading}`);
  expect(start, heading).toBeGreaterThan(-1);
  return text.slice(start, text.indexOf('\n## ', start + 5));
};

function sourcesUnder(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const f of readdirSync(dir, { recursive: true }).map(String)) {
    if (/node_modules|[\\/]dist[\\/]|^dist[\\/]|\.turbo/.test(f)) continue;
    const path = join(dir, f);
    if (/\.(ts|tsx|mjs|js|cjs|json|sql|ya?ml)$/.test(f) && statSync(path).isFile()) out.push(path);
  }
  return out;
}

// =============================================================================
// A. Fences and seams, read off the code
// =============================================================================

describe('A. fences and seams', () => {
  it('0006 and 0007 are byte for byte what staging applied, and the round adds no app migration and no platform migration', () => {
    const applied = {
      '0006_tenant_ownership_expand.sql': 'e2f9c20269d7a508c636e8bc2b84e11ac5f82418df98890fc70b894e5d1e1225',
      '0007_tenant_ownership_contract.sql': '7c0408d7329f4d19ff26914f0eeaa0d8e855dc20f98f7eba6412279ba40b1a18',
      'meta/0007_snapshot.json': '919c1fe4851d4d3dbcf814cdd4b6b12e100e5d4ae83634b16021c36cc59ce19b',
      'meta/_journal.json': 'cf81449f7cb406b497ea245629c898e09ed1a37cb201cb5936bdc7c3a7617f19',
    };
    for (const [file, hash] of Object.entries(applied)) expect(sha256(committed(join(APP_MIGRATIONS, file))), file).toBe(hash);
    expect(readdirSync(APP_MIGRATIONS).filter((f) => f.endsWith('.sql')).sort().at(-1)).toBe('0007_tenant_ownership_contract.sql');
    const platform = JSON.parse(committed(join(REPO, 'packages', 'db', 'migrations', 'meta', '_journal.json'))) as { entries: { tag: string }[] };
    expect(platform.entries.at(-1)?.tag).toBe('0075_event_booking_pass');
  });

  it('the booth reads a rota row’s group as NOT NULL, and the app keeps it so (Q2’s default; no ungrouped row can reach the roster)', () => {
    const platform = readFileSync(join(REPO, 'packages', 'db', 'src', 'schema', 'otoapp.ts'), 'utf8');
    const rows = platform.slice(platform.indexOf("otoapp.table('schedule_shift_rows'"));
    expect(rows.slice(0, rows.indexOf('});'))).toMatch(/shiftGroupId: varchar\('shift_group_id'\)\.notNull\(\)/);
    const schema = readFileSync(join(APP_DIR, 'shared', 'schema.ts'), 'utf8');
    expect(schema).toMatch(/shiftGroupId: varchar\("shift_group_id"\)\.references\(\(\) => shiftGroups\.id, \{ onDelete: "restrict" \}\)\.notNull\(\),/);
  });

  it('the booth, POS, console, launcher, packages and services name nothing of round 5', () => {
    const roots = ['apps/booth', 'apps/pos', 'apps/console', 'apps/launcher', 'packages', 'services'].map((r) => join(REPO, r));
    const patterns = [/faceOff|faceClockInOn|FACE_(CLOCK|ENROLMENT)_OFF|face_off/, /shiftGroupRequired|SHIFT_GROUP_(REQUIRED|DELETE_NEEDS_TARGET)|shift_group_required/, /SICK_LEAVE_COVERAGE|SHIFT_NEEDS_COVERAGE/];
    const hits: string[] = [];
    for (const root of roots) {
      for (const path of sourcesUnder(root)) {
        const text = readFileSync(path, 'utf8');
        for (const p of patterns) if (p.test(text)) hits.push(`${path.slice(REPO.length)} ~ ${p}`);
      }
    }
    expect(hits).toEqual([]);
  });

  it('nothing of rounds 6 and 7 in the app: the legacy-table guard stands at eleven, the face matcher is the app’s, and no 503 guard of the document modules moved', () => {
    const raw = readFileSync(join(APP_SERVER, 'routes.ts'), 'utf8');
    expect(raw.match(/legacyHrUser\(/g)?.length).toBe(11);
    expect(readFileSync(join(APP_SERVER, 'face-recognition.ts'), 'utf8')).toMatch(
      /const useAWS = process\.env\.USE_AWS_REKOGNITION === "true";\s*if \(useAWS\) \{\s*return new AWSRekognitionService\(\);\s*\}\s*return new MockFaceRecognitionService\(\);/,
    );
    expect(readFileSync(join(APP_SERVER, 'data-admin', 'router.ts'), 'utf8')).toMatch(/router\.use\("\/attention-items", \(_req: Request, res: Response\) => \{\s*res\.status\(503\)/);
  });
});

// =============================================================================
// A, continued: what the screen shows, and what the plan says
// =============================================================================

describe('A. the screen and the plan, read off the code', () => {
  const page = () => readFileSync(join(APP_DIR, 'client', 'src', 'pages', 'scheduling-page.tsx'), 'utf8');
  const mutation = (name: string) => {
    const text = page();
    const start = text.indexOf(`const ${name} = useMutation(`);
    expect(start, name).toBeGreaterThan(-1);
    return text.slice(start, text.indexOf('\n  });', start));
  };

  it('the drag and the group delete show the server’s words; the create and edit row mutations show a fixed sentence (the arrangement of finding 5)', () => {
    expect(mutation('moveShiftRowGroupMutation')).toMatch(/onError: \(err: Error\) => \{\s*toast\(\{ title: "Failed to move shift", description: err\.message,/);
    expect(mutation('deleteShiftGroupMutation')).toMatch(/onError: \(err: Error\) => \{\s*toast\(\{ title: "Failed to delete shift group", description: err\.message,/);
    expect(mutation('createShiftRowMutation')).toMatch(/onError: \(\) => \{\s*toast\(\{ title: "Error", description: "Failed to create shift row",/);
    expect(mutation('updateShiftRowMutation')).toMatch(/onError: \(\) => \{\s*toast\(\{ title: "Error", description: "Failed to update shift row",/);
    // The create sends no group when none is chosen, and the edit form's "Ungrouped" sends null: both reach the 400.
    expect(page()).toMatch(/shiftGroupId: selectedShiftGroupId \|\| undefined,/);
    expect(page()).toMatch(/shiftGroupId: val === "__none__" \? null : val/);
  });

  it.fails('FINDING 5 (low): "Choose a shift group first" reaches the manager on the create and edit dialogs, the doors Q2 and section 1 name', () => {
    for (const name of ['createShiftRowMutation', 'updateShiftRowMutation']) {
      expect(mutation(name), name).toMatch(/onError: \((err|error)(: Error)?\) => \{[\s\S]{0,200}\.message/);
    }
  });

  it('Q39 and section 10 say the older shift list keeps to the branch; Q41 names only activation; the checklist history door is named nowhere (the arrangement of findings 1 and 6)', () => {
    expect(question(39)).toMatch(/The rota view\s+\(`\/api\/rota`\) and the older shift list do keep to the branch\./);
    expect(question(41)).toMatch(/can make a reception kiosk\s+code for any branch of their park group/);
    expect(plan()).not.toMatch(/checker-history/);
    expect(plan()).not.toMatch(/shifts-needing-coverage/);
  });

  it.fails('FINDING 6 (low): the plan names the doors the restricted-branch proof did not hold — the checklist history, and the tablet list and revoke — with the app as default', () => {
    expect(plan()).toMatch(/checker-history/);
    expect(question(41)).toMatch(/revoke/);
  });

  it.fails('FINDING 1, the plan half (medium): Q39 no longer says the older shift list keeps to the branch, and names the coverage read', () => {
    expect(question(39)).not.toMatch(/the older shift list do keep to the branch/);
    expect(plan()).toMatch(/shifts-needing-coverage/);
  });

  it('Q38 defaults to "as built", which runs the later approve the live app never ran; Q31’s round 5 placement of leave_policies is "still owed" with no round named; the 07:00 board start is nowhere in the plan (the arrangement of finding 7)', () => {
    expect(question(38)).toMatch(/so\s+in\s+the\s+live\s+app\s+it\s+never\s+ran\.\s+As\s+built\s+it\s+runs/);
    expect(question(38)).toMatch(/Default: as built/);
    expect(question(40)).toMatch(/whose round 5 placement was not in round 5's row and\s+is still owed\./);
    expect(section('10. Known effects')).not.toMatch(/kiosk-reception|reception board|reception tablet's board/);
  });

  it.fails('FINDING 7 (low): Q38 defaults to the live app or says it departs from it; leave_policies has a named round; the reception board’s 07:00 day start is a known effect or a question', () => {
    expect(question(38)).toMatch(/Default: (the live app|as the live app)|departs from the live app/);
    expect(question(40)).toMatch(/leave_policies[^.]*\b(in|to|with) round [6-8]\b|leave_policies[^.]*its own slice/);
    expect(section('10. Known effects')).toMatch(/07:00/);
  });
});

// =============================================================================
// The app over HTTP — the harness for B to E
// =============================================================================

const children: ChildProcess[] = [];
afterAll(() => {
  for (const child of children) child.kill();
});

const PASSWORD = 'zz-r5-review-password';
/** The app's own password format (`hashPassword` in server/auth.ts): scrypt, 64 bytes, then the salt. */
const hashPassword = (password: string) => {
  const salt = randomBytes(16).toString('hex');
  return `${scryptSync(password, salt, 64).toString('hex')}.${salt}`;
};

async function serve(databaseUrl: string): Promise<{ origin: string; output: () => string }> {
  const env: Record<string, string | undefined> = {
    ...process.env,
    NODE_ENV: 'test',
    APP_ENV: 'dev',
    STORAGE_ENV_PREFIX: 'zz-r5-review',
    OBJECT_STORAGE: 'local',
    OTOAPP_LEGACY_LOGIN: 'true',
    LOG_LEVEL: 'warn',
    TZ: 'UTC',
    DEPLOY_ENV: 'local',
    OTOAPP_JOBS: 'platform',
    DATABASE_URL: databaseUrl,
  };
  // The switch UNSET, not "false": "off" is anything but "true" (H13).
  delete env.USE_AWS_REKOGNITION;
  delete env.HARNESS_FAKE_NOW;
  const child = spawn(process.execPath, [join(APP_NODE_MODULES, 'tsx', 'dist', 'cli.mjs'), 'tests/harness/serve-routes.ts'], {
    cwd: APP_DIR,
    env: env as NodeJS.ProcessEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(child);
  let output = '';
  const origin = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`harness did not start:\n${output}`)), 180_000);
    const read = (chunk: Buffer) => {
      output += chunk.toString('utf8');
      const m = /HARNESS_PORT=(\d+)/.exec(output);
      if (m) {
        clearTimeout(timer);
        resolve(`http://127.0.0.1:${m[1]}`);
      }
    };
    child.stdout!.on('data', read);
    child.stderr!.on('data', read);
    child.on('exit', (status) => {
      clearTimeout(timer);
      reject(new Error(`harness exited ${status}:\n${output}`));
    });
  });
  return { origin, output: () => output };
}

interface Answer {
  status: number;
  text: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- a JSON answer read field by field
  body: any;
  cookie: string;
}

let ORIGIN = '';
async function call(method: string, path: string, opts: { cookie?: string; body?: unknown; headers?: Record<string, string> } = {}): Promise<Answer> {
  const res = await fetch(`${ORIGIN}${path}`, {
    method,
    headers: {
      ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(opts.cookie ? { cookie: opts.cookie } : {}),
      ...opts.headers,
    },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    // Not JSON — kept as text.
  }
  return {
    status: res.status,
    text,
    body,
    cookie: res.headers
      .getSetCookie()
      .map((c) => c.split(';')[0])
      .join('; '),
  };
}

async function signIn(email: string): Promise<string> {
  const res = await call('POST', '/api/login', { body: { identifier: email, password: PASSWORD } });
  expect(res.status, `sign-in as ${email}: ${res.text}`).toBe(200);
  return res.cookie;
}

type Q = <T extends pg.QueryResultRow = Record<string, unknown>>(text: string, params?: unknown[]) => Promise<T[]>;

/** A Bangkok calendar date `n` days from now. */
const day = (n: number) => new Date(Date.now() + 7 * 3_600_000 + n * 86_400_000).toISOString().slice(0, 10);
/** A YYYY-MM-DD date moved by `n` days. */
const shift = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

interface ParkGroup {
  tenant: string;
  x: string;
  y: string;
  department: string;
  role: string;
  admin: { id: string; email: string; cookie: string };
  /** A manager limited to branch X. */
  limited: { id: string; email: string; cookie: string };
}

describe.skipIf(!HAS_APP_RUNTIME)('B to E. over HTTP against the app’s routes', () => {
  let drop: () => Promise<void> = async () => undefined;
  let pool: pg.Pool;
  let output: () => string = () => '';
  const run = randomBytes(3).toString('hex');
  const q: Q = async (text, params = []) => (await pool.query(text, params)).rows;
  const count = async (text: string, params: unknown[] = []) => Number((await q<{ n: string }>(text, params))[0]!.n);
  let A: ParkGroup;
  let B: ParkGroup;

  async function user(tenant: string, role: string, email: string, branch: string | null): Promise<string> {
    const id = randomUUID();
    await q(`insert into users (id, email, password, full_name, role, is_active, must_change_password) values ($1, $2, $3, 'ZZ R5RV', $4, true, false)`, [
      id,
      email,
      hashPassword(PASSWORD),
      role,
    ]);
    await q('insert into user_branch_access (tenant_id, user_id, branch_id, access_scope) values ($1, $2, $3, $4)', [
      tenant,
      id,
      branch,
      branch ? 'selected_branches' : 'all_branches',
    ]);
    return id;
  }

  async function parkGroup(label: string): Promise<ParkGroup> {
    const tenant = randomUUID();
    await q('insert into tenants (id, name, slug) values ($1, $2, $3)', [tenant, `ZZ R5RV ${label} ${run}`, `zz-r5rv-${label}-${run}`]);
    const [x, y] = [randomUUID(), randomUUID()];
    for (const [id, suffix] of [
      [x, 'x'],
      [y, 'y'],
    ] as const) {
      await q(`insert into branches (id, tenant_id, name, address, timezone) values ($1, $2, $3, 'ZZ', 'Asia/Bangkok')`, [id, tenant, `ZZ R5RV ${label} ${suffix} ${run}`]);
    }
    const department = randomUUID();
    await q('insert into departments (id, tenant_id, name) values ($1, $2, $3)', [department, tenant, `ZZ R5RV ${label} ${run}`]);
    const role = randomUUID();
    await q('insert into roles (id, tenant_id, name) values ($1, $2, $3)', [role, tenant, `ZZ R5RV ${label} ${run}`]);
    const adminEmail = `zz-r5rv-${label}-admin-${run}@example.com`;
    const limitedEmail = `zz-r5rv-${label}-limited-${run}@example.com`;
    const adminId = await user(tenant, 'admin', adminEmail, null);
    const limitedId = await user(tenant, 'manager', limitedEmail, x);
    return {
      tenant,
      x,
      y,
      department,
      role,
      admin: { id: adminId, email: adminEmail, cookie: '' },
      limited: { id: limitedId, email: limitedEmail, cookie: '' },
    };
  }

  async function employee(g: ParkGroup, branch: string | null, label: string, fields: Record<string, unknown> = {}): Promise<string> {
    const id = randomUUID();
    const cols = ['id', 'tenant_id', 'branch_id', 'full_name', 'nickname', 'email', 'status', ...Object.keys(fields)];
    const vals = [id, g.tenant, branch, `ZZ R5RV ${run} ${label}`, 'ZZ', `zz-r5rv-${label}-${id.slice(0, 8)}@example.com`, 'active', ...Object.values(fields)];
    await q(`insert into employees (${cols.join(', ')}) values (${cols.map((_, i) => `$${i + 1}`).join(', ')})`, vals);
    return id;
  }

  async function rota(g: ParkGroup, branch: string, weekStart: string) {
    const plan = randomUUID();
    await q('insert into schedule_week_plans (id, tenant_id, branch_id, week_start_date) values ($1, $2, $3, $4)', [plan, g.tenant, branch, weekStart]);
    const group = randomUUID();
    await q('insert into shift_groups (id, tenant_id, branch_id, name) values ($1, $2, $3, $4)', [group, g.tenant, branch, `ZZ R5RV ${run}`]);
    const rows: string[] = [];
    for (const [start, end] of [
      ['09:00', '17:00'],
      ['18:00', '22:00'],
    ]) {
      const row = randomUUID();
      await q(
        `insert into schedule_shift_rows (id, tenant_id, branch_id, shift_group_id, week_plan_id, start_time, end_time, label)
         values ($1, $2, $3, $4, $5, $6, $7, 'ZZ R5RV')`,
        [row, g.tenant, branch, group, plan, start, end],
      );
      rows.push(row);
    }
    return { plan, group, r1: rows[0]!, r2: rows[1]! };
  }

  async function assign(g: ParkGroup, plan: string, row: string, date: string, employeeId: string): Promise<string> {
    const id = randomUUID();
    await q('insert into schedule_assignments (id, tenant_id, week_plan_id, shift_row_id, shift_date, employee_id) values ($1, $2, $3, $4, $5, $6)', [
      id,
      g.tenant,
      plan,
      row,
      date,
      employeeId,
    ]);
    return id;
  }

  const PARKED = `zz_r5rv_parked_${run}`;
  const HELD = `zz_r5rv_held_${run}`;

  beforeAll(async () => {
    let url = '';
    ({ url, drop } = await createTestDatabase({ otoapp: true }));
    pool = new pg.Pool({ connectionString: url, options: '-c search_path=otoapp', max: 6 });
    await q("insert into tenants (name, slug) values ('OTO Default', 'default') on conflict (slug) do nothing");
    A = await parkGroup('a');
    B = await parkGroup('b');
    // A shift assigned in the instant the sick day is saved (the builder's
    // device, under this file's own names): parked assignments are re-pointed
    // to the person when their day off lands, between the route's conflict
    // check and its freeing step.
    await q(`create table ${PARKED} (note text not null, assignment_id varchar not null)`);
    await q(`create function ${PARKED}() returns trigger language plpgsql as $$
             begin
               update schedule_assignments set employee_id = new.employee_id
                where id in (select assignment_id from ${PARKED} where note = new.note);
               return new;
             end $$`);
    await q(`create trigger ${PARKED} after insert on employee_time_off for each row execute function ${PARKED}()`);
    const server = await serve(url);
    ORIGIN = server.origin;
    output = server.output;
    for (const g of [A, B]) {
      g.admin.cookie = await signIn(g.admin.email);
      g.limited.cookie = await signIn(g.limited.email);
    }
  }, 300_000);

  afterAll(async () => {
    await pool?.end();
    await drop();
  });

  // ── B. H14, attacked ────────────────────────────────────────────────────────

  const coverage = (employeeId: string) =>
    q<{ id: string; tenant_id: string; branch_id: string; entity_key: string; type: string; status: string }>(
      `select id, tenant_id, branch_id, entity_key, type, status from attention_items
        where employee_id = $1 and rule_key = 'SICK_LEAVE_COVERAGE' order by entity_key`,
      [employeeId],
    );
  const ownerOf = async (ids: string[]) =>
    Object.fromEntries((await q<{ id: string; employee_id: string | null }>('select id, employee_id from schedule_assignments where id = any($1)', [ids])).map((r) => [r.id, r.employee_id]));

  let sick = '';
  let sickRecord = '';
  const freedKeys: string[] = [];

  it('B1. the leave’s Bangkok days, from 17:00 UTC to 16:59:59.999 UTC and across a month end: exactly the inside days are freed — not the day before, not the day after, not a colleague’s, not a casual worker’s — one alert per freed shift, every one in the person’s park group', async () => {
    sick = await employee(A, A.x, 'sick');
    const parked = await employee(A, A.x, 'parked');
    const colleague = await employee(A, A.x, 'colleague');
    // The last day of a month at least six weeks out: the leave is D-1 .. D+2.
    let D = day(45);
    while (shift(D, 1).slice(8) !== '01') D = shift(D, 1);
    const R = await rota(A, A.x, shift(D, -3));
    const inside = [shift(D, -1), D, shift(D, 1), shift(D, 2)];
    const outside = [shift(D, -2), shift(D, 3)];
    const note = `ZZ R5RV month end ${run}`;
    const parkedIds: Record<string, string> = {};
    for (const d of [...inside, ...outside]) {
      parkedIds[d] = await assign(A, R.plan, R.r1, d, parked);
      await q(`insert into ${PARKED} (note, assignment_id) values ($1, $2)`, [note, parkedIds[d]]);
    }
    const colleagues = await Promise.all(inside.map((d) => assign(A, R.plan, R.r1, d, colleague)));
    const casual = randomUUID();
    await q(
      `insert into casual_workers (id, tenant_id, full_name, nickname, branch_id, department_id, role_id, start_date, end_date, daily_rate)
       values ($1, $2, $3, 'ZZ', $4, $5, $6, $7, $8, 650)`,
      [casual, A.tenant, `ZZ R5RV casual ${run}`, A.x, A.department, A.role, day(0), shift(D, 30)],
    );
    const casualAssignment = randomUUID();
    await q(
      `insert into schedule_assignments (id, tenant_id, week_plan_id, shift_row_id, shift_date, assignee_type, casual_worker_id, daily_rate_snapshot)
       values ($1, $2, $3, $4, $5, 'casual', $6, 650)`,
      [casualAssignment, A.tenant, R.plan, R.r2, D, casual],
    );

    const res = await call('POST', '/api/time-off', {
      cookie: A.admin.cookie,
      body: {
        employeeId: sick,
        branchId: A.x,
        timeOffType: 'SICK',
        // 00:00 Bangkok on D-1 and 23:59:59.999 Bangkok on D+2, written in UTC.
        startDate: `${shift(D, -2)}T17:00:00.000Z`,
        endDate: `${shift(D, 2)}T16:59:59.999Z`,
        notes: note,
        approved: true,
      },
    });
    expect(res.status, res.text).toBe(201);
    sickRecord = res.body.id as string;
    const [saved] = await q<{ s: string; e: string }>('select start_date::date::text as s, end_date::date::text as e from employee_time_off where id = $1', [sickRecord]);
    expect(saved).toEqual({ s: inside[0], e: inside[3] });

    const owners = await ownerOf([...Object.values(parkedIds), ...colleagues, casualAssignment]);
    for (const d of inside) expect(owners[parkedIds[d]!], `${d} freed`).toBeUndefined();
    for (const d of outside) expect(owners[parkedIds[d]!], `${d} kept`).toBe(sick);
    for (const id of colleagues) expect(owners[id], 'a colleague’s shift stays').toBe(colleague);
    expect(Object.keys(owners)).toContain(casualAssignment);

    const items = await coverage(sick);
    expect(items.map((i) => i.entity_key)).toEqual(inside.map((d) => `${R.r1}_${d}`).sort());
    for (const item of items) expect(item).toMatchObject({ tenant_id: A.tenant, branch_id: A.x, type: 'SHIFT_NEEDS_COVERAGE', status: 'open' });
    freedKeys.push(...items.map((i) => i.id));
    expect(await count("select count(*) as n from attention_items where tenant_id = $1", [B.tenant])).toBe(0);
  });

  it('B2. the alerts are the sick person’s park group’s to read: A’s manager lists them, B’s admin lists none and counts none', async () => {
    const a = await call('GET', '/api/attention-items', { cookie: A.admin.cookie });
    expect(a.status, a.text).toBe(200);
    const aIds = (a.body.items as { id: string }[]).map((i) => i.id);
    for (const id of freedKeys) expect(aIds).toContain(id);
    const b = await call('GET', '/api/attention-items', { cookie: B.admin.cookie });
    expect(b.status, b.text).toBe(200);
    expect((b.body.items as { id: string }[]).filter((i) => freedKeys.includes(i.id))).toEqual([]);
    const counts = await call('GET', '/api/attention-items/counts', { cookie: B.admin.cookie });
    expect(counts.status, counts.text).toBe(200);
    expect(counts.body).toEqual({ total: 0, high: 0, medium: 0, low: 0 });
    const aCounts = await call('GET', '/api/attention-items/counts', { cookie: A.admin.cookie });
    expect(aCounts.body.total).toBeGreaterThanOrEqual(freedKeys.length);
  });

  it('B3. a repeat of the same sick day is the app’s 409 and frees and raises nothing more; another park group cannot approve the record later', async () => {
    const before = (await coverage(sick)).length;
    const [rowBefore] = await q('select * from employee_time_off where id = $1', [sickRecord]);
    const [d] = (await q<{ s: string }>('select start_date::date::text as s from employee_time_off where id = $1', [sickRecord])).map((r) => r.s);
    const again = await call('POST', '/api/time-off', {
      cookie: A.admin.cookie,
      body: { employeeId: sick, branchId: A.x, timeOffType: 'SICK', startDate: d, endDate: d, approved: true },
    });
    expect(again.status, again.text).toBe(409);
    expect(again.body.message).toBe(`Cannot add time-off: employee already has time-off on ${d}.`);
    expect((await coverage(sick)).length).toBe(before);
    const legacy = randomUUID();
    await q(
      `insert into shifts (id, tenant_id, branch_id, department_id, start_at, end_at, employee_id, status, created_by)
       values ($1, $2, $3, $4, $5::timestamp, $5::timestamp + interval '8 hours', $6, 'ASSIGNED', $7)`,
      [legacy, A.tenant, A.x, A.department, `${d} 00:00:00`, sick, A.admin.id],
    );
    const foreign = await call('PATCH', `/api/time-off/${sickRecord}`, { cookie: B.admin.cookie, body: { approved: true } });
    expect(foreign.status, foreign.text).toBe(404);
    expect((await q<{ employee_id: string }>('select employee_id from shifts where id = $1', [legacy]))[0]!.employee_id).toBe(sick);
    const [rowAfter] = await q('select * from employee_time_off where id = $1', [sickRecord]);
    expect(rowAfter).toEqual(rowBefore);
  });

  it('B4. no flood: a three-month sick range frees the two shifts the instant assigned, raises two alerts, and answers promptly', async () => {
    const person = await employee(A, A.x, 'long');
    const parked = await employee(A, A.x, 'long-parked');
    const [first, last] = [day(150), day(241)];
    const R = await rota(A, A.x, first);
    const note = `ZZ R5RV long ${run}`;
    const ids = [await assign(A, R.plan, R.r1, day(160), parked), await assign(A, R.plan, R.r2, day(230), parked)];
    for (const id of ids) await q(`insert into ${PARKED} (note, assignment_id) values ($1, $2)`, [note, id]);
    const started = Date.now();
    const res = await call('POST', '/api/time-off', {
      cookie: A.admin.cookie,
      body: { employeeId: person, branchId: A.x, timeOffType: 'SICK', startDate: first, endDate: last, notes: note, approved: true },
    });
    expect(res.status, res.text).toBe(201);
    expect(Date.now() - started).toBeLessThan(30_000);
    expect(await ownerOf(ids)).toEqual({});
    expect((await coverage(person)).map((i) => i.entity_key)).toEqual([`${R.r1}_${day(160)}`, `${R.r2}_${day(230)}`].sort());
  });

  // The other order: the rota's eligibility read runs before the sick day is
  // saved, and its insert lands after the sick-day route's freeing step. A
  // BEFORE INSERT trigger holds that one insert until the sick day has answered.
  let raced: { person: string; date: string; assignment: Answer; timeOff: Answer } | undefined;
  async function race() {
    if (raced) return raced;
    const person = await employee(A, A.x, 'raced');
    const date = day(60);
    const R = await rota(A, A.x, date);
    await q(`create function ${HELD}() returns trigger language plpgsql as $$
             begin perform pg_sleep(4); return new; end $$`);
    await q(`create trigger ${HELD} before insert on schedule_assignments for each row
             when (new.employee_id = '${person}') execute function ${HELD}()`);
    try {
      const assignment = call('POST', '/api/schedule/assignments', {
        cookie: A.admin.cookie,
        body: { weekPlanId: R.plan, shiftRowId: R.r1, shiftDate: date, employeeId: person },
      });
      // Wait until the assignment's insert is held: its eligibility read has run.
      const deadline = Date.now() + 10_000;
      while (
        (await count(
          `select count(*) as n from pg_stat_activity
            where datname = current_database() and state = 'active' and query ilike 'insert into "schedule_assignments"%'`,
        )) === 0
      ) {
        if (Date.now() > deadline) throw new Error('the assignment insert was never held');
        await new Promise((r) => setTimeout(r, 25));
      }
      const timeOff = await call('POST', '/api/time-off', {
        cookie: A.admin.cookie,
        body: { employeeId: person, branchId: A.x, timeOffType: 'SICK', startDate: date, endDate: date, approved: true },
      });
      raced = { person, date, assignment: await assignment, timeOff };
      return raced;
    } finally {
      await q(`drop trigger if exists ${HELD} on schedule_assignments`);
      await q(`drop function if exists ${HELD}()`);
    }
  }

  it('B5. the arrangement of finding 4: with the assignment’s eligibility read made first, both routes answer 201 — the sick day saved as approved, the rota’s assignment saved', async () => {
    const r = await race();
    expect(r.timeOff.status, r.timeOff.text).toBe(201);
    expect(r.assignment.status, r.assignment.text).toBe(201);
  }, 60_000);

  it.fails('FINDING 4 (low): an approved sick day never leaves the person on a rota shift that day without a coverage alert, whichever route wrote last', async () => {
    const r = await race();
    const left = await count('select count(*) as n from schedule_assignments where employee_id = $1 and shift_date = $2', [r.person, r.date]);
    const alerts = (await coverage(r.person)).length;
    expect(left === 0 || alerts > 0, `left on ${left} shift(s) with ${alerts} alert(s)`).toBe(true);
  }, 60_000);

  // ── C. H13, adversarially ───────────────────────────────────────────────────

  const PIN = '7305';
  const PHONE_LOCAL = `08${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`;
  let enrolled = '';
  let deviceSecret = '';
  let faceDevice = '';

  it('C1. with the switch UNSET and an ENROLLED person present, identify-face answers the app’s no-match words and the matcher prints nothing; /api/kiosk/clock naming them with a face method is refused', async () => {
    enrolled = await employee(A, A.x, 'enrolled', {
      face_enrollment_status: 'ENROLLED',
      face_id: `face_zz_${run}`,
      face_enrolled_at: new Date(),
      timeclock_pin_hash: sha256(PIN),
      phone_e164: `+66${PHONE_LOCAL.slice(1)}`,
    });
    deviceSecret = randomBytes(32).toString('hex');
    faceDevice = randomUUID();
    await q(
      `insert into kiosk_devices (id, tenant_id, branch_id, name, device_secret_hash, kiosk_type, is_active)
       values ($1, $2, $3, 'ZZ R5RV face tablet', $4, 'face_recognition', true)`,
      [faceDevice, A.tenant, A.x, sha256(deviceSecret)],
    );
    const identify = await call('POST', '/api/kiosk/identify-face', {
      body: { faceImageBase64: 'zz', faceFramesBase64: ['zz1', 'zz2', 'zz3', 'zz4', 'zz5'], deviceSecret },
    });
    expect(identify.status, identify.text).toBe(200);
    expect(identify.body).toEqual({ success: true, matched: false, confidence: 0, message: 'No matching face found. Please use PIN entry.' });
    for (const body of [
      { employeeId: enrolled, confidenceScore: 99.9, livenessScore: 99, deviceSecret, authMethod: 'FACE', method: 'FACE' },
      { employeeId: enrolled, deviceSecret },
    ]) {
      const clock = await call('POST', '/api/kiosk/clock', { body });
      expect(clock.status, clock.text).toBe(403);
      expect(clock.body.reason).toBe('face_off');
    }
    expect(output()).not.toMatch(/MockFaceRecognition|AWSRekognition\]|\[IdentifyFace\]/);
  });

  it('C2. an enrolment session still live in the table is refused at the token check and at the capture, and stays unused; the person’s face fields do not move', async () => {
    const unenrolled = await employee(A, A.x, 'unenrolled');
    const token = randomBytes(24).toString('hex');
    const session = randomUUID();
    await q(`insert into enrollment_sessions (id, employee_id, token_hash, expires_at, created_by) values ($1, $2, $3, now() + interval '1 hour', $4)`, [
      session,
      unenrolled,
      sha256(token),
      A.admin.id,
    ]);
    const before = await q('select face_enrollment_status, face_id, face_enrolled_at from employees where id = $1', [unenrolled]);
    const verify = await call('POST', '/api/kiosk/verify-enrollment-token', { body: { token, deviceSecret } });
    expect(verify.status, verify.text).toBe(403);
    expect(verify.body.reason).toBe('face_off');
    const complete = await call('POST', '/api/kiosk/complete-enrollment', {
      body: { sessionId: session, enrollmentToken: token, faceImageBase64: 'zz', consentGiven: true, deviceSecret },
    });
    expect(complete.status, complete.text).toBe(403);
    expect(complete.body.reason).toBe('face_off');
    expect(await q('select used_at from enrollment_sessions where id = $1', [session])).toEqual([{ used_at: null }]);
    expect(await q('select face_enrollment_status, face_id, face_enrolled_at from employees where id = $1', [unenrolled])).toEqual(before);
    const fresh = await call('POST', `/api/employees/${unenrolled}/enrollment-session`, { cookie: A.admin.cookie, body: {} });
    expect(fresh.status, fresh.text).toBe(403);
    expect(await count('select count(*) as n from enrollment_sessions where employee_id = $1', [unenrolled])).toBe(1);
  });

  it('C3. the advisor’s clock and the follow-on doors refuse the enrolled person too; nowhere in the database is there a FACE time event or a FACE success', async () => {
    const d = day(0);
    for (const [path, body] of [
      ['/api/kiosk/advisor-clock', { identificationProof: 'zz.zz.zz', confidenceScore: 99, deviceSecret }],
      ['/api/kiosk/missed-clock/auto-fix', { employeeId: enrolled, branchId: A.x, scheduledStart: `${d}T02:00:00Z`, scheduledEnd: `${d}T10:00:00Z`, shiftDate: d, deviceSecret }],
      ['/api/kiosk/unscheduled-clock-in', { employeeId: enrolled, branchId: A.x, reasonCode: 'OTHER', deviceSecret }],
    ] as const) {
      const res = await call('POST', path, { body });
      expect(res.status, `${path}: ${res.text}`).toBe(403);
      expect(res.body.reason).toBe('face_off');
    }
    expect(await count(`select count(*) as n from time_events where auth_method = 'FACE'`)).toBe(0);
    expect(await count(`select count(*) as n from kiosk_auth_attempts where method = 'FACE' and outcome = 'SUCCESS'`)).toBe(0);
    expect(await count('select count(*) as n from advisor_attendance_sessions')).toBe(0);
  });

  it('C4. PIN (with a face method smuggled into the body) and phone still clock the same person on the same tablet, recorded as PIN and phone', async () => {
    const pin = await call('POST', '/api/kiosk/clock-pin', { body: { employeeId: enrolled, pin: PIN, photoEvidenceUrl: '', deviceSecret, authMethod: 'FACE' } });
    expect(pin.status, pin.text).toBe(200);
    expect(pin.body.eventType).toBe('IN');
    const phone = await call('POST', '/api/kiosk/clock-phone', { body: { phone: PHONE_LOCAL, photoEvidenceUrl: '', deviceSecret } });
    expect(phone.status, phone.text).toBe(200);
    expect(phone.body.eventType).toBe('OUT');
    expect(await q('select auth_method, event_type from time_events where employee_id = $1 order by event_time', [enrolled])).toEqual([
      { auth_method: 'PIN', event_type: 'IN' },
      { auth_method: 'PHONE_FALLBACK', event_type: 'OUT' },
    ]);
  });

  // ── D. H15 and casual workers ───────────────────────────────────────────────

  it('D1. a whitespace group, an empty target and a cleared group are the same 400 in words at every door; the casual worker’s shift on the group survives all of it; a group with a target still deletes', async () => {
    const R = await rota(A, A.y, day(20));
    const casual = randomUUID();
    await q(
      `insert into casual_workers (id, tenant_id, full_name, nickname, branch_id, department_id, role_id, start_date, end_date, daily_rate)
       values ($1, $2, $3, 'ZZ', $4, $5, $6, $7, $8, 700)`,
      [casual, A.tenant, `ZZ R5RV casual y ${run}`, A.y, A.department, A.role, day(0), day(90)],
    );
    const assigned = await call('POST', '/api/schedule/assignments', {
      cookie: A.admin.cookie,
      body: { weekPlanId: R.plan, shiftRowId: R.r1, shiftDate: day(21), casualWorkerId: casual, assigneeType: 'casual' },
    });
    expect(assigned.status, assigned.text).toBe(201);
    const required = { reason: 'shift_group_required', message: 'Choose a shift group first' };
    const rows = () => count('select count(*) as n from schedule_shift_rows where branch_id = $1', [A.y]);
    const before = await rows();
    for (const group of ['   ', '']) {
      const res = await call('POST', '/api/schedule/shift-rows', { cookie: A.admin.cookie, body: { branchId: A.y, startTime: '10:00', endTime: '18:00', label: 'ZZ', shiftGroupId: group } });
      expect(res.status, res.text).toBe(400);
      expect(res.body).toEqual(required);
      for (const path of [`/api/schedule/shift-rows/${R.r1}`, `/api/schedule/shift-rows/${R.r1}/move-group`]) {
        const edit = await call('PATCH', path, { cookie: A.admin.cookie, body: { shiftGroupId: group } });
        expect(edit.status, `${path}: ${edit.text}`).toBe(400);
        expect(edit.body).toEqual(required);
      }
    }
    expect(await rows()).toBe(before);
    const del = await call('DELETE', `/api/schedule/shift-groups/${R.group}?targetGroupId=`, { cookie: A.admin.cookie });
    expect(del.status, del.text).toBe(400);
    expect(del.body.message).toBe('Choose a shift group first: this group still has shifts, so pick the group to move them to.');
    expect(await q('select shift_group_id from schedule_shift_rows where id = $1', [R.r1])).toEqual([{ shift_group_id: R.group }]);
    expect(await q('select casual_worker_id, daily_rate_snapshot from schedule_assignments where id = $1', [assigned.body.id])).toEqual([
      { casual_worker_id: casual, daily_rate_snapshot: 700 },
    ]);
    const target = randomUUID();
    await q('insert into shift_groups (id, tenant_id, branch_id, name) values ($1, $2, $3, $4)', [target, A.tenant, A.y, `ZZ R5RV target ${run}`]);
    const moved = await call('DELETE', `/api/schedule/shift-groups/${R.group}?targetGroupId=${target}`, { cookie: A.admin.cookie });
    expect(moved.status, moved.text).toBe(204);
    expect(await q('select shift_group_id from schedule_shift_rows where id = $1', [R.r1])).toEqual([{ shift_group_id: target }]);
    expect(await count('select count(*) as n from schedule_assignments where id = $1', [assigned.body.id])).toBe(1);
  });

  // ── E. The restricted-branch proofs, verified ───────────────────────────────

  const legacy = async (g: ParkGroup, branch: string) => {
    const id = randomUUID();
    await q(
      `insert into shifts (id, tenant_id, branch_id, department_id, start_at, end_at, employee_id, status, needs_coverage, created_by)
       values ($1, $2, $3, $4, now() + interval '20 days', now() + interval '20 days 8 hours', null, 'OPEN', true, $5)`,
      [id, g.tenant, branch, g.department, g.admin.id],
    );
    return id;
  };
  let coverageRows: { ax: string; ay: string; bx: string } | undefined;
  const coverageFixture = async () => (coverageRows ??= { ax: await legacy(A, A.x), ay: await legacy(A, A.y), bx: await legacy(B, B.x) });
  const coverageList = async (cookie: string, query = '') => {
    const res = await call('GET', `/api/shifts-needing-coverage${query}`, { cookie });
    expect(res.status, res.text).toBe(200);
    return (res.body as { id: string }[]).map((s) => s.id);
  };

  it('E1. the arrangement of finding 1: with a branch named the coverage read keeps a limited manager to it; with none it answers branch Y and park group B too, and B’s admin reads A’s', async () => {
    const rows = await coverageFixture();
    const denied = await call('GET', `/api/shifts-needing-coverage?branchId=${A.y}`, { cookie: A.limited.cookie });
    expect(denied.status).toBe(403);
    const limited = await coverageList(A.limited.cookie);
    expect(limited).toEqual(expect.arrayContaining([rows.ax, rows.ay, rows.bx]));
    expect(await coverageList(B.admin.cookie)).toEqual(expect.arrayContaining([rows.ax, rows.ay]));
  });

  it.fails('FINDING 1 (medium): the coverage read with no branch answers only the caller’s own park group', async () => {
    const rows = await coverageFixture();
    expect(await coverageList(A.limited.cookie)).not.toContain(rows.bx);
    expect(await coverageList(B.admin.cookie)).not.toContain(rows.ax);
  });

  /** A's and B's company-wide sick-leave rows, after each admin saves its own. */
  let policies: { aSaved: Answer; bSaved: Answer; rows: { tenant_id: string; annual_sick_leave_days: number }[]; bRead: Answer } | undefined;
  async function sickLeavePolicies() {
    if (policies) return policies;
    const aSaved = await call('POST', '/api/sick-leave-policy', { cookie: A.admin.cookie, body: { annualSickLeaveDays: 12 } });
    const bSaved = await call('POST', '/api/sick-leave-policy', { cookie: B.admin.cookie, body: { annualSickLeaveDays: 3 } });
    const rows = await q<{ tenant_id: string; annual_sick_leave_days: number }>(
      'select tenant_id, annual_sick_leave_days from sick_leave_policies where branch_id is null and tenant_id = any($1) order by tenant_id',
      [[A.tenant, B.tenant]],
    );
    const bRead = await call('GET', '/api/sick-leave-policy', { cookie: B.admin.cookie });
    policies = { aSaved, bSaved, rows, bRead };
    return policies;
  }

  it('E2. the arrangement of finding 2: each admin’s company-wide sick-leave save answers 200, but B’s lands on A’s row; and B’s admin reads an A employee’s leave balance', async () => {
    const p = await sickLeavePolicies();
    expect(p.aSaved.status, p.aSaved.text).toBe(200);
    expect(p.bSaved.status, p.bSaved.text).toBe(200);
    expect(p.rows).toEqual([{ tenant_id: A.tenant, annual_sick_leave_days: 3 }]);
    expect(p.bRead.body.annualSickLeaveDays).toBe(3);
    const empA = await employee(A, A.x, 'balance');
    const balance = await call('GET', `/api/employees/${empA}/leave-balance`, { cookie: B.admin.cookie });
    expect(balance.status, balance.text).toBe(200);
    expect(balance.body.employeeId).toBe(empA);
  });

  it.fails('FINDING 2 (medium): each park group keeps its own company-wide sick-leave policy, and another park group’s employee’s leave balance is a 404', async () => {
    const p = await sickLeavePolicies();
    expect(p.rows).toEqual(
      [
        { tenant_id: A.tenant, annual_sick_leave_days: 12 },
        { tenant_id: B.tenant, annual_sick_leave_days: 3 },
      ].sort((l, r) => l.tenant_id.localeCompare(r.tenant_id)),
    );
    const empA = await employee(A, A.x, 'balance-2');
    expect((await call('GET', `/api/employees/${empA}/leave-balance`, { cookie: B.admin.cookie })).status).toBe(404);
  });

  /** A reception tablet on branch Y, activated from a code by A's admin. */
  async function receptionTablet(): Promise<{ token: string; device: string }> {
    const code = await call('POST', `/api/branches/${A.y}/kiosk-code`, { cookie: A.admin.cookie });
    expect(code.status, code.text).toBe(200);
    const exchanged = await call('POST', '/api/kiosk/exchange', { body: { code: code.body.code } });
    expect(exchanged.status, exchanged.text).toBe(200);
    return { token: exchanged.body.token as string, device: exchanged.body.device.id as string };
  }
  const sessionOf = (token: string) => call('GET', '/api/kiosk-reception/session', { headers: { authorization: `Bearer ${token}` } });

  let foreignRevoke: { tablet: { token: string; device: string }; revoke: Answer; after: Answer } | undefined;
  async function revokedFromElsewhere() {
    if (foreignRevoke) return foreignRevoke;
    const tablet = await receptionTablet();
    expect((await sessionOf(tablet.token)).status).toBe(200);
    const revoke = await call('DELETE', `/api/kiosk-devices/${tablet.device}/revoke`, { cookie: B.admin.cookie });
    const after = await sessionOf(tablet.token);
    foreignRevoke = { tablet, revoke, after };
    return foreignRevoke;
  }

  it('E3. the arrangement of finding 3: another park group’s revoke answers 200 and A’s tablet is signed out, while A’s device stays active', async () => {
    const r = await revokedFromElsewhere();
    expect(r.revoke.status, r.revoke.text).toBe(200);
    expect(r.revoke.body).toEqual({ success: true });
    expect(r.after.status).toBe(401);
    expect(await q('select is_active from kiosk_devices where id = $1', [r.tablet.device])).toEqual([{ is_active: true }]);
  });

  it.fails('FINDING 3 (low): another park group’s revoke is the app’s 404 and A’s tablet keeps its session', async () => {
    const r = await revokedFromElsewhere();
    expect(r.revoke.status).toBe(404);
    expect(r.after.status).toBe(200);
  });

  it('E4. finding 6 over HTTP, as the app (no branch rule, so it stands until the owner says otherwise): a manager limited to X reads Y’s checklist history, lists Y’s reception tablets and revokes one', async () => {
    const template = randomUUID();
    await q('insert into checklist_templates (id, tenant_id, branch_id, name) values ($1, $2, $3, $4)', [template, A.tenant, A.y, `ZZ R5RV y ${run}`]);
    const runId = randomUUID();
    await q(`insert into checklist_runs (id, tenant_id, template_id, branch_id, status, completed_at) values ($1, $2, $3, $4, 'completed', now())`, [
      runId,
      A.tenant,
      template,
      A.y,
    ]);
    expect((await call('GET', `/api/checklists/templates/${template}`, { cookie: A.limited.cookie })).status).toBe(403);
    const history = await call('GET', `/api/checklists/checker-history/${template}`, { cookie: A.limited.cookie });
    expect(history.status, history.text).toBe(200);
    expect((history.body.runs as { id: string; branchId: string }[]).map((r) => [r.id, r.branchId])).toEqual([[runId, A.y]]);
    const tablet = await receptionTablet();
    const listed = await call('GET', `/api/branches/${A.y}/kiosk-devices`, { cookie: A.limited.cookie });
    expect(listed.status, listed.text).toBe(200);
    expect((listed.body as { id: string }[]).map((d) => d.id)).toContain(tablet.device);
    const revoked = await call('DELETE', `/api/kiosk-devices/${tablet.device}/revoke`, { cookie: A.limited.cookie });
    expect(revoked.status, revoked.text).toBe(200);
    expect(await q('select is_active from kiosk_devices where id = $1', [tablet.device])).toEqual([{ is_active: false }]);
  });

  it('E5. the builder’s "no rule" claims, re-driven with writes: a manager limited to X assigns onto Y’s rota and retires Y’s row (Q39), and the leave-policy read refuses even X (Q40)', async () => {
    const R = await rota(A, A.y, day(25));
    const empY = await employee(A, A.y, 'rota-y');
    const assigned = await call('POST', '/api/schedule/assignments', {
      cookie: A.limited.cookie,
      body: { weekPlanId: R.plan, shiftRowId: R.r1, shiftDate: day(26), employeeId: empY },
    });
    expect(assigned.status, assigned.text).toBe(201);
    const retired = await call('DELETE', `/api/schedule/shift-rows/${R.r2}`, { cookie: A.limited.cookie });
    expect([200, 204], retired.text).toContain(retired.status);
    expect((await call('GET', `/api/leave-policies?branchId=${A.x}`, { cookie: A.limited.cookie })).status).toBe(403);
    expect((await call('GET', `/api/sick-leave-balances?branchId=${A.y}`, { cookie: A.limited.cookie })).status).toBe(200);
  });
});
