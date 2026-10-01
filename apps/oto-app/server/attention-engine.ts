import { storage } from "./storage";
import { ATTENTION_WRITES_READY } from "./attention-availability";
import type { Employee, ContractInstance, AttentionType, SeverityLevel, InsertAttentionItem, EmployeeDocument, EmployeeLetter, EmployeeAsset, EmployeeRole } from "@shared/schema";
import crypto from "crypto";
import { getEmployeeDisplayName } from "./lib/employeeDisplayName";

interface AttentionRuleResult {
  ruleKey: string;
  entityKey: string;
  fingerprint: string;
  item: InsertAttentionItem & { ruleKey: string; entityKey: string; fingerprint: string };
}

interface RuleContext {
  employee: Employee;
  contracts: ContractInstance[];
  documents: EmployeeDocument[];
  letters: EmployeeLetter[];
  assets: EmployeeAsset[];
  roles: EmployeeRole[];
}

interface AttentionRule {
  type: AttentionType;
  ruleKey: string;
  evaluate: (employee: Employee, contracts: ContractInstance[], documents?: EmployeeDocument[], letters?: EmployeeLetter[], assets?: EmployeeAsset[], roles?: EmployeeRole[]) => AttentionRuleResult | null;
}

function daysBetween(date1: Date, date2: Date): number {
  const oneDay = 24 * 60 * 60 * 1000;
  return Math.round((date2.getTime() - date1.getTime()) / oneDay);
}

function generateFingerprint(data: Record<string, unknown>): string {
  return crypto.createHash('md5').update(JSON.stringify(data)).digest('hex');
}

