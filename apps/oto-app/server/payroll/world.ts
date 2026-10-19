// The engine's input, by name (plan §2). The prototype's browser aggregate
// `PayrollPrototypeData` is `PayrollWorld` here; R3's world loader builds one
// from the database for a (tenant, month), with the month's
// `CompanyPayrollDocument` assembled beside it. Types only in R1.
export type { PayrollWorld, BranchRecord, StaffMember, AttendanceDay, StatutoryRules } from "./engine/model";
export type { CompanyPayrollDocument, CompanyCalculation, CompanyResult, CompanyPerson } from "./engine/company-model";
export type { EmployeePayrollProfile, PayingEntity, PayingAccount } from "./engine/payroll-profile";
export type { PayrollClock } from "./engine/clock";
