/**
 * Cut a sample out of the park's production export and write it to
 * `data.generated.ts`, which is what `script/sample/main.ts` loads.
 *
 *   docker exec ... createdb oto_dump_probe
 *   docker exec -i ... psql -d oto_dump_probe < imports/_db/db-...-dump-...sql
 *   DUMP_DATABASE_URL=postgres://oto:oto@localhost:5433/oto_dump_probe \
 *     npx tsx script/sample/extract.ts
 *
 * This file and its output are committed. The dump is not, and never is —
 * `imports/` is outside the workspace and ignored by git. Re-running this needs
 * the dump restored locally; re-running the *seed* does not, because the sample
 * it needs is already in the generated file.
 *
 * Read-only: every statement here is a SELECT.
 *
 * ## The sampling rule
 *
 * The owner asked for ten to fifteen percent of the real rows. Ten percent of
 * every table taken independently would produce a park that does not hold
 * together — a clock-in belonging to nobody, a department with no staff in it,
 * half an org chart. So the percentage is spent where the volume is, and the
 * rows that give the volume its meaning are kept whole:
 *
 *  1. **Lookups whole.** Tenant, operator, all three branches, all twelve
 *     departments, all twelve roles and every department-branch and role-branch
 *     link. Seventy-six rows in total — no volume at all, and without them every
 *     sampled row below loses the thing it points at.
 *  2. **People are the unit, one per staffed department.** Ten of the sixty-nine
 *     employees, which is 14.5% — the top of the band — and the smallest number
 *     that leaves no staffed department empty. Which person within a department
 *     is chosen by {@link scorePerson}, which works to a quota: every shape in
 *     the real staff list gets a target equal to its share scaled to ten people
 *     and floored at one, and a candidate is worth something only while the
 *     sample is short of it. That is what keeps the Thai-to-English name mix at
 *     the park's own 7:3 while still finding room for the two foreign hires,
 *     the part-timer and the people on their way out. Deterministic, so a
 *     re-extract picks the same ten.
 *
 *     The one distribution this knowingly does not preserve is the size of the
 *     departments themselves. Kitchen has eleven staff and Sales Booth three;
 *     ten slots spread in proportion would give Kitchen two and leave Sales
 *     Booth and Accounting with nobody. An empty department is the more
 *     misleading of the two errors, so every staffed department gets exactly
 *     one person and the headcounts are flat. `staffInExport` on each
 *     department carries the real number for anything that wants it.
 *  3. **Their rows follow them, whole.** Every role assignment and every clock-in
 *     of a sampled person. Not sampled again — a fortnight of attendance with
 *     four fifths of the days missing is not a smaller park, it is a broken one.
 *  4. **Tasks are sampled by family, to a row budget.** A task is the one thing
 *     here that belongs to a branch rather than a person, so it is sampled on its
 *     own at 15% of 333 rows. Recurring work is a parent row with up to 34
 *     children; families are taken whole so no child is left pointing at a parent
 *     that was not sampled.
 *  5. **Announcements: there is one.** Fifteen percent of one row is none, so the
 *     single real announcement is carried whole, alongside the banner the seed
 *     writes to say the data is sampled.
 *
 * ## What is deliberately left behind
 *
 * {@link CARRIED_EMPLOYEE_COLUMNS} is an allowlist, so a column is carried only
 * by being named there. Everything dropped is listed in {@link WITHHELD} with the
 * reason, and that list is printed at the end of a run.
 */

// First, and before `pg`: the export's timestamps carry no offset, and reading
// them on a laptop in Bangkok would shift every one of them by seven hours.
import './utc';

import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const OUT = join(dirname(fileURLToPath(import.meta.url)), 'data.generated.ts');

/** People: one per staffed department. Ten of sixty-nine — 14.5%. */
const PEOPLE_PER_DEPARTMENT = 1;
/** Tasks: the share of the table taken, as rows, families rounded to fit under it. */
const TASK_SAMPLE_RATE = 0.15;

/**
 * The domain every sampled address is rewritten onto. `.test` is reserved by
 * RFC 2606 and can never resolve, so nothing in the sample can mail a real
 * person even if outbound mail were switched on by mistake. The local part is
 * the real one — it is as identifying as the name beside it, which is carried,
 * and it is what makes the list look like a real staff list.
 */