const rules: AttentionRule[] = [
  {
    type: "CONTRACT_NOT_SENT",
    ruleKey: "CONTRACT_NOT_SENT",
    evaluate: (employee, contracts) => {
      if (employee.status !== "active") return null;
      
      const unsent = contracts.find(c => 
        c.status === "finalized" && 
        c.signingStatus === "not_sent" &&
        c.employeeId === employee.id
      );
      
      if (!unsent) return null;
      
      const createdAt = new Date(unsent.createdAt);
      const daysSince = daysBetween(createdAt, new Date());
      
      let severity: SeverityLevel = "low";
      if (daysSince > 7) severity = "high";
      else if (daysSince > 3) severity = "medium";
      
      const ruleKey = "CONTRACT_NOT_SENT";
      const entityKey = `contract:${unsent.id}`;
      const fingerprint = generateFingerprint({ contractId: unsent.id, daysSince, severity });
      
      return {
        ruleKey,
        entityKey,
        fingerprint,
        item: {
          branchId: employee.branchId,
          employeeId: employee.id,
          contractInstanceId: unsent.id,
          type: "CONTRACT_NOT_SENT" as const,
          severity,
          title: `Contract not sent to ${getEmployeeDisplayName(employee)}`,
          description: `A finalized contract has been waiting to be sent for ${daysSince} day(s).`,
          dueDate: null,
          ruleKey,
          entityKey,
          fingerprint,
        },
      };
    },
  },
  {
    type: "CONTRACT_NOT_SIGNED",
    ruleKey: "CONTRACT_NOT_SIGNED",
    evaluate: (employee, contracts) => {
      if (employee.status !== "active") return null;
      
      const unsigned = contracts.find(c => 
        c.signingStatus === "awaiting_signature" &&
        c.employeeId === employee.id
      );
      
      if (!unsigned) return null;
      
      const sentAt = unsigned.sentAt ? new Date(unsigned.sentAt) : new Date(unsigned.createdAt);
      const daysSince = daysBetween(sentAt, new Date());
      
      let severity: SeverityLevel = "low";
      if (daysSince > 14) severity = "high";
      else if (daysSince > 7) severity = "medium";
      
      const ruleKey = "CONTRACT_NOT_SIGNED";
      const entityKey = `contract:${unsigned.id}`;
      const fingerprint = generateFingerprint({ contractId: unsigned.id, daysSince, severity });
      
      return {
        ruleKey,
        entityKey,
        fingerprint,
        item: {
          branchId: employee.branchId,
          employeeId: employee.id,
          contractInstanceId: unsigned.id,
          type: "CONTRACT_NOT_SIGNED" as const,
          severity,
          title: `Contract awaiting signature from ${getEmployeeDisplayName(employee)}`,
          description: `Contract has been awaiting signature for ${daysSince} day(s).`,
          dueDate: unsigned.signingTokenExpiresAt,
          ruleKey,
          entityKey,
          fingerprint,
        },
      };
    },
  },
  {
    type: "CHANGE_NO_CONTRACT",
    ruleKey: "CHANGE_NO_CONTRACT",
    evaluate: (employee, contracts) => {
      if (employee.status !== "active") return null;
      
      const hasSignedContract = contracts.some(c => 
        c.signingStatus === "signed" && c.employeeId === employee.id
      );
      const hasActiveContract = contracts.some(c => 
        (c.status === "draft" || c.status === "finalized" || c.signingStatus === "awaiting_signature") && 
        c.employeeId === employee.id
      );
      
      if (hasSignedContract && !hasActiveContract) {
        if (employee.defaultMergeData?.salaryThb || employee.defaultMergeData?.positionTitle) {
          return null;
        }
      }
      
      if (contracts.length === 0 && employee.status === "active") {
        const createdAt = new Date(employee.createdAt);
        const daysSince = daysBetween(createdAt, new Date());
        
        if (daysSince > 3) {
          let severity: SeverityLevel = "low";
          if (daysSince > 14) severity = "high";
          else if (daysSince > 7) severity = "medium";
          
          const ruleKey = "CHANGE_NO_CONTRACT";
          const entityKey = `employee:${employee.id}`;
          const fingerprint = generateFingerprint({ employeeId: employee.id, daysSince, severity, hasContracts: false });
          
          return {
            ruleKey,
            entityKey,
            fingerprint,
            item: {
              branchId: employee.branchId,
              employeeId: employee.id,
              contractInstanceId: null,
              type: "CHANGE_NO_CONTRACT" as const,
              severity,
              title: `No contract created for ${getEmployeeDisplayName(employee)}`,
              description: `Employee was added ${daysSince} day(s) ago but has no contract.`,
              dueDate: null,
              ruleKey,
              entityKey,
              fingerprint,
            },
          };
        }
      }
      
      return null;
    },
  },
  {
    type: "PROBATION_REVIEW_DUE_SOON",
    ruleKey: "PROBATION_REVIEW_DUE_SOON",
    evaluate: (employee) => {
      if (employee.status !== "active") return null;
      if (employee.probationReviewCompletedAt) return null;
      if (!employee.probationEndDate) return null;
      
      const probationEnd = new Date(employee.probationEndDate);
      const daysUntil = daysBetween(new Date(), probationEnd);
      
      if (daysUntil < 0 || daysUntil > 14) return null;
      
      let severity: SeverityLevel = "medium";
      if (daysUntil <= 3) severity = "high";
      
      const ruleKey = "PROBATION_REVIEW_DUE_SOON";
      const entityKey = `employee:${employee.id}:probation-soon`;
      const fingerprint = generateFingerprint({ employeeId: employee.id, daysUntil, severity });
      
      return {
        ruleKey,
        entityKey,
        fingerprint,
        item: {
          branchId: employee.branchId,
          employeeId: employee.id,
          contractInstanceId: null,
          type: "PROBATION_REVIEW_DUE_SOON" as const,
          severity,
          title: `Probation review due in ${daysUntil} day(s) for ${getEmployeeDisplayName(employee)}`,
          description: `Probation period ends on ${probationEnd.toLocaleDateString()}. Please schedule review.`,
          dueDate: probationEnd,
          ruleKey,
          entityKey,
          fingerprint,
        },
      };
    },
  },
  {
    type: "PROBATION_REVIEW_OVERDUE",
    ruleKey: "PROBATION_REVIEW_OVERDUE",
    evaluate: (employee) => {
      if (employee.status !== "active") return null;
      if (employee.probationReviewCompletedAt) return null;
      if (!employee.probationEndDate) return null;
      
      const probationEnd = new Date(employee.probationEndDate);
      const daysUntil = daysBetween(new Date(), probationEnd);
      
      if (daysUntil >= 0) return null;
      
      const daysOverdue = Math.abs(daysUntil);
      
      const ruleKey = "PROBATION_REVIEW_OVERDUE";
      const entityKey = `employee:${employee.id}:probation-overdue`;
      const fingerprint = generateFingerprint({ employeeId: employee.id, daysOverdue });
      
      return {
        ruleKey,
        entityKey,
        fingerprint,
        item: {
          branchId: employee.branchId,
          employeeId: employee.id,
          contractInstanceId: null,
          type: "PROBATION_REVIEW_OVERDUE" as const,
          severity: "high" as SeverityLevel,
          title: `Probation review overdue for ${getEmployeeDisplayName(employee)}`,
          description: `Probation period ended ${daysOverdue} day(s) ago. Please complete review immediately.`,
          dueDate: probationEnd,
          ruleKey,
          entityKey,
          fingerprint,
        },
      };
    },
  },
  {
    type: "MISSING_OFFBOARD_DOC",
    ruleKey: "MISSING_OFFBOARD_DOC",
    evaluate: (employee, _contracts, documents = [], letters = []) => {
      if (employee.status === "active") return null;
      
      const isResigned = employee.status === "resigned" || employee.endReason?.toLowerCase().includes("resign");
      const isTerminated = employee.status === "terminated" || employee.endReason?.toLowerCase().includes("terminat");
      
      // Check for signed resignation letter OR legacy document paths
      const hasSignedResignationLetter = letters.some(l => l.letterType === "resignation" && l.status === "signed");
      const hasResignationDoc = hasSignedResignationLetter || documents.some(d => d.documentType === "resignation_form") || !!employee.resignationFormPath;
      
      // Check for signed termination letter OR legacy document paths
      const hasSignedTerminationLetter = letters.some(l => l.letterType === "termination" && l.status === "signed");
      const hasTerminationDoc = hasSignedTerminationLetter || documents.some(d => d.documentType === "termination_letter") || !!employee.terminationLetterPath;
      
      if (isResigned && !hasResignationDoc) {
        const ruleKey = "MISSING_OFFBOARD_DOC";
        const entityKey = `employee:${employee.id}:resignation`;
        const fingerprint = generateFingerprint({ employeeId: employee.id, docType: "resignation" });
        
        // Check if there's an unsigned letter pending
        const hasUnsignedLetter = letters.some(l => l.letterType === "resignation" && l.status !== "signed");
        
        return {
          ruleKey,
          entityKey,
          fingerprint,
          item: {
            branchId: employee.branchId,
            employeeId: employee.id,
            contractInstanceId: null,
            type: "MISSING_OFFBOARD_DOC" as const,
            severity: "medium" as SeverityLevel,
            title: `Missing signed resignation letter for ${getEmployeeDisplayName(employee)}`,
            description: hasUnsignedLetter 
              ? `Resignation letter has been sent but awaiting employee signature.`
              : `Employee resigned but resignation letter has not been signed.`,
            dueDate: null,
            ruleKey,
            entityKey,
            fingerprint,
          },
        };
      }
      
      if (isTerminated && !hasTerminationDoc) {
        const ruleKey = "MISSING_OFFBOARD_DOC";
        const entityKey = `employee:${employee.id}:termination`;
        const fingerprint = generateFingerprint({ employeeId: employee.id, docType: "termination" });
        
        // Check if there's an unsigned letter pending
        const hasUnsignedLetter = letters.some(l => l.letterType === "termination" && l.status !== "signed");
        
        return {
          ruleKey,
          entityKey,
          fingerprint,
          item: {
            branchId: employee.branchId,
            employeeId: employee.id,
            contractInstanceId: null,
            type: "MISSING_OFFBOARD_DOC" as const,
            severity: "medium" as SeverityLevel,
            title: `Missing signed termination letter for ${getEmployeeDisplayName(employee)}`,
            description: hasUnsignedLetter 
              ? `Termination letter has been sent but awaiting employee signature.`
              : `Employee was terminated but termination letter has not been signed.`,
            dueDate: null,
            ruleKey,
            entityKey,
            fingerprint,
          },
        };
      }
      
      return null;
    },
  },
  {
    type: "OFFBOARDING_DATES_INCOMPLETE",
    ruleKey: "OFFBOARDING_DATES_INCOMPLETE",
    evaluate: (employee) => {
      if (employee.status === "active") return null;
      
      if (!employee.lastWorkingDay || !employee.endReason) {
        const ruleKey = "OFFBOARDING_DATES_INCOMPLETE";
        const entityKey = `employee:${employee.id}:offboarding`;
        const fingerprint = generateFingerprint({ 
          employeeId: employee.id, 
          missingLastWorkingDay: !employee.lastWorkingDay,
          missingEndReason: !employee.endReason,
        });
        
        return {
          ruleKey,
          entityKey,
          fingerprint,
          item: {
            branchId: employee.branchId,
            employeeId: employee.id,
            contractInstanceId: null,
            type: "OFFBOARDING_DATES_INCOMPLETE" as const,
            severity: "low" as SeverityLevel,
            title: `Incomplete offboarding info for ${getEmployeeDisplayName(employee)}`,
            description: `Missing ${!employee.lastWorkingDay ? 'last working day' : ''}${!employee.lastWorkingDay && !employee.endReason ? ' and ' : ''}${!employee.endReason ? 'end reason' : ''}.`,
            dueDate: null,
            ruleKey,
            entityKey,
            fingerprint,
          },
        };
      }
      
      return null;
    },
  },
  {
    type: "VISA_EXPIRING",
    ruleKey: "VISA_EXPIRING",
    evaluate: (employee) => {
      if (employee.status !== "active") return null;
      if (!employee.isForeignStaff) return null;
      if (!employee.visaExpiryDate) return null;
      
      const expiryDate = new Date(employee.visaExpiryDate);
      const daysUntil = daysBetween(new Date(), expiryDate);
      
      if (daysUntil > 90) return null;
      
      let severity: SeverityLevel = "low";
      if (daysUntil <= 0) severity = "high";
      else if (daysUntil <= 30) severity = "high";
      else if (daysUntil <= 60) severity = "medium";
      
      const status = daysUntil <= 0 ? "expired" : `expiring in ${daysUntil} day(s)`;
      
      const ruleKey = "VISA_EXPIRING";
      const entityKey = `employee:${employee.id}:visa`;
      const fingerprint = generateFingerprint({ employeeId: employee.id, daysUntil, severity });
      
      return {
        ruleKey,
        entityKey,
        fingerprint,
        item: {
          branchId: employee.branchId,
          employeeId: employee.id,
          contractInstanceId: null,
          type: "VISA_EXPIRING" as const,
          severity,
          title: `Visa ${status} for ${getEmployeeDisplayName(employee)}`,
          description: `Visa expires on ${expiryDate.toLocaleDateString()}.`,
          dueDate: expiryDate,
          ruleKey,
          entityKey,
          fingerprint,
        },
      };
    },
  },
  {
    type: "WORK_PERMIT_EXPIRING",
    ruleKey: "WORK_PERMIT_EXPIRING",
    evaluate: (employee) => {
      if (employee.status !== "active") return null;
      if (!employee.isForeignStaff) return null;
      if (!employee.workPermitExpiryDate) return null;
      
      const expiryDate = new Date(employee.workPermitExpiryDate);
      const daysUntil = daysBetween(new Date(), expiryDate);
      
      if (daysUntil > 90) return null;
      
      let severity: SeverityLevel = "low";
      if (daysUntil <= 0) severity = "high";
      else if (daysUntil <= 30) severity = "high";
      else if (daysUntil <= 60) severity = "medium";
      
      const status = daysUntil <= 0 ? "expired" : `expiring in ${daysUntil} day(s)`;
      
      const ruleKey = "WORK_PERMIT_EXPIRING";
      const entityKey = `employee:${employee.id}:workpermit`;
      const fingerprint = generateFingerprint({ employeeId: employee.id, daysUntil, severity });
      
      return {
        ruleKey,
        entityKey,
        fingerprint,
        item: {
          branchId: employee.branchId,
          employeeId: employee.id,
          contractInstanceId: null,
          type: "WORK_PERMIT_EXPIRING" as const,
          severity,
          title: `Work permit ${status} for ${getEmployeeDisplayName(employee)}`,
          description: `Work permit expires on ${expiryDate.toLocaleDateString()}.`,
          dueDate: expiryDate,
          ruleKey,
          entityKey,
          fingerprint,
        },
      };
    },
  },
  {
    type: "MISSING_VISA_WP_POLICY",
    ruleKey: "MISSING_VISA_WP_POLICY",
    evaluate: (employee) => {
      if (employee.status !== "active") return null;
      if (!employee.isForeignStaff) return null;
      
      const missingVisa = !employee.visaExpiryDate;
      const missingWP = !employee.workPermitExpiryDate;
      
      if (!missingVisa && !missingWP) return null;
      
      let severity: SeverityLevel = "medium";
      if (employee.createdAt) {
        const createdAt = new Date(employee.createdAt);
        const daysSince = daysBetween(createdAt, new Date());
        if (!isNaN(daysSince)) {
          if (daysSince > 14) severity = "high";
          else if (daysSince <= 7) severity = "low";
        }
      }
      
      const missing = [];
      if (missingVisa) missing.push("visa expiry date");
      if (missingWP) missing.push("work permit expiry date");
      
      const ruleKey = "MISSING_VISA_WP_POLICY";
      const entityKey = `employee:${employee.id}:visawp`;
      const fingerprint = generateFingerprint({ employeeId: employee.id, missingVisa, missingWP, severity });
      
      return {
        ruleKey,
        entityKey,
        fingerprint,
        item: {
          branchId: employee.branchId,
          employeeId: employee.id,
          contractInstanceId: null,
          type: "MISSING_VISA_WP_POLICY" as const,
          severity,
          title: `Missing visa/WP info for ${getEmployeeDisplayName(employee)}`,
          description: `Foreign employee is missing ${missing.join(" and ")}.`,
          dueDate: null,
          ruleKey,
          entityKey,
          fingerprint,
        },
      };
    },
  },
  {
    type: "COMPANY_PROPERTY_NOT_RETURNED",
    ruleKey: "COMPANY_PROPERTY_NOT_RETURNED",
    evaluate: (employee, _contracts, _documents, _letters, assets = []) => {
      if (employee.employmentState !== 'LEAVING' && employee.employmentState !== 'LEFT') return null;
      
      const unreturnedAssets = assets.filter(a => 
        a.returnRequired && 
        !a.returnedAt &&
        a.employeeId === employee.id
      );
      
      if (unreturnedAssets.length === 0) return null;
      
      const isOverdue = employee.lastWorkingDay && new Date(employee.lastWorkingDay) < new Date();
      
      let severity: SeverityLevel = "low";
      if (employee.employmentState === 'LEFT') severity = "high";
      else if (isOverdue) severity = "high";
      else if (unreturnedAssets.length > 1) severity = "medium";
      
      const assetNames = unreturnedAssets.slice(0, 3).map(a => a.assetNameSnapshot).join(", ");
      const moreCount = unreturnedAssets.length > 3 ? ` +${unreturnedAssets.length - 3} more` : "";
      
      const ruleKey = "COMPANY_PROPERTY_NOT_RETURNED";
      const entityKey = `employee:${employee.id}:assets`;
      const fingerprint = generateFingerprint({ 
        employeeId: employee.id, 
        assetCount: unreturnedAssets.length,
        severity,
        employmentState: employee.employmentState,
      });
      
      return {
        ruleKey,
        entityKey,
        fingerprint,
        item: {
          branchId: employee.branchId,
          employeeId: employee.id,
          contractInstanceId: null,
          type: "COMPANY_PROPERTY_NOT_RETURNED" as const,
          severity,
          title: `Company property not returned by ${getEmployeeDisplayName(employee)}`,
          description: `${unreturnedAssets.length} item(s) pending return: ${assetNames}${moreCount}`,
          dueDate: employee.lastWorkingDay,
          ruleKey,
          entityKey,
          fingerprint,
        },
      };
    },
  },
  {
    type: "FACE_ENROLLMENT_REQUIRED",
    ruleKey: "FACE_ENROLLMENT_REQUIRED",
    evaluate: (employee) => {
      if (employee.status !== "active") return null;
      if (employee.faceEnrollmentStatus === "ENROLLED") return null;
      
      const createdAt = employee.createdAt ? new Date(employee.createdAt) : new Date();
      const daysSince = daysBetween(createdAt, new Date());
      
      let severity: SeverityLevel = "low";
      if (daysSince > 14) severity = "high";
      else if (daysSince > 7) severity = "medium";
      
      const statusText = employee.faceEnrollmentStatus === "SUSPENDED" ? "enrollment suspended" : "not enrolled";
      
      const ruleKey = "FACE_ENROLLMENT_REQUIRED";
      const entityKey = `employee:${employee.id}:face`;
      const fingerprint = generateFingerprint({ employeeId: employee.id, status: employee.faceEnrollmentStatus, daysSince });
      
      return {
        ruleKey,
        entityKey,
        fingerprint,
        item: {
          branchId: employee.branchId,
          employeeId: employee.id,
          contractInstanceId: null,
          type: "FACE_ENROLLMENT_REQUIRED" as const,
          severity,
          title: `Face enrollment required for ${getEmployeeDisplayName(employee)}`,
          description: `Employee has ${statusText} for time clock authentication. Started ${daysSince} day(s) ago.`,
          dueDate: null,
          ruleKey,
          entityKey,
          fingerprint,
        },
      };
    },
  },
  {
    type: "FREQUENT_PIN_USAGE",
    ruleKey: "FREQUENT_PIN_USAGE",
    evaluate: (employee) => {
      if (employee.status !== "active") return null;
      if (!employee.pinUsageCount30Day) return null;
      
      const usageCount = employee.pinUsageCount30Day;
      if (usageCount < 10) return null;
      
      let severity: SeverityLevel = "low";
      if (usageCount > 30) severity = "high";
      else if (usageCount > 20) severity = "medium";
      
      const ruleKey = "FREQUENT_PIN_USAGE";
      const entityKey = `employee:${employee.id}:pin`;
      const fingerprint = generateFingerprint({ employeeId: employee.id, usageCount });
      
      return {
        ruleKey,
        entityKey,
        fingerprint,
        item: {
          branchId: employee.branchId,
          employeeId: employee.id,
          contractInstanceId: null,
          type: "FREQUENT_PIN_USAGE" as const,
          severity,
          title: `Frequent PIN fallback for ${getEmployeeDisplayName(employee)}`,
          description: `Employee has used PIN fallback ${usageCount} times in the last 30 days. Consider re-enrolling face.`,
          dueDate: null,
          ruleKey,
          entityKey,
          fingerprint,
        },
      };
    },
  },
  {
    type: "UNSIGNED_EMPLOYMENT_CONTRACT",
    ruleKey: "UNSIGNED_EMPLOYMENT_CONTRACT",
    evaluate: (employee, contracts) => {
      if (employee.status !== "active") return null;
      
      const hasSignedContract = contracts.some(c => 
        c.signingStatus === "signed" && c.employeeId === employee.id
      );
      
      if (hasSignedContract) return null;
      
      const createdAt = new Date(employee.createdAt);
      const daysSince = daysBetween(createdAt, new Date());
      
      if (daysSince <= 7) return null;
      
      let severity: SeverityLevel = "low";
      if (daysSince > 30) severity = "high";
      else if (daysSince > 14) severity = "medium";
      
      const ruleKey = "UNSIGNED_EMPLOYMENT_CONTRACT";
      const entityKey = `employee:${employee.id}:unsigned`;
      const fingerprint = generateFingerprint({ employeeId: employee.id, daysSince, severity });
      
      return {
        ruleKey,
        entityKey,
        fingerprint,
        item: {
          branchId: employee.branchId,
          employeeId: employee.id,
          contractInstanceId: null,
          type: "UNSIGNED_EMPLOYMENT_CONTRACT" as const,
          severity,
          title: `No signed employment contract for ${getEmployeeDisplayName(employee)}`,
          description: `Employee started ${daysSince} day(s) ago but has no signed employment contract.`,
          dueDate: null,
          ruleKey,
          entityKey,
          fingerprint,
        },
      };
    },
  },
  {
    type: "OFFBOARDING_LETTER_UNSIGNED",
    ruleKey: "OFFBOARDING_LETTER_UNSIGNED",
    evaluate: (employee, _contracts, _documents, letters = []) => {
      if (employee.status === "active") return null;
      
      const unsignedLetter = letters.find(l => 
        (l.letterType === "resignation" || l.letterType === "termination") && 
        l.status !== "signed" &&
        l.status !== "draft"
      );
      
      if (!unsignedLetter) return null;
      
      const sentAt = unsignedLetter.sentAt ? new Date(unsignedLetter.sentAt) : new Date(unsignedLetter.createdAt);
      const daysSince = daysBetween(sentAt, new Date());
      
      let severity: SeverityLevel = "low";
      if (daysSince > 7) severity = "high";
      else if (daysSince > 3) severity = "medium";
      
      const letterTypeLabel = unsignedLetter.letterType === "resignation" ? "Resignation" : "Termination";
      
      const ruleKey = "OFFBOARDING_LETTER_UNSIGNED";
      const entityKey = `employee:${employee.id}:letter:${unsignedLetter.id}`;
      const fingerprint = generateFingerprint({ employeeId: employee.id, letterId: unsignedLetter.id, daysSince });
      
      return {
        ruleKey,
        entityKey,
        fingerprint,
        item: {
          branchId: employee.branchId,
          employeeId: employee.id,
          contractInstanceId: null,
          type: "OFFBOARDING_LETTER_UNSIGNED" as const,
          severity,
          title: `${letterTypeLabel} letter awaiting signature from ${getEmployeeDisplayName(employee)}`,
          description: `Letter has been sent ${daysSince} day(s) ago but remains unsigned.`,
          dueDate: null,
          ruleKey,
          entityKey,
          fingerprint,
        },
      };
    },
  },
  {
    type: "EMPLOYEE_UNSIGNED",
    ruleKey: "EMPLOYEE_UNSIGNED",
    evaluate: (employee, contracts) => {
      if (employee.status !== "active") return null;
      
      const hasAnyContract = contracts.some(c => c.employeeId === employee.id);
      const hasSignedContract = contracts.some(c => 
        c.signingStatus === "signed" && c.employeeId === employee.id
      );
      
      if (!hasAnyContract || hasSignedContract) return null;
      
      const awaitingSignature = contracts.some(c => 
        c.signingStatus === "awaiting_signature" && c.employeeId === employee.id
      );
      
      if (awaitingSignature) return null;
      
      const oldestContract = contracts
        .filter(c => c.employeeId === employee.id)
        .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())[0];
      
      if (!oldestContract) return null;
      
      const createdAt = new Date(oldestContract.createdAt);
      const daysSince = daysBetween(createdAt, new Date());
      
      let severity: SeverityLevel = "low";
      if (daysSince > 14) severity = "high";
      else if (daysSince > 7) severity = "medium";
      
      const ruleKey = "EMPLOYEE_UNSIGNED";
      const entityKey = `employee:${employee.id}:contract-unsigned`;
      const fingerprint = generateFingerprint({ employeeId: employee.id, daysSince, contractId: oldestContract.id });
      
      return {
        ruleKey,
        entityKey,
        fingerprint,
        item: {
          branchId: employee.branchId,
          employeeId: employee.id,
          contractInstanceId: oldestContract.id,
          type: "EMPLOYEE_UNSIGNED" as const,
          severity,
          title: `Contract exists but not signed for ${getEmployeeDisplayName(employee)}`,
          description: `Employee has a draft/finalized contract from ${daysSince} day(s) ago that hasn't been sent or signed.`,
          dueDate: null,
          ruleKey,
          entityKey,
          fingerprint,
        },
      };
    },
  },
  {
    type: "TERMS_CHANGED_REQUIRES_NEW_CONTRACT",
    ruleKey: "TERMS_CHANGED_REQUIRES_NEW_CONTRACT",
    evaluate: (employee, contracts) => {
      if (employee.status !== "active") return null;
      
      const signedContracts = contracts
        .filter(c => c.signingStatus === "signed" && c.employeeId === employee.id)
        .sort((a, b) => new Date(b.signedAt || b.createdAt).getTime() - new Date(a.signedAt || a.createdAt).getTime());
      
      if (signedContracts.length === 0) return null;
      
      const latestSigned = signedContracts[0];
      const mergeData = latestSigned.mergeData as Record<string, unknown> | null;
      if (!mergeData) return null;
      
      const contractSalary = mergeData.salaryThb || mergeData.salary_thb;
      const contractPosition = mergeData.positionTitle || mergeData.position_title;
      const employeeSalary = employee.defaultMergeData?.salaryThb;
      const employeePosition = employee.defaultMergeData?.positionTitle;
      
      const salaryChanged = contractSalary && employeeSalary && String(contractSalary) !== String(employeeSalary);
      const positionChanged = contractPosition && employeePosition && String(contractPosition) !== String(employeePosition);
      
      if (!salaryChanged && !positionChanged) return null;
      
      const changes = [];
      if (salaryChanged) changes.push("salary");
      if (positionChanged) changes.push("position");
      
      const ruleKey = "TERMS_CHANGED_REQUIRES_NEW_CONTRACT";
      const entityKey = `employee:${employee.id}:terms-changed`;
      const fingerprint = generateFingerprint({ 
        employeeId: employee.id, 
        contractSalary, 
        employeeSalary, 
        contractPosition, 
        employeePosition 
      });
      
      return {
        ruleKey,
        entityKey,
        fingerprint,
        item: {
          branchId: employee.branchId,
          employeeId: employee.id,
          contractInstanceId: latestSigned.id,
          type: "TERMS_CHANGED_REQUIRES_NEW_CONTRACT" as const,
          severity: "medium" as SeverityLevel,
          title: `Employment terms changed for ${getEmployeeDisplayName(employee)}`,
          description: `Employee's ${changes.join(" and ")} has been updated. A new contract may be required to reflect the changes.`,
          dueDate: null,
          ruleKey,
          entityKey,
          fingerprint,
        },
      };
    },
  },
  {
    type: "TIMEKEEPING_ANOMALY_REQUIRES_ACTION",
    ruleKey: "TIMEKEEPING_ANOMALY_REQUIRES_ACTION",
    evaluate: (_employee) => {
      // TODO: This rule requires real-time timekeeping anomaly aggregation
      // which should be computed from time_events table. For now, this
      // type is available for manual creation or future implementation
      // when employee.anomalyCount7Day field is added to the schema.
      return null;
    },
  },
  {
    type: "EMPLOYEE_MISSING_DEPARTMENT",
    ruleKey: "EMPLOYEE_MISSING_DEPARTMENT",
    evaluate: (employee) => {
      if (employee.status !== "active") return null;
      if (employee.primaryDepartmentId) return null;
      
      const createdAt = employee.createdAt ? new Date(employee.createdAt) : new Date();
      const daysSince = daysBetween(createdAt, new Date());
      
      let severity: SeverityLevel = "low";
      if (daysSince > 7) severity = "high";
      else if (daysSince > 3) severity = "medium";
      
      const ruleKey = "EMPLOYEE_MISSING_DEPARTMENT";
      const entityKey = `employee:${employee.id}:department`;
      const fingerprint = generateFingerprint({ employeeId: employee.id, daysSince });
      
      return {
        ruleKey,
        entityKey,
        fingerprint,
        item: {
          branchId: employee.branchId,
          employeeId: employee.id,
          contractInstanceId: null,
          type: "EMPLOYEE_MISSING_DEPARTMENT" as const,
          severity,
          title: `No department assigned for ${getEmployeeDisplayName(employee)}`,
          description: `Employee has not been assigned to a department. Please update their profile.`,
          dueDate: null,
          ruleKey,
          entityKey,
          fingerprint,
        },
      };
    },
  },
  {
    type: "EMPLOYEE_MISSING_ROLE",
    ruleKey: "EMPLOYEE_MISSING_ROLE",
    evaluate: (employee, _contracts, _documents, _letters, _assets, roles) => {
      if (employee.status !== "active") return null;
      if (roles && roles.length > 0) return null;
      
      const createdAt = employee.createdAt ? new Date(employee.createdAt) : new Date();
      const daysSince = daysBetween(createdAt, new Date());
      
      let severity: SeverityLevel = "low";
      if (daysSince > 7) severity = "high";
      else if (daysSince > 3) severity = "medium";
      
      const ruleKey = "EMPLOYEE_MISSING_ROLE";
      const entityKey = `employee:${employee.id}:role`;
      const fingerprint = generateFingerprint({ employeeId: employee.id, daysSince });
      
      return {
        ruleKey,
        entityKey,
        fingerprint,
        item: {
          branchId: employee.branchId,
          employeeId: employee.id,
          contractInstanceId: null,
          type: "EMPLOYEE_MISSING_ROLE" as const,
          severity,
          title: `No roles assigned for ${getEmployeeDisplayName(employee)}`,
          description: `Employee has not been assigned any roles. Please update their profile.`,
          dueDate: null,
          ruleKey,
          entityKey,
          fingerprint,
        },
      };
    },
  },
];

