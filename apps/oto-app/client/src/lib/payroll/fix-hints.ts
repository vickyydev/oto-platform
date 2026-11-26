/**
 * SCRUM-1073 (owner ruling, 26 November 2026): no payroll stop without its reason and its way forward.
 * Every blocking line, warning and refusal the month-end screens show is matched here to one plain
 * "how to fix" sentence and, where one place fixes it, the tab or page to open.
 *
 * Pure: no React, nothing that needs a browser.
 */
export type MonthTab = "attendance" | "inputs" | "adjustments" | "feeds" | "preview" | "approvals";

export interface FixHint {
  /** One sentence; empty when the message already says how to fix it. */
  text: string;
  /** The month-end tab that fixes it. */
  tab?: MonthTab;
  /** A page that fixes it. */
  href?: string;
  /** The button's or link's words. */
  label?: string;
}

export function fixHint(message: string, staffId?: string): FixHint {
  const m = message ?? "";
  const profile = staffId ? { href: `/payroll/people/${staffId}`, label: "Open the profile" } : { href: "/payroll/people", label: "Open Payroll Profiles" };
  if (/How to fix:/i.test(m)) return { text: "" };
  if (/unconfirmed attendance|attendance days? (is|are) not confirmed/i.test(m))
    return { text: "Decide the days in tab 1, Attendance, or press Confirm all remaining there.", tab: "attendance", label: "Open Attendance" };
  if (/no .*sales are entered|depends on .* revenue/i.test(m))
    return { text: "If the branch sold anything that month, enter its sales in tab 2, Inputs. If it sold nothing, there is nothing to do.", tab: "inputs", label: "Open Inputs" };
  if (/discount add-back/i.test(m))
    return { text: "In tab 2, Inputs, press Change on the branch's sales and fill the add-back amount (0 if there was none).", tab: "inputs", label: "Open Inputs" };
  if (/missing payroll profile|need payroll profiles/i.test(m))
    return { text: "Create the person's payroll profile: Payroll Profiles, Propose drafts from HR data, then complete it.", href: "/payroll/people", label: "Open Payroll Profiles" };
  if (/negative transfer|missing paying account|negative payments/i.test(m))
    return { text: "The person's deductions are more than their pay, or their branch has no paying account. Check their deductions in tab 3 and the branch's paying account in Payroll Setup.", ...profile };
  if (/wage is 0/i.test(m))
    return { text: "A person named here is set to be filed but has no pay this month. Enter their salary on the profile, or their last working day if they have left.", ...profile };
  if (/13-digit ID|title|given name|SSO filing/i.test(m))
    return { text: "Fill the 13-digit ID number, title and given name on the person's payroll profile.", ...profile };
  if (/EWF filing/i.test(m))
    return { text: "Fill the welfare fund details on the person's payroll profile: date of birth, nationality, title and names.", ...profile };
  if (/bank code|credit account|recipient name|account number/i.test(m))
    return { text: "Fill the bank, bank code, account number and account name on the person's payroll profile.", ...profile };
  if (/SSO branch no/i.test(m))
    return { text: "Enter the branch's 6-digit social security branch number in Payroll Setup, under the branch's details.", href: "/payroll/setup", label: "Open Payroll Setup" };
  if (/Zero or negative net pay/i.test(m))
    return { text: "This person earns nothing this month. For a day-rate person with no clock-in, type their worked days in tab 2, Inputs, Enter a number. If they did not work, nothing is needed.", tab: "inputs", label: "Open Inputs" };
  if (/more than 15%/i.test(m))
    return { text: "Open the person's lines in the people list and compare with last month. Nothing to fix if the change is expected." };
  if (/pool .* paid .* retained|undistributed/i.test(m))
    return { text: "The branch's service charge was not fully shared out. Check its rule and who is eligible in Service charge & incentives.", href: "/payroll/setup/rewards", label: "Open Service charge" };
  if (/third|someone else/i.test(m))
    return { text: "The pay goes to another person's account. Check the reason on the profile, then press Approve this payment." };
  if (/single shift/i.test(m))
    return { text: "A note about a former employee's single shift. Nothing to fix unless the day is wrong in Scheduling." };
  if (/is locked\. Reopen it first|locked or paid/i.test(m))
    return { text: "A locked month uses this figure. The Owner reopens that month in its Confirm & lock tab; then the figure can change.", tab: "approvals", label: "Open Confirm & lock" };
  if (/signature mismatch|confirm again/i.test(m))
    return { text: "Something changed after the GM confirmed. Press Confirm as GM again, then lock.", tab: "approvals", label: "Open Confirm & lock" };
  if (/blocking items|blocking exception/i.test(m))
    return { text: "Open Check the month and press the blocking count: each line says how to fix it.", tab: "preview", label: "Open Check the month" };
  if (/Bank files \+ cash differ/i.test(m))
    return { text: "The frozen files do not add up to net pay. Do not pay from them; report this to the system's support." };
  if (/reason is required/i.test(m)) return { text: "Type why you are making this change, then save." };
  if (/days worked must be between/i.test(m))
    return { text: "Days worked cannot be more than the days the person was employed this month." };
  if (/sales stream/i.test(m)) return { text: "Type the branch's gross sales, or 0 if it sold nothing, then save." };
  if (staffId) return { text: "Open the person's payroll profile and complete or correct what this line names.", ...profile };
  return { text: "" };
}