const SAMPLE_EMAIL_DOMAIN = 'sample.oto.test';

/** Every column read out of `employees`. Anything not here is not carried. */
const CARRIED_EMPLOYEE_COLUMNS = [
  'id',
  'full_name',
  'thai_name',
  'nickname',
  'email',
  'phone',
  'branch_id',
  'primary_department_id',
  'status',
  'employment_state',
  'employment_basis',
  'daily_rate',
  'food_allowance_per_day',
  'start_date',
  'notice_date',
  'last_working_day',
  'end_reason',
  'offboarding_type',
  'nationality',
  'is_foreign_staff',
  'visa_expiry_date',
  'work_permit_expiry_date',
  'job_description',
  'weekly_off_days',
  'display_order',
  'default_merge_data',
] as const;

/** Printed at the end of a run, and the source of the report's list. */
const WITHHELD: { what: string; why: string }[] = [
  {
    what: 'employees.email domain (local part kept, domain rewritten)',
    why: '61 of 69 are the staff member\'s personal mailbox. A reserved .test domain keeps the address recognisable and un-mailable.',
  },
  {
    what: 'employees.profile_photo_path / _captured_at / _source / _updated_by',
    why: 'A photograph of a named person. 65 of 69 have one.',
  },
  {
    what: 'employees.face_id / face_enrollment_status / face_enrolled_at',
    why: 'A biometric template reference for a named person (AWS Rekognition). 64 of 69 have one.',
  },
  {
    what: 'employees.timeclock_pin_hash / _set_at',
    why: 'A credential. Empty in the export in any case.',
  },
  {
    what: 'employees.sso_number, employees.tax_id_number',
    why: 'Government identifiers. 1 of 69 each.',
  },
  {
    what: 'employees.address',
    why: 'A home address. 58 of 69 have one, and no screen in this app needs it to look real.',
  },
  {
    what: 'employees.user_id',
    why: 'The link to a sign-in account. Accounts come from the platform\'s provisioning; a seeded link would be a second way in that survives being deactivated there.',
  },
  {
    what: 'employees.incentive_clause_text, employees.resignation_form_path, employees.termination_letter_path',
    why: 'Free-text contract terms and document paths naming an individual.',
  },
  {
    what: 'employees.person_id and the whole `people` table',
    why: 'It carries its own PIN hash, face id and phone. The seed leaves person_id NULL, as the previous sample did.',
  },
  {
    what: 'users, sessions, auth_otp_events, auth_rate_limits, kiosk_* (11,900 rows)',
    why: 'Sign-ins, one-time codes and device registrations. None of it is park data and all of it is a way in.',
  },
];

const url = process.env.DUMP_DATABASE_URL;
if (!url) {
  console.error(
    '\nextract: DUMP_DATABASE_URL is not set. Point it at a LOCAL database with\n' +
      'the export restored into it — never at staging, and never at the platform\n' +
      'database this app runs on.\n',
  );
  process.exit(1);
}

const client = new pg.Client({ connectionString: url, application_name: 'oto-app-sample-extract' });

/** `Oto Play Park, Central Floresta ` — trailing space and all — becomes `oto-play-park-central-floresta`. */
function slug(name: string): string {
  const s = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  return s.length > 0 ? s : 'x';
}

/** Unique slugs, in a stable order, so a re-extract produces the same keys. */
function keyer(): (name: string) => string {
  const used = new Map<string, number>();
  return (name: string) => {
    const base = slug(name);
    const n = used.get(base) ?? 0;
    used.set(base, n + 1);
    return n === 0 ? base : `${base}-${n + 1}`;
  };
}

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);

interface Row {
  [column: string]: unknown;
}

async function q<T = Row>(text: string, values: unknown[] = []): Promise<T[]> {
  const r = await client.query(text, values);
  return r.rows as T[];
}

/**
 * The shapes a sampled staff list has to show between its ten people.
 *
 * Each department contributes one person, so which person that is is the only
 * lever there is on what the ten show. Plain novelty — "nobody has this yet" —
 * gets the rare shapes in but wrecks the common ones: the park's staff are 68%
 * Thai-named, and scoring an English-only name as a novelty once is enough to
 * invert that to 60/40 in a sample this small.
 *
 * So each trait carries a target instead: its share of the real population,
 * scaled to ten people, floored at one so a shape held by two of sixty-nine
 * still appears. A candidate is worth something for a trait only while the
 * sample is under that trait's target. Thai names then land at seven of ten,
 * and the single foreign hire, the part-timer and the leavers still get in.
 */
