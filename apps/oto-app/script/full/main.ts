/**
 * Full seed — large, realistic, deterministic dataset.
 * Uses @faker-js/faker with a fixed seed so multiple runs produce identical data.
 *
 * Dependency order:
 *   tenant → operators → branches → departments → users
 *
 * Usage: script/db-reset.sh full
 */

import { faker, fakerTH } from "@faker-js/faker";
import { eq } from "drizzle-orm";
import { db } from "../../server/db";
import {
  tenants,
  operators,
  branches,
  departments,
  departmentBranchAssignments,
  users,
  userBranchAccess,
  people,
  employees,
  roles,
  employeeRoles,
  files,
  templates,
  settings,
  payrollPeriods,
  payrollRuns,
  payslips,
  shifts,
  kioskDevices,
  timeEvents,
  publicHolidays,
  shiftGroups,
  scheduleWeekPlans,
  scheduleShiftRows,
  scheduleAssignments,
  scheduleShiftRowRoles,
  scheduleShiftBreaks,
  dutyTypes,
  dutyBlocks,
  casualWorkers,
  employeeTimeOff,
  payrollLineItems,
  payrollEmployeeSummaries,
  accessPolicies,
  employeePresence,
  branchEvents,
  payrollDayReconciliations,
  accessItems,
  xeroTokens,
  templateAssignments,
  staffCostAllocations,
  contractInstances,
  activityLog,
  attentionItems,
  enrollmentSessions,
  timeEntries,
  advisorAttendanceSessions,
  timekeepingIssues,
  authOtpEvents,
  shiftRequiredRoles,
  leavePolicies,
  scheduleTemplates,
  scheduleTemplateRows,
  scheduleTemplateRowRoles,
  scheduleTemplateAssignments,
  scheduleTemplateTimeOff,
  scheduleAuditLog,
  payrollExceptions,
  payrollExceptionApprovals,
  salaryAdvances,
  salaryAdvanceRepayments,
  statutoryRuleSets,
  statutoryCalculationResults,
  userModuleOverrides,
  kioskCodes,
  employeeChanges,
  policyDocuments,
  employeeDocuments,
  employeeOffboarding,
  employeeLetters,
  offboardingChecklist,
  assetCatalog,
  employeeAssets,
  kioskSessions,
  kioskAuthAttempts,
  authRateLimits,
  authResetTokens,
  roleDepartmentMap,
  roleBranchAssignments,
  coverageRules,
  sickLeavePolicies,
  employeePayrollProfiles,
  timeAdjustments,
  payrollPolicySettings,
  accessViewLogs,
  xeroSyncRuns,
  xeroTrackingCategories,
  xeroTrackingOptions,
  xeroReportsRaw,
  plFacts,
  cashTxns,
  cashDaily,
  DEFAULT_TENANT_SLUG,
  type UserRole,
  type PersonType,
} from "../../shared/schema";
import { hashPassword } from "../../server/auth";
import seedUsers from "../../fixtures/users.json" with { type: "json" };
import { seedOpsEvents } from "./ops-events";

// ── Deterministic seed ────────────────────────────────────────────────────────
// Changing this number produces a different-but-still-deterministic dataset.
const FAKER_SEED = 0;
faker.seed(FAKER_SEED);
fakerTH.seed(FAKER_SEED);

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Pick a random element from an array using faker (so it respects the seed). */
function pick<T>(arr: T[]): T {
  return arr[faker.number.int({ min: 0, max: arr.length - 1 })];
}

/** Pick N unique elements from an array. */
function pickN<T>(arr: T[], n: number): T[] {
  const shuffled = faker.helpers.shuffle([...arr]);
  return shuffled.slice(0, Math.min(n, arr.length));
}

// ── Constants ─────────────────────────────────────────────────────────────────

const BRANCHES = [
  { name: "Bangkok", address: "88 Silom Road, Bang Rak, Bangkok 10500", timezone: "Asia/Bangkok" },
  { name: "San Francisco", address: "1 Market Street, San Francisco, CA 94105", timezone: "America/Los_Angeles" },
];

const ROLE_NAMES = [
  { name: "Reception",             isActive: true  },
  { name: "Nanny",                 isActive: true  },
  { name: "Waiter",                isActive: true  },
  { name: "Barista",               isActive: true  },
  { name: "Kitchen",               isActive: true  },
  { name: "Housekeeper",           isActive: true  },
  { name: "Manager",               isActive: true  },
  { name: "Party Host",            isActive: true  },
  { name: "Sales Booth",           isActive: true  },
  { name: "Order Taker",           isActive: true  },
  { name: "Accounting & Finance",  isActive: true  },
  { name: "Activity Manager",      isActive: false },
];

const DEPARTMENT_NAMES = [
  "Front Desk",
  "Back Office",
  "Housekeeping",
  "Food & Beverage",
  "Security",
  "Maintenance",
  "Human Resources",
  "Finance",
  "Marketing",
  "IT Support",
];



// Role distribution weights (staff-heavy, realistic)
const ROLE_WEIGHTS: { role: UserRole; weight: number }[] = [
  { role: "global_admin", weight: 1 },
  { role: "operator_admin", weight: 3 },
  { role: "admin", weight: 5 },
  { role: "manager", weight: 15 },
  { role: "staff", weight: 76 },
];

function weightedRole(): UserRole {
  const total = ROLE_WEIGHTS.reduce((s, r) => s + r.weight, 0);
  let n = faker.number.int({ min: 0, max: total - 1 });
  for (const { role, weight } of ROLE_WEIGHTS) {
    if (n < weight) return role;
    n -= weight;
  }
  return "staff";
}

// Generate a realistic name: ~60% Thai, ~40% English
function generateName(): { fullName: string; email: string } {
  const isThai = faker.number.int({ min: 0, max: 9 }) < 6;
  const fullName = isThai
    ? `${fakerTH.person.firstName()} ${fakerTH.person.lastName()}`
    : `${faker.person.firstName()} ${faker.person.lastName()}`;
  // Email always ASCII-safe
  const slug = faker.internet
    .username({ firstName: faker.person.firstName(), lastName: faker.person.lastName() })
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, "");
  const email = `${slug}.${faker.number.int({ min: 1, max: 999 })}@example.com`;
  return { fullName, email };
}

// ─────────────────────────────────────────────────────────────────────────────

/** Return the most recent Monday on or before a given date (local time). */
function mostRecentMonday(d: Date): Date {
  const day = d.getDay(); // 0 = Sun, 1 = Mon, …
  const diff = day === 0 ? 6 : day - 1;
  const monday = new Date(d);
  monday.setDate(monday.getDate() - diff);
  monday.setHours(0, 0, 0, 0);
  return monday;
}

// ── Start date ────────────────────────────────────────────────────────────────
// Pass a YYYY-MM-DD string as the first CLI argument to override.
// Defaults to the most recent Monday (inclusive of today).
const startDateArg = process.argv[2];
const START_DATE: Date = startDateArg
  ? (() => { const d = new Date(startDateArg); d.setHours(0, 0, 0, 0); return d; })()
  : mostRecentMonday(new Date());