let lastCalculatedAt: Date | null = null;

export function getLastCalculatedAt(): Date | null {
  return lastCalculatedAt;
}

export async function evaluateForEmployee(employeeId: string): Promise<{ created: number; updated: number; resolved: number }> {
  if (!ATTENTION_WRITES_READY) return { created: 0, updated: 0, resolved: 0 };
  const employee = await storage.getEmployee(employeeId);
  if (!employee) {
    return { created: 0, updated: 0, resolved: 0 };
  }
  
  const contracts = await storage.getContracts();
  const employeeContracts = contracts.filter(c => c.employeeId === employeeId);
  
  // Fetch documents, letters, assets, and roles for rules
  const documents = await storage.getEmployeeDocuments(employeeId);
  const letters = await storage.getEmployeeLetters(employeeId);
  const assets = await storage.getEmployeeAssets(employeeId);
  const roles = await storage.getEmployeeRoles(employeeId);
  
  let created = 0;
  let updated = 0;
  let resolved = 0;
  
  const triggeredRuleKeys = new Set<string>();
  const triggeredEntityKeys = new Set<string>();
  
  for (const rule of rules) {
    try {
      const result = rule.evaluate(employee, employeeContracts, documents, letters, assets, roles);
      
      if (result) {
        triggeredRuleKeys.add(result.ruleKey);
        triggeredEntityKeys.add(result.entityKey);
        
        const upsertResult = await storage.upsertAttentionItem(result.item);
        if (upsertResult.action === 'created') created++;
        else if (upsertResult.action === 'updated') updated++;
      }
    } catch (error) {
      console.error(`Rule ${rule.ruleKey} failed for employee ${employeeId}:`, error);
    }
  }
  
  const existingItems = await storage.getOpenAttentionItemsForEntity(`employee:${employeeId}`);
  for (const existingItem of existingItems) {
    if (existingItem.ruleKey && !triggeredRuleKeys.has(existingItem.ruleKey)) {
      if (existingItem.entityKey && existingItem.entityKey.startsWith(`employee:${employeeId}`)) {
        const resolvedCount = await storage.autoResolveAttentionItems(existingItem.ruleKey, existingItem.entityKey);
        resolved += resolvedCount;
      }
    }
  }
  
  return { created, updated, resolved };
}