function traitsOf(e: Row): string[] {
  const t: string[] = [];
  t.push(`branch:${String(e.branch_id ?? 'none')}`);
  t.push(`state:${String(e.employment_state)}`);
  t.push(`status:${String(e.status)}`);
  t.push(`basis:${String(e.employment_basis)}`);
  if (e.is_foreign_staff === true) t.push('foreign');
  if (e.nationality) t.push('nationality');
  t.push(e.thai_name ? 'thai-name' : 'english-only-name');
  if (e.end_reason) t.push('end-reason');
  if (e.notice_date) t.push('notice-date');
  if (e.last_working_day) t.push('last-working-day');
  if (e.job_description) t.push('job-description');
  if (e.daily_rate !== null) t.push('daily-rate');
  if (e.food_allowance_per_day !== null) t.push('food-allowance');
  t.push(Number(e.event_count ?? 0) > 0 ? 'has-attendance' : 'no-attendance');
  if (Number(e.override_count ?? 0) > 0) t.push('has-admin-override');
  return t;
}

interface TraitPlan {
  /** How many of the sampled people should carry the trait. */
  target: Map<string, number>;
  /**
   * What carrying it is worth while the sample is short of that target —
   * the inverse of how common it is.
   *
   * A flat bonus per unmet trait does not work: seven ordinary traits
   * (Thai-named, full-time, active, at the main branch, and so on) add up to
   * more than the one trait only two people in the park have, so the
   * part-timer and the foreign hire lose every contest and the sample comes
   * back as ten interchangeable people. Weighting by 1/share makes a shape
   * held by two of sixty-nine worth thirty-four ordinary ones, which is about
   * right when there are only ten slots to spend.
   */
  weight: Map<string, number>;
}

function planTraits(population: Row[], sampleSize: number): TraitPlan {
  const counts = new Map<string, number>();
  for (const e of population) {
    for (const t of traitsOf(e)) counts.set(t, (counts.get(t) ?? 0) + 1);
  }
  const target = new Map<string, number>();
  const weight = new Map<string, number>();
  for (const [t, n] of counts) {
    target.set(t, Math.max(1, Math.round((n / population.length) * sampleSize)));
    weight.set(t, population.length / n);
  }
  return { target, weight };
}

function scorePerson(e: Row, running: Map<string, number>, plan: TraitPlan): number {
  let score = 0;
  for (const t of traitsOf(e)) {
    if ((running.get(t) ?? 0) < (plan.target.get(t) ?? 0)) score += plan.weight.get(t) ?? 0;
  }
  // Among equals, the longer-serving person: a start date two years back reads
  // as a real staff list better than ten people who all joined last month.
  // Small on purpose — it breaks ties, it does not win contests.
  const started = e.start_date instanceof Date ? e.start_date.getTime() : Date.now();
  score += (Date.now() - started) / (1000 * 60 * 60 * 24 * 365) / 100;
  return score;
}