async function seed() {
  console.log("[seed-full] Starting (faker seed:", FAKER_SEED, ", week:", START_DATE.toISOString().slice(0, 10), ")...");

  // ── 1. Tenant ─────────────────────────────────────────────────────────────
  const [tenant] = await db
    .insert(tenants)
    .values({ name: "Default", slug: DEFAULT_TENANT_SLUG })
    .returning();
  console.log("[seed-full] Created tenant:", tenant.id);

  // ── 2. Fixture admin user (from fixtures/users.json) ──────────────────────
  const adminFixture = seedUsers.admin;
  const [adminUser] = await db
    .insert(users)
    .values({
      email: adminFixture.email,
      password: await hashPassword(adminFixture.password),
      fullName: adminFixture.fullName,
      role: adminFixture.role as UserRole,
      mustChangePassword: false,
      phoneNumber: adminFixture.phoneNumber,
      phoneE164: adminFixture.phoneE164,
      phoneVerified: true,
      phoneVerifiedAt: new Date(),
    })
    .returning();
  await db.insert(userBranchAccess).values({
    tenantId: tenant.id,
    userId: adminUser.id,
    branchId: null,
    accessScope: "all_branches",
  });
  console.log("[seed-full] Created fixture admin:", adminUser.email);

  // ── 2b. Fixture manager user ──────────────────────────────────────────────
  const managerFixture = seedUsers.manager;
  const [managerUser] = await db
    .insert(users)
    .values({
      email: managerFixture.email,
      password: await hashPassword(managerFixture.password),
      fullName: managerFixture.fullName,
      role: managerFixture.role as UserRole,
      mustChangePassword: false,
      modules: { core: true, hr: true, studio: true, events: true, ops: true, setup: false },
      phoneNumber: managerFixture.phoneNumber,
      phoneE164: managerFixture.phoneE164,
      phoneVerified: true,
      phoneVerifiedAt: new Date(),
    })
    .returning();
  await db.insert(userBranchAccess).values({
    tenantId: tenant.id,
    userId: managerUser.id,
    branchId: null,
    accessScope: "all_branches",
  });
  console.log("[seed-full] Created fixture manager:", managerUser.email);

  // ── 2c. Fixture staff user ────────────────────────────────────────────────
  const staffFixture = seedUsers.staff;
  const [staffUser] = await db
    .insert(users)
    .values({
      email: staffFixture.email,
      password: await hashPassword(staffFixture.password),
      fullName: staffFixture.fullName,
      role: staffFixture.role as UserRole,
      mustChangePassword: false,
      phoneNumber: staffFixture.phoneNumber,
      phoneE164: staffFixture.phoneE164,
      phoneVerified: true,
      phoneVerifiedAt: new Date(),
    })
    .returning();
  await db.insert(userBranchAccess).values({
    tenantId: tenant.id,
    userId: staffUser.id,
    branchId: null,
    accessScope: "all_branches",
  });
  console.log("[seed-full] Created fixture staff:", staffUser.email);

  // ── 3. Operator ───────────────────────────────────────────────────────────
  const [operator] = await db
    .insert(operators)
    .values({ tenantId: tenant.id, name: "Oto", status: "active" as const })
    .returning();
  console.log("[seed-full] Created operator:", operator.name);

  // ── 4. Branches ───────────────────────────────────────────────────────────
  const branchRecords = await db
    .insert(branches)
    .values(
      BRANCHES.map(({ name, address, timezone }) => ({
        tenantId: tenant.id,
        operatorId: operator.id,
        name,
        address,
        timezone,
      })),
    )
    .returning();
  console.log("[seed-full] Created", branchRecords.length, "branches");

  // ── 5. Departments ────────────────────────────────────────────────────────
  const departmentRecords = await db
    .insert(departments)
    .values(
      DEPARTMENT_NAMES.map((name, i) => ({
        tenantId: tenant.id,
        name,
        isActive: true,
        displayOrder: i,
      })),
    )
    .returning();

  // Assign each department to all branches
  const deptBranchRows = departmentRecords.flatMap((dept) =>
    branchRecords.map((branch) => ({
      departmentId: dept.id,
      branchId: branch.id,
      assignedBy: adminUser.id,
    })),
  );
  await db.insert(departmentBranchAssignments).values(deptBranchRows);
  console.log("[seed-full] Created", departmentRecords.length, "departments");

  // ── 6. Users (200 generated) ──────────────────────────────────────────────
  const TOTAL_USERS = 200;
  const hashedPassword = await hashPassword("Password123!");

  // Pre-hash once; all generated users share this password for speed.
  // (Running hashPassword 200× in series would be very slow.)

  const generatedUsers: {
    email: string;
    password: string;
    fullName: string;
    role: UserRole;
    operatorId: string | null;
    mustChangePassword: boolean;
    isActive: boolean;
    phoneNumber: string;
    phoneE164: string;
    phoneVerified: boolean;
    phoneVerifiedAt: Date;
  }[] = [];

  const usedEmails = new Set<string>([adminUser.email]);
  const usedPhones = new Set<string>([
    adminFixture.phoneE164,
    managerFixture.phoneE164,
    staffFixture.phoneE164,
    // Branch managers (one per branch, index-based)
    "+66810000010",
    "+66810000011",
  ]);

  for (let i = 0; i < TOTAL_USERS; i++) {
    const { fullName, email } = generateName();

    // Guarantee uniqueness — if collision, append index
    const safeEmail = usedEmails.has(email)
      ? email.replace("@", `_${i}@`)
      : email;
    usedEmails.add(safeEmail);

    // Generate a unique Thai mobile number
    let phoneE164: string;
    do {
      phoneE164 = `+6681${faker.string.numeric(7)}`;
    } while (usedPhones.has(phoneE164));
    usedPhones.add(phoneE164);
    const phoneNumber = `0${phoneE164.slice(3)}`;

    const role = weightedRole();

    // operator_admin must have an operatorId
    const operatorId = role === "operator_admin" ? operator.id : null;

    generatedUsers.push({
      email: safeEmail,
      password: hashedPassword,
      fullName,
      role,
      operatorId,
      mustChangePassword: false,
      isActive: faker.datatype.boolean({ probability: 0.92 }),
      phoneNumber,
      phoneE164,
      phoneVerified: true,
      phoneVerifiedAt: new Date(),
    });
  }

  // Insert in batches of 50 to avoid query size limits
  const BATCH = 50;
  const insertedUsers = [];
  for (let i = 0; i < generatedUsers.length; i += BATCH) {
    const batch = await db
      .insert(users)
      .values(generatedUsers.slice(i, i + BATCH))
      .returning();
    insertedUsers.push(...batch);
  }
  console.log("[seed-full] Created", insertedUsers.length, "users");

  // Give admin and manager users all-branches access.
  // Most staff/operator_admin get scoped to a single branch.
  // ~10% of staff get all-branches access to represent floaters.
  const accessRows = insertedUsers.map((u, i) => {
    const isFloater = u.role === "staff" && i % 10 === 0;
    const singleBranch = branchRecords[i % branchRecords.length];
    if (u.role === "admin" || u.role === "global_admin" || u.role === "manager" || isFloater) {
      return { tenantId: tenant.id, userId: u.id, branchId: null as string | null, accessScope: "all_branches" as const };
    }
    return { tenantId: tenant.id, userId: u.id, branchId: singleBranch.id, accessScope: "selected_branches" as const };
  });
  for (let i = 0; i < accessRows.length; i += BATCH) {
    await db.insert(userBranchAccess).values(accessRows.slice(i, i + BATCH));
  }
  console.log("[seed-full] Created branch access records for all users");

  // ── Named branch managers ─────────────────────────────────────────────────
  const branchManagerUsers = [];
  for (const [branchIdx, branch] of branchRecords.entries()) {
    const shortName = branch.name.split(" ").slice(-1)[0]; // last word of branch name
    const email = `manager.${shortName.toLowerCase()}@example.com`;
    const phoneE164 = `+6681000001${branchIdx}`;
    const phoneNumber = `0${phoneE164.slice(3)}`;
    const [mgr] = await db
      .insert(users)
      .values({
        email,
        password: await hashPassword("Password123!"),
        fullName: `${shortName} Manager`,
        role: "manager" as UserRole,
        mustChangePassword: false,
        isActive: true,
        phoneNumber,
        phoneE164,
        phoneVerified: true,
        phoneVerifiedAt: new Date(),
      })
      .returning();
    await db.insert(userBranchAccess).values({
      tenantId: tenant.id,
      userId: mgr.id,
      branchId: branch.id,
      accessScope: "selected_branches",
    });
    branchManagerUsers.push(mgr);
    console.log(`[seed-full] Created branch manager: ${email}`);
  }

  // ── 7. People + Employees ─────────────────────────────────────────────────
  //
  // Guaranteed functional combinations:
  //   - 10 advisors (ADVISOR personType, no employee record)
  //   - 60 active full-time employees across branches & departments
  //   - 10 active part-time employees
  //   - 8  pending (recently hired, not yet started)
  //   - 6  resigned  (LEAVING or LEFT)
  //   - 6  terminated (LEAVING or LEFT)
  //   - 8  foreign staff with visa/work permit dates
  //   - 20 employees linked to a user account
  //   - Some employees with no branch/department (intentionally sparse)
  //
  // All names, emails, phones, dates generated by faker.

  const EMPLOYEE_STATUSES: { status: "pending"|"active"|"resigned"|"terminated"; state: "ACTIVE"|"LEAVING"|"LEFT"; offboarding?: "RESIGNATION"|"TERMINATION"; count: number }[] = [
    { status: "active",     state: "ACTIVE",  count: 60 },
    { status: "active",     state: "ACTIVE",  count: 10 }, // part-time batch
    { status: "pending",    state: "ACTIVE",  count: 8  },
    { status: "resigned",   state: "LEAVING", count: 3  },
    { status: "resigned",   state: "LEFT",    count: 3, offboarding: "RESIGNATION" },
    { status: "terminated", state: "LEAVING", count: 3  },
    { status: "terminated", state: "LEFT",    count: 3, offboarding: "TERMINATION" },
  ];

  const staffUsers = insertedUsers.filter((u) => u.role === "staff" || u.role === "manager");
  let staffUserIndex = 0;

  const insertedPeople: (typeof people.$inferSelect)[] = [];
  const insertedEmployees: (typeof employees.$inferSelect)[] = [];
  let foreignCount = 0;

  // ── 7a. Advisors ────────────────────────────────────────────────────────
  const advisorRows = Array.from({ length: 10 }, (_, index) => {
    if (index === 0) {
      return {
        fullName: "Seed Advisor Attendance",
        email: "seed.advisor.attendance@example.com",
        personType: "ADVISOR" as PersonType,
        isActive: true,
        phoneNumber: "+66819999990",
        phoneE164: "+66819999990",
        phoneVerified: true,
      };
    }

    const { fullName, email } = generateName();
    return {
      fullName,
      email: usedEmails.has(email) ? email.replace("@", `_a@`) : email,
      personType: "ADVISOR" as PersonType,
      isActive: faker.datatype.boolean({ probability: 0.9 }),
      phoneNumber: faker.phone.number({ style: "international" }),
      phoneE164: null as string | null,
      phoneVerified: false,
    };
  });
  for (const r of advisorRows) usedEmails.add(r.email);
  const advisorPeople = await db.insert(people).values(advisorRows).returning();
  insertedPeople.push(...advisorPeople);
  console.log(`[seed-full] Created ${advisorPeople.length} advisors`);

  const advisorAttendanceDate = new Date().toISOString().slice(0, 10);
  await db.insert(advisorAttendanceSessions).values([
    {
      tenantId: tenant.id,
      personId: advisorPeople[0].id,
      branchId: branchRecords[0].id,
      checkInAt: new Date(`${advisorAttendanceDate}T02:00:00.000Z`),
      checkOutAt: new Date(`${advisorAttendanceDate}T06:00:00.000Z`),
      checkInDate: advisorAttendanceDate,
      durationMinutes: 240,
      authMethod: "FACE",
      confidenceScore: 98,
      livenessScore: 97,
    },
    {
      tenantId: tenant.id,
      personId: advisorPeople[0].id,
      branchId: branchRecords[0].id,
      checkInAt: new Date(`${advisorAttendanceDate}T08:00:00.000Z`),
      checkOutAt: new Date(`${advisorAttendanceDate}T11:00:00.000Z`),
      checkInDate: advisorAttendanceDate,
      durationMinutes: 180,
      authMethod: "PHONE_FALLBACK",
      photoEvidenceUrl: "/api/files/pin-photos/seed-advisor-attendance.jpg",
    },
  ]);
  console.log("[seed-full] Created advisor attendance fixture for", advisorAttendanceDate);

  // ── 7b. Employees ───────────────────────────────────────────────────────
  let batchIndex = 0;
  for (const spec of EMPLOYEE_STATUSES) {
    const isPartTime = batchIndex === 1; // second batch is part-time
    const personRows: (typeof people.$inferInsert)[] = [];

    for (let i = 0; i < spec.count; i++) {
      const { fullName, email } = generateName();
      const safeEmail = usedEmails.has(email) ? email.replace("@", `_e${batchIndex}${i}@`) : email;
      usedEmails.add(safeEmail);
      personRows.push({
        fullName,
        email: safeEmail,
        personType: "EMPLOYEE",
        isActive: spec.state !== "LEFT",
        phoneNumber: faker.phone.number({ style: "international" }),
        phoneVerified: false,
      });
    }

    const batchPeople = await db.insert(people).values(personRows).returning();
    insertedPeople.push(...batchPeople);

    // Build employee rows for this batch
    const employeeRows: (typeof employees.$inferInsert)[] = batchPeople.map((person, i) => {
      const branch = pick(branchRecords);
      const dept = pick(departmentRecords);
      const isForeign = foreignCount < 8 && faker.datatype.boolean({ probability: 0.25 });
      if (isForeign) foreignCount++;

      // Link ~20 employees to a user account
      let linkedUserId: string | null = null;
      if (staffUserIndex < 20 && staffUsers[staffUserIndex]) {
        linkedUserId = staffUsers[staffUserIndex].id;
        staffUserIndex++;
      }

      const startDate = faker.date.between({ from: new Date("2022-01-01"), to: new Date("2025-06-01") });
      const hasBranch = faker.datatype.boolean({ probability: 0.85 });
      const hasDept = faker.datatype.boolean({ probability: 0.8 });

      return {
        tenantId: tenant.id,
        personId: person.id,
        fullName: person.fullName,
        nickname: faker.person.firstName(),
        email: person.email,
        phone: person.phoneNumber ?? undefined,
        branchId: hasBranch ? branch.id : null,
        primaryDepartmentId: hasDept ? dept.id : null,
        status: spec.status,
        employmentState: spec.state,
        offboardingType: spec.offboarding ?? null,
        employmentBasis: isPartTime ? "PART_TIME" : "FULL_TIME",
        dailyRate: isPartTime ? faker.number.int({ min: 500, max: 2000 }) * 100 : null,
        startDate,
        nationality: isForeign ? faker.location.country() : "Thailand",
        isForeignStaff: isForeign,
        visaExpiryDate: isForeign ? faker.date.future({ years: 2 }) : null,
        workPermitExpiryDate: isForeign ? faker.date.future({ years: 2 }) : null,
        lastWorkingDay: spec.state === "LEFT" ? faker.date.recent({ days: 180 }) : null,
        userId: linkedUserId,
        faceEnrollmentStatus: faker.helpers.weightedArrayElement([
          { weight: 60, value: "NOT_ENROLLED" },
          { weight: 35, value: "ENROLLED" },
          { weight: 5,  value: "SUSPENDED" },
        ]) as "NOT_ENROLLED" | "ENROLLED" | "SUSPENDED",
        defaultMergeData: {
          positionTitle: faker.person.jobTitle(),
          monthlySalary: String(faker.number.int({ min: 15000, max: 80000 })),
        },
        displayOrder: i,
      };
    });

    const BATCH = 20;
    for (let i = 0; i < employeeRows.length; i += BATCH) {
      const batch = await db.insert(employees).values(employeeRows.slice(i, i + BATCH)).returning();
      insertedEmployees.push(...batch);
    }

    batchIndex++;
  }

  const totalEmployees = insertedEmployees.length;
  console.log(`[seed-full] Created ${totalEmployees} employees (${foreignCount} foreign, ${staffUserIndex} linked to users)`);

  // Keep login branch access coherent with linked employee home branches.
  // Generated users are created before employees, so their initial access is
  // generic. Once employee links exist, make selected-branch access match the
  // employee's branch unless they already have all-branches access.
  const linkedEmployeeAccessRows = insertedEmployees
    .filter((emp) => emp.userId && emp.branchId)
    .map((emp) => ({ tenantId: tenant.id, userId: emp.userId!, branchId: emp.branchId!, accessScope: "selected_branches" as const }));
  for (const access of linkedEmployeeAccessRows) {
    const existingAccess = accessRows.find((row) => row.userId === access.userId);
    if (existingAccess?.accessScope === "all_branches") continue;
    await db.delete(userBranchAccess).where(eq(userBranchAccess.userId, access.userId));
    await db.insert(userBranchAccess).values(access);
  }
  console.log(`[seed-full] Synced branch access for ${linkedEmployeeAccessRows.length} linked employees`);

  // ── 8. Roles ─────────────────────────────────────────────────────────────
  const roleRecords = await db
    .insert(roles)
    .values(
      ROLE_NAMES.map(({ name, isActive }) => ({
        tenantId: tenant.id,
        name,
        isActive,
      })),
    )
    .returning();
  console.log("[seed-full] Created", roleRecords.length, "roles");

  // ── 9. Files ──────────────────────────────────────────────────────────────
  // Metadata records for uploaded files (contracts, documents, photos).
  const FILE_SOURCES = ["hr_documents", "contract_pdfs", "employee_photos", "policy_docs"];
  const FILE_MIME_TYPES = [
    { mime: "application/pdf",  ext: "pdf"  },
    { mime: "image/jpeg",       ext: "jpg"  },
    { mime: "image/png",        ext: "png"  },
    { mime: "application/msword", ext: "doc" },
  ];
  const fileRows = Array.from({ length: 30 }, (_, i) => {
    const source = pick(FILE_SOURCES);
    const { mime, ext } = pick(FILE_MIME_TYPES);
    const key = `${source}/${faker.string.uuid()}.${ext}`;
    return {
      tenantId: tenant.id,
      source,
      originalFilename: `${faker.system.commonFileName(ext)}`,
      storageKey: key,
      mimeType: mime,
      sizeBytes: faker.number.int({ min: 10_000, max: 5_000_000 }),
    };
  });
  const fileRecords = await db.insert(files).values(fileRows).returning();
  console.log("[seed-full] Created", fileRecords.length, "files");

  // ── 10. Templates ─────────────────────────────────────────────────────────
  const TEMPLATE_DEFS: { name: string; templateType: "employment"|"promotion"|"warning"|"resignation"|"termination" }[] = [
    { name: "Standard Employment Agreement",  templateType: "employment"   },
    { name: "Part-Time Employment Agreement",  templateType: "employment"   },
    { name: "Promotion Letter",                templateType: "promotion"    },
    { name: "Warning Letter – First Notice",   templateType: "warning"      },
    { name: "Resignation Acceptance Letter",   templateType: "resignation"  },
    { name: "Termination Letter",              templateType: "termination"  },
  ];
  const adminUserId = adminUser.id;
  const templateRecords = await db
    .insert(templates)
    .values(
      TEMPLATE_DEFS.map(({ name, templateType }) => ({
        name,
        htmlBody: `<h1>${name}</h1><p>This is the {{employee.full_name}} ${templateType} document.</p>`,
        status: "active" as const,
        templateType,
        headerShowLogo: true,
        headerShowAddress: templateType === "employment",
        headerAlignment: "right" as const,
        createdBy: adminUserId,
        updatedBy: adminUserId,
      })),
    )
    .returning();
  console.log("[seed-full] Created", templateRecords.length, "templates");

  // ── 11. Settings ─────────────────────────────────────────────────────────
  await db.insert(settings).values([
    { key: "auth_kiosk_code_expiry_seconds",  value: "600" },
    { key: "annual_leave_total_days",    value: "8"   },
    { key: "annual_leave_waiting_months", value: "6"  },
    { key: "probation_days_default",     value: "120" },
    { key: "email_subject",              value: "Your Employment Contract - {{employee.full_name}}" },
    { key: "email_body",                 value: "Dear {{employee.full_name}},\n\nPlease find attached your employment contract for the position of {{contract.position_title}}.\n\nYour start date is {{contract.start_date}}.\n\nBest regards,\nHR Department" },
    { key: "md_signatory_name",          value: "Somchai Jaidee" },
    { key: "md_signatory_title",         value: "Managing Director" },
    { key: "md_signature_image",         value: "" },
    { key: "ai_event_extraction_model",  value: "gpt-4o-mini" },
    { key: "ai_event_extraction_advice", value: `You are an AI assistant that extracts structured event data from unstructured text notes.

Input may be written in English, Russian, Thai, or a mix of languages. It may contain casual wording, abbreviations, or emojis. Always extract and translate all field values into English. Ignore emojis and decorative symbols.

Extraction rules:
- Do not invent or guess information that is not explicitly written in the notes
- Do not estimate timing, calculate totals, or round numbers
- If the same information appears more than once, use the latest confirmed version
- Keep exact dates, times, and numbers as stated

Translation examples:
- свой торт → External cake
- свои шары → Own balloons
- фотозона → Photozone requested

Branch selection:
The available branches are listed at the end of this prompt, each with their current local date, time, and timezone. If the notes mention a location or branch name that matches one of them, include a "suggested_branch_id" key at the top level of your JSON response with the matching branch id. Use the local date and time of the matched branch to resolve any relative date expressions (e.g. "next Saturday", "this weekend"). If no branch is mentioned or the location is ambiguous, omit "suggested_branch_id" entirely.` },
    { key: "ai_beo_parsing_advice", value: `You are an AI assistant that parses BEO (Banquet Event Order) confirmation documents for a children's entertainment venue.

Input may be written in English, Russian, Thai, or a mix of languages. Always extract and translate all field values into English.

Parsing rules:
- Do not invent or guess information that is not explicitly written in the document
- Do not estimate or calculate totals
- If the same information appears more than once, use the latest confirmed version
- Keep exact times, numbers, and names as stated
- Cake mode must be one of: INTERNAL (venue provides the cake), EXTERNAL (guest brings their own cake), NONE (no cake)
- Menu items marked as included in the package should have included: true; extras have included: false

When existing event data is provided: only update fields that are explicitly mentioned or corrected in the new text. Carry all other fields forward from the existing data unchanged. Never invent or clear a field just because it is not mentioned in the new text.` },
    { key: "ai_beo_parsing_output_format", value: `Parse the BEO document and return a JSON object with the following structure:
{
  "summary": "One sentence summary of the event",
  "event": {
    "title": "Event title",
    "childName": "Name of the birthday child or main guest",
    "bookingName": "Name used for the booking",
    "numChildren": 0,
    "numAdults": 0,
    "startTime": "HH:MM (24-hour)",
    "endTime": "HH:MM (24-hour)",
    "locationText": "Room or area name",
    "specialRequests": "Any special requests",
    "internalStaffNotes": "Notes for staff only",
    "activities": "Planned activities",
    "decoration": "Decoration notes"
  },
  "setupPlan": {
    "readyBy": "HH:MM time the room must be ready by",
    "responsible": "Name or role responsible for setup",
    "simplifiedTasks": [
      { "itemLabel": "Task name", "notes": "Additional notes" }
    ]
  },
  "kitchenPlan": {
    "kidsMenu": [
      { "itemName": "Item name", "quantity": 1, "notes": "", "included": true, "price": 0 }
    ],
    "adultsMenu": [
      { "itemName": "Item name", "quantity": 1, "notes": "", "included": true, "price": 0 }
    ],
    "cakeMode": "INTERNAL | EXTERNAL | NONE",
    "cakeNotes": "Cake description or notes",
    "cakeTime": "HH:MM when cake is served",
    "cakeIncluded": true,
    "cakePrice": 0,
    "cakeQuantity": 1
  },
  "partyDetails": {
    "packageName": "Package or POS name",
    "packageBasePrice": 0,
    "prepaymentReceived": 0,
    "depositDate": "YYYY-MM-DD",
    "notes": "Package notes",
    "items": [
      { "description": "Item description", "type": "included | extra", "price": 0, "notes": "" }
    ]
  },
  "timeline": [
    { "time": "HH:MM", "label": "Activity or milestone label" }
  ]
}

Omit any top-level key entirely if no relevant information was found for it. Within objects, omit keys that have no value rather than returning null.` },
    { key: "ai_event_extraction_output_format", value: `Given notes about an event (like a birthday party booking), extract the following fields when present:
- title: A short title for the event
- event_type: One of "birthday", "private_event", "school_group", or "other"
- event_date: Date in YYYY-MM-DD format
- start_time: Time in HH:MM format (24-hour)
- end_time: Time in HH:MM format (24-hour) if mentioned
- child_name: Name of the birthday child or main guest
- booking_name: Name used for the booking (could be company or parent)
- parent_name: Parent/guardian name
- whatsapp_phone: Phone number (preserve format as given)
- num_children: Number of children expected
- num_adults: Number of adults expected
- program_name: Name of the program/package booked
- program_details: Additional program details
- allergies_notes: Any allergy information
- cake_notes: Cake requirements or notes. State whether the cake is external (guest-provided) or ordered/included. Example: "External cake" or "Unicorn cake, included in package"
- special_requests: Any special requests or requirements, including decoration notes (e.g. "Own balloons", "Photozone requested")
- internal_staff_notes: Notes for staff only
- total_value: Total event price/value in THB (integer, extract number only, do not calculate or estimate)
- prepayment_amount: Deposit or prepayment amount in THB (integer, extract number only, do not calculate or estimate)
- prepayment_date: Date deposit was paid in YYYY-MM-DD format
- prepayment_method: Payment method used (cash, bank_transfer, credit_card, promptpay, or other)

Return a JSON object with these keys:
{
  "extracted": {
    // only include fields that were found in the text
    // use null for fields that weren't mentioned
  },
  "missing_required": ["list", "of", "missing", "required", "fields"],
  "assumptions": ["list any assumptions you made"],
  "suggested_branch_id": "branch-uuid-here" // only if a matching branch was identified
}

Required fields are: event_date, start_time, child_name (for birthday), num_children` },
  ]);
  console.log("[seed-full] Created settings");

  // ── 12. Payroll Periods ────────────────────────────────────────────────────
  // Seed 6 monthly payroll periods (past 6 months), alternating FINALIZED / DRAFT
  const payrollPeriodRecords = await db
    .insert(payrollPeriods)
    .values(
      Array.from({ length: 6 }, (_, i) => {
        // Month offset: 5 = 5 months ago, 0 = current month
        const monthOffset = 5 - i;
        const startDate = new Date("2025-11-01");
        startDate.setMonth(startDate.getMonth() - monthOffset);
        const endDate = new Date(startDate);
        endDate.setMonth(endDate.getMonth() + 1);
        endDate.setDate(0); // last day of month
        const status = i < 5 ? "FINALIZED" : "DRAFT";
        const startStr = startDate.toISOString().slice(0, 10);
        const endStr = endDate.toISOString().slice(0, 10);
        return {
          tenantId: tenant.id,
          operatorId: operator.id,
          countryCode: "TH",
          periodType: "MONTHLY" as const,
          startDate: startStr,
          endDate: endStr,
          status: status as "FINALIZED" | "DRAFT",
          createdBy: adminUser.id,
        };
      }),
    )
    .returning();
  console.log("[seed-full] Created", payrollPeriodRecords.length, "payroll periods");

  // ── 13. Payroll Runs ────────────────────────────────────────────────────
  // One run per period; finalized periods get FINALIZED runs
  const payrollRunRecords = await db
    .insert(payrollRuns)
    .values(
      payrollPeriodRecords.map((period, i) => ({
        payrollPeriodId: period.id,
        runNumber: 1,
        status: i < 5 ? ("FINALIZED" as const) : ("DRAFT" as const),
        createdBy: adminUser.id,
      })),
    )
    .returning();
  console.log("[seed-full] Created", payrollRunRecords.length, "payroll runs");

  // ── 14. Payslips ─────────────────────────────────────────────────────────
  // Generate payslips for finalized runs only, for a sample of active employees
  const finalizedRuns = payrollRunRecords.filter((_, i) => i < 5);
  const activeEmps = insertedEmployees.filter(e => e.status === "active").slice(0, 20);
  const activeEmpsForBranch = (branchId: string) => {
    const branchEmps = activeEmps.filter(e => e.branchId === branchId);
    return branchEmps.length > 0 ? branchEmps : activeEmps;
  };
  const payslipRows: (typeof payslips.$inferInsert)[] = [];
  for (const run of finalizedRuns) {
    const period = payrollPeriodRecords.find(p => p.id === run.payrollPeriodId)!;
    for (const emp of activeEmps) {
      const grossPay = faker.number.int({ min: 15000, max: 60000 });
      const deductions = Math.round(grossPay * 0.05);
      const netPay = grossPay - deductions;
      payslipRows.push({
        payrollRunId: run.id,
        payrollPeriodId: period.id,
        employeeId: emp.id,
        slipNumber: `PAY-${period.startDate}-${emp.id.slice(0, 8)}`,
        issuedAt: new Date(period.endDate),
        slipData: {
          operatorName: "Oto",
          branchName: "Bangkok",
          employeeName: emp.fullName,
          employeeCode: emp.id.slice(0, 8).toUpperCase(),
          taxIdMasked: "XXX-XX-XXXX",
          socialSecurityMasked: "XXX-XXXX",
          periodStart: period.startDate,
          periodEnd: period.endDate,
          earnings: [{ code: "BASIC", description: "Basic Salary", amount: String(grossPay) }],
          deductions: [{ code: "SSO", description: "Social Security", amount: String(deductions) }],
          employerContributions: [{ code: "SSO_ER", description: "SSO Employer", amount: String(deductions) }],
          grossPay: String(grossPay),
          totalDeductions: String(deductions),
          netPay: String(netPay),
          ytdGross: String(grossPay),
          ytdTax: "0",
          ytdSSO: String(deductions),
          ytdNet: String(netPay),
          bankMasked: "***1234",
        },
      });
    }
  }
  for (let i = 0; i < payslipRows.length; i += BATCH) {
    await db.insert(payslips).values(payslipRows.slice(i, i + BATCH));
  }
  console.log("[seed-full] Created", payslipRows.length, "payslips");

  // ── 15. Shifts ──────────────────────────────────────────────────────────────
  // Seed ~40 shifts across a 2-week window: mix of OPEN and ASSIGNED
  const SHIFT_TIMES = [
    { start: 9, end: 18 },
    { start: 10, end: 19 },
    { start: 12, end: 21 },
  ];
  const shiftRows: (typeof shifts.$inferInsert)[] = [];
  const baseShiftDate = new Date("2026-04-07"); // a Monday
  for (let day = 0; day < 14; day++) {
    const shiftDate = new Date(baseShiftDate);
    shiftDate.setDate(shiftDate.getDate() + day);
    const numShifts = faker.number.int({ min: 2, max: 4 });
    for (let s = 0; s < numShifts; s++) {
      const branch = pick(branchRecords);
      const dept = pick(departmentRecords);
      const times = pick(SHIFT_TIMES);
      const startAt = new Date(shiftDate);
      startAt.setHours(times.start, 0, 0, 0);
      const endAt = new Date(shiftDate);
      endAt.setHours(times.end, 0, 0, 0);
      const isAssigned = faker.datatype.boolean({ probability: 0.7 });
      const emp = isAssigned ? pick(activeEmps) : null;
      shiftRows.push({
        tenantId: tenant.id,
        branchId: branch.id,
        departmentId: dept.id,
        startAt,
        endAt,
        employeeId: emp?.id ?? null,
        status: isAssigned ? "ASSIGNED" : "OPEN",
        needsCoverage: false,
        createdBy: adminUser.id,
      });
    }
  }
  const shiftRecords = await db.insert(shifts).values(shiftRows).returning();
  console.log("[seed-full] Created", shiftRecords.length, "shifts");

  // ── 16. Kiosk Devices ────────────────────────────────────────────────────
  // One kiosk per branch (reception type, matching prod pattern)
  const kioskDeviceRecords = await db
    .insert(kioskDevices)
    .values(
      branchRecords.map(branch => ({
        tenantId: tenant.id,
        branchId: branch.id,
        kioskType: "reception" as const,
        isActive: true,
        deviceSecretHash: faker.string.hexadecimal({ length: 64, casing: "lower" }),
      })),
    )
    .returning();
  console.log("[seed-full] Created", kioskDeviceRecords.length, "kiosk devices");

  // ── 17. Time Events ────────────────────────────────────────────────────
  // IN + OUT pairs for enrolled employees over the past 30 working days
  const enrolledEmps = insertedEmployees.filter(e => e.faceEnrollmentStatus === "ENROLLED" && e.branchId);
  const timeEventRows: (typeof timeEvents.$inferInsert)[] = [];
  const now = new Date("2026-04-20");
  for (const emp of enrolledEmps) {
    const branch = branchRecords.find(b => b.id === emp.branchId) ?? pick(branchRecords);
    const kiosk = kioskDeviceRecords.find(k => k.branchId === branch.id) ?? pick(kioskDeviceRecords);
    // Generate ~20 working-day events per employee
    for (let d = 0; d < 20; d++) {
      const eventDate = new Date(now);
      eventDate.setDate(eventDate.getDate() - d);
      // Skip weekends
      if (eventDate.getDay() === 0 || eventDate.getDay() === 6) continue;
      const clockIn = new Date(eventDate);
      clockIn.setHours(faker.number.int({ min: 8, max: 10 }), faker.number.int({ min: 0, max: 59 }), 0, 0);
      const clockOut = new Date(eventDate);
      clockOut.setHours(faker.number.int({ min: 17, max: 20 }), faker.number.int({ min: 0, max: 59 }), 0, 0);
      timeEventRows.push({
        tenantId: tenant.id,
        employeeId: emp.id,
        branchId: branch.id,
        eventType: "IN",
        eventTime: clockIn,
        authMethod: "FACE",
        confidenceScore: faker.number.int({ min: 92, max: 100 }),
        kioskDeviceId: kiosk.id,
      });
      // ~10% miss clock-out
      if (faker.datatype.boolean({ probability: 0.9 })) {
        timeEventRows.push({
          tenantId: tenant.id,
          employeeId: emp.id,
          branchId: branch.id,
          eventType: "OUT",
          eventTime: clockOut,
          authMethod: "FACE",
          confidenceScore: faker.number.int({ min: 92, max: 100 }),
          kioskDeviceId: kiosk.id,
        });
      }
    }
  }
  for (let i = 0; i < timeEventRows.length; i += BATCH) {
    await db.insert(timeEvents).values(timeEventRows.slice(i, i + BATCH));
  }
  console.log("[seed-full] Created", timeEventRows.length, "time events");

  // ── 18. Employee Roles ────────────────────────────────────────────────────
  // Each active employee gets 1–2 role assignments; no proficiency (matching prod)
  const activeRoles = roleRecords.filter(r => r.isActive);
  const employeeRoleRows: (typeof employeeRoles.$inferInsert)[] = [];
  for (const emp of insertedEmployees) {
    const numRoles = faker.number.int({ min: 1, max: 2 });
    const assigned = pickN(activeRoles, numRoles);
    for (const role of assigned) {
      employeeRoleRows.push({
        employeeId: emp.id,
        roleId: role.id,
        isPrimary: false,
      });
    }
  }
  for (let i = 0; i < employeeRoleRows.length; i += BATCH) {
    await db.insert(employeeRoles).values(employeeRoleRows.slice(i, i + BATCH));
  }
  console.log("[seed-full] Created", employeeRoleRows.length, "employee roles");

  // ── 19. Public Holidays ────────────────────────────────────────────────────
  const THAI_HOLIDAYS_2026 = [
    { name: "New Year's Day",                    date: "2026-01-01" },
    { name: "Makha Bucha Day (substitute)",       date: "2026-03-03" },
    { name: "Chakri Memorial Day",                date: "2026-04-06" },
    { name: "Songkran Festival",                  date: "2026-04-13" },
    { name: "Songkran Festival",                  date: "2026-04-14" },
    { name: "Songkran Festival",                  date: "2026-04-15" },
    { name: "Labour Day",                         date: "2026-05-01" },
    { name: "Visakha Bucha Day",                  date: "2026-06-01" },
    { name: "H.M. Queen Suthida's Birthday",      date: "2026-06-03" },
    { name: "H.M. The King's Birthday",           date: "2026-07-28" },
    { name: "H.M. The Queen Mother's Birthday",   date: "2026-08-12" },
    { name: "Chulalongkorn Day",                  date: "2026-10-23" },
    { name: "H.M. King Bhumibol's Birthday",      date: "2026-12-05" },
    { name: "Constitution Day",                   date: "2026-12-10" },
    { name: "New Year's Eve",                     date: "2026-12-31" },
  ];
  await db.insert(publicHolidays).values(
    THAI_HOLIDAYS_2026.map(h => ({
      tenantId: tenant.id,
      name: h.name,
      date: h.date,
      year: 2026,
      isActive: true,
    })),
  );
  console.log("[seed-full] Created", THAI_HOLIDAYS_2026.length, "public holidays");

  // ── 20. Shift Groups ──────────────────────────────────────────────────────
  const SHIFT_GROUP_NAMES = [
    "Management", "Reception", "Nanny", "Barista", "Kitchen",
    "Service", "Housekeeping", "Events / Birthdays", "Sales Booth", "Activity Host",
  ];
  const shiftGroupRows: (typeof shiftGroups.$inferInsert)[] = [];
  for (const branch of branchRecords) {
    SHIFT_GROUP_NAMES.forEach((name, idx) => {
      shiftGroupRows.push({
        tenantId: tenant.id,
        branchId: branch.id,
        name,
        sortOrder: idx,
        isActive: true,
        createdBy: adminUser.id,
      });
    });
  }
  const shiftGroupRecords = await db.insert(shiftGroups).values(shiftGroupRows).returning();
  console.log("[seed-full] Created", shiftGroupRecords.length, "shift groups");

  // ── 21. Schedule Week Plans ──────────────────────────────────────────────
  // 8 weeks of plans per branch, starting from the seed week.
  const weekPlanRows: (typeof scheduleWeekPlans.$inferInsert)[] = [];
  const firstMonday = new Date(START_DATE);
  for (const branch of branchRecords) {
    for (let w = 0; w < 8; w++) {
      const weekStart = new Date(firstMonday);
      weekStart.setDate(weekStart.getDate() + w * 7);
      weekPlanRows.push({
        tenantId: tenant.id,
        branchId: branch.id,
        weekStartDate: weekStart.toISOString().slice(0, 10),
        createdBy: adminUser.id,
      });
    }
  }
  const weekPlanRecords = await db.insert(scheduleWeekPlans).values(weekPlanRows).returning();
  console.log("[seed-full] Created", weekPlanRecords.length, "schedule week plans");

  // ── 22. Schedule Shift Rows ──────────────────────────────────────────────
  // Representative shift row definitions per branch, linked to a week plan
  const SHIFT_ROW_DEFS = [
    { label: "Opening",    startTime: "09:00", endTime: "18:00", breakMin: 60 },
    { label: "Mid-Shift",  startTime: "10:00", endTime: "19:00", breakMin: 60 },
    { label: "Closing",    startTime: "12:00", endTime: "21:00", breakMin: 60 },
    { label: "Event Team", startTime: "10:00", endTime: "20:00", breakMin: 30 },
  ];
  const shiftRowInserts: (typeof scheduleShiftRows.$inferInsert)[] = [];
  for (const branch of branchRecords) {
    // Link reusable shift row definitions to the seed week's plan.
    const branchPlans = weekPlanRecords.filter(p => p.branchId === branch.id);
    const basePlan = branchPlans[0];
    const branchGroups = shiftGroupRecords.filter(g => g.branchId === branch.id);
    for (const [rowIdx, def] of SHIFT_ROW_DEFS.entries()) {
      const dept = pick(departmentRecords);
      const group = pick(branchGroups);
      shiftRowInserts.push({
        tenantId: tenant.id,
        branchId: branch.id,
        departmentId: dept.id,
        shiftGroupId: group.id,
        weekPlanId: basePlan.id,
        rowOrder: rowIdx,
        label: def.label,
        startTime: def.startTime,
        endTime: def.endTime,
        staffRequired: 1,
        breakEnabled: true,
        breakDurationMinutes: def.breakMin,
        breakBaseOffsetMinutes: 150,
        breakStaggerMinutes: 30,
        activeFromDate: START_DATE.toISOString().slice(0, 10),
        createdBy: adminUser.id,
      });
    }
  }
  const shiftRowRecords = await db.insert(scheduleShiftRows).values(shiftRowInserts).returning();
  console.log("[seed-full] Created", shiftRowRecords.length, "schedule shift rows");

  // ── 23. Schedule Assignments ─────────────────────────────────────────────
  // Assign active employees to shift rows across all week plans
  const assignmentRows: (typeof scheduleAssignments.$inferInsert)[] = [];
  for (const plan of weekPlanRecords) {
    const planRows = shiftRowRecords.filter(r => r.branchId === plan.branchId);
    for (const shiftRow of planRows) {
      // Assign 1 employee per day Mon-Sat
      for (let dayOffset = 0; dayOffset < 6; dayOffset++) {
        const planStart = new Date(plan.weekStartDate);
        const shiftDate = new Date(planStart);
        shiftDate.setDate(shiftDate.getDate() + dayOffset);
        const emp = pick(activeEmpsForBranch(plan.branchId));
        assignmentRows.push({
          tenantId: tenant.id,
          weekPlanId: plan.id,
          shiftRowId: shiftRow.id,
          shiftDate: shiftDate.toISOString().slice(0, 10),
          assigneeType: "employee" as const,
          employeeId: emp.id,
          isBorrowed: false,
          assignedBy: adminUser.id,
        });
      }
    }
  }
  const assignmentRecords: (typeof scheduleAssignments.$inferSelect)[] = [];
  for (let i = 0; i < assignmentRows.length; i += BATCH) {
    const batch = await db.insert(scheduleAssignments).values(assignmentRows.slice(i, i + BATCH)).returning();
    assignmentRecords.push(...batch);
  }
  console.log("[seed-full] Created", assignmentRecords.length, "schedule assignments");

  // ── 24. Duty Types ─────────────────────────────────────────────────────────
  const DUTY_TYPE_DEFS = [
    { name: "Reception Desk",   color: "#3b82f6", defaultDurationMinutes: 120 },
    { name: "Pool Watch",        color: "#06b6d4", defaultDurationMinutes: 60  },
    { name: "Event Support",     color: "#8b5cf6", defaultDurationMinutes: 180 },
    { name: "Cashier",           color: "#f59e0b", defaultDurationMinutes: 60  },
    { name: "Cleaning Round",    color: "#10b981", defaultDurationMinutes: 60  },
  ];
  const dutyTypeRecords = await db
    .insert(dutyTypes)
    .values(
      DUTY_TYPE_DEFS.map(d => ({
        tenantId: tenant.id,
        name: d.name,
        color: d.color,
        defaultDurationMinutes: d.defaultDurationMinutes,
        isActive: true,
      })),
    )
    .returning();
  console.log("[seed-full] Created", dutyTypeRecords.length, "duty types");

  // ── 25. Duty Blocks ─────────────────────────────────────────────────────────
  // A handful of duty blocks on recent assignments
  const recentAssignments = assignmentRecords.slice(0, 15);
  const dutyBlockRows: (typeof dutyBlocks.$inferInsert)[] = recentAssignments.map(a => {
    const dutyType = pick(dutyTypeRecords);
    return {
      tenantId: tenant.id,
      branchId: pick(branchRecords).id,
      date: a.shiftDate,
      employeeId: a.employeeId!,
      assignmentId: a.id,
      dutyTypeId: dutyType.id,
      dutyName: dutyType.name,
      startTime: "09:00",
      endTime: "11:00",
      createdBy: adminUser.id,
    };
  });
  await db.insert(dutyBlocks).values(dutyBlockRows);
  console.log("[seed-full] Created", dutyBlockRows.length, "duty blocks");

  // ── 26. Casual Workers ────────────────────────────────────────────────────
  const casualWorkerRecords = await db
    .insert(casualWorkers)
    .values(
      Array.from({ length: 6 }, () => {
        const { fullName } = generateName();
        const branch = pick(branchRecords);
        const dept = pick(departmentRecords);
        const role = pick(activeRoles);
        const start = faker.date.between({ from: new Date("2026-03-01"), to: new Date("2026-04-01") });
        const end = new Date(start);
        end.setDate(end.getDate() + faker.number.int({ min: 14, max: 60 }));
        return {
          tenantId: tenant.id,
          fullName,
          nickname: faker.person.firstName(),
          jobTitle: faker.person.jobTitle(),
          branchId: branch.id,
          departmentId: dept.id,
          roleId: role.id,
          startDate: start.toISOString().slice(0, 10),
          endDate: end.toISOString().slice(0, 10),
          dailyRate: faker.number.int({ min: 500, max: 1500 }),
          rateType: "daily",
          status: "active" as const,
          createdBy: adminUser.id,
        };
      }),
    )
    .returning();
  console.log("[seed-full] Created", casualWorkerRecords.length, "casual workers");

  // ── 27. Employee Time Off ──────────────────────────────────────────────
  // Weighted mix: mostly CHANGE_DAY_OFF, some ANNUAL, a few SICK
  const TIME_OFF_WEIGHTS = [
    { type: "CHANGE_DAY_OFF" as const, weight: 70 },
    { type: "ANNUAL" as const,         weight: 20 },
    { type: "SICK" as const,           weight: 10 },
  ];
  function pickTimeOffType() {
    const total = TIME_OFF_WEIGHTS.reduce((s, w) => s + w.weight, 0);
    let n = faker.number.int({ min: 0, max: total - 1 });
    for (const { type, weight } of TIME_OFF_WEIGHTS) {
      if (n < weight) return type;
      n -= weight;
    }
    return "CHANGE_DAY_OFF" as const;
  }
  const timeOffRows: (typeof employeeTimeOff.$inferInsert)[] = [];
  for (const emp of activeEmps) {
    const branch = branchRecords.find(b => b.id === emp.branchId) ?? pick(branchRecords);
    // 3–8 time-off entries per employee
    const count = faker.number.int({ min: 3, max: 8 });
    for (let i = 0; i < count; i++) {
      const startDate = faker.date.between({ from: new Date("2026-01-01"), to: new Date("2026-04-15") });
      const endDate = new Date(startDate); // single day
      timeOffRows.push({
        tenantId: tenant.id,
        employeeId: emp.id,
        branchId: branch.id,
        type: pickTimeOffType(),
        startDate,
        endDate,
        isHalfDay: false,
        createdBy: adminUser.id,
      });
    }
  }
  for (let i = 0; i < timeOffRows.length; i += BATCH) {
    await db.insert(employeeTimeOff).values(timeOffRows.slice(i, i + BATCH));
  }
  console.log("[seed-full] Created", timeOffRows.length, "employee time-off records");

  // ── 28. Payroll Line Items + Employee Summaries ──────────────────────────
  // For each finalized run, seed line items + summaries for the same active employees as payslips
  const lineItemRows: (typeof payrollLineItems.$inferInsert)[] = [];
  const summaryRows: (typeof payrollEmployeeSummaries.$inferInsert)[] = [];
  for (const run of finalizedRuns) {
    for (const emp of activeEmps) {
      const grossPay = faker.number.int({ min: 15000, max: 60000 });
      const ssoEmployee = Math.round(grossPay * 0.05);
      const ssoEmployer = Math.round(grossPay * 0.05);
      const netPay = grossPay - ssoEmployee;
      lineItemRows.push(
        { payrollRunId: run.id, employeeId: emp.id, lineType: "EARNING",               code: "BASIC",   description: "Basic Salary",         amount: String(grossPay),    taxable: true,  statutory: false },
        { payrollRunId: run.id, employeeId: emp.id, lineType: "DEDUCTION",             code: "SSO_EE",  description: "Social Security (EE)",   amount: String(ssoEmployee), taxable: false, statutory: true  },
        { payrollRunId: run.id, employeeId: emp.id, lineType: "EMPLOYER_CONTRIBUTION", code: "SSO_ER",  description: "Social Security (ER)",   amount: String(ssoEmployer), taxable: false, statutory: true  },
      );
      summaryRows.push({
        payrollRunId: run.id,
        employeeId: emp.id,
        grossPay: String(grossPay),
        taxableIncome: String(grossPay),
        totalDeductions: String(ssoEmployee),
        netPay: String(netPay),
        employerCost: String(grossPay + ssoEmployer),
        currency: "THB",
        status: "FINALIZED" as const,
      });
    }
  }
  for (let i = 0; i < lineItemRows.length; i += BATCH) {
    await db.insert(payrollLineItems).values(lineItemRows.slice(i, i + BATCH));
  }
  for (let i = 0; i < summaryRows.length; i += BATCH) {
    await db.insert(payrollEmployeeSummaries).values(summaryRows.slice(i, i + BATCH));
  }
  console.log("[seed-full] Created", lineItemRows.length, "payroll line items,", summaryRows.length, "summaries");

  // ── 29. Access Policies ────────────────────────────────────────────────────
  // One policy per person (advisors + employee-linked people)
  // Weighted like prod: mostly STAFF/SELECTED, some MANAGER/ALL, some ADMIN
  const allPeople = insertedPeople;
  const accessPolicyRows: (typeof accessPolicies.$inferInsert)[] = allPeople.map(person => {
    const roll = faker.number.int({ min: 0, max: 99 });
    const accessLevel =
      roll < 70 ? "STAFF" as const :
      roll < 85 ? "MANAGER" as const :
      "ADMIN" as const;
    const branchScope = accessLevel === "STAFF" ? "SELECTED" as const : "ALL" as const;
    const coreEnabled = faker.datatype.boolean({ probability: 0.75 });
    return {
      tenantId: tenant.id,
      personId: person.id,
      accessLevel,
      modules: { core: coreEnabled, hr: accessLevel !== "STAFF", studio: accessLevel !== "STAFF", events: accessLevel !== "STAFF", ops: accessLevel !== "STAFF", setup: accessLevel === "ADMIN" },
      branchScope,
      branchIds: branchScope === "SELECTED" ? [pick(branchRecords).id] : null,
      coreAccountEnabled: coreEnabled,
      provisioningStatus: coreEnabled ? "SUCCESS" as const : "NOT_STARTED" as const,
    };
  });
  for (let i = 0; i < accessPolicyRows.length; i += BATCH) {
    await db.insert(accessPolicies).values(accessPolicyRows.slice(i, i + BATCH));
  }
  console.log("[seed-full] Created", accessPolicyRows.length, "access policies");

  // ── 30. Employee Presence ──────────────────────────────────────────────────
  // ~33% clocked in, ~67% clocked out (matching prod ratio)
  const presenceRows: (typeof employeePresence.$inferInsert)[] = insertedEmployees
    .filter(e => e.status === "active")
    .map(emp => {
      const isClockedIn = faker.datatype.boolean({ probability: 0.33 });
      const branch = branchRecords.find(b => b.id === emp.branchId) ?? pick(branchRecords);
      const lastEvent = new Date("2026-04-20T08:30:00Z");
      return {
        employeeId: emp.id,
        tenantId: tenant.id,
        isClockedIn,
        currentWorkBranchId: isClockedIn ? branch.id : null,
        lastInAt: lastEvent,
        lastOutAt: isClockedIn ? null : new Date("2026-04-19T18:00:00Z"),
        lastEventAt: lastEvent,
        lastEventType: isClockedIn ? "IN" : "OUT",
      };
    });
  for (let i = 0; i < presenceRows.length; i += BATCH) {
    await db.insert(employeePresence).values(presenceRows.slice(i, i + BATCH));
  }
  console.log("[seed-full] Created", presenceRows.length, "employee presence records");

  // ── 31. Branch Events ───────────────────────────────────────────────────────
  const BRANCH_EVENT_TITLES = [
    "Staff Meeting", "Deep Clean Day", "Birthday Party", "Team Outing",
    "Branch Closure", "Training Day", "Special Event", "Holiday Celebration",
  ];
  const branchEventRows: (typeof branchEvents.$inferInsert)[] = [];
  for (const branch of branchRecords) {
    for (let i = 0; i < 4; i++) {
      const eventDate = faker.date.between({ from: new Date("2026-03-01"), to: new Date("2026-06-30") });
      const startTime = new Date(eventDate);
      startTime.setHours(9, 0, 0, 0);
      const endTime = new Date(eventDate);
      endTime.setHours(17, 0, 0, 0);
      branchEventRows.push({
        branchId: branch.id,
        title: pick(BRANCH_EVENT_TITLES),
        description: faker.lorem.sentence(),
        startTime,
        endTime,
        isAllDay: faker.datatype.boolean({ probability: 0.4 }),
        createdBy: adminUser.id,
      });
    }
  }
  await db.insert(branchEvents).values(branchEventRows);
  console.log("[seed-full] Created", branchEventRows.length, "branch events");

  // ── 32. Schedule Shift Row Roles ─────────────────────────────────────────────
  // Each shift row gets 1 required role
  const shiftRowRoleRows: (typeof scheduleShiftRowRoles.$inferInsert)[] = shiftRowRecords.map(row => ({
    tenantId: tenant.id,
    shiftRowId: row.id,
    roleId: pick(activeRoles).id,
  }));
  await db.insert(scheduleShiftRowRoles).values(shiftRowRoleRows);
  console.log("[seed-full] Created", shiftRowRoleRows.length, "schedule shift row roles");

  // ── 33. Schedule Shift Breaks ─────────────────────────────────────────────
  // Auto-rule breaks (60 min, staggered) for each assignment
  const shiftBreakRows: (typeof scheduleShiftBreaks.$inferInsert)[] = [];
  for (const assignment of assignmentRecords.slice(0, 100)) {
    const row = shiftRowRecords.find(r => r.id === assignment.shiftRowId);
    if (!row) continue;
    shiftBreakRows.push({
      tenantId: tenant.id,
      branchId: row.branchId,
      shiftRowId: row.id,
      shiftDate: assignment.shiftDate,
      employeeId: assignment.employeeId,
      assignmentId: assignment.id,
      breakStartTime: "12:30",
      breakEndTime: "13:30",
      breakDurationMinutes: row.breakDurationMinutes ?? 60,
      source: "auto_rule" as const,
      hasConflict: false,
    });
  }
  for (let i = 0; i < shiftBreakRows.length; i += BATCH) {
    await db.insert(scheduleShiftBreaks).values(shiftBreakRows.slice(i, i + BATCH));
  }
  console.log("[seed-full] Created", shiftBreakRows.length, "schedule shift breaks");

  // ── 34. Payroll Day Reconciliations ─────────────────────────────────────────
  // Per-employee per-day reconciliation for the first finalized run
  const reconcRows: (typeof payrollDayReconciliations.$inferInsert)[] = [];
  const firstRun = finalizedRuns[0];
  const firstPeriod = payrollPeriodRecords[0];
  for (const emp of activeEmps.slice(0, 10)) {
    const branch = branchRecords.find(b => b.id === emp.branchId) ?? pick(branchRecords);
    for (let d = 0; d < 5; d++) {
      const workDate = new Date(firstPeriod.startDate);
      workDate.setDate(workDate.getDate() + d);
      const scheduledMin = 480;
      const actualMin = faker.number.int({ min: 450, max: 510 });
      const dailyRate = faker.number.int({ min: 600, max: 2500 });
      reconcRows.push({
        payrollRunId: firstRun.id,
        employeeId: emp.id,
        branchId: branch.id,
        workDate: workDate.toISOString().slice(0, 10),
        scheduledMinutes: scheduledMin,
        actualMinutes: actualMin,
        scheduledPay: String(dailyRate),
        actualPay: String(Math.round(dailyRate * actualMin / scheduledMin)),
        overtimeMinutes: Math.max(0, actualMin - scheduledMin),
        varianceMinutes: actualMin - scheduledMin,
        varianceAmount: "0",
      });
    }
  }
  await db.insert(payrollDayReconciliations).values(reconcRows);
  console.log("[seed-full] Created", reconcRows.length, "payroll day reconciliations");

  // ── 35. Access Items ─────────────────────────────────────────────────────────
  const ACCESS_ITEM_DEFS = [
    { title: "Staff WiFi",          category: "wifi"      as const, visibility: "all_staff"    as const },
    { title: "Office WiFi",         category: "wifi"      as const, visibility: "admin_manager" as const },
    { title: "POS System Login",    category: "systems"   as const, visibility: "admin_manager" as const },
    { title: "Front Door Code",     category: "door_lock" as const, visibility: "admin_manager" as const },
    { title: "Safe Combination",    category: "other"     as const, visibility: "admin_only"    as const },
    { title: "Bank Portal",         category: "banking"   as const, visibility: "admin_only"    as const },
  ];
  const accessItemRows: (typeof accessItems.$inferInsert)[] = ACCESS_ITEM_DEFS.map(def => ({
    tenantId: tenant.id,
    title: def.title,
    category: def.category,
    username: def.category === "systems" ? "admin" : null,
    passwordEncrypted: faker.string.alphanumeric(64), // placeholder encrypted value
    branchIds: branchRecords.map(b => b.id),
    visibilityLevel: def.visibility,
    status: "active" as const,
    updatedBy: adminUser.id,
  }));
  const insertedAccessItems = await db.insert(accessItems).values(accessItemRows).returning();
  console.log("[seed-full] Created", insertedAccessItems.length, "access items");

  // ── 36. Xero Tokens ──────────────────────────────────────────────────────────
  const XERO_SCOPES = "openid profile email accounting.transactions.read accounting.settings.read accounting.contacts.read accounting.reports.read offline_access";
  const xeroExpiry = new Date("2026-04-21T00:00:00Z");
  await db.insert(xeroTokens).values([
    {
      tenantId: tenant.id,
      xeroTenantId: faker.string.uuid(),
      xeroTenantName: "Oto Company Limited",
      accessToken: faker.string.alphanumeric(200),
      refreshToken: faker.string.alphanumeric(100),
      expiresAt: xeroExpiry,
      scopes: XERO_SCOPES,
      connectedBy: adminUser.id,
      isActive: true,
    },
  ]);
  console.log("[seed-full] Created 1 xero token");

  // ── 37. Template Assignments ──────────────────────────────────────────────
  // Assign employment templates to each branch; first one is default
  const employmentTemplates = templateRecords.filter(t => t.templateType === "employment");
  const templateAssignmentRows: (typeof templateAssignments.$inferInsert)[] = [];
  for (const branch of branchRecords) {
    for (const [i, tmpl] of employmentTemplates.entries()) {
      templateAssignmentRows.push({
        templateId: tmpl.id,
        branchId: branch.id,
        isDefaultForBranch: i === 0,
        assignedBy: adminUser.id,
      });
    }
  }
  await db.insert(templateAssignments).values(templateAssignmentRows);
  console.log("[seed-full] Created", templateAssignmentRows.length, "template assignments");

  // ── 38. Staff Cost Allocations ────────────────────────────────────────────
  // A few multi-branch employees with split cost allocations
  const multibranchEmps = activeEmps.slice(0, 5);
  const costAllocRows: (typeof staffCostAllocations.$inferInsert)[] = [];
  for (const emp of multibranchEmps) {
    // Split 60/40 across the two branches
    costAllocRows.push(
      { tenantId: tenant.id, employeeId: emp.id, branchId: branchRecords[0].id, allocationPercent: 60 },
      { tenantId: tenant.id, employeeId: emp.id, branchId: branchRecords[1].id, allocationPercent: 40 },
    );
  }
  await db.insert(staffCostAllocations).values(costAllocRows);
  console.log("[seed-full] Created", costAllocRows.length, "staff cost allocations");

  // ── 39. Contract Instances ──────────────────────────────────────────────
  // Mix: active+signed (majority), finalized+not_sent, finalized+awaiting, a few draft
  const employmentTmpl = employmentTemplates[0];
  type ContractStatus = "active"|"finalized"|"draft"|"superseded";
  type SigningStatus = "signed"|"not_sent"|"awaiting_signature";
  const CONTRACT_SPECS: { status: ContractStatus; signingStatus: SigningStatus; count: number }[] = [
    { status: "active",    signingStatus: "signed",             count: 40 },
    { status: "finalized", signingStatus: "not_sent",           count: 10 },
    { status: "finalized", signingStatus: "awaiting_signature", count: 6  },
    { status: "superseded",signingStatus: "signed",             count: 3  },
    { status: "draft",     signingStatus: "not_sent",           count: 1  },
  ];
  const contractRecords: (typeof contractInstances.$inferSelect)[] = [];
  let contractEmpIdx = 0;
  for (const spec of CONTRACT_SPECS) {
    const batch: (typeof contractInstances.$inferInsert)[] = [];
    for (let i = 0; i < spec.count; i++) {
      const emp = insertedEmployees[contractEmpIdx % insertedEmployees.length];
      contractEmpIdx++;
      const branch = branchRecords.find(b => b.id === emp.branchId) ?? pick(branchRecords);
      const salary = faker.number.int({ min: 18000, max: 75000 });
      batch.push({
        employeeId: emp.id,
        templateId: employmentTmpl.id,
        branchId: branch.id,
        templateSnapshotHtml: `<h1>Employment Agreement</h1><p>Employee: ${emp.fullName}</p>`,
        templateSnapshotVersion: 1,
        mergeDataJson: {
          positionTitle: faker.person.jobTitle(),
          salaryThb: salary,
          startDate: faker.date.past({ years: 2 }).toISOString().slice(0, 10),
        },
        status: spec.status,
        finalizedAt: spec.status !== "draft" ? faker.date.past({ years: 1 }) : null,
        signingStatus: spec.signingStatus,
        signedAt: spec.signingStatus === "signed" ? faker.date.past({ years: 1 }) : null,
        createdBy: adminUser.id,
      });
    }
    const inserted = await db.insert(contractInstances).values(batch).returning();
    contractRecords.push(...inserted);
  }
  console.log("[seed-full] Created", contractRecords.length, "contract instances");

  // ── 40. Activity Log ─────────────────────────────────────────────────────────
  const ACTIVITY_TYPES_WEIGHTED = [
    { type: "employee_created",        weight: 10 },
    { type: "contract_created",         weight: 10 },
    { type: "contract_activated",       weight: 9  },
    { type: "contract_signed",          weight: 9  },
    { type: "USER_PASSWORD_CHANGED",    weight: 8  },
    { type: "face_enrolled",            weight: 8  },
    { type: "profile_photo_set",        weight: 8  },
    { type: "enrollment_session_created", weight: 7 },
    { type: "pin_set",                  weight: 5  },
    { type: "probation_completed",      weight: 4  },
    { type: "employment_state_changed", weight: 4  },
    { type: "offboarding_started",      weight: 3  },
    { type: "employment_ended",         weight: 3  },
    { type: "USER_CREATED",             weight: 2  },
    { type: "contract_finalized",       weight: 2  },
    { type: "salary_change",            weight: 2  },
  ] as const;
  type ActivityType = typeof ACTIVITY_TYPES_WEIGHTED[number]["type"];
  function pickActivityType(): ActivityType {
    const total = ACTIVITY_TYPES_WEIGHTED.reduce((s, w) => s + w.weight, 0);
    let n = faker.number.int({ min: 0, max: total - 1 });
    for (const { type, weight } of ACTIVITY_TYPES_WEIGHTED) {
      if (n < weight) return type;
      n -= weight;
    }
    return "employee_created";
  }
  const activityRows: (typeof activityLog.$inferInsert)[] = [];
  for (let i = 0; i < 120; i++) {
    const emp = pick(insertedEmployees);
    const branch = branchRecords.find(b => b.id === emp.branchId) ?? pick(branchRecords);
    const type = pickActivityType();
    activityRows.push({
      branchId: branch.id,
      employeeId: emp.id,
      activityType: type as any,
      summaryText: `${type.replace(/_/g, " ")} for ${emp.fullName}`,
      createdBy: adminUser.id,
    });
  }
  for (let i = 0; i < activityRows.length; i += BATCH) {
    await db.insert(activityLog).values(activityRows.slice(i, i + BATCH));
  }
  console.log("[seed-full] Created", activityRows.length, "activity log entries");

  // ── 41. Attention Items ───────────────────────────────────────────────────
  const ATTENTION_SPECS: { type: string; severity: "low"|"medium"|"high"; status: "open"|"resolved"; count: number }[] = [
    { type: "TIMEKEEPING_STUCK_CLOCK_IN",  severity: "high",   status: "open",     count: 8  },
    { type: "TIMEKEEPING_STUCK_CLOCK_IN",  severity: "high",   status: "resolved", count: 12 },
    { type: "CONTRACT_NOT_SIGNED",         severity: "high",   status: "open",     count: 5  },
    { type: "CONTRACT_NOT_SIGNED",         severity: "low",    status: "resolved", count: 8  },
    { type: "PROBATION_REVIEW_OVERDUE",    severity: "high",   status: "open",     count: 4  },
    { type: "FACE_ENROLLMENT_REQUIRED",    severity: "medium", status: "resolved", count: 6  },
    { type: "MISSING_LOGIN_ACCESS",        severity: "high",   status: "resolved", count: 5  },
    { type: "EMPLOYEE_MISSING_ROLE",       severity: "low",    status: "resolved", count: 4  },
    { type: "EMPLOYEE_MISSING_DEPARTMENT", severity: "low",    status: "resolved", count: 4  },
    { type: "SCHEDULED_NO_SHOW_ALERT",     severity: "high",   status: "resolved", count: 6  },
    { type: "VISA_EXPIRING",               severity: "high",   status: "open",     count: 2  },
  ];
  const attentionRows: (typeof attentionItems.$inferInsert)[] = [];
  for (const spec of ATTENTION_SPECS) {
    for (let i = 0; i < spec.count; i++) {
      const emp = pick(insertedEmployees);
      const branch = branchRecords.find(b => b.id === emp.branchId) ?? pick(branchRecords);
      attentionRows.push({
        branchId: branch.id,
        employeeId: emp.id,
        type: spec.type as any,
        severity: spec.severity,
        title: spec.type.replace(/_/g, " "),
        description: `Attention required: ${spec.type.toLowerCase().replace(/_/g, " ")} for ${emp.fullName}`,
        status: spec.status,
        ruleKey: spec.type,
        entityKey: emp.id,
        fingerprint: `${spec.type}:${emp.id}`,
        resolvedAt: spec.status === "resolved" ? faker.date.recent({ days: 30 }) : null,
        resolvedBy: spec.status === "resolved" ? adminUser.id : null,
      });
    }
  }
  for (let i = 0; i < attentionRows.length; i += BATCH) {
    await db.insert(attentionItems).values(attentionRows.slice(i, i + BATCH));
  }
  console.log("[seed-full] Created", attentionRows.length, "attention items");

  // ── 42. Enrollment Sessions ──────────────────────────────────────────────
  // ~75% used (matching prod), 25% pending/expired
  const enrollmentSessionRows: (typeof enrollmentSessions.$inferInsert)[] =
    insertedEmployees.slice(0, 30).map((emp, i) => {
      const isUsed = i < 22;
      const createdAt = faker.date.past({ years: 1 });
      const expiresAt = new Date(createdAt);
      expiresAt.setHours(expiresAt.getHours() + 24);
      return {
        employeeId: emp.id,
        tokenHash: faker.string.hexadecimal({ length: 64, casing: "lower" }),
        expiresAt,
        usedAt: isUsed ? new Date(createdAt.getTime() + 1000 * 60 * 30) : null,
        createdBy: adminUser.id,
      };
    });
  await db.insert(enrollmentSessions).values(enrollmentSessionRows);
  console.log("[seed-full] Created", enrollmentSessionRows.length, "enrollment sessions");

  // ── 43. Time Entries ─────────────────────────────────────────────────────────
  // Paired clock-in/out entries for enrolled employees over recent days
  const timeEntryRows: (typeof timeEntries.$inferInsert)[] = [];
  for (const emp of enrolledEmps.slice(0, 15)) {
    const branch = branchRecords.find(b => b.id === emp.branchId) ?? pick(branchRecords);
    for (let d = 0; d < 10; d++) {
      const shiftDate = new Date("2026-04-20");
      shiftDate.setDate(shiftDate.getDate() - d);
      if (shiftDate.getDay() === 0 || shiftDate.getDay() === 6) continue;
      const clockIn = new Date(shiftDate);
      clockIn.setHours(faker.number.int({ min: 8, max: 10 }), faker.number.int({ min: 0, max: 59 }));
      const clockOut = new Date(shiftDate);
      clockOut.setHours(faker.number.int({ min: 17, max: 20 }), faker.number.int({ min: 0, max: 59 }));
      const isAutoFixed = faker.datatype.boolean({ probability: 0.1 });
      timeEntryRows.push({
        tenantId: tenant.id,
        employeeId: emp.id,
        branchId: branch.id,
        shiftDate: shiftDate.toISOString().slice(0, 10),
        clockInAt: clockIn,
        clockOutAt: clockOut,
        status: isAutoFixed ? "AUTO_FIXED" as const : "PENDING_APPROVAL" as const,
        sourceIn: isAutoFixed ? "SYSTEM" as const : "FACE_KIOSK" as const,
        sourceOut: isAutoFixed ? "SYSTEM" as const : "FACE_KIOSK" as const,
      });
    }
  }
  const timeEntryRecords: (typeof timeEntries.$inferSelect)[] = [];
  for (let i = 0; i < timeEntryRows.length; i += BATCH) {
    const batch = await db.insert(timeEntries).values(timeEntryRows.slice(i, i + BATCH)).returning();
    timeEntryRecords.push(...batch);
  }
  console.log("[seed-full] Created", timeEntryRecords.length, "time entries");

  // ── 44. Timekeeping Issues ───────────────────────────────────────────────
  // Mostly UNSCHEDULED_WORK + MISSING_CLOCK_IN, mostly OPEN (matching prod)
  const TK_ISSUE_SPECS: { type: string; status: "OPEN"|"RESOLVED"; count: number }[] = [
    { type: "UNSCHEDULED_WORK", status: "OPEN",     count: 20 },
    { type: "MISSING_CLOCK_IN", status: "OPEN",     count: 8  },
    { type: "MISSING_CLOCK_OUT",status: "RESOLVED", count: 5  },
    { type: "LATE_ARRIVAL",     status: "RESOLVED", count: 4  },
  ];
  const tkIssueRows: (typeof timekeepingIssues.$inferInsert)[] = [];
  for (const spec of TK_ISSUE_SPECS) {
    for (let i = 0; i < spec.count; i++) {
      const emp = pick(enrolledEmps);
      const branch = branchRecords.find(b => b.id === emp.branchId) ?? pick(branchRecords);
      const issueDate = faker.date.recent({ days: 14 });
      tkIssueRows.push({
        tenantId: tenant.id,
        employeeId: emp.id,
        branchId: branch.id,
        issueDate: issueDate.toISOString().slice(0, 10),
        issueType: spec.type as any,
        status: spec.status,
        createdBy: "KIOSK_SYSTEM",
        resolvedBy: spec.status === "RESOLVED" ? adminUser.id : null,
        resolvedAt: spec.status === "RESOLVED" ? faker.date.recent({ days: 7 }) : null,
      });
    }
  }
  for (let i = 0; i < tkIssueRows.length; i += BATCH) {
    await db.insert(timekeepingIssues).values(tkIssueRows.slice(i, i + BATCH));
  }
  console.log("[seed-full] Created", tkIssueRows.length, "timekeeping issues");

  // ── 45. Auth OTP Events ───────────────────────────────────────────────────
  const OTP_SPECS: { eventType: "request"|"verify_success"|"verify_fail"|"password_reset"; success: boolean; count: number }[] = [
    { eventType: "request",        success: true,  count: 15 },
    { eventType: "request",        success: false, count: 12 },
    { eventType: "verify_success", success: true,  count: 12 },
    { eventType: "password_reset", success: true,  count: 3  },
  ];
  const otpRows: (typeof authOtpEvents.$inferInsert)[] = [];
  for (const spec of OTP_SPECS) {
    for (let i = 0; i < spec.count; i++) {
      const user = pick(insertedUsers);
      otpRows.push({
        userId: user.id,
        phoneE164: `+6681${faker.string.numeric(7)}`,
        eventType: spec.eventType,
        success: spec.success,
        ipAddress: faker.internet.ipv4(),
        userAgent: "Mozilla/5.0",
        failReason: spec.success ? null : "invalid_code",
      });
    }
  }
  await db.insert(authOtpEvents).values(otpRows);
  console.log("[seed-full] Created", otpRows.length, "auth OTP events");

  // ── 46. Shift Required Roles ─────────────────────────────────────────────
  // Assign 1 required role to each shift
  const shiftRoleRows: (typeof shiftRequiredRoles.$inferInsert)[] = shiftRecords.map(shift => ({
    tenantId: tenant.id,
    shiftId: shift.id,
    roleId: pick(activeRoles).id,
  }));
  await db.insert(shiftRequiredRoles).values(shiftRoleRows);
  console.log("[seed-full] Created", shiftRoleRows.length, "shift required roles");

  // ── 47. Leave Policies ─────────────────────────────────────────────────────
  // One company-wide default policy + one per branch (matching prod shape)
  await db.insert(leavePolicies).values([
    { name: "Default Day-Off Policy", daysWorkedRequired: 5, daysOffEarned: 2, isActive: true },
    { branchId: branchRecords[0].id, name: "Bangkok Leave Policy",       daysWorkedRequired: 5, daysOffEarned: 2, isActive: true },
    { branchId: branchRecords[1].id, name: "San Francisco Leave Policy", daysWorkedRequired: 5, daysOffEarned: 1, isActive: true },
  ]);
  console.log("[seed-full] Created 3 leave policies");

  // ── 48. Schedule Templates ───────────────────────────────────────────────
  const TEMPLATE_NAMES = ["Standard", "Kitchen", "Waiter Standard", "Reception Standard"];
  const schedTemplateRecords: (typeof scheduleTemplates.$inferSelect)[] = [];
  for (const branch of branchRecords) {
    const branchGroups = shiftGroupRecords.filter(g => g.branchId === branch.id);
    for (const name of TEMPLATE_NAMES) {
      const dept = pick(departmentRecords);
      const group = pick(branchGroups);
      const [rec] = await db.insert(scheduleTemplates).values({
        tenantId: tenant.id,
        branchId: branch.id,
        departmentId: dept.id,
        shiftGroupId: group.id,
        name,
        createdBy: adminUser.id,
      }).returning();
      schedTemplateRecords.push(rec);
    }
  }
  console.log("[seed-full] Created", schedTemplateRecords.length, "schedule templates");

  // ── 49. Schedule Template Rows ────────────────────────────────────────────
  const schedTemplateRowRecords: (typeof scheduleTemplateRows.$inferSelect)[] = [];
  for (const tmpl of schedTemplateRecords) {
    for (const [idx, def] of SHIFT_ROW_DEFS.entries()) {
      const [row] = await db.insert(scheduleTemplateRows).values({
        tenantId: tenant.id,
        templateId: tmpl.id,
        departmentId: tmpl.departmentId,
        shiftGroupId: tmpl.shiftGroupId,
        rowOrder: idx,
        label: def.label,
        startTime: def.startTime,
        endTime: def.endTime,
        staffRequired: 1,
        breakEnabled: true,
        breakDurationMinutes: def.breakMin,
        breakBaseOffsetMinutes: 150,
        breakStaggerMinutes: 30,
      }).returning();
      schedTemplateRowRecords.push(row);
    }
  }
  console.log("[seed-full] Created", schedTemplateRowRecords.length, "schedule template rows");

  // ── 50. Schedule Template Row Roles ──────────────────────────────────────
  const templateRowRoleRows: (typeof scheduleTemplateRowRoles.$inferInsert)[] = schedTemplateRowRecords.map(row => ({
    tenantId: tenant.id,
    templateRowId: row.id,
    roleId: pick(activeRoles).id,
  }));
  await db.insert(scheduleTemplateRowRoles).values(templateRowRoleRows);
  console.log("[seed-full] Created", templateRowRoleRows.length, "schedule template row roles");

  // ── 51. Schedule Template Assignments ──────────────────────────────────
  // Pre-assign a few employees to template rows (Mon-Fri)
  const templateAssignRows: (typeof scheduleTemplateAssignments.$inferInsert)[] = [];
  for (const row of schedTemplateRowRecords.slice(0, 8)) {
    for (let day = 0; day < 5; day++) {
      templateAssignRows.push({
        templateRowId: row.id,
        dayOfWeek: day,
        employeeId: pick(activeEmps).id,
      });
    }
  }
  await db.insert(scheduleTemplateAssignments).values(templateAssignRows);
  console.log("[seed-full] Created", templateAssignRows.length, "schedule template assignments");

  // ── 52. Schedule Template Time Off ─────────────────────────────────────
  // Regular days off within templates
  const templateTimeOffRows: (typeof scheduleTemplateTimeOff.$inferInsert)[] =
    activeEmps.slice(0, 8).map(emp => ({
      tenantId: tenant.id,
      templateId: pick(schedTemplateRecords).id,
      dayOfWeek: faker.number.int({ min: 0, max: 6 }),
      employeeId: emp.id,
    }));
  await db.insert(scheduleTemplateTimeOff).values(templateTimeOffRows);
  console.log("[seed-full] Created", templateTimeOffRows.length, "schedule template time-off entries");

  // ── 53. Schedule Audit Log ─────────────────────────────────────────────────
  const AUDIT_ACTIONS = ["apply_template", "clear_week", "delete_shift_row", "overwrite_department"];
  const auditLogRows = weekPlanRecords.slice(0, 6).map(plan => ({
    tenantId: tenant.id,
    weekPlanId: plan.id,
    branchId: plan.branchId,
    action: pick(AUDIT_ACTIONS),
    description: `${pick(AUDIT_ACTIONS)} performed on week ${plan.weekStartDate}`,
    performedBy: adminUser.id,
    snapshotData: { weekPlanId: plan.id },
  }));
  await db.insert(scheduleAuditLog).values(auditLogRows);
  console.log("[seed-full] Created", auditLogRows.length, "schedule audit log entries");

  // ── 54. Payroll Exceptions ─────────────────────────────────────────────────
  const EXCEPTION_SPECS: { exType: string; severity: "INFO"|"WARNING"|"BLOCKER"; status: "OPEN"|"APPROVED"|"RESOLVED"; count: number }[] = [
    { exType: "MISSING_PUNCH",          severity: "WARNING", status: "OPEN",     count: 6 },
    { exType: "VARIANCE_OVER_THRESHOLD",severity: "WARNING", status: "RESOLVED", count: 4 },
    { exType: "OT_REQUIRES_APPROVAL",   severity: "BLOCKER", status: "APPROVED", count: 3 },
    { exType: "STATUTORY_DATA_MISSING", severity: "BLOCKER", status: "OPEN",     count: 2 },
  ];
  const payrollExceptionRecords: (typeof payrollExceptions.$inferSelect)[] = [];
  for (const spec of EXCEPTION_SPECS) {
    for (let i = 0; i < spec.count; i++) {
      const run = pick(finalizedRuns);
      const emp = pick(activeEmps);
      const branch = branchRecords.find(b => b.id === emp.branchId) ?? pick(branchRecords);
      const [rec] = await db.insert(payrollExceptions).values({
        payrollRunId: run.id,
        employeeId: emp.id,
        branchId: branch.id,
        exceptionType: spec.exType as any,
        severity: spec.severity,
        message: `${spec.exType.replace(/_/g, " ")} for ${emp.fullName}`,
        status: spec.status as any,
        requiredApproverRole: spec.severity === "BLOCKER" ? "PAYROLL_ADMIN" as const : null,
      }).returning();
      payrollExceptionRecords.push(rec);
    }
  }
  console.log("[seed-full] Created", payrollExceptionRecords.length, "payroll exceptions");

  // ── 55. Payroll Exception Approvals ─────────────────────────────────────
  const approvedExceptions = payrollExceptionRecords.filter(e => e.status === "APPROVED");
  if (approvedExceptions.length > 0) {
    await db.insert(payrollExceptionApprovals).values(
      approvedExceptions.map(ex => ({
        payrollExceptionId: ex.id,
        approverId: adminUser.id,
        role: "PAYROLL_ADMIN",
        decision: "APPROVED" as const,
        note: "Approved after review",
      })),
    );
  }
  console.log("[seed-full] Created", approvedExceptions.length, "payroll exception approvals");

  // ── 56. Salary Advances ────────────────────────────────────────────────────
  const salaryAdvanceRecords: (typeof salaryAdvances.$inferSelect)[] = [];
  for (const emp of activeEmps.slice(0, 4)) {
    const principal = faker.number.int({ min: 5000, max: 30000 });
    const repaid = faker.number.int({ min: 0, max: principal });
    const [rec] = await db.insert(salaryAdvances).values({
      tenantId: tenant.id,
      operatorId: operator.id,
      employeeId: emp.id,
      principalAmount: String(principal),
      issuedDate: faker.date.past({ years: 1 }).toISOString().slice(0, 10),
      repaymentType: "FIXED_AMOUNT" as const,
      repaymentAmount: String(faker.number.int({ min: 1000, max: 5000 })),
      remainingBalance: String(principal - repaid),
      status: repaid >= principal ? "CLOSED" as const : "ACTIVE" as const,
      createdBy: adminUser.id,
    }).returning();
    salaryAdvanceRecords.push(rec);
  }
  console.log("[seed-full] Created", salaryAdvanceRecords.length, "salary advances");

  // ── 57. Salary Advance Repayments ───────────────────────────────────────
  const repaymentRows: (typeof salaryAdvanceRepayments.$inferInsert)[] = [];
  for (const advance of salaryAdvanceRecords) {
    const run = pick(finalizedRuns);
    const amount = faker.number.int({ min: 1000, max: 5000 });
    repaymentRows.push({
      salaryAdvanceId: advance.id,
      payrollRunId: run.id,
      employeeId: advance.employeeId,
      amount: String(amount),
      remainingBalanceAfter: String(Math.max(0, Number(advance.principalAmount) - amount)),
    });
  }
  await db.insert(salaryAdvanceRepayments).values(repaymentRows);
  console.log("[seed-full] Created", repaymentRows.length, "salary advance repayments");

  // ── 58. Statutory Rule Sets ────────────────────────────────────────────────
  const [statutoryRuleSet] = await db.insert(statutoryRuleSets).values({
    tenantId: tenant.id,
    operatorId: operator.id,
    countryCode: "TH",
    name: "Thailand SSO + WHT 2026",
    description: "Social Security and withholding tax rules for Thailand 2026",
    effectiveFrom: "2026-01-01",
    rules: {
      sso: { employeeRate: 0.05, employerRate: 0.05, minWage: 1650, maxWage: 15000 },
      wht: { brackets: [{ upTo: 150000, rate: 0 }, { upTo: 300000, rate: 0.05 }, { upTo: 500000, rate: 0.10 }] },
    },
    status: "active" as const,
    createdBy: adminUser.id,
  }).returning();
  console.log("[seed-full] Created 1 statutory rule set");

  // ── 59. Statutory Calculation Results ───────────────────────────────────
  const statutoryResultRows: (typeof statutoryCalculationResults.$inferInsert)[] = [];
  for (const run of finalizedRuns.slice(0, 2)) {
    for (const emp of activeEmps.slice(0, 5)) {
      const gross = faker.number.int({ min: 15000, max: 60000 });
      const sso = Math.min(gross * 0.05, 750);
      statutoryResultRows.push({
        payrollRunId: run.id,
        employeeId: emp.id,
        countryCode: "TH",
        results: { sso: { employee: sso, employer: sso }, wht: { amount: 0 }, gross },
      });
    }
  }
  await db.insert(statutoryCalculationResults).values(statutoryResultRows);
  console.log("[seed-full] Created", statutoryResultRows.length, "statutory calculation results");

  // ── 60. User Module Overrides ──────────────────────────────────────────────
  // A handful of managers/admins with module overrides
  const managerUsers = insertedUsers.filter(u => u.role === "manager" || u.role === "admin").slice(0, 6);
  const MODULE_KEYS = ["scheduling", "hr", "reports", "settings"] as const;
  const overrideRows: (typeof userModuleOverrides.$inferInsert)[] = managerUsers.flatMap(u =>
    [pick(MODULE_KEYS)].map(key => ({
      tenantId: tenant.id,
      userId: u.id,
      moduleKey: key,
      enabled: true,
      branchScopeType: "ALL" as const,
      branchIds: [],
      updatedBy: adminUser.id,
    }))
  );
  if (overrideRows.length > 0) {
    await db.insert(userModuleOverrides).values(overrideRows);
  }
  console.log("[seed-full] Created", overrideRows.length, "user module overrides");

  // ── 61. Kiosk Codes ───────────────────────────────────────────────────────────
  // Short-lived pairing codes — seed a few expired + one active per branch
  const kioskCodeRows: (typeof kioskCodes.$inferInsert)[] = branchRecords.flatMap(branch => [
    {
      tenantId: tenant.id,
      branchId: branch.id,
      codeHash: faker.string.hexadecimal({ length: 64, casing: "lower" }),
      expiresAt: new Date("2026-01-01"), // expired
      usedAt: new Date("2026-01-01"),
    },
    {
      tenantId: tenant.id,
      branchId: branch.id,
      codeHash: faker.string.hexadecimal({ length: 64, casing: "lower" }),
      expiresAt: new Date("2026-04-21T12:00:00Z"), // still valid
    },
  ]);
  await db.insert(kioskCodes).values(kioskCodeRows);
  console.log("[seed-full] Created", kioskCodeRows.length, "kiosk codes");

  // ── 62. Employee Changes ───────────────────────────────────────────────────
  const CHANGE_SPECS: { changeType: "resigned"|"branch_transfer"|"salary_adjustment"; count: number }[] = [
    { changeType: "resigned",         count: 6 },
    { changeType: "branch_transfer",  count: 3 },
    { changeType: "salary_adjustment",count: 3 },
  ];
  const changeRows: (typeof employeeChanges.$inferInsert)[] = [];
  for (const spec of CHANGE_SPECS) {
    for (let i = 0; i < spec.count; i++) {
      const emp = pick(insertedEmployees);
      const oldSalary = faker.number.int({ min: 15000, max: 50000 });
      const newSalary = Math.round(oldSalary * faker.number.float({ min: 1.05, max: 1.20 }));
      changeRows.push({
        employeeId: emp.id,
        changeType: spec.changeType,
        effectiveDate: faker.date.past({ years: 1 }),
        oldSalary: spec.changeType === "salary_adjustment" ? oldSalary : null,
        newSalary: spec.changeType === "salary_adjustment" ? newSalary : null,
        oldBranchId: spec.changeType === "branch_transfer" ? branchRecords[0].id : null,
        newBranchId: spec.changeType === "branch_transfer" ? branchRecords[1].id : null,
        createdBy: adminUser.id,
      });
    }
  }
  await db.insert(employeeChanges).values(changeRows);
  console.log("[seed-full] Created", changeRows.length, "employee changes");

  // ── 63. Policy Documents ───────────────────────────────────────────────────
  const policyDocRecords = await db.insert(policyDocuments).values([
    {
      title: "Rules & Regulations",
      contentHtml: "<h1>Company Rules & Regulations</h1><p>All staff must adhere to the following policies...</p>",
      status: "published" as const,
      publishedAt: new Date("2026-01-01"),
      isCompanyWide: true,
      createdBy: adminUser.id,
      updatedBy: adminUser.id,
    },
    {
      title: "Branch Safety Policy",
      contentHtml: "<h1>Safety Policy</h1><p>Safety is our top priority...</p>",
      status: "published" as const,
      publishedAt: new Date("2026-01-15"),
      isCompanyWide: false,
      branchId: branchRecords[0].id,
      createdBy: adminUser.id,
      updatedBy: adminUser.id,
    },
    {
      title: "Leave Policy 2026 (Draft)",
      contentHtml: "<h1>Leave Policy</h1><p>Updated annual leave terms for 2026...</p>",
      status: "draft" as const,
      isCompanyWide: true,
      createdBy: adminUser.id,
      updatedBy: adminUser.id,
    },
  ]).returning();
  console.log("[seed-full] Created", policyDocRecords.length, "policy documents");

  // ── 64. Employee Documents ─────────────────────────────────────────────────
  const DOC_TYPES = ["id_card", "passport", "other"] as const;
  const empDocRows: (typeof employeeDocuments.$inferInsert)[] = [];
  for (const emp of insertedEmployees.slice(0, 20)) {
    const branch = branchRecords.find(b => b.id === emp.branchId) ?? pick(branchRecords);
    empDocRows.push({
      employeeId: emp.id,
      branchId: branch.id,
      documentType: pick(DOC_TYPES),
      fileName: `${emp.fullName.replace(/ /g, "_")}_ID.pdf`,
      filePath: `employee_docs/${emp.id}/id.pdf`,
      mimeType: "application/pdf",
      fileSize: faker.number.int({ min: 50000, max: 500000 }),
      uploadedBy: adminUser.id,
    });
  }
  await db.insert(employeeDocuments).values(empDocRows);
  console.log("[seed-full] Created", empDocRows.length, "employee documents");

  // ── 65. Employee Offboarding ───────────────────────────────────────────────
  const resignedEmps = insertedEmployees.filter(e => e.status === "resigned").slice(0, 6);
  const terminatedEmps = insertedEmployees.filter(e => e.status === "terminated").slice(0, 2);
  const offboardingEmps = [...resignedEmps, ...terminatedEmps];
  const RESIGN_REASONS = ["other", "personal_reasons", "mutual_agreement", "better_opportunity", "relocation"] as const;
  const offboardingRecords: (typeof employeeOffboarding.$inferSelect)[] = [];
  for (const emp of offboardingEmps) {
    const branch = branchRecords.find(b => b.id === emp.branchId) ?? pick(branchRecords);
    const lastDay = faker.date.between({ from: new Date("2025-09-01"), to: new Date("2026-03-31") });
    const [rec] = await db.insert(employeeOffboarding).values({
      employeeId: emp.id,
      branchId: branch.id,
      offboardingType: emp.status === "resigned" ? "RESIGNATION" : "TERMINATION",
      reasonCode: pick(RESIGN_REASONS),
      lastWorkingDay: lastDay,
      noticeDate: new Date(lastDay.getTime() - 30 * 24 * 60 * 60 * 1000),
      leaveAnnualDays: faker.number.int({ min: 0, max: 5 }),
      createdBy: adminUser.id,
    }).returning();
    offboardingRecords.push(rec);
  }
  console.log("[seed-full] Created", offboardingRecords.length, "employee offboarding records");

  // ── 66. Employee Letters ────────────────────────────────────────────────────
  const resignationTmpl = templateRecords.find(t => t.templateType === "resignation")!;
  const letterRows: (typeof employeeLetters.$inferInsert)[] = offboardingRecords.map(ob => ({
    employeeId: ob.employeeId,
    branchId: ob.branchId,
    offboardingId: ob.id,
    letterType: ob.offboardingType === "RESIGNATION" ? "resignation" as const : "termination" as const,
    templateId: resignationTmpl?.id,
    status: faker.helpers.weightedArrayElement([
      { weight: 5, value: "signed" as const },
      { weight: 3, value: "finalized" as const },
      { weight: 2, value: "draft" as const },
    ]),
    renderedHtmlSnapshot: `<h1>Letter</h1><p>This letter acknowledges the end of employment.</p>`,
    createdBy: adminUser.id,
  }));
  await db.insert(employeeLetters).values(letterRows);
  console.log("[seed-full] Created", letterRows.length, "employee letters");

  // ── 67. Offboarding Checklist ──────────────────────────────────────────────
  const CHECKLIST_TYPES = [
    { type: "collect_company_assets", title: "Collect company assets" },
    { type: "resignation_letter",     title: "Obtain signed resignation letter" },
    { type: "final_payroll_calculation", title: "Complete final payroll calculation" },
    { type: "remove_system_access",   title: "Remove system access" },
    { type: "return_keys_badges",     title: "Return keys and access badges" },
  ] as const;
  const checklistRows: (typeof offboardingChecklist.$inferInsert)[] = [];
  for (const ob of offboardingRecords) {
    CHECKLIST_TYPES.forEach((item, idx) => {
      const isCompleted = faker.datatype.boolean({ probability: 0.6 });
      checklistRows.push({
        offboardingId: ob.id,
        employeeId: ob.employeeId,
        branchId: ob.branchId,
        checklistType: item.type,
        title: item.title,
        isCompleted,
        completedAt: isCompleted ? faker.date.recent({ days: 30 }) : null,
        completedBy: isCompleted ? adminUser.id : null,
        sortOrder: idx,
      });
    });
  }
  await db.insert(offboardingChecklist).values(checklistRows);
  console.log("[seed-full] Created", checklistRows.length, "offboarding checklist items");

  // ── 68. Asset Catalog ────────────────────────────────────────────────────────
  const ASSET_CATALOG_DEFS = [
    { name: "Staff Uniform",       category: "uniform"   as const },
    { name: "Locker Key",          category: "access"    as const },
    { name: "iPad / Tablet",       category: "technology"as const },
    { name: "Safety Equipment",    category: "equipment" as const },
    { name: "Name Badge",          category: "access"    as const },
    { name: "Company Phone",       category: "technology"as const },
  ];
  const assetCatalogRecords = await db.insert(assetCatalog).values(
    ASSET_CATALOG_DEFS.map(d => ({ name: d.name, category: d.category, isActive: true }))
  ).returning();
  console.log("[seed-full] Created", assetCatalogRecords.length, "asset catalog items");

  // ── 69. Employee Assets ─────────────────────────────────────────────────────
  const empAssetRows: (typeof employeeAssets.$inferInsert)[] = [];
  for (const emp of activeEmps.slice(0, 15)) {
    const branch = branchRecords.find(b => b.id === emp.branchId) ?? pick(branchRecords);
    const catalogItem = pick(assetCatalogRecords);
    const isReturned = faker.datatype.boolean({ probability: 0.2 });
    empAssetRows.push({
      employeeId: emp.id,
      branchId: branch.id,
      assetNameSnapshot: catalogItem.name,
      catalogAssetId: catalogItem.id,
      quantity: 1,
      assignedBy: adminUser.id,
      returnRequired: true,
      returnedAt: isReturned ? faker.date.recent({ days: 60 }) : null,
      returnedBy: isReturned ? adminUser.id : null,
    });
  }
  await db.insert(employeeAssets).values(empAssetRows);
  console.log("[seed-full] Created", empAssetRows.length, "employee assets");

  // ── 70. Kiosk Sessions ────────────────────────────────────────────────────────
  // One active session per kiosk device (~30 day lifetime)
  await db.insert(kioskSessions).values(
    kioskDeviceRecords.map(device => ({
      tenantId: tenant.id,
      kioskDeviceId: device.id,
      sessionTokenHash: faker.string.hexadecimal({ length: 64, casing: "lower" }),
      expiresAt: new Date("2026-05-20T00:00:00Z"),
      lastSeenAt: new Date("2026-04-20T09:00:00Z"),
    }))
  );
  console.log("[seed-full] Created", kioskDeviceRecords.length, "kiosk sessions");

  // ── 71. Kiosk Auth Attempts ───────────────────────────────────────────────
  // Almost all FACE/SUCCESS (matching prod)
  const kioskAttemptRows: (typeof kioskAuthAttempts.$inferInsert)[] = [];
  for (const emp of enrolledEmps.slice(0, 20)) {
    const branch = branchRecords.find(b => b.id === emp.branchId) ?? pick(branchRecords);
    const kiosk = kioskDeviceRecords.find(k => k.branchId === branch.id) ?? pick(kioskDeviceRecords);
    for (let i = 0; i < 5; i++) {
      kioskAttemptRows.push({
        employeeId: emp.id,
        branchId: branch.id,
        kioskDeviceId: kiosk.id,
        attemptTime: faker.date.recent({ days: 14 }),
        method: "FACE" as const,
        outcome: faker.datatype.boolean({ probability: 0.95 }) ? "SUCCESS" as const : "FAIL" as const,
        confidenceScore: faker.number.int({ min: 88, max: 100 }),
      });
    }
  }
  for (let i = 0; i < kioskAttemptRows.length; i += BATCH) {
    await db.insert(kioskAuthAttempts).values(kioskAttemptRows.slice(i, i + BATCH));
  }
  console.log("[seed-full] Created", kioskAttemptRows.length, "kiosk auth attempts");

  // ── 72. Auth Rate Limits ────────────────────────────────────────────────────
  // A few sliding-window rate limit counters (phone + IP)
  const now2 = new Date("2026-04-20T10:00:00Z");
  const windowStart = new Date(now2.getTime() - 60 * 60 * 1000);
  const expiresAt = new Date(now2.getTime() + 60 * 60 * 1000);
  await db.insert(authRateLimits).values([
    { key: `otp:phone:+6681${faker.string.numeric(7)}`, windowStart, count: 2, expiresAt },
    { key: `otp:ip:${faker.internet.ipv4()}`,           windowStart, count: 1, expiresAt },
  ]);
  console.log("[seed-full] Created 2 auth rate limits");

  // ── 73. Auth Reset Tokens ──────────────────────────────────────────────────
  // A few used + expired reset tokens
  const resetTokenRows: (typeof authResetTokens.$inferInsert)[] = insertedUsers.slice(0, 4).map(u => ({
    id: faker.string.hexadecimal({ length: 40, casing: "lower" }),
    userId: u.id,
    tokenType: "user_password_reset",
    phoneE164: `+6681${faker.string.numeric(7)}`,
    used: faker.datatype.boolean({ probability: 0.75 }),
    expiresAt: faker.date.recent({ days: 1 }),
  }));
  await db.insert(authResetTokens).values(resetTokenRows);
  console.log("[seed-full] Created", resetTokenRows.length, "auth reset tokens");

  // ── 74. Role Department Map ────────────────────────────────────────────────
  // Map each role to 1–2 departments
  const roleDeptRows: (typeof roleDepartmentMap.$inferInsert)[] = roleRecords.flatMap(role =>
    pickN(departmentRecords, faker.number.int({ min: 1, max: 2 })).map(dept => ({
      roleId: role.id,
      departmentId: dept.id,
    }))
  );
  await db.insert(roleDepartmentMap).values(roleDeptRows);
  console.log("[seed-full] Created", roleDeptRows.length, "role-department mappings");

  // ── 75. Role Branch Assignments ───────────────────────────────────────────
  // All active roles available at all branches
  const roleBranchRows: (typeof roleBranchAssignments.$inferInsert)[] = activeRoles.flatMap(role =>
    branchRecords.map(branch => ({
      roleId: role.id,
      branchId: branch.id,
      assignedBy: adminUser.id,
    }))
  );
  await db.insert(roleBranchAssignments).values(roleBranchRows);
  console.log("[seed-full] Created", roleBranchRows.length, "role-branch assignments");

  // ── 76. Coverage Rules ──────────────────────────────────────────────────────
  // Min staffing per branch per department per day type
  const coverageRuleRows: (typeof coverageRules.$inferInsert)[] = branchRecords.flatMap(branch =>
    ["WEEKDAY", "WEEKEND"].flatMap(dayType =>
      departmentRecords.slice(0, 3).map(dept => ({
        branchId: branch.id,
        departmentId: dept.id,
        dayType: dayType as "WEEKDAY" | "WEEKEND",
        minStaff: dayType === "WEEKDAY" ? 2 : 1,
      }))
    )
  );
  await db.insert(coverageRules).values(coverageRuleRows);
  console.log("[seed-full] Created", coverageRuleRows.length, "coverage rules");

  // ── 77. Sick Leave Policies ──────────────────────────────────────────────
  await db.insert(sickLeavePolicies).values([
    { tenantId: tenant.id, annualSickLeaveDays: 30, proRateByStartDate: true, yearStartMonth: 1, isActive: true },
    { tenantId: tenant.id, branchId: branchRecords[0].id, annualSickLeaveDays: 30, proRateByStartDate: true, yearStartMonth: 1, isActive: true },
  ]);
  console.log("[seed-full] Created 2 sick leave policies");

  // ── 78. Employee Payroll Profiles ───────────────────────────────────────────
  // Payroll config for all active employees
  const payrollProfileRows: (typeof employeePayrollProfiles.$inferInsert)[] = activeEmps.map(emp => ({
    tenantId: tenant.id,
    operatorId: operator.id,
    employeeId: emp.id,
    employmentType: "MONTHLY" as const,
    baseSalaryMonthly: String(faker.number.int({ min: 15000, max: 80000 })),
    bankName: pick(["Kasikorn Bank", "Bangkok Bank", "SCB", "Krungthai Bank"]),
    bankAccountNumber: faker.string.numeric(10),
    bankAccountName: emp.fullName,
    taxId: faker.string.numeric(13),
    socialSecurityNumber: faker.string.numeric(13),
    socialSecurityEnabled: true,
    taxWithholdingEnabled: true,
  }));
  for (let i = 0; i < payrollProfileRows.length; i += BATCH) {
    await db.insert(employeePayrollProfiles).values(payrollProfileRows.slice(i, i + BATCH));
  }
  console.log("[seed-full] Created", payrollProfileRows.length, "employee payroll profiles");

  // ── 79. Time Adjustments ───────────────────────────────────────────────────
  const timeAdjRows: (typeof timeAdjustments.$inferInsert)[] = [];
  for (const emp of activeEmps.slice(0, 8)) {
    const branch = branchRecords.find(b => b.id === emp.branchId) ?? pick(branchRecords);
    const workDate = faker.date.recent({ days: 14 });
    const isApproved = faker.datatype.boolean({ probability: 0.6 });
    timeAdjRows.push({
      tenantId: tenant.id,
      operatorId: operator.id,
      employeeId: emp.id,
      branchId: branch.id,
      workDate: workDate.toISOString().slice(0, 10),
      adjustmentType: "EDIT_PUNCH" as const,
      beforePayload: { clockIn: "08:55", clockOut: "17:30" },
      afterPayload:  { clockIn: "09:00", clockOut: "18:00" },
      reason: "Corrected clock-in time",
      requestedBy: adminUser.id,
      approvalStatus: isApproved ? "APPROVED" as const : "PENDING" as const,
      approvedBy: isApproved ? adminUser.id : null,
      approvedAt: isApproved ? faker.date.recent({ days: 7 }) : null,
    });
  }
  await db.insert(timeAdjustments).values(timeAdjRows);
  console.log("[seed-full] Created", timeAdjRows.length, "time adjustments");

  // ── 80. Payroll Policy Settings ────────────────────────────────────────────
  // One policy per operator
  await db.insert(payrollPolicySettings).values({
    tenantId: tenant.id,
    operatorId: operator.id,
    varianceMinutesThreshold: 15,
    varianceAmountThreshold: "100",
    otRequiresApproval: true,
    roundingRule: "NONE" as const,
    unpaidBreakMinutesDefault: 0,
    maxAdvanceDeductionPercentOfNet: "0.30",
  });
  console.log("[seed-full] Created 1 payroll policy settings");

  // ── 81. Access View Logs ───────────────────────────────────────────────────
  // Log a few views of the access vault items
  const realViewLogRows: (typeof accessViewLogs.$inferInsert)[] = insertedAccessItems.flatMap(item =>
    [pick(insertedUsers), pick(insertedUsers)].map(u => ({
      tenantId: tenant.id,
      accessItemId: item.id,
      viewedBy: u.id,
    }))
  );
  await db.insert(accessViewLogs).values(realViewLogRows);
  console.log("[seed-full] Created", realViewLogRows.length, "access view logs");

  // ── 82. Xero Sync Runs ──────────────────────────────────────────────────────
  await db.insert(xeroSyncRuns).values([
    { tenantId: tenant.id, syncType: "TRACKING", fromDate: "2026-01-01", toDate: "2026-03-31", status: "OK" },
    { tenantId: tenant.id, syncType: "PL",       fromDate: "2026-01-01", toDate: "2026-03-31", status: "OK" },
    { tenantId: tenant.id, syncType: "CASH",     fromDate: "2026-01-01", toDate: "2026-03-31", status: "ERROR", errorMessage: "API rate limit exceeded" },
  ]);
  console.log("[seed-full] Created 3 xero sync runs");

  // ── 83. Xero Tracking Categories + Options ──────────────────────────────
  const xeroTenantId = faker.string.uuid();
  const trackingCatId = faker.string.uuid();
  await db.insert(xeroTrackingCategories).values([
    { tenantId: tenant.id, trackingCategoryId: trackingCatId, name: "Location", status: "ACTIVE", rawJson: { Name: "Location", Status: "ACTIVE" } },
  ]);
  const BRANCH_OPTION_NAMES = ["Bangkok", "San Francisco", "Head Office"];
  await db.insert(xeroTrackingOptions).values(
    BRANCH_OPTION_NAMES.map(name => ({
      tenantId: tenant.id,
      trackingCategoryId: trackingCatId,
      trackingOptionId: faker.string.uuid(),
      name,
      status: "ACTIVE",
    }))
  );
  console.log("[seed-full] Created 1 tracking category + 3 options");

  // ── 84. Xero Reports Raw + PL Facts ─────────────────────────────────────
  const [rawReport] = await db.insert(xeroReportsRaw).values({
    tenantId: tenant.id,
    reportType: "ProfitAndLoss",
    fromDate: "2026-01-01",
    toDate: "2026-03-31",
    trackingCategoryId: trackingCatId,
    rawJson: { ReportID: "ProfitAndLoss", ReportName: "Profit and Loss" },
  }).returning();
  const PL_SECTIONS = ["Revenue", "Cost of Sales", "Operating Expenses"];
  const PL_LINES = ["Sales", "Labour", "Rent", "Marketing", "Utilities"];
  const plFactRows: (typeof plFacts.$inferInsert)[] = PL_SECTIONS.flatMap(section =>
    PL_LINES.map(lineName => ({
      reportRawId: rawReport.id,
      tenantId: tenant.id,
      fromDate: "2026-01-01",
      toDate: "2026-03-31",
      section,
      lineName,
      locationName: pick(BRANCH_OPTION_NAMES),
      value: String(faker.number.int({ min: -500000, max: 2000000 })),
    }))
  );
  await db.insert(plFacts).values(plFactRows);
  console.log("[seed-full] Created", plFactRows.length, "P&L facts");

  // ── 85. Cash Txns + Cash Daily ──────────────────────────────────────────
  const cashTxnRows: (typeof cashTxns.$inferInsert)[] = Array.from({ length: 10 }, () => {
    const total = faker.number.int({ min: 1000, max: 500000 });
    const direction = faker.datatype.boolean() ? "in" : "out";
    return {
      tenantId: tenant.id,
      xeroBankTransactionId: faker.string.uuid(),
      date: faker.date.between({ from: new Date("2026-01-01"), to: new Date("2026-03-31") }).toISOString().slice(0, 10),
      bankAccountName: "Kasikorn Business Account",
      type: "RECEIVE",
      total: String(total),
      direction,
      rawJson: { BankTransactionID: faker.string.uuid(), Total: total },
    };
  });
  await db.insert(cashTxns).values(cashTxnRows);
  // Aggregate into daily
  const dailyMap = new Map<string, { cashIn: number; cashOut: number }>();
  for (const txn of cashTxnRows) {
    const date = txn.date as string;
    if (!dailyMap.has(date)) dailyMap.set(date, { cashIn: 0, cashOut: 0 });
    const entry = dailyMap.get(date)!;
    if (txn.direction === "in") entry.cashIn += Number(txn.total);
    else entry.cashOut += Number(txn.total);
  }
  const cashDailyRows: (typeof cashDaily.$inferInsert)[] = [...dailyMap.entries()].map(([date, { cashIn, cashOut }]) => ({
    tenantId: tenant.id,
    date,
    cashIn: String(cashIn),
    cashOut: String(cashOut),
    net: String(cashIn - cashOut),
  }));
  await db.insert(cashDaily).values(cashDailyRows);
  console.log("[seed-full] Created", cashTxnRows.length, "cash txns,", cashDailyRows.length, "cash daily rows");

  // ── 86. Ops & Events ─────────────────────────────────────────────────────
  await seedOpsEvents({
    tenantId: tenant.id,
    adminUserId: adminUser.id,
    fixtureManagerUserId: managerUser.id,
    branchRecords,
    departmentRecords,
    insertedUsers,
    insertedEmployees: activeEmps,
    startDate: START_DATE,
  });

  // ── Done ──────────────────────────────────────────────────────────────────
  console.log("[seed-full] Done.");
  console.log(`  Tenant:      1`);
  console.log(`  Operator:    1 (Oto)`);
  console.log(`  Branches:    ${branchRecords.length}`);
  console.log(`  Departments: ${departmentRecords.length}`);
  console.log(`  Users:       ${insertedUsers.length + 1} (including fixture admin)`);
  console.log(`  People:      ${insertedPeople.length} (${advisorPeople.length} advisors, ${totalEmployees} employees)`);
  console.log(`  Employees:   ${totalEmployees}`);
  console.log(`  Roles:       ${roleRecords.length}`);
}

seed()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("[seed-full] Fatal error:", err);
    process.exit(1);
  });
