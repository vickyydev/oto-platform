/**
 * Minimal seed for documentation screenshots.
 * Grows incrementally as each feature is documented.
 *
 * Usage: script/db-reset.sh minimal
 */

import { db } from "../../server/db";
import {
        tenants, operators, branches, departments, departmentBranchAssignments,
        employees, users, userBranchAccess, templates, templateAssignments,
        roles, employeeRoles, scheduleWeekPlans, scheduleShiftRows, scheduleAssignments,
        employeeTimeOff, employeePresence, DEFAULT_TENANT_SLUG, timeEvents,
        shiftGroups, scheduleShiftRowRoles,
} from "../../shared/schema";
import {
        checklistTemplates, checklistTemplateItems, serviceCheckins, nannyReservations,
        coreEvents, beoPartyHostAssignments, beoEventBilling,
        birthdayPackageTemplates, packageLineItemTemplates, beoPackageSnapshots, beoPackageSnapshotItems,
        beoLocations, beoSetupPlans, beoKitchenPlans, beoTimelineItems,
        entertainmentPackageTemplates, beoEntertainmentSelections
} from "../../server/db/coreSchema";
import { sql } from "drizzle-orm";
import { hashPassword } from "../../server/auth";
import seedUsers from "../../fixtures/users.json" with { type: "json" };

function mondayOfWeek(date: Date): string {
        const d = new Date(date);
        const day = d.getDay();
        const diff = d.getDate() - day + (day === 0 ? -6 : 1);
        d.setDate(diff);
        return d.toISOString().split("T")[0];
}

function dateStr(offsetDays: number): string {
        const d = new Date();
        d.setDate(d.getDate() + offsetDays);
        return d.toISOString().split("T")[0];
}