export async function evaluateForContract(contractId: string): Promise<{ created: number; updated: number; resolved: number }> {
  if (!ATTENTION_WRITES_READY) return { created: 0, updated: 0, resolved: 0 };
  const contract = await storage.getContract(contractId);
  if (!contract || !contract.employeeId) {
    return { created: 0, updated: 0, resolved: 0 };
  }
  
  const employee = await storage.getEmployee(contract.employeeId);
  if (!employee) {
    return { created: 0, updated: 0, resolved: 0 };
  }
  
  const contracts = await storage.getContracts();
  const employeeContracts = contracts.filter(c => c.employeeId === employee.id);
  
  let created = 0;
  let updated = 0;
  let resolved = 0;
  
  const contractRules = rules.filter(r => 
    r.ruleKey === "CONTRACT_NOT_SENT" || 
    r.ruleKey === "CONTRACT_NOT_SIGNED" ||
    r.ruleKey === "CHANGE_NO_CONTRACT"
  );
  
  for (const rule of contractRules) {
    try {
      const result = rule.evaluate(employee, employeeContracts);
      
      if (result) {
        const upsertResult = await storage.upsertAttentionItem(result.item);
        if (upsertResult.action === 'created') created++;
        else if (upsertResult.action === 'updated') updated++;
      } else {
        const resolvedCount = await storage.autoResolveAttentionItems(rule.ruleKey, `contract:${contractId}`);
        resolved += resolvedCount;
      }
    } catch (error) {
      console.error(`Rule ${rule.ruleKey} failed for contract ${contractId}:`, error);
    }
  }
  
  return { created, updated, resolved };
}