async function main(): Promise<void> {
  await client.connect();

  const before = new Map<string, number>();
  for (const t of [
    'tenants', 'operators', 'branches', 'departments', 'roles',
    'department_branch_assignments', 'role_branch_assignments',
    'employees', 'employee_roles', 'time_events', 'tasks', 'announcements',
  ]) {
    const [r] = await q<{ n: string }>(`select count(*)::text as n from "${t}"`);
    before.set(t, Number(r!.n));
  }

  // ---- 1. Lookups, whole -------------------------------------------------

  const [tenant] = await q('select id, name, slug from tenants order by created_at limit 1');
  const [operator] = await q('select id, name, status from operators order by name limit 1');
  if (!tenant || !operator) throw new Error('the export has no tenant or no operator');

  const branchKey = keyer();
  const branchRows = await q(
    'select id, name, address, timezone, calendar_color from branches order by name',
  );
  const branchKeyById = new Map<string, string>();
  const branches = branchRows.map((b) => {
    const key = branchKey(String(b.name));
    branchKeyById.set(String(b.id), key);
    return {
      key,
      name: String(b.name),
      address: String(b.address),
      timezone: String(b.timezone),
      calendarColor: (b.calendar_color as string | null) ?? null,
    };
  });

  /**
   * Two rows are named `Event Department` in the export — one active with five
   * staff, one inactive with none. The seed's find-or-create matches a
   * department by name, so it could only ever create the first of the two. The
   * duplicate is dropped here rather than silently swallowed there, and the
   * survivor is the one the staff are attached to.
   */
  const deptRows = await q(`
    select d.id, d.name, d.display_order, d.is_active, d.description,
           count(e.id)::int as staff
      from departments d
      left join employees e on e.primary_department_id = d.id
     group by d.id, d.name, d.display_order, d.is_active, d.description
     order by d.display_order, d.name, d.id
  `);
  const collapsedDepartments: string[] = [];
  const deptByName = new Map<string, Row>();
  for (const d of deptRows) {
    const k = String(d.name).trim().toLowerCase();
    const seen = deptByName.get(k);
    if (!seen) {
      deptByName.set(k, d);
      continue;
    }
    const winner =
      Number(d.staff) > Number(seen.staff) || (Number(d.staff) === Number(seen.staff) && d.is_active)
        ? d
        : seen;
    deptByName.set(k, winner);
    collapsedDepartments.push(String(d.name).trim());
  }

  const deptKey = keyer();
  const deptKeyById = new Map<string, string>();
  const departments = [...deptByName.values()]
    .sort((a, b) => Number(a.display_order) - Number(b.display_order) || String(a.name).localeCompare(String(b.name)))
    .map((d) => {
      const key = deptKey(String(d.name));
      deptKeyById.set(String(d.id), key);
      return {
        key,
        name: String(d.name),
        displayOrder: Number(d.display_order),
        isActive: Boolean(d.is_active),
        description: (d.description as string | null) ?? null,
        staffInExport: Number(d.staff),
        branchKeys: [] as string[],
      };
    });
  const deptByKey = new Map(departments.map((d) => [d.key, d]));

  const roleKey = keyer();
  const roleKeyById = new Map<string, string>();
  const roles = (await q('select id, name, is_active, description from roles order by name')).map(
    (r) => {
      const key = roleKey(String(r.name));
      roleKeyById.set(String(r.id), key);
      return {
        key,
        name: String(r.name),
        isActive: Boolean(r.is_active),
        description: (r.description as string | null) ?? null,
        branchKeys: [] as string[],
      };
    },
  );
  const roleByKey = new Map(roles.map((r) => [r.key, r]));

  for (const l of await q('select department_id, branch_id from department_branch_assignments')) {
    const d = deptByKey.get(deptKeyById.get(String(l.department_id)) ?? '');
    const b = branchKeyById.get(String(l.branch_id));
    if (d && b && !d.branchKeys.includes(b)) d.branchKeys.push(b);
  }
  for (const l of await q('select role_id, branch_id from role_branch_assignments')) {
    const r = roleByKey.get(roleKeyById.get(String(l.role_id)) ?? '');
    const b = branchKeyById.get(String(l.branch_id));
    if (r && b && !r.branchKeys.includes(b)) r.branchKeys.push(b);
  }
  for (const d of departments) d.branchKeys.sort();
  for (const r of roles) r.branchKeys.sort();

  // ---- 2. People: one per staffed department -----------------------------

  const cols = CARRIED_EMPLOYEE_COLUMNS.map((c) => `e."${c}"`).join(', ');
  const staff = await q(`
    select ${cols},
           (select count(*) from time_events t where t.employee_id = e.id)::int as event_count,
           (select count(*) from time_events t
             where t.employee_id = e.id and t.auth_method = 'ADMIN_OVERRIDE')::int as override_count
      from employees e
     where e.primary_department_id is not null
       and exists (select 1 from departments d where d.id = e.primary_department_id)
     order by e.id
  `);
  /**
   * One employee points at a department id that no longer exists. There is no
   * foreign key on `primary_department_id`, so the export carries it happily;
   * the query above leaves that row out rather than seeding a person into a
   * department the screens cannot resolve.
   */
  const orphaned = Number(before.get('employees')) - staff.length;

  const byDept = new Map<string, Row[]>();
  for (const e of staff) {
    const key = deptKeyById.get(String(e.primary_department_id));
    if (!key) continue;
    const list = byDept.get(key) ?? [];
    list.push(e);
    byDept.set(key, list);
  }

  // Largest department first, so the widest choice is made while the fewest
  // traits are covered and the scoring has the most to work with.
  const order = [...byDept.entries()].sort(
    (a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]),
  );

  const plan = planTraits(staff, order.length * PEOPLE_PER_DEPARTMENT);
  const running = new Map<string, number>();
  const chosen: { row: Row; deptKey: string }[] = [];
  for (const [dk, candidates] of order) {
    const ranked = [...candidates].sort(
      (a, b) =>
        scorePerson(b, running, plan) - scorePerson(a, running, plan) ||
        String(a.id).localeCompare(String(b.id)),
    );
    for (const row of ranked.slice(0, PEOPLE_PER_DEPARTMENT)) {
      chosen.push({ row, deptKey: dk });
      for (const t of traitsOf(row)) running.set(t, (running.get(t) ?? 0) + 1);
    }
  }

  const personKey = keyer();
  const personKeyById = new Map<string, string>();
  const people = chosen.map(({ row: e, deptKey: dk }) => {
    const local = String(e.email).split('@')[0]!.trim();
    const key = personKey(local);
    personKeyById.set(String(e.id), key);
    return {
      key,
      fullName: String(e.full_name),
      thaiName: (e.thai_name as string | null) ?? null,
      nickname: String(e.nickname),
      emailLocal: local,
      phone: (e.phone as string | null) ?? null,
      deptKey: dk,
      branchKey: branchKeyById.get(String(e.branch_id)) ?? null,
      status: String(e.status),
      employmentState: String(e.employment_state),
      employmentBasis: String(e.employment_basis),
      dailyRate: (e.daily_rate as number | null) ?? null,
      foodAllowancePerDay: (e.food_allowance_per_day as number | null) ?? null,
      startDate: iso(e.start_date as Date | null),
      noticeDate: iso(e.notice_date as Date | null),
      lastWorkingDay: iso(e.last_working_day as Date | null),
      endReason: (e.end_reason as string | null) ?? null,
      offboardingType: (e.offboarding_type as string | null) ?? null,
      nationality: (e.nationality as string | null) ?? null,
      isForeignStaff: Boolean(e.is_foreign_staff),
      visaExpiryDate: iso(e.visa_expiry_date as Date | null),
      workPermitExpiryDate: iso(e.work_permit_expiry_date as Date | null),
      jobDescription: (e.job_description as string | null) ?? null,
      weeklyOffDays: (e.weekly_off_days as number[] | null) ?? [],
      displayOrder: Number(e.display_order),
      positionTitle:
        ((e.default_merge_data as { positionTitle?: string } | null)?.positionTitle ?? null) || null,
      roleKeys: [] as string[],
    };
  });
  const peopleByKey = new Map(people.map((p) => [p.key, p]));
  const chosenIds = [...personKeyById.keys()];

  // ---- 3. The rows that belong to them, whole ----------------------------

  for (const r of await q(
    'select employee_id, role_id, is_primary, proficiency_level from employee_roles where employee_id = any($1::varchar[]) order by employee_id, role_id',
    [chosenIds],
  )) {
    const p = peopleByKey.get(personKeyById.get(String(r.employee_id)) ?? '');
    const rk = roleKeyById.get(String(r.role_id));
    if (p && rk && !p.roleKeys.includes(rk)) p.roleKeys.push(rk);
  }

  const timeEvents = (
    await q(
      `select employee_id, branch_id, event_type, event_time, auth_method, confidence_score
         from time_events
        where employee_id = any($1::varchar[])
        order by event_time, employee_id, event_type`,
      [chosenIds],
    )
  ).map((t) => [
    personKeyById.get(String(t.employee_id))!,
    branchKeyById.get(String(t.branch_id)) ?? branches[0]!.key,
    String(t.event_type),
    iso(t.event_time as Date)!,
    String(t.auth_method),
    (t.confidence_score as number | null) ?? null,
  ] as const);

  // ---- 4. Tasks, by family, to a row budget ------------------------------

  const taskRows = await q(`
    select id, parent_task_id, branch_id, department_id, assigned_employee_id,
           assigned_department_id, assigned_role_id, title, description,
           status, priority, recurrence, weekly_days, monthly_day, preferred_due_time,
           is_recurring_definition, due_at, start_at, scheduled_mode, progress_percent,
           completed_at, task_level, requires_photo_evidence, requires_responses, created_at
      from tasks
     order by created_at, id
  `);
  const families = new Map<string, Row[]>();
  for (const t of taskRows) {
    const f = String(t.parent_task_id ?? t.id);
    families.set(f, [...(families.get(f) ?? []), t]);
  }

  const budget = Math.floor(taskRows.length * TASK_SAMPLE_RATE);
  const ranked = [...families.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  const takenFamilies: Row[][] = [];
  let taken = 0;
  const seenStatus = new Set<string>();
  const seenRecurrence = new Set<string>();
  // Two passes over the same stable order: the first guarantees each status and
  // each recurrence appears at all, the second spends what is left of the
  // budget. Without the first pass a 15% cut of a board that is 87% completed
  // can come back with no live work on it.
  for (const pass of [0, 1]) {
    for (const [, rows] of ranked) {
      if (takenFamilies.includes(rows)) continue;
      if (taken + rows.length > budget) continue;
      const statuses = new Set(rows.map((r) => String(r.status)));
      const recurrences = new Set(rows.map((r) => String(r.recurrence)));
      if (pass === 0) {
        const novel =
          [...statuses].some((s) => !seenStatus.has(s)) ||
          [...recurrences].some((r) => !seenRecurrence.has(r));
        if (!novel) continue;
      }
      takenFamilies.push(rows);
      taken += rows.length;
      for (const s of statuses) seenStatus.add(s);
      for (const r of recurrences) seenRecurrence.add(r);
    }
  }

  const taskKey = keyer();
  const taskKeyById = new Map<string, string>();
  const flat = takenFamilies.flat();
  for (const t of flat) taskKeyById.set(String(t.id), taskKey(String(t.title)));
  const tasks = flat.map((t) => ({
    key: taskKeyById.get(String(t.id))!,
    parentKey: t.parent_task_id ? (taskKeyById.get(String(t.parent_task_id)) ?? null) : null,
    branchKey: t.branch_id ? (branchKeyById.get(String(t.branch_id)) ?? null) : null,
    deptKey: t.department_id ? (deptKeyById.get(String(t.department_id)) ?? null) : null,
    /**
     * Only if that person was sampled. A task pointing at one of the
     * fifty-nine employees this sample left behind would be a task assigned
     * to nobody the moment it is loaded.
     */
    assigneeKey: t.assigned_employee_id
      ? (personKeyById.get(String(t.assigned_employee_id)) ?? null)
      : null,
    assignedDeptKey: t.assigned_department_id
      ? (deptKeyById.get(String(t.assigned_department_id)) ?? null)
      : null,
    assignedRoleKey: t.assigned_role_id ? (roleKeyById.get(String(t.assigned_role_id)) ?? null) : null,
    title: String(t.title),
    description: (t.description as string | null) ?? null,
    status: String(t.status),
    priority: String(t.priority),
    recurrence: String(t.recurrence),
    weeklyDays: (t.weekly_days as string[] | null) ?? [],
    monthlyDay: (t.monthly_day as number | null) ?? null,
    preferredDueTime: (t.preferred_due_time as string | null) ?? null,
    isRecurringDefinition: Boolean(t.is_recurring_definition),
    dueAt: iso(t.due_at as Date | null),
    startAt: iso(t.start_at as Date | null),
    scheduledMode: Boolean(t.scheduled_mode),
    progressPercent: Number(t.progress_percent ?? 0),
    completedAt: iso(t.completed_at as Date | null),
    taskLevel: String(t.task_level),
    requiresPhotoEvidence: Boolean(t.requires_photo_evidence),
    requiresResponses: Boolean(t.requires_responses),
  }));

  /**
   * The seed finds an existing task by title, due time and start time. Those
   * three have to identify one task or it will skip rows and under-seed in
   * silence — which is exactly what happened when the key was the title alone
   * and a weekly task turned out to be thirty-four rows sharing one.
   */
  const taskKeys = new Set(tasks.map((t) => `${t.title}|${t.dueAt}|${t.startAt}`));
  if (taskKeys.size !== tasks.length) {
    throw new Error(
      `the ${tasks.length} sampled tasks collapse to ${taskKeys.size} under ` +
        `(title, dueAt, startAt), which is the key the seed matches on. Widen ` +
        `that key in main.ts before taking this sample.`,
    );
  }

  /** Same argument for people: the seed finds an employee by email address. */
  const personKeys = new Set(people.map((p) => p.emailLocal.toLowerCase()));
  if (personKeys.size !== people.length) {
    throw new Error(
      `two sampled people share an email local part, which is the seed's key ` +
        `for an employee. Pick a different key before taking this sample.`,
    );
  }

  // ---- 5. Announcements --------------------------------------------------

  const announcements = (
    await q(
      'select title, body, priority, start_date, end_date, show_to_everyone, is_active, branch_ids from announcements order by created_at',
    )
  ).map((a) => ({
    title: String(a.title),
    body: String(a.body),
    priority: String(a.priority),
    startDate: iso(a.start_date as Date)!,
    endDate: iso(a.end_date as Date)!,
    showToEveryone: Boolean(a.show_to_everyone),
    isActive: Boolean(a.is_active),
    branchKeys: ((a.branch_ids as string[] | null) ?? [])
      .map((id) => branchKeyById.get(id))
      .filter((k): k is string => Boolean(k)),
  }));

  // ---- write -------------------------------------------------------------

  const sampled = {
    tenants: 1, operators: 1,
    branches: branches.length, departments: departments.length, roles: roles.length,
    department_branch_assignments: departments.reduce((n, d) => n + d.branchKeys.length, 0),
    role_branch_assignments: roles.reduce((n, r) => n + r.branchKeys.length, 0),
    employees: people.length,
    employee_roles: people.reduce((n, p) => n + p.roleKeys.length, 0),
    time_events: timeEvents.length,
    tasks: tasks.length,
    announcements: announcements.length,
  };

  const j = (v: unknown): string => JSON.stringify(v);
  const lines: string[] = [];
  const push = (s = ''): void => void lines.push(s);

  push('/**');
  push(' * GENERATED by `script/sample/extract.ts` — do not edit by hand.');
  push(' *');
  push(' * A sample of the park\'s real rows, cut from the production export on a');
  push(' * local machine. The export itself is never committed; this file is.');
  push(' *');
  push(' * The sampling rule, what it left behind and why are all in `extract.ts`.');
  push(' *');
  push(' * Two things are not the park\'s own values and are marked here so nobody');
  push(' * has to go looking: every email address is the real local part on the');
  push(` * reserved domain \`${SAMPLE_EMAIL_DOMAIN}\`, which can never resolve; and no`);
  push(' * row here links to a sign-in account, a face template or a photograph.');
  push(' */');
  push();
  push('/* eslint-disable */');
  push();
  push(`export const SAMPLE_EMAIL_DOMAIN = ${j(SAMPLE_EMAIL_DOMAIN)};`);
  push();
  push('/** What the export held, and what this file carries, table by table. */');
  push(`export const SAMPLE_COUNTS: Record<string, { export: number; sample: number }> = ${j(
    Object.fromEntries(
      Object.entries(sampled).map(([t, n]) => [t, { export: before.get(t) ?? 0, sample: n }]),
    ),
  )};`);
  push();
  push(`export const TENANT = ${j({ name: String(tenant.name), slug: String(tenant.slug) })};`);
  push(`export const OPERATOR = ${j({ name: String(operator.name), status: String(operator.status) })};`);
  push();
  push('export interface SampleBranch { key: string; name: string; address: string; timezone: string; calendarColor: string | null }');
  push(`export const BRANCHES: SampleBranch[] = [`);
  for (const b of branches) push(`  ${j(b)},`);
  push('];');
  push();
  push('export interface SampleDepartment { key: string; name: string; displayOrder: number; isActive: boolean; description: string | null; staffInExport: number; branchKeys: string[] }');
  push(`export const DEPARTMENTS: SampleDepartment[] = [`);
  for (const d of departments) push(`  ${j(d)},`);
  push('];');
  push();
  push('export interface SampleRole { key: string; name: string; isActive: boolean; description: string | null; branchKeys: string[] }');
  push(`export const ROLES: SampleRole[] = [`);
  for (const r of roles) push(`  ${j(r)},`);
  push('];');
  push();
  push('export interface SamplePerson {');
  push('  key: string; fullName: string; thaiName: string | null; nickname: string;');
  push('  emailLocal: string; phone: string | null; deptKey: string; branchKey: string | null;');
  push('  status: string; employmentState: string; employmentBasis: string;');
  push('  dailyRate: number | null; foodAllowancePerDay: number | null;');
  push('  startDate: string | null; noticeDate: string | null; lastWorkingDay: string | null;');
  push('  endReason: string | null; offboardingType: string | null;');
  push('  nationality: string | null; isForeignStaff: boolean;');
  push('  visaExpiryDate: string | null; workPermitExpiryDate: string | null;');
  push('  jobDescription: string | null; weeklyOffDays: number[]; displayOrder: number;');
  push('  positionTitle: string | null; roleKeys: string[];');
  push('}');
  push(`export const PEOPLE: SamplePerson[] = [`);
  for (const p of people) push(`  ${j(p)},`);
  push('];');
  push();
  push('/** `[personKey, branchKey, eventType, isoTime, authMethod, confidence]` */');
  push('export type SampleTimeEvent = [string, string, string, string, string, number | null];');
  push(`export const TIME_EVENTS: SampleTimeEvent[] = [`);
  for (const t of timeEvents) push(`  ${j(t)},`);
  push('];');
  push();
  push('export interface SampleTask {');
  push('  key: string; parentKey: string | null; branchKey: string | null; deptKey: string | null;');
  push('  assigneeKey: string | null; assignedDeptKey: string | null; assignedRoleKey: string | null;');
  push('  title: string; description: string | null; status: string; priority: string;');
  push('  recurrence: string; weeklyDays: string[]; monthlyDay: number | null;');
  push('  preferredDueTime: string | null; isRecurringDefinition: boolean;');
  push('  dueAt: string | null; startAt: string | null; scheduledMode: boolean;');
  push('  progressPercent: number; completedAt: string | null; taskLevel: string;');
  push('  requiresPhotoEvidence: boolean; requiresResponses: boolean;');
  push('}');
  push(`export const TASKS: SampleTask[] = [`);
  for (const t of tasks) push(`  ${j(t)},`);
  push('];');
  push();
  push('export interface SampleAnnouncement { title: string; body: string; priority: string; startDate: string; endDate: string; showToEveryone: boolean; isActive: boolean; branchKeys: string[] }');
  push(`export const ANNOUNCEMENTS: SampleAnnouncement[] = [`);
  for (const a of announcements) push(`  ${j(a)},`);
  push('];');
  push();

  writeFileSync(OUT, lines.join('\n'), 'utf8');

  console.log('[extract] table            export   sample   share');
  for (const [t, n] of Object.entries(sampled)) {
    const e = before.get(t) ?? 0;
    const share = e === 0 ? '   -' : `${((n / e) * 100).toFixed(1)}%`.padStart(6);
    console.log(`[extract] ${t.padEnd(30)} ${String(e).padStart(6)} ${String(n).padStart(8)} ${share}`);
  }
  const exportTotal = [...before.values()].reduce((a, b) => a + b, 0);
  const sampleTotal = Object.values(sampled).reduce((a, b) => a + b, 0);
  console.log(
    `[extract] ${'TOTAL (these tables)'.padEnd(30)} ${String(exportTotal).padStart(6)} ${String(sampleTotal).padStart(8)} ${`${((sampleTotal / exportTotal) * 100).toFixed(1)}%`.padStart(6)}`,
  );
  if (collapsedDepartments.length > 0) {
    console.log(`[extract] collapsed duplicate departments: ${collapsedDepartments.join(', ')}`);
  }
  if (orphaned > 0) {
    console.log(
      `[extract] skipped ${orphaned} employee(s) pointing at a department id that does not exist`,
    );
  }
  console.log('[extract] withheld:');
  for (const w of WITHHELD) console.log(`[extract]   - ${w.what}\n[extract]       ${w.why}`);
  console.log(`[extract] wrote ${OUT}`);
}

main()
  .then(() => client.end())
  .catch((err: unknown) => {
    console.error(err);
    process.exitCode = 1;
    return client.end();
  });
