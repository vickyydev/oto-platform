/**
 * Ops & Events seed data for the full seed.
 *
 * Populates:
 *   - Ops:    locations, checklist templates + items + runs, task templates + tasks
 *             + assignments + activities, announcements
 *   - Events: event statuses, core events (birthday + studio), studio event details,
 *             studio event tasks, BEO locations, BEO entertainment options,
 *             BEO setup item options, BEO setup plans, BEO kitchen plans,
 *             BEO event billing, BEO timeline items, event line items
 *
 * Called from main.ts after the core data has been created.
 * Receives a startDate (the Monday of the current/target week) so all relative
 * dates are anchored to that week and next week.
 */

import { faker } from "@faker-js/faker";
import { db } from "../../server/db";
import {
  locations,
  locationBranchAccess,
  checklistTemplates,
  checklistTemplateItems,
  checklistRuns,
  checklistRunItems,
  taskTemplates,
  tasks,
  taskAssignments,
  taskActivities,
  announcements,
  coreEvents,
  eventStatuses,
  studioEventDetails,
  studioEventTasks,
  beoLocations,
  beoEntertainmentOptions,
  beoSetupItemOptions,
  beoSetupPlans,
  beoKitchenPlans,
  beoEventBilling,
  beoTimelineItems,
  eventLineItemTemplates,
  eventLineItems,
  campRegistrations,
  campAttendance,
} from "../../server/db/coreSchema";

// ── helpers ───────────────────────────────────────────────────────────────────

function pick<T>(arr: T[]): T {
  return arr[faker.number.int({ min: 0, max: arr.length - 1 })];
}

/** Return YYYY-MM-DD string for startDate + offsetDays. */
function dateStr(startDate: Date, offsetDays: number): string {
  const d = new Date(startDate);
  d.setDate(d.getDate() + offsetDays);
  return d.toISOString().slice(0, 10);
}

/** Return a Date for startDate + offsetDays at a given HH:MM. */
function dateAt(startDate: Date, offsetDays: number, hh: number, mm = 0): Date {
  const d = new Date(startDate);
  d.setDate(d.getDate() + offsetDays);
  d.setHours(hh, mm, 0, 0);
  return d;
}

// ── types matching what main.ts passes in ─────────────────────────────────────

interface SeedContext {
  tenantId: string;
  adminUserId: string;
  fixtureManagerUserId: string;
  branchRecords: { id: string; name: string }[];
  departmentRecords: { id: string; name: string }[];
  insertedUsers: { id: string; role: string }[];
  insertedEmployees: { id: string; branchId: string | null }[];
  startDate: Date; // Monday of the seed week
}

// ─────────────────────────────────────────────────────────────────────────────