async function seed() {
        console.log("[seed-minimal] Starting...");

        // ── Tenant ──────────────────────────────────────────────────────────
        const [tenant] = await db
                .insert(tenants)
                .values({ name: "Default", slug: DEFAULT_TENANT_SLUG })
                .returning();
        console.log("[seed-minimal] Created tenant:", tenant.id);

        // ── Admin user ──────────────────────────────────────────────────────
        const admin = seedUsers.admin;
        const [adminUser] = await db
                .insert(users)
                .values({
                        email: admin.email,
                        password: await hashPassword(admin.password),
                        fullName: admin.fullName,
                        role: admin.role,
                        mustChangePassword: false,
                        phoneNumber: admin.phoneNumber,
                        phoneE164: admin.phoneE164,
                        phoneVerified: true,
                        phoneVerifiedAt: new Date(),
                })
                .returning();
        console.log("[seed-minimal] Created admin user:", adminUser.email);

        await db.insert(userBranchAccess).values({
                tenantId: tenant.id,
                userId: adminUser.id,
                branchId: null,
                accessScope: "all_branches",
        });

        // ── Operator ────────────────────────────────────────────────────────
        const [operator] = await db
                .insert(operators)
                .values({ tenantId: tenant.id, name: "Default" })
                .returning();
        console.log("[seed-minimal] Created operator:", operator.name);

        // ── Branch ──────────────────────────────────────────────────────────
        const [branch] = await db
                .insert(branches)
                .values({
                        tenantId: tenant.id,
                        operatorId: operator.id,
                        name: "Head Office",
                        address: "1 Main Street",
                        timezone: "Asia/Bangkok",
                })
                .returning();
        console.log("[seed-minimal] Created branch:", branch.name);

        // ── Departments ─────────────────────────────────────────────────────
        const [frontDesk] = await db
                .insert(departments)
                .values({ tenantId: tenant.id, name: "Front Desk" })
                .returning();
        await db.insert(departmentBranchAssignments).values({
                departmentId: frontDesk.id,
                branchId: branch.id,
                assignedBy: adminUser.id,
        });

        const [backOffice] = await db
                .insert(departments)
                .values({ tenantId: tenant.id, name: "Back Office" })
                .returning();
        await db.insert(departmentBranchAssignments).values({
                departmentId: backOffice.id,
                branchId: branch.id,
                assignedBy: adminUser.id,
        });
        console.log("[seed-minimal] Created departments: Front Desk, Back Office");

        // ── Roles ───────────────────────────────────────────────────────────
        const [receptionistRole] = await db
                .insert(roles)
                .values({ tenantId: tenant.id, name: "Receptionist", description: "Handles front desk duties" })
                .returning();
        const [accountantRole] = await db
                .insert(roles)
                .values({ tenantId: tenant.id, name: "Accountant", description: "Manages bookkeeping" })
                .returning();
        const [nannyRole] = await db
                .insert(roles)
                .values({ tenantId: tenant.id, name: "Nanny", description: "Childcare provider" })
                .returning();
        console.log("[seed-minimal] Created roles: Receptionist, Accountant, Nanny");

        // ── Employees ───────────────────────────────────────────────────────
        const [somchai] = await db
                .insert(employees)
                .values({
                        tenantId: tenant.id,
                        fullName: "Somchai Jaidee",
                        nickname: "Chai",
                        email: "somchai@example.com",
                        phone: "+66812345678",
                        branchId: branch.id,
                        primaryDepartmentId: frontDesk.id,
                        status: "active",
                        defaultMergeData: {
                                positionTitle: "Receptionist",
                                monthlySalary: "25000",
                        },
                        startDate: new Date("2026-03-01"),
                })
                .returning();
        await db.insert(employeeRoles).values({
                tenantId: tenant.id,
                employeeId: somchai.id,
                roleId: receptionistRole.id,
                isPrimary: true,
        });
        console.log("[seed-minimal] Created employee:", somchai.fullName);

        const [ploy] = await db
                .insert(employees)
                .values({
                        tenantId: tenant.id,
                        fullName: "Ploy Saetang",
                        nickname: "Ploy",
                        email: "ploy@example.com",
                        phone: "+66898765432",
                        branchId: branch.id,
                        primaryDepartmentId: backOffice.id,
                        status: "active",
                        defaultMergeData: {
                                positionTitle: "Accountant",
                                monthlySalary: "30000",
                        },
                        startDate: new Date("2026-02-15"),
                })
                .returning();
        await db.insert(employeeRoles).values({
                tenantId: tenant.id,
                employeeId: ploy.id,
                roleId: accountantRole.id,
                isPrimary: true,
        });
        console.log("[seed-minimal] Created employee:", ploy.fullName);

        const [nanny1] = await db
                .insert(employees)
                .values({
                        tenantId: tenant.id,
                        fullName: "Anong Maneerat",
                        nickname: "Nong",
                        email: "anong@example.com",
                        phone: "+66823456789",
                        branchId: branch.id,
                        primaryDepartmentId: frontDesk.id,
                        status: "active",
                        defaultMergeData: {
                                positionTitle: "Nanny",
                                monthlySalary: "22000",
                        },
                        startDate: new Date("2026-03-01"),
                })
                .returning();
        await db.insert(employeeRoles).values({
                tenantId: tenant.id,
                employeeId: nanny1.id,
                roleId: nannyRole.id,
                isPrimary: true,
        });
        console.log("[seed-minimal] Created employee:", nanny1.fullName);

        const [nanny2] = await db
                .insert(employees)
                .values({
                        tenantId: tenant.id,
                        fullName: "Malee Thongchai",
                        nickname: "Mali",
                        email: "malee@example.com",
                        phone: "+66834567890",
                        branchId: branch.id,
                        primaryDepartmentId: frontDesk.id,
                        status: "active",
                        defaultMergeData: {
                                positionTitle: "Nanny",
                                monthlySalary: "23000",
                        },
                        startDate: new Date("2026-02-20"),
                })
                .returning();
        await db.insert(employeeRoles).values({
                tenantId: tenant.id,
                employeeId: nanny2.id,
                roleId: nannyRole.id,
                isPrimary: true,
        });
        console.log("[seed-minimal] Created employee:", nanny2.fullName);

        // ── Clock in nannies ────────────────────────────────────────────────
        // Use Bangkok timezone (UTC+7) - create a timestamp that's definitely "today" in Bangkok
        const todayBangkok = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Bangkok' }).format(new Date());
        const now = new Date(todayBangkok + 'T09:00:00+07:00'); // 9 AM Bangkok time
        await db.insert(employeePresence).values([
                {
                        employeeId: nanny1.id,
                        tenantId: tenant.id,
                        isClockedIn: true,
                        currentWorkBranchId: branch.id,
                        lastInAt: now,
                        lastEventAt: now,
                        lastEventType: "in",
                },
                {
                        employeeId: nanny2.id,
                        tenantId: tenant.id,
                        isClockedIn: true,
                        currentWorkBranchId: branch.id,
                        lastInAt: now,
                        lastEventAt: now,
                        lastEventType: "in",
                },
        ]);
        console.log("[seed-minimal] Clocked in nannies:", nanny1.fullName, nanny2.fullName);

        // ── Child check-ins ─────────────────────────────────────────────────
        // Child 1: Registered (waiting to be assigned to nanny)
        const [checkin1] = await db.insert(serviceCheckins).values({
                tenantId: tenant.id,
                branchId: branch.id,
                status: "registered",
                serviceType: "nanny",
                parentFullName: "Sarah Johnson",
                whatsappPhoneRaw: "+66812345001",
                whatsappPhoneE164: "+66812345001",
                childFullName: "Emma Johnson",
                childAge: 4,
                requestedDurationMinutes: 120,
                allergiesMedicalDetails: "No allergies",
                consentSigned: true,
                consentSignedAt: now,
        }).returning();

        // Child 2: Already in park with nanny 1 (times relative to Bangkok 9 AM)
        const twoHoursAgo = new Date(now.getTime() - 2 * 60 * 60 * 1000); // 7 AM Bangkok
        const inOneHour = new Date(now.getTime() + 1 * 60 * 60 * 1000);   // 10 AM Bangkok
        const [checkin2] = await db.insert(serviceCheckins).values({
                tenantId: tenant.id,
                branchId: branch.id,
                status: "in_park",
                serviceType: "nanny",
                parentFullName: "Michael Chen",
                whatsappPhoneRaw: "+66812345002",
                whatsappPhoneE164: "+66812345002",
                childFullName: "Liam Chen",
                childAge: 5,
                requestedDurationMinutes: 180,
                requestedEndAt: inOneHour,
                checkedInAt: twoHoursAgo,
                serviceStartedAt: twoHoursAgo,
                nannyEmployeeId: nanny1.id,
                nannyAssigned: nanny1.fullName,
                nannyAssignedAt: twoHoursAgo,
                consentSigned: true,
                consentSignedAt: twoHoursAgo,
        }).returning();

        // Child 3: Registered for drop-off
        const [checkin3] = await db.insert(serviceCheckins).values({
                tenantId: tenant.id,
                branchId: branch.id,
                status: "registered",
                serviceType: "dropoff",
                parentFullName: "Lisa Wong",
                whatsappPhoneRaw: "+66812345003",
                whatsappPhoneE164: "+66812345003",
                childFullName: "Sophie Wong",
                childAge: 7,
                foodNotesRestrictions: "Vegetarian",
                consentSigned: true,
                consentSignedAt: now,
        }).returning();

        console.log("[seed-minimal] Created 3 check-ins: Emma (registered), Liam (in park with nanny), Sophie (drop-off)");

        // ── Nanny reservation for child in park ────────────────────────────
        const todayDate = new Date().toISOString().split("T")[0];
        const startTimeStr = `${String(twoHoursAgo.getHours()).padStart(2, "0")}:${String(twoHoursAgo.getMinutes()).padStart(2, "0")}`;
        const endTimeStr = `${String(inOneHour.getHours()).padStart(2, "0")}:${String(inOneHour.getMinutes()).padStart(2, "0")}`;
        
        await db.insert(nannyReservations).values({
                tenantId: tenant.id,
                branchId: branch.id,
                nannyEmployeeId: nanny1.id,
                nannyFullName: nanny1.fullName,
                serviceCheckinId: checkin2.id,
                childFullName: "Liam Chen",
                parentFullName: "Michael Chen",
                reservationDate: todayDate,
                startTime: startTimeStr,
                endTime: endTimeStr,
                durationMinutes: 180,
                status: "active",
                reservedByUserId: adminUser.id,
                activatedAt: twoHoursAgo,
        });
        console.log("[seed-minimal] Created active nanny reservation for Liam with", nanny1.fullName);

        // ── Schedule: week plan + shift rows + assignments ──────────────────
        const monday = mondayOfWeek(new Date());
        const [weekPlan] = await db
                .insert(scheduleWeekPlans)
                .values({
                        tenantId: tenant.id,
                        branchId: branch.id,
                        weekStartDate: monday,
                        createdBy: adminUser.id,
                })
                .returning();

        const [defaultShiftGroup] = await db
                .insert(shiftGroups)
                .values({
                        tenantId: tenant.id,
                        branchId: branch.id,
                        name: "General",
                        sortOrder: 0,
                        isActive: true,
                        createdBy: adminUser.id,
                })
                .returning();

        const [dayShift] = await db
                .insert(scheduleShiftRows)
                .values({
                        tenantId: tenant.id,
                        branchId: branch.id,
                        label: "Day Shift",
                        startTime: "09:00",
                        endTime: "17:00",
                        staffRequired: 2,
                        departmentId: frontDesk.id,
                        shiftGroupId: defaultShiftGroup.id,
                        createdBy: adminUser.id,
                })
                .returning();

        const [afternoonShift] = await db
                .insert(scheduleShiftRows)
                .values({
                        tenantId: tenant.id,
                        branchId: branch.id,
                        label: "Afternoon Shift",
                        startTime: "14:00",
                        endTime: "22:00",
                        staffRequired: 1,
                        shiftGroupId: defaultShiftGroup.id,
                        createdBy: adminUser.id,
                })
                .returning();

        // Assign Somchai to the day shift today and tomorrow
        const today = dateStr(0);
        const tomorrow = dateStr(1);
        for (const d of [today, tomorrow]) {
                await db.insert(scheduleAssignments).values({
                        tenantId: tenant.id,
                        weekPlanId: weekPlan.id,
                        shiftRowId: dayShift.id,
                        shiftDate: d,
                        assigneeType: "employee",
                        employeeId: somchai.id,
                        assignedBy: adminUser.id,
                });
        }

        // Assign Ploy to the afternoon shift tomorrow
        await db.insert(scheduleAssignments).values({
                tenantId: tenant.id,
                weekPlanId: weekPlan.id,
                shiftRowId: afternoonShift.id,
                shiftDate: tomorrow,
                assigneeType: "employee",
                employeeId: ploy.id,
                assignedBy: adminUser.id,
        });
        console.log("[seed-minimal] Created schedule: 2 shift rows, 3 assignments");

        // ── Shift group + shift row (no assignments, so no conflicts) ────────
        const [teamAGroup] = await db.insert(shiftGroups).values({
                tenantId: tenant.id,
                branchId: branch.id,
                name: "Team A",
                isActive: true,
                sortOrder: 0,
                createdBy: adminUser.id,
        }).returning();

        const [teamAShift] = await db.insert(scheduleShiftRows).values({
                tenantId: tenant.id,
                branchId: branch.id,
                label: "Team A Shift",
                startTime: "08:00",
                endTime: "16:00",
                staffRequired: 2,
                shiftGroupId: teamAGroup.id,
                createdBy: adminUser.id,
        }).returning();

        console.log("[seed-minimal] Created shift group Team A");

        // ── Back Office shift group: requires Receptionist role ─────────────
        // Used to test that Somchai (Front Desk / Receptionist) is NOT offered
        // this shift in the Employees view + popover, even though the role matches.
        const [backOfficeGroup] = await db.insert(shiftGroups).values({
                tenantId: tenant.id,
                branchId: branch.id,
                name: "Back Office",
                isActive: true,
                sortOrder: 1,
                createdBy: adminUser.id,
        }).returning();

        const [managementShift] = await db.insert(scheduleShiftRows).values({
                tenantId: tenant.id,
                branchId: branch.id,
                label: "Management Cover",
                startTime: "09:00",
                endTime: "17:00",
                staffRequired: 1,
                departmentId: backOffice.id,
                shiftGroupId: backOfficeGroup.id,
                createdBy: adminUser.id,
        }).returning();

        await db.insert(scheduleShiftRowRoles).values({
                tenantId: tenant.id,
                shiftRowId: managementShift.id,
                roleId: receptionistRole.id,
        });

        console.log("[seed-minimal] Created Back Office shift group with Management Cover shift (requires Receptionist)");

        // ── Half-day leave ──────────────────────────────────────────────────
        const dayAfterTomorrow = dateStr(2);
        await db.insert(employeeTimeOff).values({
                tenantId: tenant.id,
                employeeId: somchai.id,
                branchId: branch.id,
                type: "ANNUAL",
                startDate: new Date(dayAfterTomorrow),
                endDate: new Date(dayAfterTomorrow),
                isHalfDay: true,
                halfDayPeriod: "AM",
                note: "Personal errand in the morning",
                createdBy: adminUser.id,
        });
        console.log("[seed-minimal] Created half-day AM leave for Somchai on", dayAfterTomorrow);

        // ── Checklist template with items ───────────────────────────────────
        const [checklist] = await db
                .insert(checklistTemplates)
                .values({
                        tenantId: tenant.id,
                        branchId: branch.id,
                        name: "Opening Checklist",
                        description: "Complete before opening the front desk each morning.",
                        checklistType: "operational",
                        recurrence: "daily",
                        scheduledTime: "08:30",
                        assignedDepartmentId: frontDesk.id,
                        isActive: true,
                        createdBy: adminUser.id,
                })
                .returning();

        const checklistItems = [
                { title: "Turn on lights and air conditioning", sortOrder: 0 },
                { title: "Check printer and supplies", sortOrder: 1 },
                { title: "Verify safe count matches closing log", requiresNote: true, sortOrder: 2 },
                { title: "Photo of lobby area", requiresPhoto: true, sortOrder: 3 },
        ];
        for (const item of checklistItems) {
                await db.insert(checklistTemplateItems).values({
                        tenantId: tenant.id,
                        templateId: checklist.id,
                        title: item.title,
                        requiresNote: item.requiresNote ?? false,
                        requiresPhoto: item.requiresPhoto ?? false,
                        sortOrder: item.sortOrder,
                });
        }
        console.log("[seed-minimal] Created checklist template: Opening Checklist (4 items)");

        // ── Contract template (assigned to branch) ──────────────────────────
        const [contractTemplate] = await db
                .insert(templates)
                .values({
                        name: "Standard Employment Contract",
                        templateType: "employment",
                        htmlBody: "<p>This employment contract is entered into between the Company and <b>{{employee.full_name}}</b> for the position of <b>{{contract.position_title}}</b>.</p>",
                        createdBy: adminUser.id,
                        updatedBy: adminUser.id,
                })
                .returning();
        await db.insert(templateAssignments).values({
                templateId: contractTemplate.id,
                branchId: branch.id,
                assignedBy: adminUser.id,
        });
        console.log("[seed-minimal] Created template:", contractTemplate.name);

        // ── Birthday Package Template ───────────────────────────────────────
        const [birthdayPackage] = await db
                .insert(birthdayPackageTemplates)
                .values({
                        tenantId: tenant.id,
                        name: "Standard Birthday Package",
                        description: "Our most popular birthday party package",
                        basePrice: 1500000, // 15,000฿ in satang
                        pricingMode: "PER_PACKAGE",
                        includedSummary: "Includes party room, decorations, 25 children, party host",
                        excludedSummary: "Additional guests, special entertainment extra",
                        isActive: true,
                        sortOrder: 0,
                        createdByUserId: adminUser.id,
                })
                .returning();

        await db.insert(packageLineItemTemplates).values([
                {
                        packageTemplateId: birthdayPackage.id,
                        category: "ROOM",
                        label: "Party Room Setup",
                        description: "Private party room with tables and chairs",
                        qtyDefault: 1,
                        qtyEditable: false,
                        unitLabel: "room",
                        included: true,
                        defaultUnitPrice: 0,
                        billableByDefault: false,
                        sortOrder: 0,
                },
                {
                        packageTemplateId: birthdayPackage.id,
                        category: "GUESTS",
                        label: "Children Guests",
                        description: "Up to 25 children included",
                        qtyDefault: 25,
                        qtyEditable: true,
                        unitLabel: "children",
                        included: true,
                        defaultUnitPrice: 0,
                        billableByDefault: false,
                        sortOrder: 1,
                },
                {
                        packageTemplateId: birthdayPackage.id,
                        category: "DECORATIONS",
                        label: "Standard Balloons",
                        description: "Basic balloon decoration",
                        qtyDefault: 1,
                        qtyEditable: false,
                        unitLabel: "set",
                        included: true,
                        defaultUnitPrice: 0,
                        billableByDefault: false,
                        sortOrder: 2,
                },
                {
                        packageTemplateId: birthdayPackage.id,
                        category: "GUESTS",
                        label: "Extra Adults",
                        description: "Additional adult guests",
                        qtyDefault: 0,
                        qtyEditable: true,
                        unitLabel: "person",
                        included: false,
                        defaultUnitPrice: 20000, // 200฿ per adult
                        billableByDefault: true,
                        sortOrder: 3,
                },
                {
                        packageTemplateId: birthdayPackage.id,
                        category: "DECORATIONS",
                        label: "Premium Balloons",
                        description: "Custom color balloon arrangement",
                        qtyDefault: 0,
                        qtyEditable: true,
                        unitLabel: "set",
                        included: false,
                        defaultUnitPrice: 50000, // 500฿
                        billableByDefault: true,
                        sortOrder: 4,
                },
                {
                        packageTemplateId: birthdayPackage.id,
                        category: "ENTERTAINMENT",
                        label: "Bubble Machine",
                        description: "Bubble machine rental for party",
                        qtyDefault: 0,
                        qtyEditable: true,
                        unitLabel: "item",
                        included: false,
                        defaultUnitPrice: 80000, // 800฿
                        billableByDefault: true,
                        sortOrder: 5,
                },
        ]);
        console.log("[seed-minimal] Created birthday package template with 6 line items");

        // ── Entertainment Template ──────────────────────────────────────────
        const [facepainting] = await db
                .insert(entertainmentPackageTemplates)
                .values({
                        tenantId: tenant.id,
                        name: "Face Painting",
                        description: "Professional face painter for kids",
                        durationMinutes: 60,
                        defaultPrice: 150000, // 1,500฿ in satang
                        billableByDefault: true,
                        isActive: true,
                        sortOrder: 0,
                })
                .returning();
        console.log("[seed-minimal] Created entertainment template:", facepainting.name);

        // ── BEO Location ────────────────────────────────────────────────────
        const [partyRoom] = await db
                .insert(beoLocations)
                .values({
                        tenantId: tenant.id,
                        branchId: branch.id,
                        name: "Party Room A",
                        description: "Main party room with capacity for 30 children",
                        capacity: 30,
                        isActive: true,
                        sortOrder: 0,
                        branchIds: [branch.id],
                })
                .returning();
        console.log("[seed-minimal] Created BEO location:", partyRoom.name);

        // ── Timekeeping test data (various issues to review) ────────────────
        // Create a nanny shift for today
        const [nannyShift] = await db.insert(scheduleShiftRows).values({
                tenantId: tenant.id,
                branchId: branch.id,
                label: "Nanny Shift",
                startTime: "09:00",
                endTime: "17:00",
                staffRequired: 2,
                shiftGroupId: defaultShiftGroup.id,
                createdBy: adminUser.id,
        }).returning();
        
        // Assign nannies to today's shift
        await db.insert(scheduleAssignments).values([
                {
                        tenantId: tenant.id,
                        weekPlanId: weekPlan.id,
                        shiftRowId: nannyShift.id,
                        shiftDate: today,
                        assigneeType: "employee",
                        employeeId: nanny1.id,
                        assignedBy: adminUser.id,
                },
                {
                        tenantId: tenant.id,
                        weekPlanId: weekPlan.id,
                        shiftRowId: nannyShift.id,
                        shiftDate: today,
                        assigneeType: "employee",
                        employeeId: nanny2.id,
                        assignedBy: adminUser.id,
                },
        ]);
        
        // Issue 1: Nanny 1 clocked in late (scheduled 9am, arrived 9:45am)
        const nanny1LateClockIn = new Date(todayBangkok + 'T09:45:00+07:00');
        await db.insert(timeEvents).values({
                tenantId: tenant.id,
                branchId: branch.id,
                employeeId: nanny1.id,
                eventType: 'in',
                eventTime: nanny1LateClockIn,
                authMethod: 'FACE',
        });
        
        // Issue 2: Nanny 2 clocked in on time but used PIN (requires review)
        const nanny2OnTimeClockIn = new Date(todayBangkok + 'T09:00:00+07:00');
        await db.insert(timeEvents).values({
                tenantId: tenant.id,
                branchId: branch.id,
                employeeId: nanny2.id,
                eventType: 'in',
                eventTime: nanny2OnTimeClockIn,
                authMethod: 'PIN',
                photoEvidenceUrl: '/uploads/pin-photos/example.jpg',
        });
        
        // Issue 3: Somchai clocked in but no clock out yet (open session)
        const somchaiClockIn = new Date(todayBangkok + 'T09:00:00+07:00');
        await db.insert(timeEvents).values({
                tenantId: tenant.id,
                branchId: branch.id,
                employeeId: somchai.id,
                eventType: 'in',
                eventTime: somchaiClockIn,
                authMethod: 'FACE',
        });
        
        // Issue 4: Ploy is scheduled but didn't show up at all (scheduled no-show)
        // Just add her to the schedule - she'll have no time events
        await db.insert(scheduleAssignments).values({
                tenantId: tenant.id,
                weekPlanId: weekPlan.id,
                shiftRowId: nannyShift.id,
                shiftDate: today,
                assigneeType: "employee",
                employeeId: ploy.id,
                assignedBy: adminUser.id,
        });
        
        console.log("[seed-minimal] Created timekeeping test scenarios: late arrival, PIN usage, open session, scheduled no-show");

        // ── Birthday Event ──────────────────────────────────────────────────
        const nextWeek = dateStr(7);
        const [birthdayEvent] = await db
                .insert(coreEvents)
                .values({
                        tenantId: tenant.id,
                        branchId: branch.id,
                        locationId: partyRoom.id,
                        locationText: partyRoom.name,
                        eventType: "birthday",
                        title: "Emma's 6th Birthday Party",
                        childName: "Emma Johnson",
                        bookingName: "Johnson Family",
                        parentName: "Sarah Johnson",
                        whatsappPhoneRaw: "+66812345678",
                        whatsappPhoneE164: "+66812345678",
                        whatsappParseValid: true,
                        eventDate: nextWeek,
                        startTime: "14:00",
                        endTime: "16:00",
                        durationMinutes: 120,
                        numChildren: 28,
                        numAdults: 8,
                        programName: "Birthday Party",
                        programDetails: "2-hour birthday party with games and cake",
                        activities: "Games, Face Painting, Musical Chairs",
                        decoration: "Unicorn balloons, pink streamers, glitter tablecloths",
                        status: "upcoming",  // Must be: upcoming, in_progress, completed, or cancelled
                        allergiesNotes: "One child allergic to peanuts",
                        cakeNotes: "Unicorn-themed cake requested",
                        specialRequests: "Please play Happy Birthday at 15:00",
                        internalStaffNotes: "VIP client - extra attention needed",
                        totalValue: 1880000,  // 18,800฿ in satang
                        prepaymentAmount: 500000,  // 5,000฿ deposit
                        prepaymentDate: todayDate,
                        prepaymentMethod: "bank_transfer",
                        createdByUserId: adminUser.id,
                        updatedByUserId: adminUser.id,  // Activity log looks for this!
                })
                .returning();

        // Assign party host
        await db.insert(beoPartyHostAssignments).values({
                eventId: birthdayEvent.id,
                assignedEmployeeId: somchai.id,
                notes: "Somchai has experience with unicorn themes",
        });

        // Setup Plan
        await db.insert(beoSetupPlans).values({
                eventId: birthdayEvent.id,
                setupRequired: true,
                setupNotes: "Use unicorn decorations from storage",
                setupTasks: {
                        readyBy: "13:30",
                        responsible: somchai.fullName,
                        responsibleId: somchai.id,
                        responsibleType: "EMPLOYEE",
                        simplifiedTasks: [
                                { itemLabel: "Set up tables and chairs", notes: "Arrange for 30 children" },
                                { itemLabel: "Hang unicorn banners", notes: "Pink and purple theme" },
                                { itemLabel: "Prepare balloon arch", notes: "At entrance" },
                                { itemLabel: "Test sound system", notes: "For music and games" },
                        ],
                },
        });

        // Kitchen Plan
        await db.insert(beoKitchenPlans).values({
                eventId: birthdayEvent.id,
                foodRequired: true,
                cakeMode: "INTERNAL",
                cakeTime: "15:00",
                cakeNotes: "Unicorn-themed cake, feeds 30",
                kitchenNotes: "Prepare snacks 30 minutes before party",
                serviceSchedule: [
                        {
                                label: "Welcome Snacks",
                                time: "14:00",
                                items: [
                                        { itemName: "Popcorn", quantity: 3, notes: "3 bowls" },
                                        { itemName: "Juice boxes", quantity: 28, notes: "Mixed flavors" },
                                ],
                        },
                        {
                                label: "Main Food",
                                time: "14:45",
                                items: [
                                        { itemName: "Mini pizzas", quantity: 40, notes: "Cheese and pepperoni" },
                                        { itemName: "Chicken nuggets", quantity: 50, notes: "" },
                                        { itemName: "Fruit platter", quantity: 2, notes: "No peanuts!" },
                                ],
                        },
                        {
                                label: "Cake Time",
                                time: "15:00",
                                items: [
                                        { itemName: "Unicorn cake", quantity: 1, notes: "With candles" },
                                ],
                        },
                ],
                menus: {
                        kids: [
                                { itemName: "Mini pizzas", quantity: 40, price: 0, included: true },
                                { itemName: "Chicken nuggets", quantity: 50, price: 0, included: true },
                                { itemName: "Fruit platter", quantity: 2, price: 0, included: true },
                                { itemName: "Popcorn", quantity: 3, price: 0, included: true },
                                { itemName: "Juice boxes", quantity: 28, price: 0, included: true },
                        ],
                        adults: [
                                { itemName: "Coffee and tea", quantity: 8, price: 0, included: true },
                                { itemName: "Cookies", quantity: 20, price: 0, included: true },
                        ],
                        cakePrice: 0,
                        cakeIncluded: true,
                },
        });

        // Timeline
        await db.insert(beoTimelineItems).values([
                {
                        eventId: birthdayEvent.id,
                        label: "Setup complete",
                        offsetFromStartMinutes: -30,
                        assignedToType: "SETUP_RESPONSIBLE",
                        isSystemGenerated: false,
                        sortOrder: 0,
                },
                {
                        eventId: birthdayEvent.id,
                        label: "Guests arrive",
                        offsetFromStartMinutes: 0,
                        assignedToType: "PARTY_HOST",
                        isSystemGenerated: false,
                        sortOrder: 1,
                },
                {
                        eventId: birthdayEvent.id,
                        label: "Welcome snacks served",
                        offsetFromStartMinutes: 0,
                        assignedToType: "KITCHEN_RESPONSIBLE",
                        isSystemGenerated: false,
                        sortOrder: 2,
                },
                {
                        eventId: birthdayEvent.id,
                        label: "Games and activities",
                        offsetFromStartMinutes: 15,
                        assignedToType: "PARTY_HOST",
                        isSystemGenerated: false,
                        sortOrder: 3,
                },
                {
                        eventId: birthdayEvent.id,
                        label: "Main food service",
                        offsetFromStartMinutes: 45,
                        assignedToType: "KITCHEN_RESPONSIBLE",
                        isSystemGenerated: false,
                        sortOrder: 4,
                },
                {
                        eventId: birthdayEvent.id,
                        label: "Cake moment 🎂",
                        offsetFromStartMinutes: 60,
                        assignedToType: "PARTY_HOST",
                        isSystemGenerated: false,
                        sortOrder: 5,
                },
                {
                        eventId: birthdayEvent.id,
                        label: "More games and free play",
                        offsetFromStartMinutes: 75,
                        assignedToType: "PARTY_HOST",
                        isSystemGenerated: false,
                        sortOrder: 6,
                },
                {
                        eventId: birthdayEvent.id,
                        label: "Wrap up and cleanup",
                        offsetFromStartMinutes: 120,
                        assignedToType: "PARTY_HOST",
                        isSystemGenerated: false,
                        sortOrder: 7,
                },
        ]);

        console.log("[seed-minimal] Created setup plan, kitchen plan, and timeline");

        // Entertainment Selection
        await db.insert(beoEntertainmentSelections).values({
                eventId: birthdayEvent.id,
                templateId: facepainting.id,
                templateNameAtApply: facepainting.name,
                templateUpdatedAtAtApply: facepainting.updatedAt,
                name: facepainting.name,
                description: facepainting.description,
                durationMinutes: facepainting.durationMinutes,
                price: facepainting.defaultPrice,
                billable: true,
                notes: "Unicorn and princess designs",
                sortOrder: 0,
        });
        console.log("[seed-minimal] Added entertainment: Face Painting");

        // Create package snapshot from template
        const templateItems = await db.select().from(packageLineItemTemplates)
                .where(sql`${packageLineItemTemplates.packageTemplateId} = ${birthdayPackage.id}`)
                .orderBy(sql`${packageLineItemTemplates.sortOrder}`);

        const [snapshot] = await db.insert(beoPackageSnapshots).values({
                eventId: birthdayEvent.id,
                templateId: birthdayPackage.id,
                templateNameAtApply: birthdayPackage.name,
                templateUpdatedAtAtApply: birthdayPackage.updatedAt,
                packageName: birthdayPackage.name,
                basePrice: birthdayPackage.basePrice,
                includedSummary: birthdayPackage.includedSummary,
                excludedSummary: birthdayPackage.excludedSummary,
        }).returning();

        // Add snapshot items with customizations (THIS IS WHERE THE BUG SHOWS UP)
        await db.insert(beoPackageSnapshotItems).values([
                // Included items
                {
                        snapshotId: snapshot.id,
                        sourceTemplateLineItemId: templateItems[0].id,
                        category: templateItems[0].category,
                        label: templateItems[0].label,
                        description: templateItems[0].description,
                        qty: 1,
                        unitLabel: templateItems[0].unitLabel,
                        included: true,
                        unitPrice: 0,
                        billable: false,
                        sortOrder: 0,
                },
                {
                        snapshotId: snapshot.id,
                        sourceTemplateLineItemId: templateItems[1].id,
                        category: templateItems[1].category,
                        label: templateItems[1].label,
                        description: templateItems[1].description,
                        qty: 28,  // Customized quantity
                        unitLabel: templateItems[1].unitLabel,
                        included: true,
                        unitPrice: 0,
                        billable: false,
                        sortOrder: 1,
                },
                {
                        snapshotId: snapshot.id,
                        sourceTemplateLineItemId: templateItems[2].id,
                        category: templateItems[2].category,
                        label: templateItems[2].label,
                        description: templateItems[2].description,
                        qty: 1,
                        unitLabel: templateItems[2].unitLabel,
                        included: true,
                        unitPrice: 0,
                        billable: false,
                        sortOrder: 2,
                },
                // Extra items (THIS IS WHERE THE BUG IS - notes field gets description)
                {
                        snapshotId: snapshot.id,
                        sourceTemplateLineItemId: templateItems[3].id,
                        category: templateItems[3].category,
                        label: templateItems[3].label,
                        description: templateItems[3].description,
                        qty: 5,  // 5 extra adults
                        unitLabel: templateItems[3].unitLabel,
                        included: false,
                        unitPrice: templateItems[3].defaultUnitPrice,
                        billable: true,
                        notes: "Parents and grandparents",
                        sortOrder: 3,
                },
                {
                        snapshotId: snapshot.id,
                        sourceTemplateLineItemId: templateItems[4].id,
                        category: templateItems[4].category,
                        label: templateItems[4].label,
                        description: templateItems[4].description,
                        qty: 1,
                        unitLabel: templateItems[4].unitLabel,
                        included: false,
                        unitPrice: templateItems[4].defaultUnitPrice,
                        billable: true,
                        notes: "Pink and purple unicorn colors", // Custom color specification
                        sortOrder: 4,
                },
                {
                        snapshotId: snapshot.id,
                        sourceTemplateLineItemId: templateItems[5].id,
                        category: templateItems[5].category,
                        label: templateItems[5].label,
                        description: templateItems[5].description,
                        qty: 1,
                        unitLabel: templateItems[5].unitLabel,
                        included: false,
                        unitPrice: templateItems[5].defaultUnitPrice,
                        billable: true,
                        sortOrder: 5,
                },
        ]);

        // Add billing with partyDetails (contains the buggy data structure)
        await db.insert(beoEventBilling).values({
                eventId: birthdayEvent.id,
                depositRequired: true,
                depositAmount: 500000, // 5,000฿ deposit
                depositPaidAt: new Date(),
                paymentMethod: "BANK_TRANSFER",
                addOns: {
                        partyDetails: {
                                packageName: birthdayPackage.name,
                                packageBasePrice: birthdayPackage.basePrice,
                                // BUG: Frontend saves items with "description" field, but PDF expects "label"
                                items: [
                                        {
                                                id: "included_1",
                                                description: "Party Room Setup",  // BUG: PDF expects "label"
                                                type: "included",
                                                price: 0,
                                                notes: "",
                                        },
                                        {
                                                id: "included_2",
                                                description: "28 Children Guests (3 extra)",  // BUG: PDF expects "label"
                                                type: "included",
                                                price: 0,
                                                notes: "",
                                        },
                                        {
                                                id: "included_3",
                                                description: "Standard Balloons",  // BUG: PDF expects "label"
                                                type: "included",
                                                price: 0,
                                                notes: "",
                                        },
                                        {
                                                id: "extra_1",
                                                description: "5 Extra Adults",  // BUG: PDF won't show this, only shows notes
                                                type: "extra",
                                                price: 100000,  // 1,000฿ (5 x 200)
                                                notes: "Parents and grandparents",
                                        },
                                        {
                                                id: "extra_2",
                                                description: "Premium Balloons - Pink and Purple",  // BUG: PDF won't show this
                                                type: "extra",
                                                price: 50000,  // 500฿
                                                notes: "Unicorn theme colors",
                                        },
                                        {
                                                id: "extra_3",
                                                description: "Bubble Machine",  // BUG: PDF won't show this, will be blank
                                                type: "extra",
                                                price: 80000,  // 800฿
                                                notes: "",  // Empty notes = completely blank line in PDF
                                        },
                                ],
                                prepaymentReceived: 500000,
                                depositDate: todayDate,
                                notes: "Deposit paid in full",
                        },
                },
        });

        console.log("[seed-minimal] Created birthday event with package and billing");
        console.log(`  → Event: ${birthdayEvent.title}`);
        console.log(`  → Party Host: ${somchai.fullName}`);
        console.log(`  → Package: ${birthdayPackage.name} with 3 extras`);
        console.log(`  → Entertainment: ${facepainting.name}`);

        // ── Done ────────────────────────────────────────────────────────────
        console.log("[seed-minimal] Done.");
        console.log(`\n  Login: ${admin.email} / ${admin.password}\n`);
        process.exit(0);
}

seed().catch((err) => {
        console.error("[seed-minimal] Fatal error:", err);
        process.exit(1);
});