export async function runFullReconciliation(): Promise<{ created: number; updated: number; resolved: number; errors: number }> {
  if (!ATTENTION_WRITES_READY) throw new Error("Tenant-owned Attention reconciliation is unavailable");
  console.log("[AttentionEngine] Starting full reconciliation...");
  
  const employees = await storage.getEmployees();
  const contracts = await storage.getContracts();
  
  let created = 0;
  let updated = 0;
  let resolved = 0;
  let errors = 0;
  
  const allTriggeredKeys = new Map<string, Set<string>>();
  
  for (const employee of employees) {
    const employeeContracts = contracts.filter(c => c.employeeId === employee.id);
    
    // Fetch documents, letters, assets, and roles for rules
    const documents = await storage.getEmployeeDocuments(employee.id);
    const letters = await storage.getEmployeeLetters(employee.id);
    const assets = await storage.getEmployeeAssets(employee.id);
    const roles = await storage.getEmployeeRoles(employee.id);
    
    for (const rule of rules) {
      try {
        const result = rule.evaluate(employee, employeeContracts, documents, letters, assets, roles);
        
        if (result) {
          if (!allTriggeredKeys.has(result.ruleKey)) {
            allTriggeredKeys.set(result.ruleKey, new Set());
          }
          allTriggeredKeys.get(result.ruleKey)!.add(result.entityKey);
          
          const upsertResult = await storage.upsertAttentionItem(result.item);
          if (upsertResult.action === 'created') created++;
          else if (upsertResult.action === 'updated') updated++;
        }
      } catch (error) {
        console.error(`Rule ${rule.ruleKey} failed for employee ${employee.id}:`, error);
        errors++;
      }
    }
  }
  
  // MISSING_LOGIN_ACCESS rule - check for active employees without login access
  for (const employee of employees) {
    if (employee.status !== "active" && employee.status !== "leaving") continue;
    
    const ruleKey = "MISSING_LOGIN_ACCESS";
    const entityKey = `employee:${employee.id}:missing-login`;
    
    // Check if employee has a person record with access policy
    let hasLogin = false;
    if (employee.personId) {
      try {
        const accessPolicy = await storage.getAccessPolicy(employee.personId);
        hasLogin = !!(accessPolicy && accessPolicy.coreAccountEnabled && accessPolicy.coreUserId);
      } catch {
        // No access policy found
      }
    }
    
    if (!hasLogin) {
      // Determine severity based on start date
      let severity: "low" | "medium" | "high" = "medium";
      if (employee.startDate) {
        const startDate = new Date(employee.startDate);
        const daysUntilStart = daysBetween(new Date(), startDate);
        if (daysUntilStart <= 7 || daysUntilStart < 0) {
          severity = "high";
        }
      }
      
      const fingerprint = generateFingerprint({ employeeId: employee.id, hasPersonId: !!employee.personId, severity });
      
      if (!allTriggeredKeys.has(ruleKey)) {
        allTriggeredKeys.set(ruleKey, new Set());
      }
      allTriggeredKeys.get(ruleKey)!.add(entityKey);
      
      const upsertResult = await storage.upsertAttentionItem({
        branchId: employee.branchId,
        employeeId: employee.id,
        contractInstanceId: null,
        type: "MISSING_LOGIN_ACCESS" as const,
        severity,
        title: `Login not set up for ${getEmployeeDisplayName(employee)}`,
        description: `This employee does not have a Core login yet. Enable access in the Access & Login section.`,
        dueDate: null,
        ruleKey,
        entityKey,
        fingerprint,
      });
      
      if (upsertResult.action === 'created') created++;
      else if (upsertResult.action === 'updated') updated++;
    }
  }
  
  const allOpenItems = await storage.getAttentionItems({ resolved: false, limit: 10000 });
  for (const item of allOpenItems) {
    if (!item.ruleKey || !item.entityKey) continue;
    
    const triggeredEntities = allTriggeredKeys.get(item.ruleKey);
    if (!triggeredEntities || !triggeredEntities.has(item.entityKey)) {
      const resolvedCount = await storage.autoResolveAttentionItems(item.ruleKey, item.entityKey);
      resolved += resolvedCount;
    }
  }
  
  lastCalculatedAt = new Date();
  console.log(`[AttentionEngine] Reconciliation complete: ${created} created, ${updated} updated, ${resolved} resolved, ${errors} errors`);
  
  return { created, updated, resolved, errors };
}

