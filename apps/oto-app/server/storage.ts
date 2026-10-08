import {
        users,
        type User,
        type InsertUser,
        type UserWithBranchAccess,
        userBranchAccess,
        type UserBranchAccess,
        type InsertUserBranchAccess,
        people,
        type Person,
        type InsertPerson,
        type PersonWithAccess,
        accessPolicies,
        type AccessPolicy,
        type InsertAccessPolicy,
        type UpdateAccessPolicy,
        userModuleOverrides,
        type UserModuleOverride,
        type InsertUserModuleOverride,
        operators,
        type Operator,
        type InsertOperator,
        branches,
        type Branch,
        type InsertBranch,
        templates,
        type Template,
        type InsertTemplate,
        templateAssignments,
        type TemplateAssignment,
        type InsertTemplateAssignment,
        employees,
        type Employee,
        type InsertEmployee,
        type EmployeeWithAccess,
        type AccessSummary,
        employeeChanges,
        type EmployeeChange,
        type InsertEmployeeChange,
        contractInstances,
        type ContractInstance,
        type InsertContractInstance,
        settings,
        type Setting,
        type InsertSetting,
        activityLog,
        type ActivityLog,
        type InsertActivityLog,
        type ActivityType,
        attentionItems,
        type AttentionItem,
        type InsertAttentionItem,
        type AttentionType,
        employeeDocuments,
        type EmployeeDocument,
        type InsertEmployeeDocument,
        policyDocuments,
        type PolicyDocument,
        type InsertPolicyDocument,
        employeeOffboarding,
        type EmployeeOffboarding,
        type InsertEmployeeOffboarding,
        employeeLetters,
        type EmployeeLetter,
        type InsertEmployeeLetter,
        assetCatalog,
        type AssetCatalog,
        type InsertAssetCatalog,
        employeeAssets,
        type EmployeeAsset,
        type InsertEmployeeAsset,
        offboardingChecklist,
        type OffboardingChecklist,
        type InsertOffboardingChecklist,
        kioskDevices,
        type KioskDevice,
        type InsertKioskDevice,
        enrollmentSessions,
        type EnrollmentSession,
        type InsertEnrollmentSession,
        timeEvents,
        type TimeEvent,
        type InsertTimeEvent,
        timeEntries,
        type TimeEntry,
        type InsertTimeEntry,
        timekeepingIssues,
        type TimekeepingIssue,
        type InsertTimekeepingIssue,
        kioskAuthAttempts,
        type KioskAuthAttempt,
        type InsertKioskAuthAttempt,
        departments,
        type Department,
        type InsertDepartment,
        roles,
        type Role,
        type InsertRole,
        roleDepartmentMap,
        type RoleDepartmentMap,
        type InsertRoleDepartmentMap,
        employeeRoles,
        type EmployeeRole,
        type InsertEmployeeRole,
        departmentBranchAssignments,
        type DepartmentBranchAssignment,
        type InsertDepartmentBranchAssignment,
        roleBranchAssignments,
        type RoleBranchAssignment,
        type InsertRoleBranchAssignment,
        type DepartmentWithBranches,
        type RoleWithBranches,
        shifts,
        type Shift,
        type InsertShift,
        type ShiftWithDetails,
        shiftRequiredRoles,
        type ShiftRequiredRole,
        type InsertShiftRequiredRole,
        employeeTimeOff,
        type EmployeeTimeOff,
        type InsertEmployeeTimeOff,
        coverageRules,
        type CoverageRule,
        type InsertCoverageRule,
        employeePresence,
        type EmployeePresence,
        type InsertEmployeePresence,
        scheduleWeekPlans,
        type ScheduleWeekPlan,
        type InsertScheduleWeekPlan,
        type ScheduleWeekPlanWithDetails,
        scheduleShiftRows,
        type ScheduleShiftRow,
        type InsertScheduleShiftRow,
        type ScheduleShiftRowWithDetails,
        scheduleShiftRowRoles,
        type ScheduleShiftRowRole,
        type InsertScheduleShiftRowRole,
        scheduleAssignments,
        type ScheduleAssignment,
        type InsertScheduleAssignment,
        scheduleShiftBreaks,
        type ScheduleShiftBreak,
        casualWorkers,
        type CasualWorker,
        type InsertCasualWorker,
        scheduleTemplates,
        type ScheduleTemplate,
        type InsertScheduleTemplate,
        type ScheduleTemplateWithDetails,
        scheduleTemplateRows,
        type ScheduleTemplateRow,
        type InsertScheduleTemplateRow,
        scheduleTemplateRowRoles,
        type ScheduleTemplateRowRole,
        type InsertScheduleTemplateRowRole,
        scheduleTemplateAssignments,
        type ScheduleTemplateAssignment,
        type InsertScheduleTemplateAssignment,
        shiftGroups,
        type ShiftGroup,
        type InsertShiftGroup,
        scheduleTemplateTimeOff,
        type ScheduleTemplateTimeOff,
        type InsertScheduleTemplateTimeOff,
        scheduleTemplateDutyBlocks,
        type InsertScheduleTemplateDutyBlock,
        scheduleAuditLog,
        branchEvents,
        type BranchEvent,
        type InsertBranchEvent,
        leavePolicies,
        type LeavePolicy,
        type InsertLeavePolicy,
        type LeaveBalance,
        sickLeavePolicies,
        type SickLeavePolicy,
        type InsertSickLeavePolicy,
        type SickLeaveBalance,
        publicHolidays,
        type PublicHoliday,
        type InsertPublicHoliday,
        coreEvents,
        type Event,
        type InsertEvent,
        studioEventDetails,
        type StudioEventDetails,
        type InsertStudioEventDetails,
        studioEventTasks,
        type StudioEventTask,
        type InsertStudioEventTask,
        studioEventInfoBlocks,
        type StudioEventInfoBlock,
        type InsertStudioEventInfoBlock,
        studioEventBookings,
        type StudioEventBooking,
        type InsertStudioEventBooking,
        studioEventFormSchema,
        type StudioEventFormSchema,
        type InsertStudioEventFormSchema,
        dropoffForms,
        type DropoffForm,
        type InsertDropoffForm,
        dropoffFormVersions,
        type DropoffFormVersion,
        type InsertDropoffFormVersion,
        i18nTranslations,
        type I18nTranslation,
        type InsertI18nTranslation,
        translationJobs,
        type TranslationJob,
        type InsertTranslationJob,
        sopArticles,
        type SopArticle,
        type InsertSopArticle,
        kbArticles,
        type KbArticle,
        type InsertKbArticle,
        kbArticleVersions,
        type KbArticleVersion,
        type InsertKbArticleVersion,
        knowledgeFiles,
        type KnowledgeFile,
        type InsertKnowledgeFile,
        knowledgeChunks,
        type KnowledgeChunk,
        type InsertKnowledgeChunk,
        askOtoThreads,
        type AskOtoThread,
        type InsertAskOtoThread,
        askOtoMessages,
        type AskOtoMessage,
        type InsertAskOtoMessage,
        fixReports,
        type FixReport,
        type InsertFixReport,
        fixComments,
        type FixComment,
        type InsertFixComment,
        fixSupplierTokens,
        type FixSupplierToken,
        type InsertFixSupplierToken,
        locations,
        trainingModules,
        type TrainingModule,
        type InsertTrainingModule,
        tasks,
        checklistTemplates,
        checklistTemplateItems,
        // Payroll module
        payrollPeriods,
        type PayrollPeriod,
        type InsertPayrollPeriod,
        type PayrollPeriodWithRuns,
        payrollRuns,
        type PayrollRun,
        type InsertPayrollRun,
        type PayrollRunWithDetails,
        employeePayrollProfiles,
        type EmployeePayrollProfile,
        type InsertEmployeePayrollProfile,
        timeAdjustments,
        type TimeAdjustment,
        type InsertTimeAdjustment,
        payrollDayReconciliations,
        type PayrollDayReconciliation,
        type InsertPayrollDayReconciliation,
        payrollExceptions,
        type PayrollException,
        type InsertPayrollException,
        type PayrollExceptionWithDetails,
        payrollExceptionApprovals,
        type PayrollExceptionApproval,
        type InsertPayrollExceptionApproval,
        payrollLineItems,
        type PayrollLineItem,
        type InsertPayrollLineItem,
        payrollEmployeeSummaries,
        type PayrollEmployeeSummary,
        type InsertPayrollEmployeeSummary,
        payslips,
        type Payslip,
        type InsertPayslip,
        salaryAdvances,
        type SalaryAdvance,
        type InsertSalaryAdvance,
        salaryAdvanceRepayments,
        type SalaryAdvanceRepayment,
        type InsertSalaryAdvanceRepayment,
        statutoryRuleSets,
        type StatutoryRuleSet,
        type InsertStatutoryRuleSet,
        statutoryCalculationResults,
        type StatutoryCalculationResult,
        type InsertStatutoryCalculationResult,
        payrollPolicySettings,
        type PayrollPolicySettings,
        type InsertPayrollPolicySettings,
        accessItems,
        type AccessItem,
        type InsertAccessItem,
        accessViewLogs,
        type AccessViewLog,
        type InsertAccessViewLog,
        dutyTypes,
        type DutyType,
        type InsertDutyType,
        dutyBlocks,
        type DutyBlock,
        type InsertDutyBlock,
        /**
         * `tenants` was missing from this list while two statements below
         * already referenced it, so `setUserBranchAccess`'s own default-tenant
         * fallback was a ReferenceError waiting for a caller with no branch
         * access and no branches — the same state that produced "Tenant ID not
         * found". Importing it makes that path run as written.
         */
        tenants,
        DEFAULT_TENANT_SLUG,
} from "@shared/schema";
import { db } from "./db";
import {
        eq,
        desc,
        or,
        inArray,
        gte,
        lte,
        lt,
        gt,
        ne,
        and,
        sql,
        exists,
        ilike,
        isNull,
        isNotNull,
} from "drizzle-orm";
import session from "express-session";
import connectPg from "connect-pg-simple";
import { pool } from "./db";
import { getNextBirthdayBranchColor } from "@shared/event-colors";

const PostgresSessionStore = connectPg(session);

// Type for studio event tasks returned for Today view
export interface StudioEventTaskForToday {
        id: string;
        eventId: string;
        title: string;
        description: string | null;
        dueTime: string | null;
        departmentId: string | null;
        requiresPhotoEvidence: boolean;
        requiresQuestionsAnswered: boolean;
        completed: boolean;
        displayOrder: number;
        eventTitle: string;
        eventStartTime: string | null;
}

export interface IStorage {
        sessionStore: session.Store;

        // User management
        getUser(id: string): Promise<User | undefined>;
        getUserByEmail(email: string): Promise<User | undefined>;
        getUserByPhoneE164(phoneE164: string): Promise<User | undefined>;
        // Who this platform account is in this app. The only lookup the
        // launcher hand-off is allowed to make: matching on name or email
        // instead is how one person ends up inside another's record.
        getUserByPlatformUserId(platformUserId: string): Promise<User | undefined>;
        getUserWithBranchAccess(
                id: string,
        ): Promise<UserWithBranchAccess | undefined>;
        getUsers(): Promise<User[]>;
        getUsersWithBranchAccess(): Promise<UserWithBranchAccess[]>;
        createUser(user: InsertUser, tenantId?: string): Promise<User>;
        updateUser(id: string, user: Partial<InsertUser>): Promise<User>;
        updateUserLastLogin(id: string): Promise<void>;
        updateUserPassword(id: string, passwordHash: string): Promise<void>;
        resetUserPassword(
                id: string,
                passwordHash: string,
                adminId: string,
        ): Promise<void>;
        // No deleteUser here (S2-17b round 1): every door that deletes a user
        // goes through deleteManagedUser in server/lib/userDeletion.ts, which
        // refuses a platform-linked or still-referenced user in one transaction.

        // Utility for activity logging
        logActivity(log: InsertActivityLog): Promise<ActivityLog>;

        // User branch access
        getUserBranchAccess(userId: string): Promise<UserBranchAccess[]>;
        setUserBranchAccess(
                userId: string,
                accessScope: "all_branches" | "selected_branches",
                branchIds?: string[],
                tenantId?: string,
        ): Promise<void>;

        // People management (identity anchor)
        getPeople(): Promise<Person[]>;
        getPerson(id: string): Promise<Person | undefined>;
        getPersonByEmail(email: string): Promise<Person | undefined>;
        getPersonWithAccess(id: string): Promise<PersonWithAccess | undefined>;
        createPerson(person: InsertPerson): Promise<Person>;
        updatePerson(id: string, person: Partial<InsertPerson>): Promise<Person>;
        deletePerson(id: string): Promise<void>;
        checkPinFingerprintExists(
                fingerprint: string,
                excludePersonId?: string,
        ): Promise<boolean>;
        setPersonPin(
                personId: string,
                pinHash: string,
                pinFingerprint: string,
        ): Promise<void>;

        // Access policies
        getAccessPolicy(personId: string): Promise<AccessPolicy | undefined>;
        createAccessPolicy(policy: InsertAccessPolicy): Promise<AccessPolicy>;
        updateAccessPolicy(
                personId: string,
                policy: UpdateAccessPolicy,
        ): Promise<AccessPolicy>;
        deleteAccessPolicy(personId: string): Promise<void>;

        // Module overrides
        getModuleOverrides(userId: string): Promise<UserModuleOverride[]>;
        getModuleOverridesByTenant(tenantId: string): Promise<UserModuleOverride[]>;
        setModuleOverrides(
                userId: string,
                tenantId: string,
                overrides: Omit<InsertUserModuleOverride, "tenantId" | "userId">[],
                updatedBy: string,
        ): Promise<UserModuleOverride[]>;
        deleteModuleOverrides(userId: string): Promise<void>;

        getBranches(): Promise<Branch[]>;
        getBranch(id: string): Promise<Branch | undefined>;
        createBranch(branch: InsertBranch): Promise<Branch>;
        updateBranch(
                id: string,
                branch: Partial<InsertBranch> & {
                        coreBranchId?: string | null;
                        coreSyncStatus?: "PENDING" | "SUCCESS" | "FAILED" | "APP_ONLY" | null;
                        coreSyncedAt?: Date | null;
                        coreSyncError?: string | null;
                },
        ): Promise<Branch>;
        deleteBranch(id: string): Promise<void>;

        // Operators management
        getOperators(): Promise<Operator[]>;
        getOperator(id: string): Promise<Operator | undefined>;
        createOperator(operator: InsertOperator): Promise<Operator>;
        updateOperator(
                id: string,
                operator: Partial<InsertOperator>,
        ): Promise<Operator>;
        deleteOperator(id: string): Promise<void>;
        getBranchesByOperator(operatorId: string): Promise<Branch[]>;
        assignBranchesToOperator(
                operatorId: string | null,
                branchIds: string[],
        ): Promise<void>;
        getUsersByOperator(operatorId: string): Promise<User[]>;
        assignUsersToOperator(
                operatorId: string | null,
                userIds: string[],
        ): Promise<void>;

        getTemplates(): Promise<Template[]>;
        getTemplatesWithAssignments(): Promise<
                { template: Template; assignments: TemplateAssignment[] }[]
        >;
        getTemplatesForBranch(branchId?: string): Promise<Template[]>;
        getTemplate(id: string): Promise<Template | undefined>;
        createTemplate(template: InsertTemplate): Promise<Template>;
        updateTemplate(
                id: string,
                template: Partial<InsertTemplate>,
        ): Promise<Template>;
        forkTemplate(
                id: string,
                forBranchId: string,
                userId: string,
        ): Promise<Template>;
        deleteTemplate(id: string): Promise<void>;
        countActiveTemplates(): Promise<number>;

        getTemplateAssignments(
                templateId?: string,
                branchId?: string,
        ): Promise<TemplateAssignment[]>;
        createTemplateAssignment(
                assignment: InsertTemplateAssignment,
        ): Promise<TemplateAssignment>;
        deleteTemplateAssignment(
                templateId: string,
                branchId: string,
        ): Promise<void>;

        getEmployees(): Promise<Employee[]>;
        getEmployeesWithAccess(): Promise<EmployeeWithAccess[]>;
        getEmployee(id: string): Promise<Employee | undefined>;
        // The same read, confined to one tenant. An unauthenticated surface --
        // the kiosks -- uses this: an employee id is not a secret, and a park's
        // device may only read the people that park employs.
        getEmployeeInTenant(
                id: string,
                tenantId: string,
        ): Promise<Employee | undefined>;
        getEmployeeByUserId(userId: string): Promise<Employee | undefined>;
        getEmployeesByPersonId(personId: string): Promise<Employee[]>;
        getEmployeesTransferredFromBranch(
                branchId: string,
                afterDate: string,
        ): Promise<Employee[]>;
        getEmployeePendingTransfer(
                employeeId: string,
        ): Promise<{
                oldBranchId: string;
                newBranchId: string;
                effectiveDate: string;
        } | null>;
        createEmployee(employee: InsertEmployee): Promise<Employee>;
        updateEmployee(
                id: string,
                employee: Partial<InsertEmployee>,
        ): Promise<Employee>;
        deleteEmployee(id: string): Promise<void>;
        reorderEmployees(orderedIds: string[]): Promise<void>;

        getContracts(): Promise<ContractInstance[]>;
        getContractsForEmployee(employeeId: string): Promise<ContractInstance[]>;
        getActiveContractForEmployee(
                employeeId: string,
        ): Promise<ContractInstance | undefined>;
        getContract(id: string): Promise<ContractInstance | undefined>;
        getContractBySigningToken(
                token: string,
        ): Promise<ContractInstance | undefined>;
        createContract(contract: InsertContractInstance): Promise<ContractInstance>;
        updateContract(
                id: string,
                contract: Partial<ContractInstance>,
        ): Promise<ContractInstance>;
        deleteContract(id: string): Promise<void>;
        archiveContract(id: string): Promise<ContractInstance>;
        supersedeActiveContract(
                employeeId: string,
                newActiveContractId: string,
        ): Promise<void>;

        getEmployeeChanges(employeeId: string): Promise<EmployeeChange[]>;
        createEmployeeChange(change: InsertEmployeeChange): Promise<EmployeeChange>;
        updateEmployeeChange(
                id: string,
                change: Partial<EmployeeChange>,
        ): Promise<EmployeeChange>;

        getSettings(): Promise<Setting[]>;
        getSetting(key: string): Promise<Setting | undefined>;
        upsertSetting(setting: InsertSetting): Promise<Setting>;

        getActivityLogs(options?: {
                branchId?: string;
                branchIds?: string[];
                employeeId?: string;
                contractInstanceId?: string;
                types?: ActivityType[];
                limit?: number;
                offset?: number;
                dateFrom?: Date;
                dateTo?: Date;
                search?: string;
        }): Promise<ActivityLog[]>;
        getActivityLogCount(options?: {
                branchId?: string;
                branchIds?: string[];
                employeeId?: string;
                contractInstanceId?: string;
                types?: ActivityType[];
                dateFrom?: Date;
                dateTo?: Date;
                search?: string;
        }): Promise<number>;
        getActivitySummary(options?: {
                branchId?: string;
                branchIds?: string[];
                sinceDays?: number;
        }): Promise<Record<string, number>>;
        createActivityLog(log: InsertActivityLog): Promise<ActivityLog>;

        getAttentionItems(options?: {
                branchId?: string;
                scope?: { tenantId: string; branchIds: string[] };
                types?: AttentionType[];
                resolved?: boolean;
                limit?: number;
        }): Promise<AttentionItem[]>;
        getAttentionItemCounts(
                branchId?: string,
                scope?: { tenantId: string; branchIds: string[] },
        ): Promise<{ total: number; high: number; medium: number; low: number }>;
        createAttentionItem(item: InsertAttentionItem): Promise<AttentionItem>;
        resolveAttentionItem(
                id: string,
                userId: string,
                permanent?: boolean,
        ): Promise<AttentionItem>;
        deleteAttentionItemsByType(
                type: AttentionType,
                employeeId?: string,
        ): Promise<void>;

        getEmployeeDocuments(employeeId: string): Promise<EmployeeDocument[]>;
        getEmployeeDocument(id: string): Promise<EmployeeDocument | undefined>;
        getEmployeeDocumentsByType(
                employeeId: string,
                docType: string,
        ): Promise<EmployeeDocument[]>;
        createEmployeeDocument(
                doc: InsertEmployeeDocument,
        ): Promise<EmployeeDocument>;
        deleteEmployeeDocument(id: string): Promise<void>;

        // Policy documents
        getPolicyDocuments(): Promise<PolicyDocument[]>;
        getPolicyDocument(id: string): Promise<PolicyDocument | undefined>;
        getLatestPublishedPolicy(): Promise<PolicyDocument | undefined>;
        createPolicyDocument(policy: InsertPolicyDocument): Promise<PolicyDocument>;
        updatePolicyDocument(
                id: string,
                policy: Partial<InsertPolicyDocument>,
        ): Promise<PolicyDocument>;
        publishPolicyDocument(id: string, userId: string): Promise<PolicyDocument>;
        archivePolicyDocument(id: string, userId: string): Promise<PolicyDocument>;

        // Employee offboarding
        getEmployeeOffboarding(
                employeeId: string,
        ): Promise<EmployeeOffboarding | undefined>;
        getOffboardingById(id: string): Promise<EmployeeOffboarding | undefined>;
        createEmployeeOffboarding(
                offboarding: InsertEmployeeOffboarding,
        ): Promise<EmployeeOffboarding>;
        updateEmployeeOffboarding(
                id: string,
                offboarding: Partial<InsertEmployeeOffboarding>,
        ): Promise<EmployeeOffboarding>;

        // Offboarding checklist
        getOffboardingChecklist(
                offboardingId: string,
        ): Promise<OffboardingChecklist[]>;
        createOffboardingChecklistItem(
                item: InsertOffboardingChecklist,
        ): Promise<OffboardingChecklist>;
        updateOffboardingChecklistItem(
                id: string,
                updates: Partial<OffboardingChecklist>,
        ): Promise<OffboardingChecklist>;
        deleteOffboardingChecklistItem(id: string): Promise<void>;

        // Employee letters (resignation/termination)
        getEmployeeLetters(employeeId: string): Promise<EmployeeLetter[]>;
        getEmployeeLetter(id: string): Promise<EmployeeLetter | undefined>;
        getEmployeeLetterByToken(
                token: string,
        ): Promise<EmployeeLetter | undefined>;
        getUnsignedLettersCount(branchId?: string): Promise<number>;
        createEmployeeLetter(letter: InsertEmployeeLetter): Promise<EmployeeLetter>;
        updateEmployeeLetter(
                id: string,
                letter: Partial<EmployeeLetter>,
        ): Promise<EmployeeLetter>;

        // Asset catalog
        getAssetCatalog(): Promise<AssetCatalog[]>;
        getAssetCatalogItem(id: string): Promise<AssetCatalog | undefined>;
        createAssetCatalogItem(item: InsertAssetCatalog): Promise<AssetCatalog>;
        updateAssetCatalogItem(
                id: string,
                item: Partial<InsertAssetCatalog>,
        ): Promise<AssetCatalog>;
        deleteAssetCatalogItem(id: string): Promise<void>;

        // Employee assets
        getEmployeeAssets(employeeId: string): Promise<EmployeeAsset[]>;
        getEmployeeAsset(id: string): Promise<EmployeeAsset | undefined>;
        createEmployeeAsset(asset: InsertEmployeeAsset): Promise<EmployeeAsset>;
        updateEmployeeAsset(
                id: string,
                asset: Partial<EmployeeAsset>,
        ): Promise<EmployeeAsset>;
        returnEmployeeAsset(
                id: string,
                returnedBy: string,
                returnNotes?: string,
        ): Promise<EmployeeAsset>;
        getUnreturnedAssetsForEmployee(
                employeeId: string,
        ): Promise<EmployeeAsset[]>;
        getUnreturnedAssetsCount(branchId?: string): Promise<number>;
        updateAssetsExpectedReturnBy(
                employeeId: string,
                expectedReturnBy: Date,
        ): Promise<void>;

        // Employment state
        getEmployeesInLeavingState(): Promise<Employee[]>;
        updateEmployeeState(
                id: string,
                state: "ACTIVE" | "LEAVING" | "LEFT",
        ): Promise<Employee>;

        // Kiosk devices
        getKioskDevices(branchId?: string): Promise<KioskDevice[]>;
        getKioskDevice(id: string): Promise<KioskDevice | undefined>;
        getKioskDeviceBySecret(
                secretHash: string,
        ): Promise<KioskDevice | undefined>;
        createKioskDevice(device: InsertKioskDevice): Promise<KioskDevice>;
        updateKioskDevice(
                id: string,
                device: Partial<InsertKioskDevice>,
        ): Promise<KioskDevice>;
        updateKioskDeviceLastSeen(id: string): Promise<void>;
        deleteKioskDevice(id: string): Promise<void>;

        // Enrollment sessions
        getEnrollmentSession(id: string): Promise<EnrollmentSession | undefined>;
        getEnrollmentSessionByToken(
                tokenHash: string,
        ): Promise<EnrollmentSession | undefined>;
        getEnrollmentSessionsForEmployee(
                employeeId: string,
        ): Promise<EnrollmentSession[]>;
        createEnrollmentSession(
                session: InsertEnrollmentSession,
        ): Promise<EnrollmentSession>;
        markEnrollmentSessionUsed(id: string): Promise<EnrollmentSession>;

        // Time events
        getTimeEvents(options?: {
                branchId?: string;
                branchIds?: string[];
                employeeId?: string;
                dateFrom?: Date;
                dateTo?: Date;
                authMethod?: string;
                limit?: number;
                offset?: number;
        }): Promise<TimeEvent[]>;
        getTimeEventsCount(options?: {
                branchId?: string;
                branchIds?: string[];
                employeeId?: string;
                dateFrom?: Date;
                dateTo?: Date;
                authMethod?: string;
        }): Promise<number>;
        getLastTimeEvent(employeeId: string): Promise<TimeEvent | undefined>;
        getTimeEvent(id: string): Promise<TimeEvent | undefined>;
        createTimeEvent(event: InsertTimeEvent): Promise<TimeEvent>;
        updateTimeEvent(
                id: string,
                event: Partial<InsertTimeEvent>,
        ): Promise<TimeEvent>;
        deleteTimeEvent(id: string): Promise<void>;
        getEmployeePinUsageCount(employeeId: string, days: number): Promise<number>;

        // Time entries (paired clock in/out)
        getTimeEntries(options?: {
                branchId?: string;
                branchIds?: string[];
                employeeId?: string;
                dateFrom?: string;
                dateTo?: string;
                status?: string;
                limit?: number;
                offset?: number;
        }): Promise<TimeEntry[]>;
        getTimeEntry(id: string): Promise<TimeEntry | undefined>;
        getOpenTimeEntry(
                employeeId: string,
                shiftDate: string,
        ): Promise<TimeEntry | undefined>;
        createTimeEntry(entry: InsertTimeEntry): Promise<TimeEntry>;
        updateTimeEntry(
                id: string,
                entry: Partial<InsertTimeEntry>,
        ): Promise<TimeEntry>;
        deleteTimeEntry(id: string): Promise<void>;

        // Timekeeping issues
        getTimekeepingIssues(options?: {
                branchId?: string;
                branchIds?: string[];
                employeeId?: string;
                dateFrom?: string;
                dateTo?: string;
                status?: string;
                issueType?: string;
                limit?: number;
                offset?: number;
        }): Promise<TimekeepingIssue[]>;
        getTimekeepingIssuesCount(options?: {
                branchId?: string;
                branchIds?: string[];
                status?: string;
                dateFrom?: string;
                dateTo?: string;
        }): Promise<number>;
        getTimekeepingIssue(id: string): Promise<TimekeepingIssue | undefined>;
        createTimekeepingIssue(
                issue: InsertTimekeepingIssue,
        ): Promise<TimekeepingIssue>;
        updateTimekeepingIssue(
                id: string,
                issue: Partial<InsertTimekeepingIssue>,
        ): Promise<TimekeepingIssue>;
        resolveTimekeepingIssue(
                id: string,
                resolvedBy: string,
                resolutionNote?: string,
        ): Promise<TimekeepingIssue>;

        // Kiosk auth attempts
        createKioskAuthAttempt(
                attempt: InsertKioskAuthAttempt,
        ): Promise<KioskAuthAttempt>;
        getKioskAuthAttempts(options?: {
                branchId?: string;
                employeeId?: string;
                sessionId?: string;
                limit?: number;
        }): Promise<KioskAuthAttempt[]>;

        // Employee schedule helpers
        getEmployeeScheduledShift(
                employeeId: string,
                date: string,
                preferredBranchId?: string,
        ): Promise<
                | {
                                assignmentId: string;
                                branchId: string;
                                branchName: string;
                                startTime: string;
                                endTime: string;
                                shiftDate: string;
                  }
                | undefined
        >;
        getEmployeeAnyScheduledShift(
                employeeId: string,
                date: string,
        ): Promise<boolean>;

        // Employee face enrollment
        updateEmployeeFaceEnrollment(
                id: string,
                faceId: string,
                status: "ENROLLED" | "SUSPENDED",
        ): Promise<Employee>;
        updateEmployeePin(id: string, pinHash: string): Promise<Employee>;
        // Deliberately no getEmployeeByPin: a PIN identifies nobody on its own.
        // Read the employee, then compare against that employee's stored digest.
        getEmployeeByPhoneE164(phoneE164: string): Promise<Employee | undefined>;
        // Phone lookup confined to one tenant, for the kiosks: a number that
        // belongs to another park must read the same as a number that belongs
        // to nobody.
        getEmployeeByPhoneE164InTenant(
                phoneE164: string,
                tenantId: string,
        ): Promise<Employee | undefined>;
        updateEmployeePhoneE164(id: string, phoneE164: string): Promise<Employee>;
        incrementEmployeePhoneFallbackUsage(id: string): Promise<void>;
        getEmployeePhoneFallbackCount(
                employeeId: string,
                days: number,
        ): Promise<number>;
        incrementEmployeePinUsage(id: string): Promise<void>;
        refreshEmployeePinUsageCount(id: string): Promise<number>;
        getEnrolledEmployees(branchId?: string): Promise<Employee[]>;
        // The candidate set a face is matched against, confined to one tenant,
        // so a kiosk never has another park's faces put in front of its matcher.
        getEnrolledEmployeesInTenant(
                tenantId: string,
                branchId?: string,
        ): Promise<Employee[]>;

        // Departments (company-wide, assigned to branches)
        getDepartments(branchId?: string): Promise<Department[]>;
        getDepartmentsWithBranches(): Promise<DepartmentWithBranches[]>;
        getDepartment(id: string): Promise<Department | undefined>;
        getDepartmentWithBranches(
                id: string,
        ): Promise<DepartmentWithBranches | undefined>;
        createDepartment(
                department: InsertDepartment,
                branchIds?: string[],
                assignedBy?: string,
        ): Promise<Department>;
        updateDepartment(
                id: string,
                department: Partial<InsertDepartment>,
        ): Promise<Department>;
        deactivateDepartment(id: string): Promise<Department>;
        reorderDepartments(orderedIds: string[]): Promise<void>;
        getEmployeeCountByDepartment(departmentId: string): Promise<number>;
        getDepartmentBranchAssignments(
                departmentId: string,
        ): Promise<DepartmentBranchAssignment[]>;
        setDepartmentBranchAssignments(
                departmentId: string,
                branchIds: string[],
                assignedBy?: string,
        ): Promise<void>;

        // Roles (company-wide)
        getRoles(): Promise<Role[]>;
        getRole(id: string): Promise<Role | undefined>;
        createRole(role: InsertRole): Promise<Role>;
        updateRole(id: string, role: Partial<InsertRole>): Promise<Role>;
        deactivateRole(id: string): Promise<Role>;
        getEmployeeCountByRole(roleId: string): Promise<number>;
        getEmployeesByRole(
                roleId: string,
        ): Promise<{ employeeId: string; roleId: string }[]>;
        setRoleEmployees(roleId: string, employeeIds: string[]): Promise<void>;
        getRoleWithBranches(roleId: string): Promise<RoleWithBranches | undefined>;
        setRoleBranchAssignments(
                roleId: string,
                branchIds: string[],
                assignedBy?: string,
        ): Promise<void>;

        // Role-Department mapping
        getRoleDepartmentMappings(
                roleId?: string,
                departmentId?: string,
        ): Promise<RoleDepartmentMap[]>;
        createRoleDepartmentMapping(
                mapping: InsertRoleDepartmentMap,
        ): Promise<RoleDepartmentMap>;
        deleteRoleDepartmentMapping(
                roleId: string,
                departmentId: string,
        ): Promise<void>;

        // Employee roles (multi-role assignment)
        getEmployeeRoles(
                employeeId: string,
        ): Promise<(EmployeeRole & { role: Role })[]>;
        setEmployeeRoles(employeeId: string, roleIds: string[]): Promise<void>;
        setEmployeeDepartment(
                employeeId: string,
                departmentId: string | null,
        ): Promise<Employee>;

        // ============================================
        // SCHEDULING MODULE
        // ============================================

        // Shifts
        getShifts(options: {
                branchId: string;
                dateFrom: Date;
                dateTo: Date;
                departmentId?: string;
                employeeId?: string;
                status?: "OPEN" | "ASSIGNED";
        }): Promise<ShiftWithDetails[]>;
        getShift(id: string): Promise<ShiftWithDetails | undefined>;
        getOpenShiftsStartingSoon(
                branchId: string,
                withinHours: number,
        ): Promise<Shift[]>;
        getShiftsNeedingCoverage(branchId?: string): Promise<Shift[]>;
        createShift(shift: InsertShift, requiredRoleIds: string[]): Promise<Shift>;
        updateShift(
                id: string,
                shift: Partial<InsertShift>,
                requiredRoleIds?: string[],
        ): Promise<Shift>;
        deleteShift(id: string): Promise<void>;
        unassignShiftEmployee(id: string, needsCoverage?: boolean): Promise<Shift>;
        getShiftRequiredRoles(
                shiftId: string,
        ): Promise<(ShiftRequiredRole & { role: Role })[]>;

        // Employee time off
        getEmployeeTimeOff(options: {
                branchId?: string;
                employeeId?: string;
                dateFrom?: Date;
                dateTo?: Date;
        }): Promise<EmployeeTimeOff[]>;
        getTimeOffRecord(id: string): Promise<EmployeeTimeOff | undefined>;
        getTimeOffForDateRange(
                employeeId: string,
                startDate: Date,
                endDate: Date,
        ): Promise<EmployeeTimeOff[]>;
        createEmployeeTimeOff(
                timeOff: InsertEmployeeTimeOff,
        ): Promise<EmployeeTimeOff>;
        updateEmployeeTimeOff(
                id: string,
                timeOff: Partial<InsertEmployeeTimeOff>,
        ): Promise<EmployeeTimeOff>;
        deleteEmployeeTimeOff(id: string): Promise<void>;
        deleteTimeOffByEmployeeAndDateRange(
                employeeId: string,
                branchId: string,
                startDate: string,
        ): Promise<EmployeeTimeOff[]>;

        // Coverage rules (for V2)
        getCoverageRules(branchId: string): Promise<CoverageRule[]>;
        createCoverageRule(rule: InsertCoverageRule): Promise<CoverageRule>;
        deleteCoverageRule(id: string): Promise<void>;

        // Leave policies
        getLeavePolicies(branchId?: string): Promise<LeavePolicy[]>;
        getActiveLeavePolicy(branchId?: string): Promise<LeavePolicy | undefined>;
        createLeavePolicy(policy: InsertLeavePolicy): Promise<LeavePolicy>;
        updateLeavePolicy(
                id: string,
                policy: Partial<InsertLeavePolicy>,
        ): Promise<LeavePolicy>;
        deleteLeavePolicy(id: string): Promise<void>;

        // Leave balance calculation
        getEmployeeLeaveBalance(employeeId: string): Promise<LeaveBalance>;
        getBranchEmployeeLeaveBalances(branchId: string): Promise<LeaveBalance[]>;

        // Sick leave policy and balance
        getSickLeavePolicy(branchId?: string): Promise<SickLeavePolicy | undefined>;
        getOrCreateSickLeavePolicy(
                tenantId: string,
                branchId?: string,
        ): Promise<SickLeavePolicy>;
        updateSickLeavePolicy(
                id: string,
                data: Partial<InsertSickLeavePolicy>,
        ): Promise<SickLeavePolicy>;
        getEmployeeSickLeaveBalance(
                employeeId: string,
                year?: number,
        ): Promise<SickLeaveBalance>;
        getBranchEmployeeSickLeaveBalances(
                branchId: string,
                year?: number,
        ): Promise<SickLeaveBalance[]>;

        // Public holidays
        getPublicHolidays(
                tenantId: string,
                year?: number,
        ): Promise<PublicHoliday[]>;
        createPublicHoliday(data: InsertPublicHoliday): Promise<PublicHoliday>;
        updatePublicHoliday(
                id: string,
                data: Partial<InsertPublicHoliday>,
        ): Promise<PublicHoliday>;
        deletePublicHoliday(id: string): Promise<void>;

        // Eligibility helpers
        getEligibleEmployeesForShift(shiftId: string): Promise<Employee[]>;
        getEmployeeShiftsOnDate(employeeId: string, date: Date): Promise<Shift[]>;

        // ============================================
        // EMPLOYEE PRESENCE (Directory API)
        // ============================================
        getEmployeePresence(
                employeeId: string,
        ): Promise<EmployeePresence | undefined>;
        upsertEmployeePresence(
                presence: InsertEmployeePresence,
        ): Promise<EmployeePresence>;
        updatePresenceOnClockIn(
                employeeId: string,
                branchId: string,
                eventTime: Date,
                tenantId: string,
        ): Promise<EmployeePresence>;
        updatePresenceOnClockOut(
                employeeId: string,
                eventTime: Date,
                tenantId: string,
        ): Promise<EmployeePresence>;

        // Directory API helpers
        getDirectoryEmployee(
                employeeId: string,
        ): Promise<
                | {
                                employee: Employee;
                                branch: Branch | null;
                                department: Department | null;
                                roles: Role[];
                                presence: EmployeePresence | null;
                  }
                | undefined
        >;
        searchDirectoryEmployees(
                query: string,
                limit?: number,
        ): Promise<{ employee: Employee; branch: Branch | null }[]>;
        getDirectoryBranchRoster(
                branchId: string,
                status?: string,
        ): Promise<
                {
                        employee: Employee;
                        department: Department | null;
                        roles: Role[];
                        presence: EmployeePresence | null;
                }[]
        >;

        // Reconciliation helpers
        getStuckClockIns(hoursThreshold: number): Promise<EmployeePresence[]>;
        repairPresenceMismatches(): Promise<{
                mismatches: number;
                repairs: number;
                anomalies: number;
        }>;
        transitionLeavingToLeft(today: Date): Promise<number>;

        // ============================================
        // WEEK-BASED SCHEDULING (Planday-style)
        // ============================================

        // Week plans
        getWeekPlan(
                branchId: string,
                weekStartDate: string,
        ): Promise<ScheduleWeekPlanWithDetails | undefined>;
        getWeekPlanById(id: string): Promise<ScheduleWeekPlan | undefined>;
        getOrCreateWeekPlan(
                branchId: string,
                weekStartDate: string,
                userId?: string,
        ): Promise<ScheduleWeekPlan>;
        deleteWeekPlan(id: string): Promise<void>;
        deleteTimeOffByBranchAndDateRange(
                branchId: string,
                startDate: Date,
                endDate: Date,
                type?: string,
        ): Promise<void>;

        // Shift rows
        getShiftRow(id: string): Promise<ScheduleShiftRowWithDetails | undefined>;
        getShiftRowsByDepartment(departmentId: string): Promise<ScheduleShiftRow[]>;
        createShiftRow(
                shiftRow: InsertScheduleShiftRow,
                roleIds?: string[],
        ): Promise<ScheduleShiftRow>;
        updateShiftRow(
                id: string,
                shiftRow: Partial<InsertScheduleShiftRow>,
                roleIds?: string[],
        ): Promise<ScheduleShiftRow>;
        deleteShiftRow(id: string): Promise<void>;

        // Shift Groups
        getShiftGroupsByBranch(branchId: string): Promise<ShiftGroup[]>;
        getShiftGroup(id: string): Promise<ShiftGroup | undefined>;
        createShiftGroup(group: InsertShiftGroup): Promise<ShiftGroup>;
        updateShiftGroup(
                id: string,
                updates: Partial<InsertShiftGroup>,
        ): Promise<ShiftGroup>;
        deleteShiftGroup(id: string): Promise<void>;
        getShiftRowsByGroup(shiftGroupId: string): Promise<ScheduleShiftRow[]>;

        // Assignments
        getAssignment(id: string): Promise<ScheduleAssignment | undefined>;
        getAssignmentsForDate(
                branchId: string,
                date: string,
        ): Promise<ScheduleAssignment[]>;
        createAssignment(
                assignment: InsertScheduleAssignment,
        ): Promise<ScheduleAssignment>;
        updateAssignment(
                id: string,
                updates: Partial<InsertScheduleAssignment>,
        ): Promise<ScheduleAssignment>;
        deleteAssignment(id: string): Promise<void>;
        deleteAssignmentsByShiftRowAndDate(
                shiftRowId: string,
                date: string,
                employeeId?: string,
        ): Promise<void>;
        deleteAssignmentsByEmployeeAndDateRange(
                employeeId: string,
                startDate: string,
                endDate: string,
        ): Promise<ScheduleAssignment[]>;

        // Eligibility for week scheduling
        getEligibleEmployeesForShiftRow(
                shiftRowId: string,
                date: string,
        ): Promise<Employee[]>;
        getBorrowCandidates(
                shiftRowId: string,
                date: string,
                destinationBranchId: string,
        ): Promise<{
                candidates: {
                        employeeId: string;
                        name: string;
                        nickname: string;
                        homeBranchId: string;
                        homeBranchName: string;
                        roles: { id: string; name: string }[];
                        availabilityStatus: "AVAILABLE" | "NOT_AVAILABLE" | "ON_LEAVE";
                        conflictingShiftSummary?: string;
                }[];
                hasSiblingBranches: boolean;
        }>;
        getEmployeeAssignmentsOnDate(
                employeeId: string,
                date: string,
        ): Promise<ScheduleAssignment[]>;
        getBorrowedOutAssignments(
                branchId: string,
                startDate: string,
                endDate: string,
        ): Promise<
                {
                        id: string;
                        employeeId: string;
                        employeeName: string;
                        shiftDate: string;
                        startTime: string;
                        endTime: string;
                        shiftLabel: string | null;
                        departmentName: string | null;
                        toBranchId: string;
                        toBranchName: string;
                }[]
        >;
        hasEmployeeShiftOnDate(
                employeeId: string,
                date: string,
                excludeAssignmentId?: string,
        ): Promise<boolean>;
        hasEmployeeTimeOffOnDate(
                employeeId: string,
                date: string,
                excludeTimeOffId?: string,
        ): Promise<boolean>;
        canAssignEmployeeToShift(
                employeeId: string,
                shiftRowId: string,
                date: string,
                options?: { isBorrowed?: boolean },
        ): Promise<{
                ok: boolean;
                reasonCode?: string;
                message?: string;
                conflictingShift?: {
                        shiftRowId: string;
                        startTime: string;
                        endTime: string;
                };
        }>;
        canAssignCasualWorkerToShift(
                casualWorkerId: string,
                shiftRowId: string,
                date: string,
        ): Promise<{
                ok: boolean;
                reasonCode?: string;
                message?: string;
                conflictingShift?: {
                        shiftRowId: string;
                        startTime: string;
                        endTime: string;
                };
        }>;

        // Duty Types & Duty Blocks
        getDutyTypes(tenantId: string): Promise<DutyType[]>;
        getDutyType(id: string): Promise<DutyType | undefined>;
        createDutyType(dutyType: InsertDutyType): Promise<DutyType>;
        updateDutyType(
                id: string,
                updates: Partial<InsertDutyType>,
        ): Promise<DutyType>;
        deleteDutyType(id: string): Promise<void>;
        getDutyBlocks(options: {
                branchId: string;
                date: string;
                employeeId?: string;
        }): Promise<DutyBlock[]>;
        getDutyBlocksByDateRange(options: {
                branchId: string;
                startDate: string;
                endDate: string;
        }): Promise<DutyBlock[]>;
        getDutyBlock(id: string): Promise<DutyBlock | undefined>;
        createDutyBlock(dutyBlock: InsertDutyBlock): Promise<DutyBlock>;
        updateDutyBlock(
                id: string,
                updates: Partial<InsertDutyBlock>,
        ): Promise<DutyBlock>;
        deleteDutyBlock(id: string): Promise<void>;

        // Templates (structural-only: shift rows + requirements + break config)
        getScheduleTemplates(
                branchId: string,
                departmentId?: string,
                shiftGroupId?: string,
        ): Promise<any[]>;
        getScheduleTemplate(
                id: string,
        ): Promise<ScheduleTemplateWithDetails | undefined>;
        createScheduleTemplate(
                template: InsertScheduleTemplate,
        ): Promise<ScheduleTemplate>;
        saveWeekAsTemplate(
                weekPlanId: string,
                name: string,
                userId?: string,
                departmentId?: string,
                shiftGroupId?: string,
        ): Promise<ScheduleTemplate>;
        applyTemplate(
                templateId: string,
                weekPlanId: string,
                userId?: string,
        ): Promise<void>;
        deleteScheduleTemplate(id: string): Promise<void>;

        // Additive template apply - adds missing shift rows only
        previewTemplateApply(
                templateId: string,
                branchId: string,
                weekStartDate: string,
        ): Promise<{
                templateRows: number;
                rowsToAdd: Array<{
                        label: string | null;
                        startTime: string;
                        endTime: string;
                        shiftGroupName?: string;
                        departmentName?: string;
                }>;
                rowsAlreadyExist: Array<{
                        label: string | null;
                        startTime: string;
                        endTime: string;
                        shiftGroupName?: string;
                        departmentName?: string;
                }>;
                assignmentsToApply: number;
                timeOffToApply: number;
        }>;
        applyTemplateAdditive(
                templateId: string,
                branchId: string,
                weekStartDate: string,
                userId: string,
        ): Promise<{
                rowsAdded: number;
                rowsSkipped: number;
                assignmentsApplied: number;
                timeOffApplied: number;
        }>;

        // Scheduling alerts
        getOpenScheduleShiftsSoon(
                branchId: string,
                hoursAhead: number,
        ): Promise<
                {
                        shiftRowId: string;
                        shiftDate: string;
                        startTime: string;
                        endTime: string;
                        departmentName: string | null;
                }[]
        >;

        // Branch events (for scheduling grid)
        getBranchEvents(
                branchId: string,
                startDate: Date,
                endDate: Date,
        ): Promise<BranchEvent[]>;
        getBranchEvent(id: string): Promise<BranchEvent | undefined>;
        createBranchEvent(event: InsertBranchEvent): Promise<BranchEvent>;
        updateBranchEvent(
                id: string,
                event: Partial<InsertBranchEvent>,
        ): Promise<BranchEvent>;
        deleteBranchEvent(id: string): Promise<void>;

        // Studio events (birthday parties, etc.)
        getStudioEvents(options: {
                tenantId: string;
                branchId?: string;
                range?: "upcoming" | "today" | "past" | "all";
                includeArchived?: boolean;
        }): Promise<Event[]>;
        getStudioEvent(id: string): Promise<Event | undefined>;
        createStudioEvent(event: InsertEvent): Promise<Event>;
        updateStudioEvent(id: string, event: Partial<InsertEvent>): Promise<Event>;
        deleteStudioEvent(id: string): Promise<void>;

        // Event Tasks (original core tasks)
        getTasksByEventId(eventId: string): Promise<any[]>;
        createEventTask(task: {
                tenantId: string;
                branchId: string;
                eventId: string;
                title: string;
                description?: string | null;
                dueAt: Date;
                departmentId?: string | null;
                requiresPhotoEvidence?: boolean;
                requiresResponses?: boolean;
                createdBy?: string;
        }): Promise<any>;

        // Studio Event Details (for one-off events)
        getStudioEventDetails(
                eventId: string,
        ): Promise<StudioEventDetails | undefined>;
        createStudioEventDetails(
                details: InsertStudioEventDetails,
        ): Promise<StudioEventDetails>;
        updateStudioEventDetails(
                eventId: string,
                details: Partial<InsertStudioEventDetails>,
        ): Promise<StudioEventDetails>;

        // Studio Event Tasks (simple task list for one-off events)
        getStudioEventTasks(
                eventId: string,
        ): Promise<(StudioEventTask & { completedByName?: string | null })[]>;
        getStudioEventTasksForDate(
                date: string,
                branchId?: string,
        ): Promise<StudioEventTaskForToday[]>;
        createStudioEventTask(
                task: InsertStudioEventTask,
        ): Promise<StudioEventTask>;
        updateStudioEventTask(
                id: string,
                task: Partial<InsertStudioEventTask>,
        ): Promise<StudioEventTask>;
        deleteStudioEventTask(id: string): Promise<void>;

        // Studio Event Info Blocks
        getStudioEventInfoBlocks(eventId: string): Promise<StudioEventInfoBlock[]>;
        createStudioEventInfoBlock(
                block: InsertStudioEventInfoBlock,
        ): Promise<StudioEventInfoBlock>;
        updateStudioEventInfoBlock(
                id: string,
                block: Partial<InsertStudioEventInfoBlock>,
        ): Promise<StudioEventInfoBlock>;
        deleteStudioEventInfoBlock(id: string): Promise<void>;

        // Studio Event Bookings
        getStudioEventBookings(eventId: string): Promise<StudioEventBooking[]>;
        getStudioEventBooking(id: string): Promise<StudioEventBooking | undefined>;
        createStudioEventBooking(
                booking: InsertStudioEventBooking,
        ): Promise<StudioEventBooking>;
        updateStudioEventBooking(
                id: string,
                booking: Partial<InsertStudioEventBooking>,
        ): Promise<StudioEventBooking>;
        deleteStudioEventBooking(id: string): Promise<void>;

        // Studio Event Form Schema
        getStudioEventFormSchema(
                eventId: string,
        ): Promise<StudioEventFormSchema | undefined>;
        createStudioEventFormSchema(
                schema: InsertStudioEventFormSchema,
        ): Promise<StudioEventFormSchema>;
        updateStudioEventFormSchema(
                eventId: string,
                schema: Partial<InsertStudioEventFormSchema>,
        ): Promise<StudioEventFormSchema>;

        // SOP Articles (franchise-ready scoping)
        getSopArticles(
                tenantId: string,
                activeBranchId?: string | null,
                filters?: { status?: string },
        ): Promise<SopArticle[]>;
        getSopArticle(id: string): Promise<SopArticle | undefined>;
        createSopArticle(article: InsertSopArticle): Promise<SopArticle>;
        updateSopArticle(
                id: string,
                article: Partial<InsertSopArticle>,
        ): Promise<SopArticle>;
        deleteSopArticle(id: string): Promise<void>;

        // Knowledge Base Articles
        getKbArticles(
                tenantId: string,
                filters?: {
                        status?: string;
                        type?: string;
                        branchId?: string;
                        search?: string;
                        allowedBranchIds?: string[];
                },
        ): Promise<KbArticle[]>;
        getKbArticle(id: string): Promise<KbArticle | undefined>;
        createKbArticle(article: InsertKbArticle): Promise<KbArticle>;
        updateKbArticle(
                id: string,
                article: Partial<InsertKbArticle>,
        ): Promise<KbArticle>;
        deleteKbArticle(id: string): Promise<void>;
        publishKbArticle(
                id: string,
                userId: string,
                userName: string,
                changeNotes?: string,
        ): Promise<KbArticle>;
        archiveKbArticle(id: string): Promise<KbArticle>;
        getKbArticleVersions(articleId: string): Promise<KbArticleVersion[]>;

        // Knowledge Files (PDFs, images for RAG)
        getKnowledgeFiles(
                tenantId: string,
                filters?: {
                        branchId?: string;
                        fileType?: string;
                        indexStatus?: string;
                        isActive?: boolean;
                },
        ): Promise<KnowledgeFile[]>;
        getKnowledgeFile(id: string): Promise<KnowledgeFile | undefined>;
        createKnowledgeFile(file: InsertKnowledgeFile): Promise<KnowledgeFile>;
        updateKnowledgeFile(
                id: string,
                file: Partial<InsertKnowledgeFile>,
        ): Promise<KnowledgeFile>;
        deleteKnowledgeFile(id: string): Promise<void>;

        // Knowledge Chunks (text chunks from PDFs for RAG)
        getKnowledgeChunks(fileId: string): Promise<KnowledgeChunk[]>;
        getKnowledgeChunksByTenant(tenantId: string): Promise<KnowledgeChunk[]>;
        createKnowledgeChunk(chunk: InsertKnowledgeChunk): Promise<KnowledgeChunk>;
        deleteKnowledgeChunksForFile(fileId: string): Promise<void>;

        // Ask OTO Threads and Messages
        getAskOtoThreads(userId: string, tenantId: string): Promise<AskOtoThread[]>;
        getAskOtoThread(id: string): Promise<AskOtoThread | undefined>;
        createAskOtoThread(thread: InsertAskOtoThread): Promise<AskOtoThread>;
        updateAskOtoThread(
                id: string,
                thread: Partial<InsertAskOtoThread>,
        ): Promise<AskOtoThread>;
        getAskOtoMessages(threadId: string): Promise<AskOtoMessage[]>;
        createAskOtoMessage(message: InsertAskOtoMessage): Promise<AskOtoMessage>;

        // Dropoff Form Builder
        getDropoffForm(
                tenantId: string,
                branchId?: string,
        ): Promise<DropoffForm | undefined>;
        createDropoffForm(form: InsertDropoffForm): Promise<DropoffForm>;
        updateDropoffForm(
                id: string,
                form: Partial<InsertDropoffForm>,
        ): Promise<DropoffForm>;
        getDropoffFormVersion(id: string): Promise<DropoffFormVersion | undefined>;
        getDropoffFormVersions(formId: string): Promise<DropoffFormVersion[]>;
        createDropoffFormVersion(
                version: InsertDropoffFormVersion,
        ): Promise<DropoffFormVersion>;
        updateDropoffFormVersion(
                id: string,
                version: Partial<InsertDropoffFormVersion>,
        ): Promise<DropoffFormVersion>;
        getLatestDraftVersion(
                formId: string,
        ): Promise<DropoffFormVersion | undefined>;
        getActivePublishedVersion(
                formId: string,
        ): Promise<DropoffFormVersion | undefined>;
        getI18nTranslations(
                versionId: string,
                lang?: string,
        ): Promise<I18nTranslation[]>;
        upsertI18nTranslation(
                translation: InsertI18nTranslation,
        ): Promise<I18nTranslation>;
        bulkUpsertI18nTranslations(
                translations: InsertI18nTranslation[],
        ): Promise<void>;
        createTranslationJob(job: InsertTranslationJob): Promise<TranslationJob>;
        updateTranslationJob(
                id: string,
                job: Partial<InsertTranslationJob>,
        ): Promise<TranslationJob>;

        // Fix Reports (camera-first quick reporting)
        getFixReports(
                tenantId: string,
                filters?: {
                        branchId?: string;
                        status?: string;
                        reportedBy?: string;
                        priority?: string;
                        locationId?: string;
                        fromDate?: Date;
                        toDate?: Date;
                        completedFrom?: Date;
                        completedTo?: Date;
                },
        ): Promise<FixReport[]>;
        getFixReport(id: string): Promise<FixReport | undefined>;
        getFixReportWithDetails(
                id: string,
        ): Promise<
                | {
                                report: FixReport;
                                comments: FixComment[];
                                location?: { id: string; name: string };
                  }
                | undefined
        >;
        createFixReport(report: InsertFixReport): Promise<FixReport>;
        updateFixReport(
                id: string,
                report: Partial<InsertFixReport>,
        ): Promise<FixReport>;
        closeFixReport(
                id: string,
                closedByUserId: string | null,
                closedBySupplierTokenId: string | null,
                doneNote?: string,
        ): Promise<FixReport>;

        // Fix Comments
        getFixComments(fixId: string): Promise<FixComment[]>;
        createFixComment(comment: InsertFixComment): Promise<FixComment>;

        // Fix Supplier Tokens (Magic Link)
        getFixSupplierTokens(tenantId: string): Promise<FixSupplierToken[]>;
        getFixSupplierToken(id: string): Promise<FixSupplierToken | undefined>;
        getFixSupplierTokenByHash(
                tokenHash: string,
        ): Promise<FixSupplierToken | undefined>;
        createFixSupplierToken(
                token: InsertFixSupplierToken,
        ): Promise<FixSupplierToken>;
        updateFixSupplierToken(
                id: string,
                updates: Partial<InsertFixSupplierToken>,
        ): Promise<FixSupplierToken>;
        updateFixSupplierTokenLastUsed(id: string): Promise<void>;
        deleteFixSupplierToken(id: string): Promise<void>;

        // Training Modules (franchise-ready scoping)
        getTrainingModules(
                tenantId: string,
                activeBranchId?: string | null,
        ): Promise<TrainingModule[]>;
        getTrainingModule(id: string): Promise<TrainingModule | undefined>;
        createTrainingModule(module: InsertTrainingModule): Promise<TrainingModule>;
        updateTrainingModule(
                id: string,
                module: Partial<InsertTrainingModule>,
        ): Promise<TrainingModule>;
        deleteTrainingModule(id: string): Promise<void>;

        // Checklist Templates
        getChecklistTemplates(
                tenantId: string,
                branchId: string | null,
        ): Promise<any[]>;
        getChecklistTemplateWithItems(
                id: string,
                tenantId?: string,
        ): Promise<any | undefined>;
        createChecklistTemplate(
                template: {
                        tenantId: string;
                        name: string;
                        description?: string | null;
                        branchId?: string | null;
                        departmentId?: string | null;
                        checklistType?: string;
                        recurrence?: string;
                        scheduledTime?: string | null;
                        checkerRounds?: number | null;
                        scheduleTime1?: string | null;
                        scheduleTime2?: string | null;
                        scheduleTime3?: string | null;
                        scheduleTime4?: string | null;
                        scheduleTime5?: string | null;
                        assignedEmployeeId?: string | null;
                        assignedRoleId?: string | null;
                        assignedDepartmentId?: string | null;
                        allowedCheckerRoles?: string[];
                        locationId?: string | null;
                        requiresPhotoEvidence?: boolean;
                        referenceMediaUrls?: string[];
                        weeklyDays?: string[];
                        monthlyDay?: number | null;
                        createdBy?: string;
                },
                items: {
                        title: string;
                        description?: string;
                        requiresNote?: boolean;
                        requiresPhoto?: boolean;
                         cameraEnabled?: boolean;
                         galleryEnabled?: boolean;
                        isCritical?: boolean;
                        linkedToFix?: boolean;
                        referenceMediaUrls?: string[];
                        departmentId?: string;
                        zoneLabel?: string;
                }[],
        ): Promise<any>;

        // ============================================
        // PAYROLL MODULE
        // ============================================

        // Payroll Periods
        getPayrollPeriods(operatorId: string): Promise<PayrollPeriod[]>;
        getPayrollPeriod(id: string): Promise<PayrollPeriod | undefined>;
        getPayrollPeriodWithRuns(
                id: string,
        ): Promise<PayrollPeriodWithRuns | undefined>;
        createPayrollPeriod(period: InsertPayrollPeriod): Promise<PayrollPeriod>;
        updatePayrollPeriod(
                id: string,
                period: Partial<InsertPayrollPeriod>,
        ): Promise<PayrollPeriod>;

        // Payroll Runs
        getPayrollRuns(periodId: string): Promise<PayrollRun[]>;
        getPayrollRun(id: string): Promise<PayrollRun | undefined>;
        getPayrollRunWithDetails(
                id: string,
        ): Promise<PayrollRunWithDetails | undefined>;
        createPayrollRun(run: InsertPayrollRun): Promise<PayrollRun>;
        updatePayrollRun(
                id: string,
                run: Partial<InsertPayrollRun>,
        ): Promise<PayrollRun>;

        // Employee Payroll Profiles
        getEmployeePayrollProfile(
                employeeId: string,
        ): Promise<EmployeePayrollProfile | undefined>;
        getEmployeePayrollProfiles(
                operatorId: string,
        ): Promise<EmployeePayrollProfile[]>;
        createEmployeePayrollProfile(
                profile: InsertEmployeePayrollProfile,
        ): Promise<EmployeePayrollProfile>;
        updateEmployeePayrollProfile(
                id: string,
                profile: Partial<InsertEmployeePayrollProfile>,
        ): Promise<EmployeePayrollProfile>;

        // Time Adjustments
        getTimeAdjustments(
                employeeId: string,
                startDate?: string,
                endDate?: string,
        ): Promise<TimeAdjustment[]>;
        createTimeAdjustment(
                adjustment: InsertTimeAdjustment,
        ): Promise<TimeAdjustment>;
        updateTimeAdjustment(
                id: string,
                adjustment: Partial<InsertTimeAdjustment>,
        ): Promise<TimeAdjustment>;

        // Payroll Day Reconciliations
        getPayrollDayReconciliations(
                runId: string,
        ): Promise<PayrollDayReconciliation[]>;
        createPayrollDayReconciliation(
                reconciliation: InsertPayrollDayReconciliation,
        ): Promise<PayrollDayReconciliation>;
        deletePayrollDayReconciliationsByRun(runId: string): Promise<void>;

        // Payroll Exceptions
        getPayrollExceptions(runId: string): Promise<PayrollException[]>;
        getPayrollException(
                id: string,
        ): Promise<PayrollExceptionWithDetails | undefined>;
        createPayrollException(
                exception: InsertPayrollException,
        ): Promise<PayrollException>;
        updatePayrollException(
                id: string,
                exception: Partial<InsertPayrollException>,
        ): Promise<PayrollException>;
        deletePayrollExceptionsByRun(runId: string): Promise<void>;

        // Payroll Exception Approvals
        createPayrollExceptionApproval(
                approval: InsertPayrollExceptionApproval,
        ): Promise<PayrollExceptionApproval>;

        // Payroll Line Items
        getPayrollLineItems(
                runId: string,
                employeeId?: string,
        ): Promise<PayrollLineItem[]>;
        createPayrollLineItem(
                item: InsertPayrollLineItem,
        ): Promise<PayrollLineItem>;
        deletePayrollLineItemsByRun(runId: string): Promise<void>;

        // Payroll Employee Summaries
        getPayrollEmployeeSummaries(
                runId: string,
        ): Promise<PayrollEmployeeSummary[]>;
        getPayrollEmployeeSummary(
                runId: string,
                employeeId: string,
        ): Promise<PayrollEmployeeSummary | undefined>;
        getPayrollSummariesByEmployee(
                employeeId: string,
        ): Promise<PayrollEmployeeSummary[]>;
        createPayrollEmployeeSummary(
                summary: InsertPayrollEmployeeSummary,
        ): Promise<PayrollEmployeeSummary>;
        updatePayrollEmployeeSummary(
                id: string,
                summary: Partial<InsertPayrollEmployeeSummary>,
        ): Promise<PayrollEmployeeSummary>;
        deletePayrollEmployeeSummariesByRun(runId: string): Promise<void>;

        // Payslips
        getPayslips(employeeId: string): Promise<Payslip[]>;
        getPayslip(id: string): Promise<Payslip | undefined>;
        getPayslipsByRun(runId: string): Promise<Payslip[]>;
        createPayslip(payslip: InsertPayslip): Promise<Payslip>;

        // Salary Advances
        getSalaryAdvances(employeeId: string): Promise<SalaryAdvance[]>;
        getActiveSalaryAdvances(employeeId: string): Promise<SalaryAdvance[]>;
        getSalaryAdvance(id: string): Promise<SalaryAdvance | undefined>;
        createSalaryAdvance(advance: InsertSalaryAdvance): Promise<SalaryAdvance>;
        updateSalaryAdvance(
                id: string,
                advance: Partial<InsertSalaryAdvance>,
        ): Promise<SalaryAdvance>;

        // Salary Advance Repayments
        getSalaryAdvanceRepayments(
                advanceId: string,
        ): Promise<SalaryAdvanceRepayment[]>;
        createSalaryAdvanceRepayment(
                repayment: InsertSalaryAdvanceRepayment,
        ): Promise<SalaryAdvanceRepayment>;

        // Statutory Rule Sets
        getStatutoryRuleSets(countryCode: string): Promise<StatutoryRuleSet[]>;
        getActiveStatutoryRuleSet(
                countryCode: string,
                asOfDate: string,
        ): Promise<StatutoryRuleSet | undefined>;
        createStatutoryRuleSet(
                ruleSet: InsertStatutoryRuleSet,
        ): Promise<StatutoryRuleSet>;

        // Statutory Calculation Results
        getStatutoryCalculationResults(
                runId: string,
                employeeId: string,
        ): Promise<StatutoryCalculationResult | undefined>;
        createStatutoryCalculationResult(
                result: InsertStatutoryCalculationResult,
        ): Promise<StatutoryCalculationResult>;
        deleteStatutoryCalculationResultsByRun(runId: string): Promise<void>;

        // Payroll Policy Settings
        getPayrollPolicySettings(
                operatorId: string,
        ): Promise<PayrollPolicySettings | undefined>;
        createPayrollPolicySettings(
                settings: InsertPayrollPolicySettings,
        ): Promise<PayrollPolicySettings>;
        updatePayrollPolicySettings(
                id: string,
                settings: Partial<InsertPayrollPolicySettings>,
        ): Promise<PayrollPolicySettings>;
}

// The Fix Board UI exposes a simplified status filter (pending / acknowledged /
// completed) that doesn't map 1:1 onto the underlying `fix_report_status` enum
// (new, in_progress, fixed, closed, pending, done). Passing an unmapped UI value
// straight into a Postgres enum comparison throws "invalid input value for enum"
// (e.g. status=acknowledged or status=completed). Always resolve through this
// helper before filtering fix report rows by status.
const FIX_REPORT_STATUS_FILTER_MAP: Record<string, string[]> = {
        pending: ["new", "pending"],
        acknowledged: ["in_progress"],
        completed: ["done"],
};
export function resolveFixReportStatusFilter(status: string): string[] {
        return FIX_REPORT_STATUS_FILTER_MAP[status] || [status];
}

type AttentionReadScope = { tenantId: string; branchIds: string[] };

// Legacy attention rows have no tenant_id. Only a branch-owned row whose
// linked employee and contract agree with that branch can be shown safely.
function attentionReadScope(scope: AttentionReadScope) {
        if (scope.branchIds.length === 0) return sql`false`;
        return and(
                inArray(attentionItems.branchId, scope.branchIds),
                exists(db.select({ id: branches.id }).from(branches).where(and(
                        eq(branches.id, attentionItems.branchId),
                        eq(branches.tenantId, scope.tenantId),
                ))),
                or(isNull(attentionItems.employeeId), exists(
                        db.select({ id: employees.id }).from(employees).where(and(
                                eq(employees.id, attentionItems.employeeId),
                                eq(employees.tenantId, scope.tenantId),
                                or(isNull(employees.branchId), eq(employees.branchId, attentionItems.branchId)),
                        )),
                )),
                or(isNull(attentionItems.contractInstanceId), exists(
                        db.select({ id: contractInstances.id }).from(contractInstances).where(and(
                                eq(contractInstances.id, attentionItems.contractInstanceId),
                                eq(contractInstances.employeeId, attentionItems.employeeId),
                                or(isNull(contractInstances.branchId), eq(contractInstances.branchId, attentionItems.branchId)),
                        )),
                )),
        )!;
}

export class DatabaseStorage implements IStorage {
        sessionStore: session.Store;

        constructor() {
                this.sessionStore = new PostgresSessionStore({
                        pool,
                        createTableIfMissing: true,
                });
        }

        async getUser(id: string): Promise<User | undefined> {
                const [user] = await db.select().from(users).where(eq(users.id, id));
                return user || undefined;
        }

        async getUserByEmail(email: string): Promise<User | undefined> {
                const [user] = await db
                        .select()
                        .from(users)
                        .where(sql`lower(${users.email}) = lower(${email})`);
                return user || undefined;
        }

        async getUserByPhoneE164(phoneE164: string): Promise<User | undefined> {
                const [user] = await db
                        .select()
                        .from(users)
                        .where(eq(users.phoneE164, phoneE164));
                return user || undefined;
        }

        async getUserByPlatformUserId(
                platformUserId: string,
        ): Promise<User | undefined> {
                const [user] = await db
                        .select()
                        .from(users)
                        .where(eq(users.platformUserId, platformUserId));
                return user || undefined;
        }

        async createUser(insertUser: InsertUser, tenantId?: string): Promise<User> {
                const [user] = await db.insert(users).values(insertUser).returning();

                if (user.fullName) {
                        try {
                                // A name alone is never enough to link across tenants.
                                let linkTenantId = tenantId;
                                if (!linkTenantId) {
                                        const knownTenants = await db.select({ id: tenants.id }).from(tenants).limit(2);
                                        if (knownTenants.length === 1) linkTenantId = knownTenants[0].id;
                                }
                                if (!linkTenantId) return user;
                                const [matchingEmployee] = await db
                                        .select({ id: employees.id })
                                        .from(employees)
                                        .where(
                                                and(
                                                        eq(employees.tenantId, linkTenantId),
                                                        sql`LOWER(TRIM(${employees.fullName})) = LOWER(TRIM(${user.fullName}))`,
                                                        sql`LOWER(TRIM(${employees.email})) = LOWER(TRIM(${user.email}))`,
                                                        isNull(employees.userId),
                                                ),
                                        )
                                        .limit(1);

                                if (matchingEmployee) {
                                        await db
                                                .update(employees)
                                                .set({ userId: user.id })
                                                .where(eq(employees.id, matchingEmployee.id));
                                        console.log(
                                                `[User] Auto-linked user "${user.fullName}" to employee ${matchingEmployee.id}`,
                                        );
                                }
                        } catch (err) {
                                console.error(
                                        `[User] Failed to auto-link employee for "${user.fullName}":`,
                                        err,
                                );
                        }
                }

                return user;
        }

        async updateUser(id: string, userData: Partial<InsertUser>): Promise<User> {
                const [user] = await db
                        .update(users)
                        .set({ ...userData, updatedAt: new Date() })
                        .where(eq(users.id, id))
                        .returning();
                return user;
        }

        async getUsers(): Promise<User[]> {
                return db.select().from(users).orderBy(desc(users.createdAt));
        }

        async getUserWithBranchAccess(
                id: string,
        ): Promise<UserWithBranchAccess | undefined> {
                const user = await this.getUser(id);
                if (!user) return undefined;

                // Track advisor access policy fields for effective-role and branch-scope mapping.
                // These are only used when user.role === "advisor".
                let advisorAccessLevel: string | undefined;
                let advisorBranchScope: string | undefined;   // "ALL" | "SELECTED"
                let advisorBranchIds: string[] | undefined;   // populated when scope is "SELECTED"

                // Helper: capture advisor policy fields from any resolved access policy record
                const captureAdvisorPolicy = (policy: { accessLevel?: string | null; branchScope?: string | null; branchIds?: string[] | null } | null | undefined) => {
                        if (!policy) return;
                        if (policy.accessLevel && !advisorAccessLevel) advisorAccessLevel = policy.accessLevel;
                        if (policy.branchScope && !advisorBranchScope)  advisorBranchScope = policy.branchScope;
                        if (policy.branchIds   && !advisorBranchIds)    advisorBranchIds   = policy.branchIds as string[];
                };

                const branchAccess = await this.getUserBranchAccess(id);
                // Global admins and legacy admins have all branches access
                // Operator admins get their branches populated via operatorId
                const hasAllBranchesAccess =
                        user.role === "admin" ||
                        user.role === "global_admin" ||
                        branchAccess.some((ba) => ba.accessScope === "all_branches");

                let allowedBranchIds: string[] = [];
                if (hasAllBranchesAccess) {
                        allowedBranchIds = []; // Empty array means all branches allowed
                } else if (user.role === "operator_admin" && user.operatorId) {
                        // Operator admins get branches from their operator
                        const operatorBranches = await db
                                .select()
                                .from(branches)
                                .where(eq(branches.operatorId, user.operatorId));
                        allowedBranchIds = operatorBranches.map((b) => b.id);
                } else {
                        allowedBranchIds = branchAccess
                                .filter((ba) => ba.branchId)
                                .map((ba) => ba.branchId!);
                }

                // Extract tenantId from first branch access record (all records for a user should have same tenantId)
                // If no branch access records, fall back to getting tenantId from existing branches
                let tenantId =
                        branchAccess.length > 0 ? branchAccess[0].tenantId : undefined;
                if (!tenantId) {
                        // Fallback: get from existing branches
                        const existingBranches = await db
                                .select({ tenantId: branches.tenantId })
                                .from(branches)
                                .limit(1);
                        if (existingBranches.length > 0 && existingBranches[0].tenantId) {
                                tenantId = existingBranches[0].tenantId;
                        }
                }
                if (!tenantId) {
                        /**
                         * Last fallback: the default tenant, which is where
                         * `resolveTenantId` in routes.ts and the six
                         * `getDefaultTenantId` helpers under server/core all
                         * end up. Without this step the chain above stops one
                         * short of theirs, and a user with no branch access in
                         * a deployment whose `branches` table is still empty
                         * gets `undefined` — which is what a launcher-
                         * provisioned user is, because provisioning writes
                         * `users` and nothing else in this schema. That value
                         * then reaches handlers as a session field they treat
                         * as present: `/api/employees/bulk-update` answers
                         * "Tenant ID not found", `/api/org-chart/nodes`
                         * answers 401, `POST /api/duty-types` hits a NOT NULL
                         * on `tenant_id`, and the BEO reads quietly return
                         * nothing.
                         *
                         * This picks a tenant; it does not prove it is the
                         * right one. In a deployment with more than one tenant
                         * and a user with no branch access there is no correct
                         * answer available here, and this returns the default
                         * rather than none. It also does not create the tenant
                         * — a read path must not write — so a database with no
                         * tenant row at all still resolves to undefined, and
                         * the seed is what fills that in.
                         */
                        const [defaultTenant] = await db
                                .select({ id: tenants.id })
                                .from(tenants)
                                .where(eq(tenants.slug, DEFAULT_TENANT_SLUG))
                                .limit(1);
                        tenantId = defaultTenant?.id ?? undefined;
                }

                // Get module access from access_policies
                // First try to find via employee->person chain (proper way for employee-linked users)
                // Then fall back to coreUserId lookup (legacy/direct lookup)
                let modules:
                        | {
                                        core: boolean;
                                        hr: boolean;
                                        studio: boolean;
                                        events?: boolean;
                                        ops?: boolean;
                                        setup?: boolean;
                          }
                        | undefined;

                // Look up through employee->person->access_policy chain
                // Primary: match by employees.user_id
                // Fallback: match by email (handles cases where user_id link was never set)
                let [employeeRecord] = await db
                        .select({
                                id: employees.id,
                                personId: employees.personId,
                                profilePhotoPath: employees.profilePhotoPath,
                        })
                        .from(employees)
                        .where(eq(employees.userId, id));

                if (!employeeRecord && user.email) {
                        const emailLower = user.email.toLowerCase();
                        const empsByEmail = await db
                                .select({
                                        id: employees.id,
                                        personId: employees.personId,
                                        profilePhotoPath: employees.profilePhotoPath,
                                        phoneE164: employees.phoneE164,
                                        fullName: employees.fullName,
                                })
                                .from(employees)
                                .where(sql`lower(${employees.email}) = ${emailLower}`);
                        if (empsByEmail.length === 1) {
                                employeeRecord = empsByEmail[0];
                        } else if (empsByEmail.length > 1) {
                                const match = user.phoneE164
                                        ? empsByEmail.find((e) => e.phoneE164 === user.phoneE164)
                                        : empsByEmail.find((e) => e.fullName === user.fullName);
                                if (match) {
                                        employeeRecord = match;
                                }
                        }
                }

                if (employeeRecord?.personId) {
                        const [accessPolicyByPerson] = await db
                                .select()
                                .from(accessPolicies)
                                .where(eq(accessPolicies.personId, employeeRecord.personId));
                        if (accessPolicyByPerson?.modules) {
                                modules = accessPolicyByPerson.modules as {
                                        core: boolean;
                                        hr: boolean;
                                        studio: boolean;
                                        events?: boolean;
                                        ops?: boolean;
                                        setup?: boolean;
                                };
                        }
                        captureAdvisorPolicy(accessPolicyByPerson);
                }

                // Fall back to direct coreUserId lookup if no modules found via employee chain
                if (!modules) {
                        const [accessPolicy] = await db
                                .select()
                                .from(accessPolicies)
                                .where(eq(accessPolicies.coreUserId, id));
                        if (accessPolicy?.modules) {
                                modules = accessPolicy.modules as {
                                        core: boolean;
                                        hr: boolean;
                                        studio: boolean;
                                        events?: boolean;
                                        ops?: boolean;
                                        setup?: boolean;
                                };
                        }
                        captureAdvisorPolicy(accessPolicy);
                }

                // Fall back to person email lookup (for advisors who have no employee record)
                if (!modules && user.email) {
                        const [personByEmail] = await db
                                .select({ id: people.id })
                                .from(people)
                                .where(eq(people.email, user.email));
                        if (personByEmail) {
                                const [accessPolicyByPerson] = await db
                                        .select()
                                        .from(accessPolicies)
                                        .where(eq(accessPolicies.personId, personByEmail.id));
                                if (accessPolicyByPerson?.modules) {
                                        modules = accessPolicyByPerson.modules as {
                                                core: boolean;
                                                hr: boolean;
                                                studio: boolean;
                                                events?: boolean;
                                                ops?: boolean;
                                                setup?: boolean;
                                        };
                                }
                                captureAdvisorPolicy(accessPolicyByPerson);
                        }
                }

                // ── Advisor effective-role + branch-scope resolution ──────────────────────
                // users.role stays "advisor" in the DB for identity/org-chart purposes; only
                // the in-memory session object carries the resolved effective role so all
                // downstream middleware (requireRole, requireModule, permission endpoints) and
                // the frontend mode-switcher work correctly without a branch/contract/schedule
                // requirement.

                let effectiveRole = user.role;
                let effectiveHasAllBranchesAccess = hasAllBranchesAccess;
                let effectiveAllowedBranchIds = allowedBranchIds;

                if (user.role === 'advisor') {
                        // 1. Map accessLevel → effective RBAC role
                        switch ((advisorAccessLevel ?? '').toUpperCase()) {
                                case 'ADMIN':    effectiveRole = 'admin';   break;
                                case 'MANAGER':  effectiveRole = 'manager'; break;
                                case 'STAFF':
                                default:         effectiveRole = 'staff';   break;
                        }

                        // 2. Determine branch access from access policy branchScope.
                        //    - ADMIN and MANAGER advisors get all-branches access by default (same as
                        //      regular admin/manager whose getRoleDefaultBranchScope returns "ALL").
                        //    - STAFF advisors use the access policy's branchScope:
                        //        "ALL"      → all branches (no physical assignment needed)
                        //        "SELECTED" → only the explicitly listed branch IDs
                        //        (absent)   → fall back to whatever userBranchAccess records say
                        if (effectiveRole === 'admin' || effectiveRole === 'manager') {
                                effectiveHasAllBranchesAccess = true;
                                effectiveAllowedBranchIds = [];
                        } else {
                                // STAFF advisor: honour access policy branchScope if present
                                const policyScope = (advisorBranchScope ?? '').toUpperCase();
                                if (policyScope === 'ALL') {
                                        effectiveHasAllBranchesAccess = true;
                                        effectiveAllowedBranchIds = [];
                                } else if (policyScope === 'SELECTED' && advisorBranchIds && advisorBranchIds.length > 0) {
                                        effectiveHasAllBranchesAccess = false;
                                        effectiveAllowedBranchIds = advisorBranchIds;
                                }
                                // else: fall through to whatever userBranchAccess records provided
                        }
                }

                return {
                        ...user,
                        role: effectiveRole,
                        branchAccess,
                        hasAllBranchesAccess: effectiveHasAllBranchesAccess,
                        allowedBranchIds: effectiveHasAllBranchesAccess ? [] : effectiveAllowedBranchIds,
                        tenantId,
                        modules,
                        linkedEmployeeId: employeeRecord?.id,
                        linkedEmployeeProfilePhoto:
                                employeeRecord?.profilePhotoPath ||
                                user.profilePhotoPath ||
                                null,
                };
        }

        async getUsersWithBranchAccess(): Promise<UserWithBranchAccess[]> {
                const allUsers = await this.getUsers();
                const result: UserWithBranchAccess[] = [];

                for (const user of allUsers) {
                        const branchAccess = await this.getUserBranchAccess(user.id);
                        const hasAllBranchesAccess =
                                user.role === "admin" ||
                                user.role === "global_admin" ||
                                branchAccess.some((ba) => ba.accessScope === "all_branches");

                        let allowedBranchIds: string[] = [];
                        if (hasAllBranchesAccess) {
                                allowedBranchIds = [];
                        } else if (user.role === "operator_admin" && user.operatorId) {
                                const operatorBranches = await db
                                        .select()
                                        .from(branches)
                                        .where(eq(branches.operatorId, user.operatorId));
                                allowedBranchIds = operatorBranches.map((b) => b.id);
                        } else {
                                allowedBranchIds = branchAccess
                                        .filter((ba) => ba.branchId)
                                        .map((ba) => ba.branchId!);
                        }

                        result.push({
                                ...user,
                                branchAccess,
                                hasAllBranchesAccess,
                                allowedBranchIds,
                        });
                }

                return result;
        }

        async getUserBranchAccess(userId: string): Promise<UserBranchAccess[]> {
                return db
                        .select()
                        .from(userBranchAccess)
                        .where(eq(userBranchAccess.userId, userId));
        }

        async setUserBranchAccess(
                userId: string,
                accessScope: "all_branches" | "selected_branches",
                branchIds?: string[],
                tenantId?: string,
        ): Promise<void> {
                // Preserve a user's explicit tenant before considering new branch assignments.
                let resolvedTenantId = tenantId;
                const existingAccess = await this.getUserBranchAccess(userId);
                if (!resolvedTenantId && existingAccess.length > 0) {
                        const tenantIds = new Set(existingAccess.map(row => row.tenantId));
                        if (tenantIds.size !== 1) throw new Error("User tenant access is ambiguous");
                        resolvedTenantId = existingAccess[0].tenantId;
                }
                if (!resolvedTenantId && branchIds && branchIds.length > 0) {
                        const selected = await db
                                .select({ id: branches.id, tenantId: branches.tenantId })
                                .from(branches)
                                .where(inArray(branches.id, [...new Set(branchIds)]));
                        const tenantIds = new Set(selected.map(branch => branch.tenantId));
                        if (selected.length !== new Set(branchIds).size || tenantIds.size !== 1) {
                                throw new Error("Branch access crosses tenant boundaries");
                        }
                        resolvedTenantId = selected[0].tenantId;
                }

                if (!resolvedTenantId) {
                        const knownTenants = await db.select({ id: tenants.id }).from(tenants).limit(2);
                        if (knownTenants.length === 1) resolvedTenantId = knownTenants[0].id;
                }

                if (!resolvedTenantId) throw new Error("User tenant access cannot be established");
                if (existingAccess.some(row => row.tenantId !== resolvedTenantId)) {
                        throw new Error("User tenant access cannot be moved");
                }
                const selectedIds = [...new Set(branchIds ?? [])];
                if (selectedIds.length > 0) {
                        const selected = await db.select({ id: branches.id }).from(branches)
                                .where(and(eq(branches.tenantId, resolvedTenantId), inArray(branches.id, selectedIds)));
                        if (selected.length !== selectedIds.length) throw new Error("Branch access crosses tenant boundaries");
                }

                // Delete existing access records
                await db
                        .delete(userBranchAccess)
                        .where(eq(userBranchAccess.userId, userId));

                if (accessScope === "all_branches") {
                        // Insert single record with null branchId
                        await db.insert(userBranchAccess).values({
                                userId,
                                branchId: null,
                                accessScope: "all_branches",
                                tenantId: resolvedTenantId,
                        });
                } else if (selectedIds.length > 0) {
                        const records = selectedIds.map((branchId) => ({
                                userId,
                                branchId,
                                accessScope: "selected_branches" as const,
                                tenantId: resolvedTenantId,
                        }));
                        await db.insert(userBranchAccess).values(records);
                } else {
                        // A branchless account still needs an unambiguous tenant identity.
                        await db.insert(userBranchAccess).values({
                                userId,
                                branchId: null,
                                accessScope: "selected_branches",
                                tenantId: resolvedTenantId,
                        });
                }
        }

        async updateUserLastLogin(id: string): Promise<void> {
                await db
                        .update(users)
                        .set({ lastLoginAt: new Date() })
                        .where(eq(users.id, id));
        }

        async updateUserPassword(id: string, passwordHash: string): Promise<void> {
                await db
                        .update(users)
                        .set({
                                password: passwordHash,
                                mustChangePassword: false,
                                updatedAt: new Date(),
                        })
                        .where(eq(users.id, id));
        }

        async resetUserPassword(
                id: string,
                passwordHash: string,
                adminId: string,
        ): Promise<void> {
                await db
                        .update(users)
                        .set({
                                password: passwordHash,
                                mustChangePassword: true,
                                updatedAt: new Date(),
                        })
                        .where(eq(users.id, id));
        }

        async logActivity(log: InsertActivityLog): Promise<ActivityLog> {
                return this.createActivityLog(log);
        }

        // People management (identity anchor)
        async getPeople(): Promise<Person[]> {
                return db.select().from(people).orderBy(desc(people.createdAt));
        }

        async getPerson(id: string): Promise<Person | undefined> {
                const [person] = await db
                        .select()
                        .from(people)
                        .where(eq(people.id, id));
                return person || undefined;
        }

        async getPersonByEmail(email: string): Promise<Person | undefined> {
                const [person] = await db
                        .select()
                        .from(people)
                        .where(eq(people.email, email));
                return person || undefined;
        }

        async getPersonWithAccess(
                id: string,
        ): Promise<PersonWithAccess | undefined> {
                const person = await this.getPerson(id);
                if (!person) return undefined;

                const accessPolicy = await this.getAccessPolicy(id);
                const employee =
                        person.personType === "EMPLOYEE"
                                ? await db
                                                .select()
                                                .from(employees)
                                                .where(eq(employees.personId, id))
                                                .then((rows) => rows[0])
                                : undefined;

                return {
                        ...person,
                        accessPolicy,
                        employee,
                };
        }

        async createPerson(person: InsertPerson): Promise<Person> {
                const [newPerson] = await db.insert(people).values(person).returning();
                return newPerson;
        }

        async updatePerson(
                id: string,
                person: Partial<InsertPerson>,
        ): Promise<Person> {
                const [updatedPerson] = await db
                        .update(people)
                        .set({ ...person, updatedAt: new Date() })
                        .where(eq(people.id, id))
                        .returning();
                return updatedPerson;
        }

        async deletePerson(id: string): Promise<void> {
                await db.delete(people).where(eq(people.id, id));
        }

        async checkPinFingerprintExists(
                fingerprint: string,
                excludePersonId?: string,
        ): Promise<boolean> {
                const query = db
                        .select()
                        .from(people)
                        .where(eq(people.timeclockPinFingerprint, fingerprint));
                const results = await query;
                if (excludePersonId) {
                        return results.some((p) => p.id !== excludePersonId);
                }
                return results.length > 0;
        }

        async setPersonPin(
                personId: string,
                pinHash: string,
                pinFingerprint: string,
        ): Promise<void> {
                await db
                        .update(people)
                        .set({
                                timeclockPinHash: pinHash,
                                timeclockPinFingerprint: pinFingerprint,
                                timeclockPinSetAt: new Date(),
                                updatedAt: new Date(),
                        })
                        .where(eq(people.id, personId));
        }

        // Access policies
        async getAccessPolicy(personId: string): Promise<AccessPolicy | undefined> {
                const [policy] = await db
                        .select()
                        .from(accessPolicies)
                        .where(eq(accessPolicies.personId, personId));
                return policy || undefined;
        }

        async createAccessPolicy(
                policy: InsertAccessPolicy,
        ): Promise<AccessPolicy> {
                const [newPolicy] = await db
                        .insert(accessPolicies)
                        .values(policy)
                        .returning();
                return newPolicy;
        }

        async updateAccessPolicy(
                personId: string,
                policy: UpdateAccessPolicy,
        ): Promise<AccessPolicy> {
                const [updatedPolicy] = await db
                        .update(accessPolicies)
                        .set({ ...policy, updatedAt: new Date() })
                        .where(eq(accessPolicies.personId, personId))
                        .returning();
                return updatedPolicy;
        }

        async deleteAccessPolicy(personId: string): Promise<void> {
                await db
                        .delete(accessPolicies)
                        .where(eq(accessPolicies.personId, personId));
        }

        // Module overrides
        async getModuleOverrides(userId: string): Promise<UserModuleOverride[]> {
                return db
                        .select()
                        .from(userModuleOverrides)
                        .where(eq(userModuleOverrides.userId, userId));
        }

        async getModuleOverridesByTenant(
                tenantId: string,
        ): Promise<UserModuleOverride[]> {
                return db
                        .select()
                        .from(userModuleOverrides)
                        .where(eq(userModuleOverrides.tenantId, tenantId));
        }

        async setModuleOverrides(
                userId: string,
                tenantId: string,
                overrides: Omit<InsertUserModuleOverride, "tenantId" | "userId">[],
                updatedBy: string,
        ): Promise<UserModuleOverride[]> {
                await db
                        .delete(userModuleOverrides)
                        .where(eq(userModuleOverrides.userId, userId));
                if (overrides.length === 0) return [];
                const rows = overrides.map((o) => ({
                        ...o,
                        tenantId,
                        userId,
                        updatedBy,
                }));
                return db.insert(userModuleOverrides).values(rows).returning();
        }

        async deleteModuleOverrides(userId: string): Promise<void> {
                await db
                        .delete(userModuleOverrides)
                        .where(eq(userModuleOverrides.userId, userId));
        }

        async getBranches(): Promise<Branch[]> {
                return db.select().from(branches).orderBy(desc(branches.createdAt));
        }

        async getBranch(id: string): Promise<Branch | undefined> {
                const [branch] = await db
                        .select()
                        .from(branches)
                        .where(eq(branches.id, id));
                return branch || undefined;
        }

        async createBranch(branch: InsertBranch): Promise<Branch> {
                return db.transaction(async (tx) => {
                        await tx.execute(
                                sql`SELECT pg_advisory_xact_lock(hashtextextended(${branch.tenantId}::text, 0))`,
                        );
                        const existingBranchColors = await tx
                                .select({ calendarColor: branches.calendarColor })
                                .from(branches)
                                .where(eq(branches.tenantId, branch.tenantId));
                        const calendarColor = getNextBirthdayBranchColor(
                                branch.name,
                                existingBranchColors.map((existing) => existing.calendarColor),
                        );
                        const [newBranch] = await tx
                                .insert(branches)
                                .values({ ...branch, calendarColor })
                                .returning();
                        return newBranch;
                });
        }

        async updateBranch(
                id: string,
                branch: Partial<InsertBranch> & {
                        coreBranchId?: string | null;
                        coreSyncStatus?: "PENDING" | "SUCCESS" | "FAILED" | "APP_ONLY" | null;
                        coreSyncedAt?: Date | null;
                        coreSyncError?: string | null;
                },
        ): Promise<Branch> {
                const [updatedBranch] = await db
                        .update(branches)
                        .set(branch)
                        .where(eq(branches.id, id))
                        .returning();
                return updatedBranch;
        }

        async deleteBranch(id: string): Promise<void> {
                await db.delete(branches).where(eq(branches.id, id));
        }

        // Operators management
        async getOperators(): Promise<Operator[]> {
                return db.select().from(operators).orderBy(operators.name);
        }

        async getOperator(id: string): Promise<Operator | undefined> {
                const [operator] = await db
                        .select()
                        .from(operators)
                        .where(eq(operators.id, id));
                return operator;
        }

        async createOperator(operator: InsertOperator): Promise<Operator> {
                const [created] = await db
                        .insert(operators)
                        .values(operator)
                        .returning();
                return created;
        }

        async updateOperator(
                id: string,
                operator: Partial<InsertOperator>,
        ): Promise<Operator> {
                const [updated] = await db
                        .update(operators)
                        .set({ ...operator, updatedAt: new Date() })
                        .where(eq(operators.id, id))
                        .returning();
                return updated;
        }

        async deleteOperator(id: string): Promise<void> {
                await db.delete(operators).where(eq(operators.id, id));
        }

        async getBranchesByOperator(operatorId: string): Promise<Branch[]> {
                return db
                        .select()
                        .from(branches)
                        .where(eq(branches.operatorId, operatorId))
                        .orderBy(branches.name);
        }

        async assignBranchesToOperator(
                operatorId: string | null,
                branchIds: string[],
        ): Promise<void> {
                if (branchIds.length === 0) return;
                await db
                        .update(branches)
                        .set({ operatorId, updatedAt: new Date() })
                        .where(inArray(branches.id, branchIds));
        }

        async getUsersByOperator(operatorId: string): Promise<User[]> {
                return db
                        .select()
                        .from(users)
                        .where(eq(users.operatorId, operatorId))
                        .orderBy(users.fullName);
        }

        async assignUsersToOperator(
                operatorId: string | null,
                userIds: string[],
        ): Promise<void> {
                if (userIds.length === 0) return;
                await db
                        .update(users)
                        .set({ operatorId, updatedAt: new Date() })
                        .where(inArray(users.id, userIds));
        }

        async getTemplates(): Promise<Template[]> {
                return db
                        .select()
                        .from(templates)
                        .where(eq(templates.status, "active"))
                        .orderBy(desc(templates.updatedAt));
        }

        async getTemplatesWithAssignments(): Promise<
                { template: Template; assignments: TemplateAssignment[] }[]
        > {
                const allTemplates = await db
                        .select()
                        .from(templates)
                        .orderBy(desc(templates.updatedAt));
                const allAssignments = await db.select().from(templateAssignments);

                return allTemplates.map((template) => ({
                        template,
                        assignments: allAssignments.filter(
                                (a) => a.templateId === template.id,
                        ),
                }));
        }

        async getTemplatesForBranch(branchId?: string): Promise<Template[]> {
                if (!branchId) {
                        return this.getTemplates();
                }

                const assignments = await this.getTemplateAssignments(
                        undefined,
                        branchId,
                );
                if (assignments.length === 0) return [];

                const templateIds = assignments.map((a) => a.templateId);
                return db
                        .select()
                        .from(templates)
                        .where(
                                and(
                                        inArray(templates.id, templateIds),
                                        eq(templates.status, "active"),
                                ),
                        )
                        .orderBy(desc(templates.updatedAt));
        }

        async getTemplate(id: string): Promise<Template | undefined> {
                const [template] = await db
                        .select()
                        .from(templates)
                        .where(eq(templates.id, id));
                return template || undefined;
        }

        async createTemplate(template: InsertTemplate): Promise<Template> {
                const [newTemplate] = await db
                        .insert(templates)
                        .values({
                                ...template,
                                version: 1,
                        })
                        .returning();
                return newTemplate;
        }

        async updateTemplate(
                id: string,
                template: Partial<InsertTemplate>,
        ): Promise<Template> {
                const existing = await this.getTemplate(id);
                if (!existing) {
                        throw new Error("Template not found");
                }

                const [updatedTemplate] = await db
                        .update(templates)
                        .set({
                                ...template,
                                version: existing.version + 1,
                                updatedAt: new Date(),
                        })
                        .where(eq(templates.id, id))
                        .returning();
                return updatedTemplate;
        }

        async forkTemplate(
                id: string,
                forBranchId: string,
                userId: string,
        ): Promise<Template> {
                const existing = await this.getTemplate(id);
                if (!existing) {
                        throw new Error("Template not found");
                }

                const [forkedTemplate] = await db
                        .insert(templates)
                        .values({
                                name: `${existing.name} (Fork)`,
                                htmlBody: existing.htmlBody,
                                status: "active",
                                forkedFromTemplateId: id,
                                headerShowLogo: existing.headerShowLogo,
                                headerShowAddress: existing.headerShowAddress,
                                headerAlignment: existing.headerAlignment,
                                createdBy: userId,
                                updatedBy: userId,
                        })
                        .returning();

                await this.createTemplateAssignment({
                        templateId: forkedTemplate.id,
                        branchId: forBranchId,
                        isDefaultForBranch: false,
                        assignedBy: userId,
                });

                return forkedTemplate;
        }

        async deleteTemplate(id: string): Promise<void> {
                await db
                        .delete(templateAssignments)
                        .where(eq(templateAssignments.templateId, id));
                await db.delete(templates).where(eq(templates.id, id));
        }

        async countActiveTemplates(): Promise<number> {
                const result = await db
                        .select({ count: sql<number>`count(*)::int` })
                        .from(templates)
                        .where(eq(templates.status, "active"));
                return result[0]?.count ?? 0;
        }

        async getTemplateAssignments(
                templateId?: string,
                branchId?: string,
        ): Promise<TemplateAssignment[]> {
                if (templateId && branchId) {
                        return db
                                .select()
                                .from(templateAssignments)
                                .where(
                                        and(
                                                eq(templateAssignments.templateId, templateId),
                                                eq(templateAssignments.branchId, branchId),
                                        ),
                                );
                }
                if (templateId) {
                        return db
                                .select()
                                .from(templateAssignments)
                                .where(eq(templateAssignments.templateId, templateId));
                }
                if (branchId) {
                        return db
                                .select()
                                .from(templateAssignments)
                                .where(eq(templateAssignments.branchId, branchId));
                }
                return db.select().from(templateAssignments);
        }

        async createTemplateAssignment(
                assignment: InsertTemplateAssignment,
        ): Promise<TemplateAssignment> {
                const [newAssignment] = await db
                        .insert(templateAssignments)
                        .values(assignment)
                        .returning();
                return newAssignment;
        }

        async deleteTemplateAssignment(
                templateId: string,
                branchId: string,
        ): Promise<void> {
                await db
                        .delete(templateAssignments)
                        .where(
                                and(
                                        eq(templateAssignments.templateId, templateId),
                                        eq(templateAssignments.branchId, branchId),
                                ),
                        );
        }

        async getTemplateContractCount(templateId: string): Promise<number> {
                const result = await db
                        .select({ count: sql<number>`count(*)::int` })
                        .from(contractInstances)
                        .where(eq(contractInstances.templateId, templateId));
                return result[0]?.count ?? 0;
        }

        async getEmployees(): Promise<Employee[]> {
                return db.select().from(employees).orderBy(desc(employees.createdAt));
        }

        async getEmployeesWithAccess(): Promise<EmployeeWithAccess[]> {
                const rows = await db
                        .select({
                                employee: employees,
                                accessPolicy: accessPolicies,
                        })
                        .from(employees)
                        .leftJoin(people, eq(employees.personId, people.id))
                        .leftJoin(accessPolicies, eq(people.id, accessPolicies.personId))
                        .orderBy(desc(employees.createdAt));

                // Get all signed contracts for quick lookup
                const signedContracts = await db
                        .select({ employeeId: contractInstances.employeeId })
                        .from(contractInstances)
                        .where(
                                and(
                                        eq(contractInstances.signingStatus, "signed"),
                                        isNull(contractInstances.archivedAt),
                                ),
                        );

                const employeesWithSignedContract = new Set(
                        signedContracts.map((c) => c.employeeId),
                );

                return rows.map(({ employee, accessPolicy }) => {
                        let accessSummary: AccessSummary | null = null;

                        if (accessPolicy) {
                                const modules = accessPolicy.modules as {
                                        core: boolean;
                                        hr: boolean;
                                        studio: boolean;
                                        events?: boolean;
                                        ops?: boolean;
                                        setup?: boolean;
                                };
                                accessSummary = {
                                        accessLevel: accessPolicy.accessLevel as
                                                | "STAFF"
                                                | "MANAGER"
                                                | "ADMIN",
                                        modules: {
                                                core: modules?.core ?? false,
                                                hr: modules?.hr ?? false,
                                                studio: modules?.studio ?? false,
                                                events: modules?.events ?? false,
                                                ops: modules?.ops ?? false,
                                                setup: modules?.setup ?? false,
                                        },
                                        branchScope: accessPolicy.branchScope as "ALL" | "SELECTED",
                                        coreAccountEnabled: accessPolicy.coreAccountEnabled,
                                        coreUserId: accessPolicy.coreUserId,
                                };
                        }

                        return {
                                ...employee,
                                accessSummary,
                                hasSignedContract: employeesWithSignedContract.has(employee.id),
                        };
                });
        }

        async getEmployee(id: string): Promise<Employee | undefined> {
                const [employee] = await db
                        .select()
                        .from(employees)
                        .where(eq(employees.id, id));
                return employee || undefined;
        }

        async getEmployeeInTenant(
                id: string,
                tenantId: string,
        ): Promise<Employee | undefined> {
                const [employee] = await db
                        .select()
                        .from(employees)
                        .where(
                                and(
                                        eq(employees.id, id),
                                        eq(employees.tenantId, tenantId),
                                ),
                        );
                return employee || undefined;
        }

        async getEmployeeByUserId(userId: string): Promise<Employee | undefined> {
                const [employee] = await db
                        .select()
                        .from(employees)
                        .where(eq(employees.userId, userId));
                return employee || undefined;
        }

        async getEmployeesByPersonId(personId: string): Promise<Employee[]> {
                return await db
                        .select()
                        .from(employees)
                        .where(eq(employees.personId, personId));
        }

        async getEmployeesTransferredFromBranch(
                branchId: string,
                afterDate: string,
        ): Promise<Employee[]> {
                // Find employees who have a branch_transfer record FROM this branch where the effective date is after the given date
                // This means the transfer hasn't taken effect yet for the date being viewed
                const transferRecords = await db
                        .select({
                                employeeId: employeeChanges.employeeId,
                        })
                        .from(employeeChanges)
                        .where(
                                and(
                                        eq(employeeChanges.changeType, "branch_transfer"),
                                        eq(employeeChanges.oldBranchId, branchId),
                                        sql`${employeeChanges.effectiveDate}::date > ${afterDate}::date`,
                                ),
                        );

                if (transferRecords.length === 0) {
                        return [];
                }

                const employeeIds = transferRecords.map((r) => r.employeeId);
                return await db
                        .select()
                        .from(employees)
                        .where(inArray(employees.id, employeeIds));
        }

        async getEmployeePendingTransfer(
                employeeId: string,
        ): Promise<{
                oldBranchId: string;
                newBranchId: string;
                effectiveDate: string;
        } | null> {
                // Find the most recent branch transfer record for this employee
                const [transfer] = await db
                        .select({
                                oldBranchId: employeeChanges.oldBranchId,
                                newBranchId: employeeChanges.newBranchId,
                                effectiveDate: employeeChanges.effectiveDate,
                        })
                        .from(employeeChanges)
                        .where(
                                and(
                                        eq(employeeChanges.employeeId, employeeId),
                                        eq(employeeChanges.changeType, "branch_transfer"),
                                        isNotNull(employeeChanges.oldBranchId),
                                        isNotNull(employeeChanges.newBranchId),
                                ),
                        )
                        .orderBy(desc(employeeChanges.effectiveDate))
                        .limit(1);

                if (
                        !transfer ||
                        !transfer.oldBranchId ||
                        !transfer.newBranchId ||
                        !transfer.effectiveDate
                ) {
                        return null;
                }

                // Format effectiveDate as yyyy-MM-dd string
                const effectiveDateStr =
                        transfer.effectiveDate instanceof Date
                                ? transfer.effectiveDate.toISOString().split("T")[0]
                                : String(transfer.effectiveDate).split("T")[0];

                return {
                        oldBranchId: transfer.oldBranchId,
                        newBranchId: transfer.newBranchId,
                        effectiveDate: effectiveDateStr,
                };
        }

        async createEmployee(employee: InsertEmployee): Promise<Employee> {
                const [newEmployee] = await db
                        .insert(employees)
                        .values(employee)
                        .returning();
                return newEmployee;
        }

        async updateEmployee(
                id: string,
                employee: Partial<InsertEmployee>,
        ): Promise<Employee> {
                const [updatedEmployee] = await db
                        .update(employees)
                        .set(employee)
                        .where(eq(employees.id, id))
                        .returning();
                return updatedEmployee;
        }

        async clearActivityLogEmployeeReferences(
                employeeId: string,
        ): Promise<void> {
                // Set employee_id to NULL in activity_log to preserve history but allow employee deletion
                await db
                        .update(activityLog)
                        .set({ employeeId: null })
                        .where(eq(activityLog.employeeId, employeeId));
        }

        async deleteEmployee(id: string): Promise<void> {
                // Delete related records first to avoid foreign key violations
                // 1. Delete employee change history
                await db
                        .delete(employeeChanges)
                        .where(eq(employeeChanges.employeeId, id));
                // 2. Delete employee documents
                await db
                        .delete(employeeDocuments)
                        .where(eq(employeeDocuments.employeeId, id));
                // 3. Delete enrollment sessions
                await db
                        .delete(enrollmentSessions)
                        .where(eq(enrollmentSessions.employeeId, id));
                // 4. Delete time events
                await db.delete(timeEvents).where(eq(timeEvents.employeeId, id));
                // 5. Delete kiosk auth attempts
                await db
                        .delete(kioskAuthAttempts)
                        .where(eq(kioskAuthAttempts.employeeId, id));
                // 6. Delete employee roles
                await db.delete(employeeRoles).where(eq(employeeRoles.employeeId, id));
                // 7. Delete employee time off
                await db
                        .delete(employeeTimeOff)
                        .where(eq(employeeTimeOff.employeeId, id));
                // 8. Delete offboarding checklist items BEFORE employee offboarding (FK dependency)
                // Get all offboarding records for this employee first
                const offboardingRecords = await db
                        .select({ id: employeeOffboarding.id })
                        .from(employeeOffboarding)
                        .where(eq(employeeOffboarding.employeeId, id));
                // Delete checklist items by offboarding_id to respect the FK constraint
                for (const offboarding of offboardingRecords) {
                        await db
                                .delete(offboardingChecklist)
                                .where(eq(offboardingChecklist.offboardingId, offboarding.id));
                }
                // 9. Now safe to delete employee offboarding records
                await db
                        .delete(employeeOffboarding)
                        .where(eq(employeeOffboarding.employeeId, id));
                // 10. Delete employee letters
                await db
                        .delete(employeeLetters)
                        .where(eq(employeeLetters.employeeId, id));
                // 11. Delete employee assets
                await db
                        .delete(employeeAssets)
                        .where(eq(employeeAssets.employeeId, id));
                // 12. Nullify employeeId in shifts (nullable FK)
                await db
                        .update(shifts)
                        .set({ employeeId: null })
                        .where(eq(shifts.employeeId, id));
                // 13. Get contract IDs for this employee before deleting
                const employeeContracts = await db
                        .select({ id: contractInstances.id })
                        .from(contractInstances)
                        .where(eq(contractInstances.employeeId, id));
                const contractIds = employeeContracts.map((c) => c.id);
                // 6. Nullify contractInstanceId in activity log and attention items for these contracts
                if (contractIds.length > 0) {
                        await db
                                .update(activityLog)
                                .set({ contractInstanceId: null })
                                .where(inArray(activityLog.contractInstanceId, contractIds));
                        await db
                                .update(attentionItems)
                                .set({ contractInstanceId: null })
                                .where(inArray(attentionItems.contractInstanceId, contractIds));
                }
                // 7. Delete contracts for this employee
                await db
                        .delete(contractInstances)
                        .where(eq(contractInstances.employeeId, id));
                // 8. Set employeeId to null in activity log (nullable FK)
                await db
                        .update(activityLog)
                        .set({ employeeId: null })
                        .where(eq(activityLog.employeeId, id));
                // 9. Set employeeId to null in attention items (nullable FK)
                await db
                        .update(attentionItems)
                        .set({ employeeId: null })
                        .where(eq(attentionItems.employeeId, id));
                // 10. Finally delete the employee
                await db.delete(employees).where(eq(employees.id, id));
        }

        async reorderEmployees(orderedIds: string[]): Promise<void> {
                for (let i = 0; i < orderedIds.length; i++) {
                        await db
                                .update(employees)
                                .set({ displayOrder: i })
                                .where(eq(employees.id, orderedIds[i]));
                }
        }

        async getContracts(): Promise<ContractInstance[]> {
                return db
                        .select()
                        .from(contractInstances)
                        .orderBy(desc(contractInstances.createdAt));
        }

        async getContract(id: string): Promise<ContractInstance | undefined> {
                const [contract] = await db
                        .select()
                        .from(contractInstances)
                        .where(eq(contractInstances.id, id));
                return contract || undefined;
        }

        async getContractBySigningToken(
                token: string,
        ): Promise<ContractInstance | undefined> {
                const [contract] = await db
                        .select()
                        .from(contractInstances)
                        .where(eq(contractInstances.signingToken, token));
                return contract || undefined;
        }

        async createContract(
                contract: InsertContractInstance,
        ): Promise<ContractInstance> {
                const [newContract] = await db
                        .insert(contractInstances)
                        .values(contract)
                        .returning();
                return newContract;
        }

        async updateContract(
                id: string,
                contract: Partial<ContractInstance>,
        ): Promise<ContractInstance> {
                const [updatedContract] = await db
                        .update(contractInstances)
                        .set(contract)
                        .where(eq(contractInstances.id, id))
                        .returning();
                return updatedContract;
        }

        async deleteContract(id: string): Promise<void> {
                // Nullify contractInstanceId in activity log for this contract
                await db
                        .update(activityLog)
                        .set({ contractInstanceId: null })
                        .where(eq(activityLog.contractInstanceId, id));
                // Nullify contractInstanceId in attention items for this contract
                await db
                        .update(attentionItems)
                        .set({ contractInstanceId: null })
                        .where(eq(attentionItems.contractInstanceId, id));
                // Delete the contract
                await db.delete(contractInstances).where(eq(contractInstances.id, id));
        }

        async archiveContract(id: string): Promise<ContractInstance> {
                const [archivedContract] = await db
                        .update(contractInstances)
                        .set({ archivedAt: new Date() })
                        .where(eq(contractInstances.id, id))
                        .returning();
                return archivedContract;
        }

        async getContractsForEmployee(
                employeeId: string,
        ): Promise<ContractInstance[]> {
                return db
                        .select()
                        .from(contractInstances)
                        .where(eq(contractInstances.employeeId, employeeId))
                        .orderBy(desc(contractInstances.createdAt));
        }

        async getActiveContractForEmployee(
                employeeId: string,
        ): Promise<ContractInstance | undefined> {
                const [contract] = await db
                        .select()
                        .from(contractInstances)
                        .where(
                                and(
                                        eq(contractInstances.employeeId, employeeId),
                                        eq(contractInstances.status, "active"),
                                ),
                        );
                return contract || undefined;
        }

        async supersedeActiveContract(
                employeeId: string,
                newActiveContractId: string,
        ): Promise<void> {
                // Find any active contracts for this employee (excluding the new one)
                const activeContracts = await db
                        .select()
                        .from(contractInstances)
                        .where(
                                and(
                                        eq(contractInstances.employeeId, employeeId),
                                        eq(contractInstances.status, "active"),
                                ),
                        );

                // Mark all existing active contracts as superseded
                for (const contract of activeContracts) {
                        if (contract.id !== newActiveContractId) {
                                await db
                                        .update(contractInstances)
                                        .set({ status: "superseded" })
                                        .where(eq(contractInstances.id, contract.id));
                        }
                }
        }

        async getEmployeeChanges(employeeId: string): Promise<EmployeeChange[]> {
                return db
                        .select()
                        .from(employeeChanges)
                        .where(eq(employeeChanges.employeeId, employeeId))
                        .orderBy(desc(employeeChanges.effectiveDate));
        }

        async createEmployeeChange(
                change: InsertEmployeeChange,
        ): Promise<EmployeeChange> {
                const [newChange] = await db
                        .insert(employeeChanges)
                        .values(change)
                        .returning();
                return newChange;
        }

        async updateEmployeeChange(
                id: string,
                change: Partial<EmployeeChange>,
        ): Promise<EmployeeChange> {
                const [updatedChange] = await db
                        .update(employeeChanges)
                        .set(change)
                        .where(eq(employeeChanges.id, id))
                        .returning();
                return updatedChange;
        }

        async getSettings(): Promise<Setting[]> {
                return db.select().from(settings);
        }

        async getSetting(key: string): Promise<Setting | undefined> {
                const [setting] = await db
                        .select()
                        .from(settings)
                        .where(eq(settings.key, key));
                return setting || undefined;
        }

        async upsertSetting(setting: InsertSetting): Promise<Setting> {
                const existing = await this.getSetting(setting.key);
                if (existing) {
                        const [updated] = await db
                                .update(settings)
                                .set({ value: setting.value, updatedAt: new Date() })
                                .where(eq(settings.key, setting.key))
                                .returning();
                        return updated;
                }
                const [newSetting] = await db
                        .insert(settings)
                        .values(setting)
                        .returning();
                return newSetting;
        }

        async getActivityLogs(options?: {
                branchId?: string;
                branchIds?: string[];
                employeeId?: string;
                contractInstanceId?: string;
                types?: ActivityType[];
                limit?: number;
                offset?: number;
                dateFrom?: Date;
                dateTo?: Date;
                search?: string;
        }): Promise<ActivityLog[]> {
                const limit = options?.limit ?? 20;
                const offset = options?.offset ?? 0;

                const conditions = this.buildActivityLogConditions(options);

                if (conditions.length > 0) {
                        return db
                                .select()
                                .from(activityLog)
                                .where(and(...conditions))
                                .orderBy(desc(activityLog.createdAt))
                                .limit(limit)
                                .offset(offset);
                }

                return db
                        .select()
                        .from(activityLog)
                        .orderBy(desc(activityLog.createdAt))
                        .limit(limit)
                        .offset(offset);
        }

        async getActivityLogCount(options?: {
                branchId?: string;
                branchIds?: string[];
                employeeId?: string;
                contractInstanceId?: string;
                types?: ActivityType[];
                dateFrom?: Date;
                dateTo?: Date;
                search?: string;
        }): Promise<number> {
                const conditions = this.buildActivityLogConditions(options);

                const [result] = await db
                        .select({ count: sql<number>`count(*)::int` })
                        .from(activityLog)
                        .where(conditions.length > 0 ? and(...conditions) : undefined);

                return result?.count ?? 0;
        }

        private buildActivityLogConditions(options?: {
                branchId?: string;
                branchIds?: string[];
                employeeId?: string;
                contractInstanceId?: string;
                types?: ActivityType[];
                dateFrom?: Date;
                dateTo?: Date;
                search?: string;
        }): any[] {
                const conditions: any[] = [];

                if (options?.branchId) {
                        conditions.push(eq(activityLog.branchId, options.branchId));
                }

                if (options?.branchIds !== undefined) {
                        conditions.push(options.branchIds.length > 0
                                ? inArray(activityLog.branchId, options.branchIds)
                                : sql`false`);
                }

                if (options?.employeeId) {
                        conditions.push(eq(activityLog.employeeId, options.employeeId));
                }

                if (options?.contractInstanceId) {
                        conditions.push(
                                eq(activityLog.contractInstanceId, options.contractInstanceId),
                        );
                }

                if (options?.types && options.types.length > 0) {
                        conditions.push(inArray(activityLog.activityType, options.types));
                }

                if (options?.dateFrom) {
                        conditions.push(gte(activityLog.createdAt, options.dateFrom));
                }

                if (options?.dateTo) {
                        conditions.push(lte(activityLog.createdAt, options.dateTo));
                }

                if (options?.search) {
                        conditions.push(
                                ilike(activityLog.summaryText, `%${options.search}%`),
                        );
                }

                return conditions;
        }

        async getActivitySummary(options?: {
                branchId?: string;
                branchIds?: string[];
                sinceDays?: number;
        }): Promise<Record<string, number>> {
                const days = options?.sinceDays ?? 30;
                const sinceDate = new Date();
                sinceDate.setDate(sinceDate.getDate() - days);

                const employeeChangeTypes: ActivityType[] = [
                        "promotion",
                        "salary_change",
                        "incentive_change",
                        "employment_ended",
                ];

                const conditions = this.buildActivityLogConditions({
                        branchId: options?.branchId,
                        branchIds: options?.branchIds,
                        dateFrom: sinceDate,
                        types: employeeChangeTypes,
                });

                const results = await db
                        .select({
                                activityType: activityLog.activityType,
                                count: sql<number>`count(*)::int`,
                        })
                        .from(activityLog)
                        .where(and(...conditions))
                        .groupBy(activityLog.activityType);

                const summary: Record<string, number> = {
                        promotion: 0,
                        salary_change: 0,
                        incentive_change: 0,
                        employment_ended: 0,
                        total: 0,
                };

                for (const row of results) {
                        summary[row.activityType] = row.count;
                        summary.total += row.count;
                }

                return summary;
        }

        async createActivityLog(log: InsertActivityLog): Promise<ActivityLog> {
                try {
                        const [newLog] = await db
                                .insert(activityLog)
                                .values(log)
                                .returning();
                        return newLog;
                } catch (error) {
                        console.error("Failed to create activity log:", error);
                        throw error;
                }
        }

        async getAttentionItems(options?: {
                branchId?: string;
                scope?: { tenantId: string; branchIds: string[] };
                types?: AttentionType[];
                resolved?: boolean;
                limit?: number;
        }): Promise<AttentionItem[]> {
                const limit = options?.limit ?? 100;
                const showResolved = options?.resolved ?? false;

                const conditions = [];

                if (options?.scope) {
                        conditions.push(attentionReadScope(options.scope));
                }

                if (!showResolved) {
                        conditions.push(eq(attentionItems.status, "open"));
                }

                if (options?.branchId) {
                        conditions.push(eq(attentionItems.branchId, options.branchId));
                }

                if (options?.types && options.types.length > 0) {
                        conditions.push(inArray(attentionItems.type, options.types));
                }

                const query =
                        conditions.length > 0
                                ? db
                                                .select()
                                                .from(attentionItems)
                                                .where(and(...conditions))
                                                .orderBy(desc(attentionItems.createdAt))
                                                .limit(limit)
                                : db
                                                .select()
                                                .from(attentionItems)
                                                .orderBy(desc(attentionItems.createdAt))
                                                .limit(limit);

                return query;
        }

        async getAttentionItemCounts(
                branchId?: string,
                scope?: { tenantId: string; branchIds: string[] },
        ): Promise<{ total: number; high: number; medium: number; low: number }> {
                const conditions = [eq(attentionItems.status, "open")];

                if (branchId) {
                        conditions.push(eq(attentionItems.branchId, branchId));
                }
                if (scope) {
                        conditions.push(attentionReadScope(scope));
                }

                const results = await db
                        .select({
                                severity: attentionItems.severity,
                                count: sql<number>`count(*)::int`,
                        })
                        .from(attentionItems)
                        .where(and(...conditions))
                        .groupBy(attentionItems.severity);

                const counts = { total: 0, high: 0, medium: 0, low: 0 };

                for (const row of results) {
                        counts[row.severity as keyof typeof counts] = row.count;
                        counts.total += row.count;
                }

                return counts;
        }

        async createAttentionItem(
                item: InsertAttentionItem,
        ): Promise<AttentionItem> {
                const [newItem] = await db
                        .insert(attentionItems)
                        .values(item)
                        .returning();
                return newItem;
        }

        async resolveAttentionItem(
                id: string,
                userId: string,
                permanent = false,
        ): Promise<AttentionItem> {
                const now = new Date();
                const suppressUntil = permanent
                        ? new Date("2050-01-01T00:00:00.000Z")
                        : new Date(now.getTime() + 24 * 60 * 60 * 1000); // suppress for 24 hours
                const [resolved] = await db
                        .update(attentionItems)
                        .set({
                                status: "resolved",
                                resolvedAt: now,
                                resolvedBy: userId,
                                suppressUntil,
                                updatedAt: now,
                        })
                        .where(eq(attentionItems.id, id))
                        .returning();
                return resolved;
        }

        async deleteAttentionItemsByType(
                type: AttentionType,
                employeeId?: string,
        ): Promise<void> {
                if (employeeId) {
                        await db
                                .delete(attentionItems)
                                .where(
                                        and(
                                                eq(attentionItems.type, type),
                                                eq(attentionItems.employeeId, employeeId),
                                        ),
                                );
                } else {
                        await db
                                .delete(attentionItems)
                                .where(eq(attentionItems.type, type));
                }
        }

        async upsertAttentionItem(
                item: InsertAttentionItem & {
                        ruleKey: string;
                        entityKey: string;
                        fingerprint?: string;
                },
        ): Promise<{
                action: "created" | "updated" | "unchanged" | "suppressed";
                item: AttentionItem;
        }> {
                const now = new Date();

                // Check for any existing item (open OR resolved) with the same rule+entity fingerprint
                const [anyExisting] = await db
                        .select()
                        .from(attentionItems)
                        .where(
                                and(
                                        eq(attentionItems.ruleKey, item.ruleKey),
                                        eq(attentionItems.entityKey, item.entityKey),
                                ),
                        )
                        .orderBy(attentionItems.updatedAt)
                        .limit(1);

                if (anyExisting) {
                        // If there's an open item, update it if fingerprint changed
                        if (anyExisting.status === "open") {
                                if (anyExisting.fingerprint === item.fingerprint) {
                                        return { action: "unchanged", item: anyExisting };
                                }
                                const [updated] = await db
                                        .update(attentionItems)
                                        .set({
                                                severity: item.severity,
                                                title: item.title,
                                                description: item.description,
                                                dueDate: item.dueDate,
                                                fingerprint: item.fingerprint,
                                                updatedAt: now,
                                        })
                                        .where(eq(attentionItems.id, anyExisting.id))
                                        .returning();
                                return { action: "updated", item: updated };
                        }

                        // If it was resolved, check suppress_until — skip creation if within suppression window
                        if (anyExisting.status === "resolved") {
                                const suppressUntil = (anyExisting as any)
                                        .suppressUntil as Date | null;
                                if (suppressUntil && suppressUntil > now) {
                                        return { action: "suppressed", item: anyExisting };
                                }
                                // Suppression window expired — re-open the item if the condition persists
                                const [reopened] = await db
                                        .update(attentionItems)
                                        .set({
                                                status: "open",
                                                severity: item.severity,
                                                title: item.title,
                                                description: item.description,
                                                dueDate: item.dueDate,
                                                fingerprint: item.fingerprint,
                                                resolvedAt: null,
                                                resolvedBy: null,
                                                updatedAt: now,
                                        })
                                        .where(eq(attentionItems.id, anyExisting.id))
                                        .returning();
                                return { action: "updated", item: reopened };
                        }
                }

                const [newItem] = await db
                        .insert(attentionItems)
                        .values({
                                ...item,
                                status: "open",
                        })
                        .returning();
                return { action: "created", item: newItem };
        }

        async autoResolveAttentionItems(
                ruleKey: string,
                entityKey: string,
        ): Promise<number> {
                const result = await db
                        .update(attentionItems)
                        .set({
                                status: "resolved",
                                resolvedAt: new Date(),
                                updatedAt: new Date(),
                        })
                        .where(
                                and(
                                        eq(attentionItems.ruleKey, ruleKey),
                                        eq(attentionItems.entityKey, entityKey),
                                        eq(attentionItems.status, "open"),
                                ),
                        )
                        .returning();
                return result.length;
        }

        async getOpenAttentionItemsForEntity(
                entityKey: string,
        ): Promise<AttentionItem[]> {
                return db
                        .select()
                        .from(attentionItems)
                        .where(
                                and(
                                        eq(attentionItems.entityKey, entityKey),
                                        eq(attentionItems.status, "open"),
                                ),
                        );
        }

        async getAttentionItem(id: string, scope?: AttentionReadScope): Promise<AttentionItem | undefined> {
                const [item] = await db
                        .select()
                        .from(attentionItems)
                        .where(and(eq(attentionItems.id, id), scope ? attentionReadScope(scope) : undefined));
                return item;
        }

        async getEmployeeDocuments(
                employeeId: string,
        ): Promise<EmployeeDocument[]> {
                return db
                        .select()
                        .from(employeeDocuments)
                        .where(eq(employeeDocuments.employeeId, employeeId))
                        .orderBy(desc(employeeDocuments.uploadedAt));
        }

        async getEmployeeDocument(
                id: string,
        ): Promise<EmployeeDocument | undefined> {
                const [doc] = await db
                        .select()
                        .from(employeeDocuments)
                        .where(eq(employeeDocuments.id, id));
                return doc;
        }

        async getEmployeeDocumentsByType(
                employeeId: string,
                docType: string,
        ): Promise<EmployeeDocument[]> {
                return db
                        .select()
                        .from(employeeDocuments)
                        .where(
                                and(
                                        eq(employeeDocuments.employeeId, employeeId),
                                        eq(employeeDocuments.documentType, docType),
                                ),
                        )
                        .orderBy(desc(employeeDocuments.uploadedAt));
        }

        async createEmployeeDocument(
                doc: InsertEmployeeDocument,
        ): Promise<EmployeeDocument> {
                const [newDoc] = await db
                        .insert(employeeDocuments)
                        .values(doc)
                        .returning();
                return newDoc;
        }

        async deleteEmployeeDocument(id: string): Promise<void> {
                await db.delete(employeeDocuments).where(eq(employeeDocuments.id, id));
        }

        // Policy document methods
        async getPolicyDocuments(): Promise<PolicyDocument[]> {
                return db
                        .select()
                        .from(policyDocuments)
                        .orderBy(desc(policyDocuments.versionInt));
        }

        async getPolicyDocument(id: string): Promise<PolicyDocument | undefined> {
                const [policy] = await db
                        .select()
                        .from(policyDocuments)
                        .where(eq(policyDocuments.id, id));
                return policy;
        }

        async getLatestPublishedPolicy(): Promise<PolicyDocument | undefined> {
                const [policy] = await db
                        .select()
                        .from(policyDocuments)
                        .where(eq(policyDocuments.status, "published"))
                        .orderBy(desc(policyDocuments.versionInt))
                        .limit(1);
                return policy;
        }

        async createPolicyDocument(
                policy: InsertPolicyDocument,
        ): Promise<PolicyDocument> {
                // Calculate next version number for this title
                const existingPolicies = await db
                        .select()
                        .from(policyDocuments)
                        .where(
                                eq(
                                        policyDocuments.title,
                                        policy.title || "Rules & Regulations",
                                ),
                        )
                        .orderBy(desc(policyDocuments.versionInt))
                        .limit(1);

                const nextVersion =
                        existingPolicies.length > 0
                                ? existingPolicies[0].versionInt + 1
                                : 1;

                // Calculate content hash
                const contentToHash = policy.contentHtml || "";
                const contentHash = await this.hashContent(contentToHash);

                const [newPolicy] = await db
                        .insert(policyDocuments)
                        .values({
                                ...policy,
                                versionInt: nextVersion,
                                contentHash,
                        })
                        .returning();
                return newPolicy;
        }

        async updatePolicyDocument(
                id: string,
                policy: Partial<InsertPolicyDocument>,
        ): Promise<PolicyDocument> {
                // Recalculate content hash if content changed
                let contentHash = undefined;
                if (policy.contentHtml !== undefined) {
                        contentHash = await this.hashContent(policy.contentHtml || "");
                }

                const [updated] = await db
                        .update(policyDocuments)
                        .set({
                                ...policy,
                                ...(contentHash ? { contentHash } : {}),
                                updatedAt: new Date(),
                        })
                        .where(eq(policyDocuments.id, id))
                        .returning();
                return updated;
        }

        async publishPolicyDocument(
                id: string,
                userId: string,
        ): Promise<PolicyDocument> {
                const [published] = await db
                        .update(policyDocuments)
                        .set({
                                status: "published",
                                publishedAt: new Date(),
                                updatedBy: userId,
                                updatedAt: new Date(),
                        })
                        .where(eq(policyDocuments.id, id))
                        .returning();
                return published;
        }

        async archivePolicyDocument(
                id: string,
                userId: string,
        ): Promise<PolicyDocument> {
                const [archived] = await db
                        .update(policyDocuments)
                        .set({
                                status: "archived",
                                updatedBy: userId,
                                updatedAt: new Date(),
                        })
                        .where(eq(policyDocuments.id, id))
                        .returning();
                return archived;
        }

        // Employee offboarding methods
        async getEmployeeOffboarding(
                employeeId: string,
        ): Promise<EmployeeOffboarding | undefined> {
                const [offboarding] = await db
                        .select()
                        .from(employeeOffboarding)
                        .where(eq(employeeOffboarding.employeeId, employeeId))
                        .orderBy(desc(employeeOffboarding.createdAt))
                        .limit(1);
                return offboarding;
        }

        async getOffboardingById(
                id: string,
        ): Promise<EmployeeOffboarding | undefined> {
                const [offboarding] = await db
                        .select()
                        .from(employeeOffboarding)
                        .where(eq(employeeOffboarding.id, id));
                return offboarding;
        }

        async createEmployeeOffboarding(
                offboarding: InsertEmployeeOffboarding,
        ): Promise<EmployeeOffboarding> {
                const [newOffboarding] = await db
                        .insert(employeeOffboarding)
                        .values(offboarding)
                        .returning();
                return newOffboarding;
        }

        async updateEmployeeOffboarding(
                id: string,
                offboarding: Partial<InsertEmployeeOffboarding>,
        ): Promise<EmployeeOffboarding> {
                const [updated] = await db
                        .update(employeeOffboarding)
                        .set({ ...offboarding, updatedAt: new Date() })
                        .where(eq(employeeOffboarding.id, id))
                        .returning();
                return updated;
        }

        // Offboarding checklist methods
        async getOffboardingChecklist(
                offboardingId: string,
        ): Promise<OffboardingChecklist[]> {
                return db
                        .select()
                        .from(offboardingChecklist)
                        .where(eq(offboardingChecklist.offboardingId, offboardingId))
                        .orderBy(offboardingChecklist.sortOrder);
        }

        async createOffboardingChecklistItem(
                item: InsertOffboardingChecklist,
        ): Promise<OffboardingChecklist> {
                const [created] = await db
                        .insert(offboardingChecklist)
                        .values(item)
                        .returning();
                return created;
        }

        async updateOffboardingChecklistItem(
                id: string,
                updates: Partial<OffboardingChecklist>,
        ): Promise<OffboardingChecklist> {
                const [updated] = await db
                        .update(offboardingChecklist)
                        .set(updates)
                        .where(eq(offboardingChecklist.id, id))
                        .returning();
                return updated;
        }

        async deleteOffboardingChecklistItem(id: string): Promise<void> {
                await db
                        .delete(offboardingChecklist)
                        .where(eq(offboardingChecklist.id, id));
        }

        // Employee letters methods
        async getEmployeeLetters(employeeId: string): Promise<EmployeeLetter[]> {
                return db
                        .select()
                        .from(employeeLetters)
                        .where(eq(employeeLetters.employeeId, employeeId))
                        .orderBy(desc(employeeLetters.createdAt));
        }

        async getEmployeeLetter(id: string): Promise<EmployeeLetter | undefined> {
                const [letter] = await db
                        .select()
                        .from(employeeLetters)
                        .where(eq(employeeLetters.id, id));
                return letter;
        }

        async getEmployeeLetterByToken(
                token: string,
        ): Promise<EmployeeLetter | undefined> {
                const [letter] = await db
                        .select()
                        .from(employeeLetters)
                        .where(eq(employeeLetters.signingToken, token));
                return letter;
        }

        async getUnsignedLettersCount(branchId?: string): Promise<number> {
                const conditions = [eq(employeeLetters.status, "signing_link_created")];
                if (branchId) {
                        conditions.push(eq(employeeLetters.branchId, branchId));
                }
                const [result] = await db
                        .select({ count: sql<number>`count(*)::int` })
                        .from(employeeLetters)
                        .where(and(...conditions));
                return result?.count || 0;
        }

        async createEmployeeLetter(
                letter: InsertEmployeeLetter,
        ): Promise<EmployeeLetter> {
                const [newLetter] = await db
                        .insert(employeeLetters)
                        .values(letter)
                        .returning();
                return newLetter;
        }

        async updateEmployeeLetter(
                id: string,
                letter: Partial<EmployeeLetter>,
        ): Promise<EmployeeLetter> {
                const [updated] = await db
                        .update(employeeLetters)
                        .set({ ...letter, updatedAt: new Date() })
                        .where(eq(employeeLetters.id, id))
                        .returning();
                return updated;
        }

        // Asset catalog methods
        async getAssetCatalog(): Promise<AssetCatalog[]> {
                return db
                        .select()
                        .from(assetCatalog)
                        .where(eq(assetCatalog.isActive, true))
                        .orderBy(assetCatalog.name);
        }

        async getAssetCatalogItem(id: string): Promise<AssetCatalog | undefined> {
                const [item] = await db
                        .select()
                        .from(assetCatalog)
                        .where(eq(assetCatalog.id, id));
                return item;
        }

        async createAssetCatalogItem(
                item: InsertAssetCatalog,
        ): Promise<AssetCatalog> {
                const [newItem] = await db
                        .insert(assetCatalog)
                        .values(item)
                        .returning();
                return newItem;
        }

        async updateAssetCatalogItem(
                id: string,
                item: Partial<InsertAssetCatalog>,
        ): Promise<AssetCatalog> {
                const [updated] = await db
                        .update(assetCatalog)
                        .set(item)
                        .where(eq(assetCatalog.id, id))
                        .returning();
                return updated;
        }

        async deleteAssetCatalogItem(id: string): Promise<void> {
                await db
                        .update(assetCatalog)
                        .set({ isActive: false })
                        .where(eq(assetCatalog.id, id));
        }

        // Employee assets methods
        async getEmployeeAssets(employeeId: string): Promise<EmployeeAsset[]> {
                return db
                        .select()
                        .from(employeeAssets)
                        .where(eq(employeeAssets.employeeId, employeeId))
                        .orderBy(desc(employeeAssets.assignedAt));
        }

        async getEmployeeAsset(id: string): Promise<EmployeeAsset | undefined> {
                const [asset] = await db
                        .select()
                        .from(employeeAssets)
                        .where(eq(employeeAssets.id, id));
                return asset;
        }

        async createEmployeeAsset(
                asset: InsertEmployeeAsset,
        ): Promise<EmployeeAsset> {
                const [newAsset] = await db
                        .insert(employeeAssets)
                        .values(asset)
                        .returning();
                return newAsset;
        }

        async updateEmployeeAsset(
                id: string,
                asset: Partial<EmployeeAsset>,
        ): Promise<EmployeeAsset> {
                const [updated] = await db
                        .update(employeeAssets)
                        .set({ ...asset, updatedAt: new Date() })
                        .where(eq(employeeAssets.id, id))
                        .returning();
                return updated;
        }

        async returnEmployeeAsset(
                id: string,
                returnedBy: string,
                returnNotes?: string,
        ): Promise<EmployeeAsset> {
                const [updated] = await db
                        .update(employeeAssets)
                        .set({
                                returnedAt: new Date(),
                                returnedBy,
                                returnNotes,
                                updatedAt: new Date(),
                        })
                        .where(eq(employeeAssets.id, id))
                        .returning();
                return updated;
        }

        async getUnreturnedAssetsForEmployee(
                employeeId: string,
        ): Promise<EmployeeAsset[]> {
                return db
                        .select()
                        .from(employeeAssets)
                        .where(
                                and(
                                        eq(employeeAssets.employeeId, employeeId),
                                        eq(employeeAssets.returnRequired, true),
                                        sql`${employeeAssets.returnedAt} IS NULL`,
                                ),
                        )
                        .orderBy(employeeAssets.assetNameSnapshot);
        }

        async getUnreturnedAssetsCount(branchId?: string): Promise<number> {
                const conditions = [
                        eq(employeeAssets.returnRequired, true),
                        sql`${employeeAssets.returnedAt} IS NULL`,
                ];
                if (branchId) {
                        conditions.push(eq(employeeAssets.branchId, branchId));
                }
                const [result] = await db
                        .select({ count: sql<number>`count(*)::int` })
                        .from(employeeAssets)
                        .where(and(...conditions));
                return result?.count || 0;
        }

        async updateAssetsExpectedReturnBy(
                employeeId: string,
                expectedReturnBy: Date,
        ): Promise<void> {
                await db
                        .update(employeeAssets)
                        .set({ expectedReturnBy, updatedAt: new Date() })
                        .where(
                                and(
                                        eq(employeeAssets.employeeId, employeeId),
                                        eq(employeeAssets.returnRequired, true),
                                        sql`${employeeAssets.returnedAt} IS NULL`,
                                ),
                        );
        }

        // Employment state methods
        async getEmployeesInLeavingState(): Promise<Employee[]> {
                return db
                        .select()
                        .from(employees)
                        .where(eq(employees.employmentState, "LEAVING"));
        }

        async updateEmployeeState(
                id: string,
                state: "ACTIVE" | "LEAVING" | "LEFT",
        ): Promise<Employee> {
                const [updated] = await db
                        .update(employees)
                        .set({ employmentState: state })
                        .where(eq(employees.id, id))
                        .returning();
                return updated;
        }

        // ==========================================
        // TIMEKEEPING / KIOSK SYSTEM
        // ==========================================

        // Kiosk devices
        async getKioskDevices(branchId?: string): Promise<KioskDevice[]> {
                if (branchId) {
                        return db
                                .select()
                                .from(kioskDevices)
                                .where(eq(kioskDevices.branchId, branchId))
                                .orderBy(kioskDevices.name);
                }
                return db.select().from(kioskDevices).orderBy(kioskDevices.name);
        }

        async getKioskDevice(id: string): Promise<KioskDevice | undefined> {
                const [device] = await db
                        .select()
                        .from(kioskDevices)
                        .where(eq(kioskDevices.id, id));
                return device;
        }

        async getKioskDeviceBySecret(
                secretHash: string,
        ): Promise<KioskDevice | undefined> {
                const [device] = await db
                        .select()
                        .from(kioskDevices)
                        .where(eq(kioskDevices.deviceSecretHash, secretHash));
                return device;
        }

        async createKioskDevice(device: InsertKioskDevice): Promise<KioskDevice> {
                const [created] = await db
                        .insert(kioskDevices)
                        .values(device)
                        .returning();
                return created;
        }

        async updateKioskDevice(
                id: string,
                device: Partial<InsertKioskDevice>,
        ): Promise<KioskDevice> {
                const [updated] = await db
                        .update(kioskDevices)
                        .set({ ...device, updatedAt: new Date() })
                        .where(eq(kioskDevices.id, id))
                        .returning();
                return updated;
        }

        async updateKioskDeviceLastSeen(id: string): Promise<void> {
                await db
                        .update(kioskDevices)
                        .set({ lastSeenAt: new Date() })
                        .where(eq(kioskDevices.id, id));
        }

        async deleteKioskDevice(id: string): Promise<void> {
                await db.delete(kioskDevices).where(eq(kioskDevices.id, id));
        }

        // Enrollment sessions
        async getEnrollmentSession(
                id: string,
        ): Promise<EnrollmentSession | undefined> {
                const [session] = await db
                        .select()
                        .from(enrollmentSessions)
                        .where(eq(enrollmentSessions.id, id));
                return session;
        }

        async getEnrollmentSessionByToken(
                tokenHash: string,
        ): Promise<EnrollmentSession | undefined> {
                const [session] = await db
                        .select()
                        .from(enrollmentSessions)
                        .where(eq(enrollmentSessions.tokenHash, tokenHash));
                return session;
        }

        async getEnrollmentSessionsForEmployee(
                employeeId: string,
        ): Promise<EnrollmentSession[]> {
                return db
                        .select()
                        .from(enrollmentSessions)
                        .where(eq(enrollmentSessions.employeeId, employeeId))
                        .orderBy(desc(enrollmentSessions.createdAt));
        }

        async createEnrollmentSession(
                session: InsertEnrollmentSession,
        ): Promise<EnrollmentSession> {
                const [created] = await db
                        .insert(enrollmentSessions)
                        .values(session)
                        .returning();
                return created;
        }

        async markEnrollmentSessionUsed(id: string): Promise<EnrollmentSession> {
                const [updated] = await db
                        .update(enrollmentSessions)
                        .set({ usedAt: new Date() })
                        .where(eq(enrollmentSessions.id, id))
                        .returning();
                return updated;
        }

        // Time events
        async getTimeEvents(options?: {
                branchId?: string;
                branchIds?: string[];
                employeeId?: string;
                dateFrom?: Date;
                dateTo?: Date;
                authMethod?: string;
                eventType?: string;
                limit?: number;
                offset?: number;
        }): Promise<TimeEvent[]> {
                const conditions = [];
                if (options?.branchId) {
                        conditions.push(eq(timeEvents.branchId, options.branchId));
                }
                if (options?.branchIds && options.branchIds.length > 0) {
                        conditions.push(inArray(timeEvents.branchId, options.branchIds));
                }
                if (options?.employeeId) {
                        conditions.push(eq(timeEvents.employeeId, options.employeeId));
                }
                if (options?.dateFrom) {
                        conditions.push(gte(timeEvents.eventTime, options.dateFrom));
                }
                if (options?.dateTo) {
                        conditions.push(lte(timeEvents.eventTime, options.dateTo));
                }
                if (options?.authMethod) {
                        conditions.push(
                                eq(timeEvents.authMethod, options.authMethod as any),
                        );
                }
                if (options?.eventType) {
                        conditions.push(eq(timeEvents.eventType, options.eventType as any));
                }

                let query = db.select().from(timeEvents);
                if (conditions.length > 0) {
                        query = query.where(and(...conditions)) as any;
                }
                query = query.orderBy(desc(timeEvents.eventTime)) as any;
                if (options?.limit) {
                        query = query.limit(options.limit) as any;
                }
                if (options?.offset) {
                        query = query.offset(options.offset) as any;
                }
                return query;
        }

        async getTimeEventsCount(options?: {
                branchId?: string;
                branchIds?: string[];
                employeeId?: string;
                dateFrom?: Date;
                dateTo?: Date;
                authMethod?: string;
                eventType?: string;
        }): Promise<number> {
                const conditions = [];
                if (options?.branchId) {
                        conditions.push(eq(timeEvents.branchId, options.branchId));
                }
                if (options?.branchIds && options.branchIds.length > 0) {
                        conditions.push(inArray(timeEvents.branchId, options.branchIds));
                }
                if (options?.employeeId) {
                        conditions.push(eq(timeEvents.employeeId, options.employeeId));
                }
                if (options?.dateFrom) {
                        conditions.push(gte(timeEvents.eventTime, options.dateFrom));
                }
                if (options?.dateTo) {
                        conditions.push(lte(timeEvents.eventTime, options.dateTo));
                }
                if (options?.authMethod) {
                        conditions.push(
                                eq(timeEvents.authMethod, options.authMethod as any),
                        );
                }
                if (options?.eventType) {
                        conditions.push(eq(timeEvents.eventType, options.eventType as any));
                }

                let query = db
                        .select({ count: sql<number>`count(*)::int` })
                        .from(timeEvents);
                if (conditions.length > 0) {
                        query = query.where(and(...conditions)) as any;
                }
                const [result] = await query;
                return result?.count || 0;
        }

        async getLastTimeEvent(employeeId: string): Promise<TimeEvent | undefined> {
                const [event] = await db
                        .select()
                        .from(timeEvents)
                        .where(eq(timeEvents.employeeId, employeeId))
                        .orderBy(desc(timeEvents.eventTime))
                        .limit(1);
                return event;
        }

        async getTimeEvent(id: string): Promise<TimeEvent | undefined> {
                const [event] = await db
                        .select()
                        .from(timeEvents)
                        .where(eq(timeEvents.id, id));
                return event;
        }

        async createTimeEvent(event: InsertTimeEvent): Promise<TimeEvent> {
                const [created] = await db.insert(timeEvents).values(event).returning();

                // Automatically update employee presence
                if (created.eventType === "IN" && created.tenantId) {
                        await this.updatePresenceOnClockIn(
                                created.employeeId,
                                created.branchId,
                                created.eventTime,
                                created.tenantId,
                        );
                } else if (created.eventType === "OUT" && created.tenantId) {
                        await this.updatePresenceOnClockOut(
                                created.employeeId,
                                created.eventTime,
                                created.tenantId,
                        );
                }

                return created;
        }

        async updateTimeEvent(
                id: string,
                event: Partial<InsertTimeEvent>,
        ): Promise<TimeEvent> {
                const [updated] = await db
                        .update(timeEvents)
                        .set(event)
                        .where(eq(timeEvents.id, id))
                        .returning();
                return updated;
        }

        async deleteTimeEvent(id: string): Promise<void> {
                await db.delete(timeEvents).where(eq(timeEvents.id, id));
        }

        async getEmployeePinUsageCount(
                employeeId: string,
                days: number,
        ): Promise<number> {
                const fromDate = new Date();
                fromDate.setDate(fromDate.getDate() - days);
                const [result] = await db
                        .select({ count: sql<number>`count(*)::int` })
                        .from(timeEvents)
                        .where(
                                and(
                                        eq(timeEvents.employeeId, employeeId),
                                        eq(timeEvents.authMethod, "PIN"),
                                        gte(timeEvents.eventTime, fromDate),
                                ),
                        );
                return result?.count || 0;
        }

        // Kiosk auth attempts
        async createKioskAuthAttempt(
                attempt: InsertKioskAuthAttempt,
        ): Promise<KioskAuthAttempt> {
                const [created] = await db
                        .insert(kioskAuthAttempts)
                        .values(attempt)
                        .returning();
                return created;
        }

        async getKioskAuthAttempts(options?: {
                branchId?: string;
                employeeId?: string;
                sessionId?: string;
                limit?: number;
        }): Promise<KioskAuthAttempt[]> {
                const conditions = [];
                if (options?.branchId) {
                        conditions.push(eq(kioskAuthAttempts.branchId, options.branchId));
                }
                if (options?.employeeId) {
                        conditions.push(
                                eq(kioskAuthAttempts.employeeId, options.employeeId),
                        );
                }
                if (options?.sessionId) {
                        conditions.push(eq(kioskAuthAttempts.sessionId, options.sessionId));
                }

                let query = db.select().from(kioskAuthAttempts);
                if (conditions.length > 0) {
                        query = query.where(and(...conditions)) as any;
                }
                query = query.orderBy(desc(kioskAuthAttempts.attemptTime)) as any;
                if (options?.limit) {
                        query = query.limit(options.limit) as any;
                }
                return query;
        }

        // Time entries (paired clock in/out)
        async getTimeEntries(options?: {
                branchId?: string;
                branchIds?: string[];
                employeeId?: string;
                dateFrom?: string;
                dateTo?: string;
                status?: string;
                limit?: number;
                offset?: number;
        }): Promise<TimeEntry[]> {
                const conditions = [];
                if (options?.branchId) {
                        conditions.push(eq(timeEntries.branchId, options.branchId));
                }
                if (options?.branchIds && options.branchIds.length > 0) {
                        conditions.push(inArray(timeEntries.branchId, options.branchIds));
                }
                if (options?.employeeId) {
                        conditions.push(eq(timeEntries.employeeId, options.employeeId));
                }
                if (options?.dateFrom) {
                        conditions.push(gte(timeEntries.shiftDate, options.dateFrom));
                }
                if (options?.dateTo) {
                        conditions.push(lte(timeEntries.shiftDate, options.dateTo));
                }
                if (options?.status) {
                        conditions.push(eq(timeEntries.status, options.status as any));
                }

                let query = db.select().from(timeEntries);
                if (conditions.length > 0) {
                        query = query.where(and(...conditions)) as any;
                }
                query = query.orderBy(desc(timeEntries.shiftDate)) as any;
                if (options?.limit) {
                        query = query.limit(options.limit) as any;
                }
                if (options?.offset) {
                        query = query.offset(options.offset) as any;
                }
                return query;
        }

        async getTimeEntry(id: string): Promise<TimeEntry | undefined> {
                const [entry] = await db
                        .select()
                        .from(timeEntries)
                        .where(eq(timeEntries.id, id));
                return entry;
        }

        async getOpenTimeEntry(
                employeeId: string,
                shiftDate: string,
        ): Promise<TimeEntry | undefined> {
                const [entry] = await db
                        .select()
                        .from(timeEntries)
                        .where(
                                and(
                                        eq(timeEntries.employeeId, employeeId),
                                        eq(timeEntries.shiftDate, shiftDate),
                                        isNull(timeEntries.clockOutAt),
                                ),
                        )
                        .orderBy(desc(timeEntries.clockInAt))
                        .limit(1);
                return entry;
        }

        async createTimeEntry(entry: InsertTimeEntry): Promise<TimeEntry> {
                const [created] = await db
                        .insert(timeEntries)
                        .values(entry)
                        .returning();
                return created;
        }

        async updateTimeEntry(
                id: string,
                entry: Partial<InsertTimeEntry>,
        ): Promise<TimeEntry> {
                const updateData = { ...entry, updatedAt: new Date() };
                const [updated] = await db
                        .update(timeEntries)
                        .set(updateData)
                        .where(eq(timeEntries.id, id))
                        .returning();
                return updated;
        }

        async deleteTimeEntry(id: string): Promise<void> {
                await db.delete(timeEntries).where(eq(timeEntries.id, id));
        }

        // Timekeeping issues
        async getTimekeepingIssues(options?: {
                branchId?: string;
                branchIds?: string[];
                employeeId?: string;
                dateFrom?: string;
                dateTo?: string;
                status?: string;
                issueType?: string;
                limit?: number;
                offset?: number;
        }): Promise<TimekeepingIssue[]> {
                const conditions = [];
                if (options?.branchId) {
                        conditions.push(eq(timekeepingIssues.branchId, options.branchId));
                }
                if (options?.branchIds && options.branchIds.length > 0) {
                        conditions.push(
                                inArray(timekeepingIssues.branchId, options.branchIds),
                        );
                }
                if (options?.employeeId) {
                        conditions.push(
                                eq(timekeepingIssues.employeeId, options.employeeId),
                        );
                }
                if (options?.dateFrom) {
                        conditions.push(gte(timekeepingIssues.issueDate, options.dateFrom));
                }
                if (options?.dateTo) {
                        conditions.push(lte(timekeepingIssues.issueDate, options.dateTo));
                }
                if (options?.status) {
                        conditions.push(
                                eq(timekeepingIssues.status, options.status as any),
                        );
                }
                if (options?.issueType) {
                        conditions.push(
                                eq(timekeepingIssues.issueType, options.issueType as any),
                        );
                }

                let query = db.select().from(timekeepingIssues);
                if (conditions.length > 0) {
                        query = query.where(and(...conditions)) as any;
                }
                query = query.orderBy(desc(timekeepingIssues.issueDate)) as any;
                if (options?.limit) {
                        query = query.limit(options.limit) as any;
                }
                if (options?.offset) {
                        query = query.offset(options.offset) as any;
                }
                return query;
        }

        async getTimekeepingIssuesCount(options?: {
                branchId?: string;
                branchIds?: string[];
                status?: string;
                dateFrom?: string;
                dateTo?: string;
        }): Promise<number> {
                const conditions = [];
                if (options?.branchId) {
                        conditions.push(eq(timekeepingIssues.branchId, options.branchId));
                }
                if (options?.branchIds && options.branchIds.length > 0) {
                        conditions.push(
                                inArray(timekeepingIssues.branchId, options.branchIds),
                        );
                }
                if (options?.status) {
                        conditions.push(
                                eq(timekeepingIssues.status, options.status as any),
                        );
                }
                if (options?.dateFrom) {
                        conditions.push(gte(timekeepingIssues.issueDate, options.dateFrom));
                }
                if (options?.dateTo) {
                        conditions.push(lte(timekeepingIssues.issueDate, options.dateTo));
                }

                let query = db
                        .select({ count: sql<number>`count(*)::int` })
                        .from(timekeepingIssues);
                if (conditions.length > 0) {
                        query = query.where(and(...conditions)) as any;
                }
                const [result] = await query;
                return result?.count || 0;
        }

        async getTimekeepingIssue(
                id: string,
        ): Promise<TimekeepingIssue | undefined> {
                const [issue] = await db
                        .select()
                        .from(timekeepingIssues)
                        .where(eq(timekeepingIssues.id, id));
                return issue;
        }

        async createTimekeepingIssue(
                issue: InsertTimekeepingIssue,
        ): Promise<TimekeepingIssue> {
                const [created] = await db
                        .insert(timekeepingIssues)
                        .values(issue)
                        .returning();
                return created;
        }

        async updateTimekeepingIssue(
                id: string,
                issue: Partial<InsertTimekeepingIssue>,
        ): Promise<TimekeepingIssue> {
                const updateData = { ...issue, updatedAt: new Date() };
                const [updated] = await db
                        .update(timekeepingIssues)
                        .set(updateData)
                        .where(eq(timekeepingIssues.id, id))
                        .returning();
                return updated;
        }

        async resolveTimekeepingIssue(
                id: string,
                resolvedBy: string,
                resolutionNote?: string,
        ): Promise<TimekeepingIssue> {
                const [updated] = await db
                        .update(timekeepingIssues)
                        .set({
                                status: "RESOLVED",
                                resolvedBy,
                                resolvedAt: new Date(),
                                resolutionNote,
                                updatedAt: new Date(),
                        })
                        .where(eq(timekeepingIssues.id, id))
                        .returning();
                return updated;
        }

        // Employee schedule helpers
        async getEmployeeScheduledShift(
                employeeId: string,
                date: string,
                preferredBranchId?: string,
        ): Promise<
                | {
                                assignmentId: string;
                                branchId: string;
                                branchName: string;
                                startTime: string;
                                endTime: string;
                                shiftDate: string;
                  }
                | undefined
        > {
                // Get all assignments for this employee on this date
                const assignments = await db
                        .select({
                                assignmentId: scheduleAssignments.id,
                                branchId: scheduleShiftRows.branchId,
                                branchName: branches.name,
                                startTime: scheduleShiftRows.startTime,
                                endTime: scheduleShiftRows.endTime,
                                shiftDate: scheduleAssignments.shiftDate,
                        })
                        .from(scheduleAssignments)
                        .innerJoin(
                                scheduleShiftRows,
                                eq(scheduleAssignments.shiftRowId, scheduleShiftRows.id),
                        )
                        .innerJoin(branches, eq(scheduleShiftRows.branchId, branches.id))
                        .where(
                                and(
                                        eq(scheduleAssignments.employeeId, employeeId),
                                        eq(scheduleAssignments.shiftDate, date),
                                ),
                        );

                if (assignments.length === 0) {
                        return undefined;
                }

                // Prefer the assignment for the kiosk branch if specified
                if (preferredBranchId) {
                        const preferredAssignment = assignments.find(
                                (a) => a.branchId === preferredBranchId,
                        );
                        if (preferredAssignment) {
                                return preferredAssignment;
                        }
                }

                // Otherwise return the first assignment
                return assignments[0];
        }

        async getEmployeeAnyScheduledShift(
                employeeId: string,
                date: string,
        ): Promise<boolean> {
                // Check if employee has ANY shift at ANY branch on this date
                const assignments = await db
                        .select({ id: scheduleAssignments.id })
                        .from(scheduleAssignments)
                        .where(
                                and(
                                        eq(scheduleAssignments.employeeId, employeeId),
                                        eq(scheduleAssignments.shiftDate, date),
                                ),
                        )
                        .limit(1);

                return assignments.length > 0;
        }

        // Employee face enrollment
        async updateEmployeeFaceEnrollment(
                id: string,
                faceId: string,
                status: "ENROLLED" | "SUSPENDED",
        ): Promise<Employee> {
                const [updated] = await db
                        .update(employees)
                        .set({
                                faceId,
                                faceEnrollmentStatus: status,
                                faceEnrolledAt: status === "ENROLLED" ? new Date() : null,
                        })
                        .where(eq(employees.id, id))
                        .returning();
                return updated;
        }

        async updateEmployeePin(id: string, pinHash: string): Promise<Employee> {
                const [updated] = await db
                        .update(employees)
                        .set({
                                timeclockPinHash: pinHash,
                                timeclockPinSetAt: new Date(),
                        })
                        .where(eq(employees.id, id))
                        .returning();
                return updated;
        }

        async getEmployeeByPhoneE164(
                phoneE164: string,
        ): Promise<Employee | undefined> {
                const [employee] = await db
                        .select()
                        .from(employees)
                        .where(eq(employees.phoneE164, phoneE164));
                return employee;
        }

        async getEmployeeByPhoneE164InTenant(
                phoneE164: string,
                tenantId: string,
        ): Promise<Employee | undefined> {
                const [employee] = await db
                        .select()
                        .from(employees)
                        .where(
                                and(
                                        eq(employees.phoneE164, phoneE164),
                                        eq(employees.tenantId, tenantId),
                                ),
                        );
                return employee;
        }

        async updateEmployeePhoneE164(
                id: string,
                phoneE164: string,
        ): Promise<Employee> {
                const [updated] = await db
                        .update(employees)
                        .set({ phoneE164, updatedAt: new Date() })
                        .where(eq(employees.id, id))
                        .returning();
                return updated;
        }

        async incrementEmployeePhoneFallbackUsage(id: string): Promise<void> {
                const employee = await this.getEmployee(id);
                if (!employee) return;

                const resetAt = employee.phoneFallbackCountResetAt
                        ? new Date(employee.phoneFallbackCountResetAt)
                        : null;
                const thirtyDaysAgo = new Date();
                thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

                if (!resetAt || resetAt < thirtyDaysAgo) {
                        await db
                                .update(employees)
                                .set({
                                        phoneFallbackCount30Day: 1,
                                        phoneFallbackCountResetAt: new Date(),
                                })
                                .where(eq(employees.id, id));
                } else {
                        await db
                                .update(employees)
                                .set({
                                        phoneFallbackCount30Day: sql`COALESCE(${employees.phoneFallbackCount30Day}, 0) + 1`,
                                })
                                .where(eq(employees.id, id));
                }
        }

        async getEmployeePhoneFallbackCount(
                employeeId: string,
                days: number,
        ): Promise<number> {
                const fromDate = new Date();
                fromDate.setDate(fromDate.getDate() - days);
                const [result] = await db
                        .select({ count: sql<number>`count(*)::int` })
                        .from(timeEvents)
                        .where(
                                and(
                                        eq(timeEvents.employeeId, employeeId),
                                        eq(timeEvents.authMethod, "PHONE_FALLBACK"),
                                        gte(timeEvents.eventTime, fromDate),
                                ),
                        );
                return result?.count || 0;
        }

        async incrementEmployeePinUsage(id: string): Promise<void> {
                const employee = await this.getEmployee(id);
                if (!employee) return;

                const resetAt = employee.pinUsageCountResetAt
                        ? new Date(employee.pinUsageCountResetAt)
                        : null;
                const thirtyDaysAgo = new Date();
                thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

                if (!resetAt || resetAt < thirtyDaysAgo) {
                        await db
                                .update(employees)
                                .set({
                                        pinUsageCount30Day: 1,
                                        pinUsageCountResetAt: new Date(),
                                })
                                .where(eq(employees.id, id));
                } else {
                        await db
                                .update(employees)
                                .set({
                                        pinUsageCount30Day: sql`COALESCE(${employees.pinUsageCount30Day}, 0) + 1`,
                                })
                                .where(eq(employees.id, id));
                }
        }

        async refreshEmployeePinUsageCount(id: string): Promise<number> {
                const count = await this.getEmployeePinUsageCount(id, 30);
                await db
                        .update(employees)
                        .set({
                                pinUsageCount30Day: count,
                                pinUsageCountResetAt: new Date(),
                        })
                        .where(eq(employees.id, id));
                return count;
        }

        private async hashContent(content: string): Promise<string> {
                const crypto = await import("crypto");
                return crypto.createHash("sha256").update(content).digest("hex");
        }

        async getEnrolledEmployees(branchId?: string): Promise<Employee[]> {
                const conditions = [eq(employees.faceEnrollmentStatus, "ENROLLED")];
                if (branchId) {
                        conditions.push(eq(employees.branchId, branchId));
                }
                return await db
                        .select()
                        .from(employees)
                        .where(and(...conditions));
        }

        async getEnrolledEmployeesInTenant(
                tenantId: string,
                branchId?: string,
        ): Promise<Employee[]> {
                const conditions = [
                        eq(employees.faceEnrollmentStatus, "ENROLLED"),
                        eq(employees.tenantId, tenantId),
                ];
                if (branchId) {
                        conditions.push(eq(employees.branchId, branchId));
                }
                return await db
                        .select()
                        .from(employees)
                        .where(and(...conditions));
        }

        // ============================================
        // DEPARTMENTS (company-wide, assigned to branches)
        // ============================================

        async getDepartments(branchId?: string): Promise<Department[]> {
                if (branchId) {
                        const assigned = await db
                                .select({
                                        departmentId: departmentBranchAssignments.departmentId,
                                })
                                .from(departmentBranchAssignments)
                                .where(eq(departmentBranchAssignments.branchId, branchId));
                        const departmentIds = assigned.map((a) => a.departmentId);
                        if (departmentIds.length === 0) return [];
                        return await db
                                .select()
                                .from(departments)
                                .where(inArray(departments.id, departmentIds))
                                .orderBy(departments.displayOrder, departments.name);
                }
                return await db
                        .select()
                        .from(departments)
                        .orderBy(departments.displayOrder, departments.name);
        }

        async getDepartmentsWithBranches(): Promise<DepartmentWithBranches[]> {
                const allDepts = await db
                        .select()
                        .from(departments)
                        .orderBy(departments.displayOrder, departments.name);
                const allAssignments = await db
                        .select()
                        .from(departmentBranchAssignments)
                        .innerJoin(
                                branches,
                                eq(departmentBranchAssignments.branchId, branches.id),
                        );

                return allDepts.map((dept) => {
                        const deptBranches = allAssignments
                                .filter(
                                        (a) =>
                                                a.department_branch_assignments.departmentId ===
                                                dept.id,
                                )
                                .map((a) => a.branches);
                        const employeeCount = 0;
                        return { ...dept, branches: deptBranches, employeeCount };
                });
        }

        async getDepartment(id: string): Promise<Department | undefined> {
                const [dept] = await db
                        .select()
                        .from(departments)
                        .where(eq(departments.id, id));
                return dept || undefined;
        }

        async getDepartmentWithBranches(
                id: string,
        ): Promise<DepartmentWithBranches | undefined> {
                const dept = await this.getDepartment(id);
                if (!dept) return undefined;

                const assignments = await db
                        .select()
                        .from(departmentBranchAssignments)
                        .innerJoin(
                                branches,
                                eq(departmentBranchAssignments.branchId, branches.id),
                        )
                        .where(eq(departmentBranchAssignments.departmentId, id));

                const deptBranches = assignments.map((a) => a.branches);
                const employeeCount = await this.getEmployeeCountByDepartment(id);
                return { ...dept, branches: deptBranches, employeeCount };
        }

        async createDepartment(
                department: InsertDepartment,
                branchIds?: string[],
                assignedBy?: string,
        ): Promise<Department> {
                const [dept] = await db
                        .insert(departments)
                        .values(department)
                        .returning();
                if (branchIds && branchIds.length > 0) {
                        await this.setDepartmentBranchAssignments(
                                dept.id,
                                branchIds,
                                assignedBy,
                        );
                }
                return dept;
        }

        async updateDepartment(
                id: string,
                updates: Partial<InsertDepartment>,
        ): Promise<Department> {
                const [dept] = await db
                        .update(departments)
                        .set({ ...updates, updatedAt: new Date() })
                        .where(eq(departments.id, id))
                        .returning();
                return dept;
        }

        async deactivateDepartment(id: string): Promise<Department> {
                const [dept] = await db
                        .update(departments)
                        .set({ isActive: false, updatedAt: new Date() })
                        .where(eq(departments.id, id))
                        .returning();
                return dept;
        }

        async reorderDepartments(orderedIds: string[]): Promise<void> {
                for (let i = 0; i < orderedIds.length; i++) {
                        await db
                                .update(departments)
                                .set({ displayOrder: i, updatedAt: new Date() })
                                .where(eq(departments.id, orderedIds[i]));
                }
        }

        async getEmployeeCountByDepartment(departmentId: string): Promise<number> {
                const result = await db
                        .select({ count: sql<number>`count(*)::int` })
                        .from(employees)
                        .where(eq(employees.primaryDepartmentId, departmentId));
                return result[0]?.count || 0;
        }

        async getDepartmentBranchAssignments(
                departmentId: string,
        ): Promise<DepartmentBranchAssignment[]> {
                return await db
                        .select()
                        .from(departmentBranchAssignments)
                        .where(eq(departmentBranchAssignments.departmentId, departmentId));
        }

        async setDepartmentBranchAssignments(
                departmentId: string,
                branchIds: string[],
                assignedBy?: string,
        ): Promise<void> {
                await db
                        .delete(departmentBranchAssignments)
                        .where(eq(departmentBranchAssignments.departmentId, departmentId));

                if (branchIds.length > 0) {
                        const values = branchIds.map((branchId) => ({
                                departmentId,
                                branchId,
                                assignedBy: assignedBy || null,
                        }));
                        await db.insert(departmentBranchAssignments).values(values);
                }
        }

        // ============================================
        // ROLES (company-wide)
        // ============================================

        async getRoles(): Promise<Role[]> {
                return await db.select().from(roles).orderBy(roles.name);
        }

        async getRole(id: string): Promise<Role | undefined> {
                const [role] = await db.select().from(roles).where(eq(roles.id, id));
                return role || undefined;
        }

        async createRole(role: InsertRole): Promise<Role> {
                const [newRole] = await db.insert(roles).values(role).returning();
                return newRole;
        }

        async updateRole(id: string, updates: Partial<InsertRole>): Promise<Role> {
                const [role] = await db
                        .update(roles)
                        .set({ ...updates, updatedAt: new Date() })
                        .where(eq(roles.id, id))
                        .returning();
                return role;
        }

        async deactivateRole(id: string): Promise<Role> {
                const [role] = await db
                        .update(roles)
                        .set({ isActive: false, updatedAt: new Date() })
                        .where(eq(roles.id, id))
                        .returning();
                return role;
        }

        async getEmployeeCountByRole(roleId: string): Promise<number> {
                const result = await db
                        .select({ count: sql<number>`count(*)::int` })
                        .from(employeeRoles)
                        .where(eq(employeeRoles.roleId, roleId));
                return result[0]?.count || 0;
        }

        async getEmployeesByRole(
                roleId: string,
        ): Promise<{ employeeId: string; roleId: string }[]> {
                const results = await db
                        .select({
                                employeeId: employeeRoles.employeeId,
                                roleId: employeeRoles.roleId,
                        })
                        .from(employeeRoles)
                        .where(eq(employeeRoles.roleId, roleId));
                return results;
        }

        async setRoleEmployees(
                roleId: string,
                employeeIds: string[],
        ): Promise<void> {
                // Delete existing role-employee mappings for this role
                await db.delete(employeeRoles).where(eq(employeeRoles.roleId, roleId));

                // Insert new mappings
                if (employeeIds.length > 0) {
                        await db.insert(employeeRoles).values(
                                employeeIds.map((employeeId) => ({
                                        employeeId,
                                        roleId,
                                        isPrimary: false,
                                })),
                        );
                }
        }

        async getRoleWithBranches(
                roleId: string,
        ): Promise<RoleWithBranches | undefined> {
                const role = await this.getRole(roleId);
                if (!role) return undefined;

                const branchAssignments = await db
                        .select({
                                branch: branches,
                        })
                        .from(roleBranchAssignments)
                        .innerJoin(
                                branches,
                                eq(roleBranchAssignments.branchId, branches.id),
                        )
                        .where(eq(roleBranchAssignments.roleId, roleId));

                const employeeCount = await this.getEmployeeCountByRole(roleId);

                return {
                        ...role,
                        branches: branchAssignments.map((ba) => ba.branch),
                        employeeCount,
                };
        }

        async setRoleBranchAssignments(
                roleId: string,
                branchIds: string[],
                assignedBy?: string,
        ): Promise<void> {
                // Delete existing assignments
                await db
                        .delete(roleBranchAssignments)
                        .where(eq(roleBranchAssignments.roleId, roleId));

                // Insert new assignments
                if (branchIds.length > 0) {
                        await db.insert(roleBranchAssignments).values(
                                branchIds.map((branchId) => ({
                                        roleId,
                                        branchId,
                                        assignedBy,
                                })),
                        );
                }
        }

        // ============================================
        // ROLE-DEPARTMENT MAPPING
        // ============================================

        async getRoleDepartmentMappings(
                roleId?: string,
                departmentId?: string,
        ): Promise<RoleDepartmentMap[]> {
                const conditions = [];
                if (roleId) conditions.push(eq(roleDepartmentMap.roleId, roleId));
                if (departmentId)
                        conditions.push(eq(roleDepartmentMap.departmentId, departmentId));

                if (conditions.length === 0) {
                        return await db.select().from(roleDepartmentMap);
                }
                return await db
                        .select()
                        .from(roleDepartmentMap)
                        .where(and(...conditions));
        }

        async createRoleDepartmentMapping(
                mapping: InsertRoleDepartmentMap,
        ): Promise<RoleDepartmentMap> {
                const [result] = await db
                        .insert(roleDepartmentMap)
                        .values(mapping)
                        .returning();
                return result;
        }

        async deleteRoleDepartmentMapping(
                roleId: string,
                departmentId: string,
        ): Promise<void> {
                await db
                        .delete(roleDepartmentMap)
                        .where(
                                and(
                                        eq(roleDepartmentMap.roleId, roleId),
                                        eq(roleDepartmentMap.departmentId, departmentId),
                                ),
                        );
        }

        // ============================================
        // EMPLOYEE ROLES (multi-role assignment)
        // ============================================

        async getEmployeeRoles(
                employeeId: string,
        ): Promise<(EmployeeRole & { role: Role })[]> {
                const results = await db
                        .select({
                                employeeRole: employeeRoles,
                                role: roles,
                        })
                        .from(employeeRoles)
                        .innerJoin(roles, eq(employeeRoles.roleId, roles.id))
                        .where(eq(employeeRoles.employeeId, employeeId));

                return results.map((r) => ({
                        ...r.employeeRole,
                        role: r.role,
                }));
        }

        async setEmployeeRoles(
                employeeId: string,
                roleIds: string[],
        ): Promise<void> {
                // Delete existing roles for this employee
                await db
                        .delete(employeeRoles)
                        .where(eq(employeeRoles.employeeId, employeeId));

                // Insert new roles
                if (roleIds.length > 0) {
                        const values = roleIds.map((roleId) => ({
                                employeeId,
                                roleId,
                        }));
                        await db.insert(employeeRoles).values(values);
                }
        }

        async setEmployeeDepartment(
                employeeId: string,
                departmentId: string | null,
        ): Promise<Employee> {
                const [emp] = await db
                        .update(employees)
                        .set({ primaryDepartmentId: departmentId })
                        .where(eq(employees.id, employeeId))
                        .returning();
                return emp;
        }

        // ============================================
        // SCHEDULING MODULE
        // ============================================

        async getShifts(options: {
                branchId: string;
                dateFrom: Date;
                dateTo: Date;
                departmentId?: string;
                employeeId?: string;
                status?: "OPEN" | "ASSIGNED";
        }): Promise<ShiftWithDetails[]> {
                const conditions = [
                        eq(shifts.branchId, options.branchId),
                        gte(shifts.startAt, options.dateFrom),
                        lte(shifts.startAt, options.dateTo),
                ];
                if (options.departmentId)
                        conditions.push(eq(shifts.departmentId, options.departmentId));
                if (options.employeeId)
                        conditions.push(eq(shifts.employeeId, options.employeeId));
                if (options.status) conditions.push(eq(shifts.status, options.status));

                const results = await db
                        .select({
                                shift: shifts,
                                employee: employees,
                                department: departments,
                        })
                        .from(shifts)
                        .leftJoin(employees, eq(shifts.employeeId, employees.id))
                        .leftJoin(departments, eq(shifts.departmentId, departments.id))
                        .where(and(...conditions))
                        .orderBy(shifts.startAt);

                // Get required roles for each shift
                const shiftsWithDetails: ShiftWithDetails[] = [];
                for (const r of results) {
                        const requiredRoles = await this.getShiftRequiredRoles(r.shift.id);
                        shiftsWithDetails.push({
                                ...r.shift,
                                employee: r.employee || undefined,
                                department: r.department || undefined,
                                requiredRoles,
                        });
                }
                return shiftsWithDetails;
        }

        async getShift(id: string): Promise<ShiftWithDetails | undefined> {
                const [result] = await db
                        .select({
                                shift: shifts,
                                employee: employees,
                                department: departments,
                        })
                        .from(shifts)
                        .leftJoin(employees, eq(shifts.employeeId, employees.id))
                        .leftJoin(departments, eq(shifts.departmentId, departments.id))
                        .where(eq(shifts.id, id));

                if (!result) return undefined;

                const requiredRoles = await this.getShiftRequiredRoles(id);
                return {
                        ...result.shift,
                        employee: result.employee || undefined,
                        department: result.department || undefined,
                        requiredRoles,
                };
        }

        async getOpenShiftsStartingSoon(
                branchId: string,
                withinHours: number,
        ): Promise<Shift[]> {
                const now = new Date();
                const threshold = new Date(
                        now.getTime() + withinHours * 60 * 60 * 1000,
                );
                return await db
                        .select()
                        .from(shifts)
                        .where(
                                and(
                                        eq(shifts.branchId, branchId),
                                        eq(shifts.status, "OPEN"),
                                        gte(shifts.startAt, now),
                                        lte(shifts.startAt, threshold),
                                ),
                        )
                        .orderBy(shifts.startAt);
        }

        async getShiftsNeedingCoverage(branchId?: string): Promise<Shift[]> {
                const conditions = [eq(shifts.needsCoverage, true)];
                if (branchId) conditions.push(eq(shifts.branchId, branchId));
                return await db
                        .select()
                        .from(shifts)
                        .where(and(...conditions))
                        .orderBy(shifts.startAt);
        }

        async createShift(
                shift: InsertShift,
                requiredRoleIds: string[],
        ): Promise<Shift> {
                const [newShift] = await db
                        .insert(shifts)
                        .values({
                                ...shift,
                                status: shift.employeeId ? "ASSIGNED" : "OPEN",
                        })
                        .returning();

                // Insert required roles
                if (requiredRoleIds.length > 0) {
                        await db
                                .insert(shiftRequiredRoles)
                                .values(
                                        requiredRoleIds.map((roleId) => ({
                                                shiftId: newShift.id,
                                                roleId,
                                        })),
                                );
                }
                return newShift;
        }

        async updateShift(
                id: string,
                shift: Partial<InsertShift>,
                requiredRoleIds?: string[],
        ): Promise<Shift> {
                // Update status based on employeeId if it's being changed
                const updateData: Partial<InsertShift> & { updatedAt: Date } = {
                        ...shift,
                        updatedAt: new Date(),
                };
                if ("employeeId" in shift) {
                        updateData.status = shift.employeeId ? "ASSIGNED" : "OPEN";
                        if (shift.employeeId) {
                                updateData.needsCoverage = false;
                        }
                }

                const [updated] = await db
                        .update(shifts)
                        .set(updateData)
                        .where(eq(shifts.id, id))
                        .returning();

                // Update required roles if provided
                if (requiredRoleIds !== undefined) {
                        await db
                                .delete(shiftRequiredRoles)
                                .where(eq(shiftRequiredRoles.shiftId, id));
                        if (requiredRoleIds.length > 0) {
                                await db
                                        .insert(shiftRequiredRoles)
                                        .values(
                                                requiredRoleIds.map((roleId) => ({
                                                        shiftId: id,
                                                        roleId,
                                                })),
                                        );
                        }
                }
                return updated;
        }

        async deleteShift(id: string): Promise<void> {
                await db.delete(shifts).where(eq(shifts.id, id));
        }

        async unassignShiftEmployee(
                id: string,
                needsCoverage = false,
        ): Promise<Shift> {
                const [updated] = await db
                        .update(shifts)
                        .set({
                                employeeId: null,
                                status: "OPEN",
                                needsCoverage,
                                updatedAt: new Date(),
                        })
                        .where(eq(shifts.id, id))
                        .returning();
                return updated;
        }

        async getShiftRequiredRoles(
                shiftId: string,
        ): Promise<(ShiftRequiredRole & { role: Role })[]> {
                const results = await db
                        .select({
                                shiftRequiredRole: shiftRequiredRoles,
                                role: roles,
                        })
                        .from(shiftRequiredRoles)
                        .innerJoin(roles, eq(shiftRequiredRoles.roleId, roles.id))
                        .where(eq(shiftRequiredRoles.shiftId, shiftId));

                return results.map((r) => ({
                        ...r.shiftRequiredRole,
                        role: r.role,
                }));
        }

        // Employee time off
        async getEmployeeTimeOff(options: {
                branchId?: string;
                employeeId?: string;
                dateFrom?: Date;
                dateTo?: Date;
        }): Promise<EmployeeTimeOff[]> {
                const conditions = [];
                if (options.branchId)
                        conditions.push(eq(employeeTimeOff.branchId, options.branchId));
                if (options.employeeId)
                        conditions.push(eq(employeeTimeOff.employeeId, options.employeeId));
                // Use date-only comparison to avoid timezone issues with time components
                if (options.dateFrom) {
                        const fromStr = options.dateFrom.toISOString().split("T")[0];
                        conditions.push(
                                sql`${employeeTimeOff.endDate}::date >= ${fromStr}::date`,
                        );
                }
                if (options.dateTo) {
                        const toStr = options.dateTo.toISOString().split("T")[0];
                        conditions.push(
                                sql`${employeeTimeOff.startDate}::date <= ${toStr}::date`,
                        );
                }

                if (conditions.length === 0) {
                        return await db
                                .select()
                                .from(employeeTimeOff)
                                .orderBy(desc(employeeTimeOff.startDate));
                }
                return await db
                        .select()
                        .from(employeeTimeOff)
                        .where(and(...conditions))
                        .orderBy(desc(employeeTimeOff.startDate));
        }

        async getTimeOffRecord(id: string): Promise<EmployeeTimeOff | undefined> {
                const [record] = await db
                        .select()
                        .from(employeeTimeOff)
                        .where(eq(employeeTimeOff.id, id));
                return record || undefined;
        }

        async getTimeOffForDateRange(
                employeeId: string,
                startDate: Date,
                endDate: Date,
        ): Promise<EmployeeTimeOff[]> {
                return await db
                        .select()
                        .from(employeeTimeOff)
                        .where(
                                and(
                                        eq(employeeTimeOff.employeeId, employeeId),
                                        lte(employeeTimeOff.startDate, endDate),
                                        gte(employeeTimeOff.endDate, startDate),
                                ),
                        );
        }

        async createEmployeeTimeOff(
                timeOff: InsertEmployeeTimeOff,
        ): Promise<EmployeeTimeOff> {
                const [record] = await db
                        .insert(employeeTimeOff)
                        .values(timeOff)
                        .returning();
                return record;
        }

        async updateEmployeeTimeOff(
                id: string,
                updates: Partial<InsertEmployeeTimeOff>,
        ): Promise<EmployeeTimeOff> {
                const [record] = await db
                        .update(employeeTimeOff)
                        .set({ ...updates, updatedAt: new Date() })
                        .where(eq(employeeTimeOff.id, id))
                        .returning();
                return record;
        }

        async deleteEmployeeTimeOff(id: string): Promise<void> {
                await db.delete(employeeTimeOff).where(eq(employeeTimeOff.id, id));
        }

        async deleteTimeOffByEmployeeAndDateRange(
                employeeId: string,
                branchId: string,
                startDate: string,
        ): Promise<EmployeeTimeOff[]> {
                const deleted = await db
                        .delete(employeeTimeOff)
                        .where(
                                and(
                                        eq(employeeTimeOff.employeeId, employeeId),
                                        eq(employeeTimeOff.branchId, branchId),
                                        gte(employeeTimeOff.startDate, new Date(startDate)),
                                ),
                        )
                        .returning();
                return deleted;
        }

        // Coverage rules (for V2)
        async getCoverageRules(branchId: string): Promise<CoverageRule[]> {
                return await db
                        .select()
                        .from(coverageRules)
                        .where(eq(coverageRules.branchId, branchId));
        }

        async createCoverageRule(rule: InsertCoverageRule): Promise<CoverageRule> {
                const [record] = await db
                        .insert(coverageRules)
                        .values(rule)
                        .returning();
                return record;
        }

        async deleteCoverageRule(id: string): Promise<void> {
                await db.delete(coverageRules).where(eq(coverageRules.id, id));
        }

        // Leave policies
        async getLeavePolicies(branchId?: string): Promise<LeavePolicy[]> {
                if (branchId) {
                        return await db
                                .select()
                                .from(leavePolicies)
                                .where(
                                        or(
                                                eq(leavePolicies.branchId, branchId),
                                                sql`${leavePolicies.branchId} IS NULL`,
                                        ),
                                )
                                .orderBy(desc(leavePolicies.createdAt));
                }
                return await db
                        .select()
                        .from(leavePolicies)
                        .orderBy(desc(leavePolicies.createdAt));
        }

        async getActiveLeavePolicy(
                branchId?: string,
        ): Promise<LeavePolicy | undefined> {
                const conditions = [eq(leavePolicies.isActive, true)];
                if (branchId) {
                        conditions.push(
                                or(
                                        eq(leavePolicies.branchId, branchId),
                                        sql`${leavePolicies.branchId} IS NULL`,
                                )!,
                        );
                }
                const [policy] = await db
                        .select()
                        .from(leavePolicies)
                        .where(and(...conditions))
                        .orderBy(desc(leavePolicies.effectiveFrom))
                        .limit(1);
                return policy;
        }

        async createLeavePolicy(policy: InsertLeavePolicy): Promise<LeavePolicy> {
                const [record] = await db
                        .insert(leavePolicies)
                        .values(policy)
                        .returning();
                return record;
        }

        async updateLeavePolicy(
                id: string,
                updates: Partial<InsertLeavePolicy>,
        ): Promise<LeavePolicy> {
                const [record] = await db
                        .update(leavePolicies)
                        .set({ ...updates, updatedAt: new Date() })
                        .where(eq(leavePolicies.id, id))
                        .returning();
                return record;
        }

        async deleteLeavePolicy(id: string): Promise<void> {
                await db.delete(leavePolicies).where(eq(leavePolicies.id, id));
        }

        async getEmployeeLeaveBalance(employeeId: string): Promise<LeaveBalance> {
                const employee = await this.getEmployee(employeeId);
                if (!employee) {
                        return {
                                employeeId,
                                daysWorked: 0,
                                daysEarned: 0,
                                daysUsed: 0,
                                balance: 0,
                                policyName: null,
                        };
                }

                const policy = await this.getActiveLeavePolicy(
                        employee.branchId || undefined,
                );
                const daysWorkedRequired = policy?.daysWorkedRequired || 5;
                const daysOffEarned = policy?.daysOffEarned || 2;

                const daysWorkedResult = await db
                        .select({
                                count: sql<number>`COUNT(DISTINCT ${scheduleAssignments.shiftDate})`,
                        })
                        .from(scheduleAssignments)
                        .where(eq(scheduleAssignments.employeeId, employeeId));
                const daysWorked = Number(daysWorkedResult[0]?.count || 0);

                const daysUsedResult = await db
                        .select({ count: sql<number>`COUNT(*)` })
                        .from(employeeTimeOff)
                        .where(
                                and(
                                        eq(employeeTimeOff.employeeId, employeeId),
                                        eq(employeeTimeOff.type, "CHANGE_DAY_OFF"),
                                ),
                        );
                const daysUsed = Number(daysUsedResult[0]?.count || 0);

                const daysEarned =
                        Math.floor(daysWorked / daysWorkedRequired) * daysOffEarned;
                const balance = daysEarned - daysUsed;

                return {
                        employeeId,
                        daysWorked,
                        daysEarned,
                        daysUsed,
                        balance,
                        policyName: policy?.name || null,
                };
        }

        async getBranchEmployeeLeaveBalances(
                branchId: string,
        ): Promise<LeaveBalance[]> {
                const branchEmployees = await db
                        .select()
                        .from(employees)
                        .where(
                                and(
                                        eq(employees.branchId, branchId),
                                        eq(employees.employmentState, "ACTIVE"),
                                ),
                        );

                const balances: LeaveBalance[] = [];
                for (const emp of branchEmployees) {
                        const balance = await this.getEmployeeLeaveBalance(emp.id);
                        balances.push(balance);
                }
                return balances;
        }

        // Sick leave policy and balance methods
        async getSickLeavePolicy(
                branchId?: string,
        ): Promise<SickLeavePolicy | undefined> {
                // First try to get branch-specific policy
                if (branchId) {
                        const [branchPolicy] = await db
                                .select()
                                .from(sickLeavePolicies)
                                .where(
                                        and(
                                                eq(sickLeavePolicies.branchId, branchId),
                                                eq(sickLeavePolicies.isActive, true),
                                        ),
                                );
                        if (branchPolicy) return branchPolicy;
                }

                // Fall back to tenant-wide policy (branchId is null)
                const [tenantPolicy] = await db
                        .select()
                        .from(sickLeavePolicies)
                        .where(
                                and(
                                        sql`${sickLeavePolicies.branchId} IS NULL`,
                                        eq(sickLeavePolicies.isActive, true),
                                ),
                        );
                return tenantPolicy;
        }

        async getOrCreateSickLeavePolicy(
                tenantId: string,
                branchId?: string,
        ): Promise<SickLeavePolicy> {
                const existing = await this.getSickLeavePolicy(branchId);
                if (existing) return existing;

                // Create default policy
                const [policy] = await db
                        .insert(sickLeavePolicies)
                        .values({
                                tenantId,
                                branchId: branchId || null,
                                annualSickLeaveDays: 30,
                                proRateByStartDate: true,
                                yearStartMonth: 1,
                                isActive: true,
                        })
                        .returning();
                return policy;
        }

        async updateSickLeavePolicy(
                id: string,
                data: Partial<InsertSickLeavePolicy>,
        ): Promise<SickLeavePolicy> {
                const [policy] = await db
                        .update(sickLeavePolicies)
                        .set({ ...data, updatedAt: new Date() })
                        .where(eq(sickLeavePolicies.id, id))
                        .returning();
                return policy;
        }

        async getEmployeeSickLeaveBalance(
                employeeId: string,
                year?: number,
        ): Promise<SickLeaveBalance> {
                const currentYear = year || new Date().getFullYear();
                const employee = await this.getEmployee(employeeId);

                if (!employee) {
                        return {
                                employeeId,
                                employeeName: "Unknown",
                                year: currentYear,
                                annualEntitlement: 30,
                                proRatedEntitlement: 0,
                                daysUsed: 0,
                                daysRemaining: 0,
                                startDate: null,
                                monthsInYear: 0,
                        };
                }

                // Get sick leave policy for the employee's branch
                const policy = await this.getSickLeavePolicy(
                        employee.branchId || undefined,
                );
                const annualDays = policy?.annualSickLeaveDays || 30;
                const proRate = policy?.proRateByStartDate !== false;

                // Calculate pro-rated entitlement based on start date
                let monthsInYear = 12;
                let proRatedEntitlement = annualDays;
                const startDate = employee.startDate;

                if (proRate && startDate) {
                        const startYear = new Date(startDate).getFullYear();
                        const startMonth = new Date(startDate).getMonth() + 1; // 1-based month

                        if (startYear === currentYear) {
                                // Employee started this year - pro-rate from start month
                                monthsInYear = 12 - startMonth + 1;
                                proRatedEntitlement = Math.round(
                                        (monthsInYear / 12) * annualDays,
                                );
                        } else if (startYear > currentYear) {
                                // Employee hasn't started yet
                                monthsInYear = 0;
                                proRatedEntitlement = 0;
                        }
                        // If startYear < currentYear, employee gets full entitlement
                }

                // Count sick days used in this calendar year
                const yearStart = new Date(currentYear, 0, 1);
                const yearEnd = new Date(currentYear, 11, 31, 23, 59, 59);

                const sickDaysResult = await db
                        .select({
                                count: sql<number>`COUNT(*)`,
                        })
                        .from(employeeTimeOff)
                        .where(
                                and(
                                        eq(employeeTimeOff.employeeId, employeeId),
                                        eq(employeeTimeOff.type, "SICK"),
                                        sql`${employeeTimeOff.startDate} >= ${yearStart}`,
                                        sql`${employeeTimeOff.startDate} <= ${yearEnd}`,
                                ),
                        );

                const daysUsed = Number(sickDaysResult[0]?.count || 0);
                const daysRemaining = Math.max(0, proRatedEntitlement - daysUsed);

                return {
                        employeeId,
                        employeeName: employee.fullName,
                        year: currentYear,
                        annualEntitlement: annualDays,
                        proRatedEntitlement,
                        daysUsed,
                        daysRemaining,
                        startDate,
                        monthsInYear,
                };
        }

        async getBranchEmployeeSickLeaveBalances(
                branchId: string,
                year?: number,
        ): Promise<SickLeaveBalance[]> {
                const branchEmployees = await db
                        .select()
                        .from(employees)
                        .where(
                                and(
                                        eq(employees.branchId, branchId),
                                        eq(employees.employmentState, "ACTIVE"),
                                ),
                        );

                const balances: SickLeaveBalance[] = [];
                for (const emp of branchEmployees) {
                        const balance = await this.getEmployeeSickLeaveBalance(
                                emp.id,
                                year,
                        );
                        balances.push(balance);
                }
                return balances;
        }

        // Public holidays methods
        async getPublicHolidays(
                tenantId: string,
                year?: number,
        ): Promise<PublicHoliday[]> {
                const conditions = [eq(publicHolidays.tenantId, tenantId)];
                if (year) {
                        conditions.push(eq(publicHolidays.year, year));
                }
                return db
                        .select()
                        .from(publicHolidays)
                        .where(and(...conditions))
                        .orderBy(publicHolidays.date);
        }

        async createPublicHoliday(
                data: InsertPublicHoliday,
        ): Promise<PublicHoliday> {
                const [holiday] = await db
                        .insert(publicHolidays)
                        .values(data)
                        .returning();
                return holiday;
        }

        async updatePublicHoliday(
                id: string,
                data: Partial<InsertPublicHoliday>,
        ): Promise<PublicHoliday> {
                const [holiday] = await db
                        .update(publicHolidays)
                        .set({ ...data, updatedAt: new Date() })
                        .where(eq(publicHolidays.id, id))
                        .returning();
                return holiday;
        }

        async deletePublicHoliday(id: string): Promise<void> {
                await db.delete(publicHolidays).where(eq(publicHolidays.id, id));
        }

        // Eligibility helpers
        async getEligibleEmployeesForShift(shiftId: string): Promise<Employee[]> {
                // Get the shift's required roles
                const requiredRoles = await this.getShiftRequiredRoles(shiftId);
                if (requiredRoles.length === 0) return [];

                const roleIds = requiredRoles.map((r) => r.roleId);
                const shift = await db
                        .select()
                        .from(shifts)
                        .where(eq(shifts.id, shiftId))
                        .then((r) => r[0]);
                if (!shift) return [];

                // Get employees who have ANY of the required roles and are in the same branch
                const eligibleEmployeeIds = await db
                        .selectDistinct({ id: employeeRoles.employeeId })
                        .from(employeeRoles)
                        .where(inArray(employeeRoles.roleId, roleIds));

                if (eligibleEmployeeIds.length === 0) return [];

                const ids = eligibleEmployeeIds.map((e) => e.id);

                // Get employees in the same branch who are active
                const eligibleEmployees = await db
                        .select()
                        .from(employees)
                        .where(
                                and(
                                        inArray(employees.id, ids),
                                        eq(employees.branchId, shift.branchId),
                                        eq(employees.employmentState, "ACTIVE"),
                                ),
                        );

                // Filter out employees who are on time off during the shift
                const result: Employee[] = [];
                for (const emp of eligibleEmployees) {
                        const timeOff = await this.getTimeOffForDateRange(
                                emp.id,
                                shift.startAt,
                                shift.endAt,
                        );
                        if (timeOff.length === 0) {
                                result.push(emp);
                        }
                }
                return result;
        }

        async getEmployeeShiftsOnDate(
                employeeId: string,
                date: Date,
        ): Promise<Shift[]> {
                const startOfDay = new Date(date);
                startOfDay.setHours(0, 0, 0, 0);
                const endOfDay = new Date(date);
                endOfDay.setHours(23, 59, 59, 999);

                return await db
                        .select()
                        .from(shifts)
                        .where(
                                and(
                                        eq(shifts.employeeId, employeeId),
                                        gte(shifts.startAt, startOfDay),
                                        lte(shifts.startAt, endOfDay),
                                ),
                        )
                        .orderBy(shifts.startAt);
        }

        // ============================================
        // EMPLOYEE PRESENCE (Directory API)
        // ============================================

        async getEmployeePresence(
                employeeId: string,
        ): Promise<EmployeePresence | undefined> {
                const [presence] = await db
                        .select()
                        .from(employeePresence)
                        .where(eq(employeePresence.employeeId, employeeId));
                return presence || undefined;
        }

        async upsertEmployeePresence(
                presence: InsertEmployeePresence,
        ): Promise<EmployeePresence> {
                const [result] = await db
                        .insert(employeePresence)
                        .values({ ...presence, updatedAt: new Date() })
                        .onConflictDoUpdate({
                                target: employeePresence.employeeId,
                                set: { ...presence, updatedAt: new Date() },
                        })
                        .returning();
                return result;
        }

        async updatePresenceOnClockIn(
                employeeId: string,
                branchId: string,
                eventTime: Date,
                tenantId: string,
        ): Promise<EmployeePresence> {
                // Check if this event is newer than the last recorded event to avoid backdated updates
                const existing = await this.getEmployeePresence(employeeId);
                if (
                        existing &&
                        existing.lastEventAt &&
                        eventTime < existing.lastEventAt
                ) {
                        // Backdated event - don't update current presence state, just return existing
                        return existing;
                }

                const [result] = await db
                        .insert(employeePresence)
                        .values({
                                employeeId,
                                tenantId,
                                isClockedIn: true,
                                currentWorkBranchId: branchId,
                                lastInAt: eventTime,
                                lastEventAt: eventTime,
                                lastEventType: "IN",
                                updatedAt: new Date(),
                        })
                        .onConflictDoUpdate({
                                target: employeePresence.employeeId,
                                set: {
                                        isClockedIn: true,
                                        currentWorkBranchId: branchId,
                                        lastInAt: eventTime,
                                        lastEventAt: eventTime,
                                        lastEventType: "IN",
                                        updatedAt: new Date(),
                                },
                        })
                        .returning();
                return result;
        }

        async updatePresenceOnClockOut(
                employeeId: string,
                eventTime: Date,
                tenantId: string,
        ): Promise<EmployeePresence> {
                // Check if this event is newer than the last recorded event to avoid backdated updates
                const existing = await this.getEmployeePresence(employeeId);
                if (
                        existing &&
                        existing.lastEventAt &&
                        eventTime < existing.lastEventAt
                ) {
                        // Backdated event - don't update current presence state, just return existing
                        return existing;
                }

                const [result] = await db
                        .insert(employeePresence)
                        .values({
                                employeeId,
                                tenantId,
                                isClockedIn: false,
                                currentWorkBranchId: null,
                                lastOutAt: eventTime,
                                lastEventAt: eventTime,
                                lastEventType: "OUT",
                                updatedAt: new Date(),
                        })
                        .onConflictDoUpdate({
                                target: employeePresence.employeeId,
                                set: {
                                        isClockedIn: false,
                                        currentWorkBranchId: null,
                                        lastOutAt: eventTime,
                                        lastEventAt: eventTime,
                                        lastEventType: "OUT",
                                        updatedAt: new Date(),
                                },
                        })
                        .returning();
                return result;
        }

        // Directory API helpers
        async getDirectoryEmployee(
                employeeId: string,
        ): Promise<
                | {
                                employee: Employee;
                                person: Person | null;
                                branch: Branch | null;
                                department: Department | null;
                                roles: Role[];
                                presence: EmployeePresence | null;
                  }
                | undefined
        > {
                const [employee] = await db
                        .select()
                        .from(employees)
                        .where(eq(employees.id, employeeId));
                if (!employee) return undefined;

                const person = employee.personId
                        ? (
                                        await db
                                                .select()
                                                .from(people)
                                                .where(eq(people.id, employee.personId))
                                )[0] || null
                        : null;

                const branch = employee.branchId
                        ? (
                                        await db
                                                .select()
                                                .from(branches)
                                                .where(eq(branches.id, employee.branchId))
                                )[0] || null
                        : null;

                const department = employee.primaryDepartmentId
                        ? (
                                        await db
                                                .select()
                                                .from(departments)
                                                .where(eq(departments.id, employee.primaryDepartmentId))
                                )[0] || null
                        : null;

                const empRoles = await db
                        .select({ role: roles })
                        .from(employeeRoles)
                        .innerJoin(roles, eq(employeeRoles.roleId, roles.id))
                        .where(eq(employeeRoles.employeeId, employeeId));

                const presence = await this.getEmployeePresence(employeeId);

                return {
                        employee,
                        person,
                        branch,
                        department,
                        roles: empRoles.map((r) => r.role),
                        presence: presence || null,
                };
        }

        async searchDirectoryEmployees(
                query: string,
                limit: number = 20,
        ): Promise<
                { employee: Employee; person: Person | null; branch: Branch | null }[]
        > {
                const searchPattern = `%${query}%`;
                const employeeResults = await db
                        .select()
                        .from(employees)
                        .where(
                                or(
                                        ilike(employees.fullName, searchPattern),
                                        ilike(employees.email, searchPattern),
                                ),
                        )
                        .limit(limit);

                const results: {
                        employee: Employee;
                        person: Person | null;
                        branch: Branch | null;
                }[] = [];
                for (const emp of employeeResults) {
                        const person = emp.personId
                                ? (
                                                await db
                                                        .select()
                                                        .from(people)
                                                        .where(eq(people.id, emp.personId))
                                        )[0] || null
                                : null;
                        const branch = emp.branchId
                                ? (
                                                await db
                                                        .select()
                                                        .from(branches)
                                                        .where(eq(branches.id, emp.branchId))
                                        )[0] || null
                                : null;
                        results.push({ employee: emp, person, branch });
                }

                return results;
        }

        async getDirectoryBranchRoster(
                branchId: string,
                status?: string,
        ): Promise<
                {
                        employee: Employee;
                        person: Person | null;
                        department: Department | null;
                        roles: Role[];
                        presence: EmployeePresence | null;
                }[]
        > {
                let conditions = [eq(employees.branchId, branchId)];
                if (status) {
                        conditions.push(eq(employees.employmentState, status as any));
                }

                const employeeList = await db
                        .select()
                        .from(employees)
                        .where(and(...conditions));

                const results: {
                        employee: Employee;
                        person: Person | null;
                        department: Department | null;
                        roles: Role[];
                        presence: EmployeePresence | null;
                }[] = [];
                for (const emp of employeeList) {
                        const person = emp.personId
                                ? (
                                                await db
                                                        .select()
                                                        .from(people)
                                                        .where(eq(people.id, emp.personId))
                                        )[0] || null
                                : null;

                        const department = emp.primaryDepartmentId
                                ? (
                                                await db
                                                        .select()
                                                        .from(departments)
                                                        .where(eq(departments.id, emp.primaryDepartmentId))
                                        )[0] || null
                                : null;

                        const empRoles = await db
                                .select({ role: roles })
                                .from(employeeRoles)
                                .innerJoin(roles, eq(employeeRoles.roleId, roles.id))
                                .where(eq(employeeRoles.employeeId, emp.id));

                        const presence = await this.getEmployeePresence(emp.id);

                        results.push({
                                employee: emp,
                                person,
                                department,
                                roles: empRoles.map((r) => r.role),
                                presence: presence || null,
                        });
                }

                return results;
        }

        // ============================================
        // RECONCILIATION HELPERS
        // ============================================

        async getStuckClockIns(
                hoursThreshold: number,
        ): Promise<EmployeePresence[]> {
                const cutoffTime = new Date(
                        Date.now() - hoursThreshold * 60 * 60 * 1000,
                );

                return db
                        .select()
                        .from(employeePresence)
                        .where(
                                and(
                                        eq(employeePresence.isClockedIn, true),
                                        lt(employeePresence.lastInAt, cutoffTime),
                                ),
                        );
        }

        async repairPresenceMismatches(): Promise<{
                mismatches: number;
                repairs: number;
                anomalies: number;
        }> {
                let mismatches = 0;
                let repairs = 0;
                let anomalies = 0;

                const allPresence = await db.select().from(employeePresence);

                for (const presence of allPresence) {
                        if (
                                !presence.isClockedIn &&
                                presence.currentWorkBranchId !== null
                        ) {
                                await db
                                        .update(employeePresence)
                                        .set({ currentWorkBranchId: null, updatedAt: new Date() })
                                        .where(
                                                eq(employeePresence.employeeId, presence.employeeId),
                                        );
                                mismatches++;
                                repairs++;
                        }

                        if (presence.isClockedIn && presence.currentWorkBranchId === null) {
                                mismatches++;
                                const lastInEvent = await db
                                        .select()
                                        .from(timeEvents)
                                        .where(
                                                and(
                                                        eq(timeEvents.employeeId, presence.employeeId),
                                                        eq(timeEvents.eventType, "IN"),
                                                ),
                                        )
                                        .orderBy(desc(timeEvents.eventTime))
                                        .limit(1);

                                if (lastInEvent.length > 0) {
                                        const lastOutEvent = await db
                                                .select()
                                                .from(timeEvents)
                                                .where(
                                                        and(
                                                                eq(timeEvents.employeeId, presence.employeeId),
                                                                eq(timeEvents.eventType, "OUT"),
                                                                gt(
                                                                        timeEvents.eventTime,
                                                                        lastInEvent[0].eventTime,
                                                                ),
                                                        ),
                                                )
                                                .limit(1);

                                        if (lastOutEvent.length === 0) {
                                                await db
                                                        .update(employeePresence)
                                                        .set({
                                                                currentWorkBranchId: lastInEvent[0].branchId,
                                                                updatedAt: new Date(),
                                                        })
                                                        .where(
                                                                eq(
                                                                        employeePresence.employeeId,
                                                                        presence.employeeId,
                                                                ),
                                                        );
                                                repairs++;
                                        } else {
                                                await db
                                                        .update(employeePresence)
                                                        .set({
                                                                isClockedIn: false,
                                                                currentWorkBranchId: null,
                                                                updatedAt: new Date(),
                                                        })
                                                        .where(
                                                                eq(
                                                                        employeePresence.employeeId,
                                                                        presence.employeeId,
                                                                ),
                                                        );
                                                repairs++;
                                        }
                                } else {
                                        await db
                                                .update(employeePresence)
                                                .set({
                                                        isClockedIn: false,
                                                        currentWorkBranchId: null,
                                                        updatedAt: new Date(),
                                                })
                                                .where(
                                                        eq(
                                                                employeePresence.employeeId,
                                                                presence.employeeId,
                                                        ),
                                                );
                                        anomalies++;
                                }
                        }
                }

                return { mismatches, repairs, anomalies };
        }

        async transitionLeavingToLeft(today: Date): Promise<number> {
                // Delete future schedule assignments for employees transitioning to LEFT
                await db.delete(scheduleAssignments).where(
                        and(
                                inArray(
                                        scheduleAssignments.employeeId,
                                        db
                                                .select({ id: employees.id })
                                                .from(employees)
                                                .where(
                                                        and(
                                                                eq(employees.employmentState, "LEAVING"),
                                                                lt(employees.lastWorkingDay, today),
                                                        ),
                                                ),
                                ),
                                gt(scheduleAssignments.shiftDate, today),
                        ),
                );

                // Clock out employees transitioning to LEFT
                await db
                        .update(employeePresence)
                        .set({ isClockedIn: false })
                        .where(
                                inArray(
                                        employeePresence.employeeId,
                                        db
                                                .select({ id: employees.id })
                                                .from(employees)
                                                .where(
                                                        and(
                                                                eq(employees.employmentState, "LEAVING"),
                                                                lt(employees.lastWorkingDay, today),
                                                        ),
                                                ),
                                ),
                        );

                const result = await db
                        .update(employees)
                        .set({
                                employmentState: "LEFT",
                        })
                        .where(
                                and(
                                        eq(employees.employmentState, "LEAVING"),
                                        lt(employees.lastWorkingDay, today),
                                ),
                        )
                        .returning();

                return result.length;
        }

        // ============================================
        // WEEK-BASED SCHEDULING (Planday-style)
        // ============================================

        async getWeekPlan(
                branchId: string,
                weekStartDate: string,
        ): Promise<ScheduleWeekPlanWithDetails | undefined> {
                // Query for week plan - may not exist yet (created on-demand when user creates assignments)
                const [weekPlan] = await db
                        .select()
                        .from(scheduleWeekPlans)
                        .where(
                                and(
                                        eq(scheduleWeekPlans.branchId, branchId),
                                        eq(scheduleWeekPlans.weekStartDate, weekStartDate),
                                ),
                        );

                const [branch] = await db
                        .select()
                        .from(branches)
                        .where(eq(branches.id, branchId));

                // Query shift rows by branch + date range overlap instead of weekPlanId
                // A shift row is active for a week if: activeFromDate <= weekEnd AND (activeUntilDate IS NULL OR activeUntilDate >= weekStart)
                const weekEnd = new Date(weekStartDate);
                weekEnd.setDate(weekEnd.getDate() + 6);
                const weekEndStr = weekEnd.toISOString().split("T")[0];

                const shiftRowsData = await db
                        .select()
                        .from(scheduleShiftRows)
                        .where(
                                and(
                                        eq(scheduleShiftRows.branchId, branchId),
                                        or(
                                                isNull(scheduleShiftRows.activeFromDate),
                                                sql`${scheduleShiftRows.activeFromDate} <= ${weekEndStr}::date`,
                                        ),
                                        or(
                                                isNull(scheduleShiftRows.activeUntilDate),
                                                sql`${scheduleShiftRows.activeUntilDate} >= ${weekStartDate}::date`,
                                        ),
                                ),
                        )
                        .orderBy(scheduleShiftRows.rowOrder);

                const shiftRows: ScheduleShiftRowWithDetails[] = await Promise.all(
                        shiftRowsData.map(async (row) => {
                                const [dept] = await db
                                        .select()
                                        .from(departments)
                                        .where(eq(departments.id, row.departmentId));

                                const rolesData = await db
                                        .select({
                                                id: scheduleShiftRowRoles.id,
                                                shiftRowId: scheduleShiftRowRoles.shiftRowId,
                                                roleId: scheduleShiftRowRoles.roleId,
                                                role: roles,
                                        })
                                        .from(scheduleShiftRowRoles)
                                        .leftJoin(roles, eq(scheduleShiftRowRoles.roleId, roles.id))
                                        .where(eq(scheduleShiftRowRoles.shiftRowId, row.id));

                                // Only fetch assignments if a week plan exists for this week
                                const assignmentsData = weekPlan
                                        ? await db
                                                        .select({
                                                                id: scheduleAssignments.id,
                                                                weekPlanId: scheduleAssignments.weekPlanId,
                                                                shiftRowId: scheduleAssignments.shiftRowId,
                                                                shiftDate: scheduleAssignments.shiftDate,
                                                                assigneeType: scheduleAssignments.assigneeType,
                                                                employeeId: scheduleAssignments.employeeId,
                                                                casualWorkerId:
                                                                        scheduleAssignments.casualWorkerId,
                                                                dailyRateSnapshot:
                                                                        scheduleAssignments.dailyRateSnapshot,
                                                                assignedAt: scheduleAssignments.assignedAt,
                                                                assignedBy: scheduleAssignments.assignedBy,
                                                                isBorrowed: scheduleAssignments.isBorrowed,
                                                                borrowedFromBranchId:
                                                                        scheduleAssignments.borrowedFromBranchId,
                                                                roleId: scheduleAssignments.roleId,
                                                                employee: employees,
                                                                casualWorker: casualWorkers,
                                                        })
                                                        .from(scheduleAssignments)
                                                        .leftJoin(
                                                                employees,
                                                                eq(
                                                                        scheduleAssignments.employeeId,
                                                                        employees.id,
                                                                ),
                                                        )
                                                        .leftJoin(
                                                                casualWorkers,
                                                                eq(
                                                                        scheduleAssignments.casualWorkerId,
                                                                        casualWorkers.id,
                                                                ),
                                                        )
                                                        .where(
                                                                and(
                                                                        eq(scheduleAssignments.shiftRowId, row.id),
                                                                        eq(
                                                                                scheduleAssignments.weekPlanId,
                                                                                weekPlan.id,
                                                                        ),
                                                                ),
                                                        )
                                        : [];

                                const breaksData = await db
                                        .select()
                                        .from(scheduleShiftBreaks)
                                        .where(eq(scheduleShiftBreaks.shiftRowId, row.id));

                                return {
                                        ...row,
                                        department: dept,
                                        roles: rolesData.map((r) => ({
                                                id: r.id,
                                                shiftRowId: r.shiftRowId,
                                                roleId: r.roleId,
                                                role: r.role || undefined,
                                        })),
                                        assignments: assignmentsData.map((a) => ({
                                                id: a.id,
                                                weekPlanId: a.weekPlanId,
                                                shiftRowId: a.shiftRowId,
                                                shiftDate: a.shiftDate,
                                                assigneeType: a.assigneeType,
                                                employeeId: a.employeeId,
                                                casualWorkerId: a.casualWorkerId,
                                                dailyRateSnapshot: a.dailyRateSnapshot,
                                                assignedAt: a.assignedAt,
                                                assignedBy: a.assignedBy,
                                                isBorrowed: a.isBorrowed,
                                                borrowedFromBranchId: a.borrowedFromBranchId,
                                                roleId: a.roleId,
                                                employee: a.employee || undefined,
                                                casualWorker: a.casualWorker || undefined,
                                        })),
                                        breaks: breaksData,
                                };
                        }),
                );

                const shiftGroupsData = await db
                        .select()
                        .from(shiftGroups)
                        .where(
                                and(
                                        eq(shiftGroups.branchId, branchId),
                                        eq(shiftGroups.isActive, true),
                                ),
                        )
                        .orderBy(shiftGroups.sortOrder);

                console.log(
                        `[getWeekPlan] week=${weekStartDate} weekPlanExists=${!!weekPlan} shiftGroups=${shiftGroupsData.length} shiftRows=${shiftRowsData.length}`,
                );

                return {
                        ...(weekPlan || {}),
                        branch,
                        shiftRows,
                        shiftGroups: shiftGroupsData,
                };
        }

        async getOrCreateWeekPlan(
                branchId: string,
                weekStartDate: string,
                userId?: string,
        ): Promise<ScheduleWeekPlan> {
                const [existing] = await db
                        .select()
                        .from(scheduleWeekPlans)
                        .where(
                                and(
                                        eq(scheduleWeekPlans.branchId, branchId),
                                        eq(scheduleWeekPlans.weekStartDate, weekStartDate),
                                ),
                        );

                if (existing) return existing;

                // Get tenant_id from the branch
                const [branch] = await db
                        .select()
                        .from(branches)
                        .where(eq(branches.id, branchId));
                if (!branch) throw new Error("Branch not found");

                const [newPlan] = await db
                        .insert(scheduleWeekPlans)
                        .values({
                                tenantId: branch.tenantId,
                                branchId,
                                weekStartDate,
                                createdBy: userId,
                        })
                        .returning();

                return newPlan;
        }

        async snapshotWeekPlan(weekPlanId: string): Promise<any> {
                const [weekPlan] = await db
                        .select()
                        .from(scheduleWeekPlans)
                        .where(eq(scheduleWeekPlans.id, weekPlanId));
                if (!weekPlan) return null;

                // Query shift rows by branch + date range overlap for this week
                const wpStart =
                        typeof weekPlan.weekStartDate === "string"
                                ? weekPlan.weekStartDate
                                : weekPlan.weekStartDate.toISOString().split("T")[0];
                const wpEnd = new Date(wpStart);
                wpEnd.setDate(wpEnd.getDate() + 6);
                const wpEndStr = wpEnd.toISOString().split("T")[0];

                const shiftRows = await db
                        .select()
                        .from(scheduleShiftRows)
                        .where(
                                and(
                                        eq(scheduleShiftRows.branchId, weekPlan.branchId),
                                        or(
                                                isNull(scheduleShiftRows.activeFromDate),
                                                sql`${scheduleShiftRows.activeFromDate} <= ${wpEndStr}::date`,
                                        ),
                                        or(
                                                isNull(scheduleShiftRows.activeUntilDate),
                                                sql`${scheduleShiftRows.activeUntilDate} >= ${wpStart}::date`,
                                        ),
                                ),
                        );

                const rowIds = shiftRows.map((r) => r.id);
                const assignments =
                        rowIds.length > 0
                                ? await db
                                                .select()
                                                .from(scheduleAssignments)
                                                .where(
                                                        and(
                                                                inArray(scheduleAssignments.shiftRowId, rowIds),
                                                                gte(scheduleAssignments.shiftDate, wpStart),
                                                                lte(scheduleAssignments.shiftDate, wpEndStr),
                                                        ),
                                                )
                                : [];
                const rowRoles =
                        rowIds.length > 0
                                ? await db
                                                .select()
                                                .from(scheduleShiftRowRoles)
                                                .where(
                                                        inArray(scheduleShiftRowRoles.shiftRowId, rowIds),
                                                )
                                : [];

                const assignmentIds = assignments.map((a) => a.id);
                const breaks =
                        assignmentIds.length > 0
                                ? await db
                                                .select()
                                                .from(scheduleShiftBreaks)
                                                .where(inArray(scheduleShiftBreaks.assignmentId, assignmentIds))
                                : [];

                return { weekPlan, shiftRows, assignments, rowRoles, breaks };
        }

        async snapshotByDepartmentAndWeek(
                branchId: string,
                departmentId: string,
                weekStart: string,
                weekEnd: string,
        ): Promise<{ shiftRows: any[]; assignments: any[]; breaks: any[]; timeOff: any[]; meta: { branchId: string; departmentId: string; weekStart: string; weekEnd: string } }> {
                // Get shift rows that belong to this branch AND this department, active during the week
                const deptRows = await db
                        .select()
                        .from(scheduleShiftRows)
                        .where(
                                and(
                                        eq(scheduleShiftRows.branchId, branchId),
                                        eq(scheduleShiftRows.departmentId, departmentId),
                                        or(
                                                isNull(scheduleShiftRows.activeFromDate),
                                                sql`${scheduleShiftRows.activeFromDate} <= ${weekEnd}::date`,
                                        ),
                                        or(
                                                isNull(scheduleShiftRows.activeUntilDate),
                                                sql`${scheduleShiftRows.activeUntilDate} >= ${weekStart}::date`,
                                        ),
                                ),
                        );

                const rowIds = deptRows.map((r) => r.id);

                // All assignments on these department shift rows within the date range
                const assignments =
                        rowIds.length > 0
                                ? await db
                                                .select()
                                                .from(scheduleAssignments)
                                                .where(
                                                        and(
                                                                inArray(scheduleAssignments.shiftRowId, rowIds),
                                                                gte(scheduleAssignments.shiftDate, weekStart),
                                                                lte(scheduleAssignments.shiftDate, weekEnd),
                                                        ),
                                                )
                                : [];

                const assignmentIds = assignments.map((a) => a.id);
                const breaks =
                        assignmentIds.length > 0
                                ? await db
                                                .select()
                                                .from(scheduleShiftBreaks)
                                                .where(inArray(scheduleShiftBreaks.assignmentId, assignmentIds))
                                : [];

                // CHANGE_DAY_OFF entries: scope to employees assigned to this department's rows in this week
                const assignedEmployeeIds = [...new Set(
                        assignments.map((a) => a.employeeId).filter(Boolean) as string[],
                )];
                const timeOff =
                        assignedEmployeeIds.length > 0
                                ? await db
                                                .select()
                                                .from(employeeTimeOff)
                                                .where(
                                                        and(
                                                                eq(employeeTimeOff.branchId, branchId),
                                                                inArray(employeeTimeOff.employeeId, assignedEmployeeIds),
                                                                sql`${employeeTimeOff.startDate}::date >= ${weekStart}::date`,
                                                                sql`${employeeTimeOff.endDate}::date <= ${weekEnd}::date`,
                                                                eq(employeeTimeOff.type, "CHANGE_DAY_OFF"),
                                                        ),
                                                )
                                : [];

                return {
                        shiftRows: deptRows,
                        assignments,
                        breaks,
                        timeOff,
                        meta: { branchId, departmentId, weekStart, weekEnd },
                };
        }

        async logScheduleAudit(
                tenantId: string,
                action: string,
                opts: {
                        weekPlanId?: string;
                        branchId?: string;
                        departmentId?: string;
                        weekStartDate?: string;
                        description?: string;
                        performedBy?: string;
                        snapshotData?: any;
                        summaryData?: { shiftRows: number; assignments: number; breaks: number };
                },
        ): Promise<void> {
                await db.insert(scheduleAuditLog).values({
                        tenantId,
                        weekPlanId: opts.weekPlanId,
                        branchId: opts.branchId,
                        departmentId: opts.departmentId,
                        weekStartDate: opts.weekStartDate,
                        action,
                        description: opts.description,
                        performedBy: opts.performedBy,
                        snapshotData: opts.snapshotData,
                        summaryData: opts.summaryData as any,
                });
        }

        async restoreFromDeptWeekSnapshot(
                snapshotData: any,
        ): Promise<{ restored: boolean; shiftRows: number; assignments: number; breaks: number }> {
                if (!snapshotData?.meta) throw new Error("Invalid scoped snapshot data");

                const { assignments, breaks, timeOff, meta } = snapshotData;
                const { branchId, departmentId, weekStart, weekEnd } = meta;

                const toDate = (v: any): Date | undefined => {
                        if (!v) return undefined;
                        if (v instanceof Date) return v;
                        const d = new Date(v);
                        return isNaN(d.getTime()) ? undefined : d;
                };

                // Get all shift rows for this branch+department active in the week range (same scope used when clearing)
                const deptRows = await db
                        .select({ id: scheduleShiftRows.id })
                        .from(scheduleShiftRows)
                        .where(
                                and(
                                        eq(scheduleShiftRows.branchId, branchId),
                                        eq(scheduleShiftRows.departmentId, departmentId),
                                        or(
                                                isNull(scheduleShiftRows.activeFromDate),
                                                sql`${scheduleShiftRows.activeFromDate} <= ${weekEnd}::date`,
                                        ),
                                        or(
                                                isNull(scheduleShiftRows.activeUntilDate),
                                                sql`${scheduleShiftRows.activeUntilDate} >= ${weekStart}::date`,
                                        ),
                                ),
                        );
                const deptRowIds = deptRows.map((r) => r.id);

                // Delete existing assignments (and their breaks) scoped to these dept rows + date range
                if (deptRowIds.length > 0) {
                        const existingAssignments = await db
                                .select({ id: scheduleAssignments.id })
                                .from(scheduleAssignments)
                                .where(
                                        and(
                                                inArray(scheduleAssignments.shiftRowId, deptRowIds),
                                                gte(scheduleAssignments.shiftDate, weekStart),
                                                lte(scheduleAssignments.shiftDate, weekEnd),
                                        ),
                                );
                        const existingIds = existingAssignments.map((a) => a.id);
                        if (existingIds.length > 0) {
                                await db
                                        .delete(scheduleShiftBreaks)
                                        .where(inArray(scheduleShiftBreaks.assignmentId, existingIds));
                        }
                        await db
                                .delete(scheduleAssignments)
                                .where(
                                        and(
                                                inArray(scheduleAssignments.shiftRowId, deptRowIds),
                                                gte(scheduleAssignments.shiftDate, weekStart),
                                                lte(scheduleAssignments.shiftDate, weekEnd),
                                        ),
                                );
                }

                // Delete existing time-off in scope (employees who were in the snapshot)
                const snapshotEmployeeIds = [...new Set(
                        (assignments || []).map((a: any) => a.employeeId).filter(Boolean) as string[],
                )];
                if (snapshotEmployeeIds.length > 0) {
                        await db
                                .delete(employeeTimeOff)
                                .where(
                                        and(
                                                eq(employeeTimeOff.branchId, branchId),
                                                inArray(employeeTimeOff.employeeId, snapshotEmployeeIds),
                                                sql`${employeeTimeOff.startDate}::date >= ${weekStart}::date`,
                                                sql`${employeeTimeOff.endDate}::date <= ${weekEnd}::date`,
                                                eq(employeeTimeOff.type, "CHANGE_DAY_OFF"),
                                        ),
                                );
                }

                // Restore assignments — drop old IDs to let DB generate new ones (avoids duplicate PK)
                for (const assignment of assignments || []) {
                        const { id: _id, ...aCopy } = assignment;
                        if (aCopy.assignedAt) aCopy.assignedAt = toDate(aCopy.assignedAt);
                        await db.insert(scheduleAssignments).values(aCopy);
                }

                // Re-fetch newly inserted assignments to remap break assignmentIds
                const newAssignments = deptRowIds.length > 0
                        ? await db
                                .select()
                                .from(scheduleAssignments)
                                .where(
                                        and(
                                                inArray(scheduleAssignments.shiftRowId, deptRowIds),
                                                gte(scheduleAssignments.shiftDate, weekStart),
                                                lte(scheduleAssignments.shiftDate, weekEnd),
                                        ),
                                )
                        : [];

                // Map (shiftRowId|shiftDate|employeeId) -> new assignment id
                const newAssignmentMap = new Map<string, string>();
                for (const a of newAssignments) {
                        const key = `${a.shiftRowId}|${a.shiftDate}|${a.employeeId}`;
                        newAssignmentMap.set(key, a.id);
                }

                let restoredBreaks = 0;
                for (const brk of breaks || []) {
                        const key = `${brk.shiftRowId}|${brk.shiftDate}|${brk.employeeId}`;
                        const newAssignmentId = newAssignmentMap.get(key);
                        if (!newAssignmentId) continue;
                        const { id: _id, createdAt: _c, updatedAt: _u, ...brkCopy } = brk;
                        await db.insert(scheduleShiftBreaks).values({ ...brkCopy, assignmentId: newAssignmentId });
                        restoredBreaks++;
                }

                // Restore time-off entries
                for (const to of timeOff || []) {
                        const { id: _id, createdAt: _c, updatedAt: _u, ...rest } = to;
                        const toCopy: any = { ...rest };
                        // startDate and endDate are timestamp columns — must be Date objects, not JSON strings
                        if (toCopy.startDate) toCopy.startDate = toDate(toCopy.startDate);
                        if (toCopy.endDate) toCopy.endDate = toDate(toCopy.endDate);
                        await db.insert(employeeTimeOff).values(toCopy);
                }

                return {
                        restored: true,
                        shiftRows: (snapshotData.shiftRows || []).length,
                        assignments: (assignments || []).length,
                        breaks: restoredBreaks,
                };
        }

        async restoreWeekPlanFromSnapshot(
                snapshotData: any,
                userId?: string,
        ): Promise<{ restored: boolean; shiftRows: number; assignments: number; breaks: number }> {
                // If this is a scoped dept/week snapshot (from new clear_week), use the scoped restore
                if (snapshotData?.meta) {
                        return this.restoreFromDeptWeekSnapshot(snapshotData);
                }

                if (!snapshotData?.weekPlan) throw new Error("Invalid snapshot data");

                const { weekPlan, shiftRows, assignments, rowRoles, breaks } = snapshotData;

                const toDate = (v: any): Date | undefined => {
                        if (!v) return undefined;
                        if (v instanceof Date) return v;
                        const d = new Date(v);
                        return isNaN(d.getTime()) ? undefined : d;
                };

                const [existingPlan] = await db
                        .select()
                        .from(scheduleWeekPlans)
                        .where(eq(scheduleWeekPlans.id, weekPlan.id));

                if (!existingPlan) {
                        const wpCopy = { ...weekPlan };
                        if (wpCopy.createdAt) wpCopy.createdAt = toDate(wpCopy.createdAt);
                        if (wpCopy.updatedAt) wpCopy.updatedAt = toDate(wpCopy.updatedAt);
                        await db.insert(scheduleWeekPlans).values(wpCopy);
                } else {
                        // For restore, scope cleanup to the snapshot's shift row IDs
                        const snapshotRowIds = shiftRows.map((r: any) => r.id);
                        if (snapshotRowIds.length > 0) {
                                // First get existing assignment IDs to clean up breaks
                                const existingAssignments = await db
                                        .select({ id: scheduleAssignments.id })
                                        .from(scheduleAssignments)
                                        .where(inArray(scheduleAssignments.shiftRowId, snapshotRowIds));
                                const existingAssignmentIds = existingAssignments.map((a) => a.id);
                                if (existingAssignmentIds.length > 0) {
                                        await db
                                                .delete(scheduleShiftBreaks)
                                                .where(inArray(scheduleShiftBreaks.assignmentId, existingAssignmentIds));
                                }
                                await db
                                        .delete(scheduleAssignments)
                                        .where(inArray(scheduleAssignments.shiftRowId, snapshotRowIds));
                                await db
                                        .delete(scheduleShiftRowRoles)
                                        .where(inArray(scheduleShiftRowRoles.shiftRowId, snapshotRowIds));
                                await db
                                        .delete(scheduleShiftRows)
                                        .where(inArray(scheduleShiftRows.id, snapshotRowIds));
                        }
                }

                for (const row of shiftRows) {
                        const rowCopy = { ...row };
                        if (rowCopy.createdAt)
                                rowCopy.createdAt = toDate(rowCopy.createdAt);
                        if (rowCopy.updatedAt)
                                rowCopy.updatedAt = toDate(rowCopy.updatedAt);
                        await db.insert(scheduleShiftRows).values(rowCopy);
                }

                for (const role of rowRoles || []) {
                        await db.insert(scheduleShiftRowRoles).values(role);
                }

                for (const assignment of assignments || []) {
                        const aCopy = { ...assignment };
                        if (aCopy.assignedAt) aCopy.assignedAt = toDate(aCopy.assignedAt);
                        await db.insert(scheduleAssignments).values(aCopy);
                }

                // Restore breaks if present in snapshot
                for (const brk of breaks || []) {
                        const { id: _id, createdAt: _c, updatedAt: _u, ...brkCopy } = brk;
                        try {
                                await db.insert(scheduleShiftBreaks).values(brkCopy);
                        } catch {
                                // skip if assignment no longer exists
                        }
                }

                return {
                        restored: true,
                        shiftRows: shiftRows.length,
                        assignments: assignments?.length ?? 0,
                        breaks: breaks?.length ?? 0,
                };
        }

        async deleteWeekPlan(id: string): Promise<void> {
                await db.delete(scheduleWeekPlans).where(eq(scheduleWeekPlans.id, id));
        }

        async getWeekPlanById(id: string): Promise<ScheduleWeekPlan | undefined> {
                const [plan] = await db
                        .select()
                        .from(scheduleWeekPlans)
                        .where(eq(scheduleWeekPlans.id, id));
                return plan || undefined;
        }

        async deleteTimeOffByBranchAndDateRange(
                branchId: string,
                startDate: Date,
                endDate: Date,
                type?: string,
        ): Promise<void> {
                const startStr = startDate.toISOString().split("T")[0];
                const endStr = endDate.toISOString().split("T")[0];

                const conditions = [
                        eq(employeeTimeOff.branchId, branchId),
                        sql`${employeeTimeOff.startDate}::date >= ${startStr}::date`,
                        sql`${employeeTimeOff.endDate}::date <= ${endStr}::date`,
                ];

                if (type) {
                        conditions.push(eq(employeeTimeOff.type, type));
                }

                await db.delete(employeeTimeOff).where(and(...conditions));
        }

        async getShiftRow(
                id: string,
        ): Promise<ScheduleShiftRowWithDetails | undefined> {
                const [row] = await db
                        .select()
                        .from(scheduleShiftRows)
                        .where(eq(scheduleShiftRows.id, id));
                if (!row) return undefined;

                const [dept] = await db
                        .select()
                        .from(departments)
                        .where(eq(departments.id, row.departmentId));

                const rolesData = await db
                        .select({
                                id: scheduleShiftRowRoles.id,
                                shiftRowId: scheduleShiftRowRoles.shiftRowId,
                                roleId: scheduleShiftRowRoles.roleId,
                                role: roles,
                        })
                        .from(scheduleShiftRowRoles)
                        .leftJoin(roles, eq(scheduleShiftRowRoles.roleId, roles.id))
                        .where(eq(scheduleShiftRowRoles.shiftRowId, id));

                const assignmentsData = await db
                        .select({
                                id: scheduleAssignments.id,
                                weekPlanId: scheduleAssignments.weekPlanId,
                                shiftRowId: scheduleAssignments.shiftRowId,
                                shiftDate: scheduleAssignments.shiftDate,
                                employeeId: scheduleAssignments.employeeId,
                                casualWorkerId: scheduleAssignments.casualWorkerId,
                                assigneeType: scheduleAssignments.assigneeType,
                                assignedAt: scheduleAssignments.assignedAt,
                                assignedBy: scheduleAssignments.assignedBy,
                                employee: employees,
                        })
                        .from(scheduleAssignments)
                        .leftJoin(
                                employees,
                                eq(scheduleAssignments.employeeId, employees.id),
                        )
                        .where(eq(scheduleAssignments.shiftRowId, id));

                return {
                        ...row,
                        department: dept,
                        roles: rolesData.map((r) => ({
                                id: r.id,
                                shiftRowId: r.shiftRowId,
                                roleId: r.roleId,
                                role: r.role || undefined,
                        })),
                        assignments: assignmentsData.map((a) => ({
                                id: a.id,
                                weekPlanId: a.weekPlanId,
                                shiftRowId: a.shiftRowId,
                                shiftDate: a.shiftDate,
                                employeeId: a.employeeId,
                                casualWorkerId: a.casualWorkerId,
                                assigneeType: a.assigneeType,
                                assignedAt: a.assignedAt,
                                assignedBy: a.assignedBy,
                                employee: a.employee || undefined,
                        })),
                };
        }

        async createShiftRow(
                shiftRow: InsertScheduleShiftRow,
                roleIds?: string[],
        ): Promise<ScheduleShiftRow> {
                // Auto-assign colorIndex if not provided - find max colorIndex in the branch and add 1
                let colorIndex = shiftRow.colorIndex;
                if (colorIndex == null && shiftRow.branchId) {
                        const existingRows = await db
                                .select({ colorIndex: scheduleShiftRows.colorIndex })
                                .from(scheduleShiftRows)
                                .where(eq(scheduleShiftRows.branchId, shiftRow.branchId));

                        const maxColorIndex = existingRows.reduce((max, row) => {
                                const idx = row.colorIndex ?? -1;
                                return idx > max ? idx : max;
                        }, -1);

                        colorIndex = maxColorIndex + 1;
                }

                // Set activeFromDate to today if not provided
                const activeFromDate =
                        shiftRow.activeFromDate || new Date().toISOString().split("T")[0];

                const [row] = await db
                        .insert(scheduleShiftRows)
                        .values({ ...shiftRow, colorIndex, activeFromDate })
                        .returning();

                if (roleIds && roleIds.length > 0) {
                        await db
                                .insert(scheduleShiftRowRoles)
                                .values(
                                        roleIds.map((roleId) => ({
                                                shiftRowId: row.id,
                                                roleId,
                                                tenantId: shiftRow.tenantId,
                                        })),
                                );
                }

                return row;
        }

        async updateShiftRow(
                id: string,
                shiftRow: Partial<InsertScheduleShiftRow>,
                roleIds?: string[],
        ): Promise<ScheduleShiftRow> {
                const [row] = await db
                        .update(scheduleShiftRows)
                        .set({ ...shiftRow, updatedAt: new Date() })
                        .where(eq(scheduleShiftRows.id, id))
                        .returning();

                if (roleIds !== undefined) {
                        await db
                                .delete(scheduleShiftRowRoles)
                                .where(eq(scheduleShiftRowRoles.shiftRowId, id));
                        if (roleIds.length > 0) {
                                await db
                                        .insert(scheduleShiftRowRoles)
                                        .values(
                                                roleIds.map((roleId) => ({
                                                        shiftRowId: id,
                                                        roleId,
                                                        tenantId: row.tenantId,
                                                })),
                                        );
                        }
                }

                return row;
        }

        async deleteShiftRow(id: string): Promise<void> {
                // Soft-delete: set activeUntilDate to yesterday so the row is excluded
                // from the current week immediately (the visibility filter is
                // activeUntilDate >= weekStart, so setting it to today would still
                // show the row for the rest of the current week).
                const yesterday = new Date();
                yesterday.setDate(yesterday.getDate() - 1);
                const yesterdayStr = yesterday.toISOString().split("T")[0];
                await db
                        .update(scheduleShiftRows)
                        .set({ activeUntilDate: yesterdayStr, updatedAt: new Date() })
                        .where(eq(scheduleShiftRows.id, id));
        }

        async getShiftRowsByDepartment(
                departmentId: string,
        ): Promise<ScheduleShiftRow[]> {
                return await db
                        .select()
                        .from(scheduleShiftRows)
                        .where(eq(scheduleShiftRows.departmentId, departmentId))
                        .orderBy(scheduleShiftRows.rowOrder);
        }

        async getShiftGroupsByBranch(branchId: string): Promise<ShiftGroup[]> {
                return await db
                        .select()
                        .from(shiftGroups)
                        .where(
                                and(
                                        eq(shiftGroups.branchId, branchId),
                                        eq(shiftGroups.isActive, true),
                                ),
                        )
                        .orderBy(shiftGroups.sortOrder);
        }

        async getShiftGroup(id: string): Promise<ShiftGroup | undefined> {
                const [group] = await db
                        .select()
                        .from(shiftGroups)
                        .where(eq(shiftGroups.id, id));
                return group || undefined;
        }

        async createShiftGroup(group: InsertShiftGroup): Promise<ShiftGroup> {
                const [created] = await db
                        .insert(shiftGroups)
                        .values(group)
                        .returning();
                return created;
        }

        async updateShiftGroup(
                id: string,
                updates: Partial<InsertShiftGroup>,
        ): Promise<ShiftGroup> {
                const [updated] = await db
                        .update(shiftGroups)
                        .set({ ...updates, updatedAt: new Date() })
                        .where(eq(shiftGroups.id, id))
                        .returning();
                return updated;
        }

        async deleteShiftGroup(id: string): Promise<void> {
                await db
                        .update(shiftGroups)
                        .set({ isActive: false, updatedAt: new Date() })
                        .where(eq(shiftGroups.id, id));
        }

        async getShiftRowsByGroup(
                shiftGroupId: string,
        ): Promise<ScheduleShiftRow[]> {
                return await db
                        .select()
                        .from(scheduleShiftRows)
                        .where(eq(scheduleShiftRows.shiftGroupId, shiftGroupId))
                        .orderBy(scheduleShiftRows.sortOrderWithinGroup);
        }

        // Duty Types & Duty Blocks
        async getDutyTypes(tenantId: string): Promise<DutyType[]> {
                return await db
                        .select()
                        .from(dutyTypes)
                        .where(eq(dutyTypes.tenantId, tenantId))
                        .orderBy(dutyTypes.name);
        }

        async getDutyType(id: string): Promise<DutyType | undefined> {
                const [dt] = await db
                        .select()
                        .from(dutyTypes)
                        .where(eq(dutyTypes.id, id));
                return dt || undefined;
        }

        async createDutyType(dutyType: InsertDutyType): Promise<DutyType> {
                const [created] = await db
                        .insert(dutyTypes)
                        .values(dutyType)
                        .returning();
                return created;
        }

        async updateDutyType(
                id: string,
                updates: Partial<InsertDutyType>,
        ): Promise<DutyType> {
                const [updated] = await db
                        .update(dutyTypes)
                        .set({ ...updates, updatedAt: new Date() })
                        .where(eq(dutyTypes.id, id))
                        .returning();
                return updated;
        }

        async deleteDutyType(id: string): Promise<void> {
                await db
                        .update(dutyTypes)
                        .set({ isActive: false, updatedAt: new Date() })
                        .where(eq(dutyTypes.id, id));
        }

        async getDutyBlocks(options: {
                branchId: string;
                date: string;
                employeeId?: string;
        }): Promise<DutyBlock[]> {
                const conditions = [
                        eq(dutyBlocks.branchId, options.branchId),
                        eq(dutyBlocks.date, options.date),
                ];
                if (options.employeeId) {
                        conditions.push(eq(dutyBlocks.employeeId, options.employeeId));
                }
                return await db
                        .select()
                        .from(dutyBlocks)
                        .where(and(...conditions))
                        .orderBy(dutyBlocks.startTime);
        }

        async getDutyBlocksByDateRange(options: {
                branchId: string;
                startDate: string;
                endDate: string;
        }): Promise<DutyBlock[]> {
                return await db
                        .select()
                        .from(dutyBlocks)
                        .where(
                                and(
                                        eq(dutyBlocks.branchId, options.branchId),
                                        gte(dutyBlocks.date, options.startDate),
                                        lte(dutyBlocks.date, options.endDate),
                                ),
                        )
                        .orderBy(dutyBlocks.date, dutyBlocks.startTime);
        }

        async getDutyBlock(id: string): Promise<DutyBlock | undefined> {
                const [block] = await db
                        .select()
                        .from(dutyBlocks)
                        .where(eq(dutyBlocks.id, id));
                return block || undefined;
        }

        async createDutyBlock(dutyBlock: InsertDutyBlock): Promise<DutyBlock> {
                const [created] = await db
                        .insert(dutyBlocks)
                        .values(dutyBlock)
                        .returning();
                return created;
        }

        async updateDutyBlock(
                id: string,
                updates: Partial<InsertDutyBlock>,
        ): Promise<DutyBlock> {
                const [updated] = await db
                        .update(dutyBlocks)
                        .set({ ...updates, updatedAt: new Date() })
                        .where(eq(dutyBlocks.id, id))
                        .returning();
                return updated;
        }

        async deleteDutyBlock(id: string): Promise<void> {
                await db.delete(dutyBlocks).where(eq(dutyBlocks.id, id));
        }

        async getAssignmentsForDate(
                branchId: string,
                date: string,
        ): Promise<ScheduleAssignment[]> {
                const assignments = await db
                        .select()
                        .from(scheduleAssignments)
                        .innerJoin(
                                scheduleShiftRows,
                                eq(scheduleAssignments.shiftRowId, scheduleShiftRows.id),
                        )
                        .where(
                                and(
                                        eq(scheduleShiftRows.branchId, branchId),
                                        eq(scheduleAssignments.shiftDate, date),
                                ),
                        );

                return assignments.map((a) => a.schedule_assignments);
        }

        async createAssignment(
                assignment: InsertScheduleAssignment,
        ): Promise<ScheduleAssignment> {
                const [result] = await db
                        .insert(scheduleAssignments)
                        .values(assignment)
                        .returning();
                return result;
        }

        async getAssignment(id: string): Promise<ScheduleAssignment | undefined> {
                const [assignment] = await db
                        .select()
                        .from(scheduleAssignments)
                        .where(eq(scheduleAssignments.id, id))
                        .limit(1);
                return assignment;
        }

        async updateAssignment(
                id: string,
                updates: Partial<InsertScheduleAssignment>,
        ): Promise<ScheduleAssignment> {
                const [assignment] = await db
                        .update(scheduleAssignments)
                        .set(updates)
                        .where(eq(scheduleAssignments.id, id))
                        .returning();
                return assignment;
        }

        async deleteAssignment(id: string): Promise<void> {
                await db
                        .delete(scheduleAssignments)
                        .where(eq(scheduleAssignments.id, id));
        }

        async deleteAssignmentsByShiftRowAndDate(
                shiftRowId: string,
                date: string,
                employeeId?: string,
        ): Promise<void> {
                const conditions = [
                        eq(scheduleAssignments.shiftRowId, shiftRowId),
                        eq(scheduleAssignments.shiftDate, date),
                ];
                if (employeeId) {
                        conditions.push(eq(scheduleAssignments.employeeId, employeeId));
                }
                await db.delete(scheduleAssignments).where(and(...conditions));
        }

        async deleteAssignmentsByEmployeeAndDateRange(
                employeeId: string,
                startDate: string,
                endDate: string,
        ): Promise<ScheduleAssignment[]> {
                // First get the assignments that will be deleted (to return them for attention items)
                const affected = await db
                        .select()
                        .from(scheduleAssignments)
                        .where(
                                and(
                                        eq(scheduleAssignments.employeeId, employeeId),
                                        gte(scheduleAssignments.shiftDate, startDate),
                                        lte(scheduleAssignments.shiftDate, endDate),
                                ),
                        );

                // Delete them
                if (affected.length > 0) {
                        await db
                                .delete(scheduleAssignments)
                                .where(
                                        and(
                                                eq(scheduleAssignments.employeeId, employeeId),
                                                gte(scheduleAssignments.shiftDate, startDate),
                                                lte(scheduleAssignments.shiftDate, endDate),
                                        ),
                                );
                }

                return affected;
        }

        async getEligibleEmployeesForShiftRow(
                shiftRowId: string,
                date: string,
        ): Promise<Employee[]> {
                const [shiftRow] = await db
                        .select()
                        .from(scheduleShiftRows)
                        .where(eq(scheduleShiftRows.id, shiftRowId));

                if (!shiftRow) return [];

                const requiredRoles = await db
                        .select({ roleId: scheduleShiftRowRoles.roleId })
                        .from(scheduleShiftRowRoles)
                        .where(eq(scheduleShiftRowRoles.shiftRowId, shiftRowId));

                // Get employees currently in this branch who are active (signed contract) and whose start date is on/before the shift date
                // Include both ACTIVE employees and LEAVING employees (those who have resigned but last working day hasn't passed)
                // Filter by department: only show employees from the shift row's department
                let eligibleQuery = db
                        .select()
                        .from(employees)
                        .where(
                                and(
                                        eq(employees.branchId, shiftRow.branchId),
                                        eq(employees.status, "active"),
                                        or(
                                                eq(employees.employmentState, "ACTIVE"),
                                                and(
                                                        eq(employees.employmentState, "LEAVING"),
                                                        or(
                                                                isNull(employees.lastWorkingDay),
                                                                gte(employees.lastWorkingDay, new Date(date)),
                                                        ),
                                                ),
                                        ),
                                        or(
                                                isNull(employees.startDate),
                                                lte(employees.startDate, new Date(date)),
                                        ),
                                ),
                        );

                let eligibleEmployees = await eligibleQuery;

                // Also include employees who were transferred FROM this branch but where the shift date
                // is BEFORE the effective date (they should still be assignable until transfer takes effect)
                const transferredFromBranch = await db
                        .select()
                        .from(employeeChanges)
                        .where(
                                and(
                                        eq(employeeChanges.changeType, "branch_transfer"),
                                        eq(employeeChanges.oldBranchId, shiftRow.branchId),
                                        sql`${employeeChanges.effectiveDate}::date > ${date}::date`, // effectiveDate > shiftDate means transfer hasn't taken effect yet
                                ),
                        );

                if (transferredFromBranch.length > 0) {
                        const transferredEmployeeIds = transferredFromBranch.map(
                                (t) => t.employeeId,
                        );
                        const transferredEmployees = await db
                                .select()
                                .from(employees)
                                .where(
                                        and(
                                                inArray(employees.id, transferredEmployeeIds),
                                                eq(employees.status, "active"),
                                                or(
                                                        eq(employees.employmentState, "ACTIVE"),
                                                        and(
                                                                eq(employees.employmentState, "LEAVING"),
                                                                or(
                                                                        isNull(employees.lastWorkingDay),
                                                                        gte(
                                                                                employees.lastWorkingDay,
                                                                                new Date(date),
                                                                        ),
                                                                ),
                                                        ),
                                                ),
                                                or(
                                                        isNull(employees.startDate),
                                                        lte(employees.startDate, new Date(date)),
                                                ),
                                        ),
                                );

                        // Add them to eligible list if not already there
                        const existingIds = new Set(eligibleEmployees.map((e) => e.id));
                        for (const emp of transferredEmployees) {
                                if (!existingIds.has(emp.id)) {
                                        eligibleEmployees.push(emp);
                                }
                        }
                }

                // Filter by the shift row's department — only employees whose primary department
                // matches the shift row's department are eligible to be assigned to it.
                // If the shift row has no department set, skip this filter (show all branch employees).
                if (shiftRow.departmentId) {
                        eligibleEmployees = eligibleEmployees.filter(
                                (e) => e.primaryDepartmentId === shiftRow.departmentId,
                        );
                }

                if (requiredRoles.length > 0) {
                        const roleIds = requiredRoles.map((r) => r.roleId);
                        const employeesWithRoles = await db
                                .select({ employeeId: employeeRoles.employeeId })
                                .from(employeeRoles)
                                .where(inArray(employeeRoles.roleId, roleIds));

                        const eligibleEmployeeIds = new Set(
                                employeesWithRoles.map((e) => e.employeeId),
                        );
                        eligibleEmployees = eligibleEmployees.filter((e) =>
                                eligibleEmployeeIds.has(e.id),
                        );
                }

                const timeOffRecords = await db
                        .select()
                        .from(employeeTimeOff)
                        .where(
                                and(
                                        inArray(
                                                employeeTimeOff.employeeId,
                                                eligibleEmployees.map((e) => e.id),
                                        ),
                                        sql`${employeeTimeOff.startDate}::date <= ${date}::date`,
                                        sql`${employeeTimeOff.endDate}::date >= ${date}::date`,
                                ),
                        );

                const employeesOnLeave = new Set(
                        timeOffRecords.map((t) => t.employeeId),
                );
                eligibleEmployees = eligibleEmployees.filter(
                        (e) => !employeesOnLeave.has(e.id),
                );

                // Filter out employees whose weekly off day matches this date
                const dateObj = new Date(date + "T00:00:00");
                const dayOfWeek = dateObj.getUTCDay(); // 0 = Sunday, 1 = Monday, etc.
                eligibleEmployees = eligibleEmployees.filter((e) => {
                        if (!e.weeklyOffDays || e.weeklyOffDays.length === 0) return true;
                        return !e.weeklyOffDays.includes(dayOfWeek);
                });

                // Filter out employees who have overlapping shifts on the same date
                // Time overlap rule: newStart < existingEnd AND existingStart < newEnd (allows back-to-back)
                if (eligibleEmployees.length > 0) {
                        const targetStartMin = this.timeToMinutes(shiftRow.startTime);
                        const targetEndMin = this.timeToMinutes(shiftRow.endTime);

                        const existingAssignments = await db
                                .select({
                                        employeeId: scheduleAssignments.employeeId,
                                        shiftRowId: scheduleAssignments.shiftRowId,
                                })
                                .from(scheduleAssignments)
                                .where(
                                        and(
                                                inArray(
                                                        scheduleAssignments.employeeId,
                                                        eligibleEmployees.map((e) => e.id),
                                                ),
                                                eq(scheduleAssignments.shiftDate, date),
                                        ),
                                );

                        if (existingAssignments.length > 0) {
                                const assignedShiftRowIds = Array.from(
                                        new Set(existingAssignments.map((a) => a.shiftRowId)),
                                );
                                const assignedShiftRows = await db
                                        .select({
                                                id: scheduleShiftRows.id,
                                                startTime: scheduleShiftRows.startTime,
                                                endTime: scheduleShiftRows.endTime,
                                        })
                                        .from(scheduleShiftRows)
                                        .where(inArray(scheduleShiftRows.id, assignedShiftRowIds));

                                const shiftRowTimes = new Map(
                                        assignedShiftRows.map((r) => [
                                                r.id,
                                                { start: r.startTime, end: r.endTime },
                                        ]),
                                );

                                const employeesWithConflicts = new Set<string>();
                                for (const assignment of existingAssignments) {
                                        const times = shiftRowTimes.get(assignment.shiftRowId);
                                        if (times) {
                                                const existingStartMin = this.timeToMinutes(
                                                        times.start,
                                                );
                                                const existingEndMin = this.timeToMinutes(times.end);
                                                const hasOverlap =
                                                        targetStartMin < existingEndMin &&
                                                        existingStartMin < targetEndMin;
                                                if (hasOverlap) {
                                                        employeesWithConflicts.add(assignment.employeeId);
                                                }
                                        }
                                }

                                eligibleEmployees = eligibleEmployees.filter(
                                        (e) => !employeesWithConflicts.has(e.id),
                                );
                        }
                }

                return eligibleEmployees;
        }

        async getBorrowCandidates(
                shiftRowId: string,
                date: string,
                destinationBranchId: string,
        ): Promise<{
                candidates: {
                        employeeId: string;
                        name: string;
                        homeBranchId: string;
                        homeBranchName: string;
                        roles: { id: string; name: string }[];
                        availabilityStatus: "AVAILABLE" | "NOT_AVAILABLE" | "ON_LEAVE";
                        conflictingShiftSummary?: string;
                }[];
                hasSiblingBranches: boolean;
        }> {
                // Get the shift row details
                const [shiftRow] = await db
                        .select()
                        .from(scheduleShiftRows)
                        .where(eq(scheduleShiftRows.id, shiftRowId));
                if (!shiftRow) return { candidates: [], hasSiblingBranches: false };

                // Get the destination branch to find its operator (or tenant for fallback)
                const [destBranch] = await db
                        .select()
                        .from(branches)
                        .where(eq(branches.id, destinationBranchId));
                if (!destBranch) return { candidates: [], hasSiblingBranches: false };

                // Get required roles for this shift
                const requiredRoles = await db
                        .select({ roleId: scheduleShiftRowRoles.roleId })
                        .from(scheduleShiftRowRoles)
                        .where(eq(scheduleShiftRowRoles.shiftRowId, shiftRowId));
                const requiredRoleIds = requiredRoles.map((r) => r.roleId);

                // Find sibling branches: use operator scope when configured, otherwise fall
                // back to tenant scope so single-company setups (no operators) still work.
                let siblingBranches: (typeof branches.$inferSelect)[];
                if (destBranch.operatorId) {
                        siblingBranches = await db
                                .select()
                                .from(branches)
                                .where(
                                        and(
                                                eq(branches.operatorId, destBranch.operatorId),
                                                sql`${branches.id} != ${destinationBranchId}`,
                                        ),
                                );
                } else {
                        siblingBranches = await db
                                .select()
                                .from(branches)
                                .where(
                                        and(
                                                eq(branches.tenantId, destBranch.tenantId),
                                                sql`${branches.id} != ${destinationBranchId}`,
                                        ),
                                );
                }
                const otherBranchIds = siblingBranches.map((b) => b.id);
                if (otherBranchIds.length === 0)
                        return { candidates: [], hasSiblingBranches: false };

                // Get employees from other branches
                let candidates = await db
                        .select()
                        .from(employees)
                        .where(
                                and(
                                        inArray(employees.branchId, otherBranchIds),
                                        eq(employees.employmentState, "ACTIVE"),
                                ),
                        );

                if (candidates.length === 0)
                        return { candidates: [], hasSiblingBranches: true };

                // Get roles for all candidate employees
                const candidateIds = candidates.map((c) => c.id);
                const candidateRolesData = await db
                        .select({
                                employeeId: employeeRoles.employeeId,
                                roleId: employeeRoles.roleId,
                                roleName: roles.name,
                        })
                        .from(employeeRoles)
                        .innerJoin(roles, eq(employeeRoles.roleId, roles.id))
                        .where(inArray(employeeRoles.employeeId, candidateIds));

                // Group roles by employee
                const rolesByEmployee = new Map<
                        string,
                        { id: string; name: string }[]
                >();
                for (const r of candidateRolesData) {
                        if (!rolesByEmployee.has(r.employeeId)) {
                                rolesByEmployee.set(r.employeeId, []);
                        }
                        rolesByEmployee
                                .get(r.employeeId)!
                                .push({ id: r.roleId, name: r.roleName });
                }

                // Filter candidates by required roles
                if (requiredRoleIds.length > 0) {
                        candidates = candidates.filter((c) => {
                                const empRoles = rolesByEmployee.get(c.id) || [];
                                return empRoles.some((r) => requiredRoleIds.includes(r.id));
                        });
                }

                if (candidates.length === 0)
                        return { candidates: [], hasSiblingBranches: true };

                // Check for time-off on this date (use date-only comparison to handle noon timestamps)
                const timeOffRecords = await db
                        .select()
                        .from(employeeTimeOff)
                        .where(
                                and(
                                        inArray(
                                                employeeTimeOff.employeeId,
                                                candidates.map((c) => c.id),
                                        ),
                                        sql`${employeeTimeOff.startDate}::date <= ${date}::date`,
                                        sql`${employeeTimeOff.endDate}::date >= ${date}::date`,
                                ),
                        );
                const employeesOnLeave = new Set(
                        timeOffRecords.map((t) => t.employeeId),
                );

                // Check for weekly off days
                const dateObj = new Date(date + "T00:00:00");
                const dayOfWeek = dateObj.getUTCDay();
                const employeesWithDayOff = new Set(
                        candidates
                                .filter((c) => c.weeklyOffDays?.includes(dayOfWeek))
                                .map((c) => c.id),
                );

                // Check for overlapping shifts
                const targetStartMin = this.timeToMinutes(shiftRow.startTime);
                const targetEndMin = this.timeToMinutes(shiftRow.endTime);

                const existingAssignments = await db
                        .select({
                                employeeId: scheduleAssignments.employeeId,
                                shiftRowId: scheduleAssignments.shiftRowId,
                        })
                        .from(scheduleAssignments)
                        .where(
                                and(
                                        inArray(
                                                scheduleAssignments.employeeId,
                                                candidates.map((c) => c.id),
                                        ),
                                        eq(scheduleAssignments.shiftDate, date),
                                ),
                        );

                // Get shift row times for conflict checking
                const assignedShiftRowIds = Array.from(
                        new Set(existingAssignments.map((a) => a.shiftRowId)),
                );
                let shiftRowTimes = new Map<string, { start: string; end: string }>();
                if (assignedShiftRowIds.length > 0) {
                        const assignedShiftRows = await db
                                .select({
                                        id: scheduleShiftRows.id,
                                        startTime: scheduleShiftRows.startTime,
                                        endTime: scheduleShiftRows.endTime,
                                })
                                .from(scheduleShiftRows)
                                .where(inArray(scheduleShiftRows.id, assignedShiftRowIds));
                        shiftRowTimes = new Map(
                                assignedShiftRows.map((r) => [
                                        r.id,
                                        { start: r.startTime, end: r.endTime },
                                ]),
                        );
                }

                // Find employees with schedule conflicts
                const employeesWithConflicts = new Map<string, string>(); // employeeId -> conflict summary
                for (const assignment of existingAssignments) {
                        const times = shiftRowTimes.get(assignment.shiftRowId);
                        if (times) {
                                const existingStartMin = this.timeToMinutes(times.start);
                                const existingEndMin = this.timeToMinutes(times.end);
                                const hasOverlap =
                                        targetStartMin < existingEndMin &&
                                        existingStartMin < targetEndMin;
                                if (hasOverlap) {
                                        employeesWithConflicts.set(
                                                assignment.employeeId,
                                                `Shift ${times.start.slice(0, 5)}-${times.end.slice(0, 5)}`,
                                        );
                                }
                        }
                }

                // Get branch names
                const branchMap = new Map(siblingBranches.map((b) => [b.id, b.name]));

                // Build result
                return {
                        hasSiblingBranches: true,
                        candidates: candidates
                                .map((c) => {
                                        let availabilityStatus:
                                                | "AVAILABLE"
                                                | "NOT_AVAILABLE"
                                                | "ON_LEAVE" = "AVAILABLE";
                                        let conflictingShiftSummary: string | undefined;

                                        if (
                                                employeesOnLeave.has(c.id) ||
                                                employeesWithDayOff.has(c.id)
                                        ) {
                                                availabilityStatus = "ON_LEAVE";
                                        } else if (employeesWithConflicts.has(c.id)) {
                                                availabilityStatus = "NOT_AVAILABLE";
                                                conflictingShiftSummary = employeesWithConflicts.get(
                                                        c.id,
                                                );
                                        }

                                        return {
                                                employeeId: c.id,
                                                name: c.fullName,
                                                nickname: c.nickname || "",
                                                homeBranchId: c.branchId,
                                                homeBranchName: branchMap.get(c.branchId) || "Unknown",
                                                roles: rolesByEmployee.get(c.id) || [],
                                                availabilityStatus,
                                                conflictingShiftSummary,
                                        };
                                })
                                .sort((a, b) => {
                                        // Sort: AVAILABLE first, then NOT_AVAILABLE, then ON_LEAVE
                                        const order = {
                                                AVAILABLE: 0,
                                                NOT_AVAILABLE: 1,
                                                ON_LEAVE: 2,
                                        };
                                        return (
                                                order[a.availabilityStatus] -
                                                        order[b.availabilityStatus] ||
                                                a.name.localeCompare(b.name)
                                        );
                                }),
                };
        }

        private timeToMinutes(time: string): number {
                const [hours, minutes] = time.split(":").map(Number);
                return hours * 60 + (minutes || 0);
        }

        async canAssignEmployeeToShift(
                employeeId: string,
                shiftRowId: string,
                date: string,
                options?: { isBorrowed?: boolean; excludeAssignmentId?: string },
        ): Promise<{
                ok: boolean;
                reasonCode?: string;
                message?: string;
                conflictingShift?: {
                        shiftRowId: string;
                        startTime: string;
                        endTime: string;
                };
        }> {
                const isBorrowed = options?.isBorrowed || false;
                const excludeAssignmentId = options?.excludeAssignmentId;
                const [shiftRow] = await db
                        .select()
                        .from(scheduleShiftRows)
                        .where(eq(scheduleShiftRows.id, shiftRowId));
                if (!shiftRow)
                        return {
                                ok: false,
                                reasonCode: "NOT_FOUND",
                                message: "Shift row not found",
                        };

                const [employee] = await db
                        .select()
                        .from(employees)
                        .where(eq(employees.id, employeeId));
                if (!employee)
                        return {
                                ok: false,
                                reasonCode: "NOT_FOUND",
                                message: "Employee not found",
                        };

                // Check employee start date - cannot assign shifts before employee's start date
                if (employee.startDate) {
                        const shiftDateObj = new Date(date);
                        const startDateObj = new Date(employee.startDate);
                        // Normalize to date-only comparison (ignore time component)
                        shiftDateObj.setHours(0, 0, 0, 0);
                        startDateObj.setHours(0, 0, 0, 0);

                        if (shiftDateObj < startDateObj) {
                                const formattedStartDate = startDateObj
                                        .toISOString()
                                        .split("T")[0];
                                return {
                                        ok: false,
                                        reasonCode: "NOT_YET_STARTED",
                                        message: `Can't assign: employee hasn't started yet. Start date is ${formattedStartDate}.`,
                                };
                        }
                }

                // Check last working day - cannot assign shifts after employee's last working day
                if (employee.lastWorkingDay) {
                        const shiftDateObj = new Date(date);
                        const lastDayObj = new Date(employee.lastWorkingDay);
                        // Normalize to date-only comparison (ignore time component)
                        shiftDateObj.setHours(0, 0, 0, 0);
                        lastDayObj.setHours(0, 0, 0, 0);

                        if (shiftDateObj > lastDayObj) {
                                const formattedLastDay = lastDayObj.toISOString().split("T")[0];
                                return {
                                        ok: false,
                                        reasonCode: "EMPLOYMENT_ENDED",
                                        message: `Can't assign: employee's last working day was ${formattedLastDay}.`,
                                };
                        }
                }

                // Check if employee has LEFT (resigned/terminated after last day)
                if (employee.employmentState === "LEFT") {
                        return {
                                ok: false,
                                reasonCode: "EMPLOYMENT_ENDED",
                                message: `Can't assign: employee is no longer employed.`,
                        };
                }

                // Check if already assigned to this specific shift
                const existingThisShift = await db
                        .select()
                        .from(scheduleAssignments)
                        .where(
                                and(
                                        eq(scheduleAssignments.shiftRowId, shiftRowId),
                                        eq(scheduleAssignments.shiftDate, date),
                                        eq(scheduleAssignments.employeeId, employeeId),
                                ),
                        );
                if (existingThisShift.length > 0) {
                        return {
                                ok: false,
                                reasonCode: "ALREADY_ASSIGNED",
                                message: "Employee is already assigned to this shift.",
                        };
                }

                // 0. Department check: employee's primary department must match the shift row's department.
                // Skip if: the shift row has no departmentId, the employee has no primaryDepartmentId,
                // or this is a borrowed cross-branch assignment (isBorrowed).
                if (
                        shiftRow.departmentId &&
                        employee.primaryDepartmentId &&
                        !isBorrowed
                ) {
                        if (employee.primaryDepartmentId !== shiftRow.departmentId) {
                                return {
                                        ok: false,
                                        reasonCode: "DEPT_MISMATCH",
                                        message:
                                                "Can't assign: employee is not in the shift's department.",
                                };
                        }
                }

                // 1. Role qualification check
                const requiredRoles = await db
                        .select({ roleId: scheduleShiftRowRoles.roleId })
                        .from(scheduleShiftRowRoles)
                        .where(eq(scheduleShiftRowRoles.shiftRowId, shiftRowId));

                if (requiredRoles.length > 0) {
                        const roleIds = requiredRoles.map((r) => r.roleId);
                        const employeeRoleRecords = await db
                                .select({ roleId: employeeRoles.roleId })
                                .from(employeeRoles)
                                .where(
                                        and(
                                                eq(employeeRoles.employeeId, employeeId),
                                                inArray(employeeRoles.roleId, roleIds),
                                        ),
                                );

                        if (employeeRoleRecords.length === 0) {
                                return {
                                        ok: false,
                                        reasonCode: "ROLE_MISMATCH",
                                        message:
                                                "Can't assign: employee isn't qualified for the required role.",
                                };
                        }
                }

                // 2. Branch transfer check - prevent assigning in old branch after transfer effective date
                // BUT allow if it's a borrowed assignment (isBorrowed = true)
                // Get the week plan to find the branch
                const [weekPlan] = await db
                        .select()
                        .from(scheduleWeekPlans)
                        .where(eq(scheduleWeekPlans.id, shiftRow.weekPlanId));

                if (weekPlan && !isBorrowed) {
                        const shiftBranchId = weekPlan.branchId;
                        // If employee's current branch doesn't match the shift's branch, check for transfer
                        if (employee.branchId !== shiftBranchId) {
                                // Check if there was a transfer from this branch
                                const transferRecords = await db
                                        .select()
                                        .from(employeeChanges)
                                        .where(
                                                and(
                                                        eq(employeeChanges.employeeId, employeeId),
                                                        eq(employeeChanges.changeType, "branch_transfer"),
                                                        eq(employeeChanges.oldBranchId, shiftBranchId),
                                                        sql`${employeeChanges.effectiveDate}::date <= ${date}::date`,
                                                ),
                                        )
                                        .orderBy(desc(employeeChanges.effectiveDate))
                                        .limit(1);

                                if (transferRecords.length > 0) {
                                        return {
                                                ok: false,
                                                reasonCode: "TRANSFERRED",
                                                message:
                                                        "Can't assign: employee has been permanently transferred from this branch.",
                                        };
                                }
                        }
                }

                // 3. Leave / time-off check (use date-only comparison to handle noon timestamps)
                const timeOffRecords = await db
                        .select()
                        .from(employeeTimeOff)
                        .where(
                                and(
                                        eq(employeeTimeOff.employeeId, employeeId),
                                        sql`${employeeTimeOff.startDate}::date <= ${date}::date`,
                                        sql`${employeeTimeOff.endDate}::date >= ${date}::date`,
                                ),
                        );

                if (timeOffRecords.length > 0) {
                        // Check for half-day leave conflict
                        const shiftStartMin = this.timeToMinutes(shiftRow.startTime);
                        const MIDDAY_MINUTES = 13 * 60; // 13:00 boundary between AM and PM

                        for (const leave of timeOffRecords) {
                                if (leave.isHalfDay && leave.halfDayPeriod) {
                                        // AM leave blocks shifts starting before 13:00
                                        if (
                                                leave.halfDayPeriod === "AM" &&
                                                shiftStartMin < MIDDAY_MINUTES
                                        ) {
                                                return {
                                                        ok: false,
                                                        reasonCode: "ON_LEAVE",
                                                        message:
                                                                "Can't assign: employee has AM half-day leave.",
                                                };
                                        }
                                        // PM leave blocks shifts starting at or after 13:00
                                        if (
                                                leave.halfDayPeriod === "PM" &&
                                                shiftStartMin >= MIDDAY_MINUTES
                                        ) {
                                                return {
                                                        ok: false,
                                                        reasonCode: "ON_LEAVE",
                                                        message:
                                                                "Can't assign: employee has PM half-day leave.",
                                                };
                                        }
                                        // Half-day leave for the other period doesn't block this shift
                                        continue;
                                }
                                // Full-day leave blocks all shifts
                                return {
                                        ok: false,
                                        reasonCode: "ON_LEAVE",
                                        message: "Can't assign: employee is on leave or holiday.",
                                };
                        }
                }

                // 4. Weekly day-off check
                const dateObj = new Date(date + "T00:00:00");
                const dayOfWeek = dateObj.getUTCDay();
                if (
                        employee.weeklyOffDays &&
                        employee.weeklyOffDays.includes(dayOfWeek)
                ) {
                        return {
                                ok: false,
                                reasonCode: "DAY_OFF",
                                message:
                                        "Can't assign: this is the employee's scheduled day off.",
                        };
                }

                // 5. Overlapping shift check - employee can have multiple non-overlapping shifts per day
                const targetStartMin = this.timeToMinutes(shiftRow.startTime);
                const targetEndMin = this.timeToMinutes(shiftRow.endTime);

                const assignmentConditions = [
                        eq(scheduleAssignments.employeeId, employeeId),
                        eq(scheduleAssignments.shiftDate, date),
                ];
                if (excludeAssignmentId) {
                        assignmentConditions.push(
                                sql`${scheduleAssignments.id} != ${excludeAssignmentId}`,
                        );
                }
                const existingAssignments = await db
                        .select({
                                shiftRowId: scheduleAssignments.shiftRowId,
                        })
                        .from(scheduleAssignments)
                        .where(and(...assignmentConditions));

                if (existingAssignments.length > 0) {
                        const assignedShiftRowIds = existingAssignments.map(
                                (a) => a.shiftRowId,
                        );
                        const assignedShiftRows = await db
                                .select({
                                        id: scheduleShiftRows.id,
                                        startTime: scheduleShiftRows.startTime,
                                        endTime: scheduleShiftRows.endTime,
                                })
                                .from(scheduleShiftRows)
                                .where(inArray(scheduleShiftRows.id, assignedShiftRowIds));

                        for (const existingShift of assignedShiftRows) {
                                const existingStartMin = this.timeToMinutes(
                                        existingShift.startTime,
                                );
                                const existingEndMin = this.timeToMinutes(
                                        existingShift.endTime,
                                );
                                const hasOverlap =
                                        targetStartMin < existingEndMin &&
                                        existingStartMin < targetEndMin;
                                if (hasOverlap) {
                                        return {
                                                ok: false,
                                                reasonCode: "ALREADY_SCHEDULED",
                                                message: `Can't assign: employee has an overlapping shift (${existingShift.startTime.slice(0, 5)}-${existingShift.endTime.slice(0, 5)}).`,
                                                conflictingShift: {
                                                        shiftRowId: existingShift.id,
                                                        startTime: existingShift.startTime,
                                                        endTime: existingShift.endTime,
                                                },
                                        };
                                }
                        }
                }

                return { ok: true };
        }

        // Check if a casual worker can be assigned to a specific shift (no overlapping shifts)
        async canAssignCasualWorkerToShift(
                casualWorkerId: string,
                shiftRowId: string,
                date: string,
        ): Promise<{
                ok: boolean;
                reasonCode?: string;
                message?: string;
                conflictingShift?: {
                        shiftRowId: string;
                        startTime: string;
                        endTime: string;
                };
        }> {
                // Get the target shift row to know its time
                const [shiftRow] = await db
                        .select()
                        .from(scheduleShiftRows)
                        .where(eq(scheduleShiftRows.id, shiftRowId));

                if (!shiftRow) {
                        return {
                                ok: false,
                                reasonCode: "SHIFT_NOT_FOUND",
                                message: "Shift not found",
                        };
                }

                // Check for existing assignments on this date for this casual worker
                const existingAssignments = await db
                        .select({
                                shiftRowId: scheduleAssignments.shiftRowId,
                        })
                        .from(scheduleAssignments)
                        .where(
                                and(
                                        eq(scheduleAssignments.casualWorkerId, casualWorkerId),
                                        eq(scheduleAssignments.shiftDate, date),
                                ),
                        );

                if (existingAssignments.length > 0) {
                        const assignedShiftRowIds = existingAssignments.map(
                                (a) => a.shiftRowId,
                        );
                        const assignedShiftRows = await db
                                .select({
                                        id: scheduleShiftRows.id,
                                        startTime: scheduleShiftRows.startTime,
                                        endTime: scheduleShiftRows.endTime,
                                })
                                .from(scheduleShiftRows)
                                .where(inArray(scheduleShiftRows.id, assignedShiftRowIds));

                        // Helper to convert HH:MM time to minutes for easy comparison
                        const timeToMinutes = (time: string): number => {
                                const [hours, minutes] = time.split(":").map(Number);
                                return hours * 60 + minutes;
                        };

                        // Check if target shift overlaps with any existing shift
                        const targetStart = timeToMinutes(shiftRow.startTime);
                        const targetEnd = timeToMinutes(shiftRow.endTime);

                        for (const existingShift of assignedShiftRows) {
                                const existingStart = timeToMinutes(existingShift.startTime);
                                const existingEnd = timeToMinutes(existingShift.endTime);

                                // Shifts overlap if they share any time (not just touching)
                                // Overlap occurs when: targetStart < existingEnd AND targetEnd > existingStart
                                if (targetStart < existingEnd && targetEnd > existingStart) {
                                        console.log(
                                                "[SCHEDULING] Casual worker assignment blocked - shift time overlap:",
                                                {
                                                        casualWorkerId,
                                                        date,
                                                        targetShift: {
                                                                start: shiftRow.startTime,
                                                                end: shiftRow.endTime,
                                                        },
                                                        existingShift: {
                                                                id: existingShift.id,
                                                                start: existingShift.startTime,
                                                                end: existingShift.endTime,
                                                        },
                                                },
                                        );
                                        return {
                                                ok: false,
                                                reasonCode: "SHIFT_OVERLAP",
                                                message: `Can't assign: casual worker already has a shift at this time (${existingShift.startTime.slice(0, 5)}-${existingShift.endTime.slice(0, 5)}).`,
                                                conflictingShift: {
                                                        shiftRowId: existingShift.id,
                                                        startTime: existingShift.startTime,
                                                        endTime: existingShift.endTime,
                                                },
                                        };
                                }
                        }
                }

                return { ok: true };
        }

        // Check if employee has any shift assignment on a given date
        // Optionally exclude a specific assignment ID (useful for move/reassign operations)
        async hasEmployeeShiftOnDate(
                employeeId: string,
                date: string,
                excludeAssignmentId?: string,
        ): Promise<boolean> {
                let query = db
                        .select({ id: scheduleAssignments.id })
                        .from(scheduleAssignments)
                        .where(
                                and(
                                        eq(scheduleAssignments.employeeId, employeeId),
                                        eq(scheduleAssignments.shiftDate, date),
                                        excludeAssignmentId
                                                ? ne(scheduleAssignments.id, excludeAssignmentId)
                                                : undefined,
                                ),
                        )
                        .limit(1);
                const assignments = await query;
                return assignments.length > 0;
        }

        // Check if employee has time-off on a given date
        // Optionally exclude a specific time-off ID (useful for move operations)
        async hasEmployeeTimeOffOnDate(
                employeeId: string,
                date: string,
                excludeTimeOffId?: string,
        ): Promise<boolean> {
                const records = await db
                        .select({ id: employeeTimeOff.id })
                        .from(employeeTimeOff)
                        .where(
                                and(
                                        eq(employeeTimeOff.employeeId, employeeId),
                                        sql`${employeeTimeOff.startDate}::date <= ${date}::date`,
                                        sql`${employeeTimeOff.endDate}::date >= ${date}::date`,
                                        excludeTimeOffId
                                                ? ne(employeeTimeOff.id, excludeTimeOffId)
                                                : undefined,
                                ),
                        )
                        .limit(1);
                return records.length > 0;
        }

        async getEmployeeAssignmentsOnDate(
                employeeId: string,
                date: string,
        ): Promise<ScheduleAssignment[]> {
                return db
                        .select()
                        .from(scheduleAssignments)
                        .where(
                                and(
                                        eq(scheduleAssignments.employeeId, employeeId),
                                        eq(scheduleAssignments.shiftDate, date),
                                ),
                        );
        }

        async getBorrowedOutAssignments(
                branchId: string,
                startDate: string,
                endDate: string,
        ): Promise<
                {
                        id: string;
                        employeeId: string;
                        employeeName: string;
                        shiftDate: string;
                        startTime: string;
                        endTime: string;
                        shiftLabel: string | null;
                        departmentName: string | null;
                        toBranchId: string;
                        toBranchName: string;
                }[]
        > {
                const result = await db
                        .select({
                                id: scheduleAssignments.id,
                                employeeId: scheduleAssignments.employeeId,
                                employeeNickname: employees.nickname,
                                employeeFullName: employees.fullName,
                                shiftDate: scheduleAssignments.shiftDate,
                                startTime: scheduleShiftRows.startTime,
                                endTime: scheduleShiftRows.endTime,
                                shiftLabel: scheduleShiftRows.label,
                                departmentName: departments.name,
                                toBranchId: scheduleShiftRows.branchId,
                                toBranchName: branches.name,
                        })
                        .from(scheduleAssignments)
                        .innerJoin(
                                employees,
                                eq(scheduleAssignments.employeeId, employees.id),
                        )
                        .innerJoin(
                                scheduleShiftRows,
                                eq(scheduleAssignments.shiftRowId, scheduleShiftRows.id),
                        )
                        .innerJoin(branches, eq(scheduleShiftRows.branchId, branches.id))
                        .leftJoin(
                                departments,
                                eq(scheduleShiftRows.departmentId, departments.id),
                        )
                        .where(
                                and(
                                        eq(employees.branchId, branchId),
                                        ne(scheduleShiftRows.branchId, branchId),
                                        gte(scheduleAssignments.shiftDate, startDate),
                                        lte(scheduleAssignments.shiftDate, endDate),
                                ),
                        );
                return result.map((r) => ({
                        id: r.id,
                        employeeId: r.employeeId,
                        employeeName:
                                r.employeeNickname?.trim() || r.employeeFullName || "Unknown",
                        shiftDate: r.shiftDate,
                        startTime: r.startTime,
                        endTime: r.endTime,
                        shiftLabel: r.shiftLabel,
                        departmentName: r.departmentName,
                        toBranchId: r.toBranchId,
                        toBranchName: r.toBranchName,
                }));
        }

        async getScheduleTemplates(
                branchId: string,
                departmentId?: string,
                shiftGroupId?: string,
        ): Promise<any[]> {
                const conditions = [eq(scheduleTemplates.branchId, branchId)];
                if (shiftGroupId) {
                        conditions.push(eq(scheduleTemplates.shiftGroupId, shiftGroupId));
                } else if (departmentId) {
                        conditions.push(eq(scheduleTemplates.departmentId, departmentId));
                }
                const results = await db
                        .select({
                                template: scheduleTemplates,
                                department: departments,
                                shiftGroup: shiftGroups,
                        })
                        .from(scheduleTemplates)
                        .leftJoin(
                                departments,
                                eq(scheduleTemplates.departmentId, departments.id),
                        )
                        .leftJoin(
                                shiftGroups,
                                eq(scheduleTemplates.shiftGroupId, shiftGroups.id),
                        )
                        .where(and(...conditions))
                        .orderBy(desc(scheduleTemplates.createdAt));

                return results.map((r) => ({
                        ...r.template,
                        department: r.department || undefined,
                        shiftGroup: r.shiftGroup || undefined,
                }));
        }

        async getScheduleTemplate(
                id: string,
        ): Promise<ScheduleTemplateWithDetails | undefined> {
                const [template] = await db
                        .select()
                        .from(scheduleTemplates)
                        .where(eq(scheduleTemplates.id, id));

                if (!template) return undefined;

                const [branch] = await db
                        .select()
                        .from(branches)
                        .where(eq(branches.id, template.branchId));

                const rowsData = await db
                        .select()
                        .from(scheduleTemplateRows)
                        .where(eq(scheduleTemplateRows.templateId, id))
                        .orderBy(scheduleTemplateRows.rowOrder);

                const allRowIds = rowsData.map((r) => r.id);
                const allRolesData =
                        allRowIds.length > 0
                                ? await db
                                                .select({
                                                        id: scheduleTemplateRowRoles.id,
                                                        tenantId: scheduleTemplateRowRoles.tenantId,
                                                        templateRowId:
                                                                scheduleTemplateRowRoles.templateRowId,
                                                        roleId: scheduleTemplateRowRoles.roleId,
                                                        role: roles,
                                                })
                                                .from(scheduleTemplateRowRoles)
                                                .leftJoin(
                                                        roles,
                                                        eq(scheduleTemplateRowRoles.roleId, roles.id),
                                                )
                                                .where(
                                                        inArray(
                                                                scheduleTemplateRowRoles.templateRowId,
                                                                allRowIds,
                                                        ),
                                                )
                                : [];

                const deptIds = [
                        ...new Set(rowsData.map((r) => r.departmentId).filter(Boolean)),
                ] as string[];
                const allDepts =
                        deptIds.length > 0
                                ? await db
                                                .select()
                                                .from(departments)
                                                .where(inArray(departments.id, deptIds))
                                : [];
                const deptMap = new Map(allDepts.map((d) => [d.id, d]));

                const rows = rowsData.map((row) => ({
                        ...row,
                        department: row.departmentId
                                ? deptMap.get(row.departmentId)
                                : undefined,
                        roles: allRolesData
                                .filter((r) => r.templateRowId === row.id)
                                .map((r) => ({
                                        id: r.id,
                                        tenantId: r.tenantId,
                                        templateRowId: r.templateRowId,
                                        roleId: r.roleId,
                                        role: r.role || undefined,
                                })),
                }));

                const [department] = template.departmentId
                        ? await db
                                        .select()
                                        .from(departments)
                                        .where(eq(departments.id, template.departmentId))
                        : [undefined];

                const [shiftGroup] = template.shiftGroupId
                        ? await db
                                        .select()
                                        .from(shiftGroups)
                                        .where(eq(shiftGroups.id, template.shiftGroupId))
                        : [undefined];

                return {
                        ...template,
                        branch,
                        department,
                        shiftGroup,
                        rows,
                };
        }

        async createScheduleTemplate(
                template: InsertScheduleTemplate,
        ): Promise<ScheduleTemplate> {
                const [result] = await db
                        .insert(scheduleTemplates)
                        .values(template)
                        .returning();
                return result;
        }

        async saveWeekAsTemplate(
                weekPlanId: string,
                name: string,
                userId?: string,
                departmentId?: string,
                shiftGroupId?: string,
                branchId?: string,
                weekStartDate?: string,
        ): Promise<ScheduleTemplate> {
                let weekPlan: ScheduleWeekPlan | undefined;

                if (weekPlanId) {
                        const [found] = await db
                                .select()
                                .from(scheduleWeekPlans)
                                .where(eq(scheduleWeekPlans.id, weekPlanId));
                        weekPlan = found;
                }

                // If no plan found by id, auto-create one using branchId + weekStartDate
                if (!weekPlan) {
                        if (!branchId || !weekStartDate)
                                throw new Error("Week plan not found");
                        weekPlan = await this.getOrCreateWeekPlan(
                                branchId,
                                weekStartDate,
                                userId,
                        );
                }

                const weekStart = new Date(weekPlan.weekStartDate);
                const weekEnd = new Date(weekStart);
                weekEnd.setDate(weekEnd.getDate() + 6);
                const weekStartStr = weekStart.toISOString().split("T")[0];
                const weekEndStr = weekEnd.toISOString().split("T")[0];

                // For dept templates: find shift rows that have at least one assignment
                // this week where the assigned employee's primaryDepartmentId matches.
                // This is correct because shift_rows.department_id is never written by
                // the UI — the department association lives on the employee.
                let shiftRows: ScheduleShiftRow[];
                // Assignments scoped to the dept filter (populated only for dept templates)
                let deptScopedAssignmentIds: Set<string> | null = null;

                if (departmentId) {
                        // Find all assignments this week for employees in this department.
                        // Filter by date range + branch (via the shift row), not by weekPlanId,
                        // because the weekPlan may have just been auto-created and is empty.
                        const deptAssignments = await db
                                .select({
                                        id: scheduleAssignments.id,
                                        shiftRowId: scheduleAssignments.shiftRowId,
                                        employeeId: scheduleAssignments.employeeId,
                                        shiftDate: scheduleAssignments.shiftDate,
                                })
                                .from(scheduleAssignments)
                                .innerJoin(
                                        employees,
                                        eq(scheduleAssignments.employeeId, employees.id),
                                )
                                .innerJoin(
                                        scheduleShiftRows,
                                        eq(scheduleAssignments.shiftRowId, scheduleShiftRows.id),
                                )
                                .where(
                                        and(
                                                eq(scheduleShiftRows.branchId, weekPlan.branchId),
                                                eq(employees.primaryDepartmentId, departmentId),
                                                gte(scheduleAssignments.shiftDate, weekStartStr),
                                                sql`${scheduleAssignments.shiftDate} <= ${weekEndStr}`,
                                        ),
                                );

                        // Collect the distinct shift rows referenced by those assignments
                        const deptShiftRowIds = [
                                ...new Set(deptAssignments.map((a) => a.shiftRowId)),
                        ];
                        deptScopedAssignmentIds = new Set(deptAssignments.map((a) => a.id));

                        shiftRows =
                                deptShiftRowIds.length > 0
                                        ? await db
                                                        .select()
                                                        .from(scheduleShiftRows)
                                                        .where(
                                                                and(
                                                                        inArray(
                                                                                scheduleShiftRows.id,
                                                                                deptShiftRowIds,
                                                                        ),
                                                                        or(
                                                                                isNull(
                                                                                        scheduleShiftRows.activeUntilDate,
                                                                                ),
                                                                                sql`${scheduleShiftRows.activeUntilDate} >= CURRENT_DATE`,
                                                                        ),
                                                                ),
                                                        )
                                                        .orderBy(scheduleShiftRows.rowOrder)
                                        : [];
                } else {
                        // Shift-group template: filter shift rows directly by shift group
                        const shiftRowConditions: any[] = [
                                eq(scheduleShiftRows.branchId, weekPlan.branchId),
                                or(
                                        isNull(scheduleShiftRows.activeUntilDate),
                                        sql`${scheduleShiftRows.activeUntilDate} >= CURRENT_DATE`,
                                ),
                        ];
                        if (shiftGroupId) {
                                shiftRowConditions.push(
                                        eq(scheduleShiftRows.shiftGroupId, shiftGroupId),
                                );
                        }
                        shiftRows = await db
                                .select()
                                .from(scheduleShiftRows)
                                .where(and(...shiftRowConditions))
                                .orderBy(scheduleShiftRows.rowOrder);

                        if (shiftRows.length === 0) {
                                throw new Error(
                                        "No shift rows found for the selected shift group",
                                );
                        }
                }

                const [template] = await db
                        .insert(scheduleTemplates)
                        .values({
                                tenantId: weekPlan.tenantId,
                                branchId: weekPlan.branchId,
                                departmentId: departmentId || null,
                                shiftGroupId: shiftGroupId || null,
                                name,
                                sourceWeekPlanId: weekPlan.id,
                                createdBy: userId,
                        })
                        .returning();

                const allRowIds = shiftRows.map((r) => r.id);
                const allRoles =
                        allRowIds.length > 0
                                ? await db
                                                .select()
                                                .from(scheduleShiftRowRoles)
                                                .where(
                                                        inArray(
                                                                scheduleShiftRowRoles.shiftRowId,
                                                                allRowIds,
                                                        ),
                                                )
                                : [];

                const seen = new Map<string, number>();
                const uniqueShiftRows: typeof shiftRows = [];
                for (const row of shiftRows) {
                        const key = `${row.label}|${row.startTime}|${row.endTime}|${row.shiftGroupId || ""}`;
                        if (!seen.has(key)) {
                                seen.set(key, uniqueShiftRows.length);
                                uniqueShiftRows.push(row);
                        }
                }

                const templateRowValues = uniqueShiftRows.map((row, i) => ({
                        tenantId: weekPlan.tenantId,
                        templateId: template.id,
                        departmentId: departmentId || row.departmentId,
                        shiftGroupId: row.shiftGroupId || null,
                        rowOrder: i,
                        label: row.label,
                        startTime: row.startTime,
                        endTime: row.endTime,
                        staffRequired: row.staffRequired,
                        staffRequiredByDay: row.staffRequiredByDay,
                        colorIndex: row.colorIndex ?? i,
                        breakEnabled: row.breakEnabled,
                        breakDurationMinutes: row.breakDurationMinutes,
                        breakBaseOffsetMinutes: row.breakBaseOffsetMinutes,
                        breakStaggerMinutes: row.breakStaggerMinutes,
                }));

                const insertedRows =
                        templateRowValues.length > 0
                                ? await db
                                                .insert(scheduleTemplateRows)
                                                .values(templateRowValues)
                                                .returning()
                                : [];

                const shiftRowIdToTemplateRowId = new Map<string, string>();
                uniqueShiftRows.forEach((sr, i) =>
                        shiftRowIdToTemplateRowId.set(sr.id, insertedRows[i].id),
                );
                for (const row of shiftRows) {
                        if (!shiftRowIdToTemplateRowId.has(row.id)) {
                                const key = `${row.label}|${row.startTime}|${row.endTime}|${row.shiftGroupId || ""}`;
                                const idx = seen.get(key)!;
                                shiftRowIdToTemplateRowId.set(row.id, insertedRows[idx].id);
                        }
                }

                const roleValues = allRoles.map((r) => ({
                        tenantId: weekPlan.tenantId,
                        templateRowId: shiftRowIdToTemplateRowId.get(r.shiftRowId)!,
                        roleId: r.roleId,
                }));

                if (roleValues.length > 0) {
                        await db.insert(scheduleTemplateRowRoles).values(roleValues);
                }

                // Save assignments from the source week.
                // For dept templates, only save assignments for employees in that dept.
                const weekAssignments = await db
                        .select()
                        .from(scheduleAssignments)
                        .where(
                                and(
                                        inArray(scheduleAssignments.shiftRowId, allRowIds),
                                        gte(scheduleAssignments.shiftDate, weekStartStr),
                                        sql`${scheduleAssignments.shiftDate} <= ${weekEndStr}`,
                                ),
                        );

                const filteredAssignments = deptScopedAssignmentIds
                        ? weekAssignments.filter((a) => deptScopedAssignmentIds!.has(a.id))
                        : weekAssignments;

                if (filteredAssignments.length > 0) {
                        const templateAssignmentValues: InsertScheduleTemplateAssignment[] =
                                [];
                        for (const a of filteredAssignments) {
                                const templateRowId = shiftRowIdToTemplateRowId.get(
                                        a.shiftRowId,
                                );
                                if (!templateRowId || !a.employeeId) continue;
                                const shiftDate = new Date(a.shiftDate);
                                const dayOfWeek = (shiftDate.getDay() + 6) % 7; // Convert JS Sunday=0 to Mon=0
                                templateAssignmentValues.push({
                                        templateRowId,
                                        dayOfWeek,
                                        employeeId: a.employeeId,
                                });
                        }
                        if (templateAssignmentValues.length > 0) {
                                const insertedTemplateAssignments = await db
                                        .insert(scheduleTemplateAssignments)
                                        .values(templateAssignmentValues)
                                        .returning();

                                // Save duty blocks linked to each assignment.
                                // Map original assignment id → inserted template assignment id.
                                const assignmentIdToTemplateAssignmentId = new Map<
                                        string,
                                        string
                                >();
                                filteredAssignments.forEach((a, i) => {
                                        const templateRowId = shiftRowIdToTemplateRowId.get(
                                                a.shiftRowId,
                                        );
                                        if (!templateRowId || !a.employeeId) return;
                                        assignmentIdToTemplateAssignmentId.set(
                                                a.id,
                                                insertedTemplateAssignments[i].id,
                                        );
                                });

                                const sourceAssignmentIds = filteredAssignments.map(
                                        (a) => a.id,
                                );
                                const sourceDutyBlocks =
                                        sourceAssignmentIds.length > 0
                                                ? await db
                                                                .select()
                                                                .from(dutyBlocks)
                                                                .where(
                                                                        inArray(
                                                                                dutyBlocks.assignmentId,
                                                                                sourceAssignmentIds,
                                                                        ),
                                                                )
                                                : [];

                                if (sourceDutyBlocks.length > 0) {
                                        const dutyBlockValues: InsertScheduleTemplateDutyBlock[] =
                                                sourceDutyBlocks
                                                        .map((db_) => {
                                                                const templateAssignmentId =
                                                                        assignmentIdToTemplateAssignmentId.get(
                                                                                db_.assignmentId,
                                                                        );
                                                                if (!templateAssignmentId) return null;
                                                                return {
                                                                        templateAssignmentId,
                                                                        dutyTypeId: db_.dutyTypeId,
                                                                        dutyName: db_.dutyName,
                                                                        startTime: db_.startTime,
                                                                        endTime: db_.endTime,
                                                                        notes: db_.notes,
                                                                } as InsertScheduleTemplateDutyBlock;
                                                        })
                                                        .filter(
                                                                (v): v is InsertScheduleTemplateDutyBlock =>
                                                                        v !== null,
                                                        );

                                        if (dutyBlockValues.length > 0) {
                                                await db
                                                        .insert(scheduleTemplateDutyBlocks)
                                                        .values(dutyBlockValues);
                                        }
                                }
                        }
                }

                // Save time-off from the source week.
                // For dept templates, only capture time-off for employees in that dept.
                const timeOffConditions: any[] = [
                        eq(employeeTimeOff.branchId, weekPlan.branchId),
                        gte(employeeTimeOff.startDate, new Date(weekStartStr)),
                        sql`${employeeTimeOff.startDate} <= ${weekEndStr}::date`,
                ];
                if (departmentId) {
                        // Scope to employees whose primaryDepartmentId matches
                        const deptEmployeeIds = await db
                                .select({ id: employees.id })
                                .from(employees)
                                .where(eq(employees.primaryDepartmentId, departmentId))
                                .then((rows) => rows.map((r) => r.id));
                        if (deptEmployeeIds.length > 0) {
                                timeOffConditions.push(
                                        inArray(employeeTimeOff.employeeId, deptEmployeeIds),
                                );
                        } else {
                                // No employees in dept — skip time-off entirely
                                return template;
                        }
                }
                const weekTimeOff = await db
                        .select()
                        .from(employeeTimeOff)
                        .where(and(...timeOffConditions));

                if (weekTimeOff.length > 0) {
                        const templateTimeOffValues: InsertScheduleTemplateTimeOff[] = [];
                        for (const t of weekTimeOff) {
                                const offDate = new Date(t.startDate);
                                const dayOfWeek = (offDate.getDay() + 6) % 7;
                                templateTimeOffValues.push({
                                        tenantId: weekPlan.tenantId,
                                        templateId: template.id,
                                        dayOfWeek,
                                        employeeId: t.employeeId,
                                        type: t.type,
                                });
                        }
                        if (templateTimeOffValues.length > 0) {
                                await db
                                        .insert(scheduleTemplateTimeOff)
                                        .values(templateTimeOffValues);
                        }
                }

                return template;
        }

        async applyTemplate(
                templateId: string,
                weekPlanId: string,
                userId?: string,
        ): Promise<void> {
                const template = await this.getScheduleTemplate(templateId);
                if (!template) throw new Error("Template not found");

                const [weekPlan] = await db
                        .select()
                        .from(scheduleWeekPlans)
                        .where(eq(scheduleWeekPlans.id, weekPlanId));

                if (!weekPlan) throw new Error("Week plan not found");

                // Query existing shift rows by branch (not weekPlanId) since shift rows are now branch-level
                const existingRows = await db
                        .select()
                        .from(scheduleShiftRows)
                        .where(
                                and(
                                        eq(scheduleShiftRows.branchId, weekPlan.branchId),
                                        or(
                                                isNull(scheduleShiftRows.activeUntilDate),
                                                sql`${scheduleShiftRows.activeUntilDate} >= CURRENT_DATE`,
                                        ),
                                ),
                        );

                for (const templateRow of template.rows) {
                        const exactMatch = existingRows.find(
                                (existing) =>
                                        existing.label === templateRow.label &&
                                        existing.startTime === templateRow.startTime &&
                                        existing.endTime === templateRow.endTime &&
                                        existing.shiftGroupId === templateRow.shiftGroupId,
                        );
                        if (exactMatch) continue;

                        // Check if a row with the same label + group exists but with different times
                        // (e.g., hours were updated in the template). Update the existing row instead of creating a duplicate.
                        const sameNameRow = existingRows.find(
                                (existing) =>
                                        existing.label === templateRow.label &&
                                        existing.shiftGroupId === templateRow.shiftGroupId &&
                                        (existing.startTime !== templateRow.startTime ||
                                                existing.endTime !== templateRow.endTime),
                        );
                        if (sameNameRow) {
                                await db
                                        .update(scheduleShiftRows)
                                        .set({
                                                startTime: templateRow.startTime,
                                                endTime: templateRow.endTime,
                                                staffRequired:
                                                        templateRow.staffRequired ??
                                                        sameNameRow.staffRequired,
                                                breakEnabled:
                                                        templateRow.breakEnabled ??
                                                        sameNameRow.breakEnabled,
                                                breakDurationMinutes:
                                                        templateRow.breakDurationMinutes ??
                                                        sameNameRow.breakDurationMinutes,
                                                breakBaseOffsetMinutes:
                                                        templateRow.breakBaseOffsetMinutes ??
                                                        sameNameRow.breakBaseOffsetMinutes,
                                                breakStaggerMinutes:
                                                        templateRow.breakStaggerMinutes ??
                                                        sameNameRow.breakStaggerMinutes,
                                        })
                                        .where(eq(scheduleShiftRows.id, sameNameRow.id));
                                continue;
                        }

                        const today = new Date().toISOString().split("T")[0];
                        const [newRow] = await db
                                .insert(scheduleShiftRows)
                                .values({
                                        tenantId: weekPlan.tenantId,
                                        branchId: weekPlan.branchId,
                                        departmentId: templateRow.departmentId,
                                        shiftGroupId: templateRow.shiftGroupId,
                                        rowOrder: templateRow.rowOrder,
                                        label: templateRow.label,
                                        startTime: templateRow.startTime,
                                        endTime: templateRow.endTime,
                                        staffRequired: templateRow.staffRequired ?? 1,
                                        staffRequiredByDay: templateRow.staffRequiredByDay,
                                        colorIndex: templateRow.colorIndex,
                                        breakEnabled: templateRow.breakEnabled,
                                        breakDurationMinutes: templateRow.breakDurationMinutes,
                                        breakBaseOffsetMinutes: templateRow.breakBaseOffsetMinutes,
                                        breakStaggerMinutes: templateRow.breakStaggerMinutes,
                                        activeFromDate: today,
                                        createdBy: userId,
                                })
                                .returning();

                        if (templateRow.roles.length > 0) {
                                await db
                                        .insert(scheduleShiftRowRoles)
                                        .values(
                                                templateRow.roles.map((r) => ({
                                                        tenantId: weekPlan.tenantId,
                                                        shiftRowId: newRow.id,
                                                        roleId: r.roleId,
                                                })),
                                        );
                        }
                }
        }

        async deleteScheduleTemplate(id: string): Promise<void> {
                await db.delete(scheduleTemplates).where(eq(scheduleTemplates.id, id));
        }

        async previewTemplateApply(
                templateId: string,
                branchId: string,
                weekStartDate: string,
        ): Promise<{
                templateRows: number;
                rowsToAdd: Array<{
                        label: string | null;
                        startTime: string;
                        endTime: string;
                        shiftGroupName?: string;
                        departmentName?: string;
                }>;
                rowsAlreadyExist: Array<{
                        label: string | null;
                        startTime: string;
                        endTime: string;
                        shiftGroupName?: string;
                        departmentName?: string;
                }>;
                assignmentsToApply: number;
                timeOffToApply: number;
        }> {
                const template = await this.getScheduleTemplate(templateId);
                if (!template) throw new Error("Template not found");

                // Query existing active shift rows by branch (not weekPlan-scoped)
                const existingRows = await db
                        .select({
                                id: scheduleShiftRows.id,
                                label: scheduleShiftRows.label,
                                startTime: scheduleShiftRows.startTime,
                                endTime: scheduleShiftRows.endTime,
                                shiftGroupId: scheduleShiftRows.shiftGroupId,
                                departmentId: scheduleShiftRows.departmentId,
                        })
                        .from(scheduleShiftRows)
                        .where(
                                and(
                                        eq(scheduleShiftRows.branchId, branchId),
                                        or(
                                                isNull(scheduleShiftRows.activeUntilDate),
                                                sql`${scheduleShiftRows.activeUntilDate} >= CURRENT_DATE`,
                                        ),
                                ),
                        );

                const rowsToAdd: Array<{
                        label: string | null;
                        startTime: string;
                        endTime: string;
                        shiftGroupName?: string;
                        departmentName?: string;
                }> = [];
                const rowsAlreadyExist: Array<{
                        label: string | null;
                        startTime: string;
                        endTime: string;
                        shiftGroupName?: string;
                        departmentName?: string;
                }> = [];
                const templateRowIdToShiftRowId = new Map<string, string>();

                for (const templateRow of template.rows) {
                        const info = {
                                label: templateRow.label,
                                startTime: templateRow.startTime,
                                endTime: templateRow.endTime,
                                shiftGroupName: template.shiftGroup?.name,
                                departmentName: templateRow.department?.name,
                        };

                        const existing = existingRows.find(
                                (e) =>
                                        e.label === templateRow.label &&
                                        e.startTime === templateRow.startTime &&
                                        e.endTime === templateRow.endTime &&
                                        (e.departmentId || null) ===
                                                (templateRow.departmentId || null) &&
                                        (e.shiftGroupId || null) ===
                                                (templateRow.shiftGroupId || null),
                        );

                        if (existing) {
                                rowsAlreadyExist.push(info);
                                templateRowIdToShiftRowId.set(templateRow.id, existing.id);
                        } else {
                                rowsToAdd.push(info);
                        }
                }

                // Count assignments from the template that would be applied to this week
                const allTemplateRowIds = template.rows.map((r) => r.id);
                const templateAssignments =
                        allTemplateRowIds.length > 0
                                ? await db
                                                .select()
                                                .from(scheduleTemplateAssignments)
                                                .where(
                                                        inArray(
                                                                scheduleTemplateAssignments.templateRowId,
                                                                allTemplateRowIds,
                                                        ),
                                                )
                                : [];

                // Check existing assignments in target week to count net new ones
                const targetWeekStart = new Date(weekStartDate + "T00:00:00Z");
                const targetWeekEnd = new Date(targetWeekStart);
                targetWeekEnd.setDate(targetWeekEnd.getDate() + 6);
                const targetStartStr = weekStartDate;
                const targetEndStr = targetWeekEnd.toISOString().split("T")[0];

                const targetShiftRowIds = [
                        ...new Set(
                                templateAssignments
                                        .map((a) => templateRowIdToShiftRowId.get(a.templateRowId))
                                        .filter(Boolean),
                        ),
                ] as string[];

                const existingAssignments =
                        targetShiftRowIds.length > 0
                                ? await db
                                                .select()
                                                .from(scheduleAssignments)
                                                .where(
                                                        and(
                                                                inArray(
                                                                        scheduleAssignments.shiftRowId,
                                                                        targetShiftRowIds,
                                                                ),
                                                                gte(
                                                                        scheduleAssignments.shiftDate,
                                                                        targetStartStr,
                                                                ),
                                                                sql`${scheduleAssignments.shiftDate} <= ${targetEndStr}`,
                                                        ),
                                                )
                                : [];

                const existingAssignmentKeys = new Set(
                        existingAssignments.map(
                                (a) => `${a.shiftRowId}|${a.shiftDate}|${a.employeeId}`,
                        ),
                );

                let assignmentsToApply = 0;
                for (const ta of templateAssignments) {
                        const shiftRowId = templateRowIdToShiftRowId.get(ta.templateRowId);
                        if (!shiftRowId) continue;
                        const targetDate = new Date(targetWeekStart);
                        targetDate.setDate(targetDate.getDate() + ta.dayOfWeek);
                        const shiftDate = targetDate.toISOString().split("T")[0];
                        const key = `${shiftRowId}|${shiftDate}|${ta.employeeId}`;
                        if (!existingAssignmentKeys.has(key)) assignmentsToApply++;
                }

                // Count time-off entries that would be applied
                const templateTimeOffEntries = await db
                        .select()
                        .from(scheduleTemplateTimeOff)
                        .where(eq(scheduleTemplateTimeOff.templateId, templateId));

                const existingTimeOff =
                        templateTimeOffEntries.length > 0
                                ? await db
                                                .select()
                                                .from(employeeTimeOff)
                                                .where(
                                                        and(
                                                                eq(employeeTimeOff.branchId, branchId),
                                                                gte(
                                                                        employeeTimeOff.startDate,
                                                                        new Date(targetStartStr),
                                                                ),
                                                                sql`${employeeTimeOff.startDate} <= ${targetEndStr}::date`,
                                                        ),
                                                )
                                : [];
                const existingTimeOffKeys = new Set(
                        existingTimeOff.map((t) => {
                                const d = new Date(t.startDate);
                                return `${d.toISOString().split("T")[0]}|${t.employeeId}`;
                        }),
                );

                let timeOffToApply = 0;
                for (const tt of templateTimeOffEntries) {
                        const targetDate = new Date(targetWeekStart);
                        targetDate.setDate(targetDate.getDate() + tt.dayOfWeek);
                        const dateStr = targetDate.toISOString().split("T")[0];
                        if (!existingTimeOffKeys.has(`${dateStr}|${tt.employeeId}`))
                                timeOffToApply++;
                }

                return {
                        templateRows: template.rows.length,
                        rowsToAdd,
                        rowsAlreadyExist,
                        assignmentsToApply,
                        timeOffToApply,
                };
        }

        async applyTemplateAdditive(
                templateId: string,
                branchId: string,
                weekStartDate: string,
                userId: string,
        ): Promise<{ rowsAdded: number; rowsSkipped: number }> {
                const template = await this.getScheduleTemplate(templateId);
                if (!template) throw new Error("Template not found");

                const tenantId = template.tenantId;
                // Still create/get the week plan for assignment tracking purposes
                const weekPlan = await this.getOrCreateWeekPlan(
                        branchId,
                        weekStartDate,
                        userId,
                );

                // Query existing active shift rows by branch (not weekPlan-scoped)
                const existingRows = await db
                        .select()
                        .from(scheduleShiftRows)
                        .where(
                                and(
                                        eq(scheduleShiftRows.branchId, branchId),
                                        or(
                                                isNull(scheduleShiftRows.activeUntilDate),
                                                sql`${scheduleShiftRows.activeUntilDate} >= CURRENT_DATE`,
                                        ),
                                ),
                        );

                let rowsAdded = 0;
                let rowsSkipped = 0;
                const templateRowIdToShiftRowId = new Map<string, string>();

                for (const templateRow of template.rows) {
                        const matchingExisting = existingRows.find(
                                (existing) =>
                                        existing.label === templateRow.label &&
                                        existing.startTime === templateRow.startTime &&
                                        existing.endTime === templateRow.endTime &&
                                        (existing.departmentId || null) ===
                                                (templateRow.departmentId || null) &&
                                        (existing.shiftGroupId || null) ===
                                                (templateRow.shiftGroupId || null),
                        );

                        if (matchingExisting) {
                                templateRowIdToShiftRowId.set(
                                        templateRow.id,
                                        matchingExisting.id,
                                );
                                rowsSkipped++;
                                continue;
                        }

                        const today = new Date().toISOString().split("T")[0];
                        const [newRow] = await db
                                .insert(scheduleShiftRows)
                                .values({
                                        tenantId,
                                        branchId,
                                        departmentId: templateRow.departmentId || null,
                                        shiftGroupId: templateRow.shiftGroupId || null,
                                        rowOrder: templateRow.rowOrder,
                                        label: templateRow.label,
                                        startTime: templateRow.startTime,
                                        endTime: templateRow.endTime,
                                        staffRequired: templateRow.staffRequired ?? 1,
                                        staffRequiredByDay: templateRow.staffRequiredByDay,
                                        colorIndex: templateRow.colorIndex,
                                        breakEnabled: templateRow.breakEnabled,
                                        breakDurationMinutes: templateRow.breakDurationMinutes,
                                        breakBaseOffsetMinutes: templateRow.breakBaseOffsetMinutes,
                                        breakStaggerMinutes: templateRow.breakStaggerMinutes,
                                        activeFromDate: today,
                                        createdBy: userId,
                                })
                                .returning();

                        templateRowIdToShiftRowId.set(templateRow.id, newRow.id);

                        if (templateRow.roles.length > 0) {
                                await db
                                        .insert(scheduleShiftRowRoles)
                                        .values(
                                                templateRow.roles.map((r) => ({
                                                        tenantId,
                                                        shiftRowId: newRow.id,
                                                        roleId: r.roleId,
                                                })),
                                        );
                        }

                        rowsAdded++;
                }

                // Apply assignments from template
                const allTemplateRowIds = template.rows.map((r) => r.id);
                const templateAssignments =
                        allTemplateRowIds.length > 0
                                ? await db
                                                .select()
                                                .from(scheduleTemplateAssignments)
                                                .where(
                                                        inArray(
                                                                scheduleTemplateAssignments.templateRowId,
                                                                allTemplateRowIds,
                                                        ),
                                                )
                                : [];

                let assignmentsApplied = 0;
                if (templateAssignments.length > 0) {
                        const targetWeekStart = new Date(weekStartDate + "T00:00:00Z");

                        // Get existing assignments for this week to avoid duplicates
                        const targetWeekEnd = new Date(targetWeekStart);
                        targetWeekEnd.setDate(targetWeekEnd.getDate() + 6);
                        const targetStartStr = weekStartDate;
                        const targetEndStr = targetWeekEnd.toISOString().split("T")[0];

                        const targetShiftRowIds = [
                                ...new Set(
                                        templateAssignments
                                                .map((a) =>
                                                        templateRowIdToShiftRowId.get(a.templateRowId),
                                                )
                                                .filter(Boolean),
                                ),
                        ] as string[];
                        const existingAssignments =
                                targetShiftRowIds.length > 0
                                        ? await db
                                                        .select()
                                                        .from(scheduleAssignments)
                                                        .where(
                                                                and(
                                                                        inArray(
                                                                                scheduleAssignments.shiftRowId,
                                                                                targetShiftRowIds,
                                                                        ),
                                                                        gte(
                                                                                scheduleAssignments.shiftDate,
                                                                                targetStartStr,
                                                                        ),
                                                                        sql`${scheduleAssignments.shiftDate} <= ${targetEndStr}`,
                                                                ),
                                                        )
                                        : [];

                        const existingAssignmentKeys = new Set(
                                existingAssignments.map(
                                        (a) => `${a.shiftRowId}|${a.shiftDate}|${a.employeeId}`,
                                ),
                        );

                        // Track which templateAssignment id maps to each entry so we can later
                        // look up the corresponding duty blocks to recreate.
                        const newAssignments: {
                                tenantId: string;
                                weekPlanId: string;
                                shiftRowId: string;
                                shiftDate: string;
                                employeeId: string;
                        }[] = [];
                        const newAssignmentTemplateIds: string[] = []; // parallel array: templateAssignment.id for each newAssignment
                        for (const ta of templateAssignments) {
                                const shiftRowId = templateRowIdToShiftRowId.get(
                                        ta.templateRowId,
                                );
                                if (!shiftRowId) continue;

                                const targetDate = new Date(targetWeekStart);
                                targetDate.setDate(targetDate.getDate() + ta.dayOfWeek);
                                const shiftDate = targetDate.toISOString().split("T")[0];

                                const key = `${shiftRowId}|${shiftDate}|${ta.employeeId}`;
                                if (existingAssignmentKeys.has(key)) continue;

                                // Validate the employee is still eligible. This catches cases where the
                                // employee has left, changed role, or is on leave since the template was saved.
                                const validation = await this.canAssignEmployeeToShift(
                                        ta.employeeId,
                                        shiftRowId,
                                        shiftDate,
                                        { isBorrowed: false },
                                );
                                if (!validation.ok) continue;

                                newAssignments.push({
                                        tenantId,
                                        weekPlanId: weekPlan.id,
                                        shiftRowId,
                                        shiftDate,
                                        employeeId: ta.employeeId,
                                });
                                newAssignmentTemplateIds.push(ta.id);
                        }

                        if (newAssignments.length > 0) {
                                const insertedAssignments = await db
                                        .insert(scheduleAssignments)
                                        .values(newAssignments)
                                        .returning();
                                assignmentsApplied = insertedAssignments.length;

                                // Recreate duty blocks for each newly-created assignment.
                                const allTemplateDutyBlocks =
                                        newAssignmentTemplateIds.length > 0
                                                ? await db
                                                                .select()
                                                                .from(scheduleTemplateDutyBlocks)
                                                                .where(
                                                                        inArray(
                                                                                scheduleTemplateDutyBlocks.templateAssignmentId,
                                                                                newAssignmentTemplateIds,
                                                                        ),
                                                                )
                                                : [];

                                if (allTemplateDutyBlocks.length > 0) {
                                        const dutyBlocksToInsert: (typeof dutyBlocks.$inferInsert)[] =
                                                [];
                                        insertedAssignments.forEach((asgn, i) => {
                                                const templateAssignmentId =
                                                        newAssignmentTemplateIds[i];
                                                const relatedDutyBlocks = allTemplateDutyBlocks.filter(
                                                        (d) =>
                                                                d.templateAssignmentId === templateAssignmentId,
                                                );
                                                for (const tdb of relatedDutyBlocks) {
                                                        dutyBlocksToInsert.push({
                                                                tenantId,
                                                                branchId,
                                                                date: asgn.shiftDate,
                                                                employeeId: asgn.employeeId!,
                                                                assignmentId: asgn.id,
                                                                dutyTypeId: tdb.dutyTypeId,
                                                                dutyName: tdb.dutyName,
                                                                startTime: tdb.startTime,
                                                                endTime: tdb.endTime,
                                                                notes: tdb.notes,
                                                                createdBy: userId,
                                                        });
                                                }
                                        });
                                        if (dutyBlocksToInsert.length > 0) {
                                                await db.insert(dutyBlocks).values(dutyBlocksToInsert);
                                        }
                                }
                        }
                }

                // Apply time-off from template
                const templateTimeOffEntries = await db
                        .select()
                        .from(scheduleTemplateTimeOff)
                        .where(eq(scheduleTemplateTimeOff.templateId, templateId));

                let timeOffApplied = 0;
                if (templateTimeOffEntries.length > 0) {
                        const targetWeekStart = new Date(weekStartDate + "T00:00:00Z");

                        // Check existing time-off for target week to avoid duplicates
                        const targetWeekEnd = new Date(targetWeekStart);
                        targetWeekEnd.setDate(targetWeekEnd.getDate() + 6);
                        const existingTimeOff = await db
                                .select()
                                .from(employeeTimeOff)
                                .where(
                                        and(
                                                eq(employeeTimeOff.branchId, branchId),
                                                gte(employeeTimeOff.startDate, new Date(weekStartDate)),
                                                sql`${employeeTimeOff.startDate} <= ${targetWeekEnd.toISOString().split("T")[0]}::date`,
                                        ),
                                );

                        const existingTimeOffKeys = new Set(
                                existingTimeOff.map((t) => {
                                        const d = new Date(t.startDate);
                                        return `${d.toISOString().split("T")[0]}|${t.employeeId}`;
                                }),
                        );

                        const newTimeOff: InsertEmployeeTimeOff[] = [];
                        for (const tt of templateTimeOffEntries) {
                                const targetDate = new Date(targetWeekStart);
                                targetDate.setDate(targetDate.getDate() + tt.dayOfWeek);
                                const dateStr = targetDate.toISOString().split("T")[0];

                                const key = `${dateStr}|${tt.employeeId}`;
                                if (existingTimeOffKeys.has(key)) continue;

                                newTimeOff.push({
                                        tenantId,
                                        branchId,
                                        employeeId: tt.employeeId,
                                        startDate: new Date(dateStr),
                                        endDate: new Date(dateStr),
                                        type: tt.type || "CHANGE_DAY_OFF",
                                        createdBy: userId,
                                });
                        }

                        if (newTimeOff.length > 0) {
                                await db.insert(employeeTimeOff).values(newTimeOff);
                                timeOffApplied = newTimeOff.length;
                        }
                }

                return { rowsAdded, rowsSkipped, assignmentsApplied, timeOffApplied };
        }

        async getOpenScheduleShiftsSoon(
                branchId: string,
                hoursAhead: number,
        ): Promise<
                {
                        shiftRowId: string;
                        shiftDate: string;
                        startTime: string;
                        endTime: string;
                        departmentName: string | null;
                }[]
        > {
                const now = new Date();
                const futureDate = new Date(
                        now.getTime() + hoursAhead * 60 * 60 * 1000,
                );
                const todayStr = now.toISOString().split("T")[0];
                const futureDateStr = futureDate.toISOString().split("T")[0];

                // Get all active shift rows for this branch in the date window
                const shiftRows = await db
                        .select({
                                id: scheduleShiftRows.id,
                                startTime: scheduleShiftRows.startTime,
                                endTime: scheduleShiftRows.endTime,
                                departmentId: scheduleShiftRows.departmentId,
                        })
                        .from(scheduleShiftRows)
                        .where(
                                and(
                                        eq(scheduleShiftRows.branchId, branchId),
                                        or(
                                                isNull(scheduleShiftRows.activeFromDate),
                                                sql`${scheduleShiftRows.activeFromDate} <= ${futureDateStr}::date`,
                                        ),
                                        or(
                                                isNull(scheduleShiftRows.activeUntilDate),
                                                sql`${scheduleShiftRows.activeUntilDate} >= ${todayStr}::date`,
                                        ),
                                ),
                        );

                const result: {
                        shiftRowId: string;
                        shiftDate: string;
                        startTime: string;
                        endTime: string;
                        departmentName: string | null;
                }[] = [];

                // Check each day in the window for each shift row
                const currentDate = new Date(todayStr);
                const endDate = new Date(futureDateStr);

                for (const row of shiftRows) {
                        const d = new Date(currentDate);
                        while (d <= endDate) {
                                const shiftDateStr = d.toISOString().split("T")[0];

                                const [hours, minutes] = row.startTime.split(":").map(Number);
                                const shiftStartDatetime = new Date(d);
                                shiftStartDatetime.setHours(hours, minutes, 0, 0);

                                const hoursUntil =
                                        (shiftStartDatetime.getTime() - now.getTime()) /
                                        (1000 * 60 * 60);
                                if (hoursUntil >= 0 && hoursUntil <= hoursAhead) {
                                        const assignments = await db
                                                .select()
                                                .from(scheduleAssignments)
                                                .where(
                                                        and(
                                                                eq(scheduleAssignments.shiftRowId, row.id),
                                                                eq(scheduleAssignments.shiftDate, shiftDateStr),
                                                        ),
                                                );

                                        if (assignments.length === 0) {
                                                const [dept] = await db
                                                        .select()
                                                        .from(departments)
                                                        .where(eq(departments.id, row.departmentId));
                                                result.push({
                                                        shiftRowId: row.id,
                                                        shiftDate: shiftDateStr,
                                                        startTime: row.startTime,
                                                        endTime: row.endTime,
                                                        departmentName: dept?.name || null,
                                                });
                                        }
                                }
                                d.setDate(d.getDate() + 1);
                        }
                }

                return result;
        }

        // ============================================
        // BRANCH EVENTS
        // ============================================

        async getBranchEvents(
                branchId: string,
                startDate: Date,
                endDate: Date,
        ): Promise<BranchEvent[]> {
                // Get events that overlap with the date range
                // An event overlaps if: event.startTime < endDate AND event.endTime > startDate
                return await db
                        .select()
                        .from(branchEvents)
                        .where(
                                and(
                                        eq(branchEvents.branchId, branchId),
                                        lt(branchEvents.startTime, endDate),
                                        gt(branchEvents.endTime, startDate),
                                ),
                        )
                        .orderBy(branchEvents.startTime);
        }

        async getBranchEvent(id: string): Promise<BranchEvent | undefined> {
                const [event] = await db
                        .select()
                        .from(branchEvents)
                        .where(eq(branchEvents.id, id));
                return event || undefined;
        }

        async createBranchEvent(event: InsertBranchEvent): Promise<BranchEvent> {
                const [created] = await db
                        .insert(branchEvents)
                        .values(event)
                        .returning();
                return created;
        }

        async updateBranchEvent(
                id: string,
                event: Partial<InsertBranchEvent>,
        ): Promise<BranchEvent> {
                const [updated] = await db
                        .update(branchEvents)
                        .set({ ...event, updatedAt: new Date() })
                        .where(eq(branchEvents.id, id))
                        .returning();
                return updated;
        }

        async deleteBranchEvent(id: string): Promise<void> {
                await db.delete(branchEvents).where(eq(branchEvents.id, id));
        }

        async getStudioEvents(options: {
                tenantId: string;
                branchId?: string;
                range?: "upcoming" | "today" | "past" | "all";
                includeArchived?: boolean;
        }): Promise<Event[]> {
                const { tenantId, branchId, range, includeArchived = false } = options;
                const today = new Intl.DateTimeFormat("sv-SE", {
                        timeZone: "Asia/Bangkok",
                }).format(new Date());

                const conditions = [eq(coreEvents.tenantId, tenantId)];

                if (branchId) {
                        conditions.push(eq(coreEvents.branchId, branchId));
                }

                if (!includeArchived) {
                        conditions.push(eq(coreEvents.isArchived, false));
                }

                if (range === "today") {
                        conditions.push(eq(coreEvents.eventDate, today));
                } else if (range === "upcoming") {
                        conditions.push(gte(coreEvents.eventDate, today));
                } else if (range === "past") {
                        conditions.push(lt(coreEvents.eventDate, today));
                }
                // range === "all" or undefined: no date filter

                return db
                        .select()
                        .from(coreEvents)
                        .where(and(...conditions))
                        .orderBy(coreEvents.eventDate, coreEvents.startTime);
        }

        async getStudioEvent(id: string): Promise<Event | undefined> {
                const [event] = await db
                        .select()
                        .from(coreEvents)
                        .where(eq(coreEvents.id, id));
                return event;
        }

        async createStudioEvent(event: InsertEvent): Promise<Event> {
                const [created] = await db.insert(coreEvents).values(event).returning();
                return created;
        }

        async updateStudioEvent(
                id: string,
                event: Partial<InsertEvent>,
        ): Promise<Event> {
                const [updated] = await db
                        .update(coreEvents)
                        .set({ ...event, updatedAt: new Date() })
                        .where(eq(coreEvents.id, id))
                        .returning();
                return updated;
        }

        async deleteStudioEvent(id: string): Promise<void> {
                await db.delete(coreEvents).where(eq(coreEvents.id, id));
        }

        // Event Tasks
        async getTasksByEventId(eventId: string): Promise<any[]> {
                return db
                        .select()
                        .from(tasks)
                        .where(eq(tasks.eventId, eventId))
                        .orderBy(tasks.dueAt);
        }

        async createEventTask(task: {
                tenantId: string;
                branchId: string;
                eventId: string;
                title: string;
                description?: string | null;
                dueAt: Date;
                departmentId?: string | null;
                requiresPhotoEvidence?: boolean;
                requiresResponses?: boolean;
                createdBy?: string;
        }): Promise<any> {
                const [created] = await db
                        .insert(tasks)
                        .values({
                                tenantId: task.tenantId,
                                branchId: task.branchId,
                                eventId: task.eventId,
                                title: task.title,
                                description: task.description,
                                dueAt: task.dueAt,
                                departmentId: task.departmentId,
                                requiresPhotoEvidence: task.requiresPhotoEvidence ?? false,
                                requiresResponses: task.requiresResponses ?? false,
                                createdBy: task.createdBy,
                                recurrence: "once",
                                status: "pending",
                        })
                        .returning();
                return created;
        }

        // Studio Event Details (for one-off events)
        async getStudioEventDetails(
                eventId: string,
        ): Promise<StudioEventDetails | undefined> {
                const [details] = await db
                        .select()
                        .from(studioEventDetails)
                        .where(eq(studioEventDetails.eventId, eventId));
                return details;
        }

        async createStudioEventDetails(
                details: InsertStudioEventDetails,
        ): Promise<StudioEventDetails> {
                const [created] = await db
                        .insert(studioEventDetails)
                        .values(details)
                        .returning();
                return created;
        }

        async updateStudioEventDetails(
                eventId: string,
                details: Partial<InsertStudioEventDetails>,
        ): Promise<StudioEventDetails> {
                const [updated] = await db
                        .update(studioEventDetails)
                        .set({ ...details, updatedAt: new Date() })
                        .where(eq(studioEventDetails.eventId, eventId))
                        .returning();
                return updated;
        }

        // Studio Event Tasks (simple task list for one-off events)
        async getStudioEventTasks(
                eventId: string,
        ): Promise<(StudioEventTask & { completedByName?: string | null })[]> {
                const results = await db
                        .select({
                                task: studioEventTasks,
                                completedByFullName: users.fullName,
                                completedByNickname: employees.nickname,
                        })
                        .from(studioEventTasks)
                        .leftJoin(users, eq(studioEventTasks.completedByUserId, users.id))
                        .leftJoin(employees, eq(employees.userId, users.id))
                        .where(eq(studioEventTasks.eventId, eventId))
                        .orderBy(studioEventTasks.displayOrder);

                return results.map((r) => ({
                        ...r.task,
                        completedByName: r.completedByNickname || r.completedByFullName,
                }));
        }

        async createStudioEventTask(
                task: InsertStudioEventTask,
        ): Promise<StudioEventTask> {
                const [created] = await db
                        .insert(studioEventTasks)
                        .values(task)
                        .returning();
                return created;
        }

        async updateStudioEventTask(
                id: string,
                task: Partial<InsertStudioEventTask>,
        ): Promise<StudioEventTask> {
                const [updated] = await db
                        .update(studioEventTasks)
                        .set({ ...task, updatedAt: new Date() })
                        .where(eq(studioEventTasks.id, id))
                        .returning();
                return updated;
        }

        async deleteStudioEventTask(id: string): Promise<void> {
                await db.delete(studioEventTasks).where(eq(studioEventTasks.id, id));
        }

        // Studio Event Info Blocks
        async getStudioEventInfoBlocks(
                eventId: string,
        ): Promise<StudioEventInfoBlock[]> {
                return db
                        .select()
                        .from(studioEventInfoBlocks)
                        .where(eq(studioEventInfoBlocks.eventId, eventId))
                        .orderBy(studioEventInfoBlocks.displayOrder);
        }

        async createStudioEventInfoBlock(
                block: InsertStudioEventInfoBlock,
        ): Promise<StudioEventInfoBlock> {
                const [created] = await db
                        .insert(studioEventInfoBlocks)
                        .values(block)
                        .returning();
                return created;
        }

        async updateStudioEventInfoBlock(
                id: string,
                block: Partial<InsertStudioEventInfoBlock>,
        ): Promise<StudioEventInfoBlock> {
                const [updated] = await db
                        .update(studioEventInfoBlocks)
                        .set({ ...block, updatedAt: new Date() })
                        .where(eq(studioEventInfoBlocks.id, id))
                        .returning();
                return updated;
        }

        async deleteStudioEventInfoBlock(id: string): Promise<void> {
                await db
                        .delete(studioEventInfoBlocks)
                        .where(eq(studioEventInfoBlocks.id, id));
        }

        async getStudioEventTasksForDate(
                date: string,
                branchId?: string,
        ): Promise<StudioEventTaskForToday[]> {
                // Get incomplete studio event tasks for events happening on the specified date
                const conditions = [
                        eq(coreEvents.eventDate, date),
                        eq(coreEvents.eventType, "studio_event"),
                        eq(studioEventTasks.completed, false),
                ];
                if (branchId) {
                        conditions.push(eq(coreEvents.branchId, branchId));
                }

                const results = await db
                        .select({
                                id: studioEventTasks.id,
                                eventId: studioEventTasks.eventId,
                                title: studioEventTasks.title,
                                description: studioEventTasks.description,
                                dueTime: studioEventTasks.dueTime,
                                departmentId: studioEventTasks.departmentId,
                                requiresPhotoEvidence: studioEventTasks.requiresPhotoEvidence,
                                requiresQuestionsAnswered:
                                        studioEventTasks.requiresQuestionsAnswered,
                                completed: studioEventTasks.completed,
                                displayOrder: studioEventTasks.displayOrder,
                                eventTitle: coreEvents.title,
                                eventStartTime: coreEvents.startTime,
                        })
                        .from(studioEventTasks)
                        .innerJoin(coreEvents, eq(studioEventTasks.eventId, coreEvents.id))
                        .where(and(...conditions))
                        .orderBy(studioEventTasks.dueTime, studioEventTasks.displayOrder);

                return results;
        }

        // Studio Event Bookings
        async getStudioEventBookings(
                eventId: string,
        ): Promise<StudioEventBooking[]> {
                return db
                        .select()
                        .from(studioEventBookings)
                        .where(eq(studioEventBookings.eventId, eventId))
                        .orderBy(studioEventBookings.displayOrder);
        }

        async getStudioEventBooking(
                id: string,
        ): Promise<StudioEventBooking | undefined> {
                const [booking] = await db
                        .select()
                        .from(studioEventBookings)
                        .where(eq(studioEventBookings.id, id));
                return booking;
        }

        async createStudioEventBooking(
                booking: InsertStudioEventBooking,
        ): Promise<StudioEventBooking> {
                const [created] = await db
                        .insert(studioEventBookings)
                        .values(booking)
                        .returning();
                return created;
        }

        async updateStudioEventBooking(
                id: string,
                booking: Partial<InsertStudioEventBooking>,
        ): Promise<StudioEventBooking> {
                const [updated] = await db
                        .update(studioEventBookings)
                        .set({ ...booking, updatedAt: new Date() })
                        .where(eq(studioEventBookings.id, id))
                        .returning();
                return updated;
        }

        async deleteStudioEventBooking(id: string): Promise<void> {
                await db
                        .delete(studioEventBookings)
                        .where(eq(studioEventBookings.id, id));
        }

        // Studio Event Form Schema
        async getStudioEventFormSchema(
                eventId: string,
        ): Promise<StudioEventFormSchema | undefined> {
                const [schema] = await db
                        .select()
                        .from(studioEventFormSchema)
                        .where(eq(studioEventFormSchema.eventId, eventId));
                return schema;
        }

        async createStudioEventFormSchema(
                schema: InsertStudioEventFormSchema,
        ): Promise<StudioEventFormSchema> {
                const [created] = await db
                        .insert(studioEventFormSchema)
                        .values(schema)
                        .returning();
                return created;
        }

        async updateStudioEventFormSchema(
                eventId: string,
                schema: Partial<InsertStudioEventFormSchema>,
        ): Promise<StudioEventFormSchema> {
                const [updated] = await db
                        .update(studioEventFormSchema)
                        .set({ ...schema, updatedAt: new Date() })
                        .where(eq(studioEventFormSchema.eventId, eventId))
                        .returning();
                return updated;
        }

        // SOP Articles (franchise-ready scoping)
        async getSopArticles(
                tenantId: string,
                activeBranchId?: string | null,
                filters?: { status?: string },
        ): Promise<SopArticle[]> {
                const conditions = [eq(sopArticles.tenantId, tenantId)];

                // Filter by status if provided (for ASK OTO security - only show published SOPs)
                if (filters?.status) {
                        conditions.push(eq(sopArticles.status, filters.status as any));
                }

                const articles = await db
                        .select()
                        .from(sopArticles)
                        .where(and(...conditions))
                        .orderBy(sopArticles.title);

                // Filter by scope: include GLOBAL or if activeBranchId is in branchIds
                if (activeBranchId) {
                        return articles.filter(
                                (article) =>
                                        article.scope === "GLOBAL" ||
                                        (article.branchIds &&
                                                article.branchIds.includes(activeBranchId)),
                        );
                }
                // If no activeBranchId (admin viewing all), return all articles
                return articles;
        }

        async getSopArticle(id: string): Promise<SopArticle | undefined> {
                const [article] = await db
                        .select()
                        .from(sopArticles)
                        .where(eq(sopArticles.id, id));
                return article;
        }

        async createSopArticle(article: InsertSopArticle): Promise<SopArticle> {
                const [created] = await db
                        .insert(sopArticles)
                        .values(article)
                        .returning();
                return created;
        }

        async updateSopArticle(
                id: string,
                article: Partial<InsertSopArticle>,
        ): Promise<SopArticle> {
                const [updated] = await db
                        .update(sopArticles)
                        .set({ ...article, lastUpdated: new Date() })
                        .where(eq(sopArticles.id, id))
                        .returning();
                return updated;
        }

        async deleteSopArticle(id: string): Promise<void> {
                await db.delete(sopArticles).where(eq(sopArticles.id, id));
        }

        // Knowledge Base Articles
        async getKbArticles(
                tenantId: string,
                filters?: {
                        status?: string;
                        type?: string;
                        branchId?: string;
                        search?: string;
                        allowedBranchIds?: string[];
                },
        ): Promise<KbArticle[]> {
                const conditions = [eq(kbArticles.tenantId, tenantId)];

                if (filters?.status) {
                        conditions.push(eq(kbArticles.status, filters.status as any));
                }
                if (filters?.type) {
                        conditions.push(eq(kbArticles.type, filters.type as any));
                }
                if (filters?.search) {
                        conditions.push(ilike(kbArticles.title, `%${filters.search}%`));
                }

                const articles = await db
                        .select()
                        .from(kbArticles)
                        .where(and(...conditions))
                        .orderBy(desc(kbArticles.updatedAt));

                // Apply branch scoping filters
                let filteredArticles = articles;

                // If specific branchId is requested, filter by that branch
                if (filters?.branchId) {
                        filteredArticles = filteredArticles.filter(
                                (article) =>
                                        article.branchScope === "ALL" ||
                                        (article.branchIds &&
                                                article.branchIds.includes(filters.branchId!)),
                        );
                }

                // If allowedBranchIds is provided (non-admin user), enforce branch scoping
                if (filters?.allowedBranchIds) {
                        filteredArticles = filteredArticles.filter((article) => {
                                // ALL-scoped articles are visible to all users
                                if (article.branchScope === "ALL") return true;

                                // BRANCHES-scoped articles require intersection with user's branches
                                if (article.branchScope === "SELECTED") {
                                        if (!article.branchIds || article.branchIds.length === 0)
                                                return false;
                                        return article.branchIds.some((bid) =>
                                                filters.allowedBranchIds!.includes(bid),
                                        );
                                }

                                return false;
                        });
                }

                return filteredArticles;
        }

        async getKbArticle(id: string): Promise<KbArticle | undefined> {
                const [article] = await db
                        .select()
                        .from(kbArticles)
                        .where(eq(kbArticles.id, id));
                return article;
        }

        async createKbArticle(article: InsertKbArticle): Promise<KbArticle> {
                const [created] = await db
                        .insert(kbArticles)
                        .values({
                                ...article,
                                createdAt: new Date(),
                                updatedAt: new Date(),
                        })
                        .returning();
                return created;
        }

        async updateKbArticle(
                id: string,
                article: Partial<InsertKbArticle>,
        ): Promise<KbArticle> {
                const [updated] = await db
                        .update(kbArticles)
                        .set({ ...article, updatedAt: new Date() })
                        .where(eq(kbArticles.id, id))
                        .returning();
                return updated;
        }

        async deleteKbArticle(id: string): Promise<void> {
                await db.delete(kbArticles).where(eq(kbArticles.id, id));
        }

        async publishKbArticle(
                id: string,
                userId: string,
                userName: string,
                changeNotes?: string,
        ): Promise<KbArticle> {
                const article = await this.getKbArticle(id);
                if (!article) throw new Error("Article not found");

                const newVersion = article.version + 1;
                const now = new Date();

                // Create version snapshot
                await db.insert(kbArticleVersions).values({
                        articleId: id,
                        tenantId: article.tenantId,
                        version: newVersion,
                        title: article.title,
                        type: article.type,
                        content: article.content,
                        quickAnswer: article.quickAnswer,
                        departments: article.departments,
                        roles: article.roles,
                        tags: article.tags,
                        branchScope: article.branchScope,
                        branchIds: article.branchIds,
                        publishedBy: userId,
                        publishedByName: userName,
                        changeNotes: changeNotes || null,
                });

                // Update article status to published
                const [updated] = await db
                        .update(kbArticles)
                        .set({
                                status: "published",
                                version: newVersion,
                                publishedAt: now,
                                updatedAt: now,
                                embeddingStatus: "pending",
                        })
                        .where(eq(kbArticles.id, id))
                        .returning();

                return updated;
        }

        async archiveKbArticle(id: string): Promise<KbArticle> {
                const [updated] = await db
                        .update(kbArticles)
                        .set({
                                status: "archived",
                                archivedAt: new Date(),
                                updatedAt: new Date(),
                        })
                        .where(eq(kbArticles.id, id))
                        .returning();
                return updated;
        }

        async getKbArticleVersions(articleId: string): Promise<KbArticleVersion[]> {
                return db
                        .select()
                        .from(kbArticleVersions)
                        .where(eq(kbArticleVersions.articleId, articleId))
                        .orderBy(desc(kbArticleVersions.version));
        }

        // Knowledge Files (PDFs, images for RAG)
        async getKnowledgeFiles(
                tenantId: string,
                filters?: {
                        branchId?: string;
                        fileType?: string;
                        indexStatus?: string;
                        isActive?: boolean;
                },
        ): Promise<KnowledgeFile[]> {
                const conditions = [eq(knowledgeFiles.tenantId, tenantId)];

                if (filters?.branchId) {
                        conditions.push(eq(knowledgeFiles.branchId, filters.branchId));
                }
                if (filters?.fileType) {
                        conditions.push(
                                eq(knowledgeFiles.fileType, filters.fileType as any),
                        );
                }
                if (filters?.indexStatus) {
                        conditions.push(
                                eq(knowledgeFiles.indexStatus, filters.indexStatus as any),
                        );
                }
                if (filters?.isActive !== undefined) {
                        conditions.push(eq(knowledgeFiles.isActive, filters.isActive));
                }

                return db
                        .select()
                        .from(knowledgeFiles)
                        .where(and(...conditions))
                        .orderBy(desc(knowledgeFiles.createdAt));
        }

        async getKnowledgeFile(id: string): Promise<KnowledgeFile | undefined> {
                const [file] = await db
                        .select()
                        .from(knowledgeFiles)
                        .where(eq(knowledgeFiles.id, id));
                return file;
        }

        async createKnowledgeFile(
                file: InsertKnowledgeFile,
        ): Promise<KnowledgeFile> {
                const [created] = await db
                        .insert(knowledgeFiles)
                        .values(file)
                        .returning();
                return created;
        }

        async updateKnowledgeFile(
                id: string,
                file: Partial<InsertKnowledgeFile>,
        ): Promise<KnowledgeFile> {
                const [updated] = await db
                        .update(knowledgeFiles)
                        .set({ ...file, updatedAt: new Date() })
                        .where(eq(knowledgeFiles.id, id))
                        .returning();
                return updated;
        }

        async deleteKnowledgeFile(id: string): Promise<void> {
                await db.delete(knowledgeFiles).where(eq(knowledgeFiles.id, id));
        }

        // Knowledge Chunks (text chunks from PDFs for RAG)
        async getKnowledgeChunks(fileId: string): Promise<KnowledgeChunk[]> {
                return db
                        .select()
                        .from(knowledgeChunks)
                        .where(eq(knowledgeChunks.fileId, fileId))
                        .orderBy(knowledgeChunks.chunkIndex);
        }

        async getKnowledgeChunksByTenant(
                tenantId: string,
        ): Promise<KnowledgeChunk[]> {
                return db
                        .select()
                        .from(knowledgeChunks)
                        .where(eq(knowledgeChunks.tenantId, tenantId));
        }

        async createKnowledgeChunk(
                chunk: InsertKnowledgeChunk,
        ): Promise<KnowledgeChunk> {
                const [created] = await db
                        .insert(knowledgeChunks)
                        .values(chunk)
                        .returning();
                return created;
        }

        async deleteKnowledgeChunksForFile(fileId: string): Promise<void> {
                await db
                        .delete(knowledgeChunks)
                        .where(eq(knowledgeChunks.fileId, fileId));
        }

        // Ask OTO Threads and Messages
        async getAskOtoThreads(
                userId: string,
                tenantId: string,
        ): Promise<AskOtoThread[]> {
                return db
                        .select()
                        .from(askOtoThreads)
                        .where(
                                and(
                                        eq(askOtoThreads.userId, userId),
                                        eq(askOtoThreads.tenantId, tenantId),
                                ),
                        )
                        .orderBy(desc(askOtoThreads.updatedAt));
        }

        async getAskOtoThread(id: string): Promise<AskOtoThread | undefined> {
                const [thread] = await db
                        .select()
                        .from(askOtoThreads)
                        .where(eq(askOtoThreads.id, id));
                return thread;
        }

        async createAskOtoThread(
                thread: InsertAskOtoThread,
        ): Promise<AskOtoThread> {
                const [created] = await db
                        .insert(askOtoThreads)
                        .values(thread)
                        .returning();
                return created;
        }

        async updateAskOtoThread(
                id: string,
                thread: Partial<InsertAskOtoThread>,
        ): Promise<AskOtoThread> {
                const [updated] = await db
                        .update(askOtoThreads)
                        .set({ ...thread, updatedAt: new Date() })
                        .where(eq(askOtoThreads.id, id))
                        .returning();
                return updated;
        }

        async getAskOtoMessages(threadId: string): Promise<AskOtoMessage[]> {
                return db
                        .select()
                        .from(askOtoMessages)
                        .where(eq(askOtoMessages.threadId, threadId))
                        .orderBy(askOtoMessages.createdAt);
        }

        async createAskOtoMessage(
                message: InsertAskOtoMessage,
        ): Promise<AskOtoMessage> {
                const [created] = await db
                        .insert(askOtoMessages)
                        .values(message)
                        .returning();
                return created;
        }

        // Fix Reports (camera-first quick reporting)
        async getFixReports(
                tenantId: string,
                filters?: {
                        branchId?: string;
                        status?: string;
                        reportedBy?: string;
                        priority?: string;
                        locationId?: string;
                        fromDate?: Date;
                        toDate?: Date;
                        completedFrom?: Date;
                        completedTo?: Date;
                },
        ): Promise<FixReport[]> {
                const conditions = [eq(fixReports.tenantId, tenantId)];

                if (filters?.branchId) {
                        conditions.push(eq(fixReports.branchId, filters.branchId));
                }
                if (filters?.status) {
                        conditions.push(inArray(fixReports.status, resolveFixReportStatusFilter(filters.status) as any));
                }
                if (filters?.reportedBy) {
                        conditions.push(eq(fixReports.reportedBy, filters.reportedBy));
                }
                if (filters?.priority) {
                        conditions.push(eq(fixReports.priority, filters.priority as any));
                }
                if (filters?.locationId) {
                        conditions.push(eq(fixReports.locationId, filters.locationId));
                }
                if (filters?.fromDate) {
                        conditions.push(gte(fixReports.createdAt, filters.fromDate));
                }
                if (filters?.toDate) {
                        conditions.push(lte(fixReports.createdAt, filters.toDate));
                }
                if (filters?.completedFrom) {
                        conditions.push(gte(sql`COALESCE(${fixReports.closedAt}, ${fixReports.updatedAt})`, filters.completedFrom));
                }
                if (filters?.completedTo) {
                        conditions.push(lte(sql`COALESCE(${fixReports.closedAt}, ${fixReports.updatedAt})`, filters.completedTo));
                }

                const isCompletedView = filters?.status === 'completed';
                return db
                        .select()
                        .from(fixReports)
                        .where(and(...conditions))
                        .orderBy(
                                ...(isCompletedView
                                        ? [sql`COALESCE(${fixReports.closedAt}, ${fixReports.updatedAt}) DESC`]
                                        : [
                                                sql`CASE ${fixReports.priority} WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 WHEN 'low' THEN 3 ELSE 4 END`,
                                                desc(fixReports.createdAt),
                                          ]),
                        );
        }

        async getFixReport(id: string): Promise<FixReport | undefined> {
                const [report] = await db
                        .select()
                        .from(fixReports)
                        .where(eq(fixReports.id, id));
                return report;
        }

        async getFixReportWithDetails(
                id: string,
        ): Promise<
                | {
                                report: FixReport;
                                comments: FixComment[];
                                location?: { id: string; name: string };
                  }
                | undefined
        > {
                const [report] = await db
                        .select()
                        .from(fixReports)
                        .where(eq(fixReports.id, id));

                if (!report) return undefined;

                const comments = await db
                        .select()
                        .from(fixComments)
                        .where(eq(fixComments.fixId, id))
                        .orderBy(fixComments.createdAt);

                let location: { id: string; name: string } | undefined;
                if (report.locationId) {
                        const [loc] = await db
                                .select({ id: locations.id, name: locations.name })
                                .from(locations)
                                .where(eq(locations.id, report.locationId));
                        location = loc;
                }

                return { report, comments, location };
        }

        async createFixReport(report: InsertFixReport): Promise<FixReport> {
                const [created] = await db
                        .insert(fixReports)
                        .values(report)
                        .returning();
                return created;
        }

        async updateFixReport(
                id: string,
                report: Partial<InsertFixReport>,
        ): Promise<FixReport> {
                const [updated] = await db
                        .update(fixReports)
                        .set({ ...report, updatedAt: new Date() })
                        .where(eq(fixReports.id, id))
                        .returning();
                return updated;
        }

        // Get fix reports for specific branches (used by supplier portal)
        async getFixReportsForBranches(
                tenantId: string,
                branchIds: string[],
        ): Promise<FixReport[]> {
                if (branchIds.length === 0) return [];
                return db
                        .select()
                        .from(fixReports)
                        .where(
                                and(
                                        eq(fixReports.tenantId, tenantId),
                                        inArray(fixReports.branchId, branchIds),
                                ),
                        )
                        .orderBy(desc(fixReports.createdAt));
        }

        async closeFixReport(
                id: string,
                closedByUserId: string | null,
                closedBySupplierTokenId: string | null,
                doneNote?: string,
        ): Promise<FixReport> {
                const [updated] = await db
                        .update(fixReports)
                        .set({
                                status: "done" as any,
                                closedAt: new Date(),
                                closedByUserId,
                                closedBySupplierTokenId,
                                doneNote,
                                updatedAt: new Date(),
                        })
                        .where(eq(fixReports.id, id))
                        .returning();
                return updated;
        }

        // Fix Comments
        async getFixComments(fixId: string): Promise<FixComment[]> {
                return db
                        .select()
                        .from(fixComments)
                        .where(eq(fixComments.fixId, fixId))
                        .orderBy(fixComments.createdAt);
        }

        async createFixComment(comment: InsertFixComment): Promise<FixComment> {
                const [created] = await db
                        .insert(fixComments)
                        .values(comment)
                        .returning();
                return created;
        }

        // Fix Supplier Tokens (Magic Link)
        async getFixSupplierTokens(tenantId: string): Promise<FixSupplierToken[]> {
                return db
                        .select()
                        .from(fixSupplierTokens)
                        .where(eq(fixSupplierTokens.tenantId, tenantId))
                        .orderBy(desc(fixSupplierTokens.createdAt));
        }

        async getFixSupplierToken(
                id: string,
        ): Promise<FixSupplierToken | undefined> {
                const [token] = await db
                        .select()
                        .from(fixSupplierTokens)
                        .where(eq(fixSupplierTokens.id, id));
                return token;
        }

        async getFixSupplierTokenByHash(
                tokenHash: string,
        ): Promise<FixSupplierToken | undefined> {
                const [token] = await db
                        .select()
                        .from(fixSupplierTokens)
                        .where(eq(fixSupplierTokens.tokenHash, tokenHash));
                return token;
        }

        async createFixSupplierToken(
                token: InsertFixSupplierToken,
        ): Promise<FixSupplierToken> {
                const [created] = await db
                        .insert(fixSupplierTokens)
                        .values(token)
                        .returning();
                return created;
        }

        async updateFixSupplierToken(
                id: string,
                updates: Partial<InsertFixSupplierToken>,
        ): Promise<FixSupplierToken> {
                const [updated] = await db
                        .update(fixSupplierTokens)
                        .set(updates)
                        .where(eq(fixSupplierTokens.id, id))
                        .returning();
                return updated;
        }

        async updateFixSupplierTokenLastUsed(id: string): Promise<void> {
                await db
                        .update(fixSupplierTokens)
                        .set({ lastUsedAt: new Date() })
                        .where(eq(fixSupplierTokens.id, id));
        }

        async deleteFixSupplierToken(id: string): Promise<void> {
                await db.delete(fixSupplierTokens).where(eq(fixSupplierTokens.id, id));
        }

        // Training Modules (franchise-ready scoping)
        async getTrainingModules(
                tenantId: string,
                activeBranchId?: string | null,
        ): Promise<TrainingModule[]> {
                const modules = await db
                        .select()
                        .from(trainingModules)
                        .where(eq(trainingModules.tenantId, tenantId))
                        .orderBy(trainingModules.orderIndex, trainingModules.title);

                // Filter by scope: include GLOBAL or if activeBranchId is in branchIds
                if (activeBranchId) {
                        return modules.filter(
                                (module) =>
                                        module.scope === "GLOBAL" ||
                                        (module.branchIds &&
                                                module.branchIds.includes(activeBranchId)),
                        );
                }
                // If no activeBranchId (admin viewing all), return all modules
                return modules;
        }

        async getTrainingModule(id: string): Promise<TrainingModule | undefined> {
                const [module] = await db
                        .select()
                        .from(trainingModules)
                        .where(eq(trainingModules.id, id));
                return module;
        }

        async createTrainingModule(
                module: InsertTrainingModule,
        ): Promise<TrainingModule> {
                const [created] = await db
                        .insert(trainingModules)
                        .values(module)
                        .returning();
                return created;
        }

        async updateTrainingModule(
                id: string,
                module: Partial<InsertTrainingModule>,
        ): Promise<TrainingModule> {
                const [updated] = await db
                        .update(trainingModules)
                        .set({ ...module, updatedAt: new Date() })
                        .where(eq(trainingModules.id, id))
                        .returning();
                return updated;
        }

        async deleteTrainingModule(id: string): Promise<void> {
                await db.delete(trainingModules).where(eq(trainingModules.id, id));
        }

        // Checklist Templates
        async getChecklistTemplates(
                tenantId: string,
                branchId: string | null,
        ): Promise<any[]> {
                let conditions = [eq(checklistTemplates.tenantId, tenantId)];
                if (branchId) {
                        conditions.push(
                                or(
                                        eq(checklistTemplates.branchId, branchId),
                                        sql`${checklistTemplates.branchId} IS NULL`,
                                        // Also match if branchIds JSON array contains this branch
                                        sql`${checklistTemplates.branchIds}::jsonb @> ${JSON.stringify([branchId])}::jsonb`,
                                )!,
                        );
                }
                const templates = await db
                        .select()
                        .from(checklistTemplates)
                        .where(and(...conditions))
                        .orderBy(desc(checklistTemplates.createdAt));
                return templates;
        }

        async getChecklistTemplateWithItems(
                id: string,
                tenantId?: string,
        ): Promise<any | undefined> {
                let conditions = [eq(checklistTemplates.id, id)];
                if (tenantId) {
                        conditions.push(eq(checklistTemplates.tenantId, tenantId));
                }
                const [template] = await db
                        .select()
                        .from(checklistTemplates)
                        .where(and(...conditions));
                if (!template) return undefined;

                const items = await db
                        .select()
                        .from(checklistTemplateItems)
                        .where(eq(checklistTemplateItems.templateId, id))
                        .orderBy(checklistTemplateItems.sortOrder);

                const normalizedItems = template.requiresPhotoEvidence
                        ? items.map((item) => ({
                                ...item,
                                requiresPhoto: true,
                                cameraEnabled: item.cameraEnabled || item.galleryEnabled ? item.cameraEnabled : true,
                        }))
                        : items;

                return { ...template, items: normalizedItems };
        }

        async createChecklistTemplate(
                template: {
                        tenantId: string;
                        name: string;
                        description?: string | null;
                        branchId?: string | null;
                        departmentId?: string | null;
                        checklistType?: string;
                        recurrence?: string;
                        scheduledTime?: string | null;
                        checkerRounds?: number | null;
                        scheduleTime1?: string | null;
                        scheduleTime2?: string | null;
                        scheduleTime3?: string | null;
                        scheduleTime4?: string | null;
                        scheduleTime5?: string | null;
                        assignedEmployeeId?: string | null;
                        assignedRoleId?: string | null;
                        assignedDepartmentId?: string | null;
                        allowedCheckerRoles?: string[];
                        locationId?: string | null;
                        referenceMediaUrls?: string[];
                        weeklyDays?: string[];
                        monthlyDay?: number | null;
                        createdBy?: string;
                },
                items: {
                        title: string;
                        description?: string;
                        requiresNote?: boolean;
                        requiresPhoto?: boolean;
                        cameraEnabled?: boolean;
                        galleryEnabled?: boolean;
                        isCritical?: boolean;
                        linkedToFix?: boolean;
                        referenceMediaUrls?: string[];
                        departmentId?: string;
                        zoneLabel?: string;
                }[],
        ): Promise<any> {
                const [created] = await db
                        .insert(checklistTemplates)
                        .values({
                                tenantId: template.tenantId,
                                name: template.name,
                                description: template.description,
                                branchId: template.branchId,
                                departmentId: template.departmentId,
                                checklistType: (template.checklistType || "operational") as any,
                                recurrence: template.recurrence as any,
                                scheduledTime: template.scheduledTime,
                                checkerRounds: template.checkerRounds,
                                scheduleTime1: template.scheduleTime1,
                                scheduleTime2: template.scheduleTime2,
                                scheduleTime3: template.scheduleTime3,
                                scheduleTime4: template.scheduleTime4,
                                scheduleTime5: template.scheduleTime5,
                                assignedEmployeeId: template.assignedEmployeeId,
                                assignedRoleId: template.assignedRoleId,
                                assignedDepartmentId: template.assignedDepartmentId,
                                allowedCheckerRoles: template.allowedCheckerRoles || [],
                                locationId: template.locationId,
                                requiresPhotoEvidence: false,
                                referenceMediaUrls: template.referenceMediaUrls || [],
                                weeklyDays: template.weeklyDays || [],
                                monthlyDay: template.monthlyDay,
                                createdBy: template.createdBy,
                        })
                        .returning();

                if (items.length > 0) {
                        await db.insert(checklistTemplateItems).values(
                                items.map((item, index) => ({
                                        tenantId: template.tenantId,
                                        templateId: created.id,
                                        title: item.title,
                                        description: item.description,
                                        requiresNote: item.requiresNote,
                                        requiresPhoto: item.requiresPhoto,
                                         cameraEnabled: item.cameraEnabled ?? true,
                                         galleryEnabled: item.galleryEnabled ?? false,
                                        isCritical: item.isCritical,
                                        linkedToFix: template.checklistType === "checker" ? false : item.linkedToFix === true,
                                        referenceMediaUrls: item.referenceMediaUrls || [],
                                        departmentId: item.departmentId || null,
                                        zoneLabel: item.zoneLabel || null,
                                        sortOrder: index,
                                })),
                        );
                }

                return this.getChecklistTemplateWithItems(created.id);
        }

        // ============================================
        // PAYROLL MODULE IMPLEMENTATIONS
        // ============================================

        // Payroll Periods
        async getPayrollPeriods(operatorId: string): Promise<PayrollPeriod[]> {
                return await db
                        .select()
                        .from(payrollPeriods)
                        .where(eq(payrollPeriods.operatorId, operatorId))
                        .orderBy(desc(payrollPeriods.startDate));
        }

        async getPayrollPeriod(id: string): Promise<PayrollPeriod | undefined> {
                const [period] = await db
                        .select()
                        .from(payrollPeriods)
                        .where(eq(payrollPeriods.id, id));
                return period;
        }

        async getPayrollPeriodWithRuns(
                id: string,
        ): Promise<PayrollPeriodWithRuns | undefined> {
                const period = await this.getPayrollPeriod(id);
                if (!period) return undefined;
                const runs = await this.getPayrollRuns(id);
                const [operator] = await db
                        .select()
                        .from(operators)
                        .where(eq(operators.id, period.operatorId));
                return { ...period, runs, operator };
        }

        async createPayrollPeriod(
                period: InsertPayrollPeriod,
        ): Promise<PayrollPeriod> {
                const [created] = await db
                        .insert(payrollPeriods)
                        .values(period)
                        .returning();
                return created;
        }

        async updatePayrollPeriod(
                id: string,
                period: Partial<InsertPayrollPeriod>,
        ): Promise<PayrollPeriod> {
                const [updated] = await db
                        .update(payrollPeriods)
                        .set({ ...period, updatedAt: new Date() })
                        .where(eq(payrollPeriods.id, id))
                        .returning();
                return updated;
        }

        // Payroll Runs
        async getPayrollRuns(periodId: string): Promise<PayrollRun[]> {
                return await db
                        .select()
                        .from(payrollRuns)
                        .where(eq(payrollRuns.payrollPeriodId, periodId))
                        .orderBy(desc(payrollRuns.runNumber));
        }

        async getPayrollRun(id: string): Promise<PayrollRun | undefined> {
                const [run] = await db
                        .select()
                        .from(payrollRuns)
                        .where(eq(payrollRuns.id, id));
                return run;
        }

        async getPayrollRunWithDetails(
                id: string,
        ): Promise<PayrollRunWithDetails | undefined> {
                const run = await this.getPayrollRun(id);
                if (!run) return undefined;
                const period = await this.getPayrollPeriod(run.payrollPeriodId);
                const summaries = await this.getPayrollEmployeeSummaries(id);
                const exceptions = await this.getPayrollExceptions(id);
                return { ...run, period, summaries, exceptions };
        }

        async createPayrollRun(run: InsertPayrollRun): Promise<PayrollRun> {
                const [created] = await db.insert(payrollRuns).values(run).returning();
                return created;
        }

        async updatePayrollRun(
                id: string,
                run: Partial<InsertPayrollRun>,
        ): Promise<PayrollRun> {
                const [updated] = await db
                        .update(payrollRuns)
                        .set(run)
                        .where(eq(payrollRuns.id, id))
                        .returning();
                return updated;
        }

        // Employee Payroll Profiles
        async getEmployeePayrollProfile(
                employeeId: string,
        ): Promise<EmployeePayrollProfile | undefined> {
                const [profile] = await db
                        .select()
                        .from(employeePayrollProfiles)
                        .where(eq(employeePayrollProfiles.employeeId, employeeId));
                return profile;
        }

        async getEmployeePayrollProfiles(
                operatorId: string,
        ): Promise<EmployeePayrollProfile[]> {
                return await db
                        .select()
                        .from(employeePayrollProfiles)
                        .where(eq(employeePayrollProfiles.operatorId, operatorId));
        }

        async createEmployeePayrollProfile(
                profile: InsertEmployeePayrollProfile,
        ): Promise<EmployeePayrollProfile> {
                const [created] = await db
                        .insert(employeePayrollProfiles)
                        .values(profile)
                        .returning();
                return created;
        }

        async updateEmployeePayrollProfile(
                id: string,
                profile: Partial<InsertEmployeePayrollProfile>,
        ): Promise<EmployeePayrollProfile> {
                const [updated] = await db
                        .update(employeePayrollProfiles)
                        .set({ ...profile, updatedAt: new Date() })
                        .where(eq(employeePayrollProfiles.id, id))
                        .returning();
                return updated;
        }

        // Time Adjustments
        async getTimeAdjustments(
                employeeId: string,
                startDate?: string,
                endDate?: string,
        ): Promise<TimeAdjustment[]> {
                const conditions = [eq(timeAdjustments.employeeId, employeeId)];
                if (startDate)
                        conditions.push(gte(timeAdjustments.workDate, startDate));
                if (endDate) conditions.push(lte(timeAdjustments.workDate, endDate));
                return await db
                        .select()
                        .from(timeAdjustments)
                        .where(and(...conditions))
                        .orderBy(desc(timeAdjustments.workDate));
        }

        async createTimeAdjustment(
                adjustment: InsertTimeAdjustment,
        ): Promise<TimeAdjustment> {
                const [created] = await db
                        .insert(timeAdjustments)
                        .values(adjustment)
                        .returning();
                return created;
        }

        async updateTimeAdjustment(
                id: string,
                adjustment: Partial<InsertTimeAdjustment>,
        ): Promise<TimeAdjustment> {
                const [updated] = await db
                        .update(timeAdjustments)
                        .set(adjustment)
                        .where(eq(timeAdjustments.id, id))
                        .returning();
                return updated;
        }

        // Payroll Day Reconciliations
        async getPayrollDayReconciliations(
                runId: string,
        ): Promise<PayrollDayReconciliation[]> {
                return await db
                        .select()
                        .from(payrollDayReconciliations)
                        .where(eq(payrollDayReconciliations.payrollRunId, runId))
                        .orderBy(payrollDayReconciliations.workDate);
        }

        async createPayrollDayReconciliation(
                reconciliation: InsertPayrollDayReconciliation,
        ): Promise<PayrollDayReconciliation> {
                const [created] = await db
                        .insert(payrollDayReconciliations)
                        .values(reconciliation)
                        .returning();
                return created;
        }

        async deletePayrollDayReconciliationsByRun(runId: string): Promise<void> {
                await db
                        .delete(payrollDayReconciliations)
                        .where(eq(payrollDayReconciliations.payrollRunId, runId));
        }

        // Payroll Exceptions
        async getPayrollExceptions(runId: string): Promise<PayrollException[]> {
                return await db
                        .select()
                        .from(payrollExceptions)
                        .where(eq(payrollExceptions.payrollRunId, runId))
                        .orderBy(payrollExceptions.severity);
        }

        async getPayrollException(
                id: string,
        ): Promise<PayrollExceptionWithDetails | undefined> {
                const [exception] = await db
                        .select()
                        .from(payrollExceptions)
                        .where(eq(payrollExceptions.id, id));
                if (!exception) return undefined;
                const [employee] = await db
                        .select()
                        .from(employees)
                        .where(eq(employees.id, exception.employeeId));
                const branch = exception.branchId
                        ? (
                                        await db
                                                .select()
                                                .from(branches)
                                                .where(eq(branches.id, exception.branchId))
                                )[0]
                        : undefined;
                const approvals = await db
                        .select()
                        .from(payrollExceptionApprovals)
                        .where(eq(payrollExceptionApprovals.payrollExceptionId, id));
                return { ...exception, employee, branch, approvals };
        }

        async createPayrollException(
                exception: InsertPayrollException,
        ): Promise<PayrollException> {
                const [created] = await db
                        .insert(payrollExceptions)
                        .values(exception)
                        .returning();
                return created;
        }

        async updatePayrollException(
                id: string,
                exception: Partial<InsertPayrollException>,
        ): Promise<PayrollException> {
                const [updated] = await db
                        .update(payrollExceptions)
                        .set({ ...exception, updatedAt: new Date() })
                        .where(eq(payrollExceptions.id, id))
                        .returning();
                return updated;
        }

        async deletePayrollExceptionsByRun(runId: string): Promise<void> {
                await db
                        .delete(payrollExceptions)
                        .where(eq(payrollExceptions.payrollRunId, runId));
        }

        // Payroll Exception Approvals
        async createPayrollExceptionApproval(
                approval: InsertPayrollExceptionApproval,
        ): Promise<PayrollExceptionApproval> {
                const [created] = await db
                        .insert(payrollExceptionApprovals)
                        .values(approval)
                        .returning();
                return created;
        }

        // Payroll Line Items
        async getPayrollLineItems(
                runId: string,
                employeeId?: string,
        ): Promise<PayrollLineItem[]> {
                const conditions = [eq(payrollLineItems.payrollRunId, runId)];
                if (employeeId)
                        conditions.push(eq(payrollLineItems.employeeId, employeeId));
                return await db
                        .select()
                        .from(payrollLineItems)
                        .where(and(...conditions))
                        .orderBy(payrollLineItems.lineType, payrollLineItems.code);
        }

        async createPayrollLineItem(
                item: InsertPayrollLineItem,
        ): Promise<PayrollLineItem> {
                const [created] = await db
                        .insert(payrollLineItems)
                        .values(item)
                        .returning();
                return created;
        }

        async deletePayrollLineItemsByRun(runId: string): Promise<void> {
                await db
                        .delete(payrollLineItems)
                        .where(eq(payrollLineItems.payrollRunId, runId));
        }

        // Payroll Employee Summaries
        async getPayrollEmployeeSummaries(
                runId: string,
        ): Promise<PayrollEmployeeSummary[]> {
                return await db
                        .select()
                        .from(payrollEmployeeSummaries)
                        .where(eq(payrollEmployeeSummaries.payrollRunId, runId));
        }

        async getPayrollEmployeeSummary(
                runId: string,
                employeeId: string,
        ): Promise<PayrollEmployeeSummary | undefined> {
                const [summary] = await db
                        .select()
                        .from(payrollEmployeeSummaries)
                        .where(
                                and(
                                        eq(payrollEmployeeSummaries.payrollRunId, runId),
                                        eq(payrollEmployeeSummaries.employeeId, employeeId),
                                ),
                        );
                return summary;
        }

        async getPayrollSummariesByEmployee(
                employeeId: string,
        ): Promise<PayrollEmployeeSummary[]> {
                return await db
                        .select()
                        .from(payrollEmployeeSummaries)
                        .where(eq(payrollEmployeeSummaries.employeeId, employeeId))
                        .orderBy(desc(payrollEmployeeSummaries.createdAt));
        }

        async createPayrollEmployeeSummary(
                summary: InsertPayrollEmployeeSummary,
        ): Promise<PayrollEmployeeSummary> {
                const [created] = await db
                        .insert(payrollEmployeeSummaries)
                        .values(summary)
                        .returning();
                return created;
        }

        async updatePayrollEmployeeSummary(
                id: string,
                summary: Partial<InsertPayrollEmployeeSummary>,
        ): Promise<PayrollEmployeeSummary> {
                const [updated] = await db
                        .update(payrollEmployeeSummaries)
                        .set({ ...summary, updatedAt: new Date() })
                        .where(eq(payrollEmployeeSummaries.id, id))
                        .returning();
                return updated;
        }

        async deletePayrollEmployeeSummariesByRun(runId: string): Promise<void> {
                await db
                        .delete(payrollEmployeeSummaries)
                        .where(eq(payrollEmployeeSummaries.payrollRunId, runId));
        }

        // Payslips
        async getPayslips(employeeId: string): Promise<Payslip[]> {
                return await db
                        .select()
                        .from(payslips)
                        .where(eq(payslips.employeeId, employeeId))
                        .orderBy(desc(payslips.issuedAt));
        }

        async getPayslip(id: string): Promise<Payslip | undefined> {
                const [slip] = await db
                        .select()
                        .from(payslips)
                        .where(eq(payslips.id, id));
                return slip;
        }

        async getPayslipsByRun(runId: string): Promise<Payslip[]> {
                return await db
                        .select()
                        .from(payslips)
                        .where(eq(payslips.payrollRunId, runId));
        }

        async createPayslip(payslip: InsertPayslip): Promise<Payslip> {
                const [created] = await db.insert(payslips).values(payslip).returning();
                return created;
        }

        // Salary Advances
        async getSalaryAdvances(employeeId: string): Promise<SalaryAdvance[]> {
                return await db
                        .select()
                        .from(salaryAdvances)
                        .where(eq(salaryAdvances.employeeId, employeeId))
                        .orderBy(desc(salaryAdvances.issuedDate));
        }

        async getActiveSalaryAdvances(
                employeeId: string,
        ): Promise<SalaryAdvance[]> {
                return await db
                        .select()
                        .from(salaryAdvances)
                        .where(
                                and(
                                        eq(salaryAdvances.employeeId, employeeId),
                                        eq(salaryAdvances.status, "ACTIVE"),
                                ),
                        );
        }

        async getSalaryAdvance(id: string): Promise<SalaryAdvance | undefined> {
                const [advance] = await db
                        .select()
                        .from(salaryAdvances)
                        .where(eq(salaryAdvances.id, id));
                return advance;
        }

        async createSalaryAdvance(
                advance: InsertSalaryAdvance,
        ): Promise<SalaryAdvance> {
                const [created] = await db
                        .insert(salaryAdvances)
                        .values(advance)
                        .returning();
                return created;
        }

        async updateSalaryAdvance(
                id: string,
                advance: Partial<InsertSalaryAdvance>,
        ): Promise<SalaryAdvance> {
                const [updated] = await db
                        .update(salaryAdvances)
                        .set(advance)
                        .where(eq(salaryAdvances.id, id))
                        .returning();
                return updated;
        }

        // Salary Advance Repayments
        async getSalaryAdvanceRepayments(
                advanceId: string,
        ): Promise<SalaryAdvanceRepayment[]> {
                return await db
                        .select()
                        .from(salaryAdvanceRepayments)
                        .where(eq(salaryAdvanceRepayments.salaryAdvanceId, advanceId))
                        .orderBy(salaryAdvanceRepayments.createdAt);
        }

        async createSalaryAdvanceRepayment(
                repayment: InsertSalaryAdvanceRepayment,
        ): Promise<SalaryAdvanceRepayment> {
                const [created] = await db
                        .insert(salaryAdvanceRepayments)
                        .values(repayment)
                        .returning();
                return created;
        }

        // Statutory Rule Sets
        async getStatutoryRuleSets(
                countryCode: string,
                tenantId?: string,
        ): Promise<StatutoryRuleSet[]> {
                const conditions = [eq(statutoryRuleSets.countryCode, countryCode)];
                if (tenantId) {
                        conditions.push(eq(statutoryRuleSets.tenantId, tenantId));
                }
                return await db
                        .select()
                        .from(statutoryRuleSets)
                        .where(and(...conditions))
                        .orderBy(desc(statutoryRuleSets.effectiveFrom));
        }

        async getAllStatutoryRuleSets(
                tenantId: string,
                operatorId?: string,
        ): Promise<StatutoryRuleSet[]> {
                const conditions = [eq(statutoryRuleSets.tenantId, tenantId)];
                if (operatorId) {
                        conditions.push(
                                or(
                                        eq(statutoryRuleSets.operatorId, operatorId),
                                        isNull(statutoryRuleSets.operatorId),
                                )!,
                        );
                }
                return await db
                        .select()
                        .from(statutoryRuleSets)
                        .where(and(...conditions))
                        .orderBy(desc(statutoryRuleSets.effectiveFrom));
        }

        async getActiveStatutoryRuleSet(
                countryCode: string,
                asOfDate: string,
                tenantId?: string,
                operatorId?: string,
                branchId?: string,
        ): Promise<StatutoryRuleSet | undefined> {
                const conditions = [
                        eq(statutoryRuleSets.countryCode, countryCode),
                        eq(statutoryRuleSets.status, "active"),
                        lte(statutoryRuleSets.effectiveFrom, asOfDate),
                        or(
                                isNull(statutoryRuleSets.effectiveTo),
                                gte(statutoryRuleSets.effectiveTo, asOfDate),
                        ),
                ];
                if (tenantId) {
                        conditions.push(eq(statutoryRuleSets.tenantId, tenantId));
                }
                if (branchId) {
                        const [branchRule] = await db
                                .select()
                                .from(statutoryRuleSets)
                                .where(
                                        and(
                                                ...conditions,
                                                eq(statutoryRuleSets.branchId, branchId),
                                        ),
                                )
                                .orderBy(desc(statutoryRuleSets.effectiveFrom))
                                .limit(1);
                        if (branchRule) return branchRule;
                }
                if (operatorId) {
                        const [operatorRule] = await db
                                .select()
                                .from(statutoryRuleSets)
                                .where(
                                        and(
                                                ...conditions,
                                                eq(statutoryRuleSets.operatorId, operatorId),
                                                isNull(statutoryRuleSets.branchId),
                                        ),
                                )
                                .orderBy(desc(statutoryRuleSets.effectiveFrom))
                                .limit(1);
                        if (operatorRule) return operatorRule;
                }
                const [defaultRule] = await db
                        .select()
                        .from(statutoryRuleSets)
                        .where(
                                and(
                                        ...conditions,
                                        isNull(statutoryRuleSets.operatorId),
                                        isNull(statutoryRuleSets.branchId),
                                ),
                        )
                        .orderBy(desc(statutoryRuleSets.effectiveFrom))
                        .limit(1);
                return defaultRule;
        }

        async getStatutoryRuleSetById(
                id: string,
        ): Promise<StatutoryRuleSet | undefined> {
                const [ruleSet] = await db
                        .select()
                        .from(statutoryRuleSets)
                        .where(eq(statutoryRuleSets.id, id));
                return ruleSet;
        }

        async createStatutoryRuleSet(
                ruleSet: InsertStatutoryRuleSet,
        ): Promise<StatutoryRuleSet> {
                const [created] = await db
                        .insert(statutoryRuleSets)
                        .values(ruleSet)
                        .returning();
                return created;
        }

        async updateStatutoryRuleSet(
                id: string,
                updates: Partial<InsertStatutoryRuleSet>,
        ): Promise<StatutoryRuleSet | undefined> {
                const [updated] = await db
                        .update(statutoryRuleSets)
                        .set({ ...updates, updatedAt: new Date() })
                        .where(eq(statutoryRuleSets.id, id))
                        .returning();
                return updated;
        }

        async deleteStatutoryRuleSet(id: string): Promise<void> {
                await db.delete(statutoryRuleSets).where(eq(statutoryRuleSets.id, id));
        }

        // Statutory Calculation Results
        async getStatutoryCalculationResults(
                runId: string,
                employeeId: string,
        ): Promise<StatutoryCalculationResult | undefined> {
                const [result] = await db
                        .select()
                        .from(statutoryCalculationResults)
                        .where(
                                and(
                                        eq(statutoryCalculationResults.payrollRunId, runId),
                                        eq(statutoryCalculationResults.employeeId, employeeId),
                                ),
                        );
                return result;
        }

        async createStatutoryCalculationResult(
                result: InsertStatutoryCalculationResult,
        ): Promise<StatutoryCalculationResult> {
                const [created] = await db
                        .insert(statutoryCalculationResults)
                        .values(result)
                        .returning();
                return created;
        }

        async deleteStatutoryCalculationResultsByRun(runId: string): Promise<void> {
                await db
                        .delete(statutoryCalculationResults)
                        .where(eq(statutoryCalculationResults.payrollRunId, runId));
        }

        // Payroll Policy Settings
        async getPayrollPolicySettings(
                operatorId: string,
        ): Promise<PayrollPolicySettings | undefined> {
                const [settings] = await db
                        .select()
                        .from(payrollPolicySettings)
                        .where(eq(payrollPolicySettings.operatorId, operatorId));
                return settings;
        }

        async createPayrollPolicySettings(
                settings: InsertPayrollPolicySettings,
        ): Promise<PayrollPolicySettings> {
                const [created] = await db
                        .insert(payrollPolicySettings)
                        .values(settings)
                        .returning();
                return created;
        }

        async updatePayrollPolicySettings(
                id: string,
                settings: Partial<InsertPayrollPolicySettings>,
        ): Promise<PayrollPolicySettings> {
                const [updated] = await db
                        .update(payrollPolicySettings)
                        .set({ ...settings, updatedAt: new Date() })
                        .where(eq(payrollPolicySettings.id, id))
                        .returning();
                return updated;
        }

        // Dropoff Form Builder
        async getDropoffForm(
                tenantId: string,
                branchId?: string,
        ): Promise<DropoffForm | undefined> {
                const conditions = [eq(dropoffForms.tenantId, tenantId)];
                if (branchId) {
                        conditions.push(eq(dropoffForms.branchId, branchId));
                } else {
                        conditions.push(sql`${dropoffForms.branchId} IS NULL`);
                }
                const [form] = await db
                        .select()
                        .from(dropoffForms)
                        .where(and(...conditions));
                return form;
        }

        async createDropoffForm(form: InsertDropoffForm): Promise<DropoffForm> {
                const [created] = await db
                        .insert(dropoffForms)
                        .values(form)
                        .returning();
                return created;
        }

        async updateDropoffForm(
                id: string,
                form: Partial<InsertDropoffForm>,
        ): Promise<DropoffForm> {
                const [updated] = await db
                        .update(dropoffForms)
                        .set({ ...form, updatedAt: new Date() })
                        .where(eq(dropoffForms.id, id))
                        .returning();
                return updated;
        }

        async getDropoffFormVersion(
                id: string,
        ): Promise<DropoffFormVersion | undefined> {
                const [version] = await db
                        .select()
                        .from(dropoffFormVersions)
                        .where(eq(dropoffFormVersions.id, id));
                return version;
        }

        async getDropoffFormVersions(
                formId: string,
        ): Promise<DropoffFormVersion[]> {
                return db
                        .select()
                        .from(dropoffFormVersions)
                        .where(eq(dropoffFormVersions.formId, formId))
                        .orderBy(desc(dropoffFormVersions.versionNumber));
        }

        async createDropoffFormVersion(
                version: InsertDropoffFormVersion,
        ): Promise<DropoffFormVersion> {
                const [created] = await db
                        .insert(dropoffFormVersions)
                        .values(version)
                        .returning();
                return created;
        }

        async updateDropoffFormVersion(
                id: string,
                version: Partial<InsertDropoffFormVersion>,
        ): Promise<DropoffFormVersion> {
                const [updated] = await db
                        .update(dropoffFormVersions)
                        .set(version)
                        .where(eq(dropoffFormVersions.id, id))
                        .returning();
                return updated;
        }

        async getLatestDraftVersion(
                formId: string,
        ): Promise<DropoffFormVersion | undefined> {
                const [version] = await db
                        .select()
                        .from(dropoffFormVersions)
                        .where(
                                and(
                                        eq(dropoffFormVersions.formId, formId),
                                        eq(dropoffFormVersions.isDraft, true),
                                ),
                        )
                        .orderBy(desc(dropoffFormVersions.versionNumber))
                        .limit(1);
                return version;
        }

        async getActivePublishedVersion(
                formId: string,
        ): Promise<DropoffFormVersion | undefined> {
                const [form] = await db
                        .select()
                        .from(dropoffForms)
                        .where(eq(dropoffForms.id, formId));
                if (!form?.activePublishedVersionId) return undefined;
                const [version] = await db
                        .select()
                        .from(dropoffFormVersions)
                        .where(eq(dropoffFormVersions.id, form.activePublishedVersionId));
                return version;
        }

        async getI18nTranslations(
                versionId: string,
                lang?: string,
        ): Promise<I18nTranslation[]> {
                const conditions = [eq(i18nTranslations.versionId, versionId)];
                if (lang) {
                        conditions.push(eq(i18nTranslations.lang, lang as any));
                }
                return db
                        .select()
                        .from(i18nTranslations)
                        .where(and(...conditions));
        }

        async upsertI18nTranslation(
                translation: InsertI18nTranslation,
        ): Promise<I18nTranslation> {
                const existing = await db
                        .select()
                        .from(i18nTranslations)
                        .where(
                                and(
                                        eq(i18nTranslations.versionId, translation.versionId),
                                        eq(i18nTranslations.lang, translation.lang),
                                        eq(i18nTranslations.key, translation.key),
                                ),
                        );

                if (existing.length > 0) {
                        const [updated] = await db
                                .update(i18nTranslations)
                                .set({
                                        value: translation.value,
                                        isManualOverride: translation.isManualOverride,
                                        updatedAt: new Date(),
                                })
                                .where(eq(i18nTranslations.id, existing[0].id))
                                .returning();
                        return updated;
                } else {
                        const [created] = await db
                                .insert(i18nTranslations)
                                .values(translation)
                                .returning();
                        return created;
                }
        }

        async bulkUpsertI18nTranslations(
                translations: InsertI18nTranslation[],
        ): Promise<void> {
                for (const translation of translations) {
                        await this.upsertI18nTranslation(translation);
                }
        }

        async createTranslationJob(
                job: InsertTranslationJob,
        ): Promise<TranslationJob> {
                const [created] = await db
                        .insert(translationJobs)
                        .values(job)
                        .returning();
                return created;
        }

        async updateTranslationJob(
                id: string,
                job: Partial<InsertTranslationJob>,
        ): Promise<TranslationJob> {
                const [updated] = await db
                        .update(translationJobs)
                        .set(job)
                        .where(eq(translationJobs.id, id))
                        .returning();
                return updated;
        }

        // ============================================
        // ACCESS ITEMS
        // ============================================

        async getAccessItems(tenantId: string): Promise<AccessItem[]> {
                return db
                        .select()
                        .from(accessItems)
                        .where(eq(accessItems.tenantId, tenantId))
                        .orderBy(desc(accessItems.updatedAt));
        }

        async getAccessItem(id: string): Promise<AccessItem | undefined> {
                const [item] = await db
                        .select()
                        .from(accessItems)
                        .where(eq(accessItems.id, id));
                return item;
        }

        async createAccessItem(item: InsertAccessItem): Promise<AccessItem> {
                const [created] = await db.insert(accessItems).values(item).returning();
                return created;
        }

        async updateAccessItem(
                id: string,
                item: Partial<InsertAccessItem>,
        ): Promise<AccessItem> {
                const [updated] = await db
                        .update(accessItems)
                        .set({ ...item, updatedAt: new Date() })
                        .where(eq(accessItems.id, id))
                        .returning();
                return updated;
        }

        async createAccessViewLog(
                log: InsertAccessViewLog,
        ): Promise<AccessViewLog> {
                const [created] = await db
                        .insert(accessViewLogs)
                        .values(log)
                        .returning();
                return created;
        }

        async getAccessViewLogs(accessItemId: string): Promise<AccessViewLog[]> {
                return db
                        .select()
                        .from(accessViewLogs)
                        .where(eq(accessViewLogs.accessItemId, accessItemId))
                        .orderBy(desc(accessViewLogs.viewedAt));
        }
}

export const storage = new DatabaseStorage();