export async function seedOpsEvents(ctx: SeedContext): Promise<void> {
  const { tenantId, adminUserId, fixtureManagerUserId, branchRecords, departmentRecords, insertedUsers, insertedEmployees, startDate } = ctx;

  const managerUsers = insertedUsers.filter(u => u.role === "manager" || u.role === "admin");

  // ── OPS ───────────────────────────────────────────────────────────────────

  // ── O1. Locations ─────────────────────────────────────────────────────────
  const LOCATION_DEFS = [
    { name: "Main Floor",      description: "Primary play area" },
    { name: "Café Area",       description: "Café and seating for parents" },
    { name: "Party Room A",    description: "Private birthday party room" },
    { name: "Party Room B",    description: "Second private party room" },
    { name: "Entrance / Lobby", description: "Reception and check-in area" },
    { name: "Toilets",         description: "Restrooms on main floor" },
    { name: "Kitchen",         description: "Food preparation area" },
    { name: "Storage Room",    description: "Equipment and supplies storage" },
  ];

  const locationRecords = await db.insert(locations).values(
    LOCATION_DEFS.map((l, i) => ({
      tenantId,
      name: l.name,
      description: l.description,
      isActive: true,
      sortOrder: i,
    }))
  ).returning();

  // Each location accessible to all branches
  const locBranchRows = locationRecords.flatMap(loc =>
    branchRecords.map(branch => ({ locationId: loc.id, branchId: branch.id }))
  );
  await db.insert(locationBranchAccess).values(locBranchRows);
  console.log("[seed-full/ops-events] Created", locationRecords.length, "locations");

  // ── O2. Checklist Templates ───────────────────────────────────────────────
  const CHECKLIST_TEMPLATE_DEFS = [
    {
      name: "Opening Checklist",
      description: "Daily opening tasks for all floor staff",
      recurrence: "daily" as const,
      scheduledTime: "08:00",
      items: [
        { title: "Unlock main entrance and disable alarm", isCritical: true },
        { title: "Turn on all lighting and AC zones" },
        { title: "Inspect play equipment for damage or hazards", isCritical: true },
        { title: "Wipe down high-touch surfaces (rails, tables, kiosk screens)" },
        { title: "Check café stock levels and restock if needed" },
        { title: "Ensure all hand-sanitiser stations are filled" },
        { title: "Test kiosk screens and point-of-sale terminals" },
        { title: "Brief the floor team on the day's events and bookings" },
      ],
    },
    {
      name: "Closing Checklist",
      description: "End-of-day closing tasks",
      recurrence: "daily" as const,
      scheduledTime: "21:00",
      items: [
        { title: "Ensure all guests have exited the venue" },
        { title: "Close out POS terminals and reconcile cash drawer", isCritical: true },
        { title: "Wipe down and sanitise all play equipment" },
        { title: "Sweep and mop main floor" },
        { title: "Take out rubbish and replace bin liners" },
        { title: "Turn off non-essential lighting and AC" },
        { title: "Arm alarm and lock main entrance", isCritical: true },
        { title: "Submit daily summary report to manager" },
      ],
    },
    {
      name: "Party Room Turnover",
      description: "Between-party room reset checklist",
      recurrence: "once" as const,
      items: [
        { title: "Clear all decorations and disposables left by previous party" },
        { title: "Wipe tables, chairs, and surfaces" },
        { title: "Vacuum or sweep floor" },
        { title: "Set up table layout per booking sheet" },
        { title: "Arrange balloons and decorations per theme" },
        { title: "Place party supplies (plates, cups, napkins) on table" },
        { title: "Check AV equipment (music, display screen)" },
        { title: "Confirm cake area and fridge space is ready" },
      ],
    },
    {
      name: "Weekly Deep Clean",
      description: "Full venue deep clean every Monday morning before opening",
      recurrence: "weekly" as const,
      weeklyDays: ["1"],
      scheduledTime: "07:00",
      items: [
        { title: "Deep clean all soft play foam equipment with approved sanitiser", isCritical: true },
        { title: "Wash all ball-pit balls in batches" },
        { title: "Clean behind and underneath all fixed equipment" },
        { title: "Descale café equipment (coffee machine, dishwasher)" },
        { title: "Clean grease traps and kitchen drains" },
        { title: "Wipe all walls, mirrors, and glass panels" },
        { title: "Inspect and replace worn or damaged play components", requiresNote: true },
        { title: "Steam-clean party room carpets and upholstery" },
      ],
    },
    {
      name: "Café Pre-Service Setup",
      description: "Café preparation before doors open",
      recurrence: "daily" as const,
      scheduledTime: "08:30",
      items: [
        { title: "Brew initial batch of coffee and check machine temperature" },
        { title: "Prepare and label food display items" },
        { title: "Stock fridge with drinks and check expiry dates" },
        { title: "Set up condiments, sugars, and napkin holders" },
        { title: "Test POS terminal and confirm menu prices are correct" },
      ],
    },
  ];

  const checklistTemplateRecords = await db.insert(checklistTemplates).values(
    CHECKLIST_TEMPLATE_DEFS.map(def => ({
      tenantId,
      branchId: branchRecords[0].id,
      branchIds: branchRecords.map(b => b.id),
      name: def.name,
      description: def.description,
      checklistType: "operational" as const,
      isActive: true,
      recurrence: def.recurrence,
      weeklyDays: def.weeklyDays ?? [],
      scheduledTime: def.scheduledTime ?? null,
      createdBy: adminUserId,
    }))
  ).returning();

  // Insert items for each template
  const checklistItemRecords: (typeof checklistTemplateItems.$inferSelect)[] = [];
  for (let ti = 0; ti < CHECKLIST_TEMPLATE_DEFS.length; ti++) {
    const tmpl = checklistTemplateRecords[ti];
    const def = CHECKLIST_TEMPLATE_DEFS[ti];
    const inserted = await db.insert(checklistTemplateItems).values(
      def.items.map((item, idx) => ({
        tenantId,
        templateId: tmpl.id,
        title: item.title,
        isCritical: (item as any).isCritical ?? false,
        requiresNote: (item as any).requiresNote ?? false,
        sortOrder: idx,
      }))
    ).returning();
    checklistItemRecords.push(...inserted);
  }
  console.log("[seed-full/ops-events] Created", checklistTemplateRecords.length, "checklist templates,", checklistItemRecords.length, "items");

  // ── O3. Checklist Runs (this week) ────────────────────────────────────────
  // Opening + Closing for each of the last 3 days, one Party Room Turnover
  const openingTmpl  = checklistTemplateRecords[0];
  const closingTmpl  = checklistTemplateRecords[1];
  const partyTmpl    = checklistTemplateRecords[2];

  const runDefs: { templateId: string; offsetDays: number; status: "completed"|"in_progress"|"pending"; dueHour: number }[] = [];
  for (let d = 0; d < 3; d++) {
    runDefs.push({ templateId: openingTmpl.id, offsetDays: d, status: d < 2 ? "completed" : "in_progress", dueHour: 8 });
    runDefs.push({ templateId: closingTmpl.id, offsetDays: d, status: d < 2 ? "completed" : "pending", dueHour: 21 });
  }
  runDefs.push({ templateId: partyTmpl.id, offsetDays: 1, status: "completed", dueHour: 11 });
  runDefs.push({ templateId: partyTmpl.id, offsetDays: 2, status: "in_progress", dueHour: 14 });

  const checklistRunRecords: (typeof checklistRuns.$inferSelect)[] = [];
  for (const rd of runDefs) {
    const assignedUser = pick(managerUsers);
    const dueAt = dateAt(startDate, rd.offsetDays, rd.dueHour);
    const startedAt = rd.status !== "pending" ? dateAt(startDate, rd.offsetDays, rd.dueHour - 1) : null;
    const completedAt = rd.status === "completed" ? dateAt(startDate, rd.offsetDays, rd.dueHour, 30) : null;
    const runRow = {
      tenantId,
      templateId: rd.templateId,
      branchId: branchRecords[0].id,
      assignedTo: assignedUser.id,
      status: rd.status,
      templateVersionApplied: 1,
      dueAt,
      startedAt,
      completedAt,
    };
    const [run] = await db.insert(checklistRuns).values(runRow as any).returning();
    checklistRunRecords.push(run);
  }

  // Insert run items for each run
  const templateItemsByTemplate = new Map<string, (typeof checklistItemRecords[0])[]>();
  for (const item of checklistItemRecords) {
    const list = templateItemsByTemplate.get(item.templateId) ?? [];
    list.push(item);
    templateItemsByTemplate.set(item.templateId, list);
  }

  for (const run of checklistRunRecords) {
    const tmplItems = templateItemsByTemplate.get(run.templateId) ?? [];
    if (tmplItems.length === 0) continue;
    await db.insert(checklistRunItems).values(
      tmplItems.map(item => {
        const isCompleted = run.status === "completed" || (run.status === "in_progress" && faker.datatype.boolean({ probability: 0.6 }));
        return {
          tenantId,
          runId: run.id,
          templateItemId: item.id,
          isCompleted,
          completedBy: isCompleted ? adminUserId : null,
          completedAt: isCompleted ? run.completedAt ?? run.startedAt : null,
        };
      })
    );
  }
  console.log("[seed-full/ops-events] Created", checklistRunRecords.length, "checklist runs");

  // ── O4. Task Templates ────────────────────────────────────────────────────
  const TASK_TEMPLATE_DEFS = [
    {
      title: "Restock supplies cabinet",
      description: "Check and restock party supplies: plates, cups, napkins, balloons.",
      recurrence: "weekly" as const,
      weeklyDays: ["1"],
      preferredDueTime: "09:00",
      taskLevel: "line" as const,
    },
    {
      title: "Submit weekly maintenance report",
      description: "Document any equipment faults, maintenance done, and items needing follow-up.",
      recurrence: "weekly" as const,
      weeklyDays: ["5"],
      preferredDueTime: "17:00",
      taskLevel: "management" as const,
    },
    {
      title: "Fire safety equipment check",
      description: "Inspect all fire extinguishers, emergency exits, and smoke detectors.",
      recurrence: "monthly" as const,
      monthlyDay: 1,
      preferredDueTime: "10:00",
      taskLevel: "management" as const,
    },
  ];

  const taskTemplateRecords = await db.insert(taskTemplates).values(
    TASK_TEMPLATE_DEFS.map(def => ({
      tenantId,
      title: def.title,
      description: def.description,
      branchScope: "ALL" as const,
      recurrence: def.recurrence,
      weeklyDays: def.weeklyDays ?? [],
      monthlyDay: def.monthlyDay ?? null,
      preferredDueTime: def.preferredDueTime,
      taskLevel: def.taskLevel,
      isActive: true,
      createdBy: adminUserId,
    }))
  ).returning();
  console.log("[seed-full/ops-events] Created", taskTemplateRecords.length, "task templates");

  // ── O5. Tasks ─────────────────────────────────────────────────────────────
  const TASK_DEFS: {
    title: string;
    description: string;
    status: "pending"|"in_progress"|"completed"|"overdue";
    priority: "low"|"medium"|"high"|"critical";
    offsetDays: number;
    dueHour: number;
    taskLevel: "line"|"management"|"strategic";
    branchIdx: number;
    fixtureManager?: boolean;
  }[] = [
    // This week
    { title: "Fix broken safety gate on slide entrance", description: "Latch is bent and needs replacing. Slide is closed until fixed.", status: "in_progress", priority: "critical", offsetDays: 0, dueHour: 12, taskLevel: "line", branchIdx: 0 },
    { title: "Restock party supplies cabinet", description: "Running low on plates, cups, and napkins for Party Room A.", status: "pending", priority: "medium", offsetDays: 1, dueHour: 9, taskLevel: "line", branchIdx: 0 },
    { title: "Replace burnt-out light in Party Room B", description: "Three ceiling lights are out. Electrician scheduled.", status: "completed", priority: "high", offsetDays: 0, dueHour: 11, taskLevel: "line", branchIdx: 0 },
    { title: "Update weekend event board", description: "Post this weekend's birthday schedule on the staff notice board.", status: "completed", priority: "low", offsetDays: 1, dueHour: 8, taskLevel: "line", branchIdx: 0 },
    { title: "Submit weekly maintenance report", description: "Compile all maintenance issues from this week for manager review.", status: "pending", priority: "medium", offsetDays: 4, dueHour: 17, taskLevel: "management", branchIdx: 0, fixtureManager: true },
    { title: "Inspect café refrigeration units", description: "Temperature logging check and clean condenser coils.", status: "in_progress", priority: "high", offsetDays: 2, dueHour: 10, taskLevel: "line", branchIdx: 0 },
    { title: "Top up hand sanitiser stations", description: "All 6 stations on main floor need refilling.", status: "completed", priority: "low", offsetDays: 0, dueHour: 8, taskLevel: "line", branchIdx: 0 },
    { title: "Review party booking confirmations", description: "Check this weekend's bookings are confirmed and staffed correctly.", status: "pending", priority: "high", offsetDays: 3, dueHour: 14, taskLevel: "management", branchIdx: 0, fixtureManager: true },
    // Next week
    { title: "Deep clean ball pit", description: "Full ball wash and foam base sanitisation scheduled for next Monday.", status: "pending", priority: "medium", offsetDays: 7, dueHour: 7, taskLevel: "line", branchIdx: 0 },
    { title: "Monthly fire safety check", description: "Inspect extinguishers, exits, and smoke detectors throughout venue.", status: "pending", priority: "high", offsetDays: 7, dueHour: 10, taskLevel: "management", branchIdx: 0, fixtureManager: true },
    { title: "Restock café dry goods", description: "Coffee beans, sugar, and cup stock running low.", status: "pending", priority: "medium", offsetDays: 8, dueHour: 9, taskLevel: "line", branchIdx: 0 },
    { title: "Staff team briefing — new SOP rollout", description: "Brief all floor staff on updated check-in and drop-off procedures.", status: "pending", priority: "medium", offsetDays: 9, dueHour: 9, taskLevel: "management", branchIdx: 0 },
    // SF branch
    { title: "Check AC units before weekend", description: "Both party room AC units need filter cleaning.", status: "pending", priority: "medium", offsetDays: 3, dueHour: 10, taskLevel: "line", branchIdx: 1 },
    { title: "Prepare weekend staff rota", description: "Confirm shifts and coverage for Saturday and Sunday.", status: "in_progress", priority: "high", offsetDays: 2, dueHour: 16, taskLevel: "management", branchIdx: 1 },
    // Overdue
    { title: "Submit Q1 venue inspection report", description: "Overdue — was due end of last month.", status: "overdue", priority: "high", offsetDays: -7, dueHour: 17, taskLevel: "management", branchIdx: 0 },
  ];

  const taskRecords: (typeof tasks.$inferSelect)[] = [];
  for (const def of TASK_DEFS) {
    const branch = branchRecords[def.branchIdx] ?? branchRecords[0];
    const dept = pick(departmentRecords);
    const assignee = def.fixtureManager ? { id: fixtureManagerUserId } : pick(managerUsers);
    const dueAt = dateAt(startDate, def.offsetDays, def.dueHour);
    const completedAt = def.status === "completed" ? dateAt(startDate, def.offsetDays, def.dueHour + 1) : null;
    const taskRow = {
      tenantId,
      branchId: branch.id,
      departmentId: dept.id,
      title: def.title,
      description: def.description,
      status: def.status,
      priority: def.priority,
      recurrence: "once" as const,
      taskLevel: def.taskLevel,
      dueAt,
      completedAt,
      assignedTo: assignee.id,
      createdBy: adminUserId,
      ownerUserId: assignee.id,
      lastMovementAt: dueAt,
    };
    const [task] = await db.insert(tasks).values(taskRow as any).returning();
    taskRecords.push(task);
  }
  console.log("[seed-full/ops-events] Created", taskRecords.length, "tasks");

  // ── O6. Task Assignments ──────────────────────────────────────────────────
  // Pick a real employee for each task assignment
  const taskAssignmentRows = taskRecords.map(task => {
    const branchEmps = insertedEmployees.filter(e => e.branchId === task.branchId);
    const emp = branchEmps.length > 0 ? pick(branchEmps) : pick(insertedEmployees);
    return {
      tenantId,
      taskId: task.id,
      assignmentType: "employee" as const,
      assignmentId: emp.id,
    };
  });
  await db.insert(taskAssignments).values(taskAssignmentRows);

  // ── O7. Task Activities ───────────────────────────────────────────────────
  const activityRows: Record<string, unknown>[] = [];
  for (const task of taskRecords) {
    activityRows.push({
      tenantId,
      taskId: task.id,
      activityType: "created" as const,
      description: `Task created`,
      userId: adminUserId,
    });
    if (task.status === "in_progress") {
      activityRows.push({
        tenantId,
        taskId: task.id,
        activityType: "status_changed" as const,
        description: `Status changed to in_progress`,
        userId: task.assignedTo ?? adminUserId,
      });
    }
    if (task.status === "completed") {
      activityRows.push({
        tenantId,
        taskId: task.id,
        activityType: "completed" as const,
        description: `Task marked as completed`,
        userId: task.assignedTo ?? adminUserId,
      });
    }
  }
  await db.insert(taskActivities).values(activityRows as any);
  console.log("[seed-full/ops-events] Created", activityRows.length, "task activities");

  // ── O8. Announcements ─────────────────────────────────────────────────────
  const announcementDefs = [
    {
      title: "Long Weekend Hours — Reminder",
      body: "Please note we are operating extended hours this long weekend. Check the rota for your shift times. Additional part-time staff will be on floor both days.",
      priority: "info" as const,
      offsetStart: 0,
      offsetEnd: 14,
    },
    {
      title: "New SOP: Check-in Procedure Update",
      body: "Effective from next Monday, all guests must check in via the new kiosk system. Staff should direct parents to the kiosk on arrival. Full walkthrough at Monday morning briefing.",
      priority: "warning" as const,
      offsetStart: 0,
      offsetEnd: 21,
    },
    {
      title: "Maintenance: Party Room B AC offline",
      body: "Party Room B air conditioning is offline for repairs until Thursday. Events in that room have been moved to Room A where possible. Affected families have been notified.",
      priority: "urgent" as const,
      offsetStart: 0,
      offsetEnd: 4,
    },
    {
      title: "Staff Appreciation Week — Next Week",
      body: "Next week is Staff Appreciation Week! Look out for daily surprises from management. Thank you all for your hard work this quarter.",
      priority: "info" as const,
      offsetStart: 7,
      offsetEnd: 14,
    },
  ];

  await db.insert(announcements).values(
    announcementDefs.map(def => ({
      tenantId,
      title: def.title,
      body: def.body,
      priority: def.priority,
      startDate: dateAt(startDate, def.offsetStart, 0),
      endDate: dateAt(startDate, def.offsetEnd, 23, 59),
      showToEveryone: true,
      isActive: true,
      createdBy: adminUserId,
    }))
  );
  console.log("[seed-full/ops-events] Created", announcementDefs.length, "announcements");

  // ── EVENTS ────────────────────────────────────────────────────────────────

  // ── E1. Event Statuses ────────────────────────────────────────────────────
  const EVENT_STATUS_DEFS = [
    { name: "Upcoming",    value: "upcoming",    color: "blue",   sortOrder: 0, isDefault: true },
    { name: "In Progress", value: "in_progress", color: "yellow", sortOrder: 1 },
    { name: "Completed",   value: "completed",   color: "green",  sortOrder: 2 },
    { name: "Cancelled",   value: "cancelled",   color: "red",    sortOrder: 3 },
  ];

  await db.insert(eventStatuses).values(
    EVENT_STATUS_DEFS.map(s => ({ tenantId, ...s }))
  );
  console.log("[seed-full/ops-events] Created", EVENT_STATUS_DEFS.length, "event statuses");

  // ── E2. BEO Locations ─────────────────────────────────────────────────────
  const BEO_LOCATION_DEFS = [
    { name: "Party Room A", capacity: 30, description: "Main private party room with stage area" },
    { name: "Party Room B", capacity: 20, description: "Smaller party room, suitable for intimate events" },
    { name: "Main Floor",   capacity: 80, description: "Open play area, available for large group events" },
    { name: "Rooftop Terrace", capacity: 40, description: "Outdoor terrace, available evenings only" },
  ];

  const beoLocationRecords = await db.insert(beoLocations).values(
    BEO_LOCATION_DEFS.map((l, i) => ({
      tenantId,
      branchId: branchRecords[0].id,
      branchIds: branchRecords.map(b => b.id),
      name: l.name,
      capacity: l.capacity,
      description: l.description,
      isActive: true,
      sortOrder: i,
    }))
  ).returning();
  console.log("[seed-full/ops-events] Created", beoLocationRecords.length, "BEO locations");

  // ── E3. BEO Entertainment Options ────────────────────────────────────────
  const BEO_ENT_DEFS = [
    { name: "Mascot Appearance", defaultDurationMinutes: 30, notes: "Character costume appearance + photos" },
    { name: "Face Painting",     defaultDurationMinutes: 60, notes: "One artist, up to 20 kids" },
    { name: "Game Leader",       defaultDurationMinutes: 45, notes: "Hosted party games on main floor" },
    { name: "Magic Show",        defaultDurationMinutes: 30, notes: "External performer, requires 3-day notice" },
    { name: "Balloon Twisting",  defaultDurationMinutes: 45, notes: "One artist" },
  ];

  const beoEntOptionRecords = await db.insert(beoEntertainmentOptions).values(
    BEO_ENT_DEFS.map((e, i) => ({
      tenantId,
      name: e.name,
      defaultDurationMinutes: e.defaultDurationMinutes,
      notes: e.notes,
      isActive: true,
      sortOrder: i,
    }))
  ).returning();
  console.log("[seed-full/ops-events] Created", beoEntOptionRecords.length, "BEO entertainment options");

  // ── E4. BEO Setup Item Options ────────────────────────────────────────────
  const BEO_SETUP_DEFS = [
    { name: "Balloon Arch",       category: "Decorations", defaultCost: 800 },
    { name: "Backdrop Banner",    category: "Decorations", defaultCost: 500 },
    { name: "Table Layout (round)", category: "Furniture", defaultCost: 0 },
    { name: "High Chair",         category: "Furniture",   defaultCost: 0 },
    { name: "Projector + Screen", category: "AV",          defaultCost: 500 },
    { name: "Party Favours Bags", category: "Party Supplies", defaultCost: 200 },
  ];

  await db.insert(beoSetupItemOptions).values(
    BEO_SETUP_DEFS.map((s, i) => ({
      tenantId,
      name: s.name,
      category: s.category,
      defaultCost: s.defaultCost,
      isActive: true,
      sortOrder: i,
    }))
  );
  console.log("[seed-full/ops-events] Created", BEO_SETUP_DEFS.length, "BEO setup item options");

  // ── E5. Event Line Item Templates ────────────────────────────────────────
  const LINE_ITEM_TEMPLATE_DEFS = [
    { name: "Basic Birthday Package",   category: "PACKAGE" as const,       defaultUnitPriceIncVat: 3500, isIncludedByDefault: true },
    { name: "Premium Birthday Package", category: "PACKAGE" as const,       defaultUnitPriceIncVat: 5500, isIncludedByDefault: false },
    { name: "Face Painting Add-on",     category: "ENTERTAINMENT" as const, defaultUnitPriceIncVat: 1200, isIncludedByDefault: false },
    { name: "Mascot Appearance",        category: "ENTERTAINMENT" as const, defaultUnitPriceIncVat: 1500, isIncludedByDefault: false },
    { name: "Kids Lunch Set",           category: "FOOD" as const,          defaultUnitPriceIncVat: 280,  isIncludedByDefault: false },
    { name: "Adult Snack Platter",      category: "FOOD" as const,          defaultUnitPriceIncVat: 450,  isIncludedByDefault: false },
    { name: "Balloon Arch Decoration",  category: "ADD_ON" as const,        defaultUnitPriceIncVat: 800,  isIncludedByDefault: false },
    { name: "Extra Hour",               category: "SERVICE" as const,       defaultUnitPriceIncVat: 500,  isIncludedByDefault: false },
  ];

  const lineItemTemplateRecords = await db.insert(eventLineItemTemplates).values(
    LINE_ITEM_TEMPLATE_DEFS.map(t => ({
      tenantId,
      name: t.name,
      category: t.category,
      defaultUnitPriceIncVat: t.defaultUnitPriceIncVat,
      defaultQty: 1,
      isIncludedByDefault: t.isIncludedByDefault,
      isActive: true,
      createdByUserId: pick(managerUsers).id,
      updatedByUserId: pick(managerUsers).id,
    }))
  ).returning();
  console.log("[seed-full/ops-events] Created", lineItemTemplateRecords.length, "event line item templates");

  // ── E6. Core Events ───────────────────────────────────────────────────────
  // A mix of birthday parties and studio events spread over this week and next.
  // Each branch gets events. Statuses reflect the position relative to startDate.

  type EventDef = {
    title: string;
    eventType: "birthday"|"studio_event"|"private_event";
    offsetDays: number;
    startTime: string;
    endTime: string;
    status: string;
    childName?: string;
    bookingName: string;
    numChildren?: number;
    numAdults?: number;
    totalValue?: number;
    prepaymentAmount?: number;
    specialRequests?: string;
    branchIdx: number;
    isStudio?: boolean;
  };

  const EVENT_DEFS: EventDef[] = [
    // This week — Bangkok
    { title: "Sophia's 5th Birthday Party",    eventType: "birthday",      offsetDays: 0, startTime: "10:00", endTime: "12:00", status: "completed",   childName: "Sophia",   bookingName: "Wanchai Family",   numChildren: 15, numAdults: 10, totalValue: 5500, prepaymentAmount: 2000, branchIdx: 0 },
    { title: "Liam's Birthday Bash",           eventType: "birthday",      offsetDays: 1, startTime: "13:00", endTime: "15:00", status: "completed",   childName: "Liam",     bookingName: "Johnson Family",   numChildren: 12, numAdults: 8,  totalValue: 3500, prepaymentAmount: 1500, branchIdx: 0 },
    { title: "Mia's Princess Party",           eventType: "birthday",      offsetDays: 2, startTime: "11:00", endTime: "13:00", status: "in_progress", childName: "Mia",      bookingName: "Nakamura Family",  numChildren: 18, numAdults: 12, totalValue: 5500, prepaymentAmount: 2500, specialRequests: "No nuts in food, balloon arch in pink and gold", branchIdx: 0 },
    { title: "Noah's Superhero Party",         eventType: "birthday",      offsetDays: 3, startTime: "10:00", endTime: "12:30", status: "upcoming",    childName: "Noah",     bookingName: "Smith Family",     numChildren: 20, numAdults: 15, totalValue: 6200, prepaymentAmount: 2000, branchIdx: 0 },
    { title: "Ella's Unicorn Celebration",     eventType: "birthday",      offsetDays: 4, startTime: "14:00", endTime: "16:00", status: "upcoming",    childName: "Ella",     bookingName: "Thompson Family",  numChildren: 16, numAdults: 10, totalValue: 5500, prepaymentAmount: 2500, branchIdx: 0 },
    { title: "Kids Yoga & Wellness Workshop",  eventType: "studio_event",  offsetDays: 2, startTime: "09:00", endTime: "11:00", status: "in_progress", bookingName: "Studio",                                   numChildren: 10, numAdults: 5,  totalValue: 2000, branchIdx: 0, isStudio: true },
    { title: "Saturday Open Play Session",     eventType: "private_event", offsetDays: 5, startTime: "10:00", endTime: "18:00", status: "upcoming",    bookingName: "Walk-ins",                                 numChildren: 40, numAdults: 30, totalValue: 0, branchIdx: 0 },
    // Next week — Bangkok
    { title: "Oliver's Space Adventure Party", eventType: "birthday",      offsetDays: 7, startTime: "10:00", endTime: "12:00", status: "upcoming",    childName: "Oliver",   bookingName: "Patel Family",     numChildren: 14, numAdults: 9,  totalValue: 3500, prepaymentAmount: 1500, branchIdx: 0 },
    { title: "Ava's Fairy Tale Party",         eventType: "birthday",      offsetDays: 8, startTime: "13:00", endTime: "15:00", status: "upcoming",    childName: "Ava",      bookingName: "Garcia Family",    numChildren: 22, numAdults: 14, totalValue: 5500, prepaymentAmount: 2000, specialRequests: "Dairy-free cake option needed", branchIdx: 0 },
    { title: "Mini Chefs Cooking Class",       eventType: "studio_event",  offsetDays: 9, startTime: "10:00", endTime: "12:00", status: "upcoming",    bookingName: "Studio",                                   numChildren: 8,  numAdults: 4,  totalValue: 2400, branchIdx: 0, isStudio: true },
    { title: "Jack's Dinosaur Party",          eventType: "birthday",      offsetDays: 10, startTime: "11:00", endTime: "13:00", status: "upcoming",   childName: "Jack",     bookingName: "Wilson Family",    numChildren: 16, numAdults: 10, totalValue: 5500, prepaymentAmount: 2000, branchIdx: 0 },
    { title: "Weekend Birthday Marathon",      eventType: "birthday",      offsetDays: 12, startTime: "10:00", endTime: "12:00", status: "upcoming",   childName: "Lily",     bookingName: "Brown Family",     numChildren: 18, numAdults: 12, totalValue: 5500, prepaymentAmount: 1500, branchIdx: 0 },
    // SF branch
    { title: "Ethan's Birthday Extravaganza",  eventType: "birthday",      offsetDays: 1, startTime: "11:00", endTime: "13:00", status: "completed",   childName: "Ethan",    bookingName: "Miller Family",    numChildren: 20, numAdults: 14, totalValue: 5500, prepaymentAmount: 2500, branchIdx: 1 },
    { title: "Isabella's Party",               eventType: "birthday",      offsetDays: 3, startTime: "14:00", endTime: "16:00", status: "upcoming",    childName: "Isabella", bookingName: "Davis Family",     numChildren: 15, numAdults: 10, totalValue: 3500, prepaymentAmount: 1500, branchIdx: 1 },
    { title: "Storytelling & Art Session",     eventType: "studio_event",  offsetDays: 8, startTime: "10:00", endTime: "11:30", status: "upcoming",    bookingName: "Studio",                                   numChildren: 12, numAdults: 6,  totalValue: 1800, branchIdx: 1, isStudio: true },
    { title: "Lucas's Adventure Party",        eventType: "birthday",      offsetDays: 9, startTime: "13:00", endTime: "15:00", status: "upcoming",    childName: "Lucas",    bookingName: "Martinez Family",  numChildren: 18, numAdults: 12, totalValue: 5500, prepaymentAmount: 2000, branchIdx: 1 },
    // Cancelled
    { title: "Emma's Cancelled Party",         eventType: "birthday",      offsetDays: 4, startTime: "10:00", endTime: "12:00", status: "cancelled",   childName: "Emma",     bookingName: "Anderson Family",  numChildren: 15, numAdults: 8,  totalValue: 3500, prepaymentAmount: 1000, specialRequests: "Cancelled by family", branchIdx: 0 },
  ];

  const coreEventRecords: (typeof coreEvents.$inferSelect)[] = [];
  for (const def of EVENT_DEFS) {
    const branch = branchRecords[def.branchIdx] ?? branchRecords[0];
    const beoLoc = pick(beoLocationRecords);
    const evtRow = {
      tenantId,
      branchId: branch.id,
      locationId: beoLoc.id,
      eventType: def.eventType,
      title: def.title,
      eventDate: dateStr(startDate, def.offsetDays),
      startTime: def.startTime,
      endTime: def.endTime,
      durationMinutes: (() => {
        const [sh, sm] = def.startTime.split(":").map(Number);
        const [eh, em] = def.endTime.split(":").map(Number);
        return (eh * 60 + em) - (sh * 60 + sm);
      })(),
      childName: def.childName ?? null,
      bookingName: def.bookingName,
      numChildren: def.numChildren ?? null,
      numAdults: def.numAdults ?? null,
      totalValue: def.totalValue ?? null,
      prepaymentAmount: def.prepaymentAmount ?? null,
      specialRequests: def.specialRequests ?? null,
      status: def.status,
      isArchived: false,
      createdByUserId: pick(managerUsers).id,
      updatedByUserId: pick(managerUsers).id,
    };
    const [evt] = await db.insert(coreEvents).values(evtRow as any).returning();
    coreEventRecords.push(evt);
  }
  const manualTestCampDate = dateStr(startDate, 0);
  const [manualTestCamp] = await db.insert(coreEvents).values({
    tenantId,
    branchId: branchRecords[0].id,
    eventType: "camp",
    title: "Manual Test Camp - Today",
    eventDate: manualTestCampDate,
    campEndDate: dateStr(startDate, 6),
    startTime: "09:00",
    endTime: "15:00",
    durationMinutes: 360,
    numChildren: 12,
    status: "confirmed",
    isArchived: false,
    createdByUserId: pick(managerUsers).id,
    updatedByUserId: pick(managerUsers).id,
  } as any).returning();
  const todayOffset = (new Date().getDay() + 6) % 7;
  const todayCampDate = dateStr(startDate, todayOffset);
  const [camperOne, camperTwo] = await db.insert(campRegistrations).values([
    {
      tenantId,
      eventId: manualTestCamp.id,
      childFullName: "Manual Test Camper One",
      dateOfBirth: "2018-03-12",
      parentGuardianName: "Manual Test Parent One",
      emergencyContactNumber: "+66810000001",
      attendanceDays: [manualTestCampDate],
      agreedCampRules: true,
      agreedChildHealthy: true,
      agreedCampRulesDate: dateAt(startDate, -30, 12),
      agreedCampRulesHistory: [dateAt(startDate, -30, 12).toISOString()],
      parentSignature: "Manual Test Parent One",
      signatureDate: manualTestCampDate,
    },
    {
      tenantId,
      eventId: manualTestCamp.id,
      childFullName: "Manual Test Camper Two",
      dateOfBirth: "2017-09-24",
      parentGuardianName: "Manual Test Parent Two",
      emergencyContactNumber: "+66810000002",
      attendanceDays: [todayCampDate],
      agreedCampRules: true,
      agreedChildHealthy: true,
      agreedCampRulesDate: dateAt(startDate, -14, 12),
      agreedCampRulesHistory: [dateAt(startDate, -14, 12).toISOString()],
      parentSignature: "Manual Test Parent Two",
      signatureDate: manualTestCampDate,
    },
  ]).returning();

  await db.insert(campAttendance).values([
    {
      campRegistrationId: camperOne.id,
      tenantId,
      eventId: manualTestCamp.id,
      attendanceDate: manualTestCampDate,
      status: "checked_out",
      checkedInAt: dateAt(startDate, 0, 9, 12),
      checkedInBy: "Full Seed Reception",
      checkedOutAt: dateAt(startDate, 0, 15, 18),
      checkedOutBy: "Full Seed Reception",
      paymentMethod: "Prepaid",
      dropOffPerson: "Manual Test Parent One",
      pickUpPerson: "Manual Test Grandparent",
      staffNotes: "Enjoyed the art activity.",
    },
    {
      campRegistrationId: camperTwo.id,
      tenantId,
      eventId: manualTestCamp.id,
      attendanceDate: todayCampDate,
      status: "checked_in",
      checkedInAt: dateAt(startDate, todayOffset, 9, 25),
      checkedInBy: "Full Seed Reception",
      paymentMethod: "Card",
      dropOffPerson: "Manual Test Parent Two",
      staffNotes: "Has sunscreen in their bag.",
    },
  ]);

  console.log("[seed-full/ops-events] Created", coreEventRecords.length, "core events, 2 camp registrations, and seeded attendance history for manual testing");

  // ── E7. Studio Event Details ──────────────────────────────────────────────
  const studioEvents = coreEventRecords.filter((_, i) => EVENT_DEFS[i].isStudio);
  if (studioEvents.length > 0) {
    await db.insert(studioEventDetails).values(
      studioEvents.map(evt => ({
        eventId: evt.id,
        concept: "Creative kids workshop",
        fnbDetails: "Light snacks and juice boxes provided",
        notes: "Participants should wear comfortable clothes",
        studioStatus: evt.status === "completed" ? "completed" as const : evt.status === "cancelled" ? "cancelled" as const : "published" as const,
      }))
    );

    // Studio event tasks for each studio event
    const studioTaskDefs = [
      { title: "Confirm materials and props are ready", status: "done" as const, offsetHours: -24 },
      { title: "Brief facilitator on session plan",     status: "done" as const, offsetHours: -2  },
      { title: "Set up room layout and activity stations", status: "doing" as const, offsetHours: -1 },
      { title: "Post-session cleanup and report",       status: "todo" as const, offsetHours: 1  },
    ];

    const studioTaskRows = studioEvents.flatMap((evt, ei) =>
      studioTaskDefs.map((t, ti) => ({
        eventId: evt.id,
        title: t.title,
        status: t.status,
        displayOrder: ti,
        assignedToUserId: pick(managerUsers).id,
        completed: t.status === "done",
        completedAt: t.status === "done" ? new Date() : null,
      }))
    );
    await db.insert(studioEventTasks).values(studioTaskRows);
    console.log("[seed-full/ops-events] Created", studioTaskRows.length, "studio event tasks");
  }

  // ── E8. BEO Plans for birthday events ────────────────────────────────────
  const birthdayEvents = coreEventRecords.filter((_, i) => EVENT_DEFS[i].eventType === "birthday");

  // Setup plans
  await db.insert(beoSetupPlans).values(
    birthdayEvents.map(evt => ({
      eventId: evt.id,
      setupRequired: true,
      setupItems: ["Balloon arch", "Backdrop banner", "Table layout"],
      setupNotes: "Setup should be complete 30 minutes before event start time",
      setupDeadlineOffsetMinutes: 30,
      setupChargeMode: "included" as const,
    }))
  );

  // Kitchen plans
  await db.insert(beoKitchenPlans).values(
    birthdayEvents.map((evt, i) => {
      const def = EVENT_DEFS.filter(d => d.eventType === "birthday")[i];
      const [sh, sm] = (def?.startTime || "10:00").split(":").map(Number);
      const cakeMins = sh * 60 + sm + 60;
      const cakeTime = `${String(Math.floor(cakeMins / 60)).padStart(2, "0")}:${String(cakeMins % 60).padStart(2, "0")}`;
      return {
        eventId: evt.id,
        foodRequired: true,
        foodPackageName: "Kids Party Lunch Set",
        cakeMode: "INTERNAL" as const,
        cakeQuantity: 1,
        cakeTime,
        kitchenReadyOffsetMinutes: 20,
        kitchenNotes: "Allergen info from booking sheet must be shared with kitchen",
      };
    })
  );

  // Billing
  await db.insert(beoEventBilling).values(
    birthdayEvents.map(evt => {
      const evtDef = EVENT_DEFS[coreEventRecords.indexOf(evt)];
      const total = evtDef?.totalValue ?? 3500;
      const deposit = evtDef?.prepaymentAmount ?? 0;
      return {
        eventId: evt.id,
        packagePrice: total,
        totalCalculated: total,
        depositRequired: deposit > 0,
        depositAmount: deposit > 0 ? deposit : null,
        depositPaid: deposit > 0,
        depositPaidAmount: deposit > 0 ? deposit : null,
        depositPaymentMethod: deposit > 0 ? "TRANSFER" as const : null,
      };
    })
  );

  // Timeline items for birthday events
  const TIMELINE_DEFS = [
    { label: "Guests arrive & free play",  offsetFromStartMinutes: 0,   assignedToType: "PARTY_HOST" as const },
    { label: "Structured games begin",     offsetFromStartMinutes: 20,  assignedToType: "PARTY_HOST" as const },
    { label: "Entertainment (if booked)",  offsetFromStartMinutes: 50,  assignedToType: "ENTERTAINMENT" as const },
    { label: "Food service",               offsetFromStartMinutes: 70,  assignedToType: "KITCHEN_RESPONSIBLE" as const },
    { label: "Cake cutting & singing",     offsetFromStartMinutes: 90,  assignedToType: "PARTY_HOST" as const },
    { label: "Party bags & farewell",      offsetFromStartMinutes: 110, assignedToType: "PARTY_HOST" as const },
  ];

  const timelineRows = birthdayEvents.flatMap(evt =>
    TIMELINE_DEFS.map((t, i) => ({
      eventId: evt.id,
      sortOrder: i,
      label: t.label,
      offsetFromStartMinutes: t.offsetFromStartMinutes,
      assignedToType: t.assignedToType,
      isSystemGenerated: true,
      isCompleted: evt.status === "completed",
      completedAt: evt.status === "completed" ? new Date() : null,
    }))
  );
  await db.insert(beoTimelineItems).values(timelineRows);
  console.log("[seed-full/ops-events] Created", timelineRows.length, "BEO timeline items");

  // ── E9. Event Line Items for birthday events ──────────────────────────────
  const packageTmpl = lineItemTemplateRecords.find(t => t.name === "Basic Birthday Package")!;
  const premiumTmpl = lineItemTemplateRecords.find(t => t.name === "Premium Birthday Package")!;
  const facePaintTmpl = lineItemTemplateRecords.find(t => t.name === "Face Painting Add-on")!;
  const lunchTmpl = lineItemTemplateRecords.find(t => t.name === "Kids Lunch Set")!;

  const lineItemRows = birthdayEvents.flatMap((evt, i) => {
    const isPremium = (evt.totalValue ?? 0) >= 5000;
    const rows: Record<string, unknown>[] = [
      {
        eventId: evt.id,
        templateId: isPremium ? premiumTmpl.id : packageTmpl.id,
        name: isPremium ? "Premium Birthday Package" : "Basic Birthday Package",
        category: "PACKAGE" as const,
        qty: 1,
        unitPriceIncVat: isPremium ? 5500 : 3500,
        isIncluded: true,
        sortOrder: 0,
        createdByUserId: adminUserId,
        updatedByUserId: adminUserId,
      },
    ];
    if (isPremium && i % 2 === 0) {
      rows.push({
        eventId: evt.id,
        templateId: facePaintTmpl.id,
        name: "Face Painting Add-on",
        category: "ENTERTAINMENT" as const,
        qty: 1,
        unitPriceIncVat: 1200,
        isIncluded: false,
        sortOrder: 1,
        createdByUserId: adminUserId,
        updatedByUserId: adminUserId,
      });
    }
    if (evt.numChildren && evt.numChildren > 0) {
      rows.push({
        eventId: evt.id,
        templateId: lunchTmpl.id,
        name: "Kids Lunch Set",
        category: "FOOD" as const,
        qty: evt.numChildren,
        unitPriceIncVat: 280,
        isIncluded: false,
        sortOrder: rows.length,
        createdByUserId: adminUserId,
        updatedByUserId: adminUserId,
      });
    }
    return rows;
  });
  await db.insert(eventLineItems).values(lineItemRows as any);
  console.log("[seed-full/ops-events] Created", lineItemRows.length, "event line items");

  console.log("[seed-full/ops-events] Done.");
}