export async function generateAttentionItems(): Promise<number> {
  const result = await runFullReconciliation();
  return result.created;
}

async function getAttentionConfig(): Promise<Record<string, any>> {
  const DEFAULT_CONFIG = {
    openShiftHoursThreshold: 72,
    enabledRules: [
      "CONTRACT_NOT_SENT", "DOCUMENT_EXPIRY_SOON", "MISSING_DOCUMENT",
      "PROBATION_ENDING_SOON", "OPEN_SHIFT_SOON", "SHIFT_NEEDS_COVERAGE",
      "MISSING_LOGIN_ACCESS", "CHECKLIST_AUDIT_FAIL", "CHECKLIST_NOTE_FLAGGED",
    ],
  };
  try {
    const setting = await storage.getSetting("attention_rules_config");
    if (setting) return { ...DEFAULT_CONFIG, ...JSON.parse(setting.value) };
  } catch { /* use defaults */ }
  return DEFAULT_CONFIG;
}

export async function evaluateSchedulingAlerts(): Promise<{ created: number; updated: number; resolved: number }> {
  if (!ATTENTION_WRITES_READY) throw new Error("Tenant-owned Attention scheduling alerts are unavailable");
  let created = 0;
  let updated = 0;
  let resolved = 0;
  
  const config = await getAttentionConfig();
  const enabledRules: string[] = config.enabledRules || [];
  const openShiftHours = config.openShiftHoursThreshold || 72;

  const branches = await storage.getBranches();
  const allTriggeredKeys = new Map<string, Set<string>>();
  
  for (const branch of branches) {
    // Rule 1: OPEN_SHIFT_SOON - Open shifts starting within configured hours
    if (!enabledRules.includes("OPEN_SHIFT_SOON")) continue;
    try {
      const openShiftsSoon = await storage.getOpenShiftsStartingSoon(branch.id, openShiftHours);
      
      for (const shift of openShiftsSoon) {
        const hoursUntil = Math.max(0, (new Date(shift.startAt).getTime() - Date.now()) / (1000 * 60 * 60));
        
        let severity: "low" | "medium" | "high" = "low";
        if (hoursUntil <= 24) severity = "high";
        else if (hoursUntil <= 48) severity = "medium";
        
        const ruleKey = "OPEN_SHIFT_SOON";
        const entityKey = `shift:${shift.id}`;
        const fingerprint = generateFingerprint({ shiftId: shift.id, hoursUntil: Math.round(hoursUntil), severity });
        
        if (!allTriggeredKeys.has(ruleKey)) {
          allTriggeredKeys.set(ruleKey, new Set());
        }
        allTriggeredKeys.get(ruleKey)!.add(entityKey);
        
        const shiftDate = new Date(shift.startAt).toLocaleDateString('en-GB');
        const shiftTime = new Date(shift.startAt).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
        
        const upsertResult = await storage.upsertAttentionItem({
          branchId: branch.id,
          employeeId: null,
          contractInstanceId: null,
          type: "OPEN_SHIFT_SOON" as const,
          severity,
          title: `Open shift starting in ${Math.round(hoursUntil)} hours`,
          description: `Shift on ${shiftDate} at ${shiftTime} has no assigned employee.`,
          dueDate: shift.startAt,
          ruleKey,
          entityKey,
          fingerprint,
        });
        
        if (upsertResult.action === 'created') created++;
        else if (upsertResult.action === 'updated') updated++;
      }
    } catch (error) {
      console.error(`OPEN_SHIFT_SOON rule failed for branch ${branch.id}:`, error);
    }
    
    // Rule 2: SHIFT_NEEDS_COVERAGE - Shifts marked as needing coverage
    try {
      const shiftsNeedingCoverage = await storage.getShiftsNeedingCoverage(branch.id);
      
      for (const shift of shiftsNeedingCoverage) {
        const hoursUntil = Math.max(0, (new Date(shift.startAt).getTime() - Date.now()) / (1000 * 60 * 60));
        
        let severity: "low" | "medium" | "high" = "medium";
        if (hoursUntil <= 24) severity = "high";
        
        const ruleKey = "SHIFT_NEEDS_COVERAGE";
        const entityKey = `shift:${shift.id}`;
        const fingerprint = generateFingerprint({ shiftId: shift.id, hoursUntil: Math.round(hoursUntil), severity });
        
        if (!allTriggeredKeys.has(ruleKey)) {
          allTriggeredKeys.set(ruleKey, new Set());
        }
        allTriggeredKeys.get(ruleKey)!.add(entityKey);
        
        const shiftDate = new Date(shift.startAt).toLocaleDateString('en-GB');
        const shiftTime = new Date(shift.startAt).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
        
        const upsertResult = await storage.upsertAttentionItem({
          branchId: branch.id,
          employeeId: null,
          contractInstanceId: null,
          type: "SHIFT_NEEDS_COVERAGE" as const,
          severity,
          title: `Shift needs coverage`,
          description: `Shift on ${shiftDate} at ${shiftTime} needs coverage (possibly due to sick leave).`,
          dueDate: shift.startAt,
          ruleKey,
          entityKey,
          fingerprint,
        });
        
        if (upsertResult.action === 'created') created++;
        else if (upsertResult.action === 'updated') updated++;
      }
    } catch (error) {
      console.error(`SHIFT_NEEDS_COVERAGE rule failed for branch ${branch.id}:`, error);
    }

    // Rule 3: OPEN_SHIFT_SOON for new Planday-style scheduling (schedule_shift_rows)
    try {
      const openScheduleShifts = await storage.getOpenScheduleShiftsSoon(branch.id, 72);
      
      for (const openShift of openScheduleShifts) {
        const [hours, minutes] = openShift.startTime.split(':').map(Number);
        const shiftStartDatetime = new Date(openShift.shiftDate);
        shiftStartDatetime.setHours(hours, minutes, 0, 0);
        
        const hoursUntil = Math.max(0, (shiftStartDatetime.getTime() - Date.now()) / (1000 * 60 * 60));
        
        let severity: "low" | "medium" | "high" = "low";
        if (hoursUntil <= 24) severity = "high";
        else if (hoursUntil <= 48) severity = "medium";
        
        const ruleKey = "OPEN_SHIFT_SOON";
        const entityKey = `schedule:${openShift.shiftRowId}_${openShift.shiftDate}`;
        const fingerprint = generateFingerprint({ shiftRowId: openShift.shiftRowId, shiftDate: openShift.shiftDate, hoursUntil: Math.round(hoursUntil), severity });
        
        if (!allTriggeredKeys.has(ruleKey)) {
          allTriggeredKeys.set(ruleKey, new Set());
        }
        allTriggeredKeys.get(ruleKey)!.add(entityKey);
        
        const shiftDateFormatted = new Date(openShift.shiftDate).toLocaleDateString('en-GB');
        
        const upsertResult = await storage.upsertAttentionItem({
          branchId: branch.id,
          employeeId: null,
          contractInstanceId: null,
          type: "OPEN_SHIFT_SOON" as const,
          severity,
          title: `Open shift: ${openShift.startTime.slice(0,5)}-${openShift.endTime.slice(0,5)} on ${shiftDateFormatted}`,
          description: `Shift at ${openShift.departmentName || "Unknown dept"} has no assigned staff.`,
          dueDate: shiftStartDatetime,
          ruleKey,
          entityKey,
          fingerprint,
        });
        
        if (upsertResult.action === 'created') created++;
        else if (upsertResult.action === 'updated') updated++;
      }
    } catch (error) {
      console.error(`OPEN_SHIFT_SOON (schedule) rule failed for branch ${branch.id}:`, error);
    }
  }
  
  // Auto-resolve scheduling alerts that are no longer triggered
  const openSchedulingItems = await storage.getAttentionItems({ 
    types: ["OPEN_SHIFT_SOON", "SHIFT_NEEDS_COVERAGE"], 
    resolved: false, 
    limit: 10000 
  });
  
  for (const item of openSchedulingItems) {
    if (!item.ruleKey || !item.entityKey) continue;
    
    const triggeredEntities = allTriggeredKeys.get(item.ruleKey);
    if (!triggeredEntities || !triggeredEntities.has(item.entityKey)) {
      const resolvedCount = await storage.autoResolveAttentionItems(item.ruleKey, item.entityKey);
      resolved += resolvedCount;
    }
  }
  
  return { created, updated, resolved };
}

export async function runAttentionEngine(): Promise<{ created: number; message: string }> {
  try {
    const result = await runFullReconciliation();
    
    // Also run scheduling alerts
    const schedulingResult = await evaluateSchedulingAlerts();
    
    const totalCreated = result.created + schedulingResult.created;
    const totalUpdated = result.updated + schedulingResult.updated;
    const totalResolved = result.resolved + schedulingResult.resolved;
    
    return {
      created: totalCreated,
      message: `Attention engine completed. Created ${totalCreated}, updated ${totalUpdated}, resolved ${totalResolved} item(s).`,
    };
  } catch (error) {
    console.error("Attention engine error:", error);
    return {
      created: 0,
      message: `Attention engine failed: ${error}`,
    };
  }
}

export async function evaluateRuleForEmployee(employeeId: string): Promise<{
  ruleKey: string;
  triggered: boolean;
  reason: string;
  item?: AttentionRuleResult;
}[]> {
  const employee = await storage.getEmployee(employeeId);
  if (!employee) {
    return rules.map(r => ({
      ruleKey: r.ruleKey,
      triggered: false,
      reason: "Employee not found",
    }));
  }
  
  const contracts = await storage.getContracts();
  const employeeContracts = contracts.filter(c => c.employeeId === employeeId);
  
  // Fetch documents, letters, assets, and roles for rules
  const documents = await storage.getEmployeeDocuments(employeeId);
  const letters = await storage.getEmployeeLetters(employeeId);
  const assets = await storage.getEmployeeAssets(employeeId);
  const roles = await storage.getEmployeeRoles(employeeId);
  
  return rules.map(rule => {
    try {
      const result = rule.evaluate(employee, employeeContracts, documents, letters, assets, roles);
      if (result) {
        return {
          ruleKey: rule.ruleKey,
          triggered: true,
          reason: result.item.description || "Condition met",
          item: result,
        };
      }
      return {
        ruleKey: rule.ruleKey,
        triggered: false,
        reason: "Condition not met",
      };
    } catch (error) {
      return {
        ruleKey: rule.ruleKey,
        triggered: false,
        reason: `Error: ${error}`,
      };
    }
  });
}

export function getRuleDefinitions(): { ruleKey: string; type: AttentionType; description: string }[] {
  return rules.map(r => ({
    ruleKey: r.ruleKey,
    type: r.type,
    description: getDescriptionForRule(r.ruleKey),
  }));
}

function getDescriptionForRule(ruleKey: string): string {
  const descriptions: Record<string, string> = {
    "CONTRACT_NOT_SENT": "Finalized contracts waiting to be sent to employees",
    "CONTRACT_NOT_SIGNED": "Contracts awaiting employee signature",
    "CHANGE_NO_CONTRACT": "Employees without any contract after grace period",
    "PROBATION_REVIEW_DUE": "Probation reviews due within 14 days",
    "PROBATION_REVIEW_OVERDUE": "Probation reviews that are overdue",
    "MISSING_OFFBOARD_DOC": "Missing signed resignation or termination letters",
    "OFFBOARDING_DATES_INCOMPLETE": "Missing last working day or end reason for departed employees",
    "VISA_EXPIRING": "Visa expiring or expired for foreign staff",
    "WORK_PERMIT_EXPIRING": "Work permit expiring or expired for foreign staff",
    "MISSING_VISA_WP_POLICY": "Foreign staff missing visa or work permit information",
    "EMPLOYEE_MISSING_DEPARTMENT": "Employees without an assigned department",
    "EMPLOYEE_MISSING_ROLE": "Employees without any assigned roles",
    "OPEN_SHIFT_SOON": "Open shifts starting within 72 hours without an assigned employee",
    "SHIFT_NEEDS_COVERAGE": "Shifts requiring coverage due to employee unavailability",
    "MISSING_LOGIN_ACCESS": "Employees without Core login access enabled",
    "DUPLICATE_FACE_ENROLLMENT": "Faces enrolled under two different employees with high similarity — possible mis-enrollment",
  };
  return descriptions[ruleKey] || "Unknown rule";
}
