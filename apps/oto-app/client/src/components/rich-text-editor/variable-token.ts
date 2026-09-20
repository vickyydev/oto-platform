import { Node, mergeAttributes } from '@tiptap/core';

export interface VariableTokenOptions {
  HTMLAttributes: Record<string, unknown>;
}

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    variableToken: {
      insertVariable: (attributes: { variable: string; label: string }) => ReturnType;
    };
  }
}

// Define which variables are clause blocks (render conditionally and use triple braces for raw HTML)
// Must be defined before VariableToken since it's used in renderHTML
export const clauseBlockVariables = [
  'incentive_clause_block',
  'special_terms_block',
  'visa_sponsorship_block',
];

export function isClauseBlock(variable: string): boolean {
  return clauseBlockVariables.includes(variable);
}

export const VariableToken = Node.create<VariableTokenOptions>({
  name: 'variableToken',

  group: 'inline',

  inline: true,

  atom: true,

  addOptions() {
    return {
      HTMLAttributes: {},
    };
  },

  addAttributes() {
    return {
      variable: {
        default: null,
        parseHTML: (element) => element.getAttribute('data-variable'),
        renderHTML: (attributes) => {
          return {
            'data-variable': attributes.variable,
          };
        },
      },
      label: {
        default: null,
        parseHTML: (element) => element.getAttribute('data-label'),
        renderHTML: (attributes) => {
          return {
            'data-label': attributes.label,
          };
        },
      },
    };
  },

  parseHTML() {
    return [
      {
        tag: 'span[data-variable]',
      },
    ];
  },

  renderHTML({ node, HTMLAttributes }) {
    const isBlock = isClauseBlock(node.attrs.variable);
    return [
      'span',
      mergeAttributes(this.options.HTMLAttributes, HTMLAttributes, {
        class: isBlock ? 'variable-token clause-block' : 'variable-token',
        contenteditable: 'false',
        'data-is-block': isBlock ? 'true' : 'false',
      }),
      node.attrs.label || node.attrs.variable,
    ];
  },

  renderText({ node }) {
    return `{{${node.attrs.variable}}}`;
  },

  addCommands() {
    return {
      insertVariable:
        (attributes) =>
        ({ commands }) => {
          return commands.insertContent({
            type: this.name,
            attrs: attributes,
          });
        },
    };
  },
});

export function htmlToEditorContent(html: string): string {
  // First handle triple braces (raw HTML blocks like special_terms_block)
  let result = html.replace(/\{\{\{([^}]+)\}\}\}/g, (match, variable) => {
    const trimmedVar = variable.trim();
    const label = getVariableLabel(trimmedVar);
    const isBlock = isClauseBlock(trimmedVar);
    const className = isBlock ? 'variable-token clause-block' : 'variable-token';
    return `<span data-variable="${trimmedVar}" data-label="${label}" data-raw="true" class="${className}">${label}</span>`;
  });
  // Then handle double braces (regular variables)
  result = result.replace(/\{\{([^}]+)\}\}/g, (match, variable) => {
    const trimmedVar = variable.trim();
    const label = getVariableLabel(trimmedVar);
    const isBlock = isClauseBlock(trimmedVar);
    const className = isBlock ? 'variable-token clause-block' : 'variable-token';
    return `<span data-variable="${trimmedVar}" data-label="${label}" class="${className}">${label}</span>`;
  });
  return result;
}

export function editorContentToHtml(html: string): string {
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, 'text/html');
  const tokens = doc.querySelectorAll('span[data-variable]');
  
  tokens.forEach((token) => {
    const variable = token.getAttribute('data-variable');
    const isRaw = token.getAttribute('data-raw') === 'true';
    if (variable) {
      // Use triple braces for raw blocks (clause blocks render HTML), double for regular variables
      const braces = isRaw || isClauseBlock(variable) ? '{{{' : '{{';
      const closeBraces = isRaw || isClauseBlock(variable) ? '}}}' : '}}';
      const textNode = doc.createTextNode(`${braces}${variable}${closeBraces}`);
      token.parentNode?.replaceChild(textNode, token);
    }
  });
  
  return doc.body.innerHTML;
}

export function getVariableLabel(variable: string): string {
  const labels: Record<string, string> = {
    'employee.full_name': 'Employee: Full Name',
    'employee.email': 'Employee: Email',
    'employee.phone': 'Employee: Phone',
    'employee.address': 'Employee: Address',
    'contract.position_title': 'Contract: Position',
    'contract.salary_thb': 'Contract: Salary (THB)',
    'contract.start_date': 'Contract: Start Date',
    'contract.work_location': 'Contract: Work Location',
    'contract.food_allowance_per_day': 'Contract: Food Allowance/Day',
    'incentive_clause_block': 'Incentive/Commission and Allowance Block',
    'special_terms_block': 'Special Terms Block',
    'visa_sponsorship_block': 'Visa Sponsorship Block',
    'employee.id_number': 'Employee: ID Number',
    'employee.department': 'Employee: Department',
    'employee.start_date_employment': 'Employee: Employment Start Date',
    'employee.years_of_service': 'Employee: Years of Service',
    'termination.last_working_day': 'Termination: Last Working Day',
    'termination.notice_period_days': 'Termination: Notice Period (Days)',
    'termination.reason': 'Termination: Reason',
    'termination.severance_pay': 'Termination: Severance Pay (THB)',
    'termination.remaining_annual_leave': 'Termination: Remaining Annual Leave (Days)',
    'termination.remaining_public_holidays': 'Termination: Remaining Public Holidays (Days)',
    'termination.remaining_keep_day_off': 'Termination: Keep Day Off (Days)',
    'termination.remaining_ot_lieu': 'Termination: Overtime in Lieu (Days)',
    'termination.remaining_leave_total': 'Termination: Total Remaining Leave (Days)',
    'termination.service_charge_months': 'Termination: Service Charge Months',
    'termination.service_charge_payout_dates': 'Termination: Service Charge Payout Dates',
    'termination.salary_due': 'Termination: Remaining Salary Due (THB)',
    'termination.reason_code': 'Termination: SSO Reason Code',
    'termination.unused_leave_payout': 'Termination: Unused Leave Payout (THB)',
    'termination.notice_pay': 'Termination: Payment in Lieu of Notice (THB)',
    'termination.severance_amount': 'Termination: Severance Amount (THB)',
    'termination.service_charge_payout': 'Termination: Service Charge Payout (THB)',
    'termination.total_payout': 'Termination: Total Net Payout (THB)',
    'warning.issued_date': 'Warning: Issued Date',
    'warning.violation_date': 'Warning: Violation Date',
    'warning.violation_time': 'Warning: Violation Time',
    'warning.violation_type': 'Warning: Violation Type',
    'warning.violation_details': 'Warning: Violation Details',
    'warning.warning_type': 'Warning: Type of Warning',
    'warning.warning_number': 'Warning: Warning Number',
    'warning.warning_count': 'Warning: Warning Count (1st/2nd/Final)',
    'warning.disciplinary_action': 'Warning: Disciplinary Action Details',
    'warning.expiry_date': 'Warning: Expiry Date (1 Year)',
    'branch.name': 'Branch: Name',
    'branch.address': 'Branch: Address',
    'branch.logo_url': 'Branch: Logo',
    'document.todays_date': 'Document: Today\'s Date',
  };
  return labels[variable] || variable;
}

export const variableGroups = [
  {
    label: 'Document',
    variables: [
      { variable: 'document.todays_date', label: "Today's Date" },
    ],
  },
  {
    label: 'Employee',
    variables: [
      { variable: 'employee.full_name', label: 'Full Name' },
      { variable: 'employee.email', label: 'Email' },
      { variable: 'employee.phone', label: 'Phone' },
      { variable: 'employee.address', label: 'Address' },
      { variable: 'employee.id_number', label: 'ID Number' },
      { variable: 'employee.department', label: 'Department' },
      { variable: 'employee.start_date_employment', label: 'Employment Start Date' },
      { variable: 'employee.years_of_service', label: 'Years of Service' },
    ],
  },
  {
    label: 'Contract',
    variables: [
      { variable: 'contract.position_title', label: 'Position Title' },
      { variable: 'contract.salary_thb', label: 'Salary (THB)' },
      { variable: 'contract.start_date', label: 'Start Date' },
      { variable: 'contract.work_location', label: 'Work Location' },
      { variable: 'contract.food_allowance_per_day', label: 'Food Allowance/Day' },
    ],
  },
  {
    label: 'Termination',
    variables: [
      { variable: 'termination.last_working_day', label: 'Last Working Day' },
      { variable: 'termination.notice_period_days', label: 'Notice Period (Days)' },
      { variable: 'termination.reason', label: 'Reason for Termination' },
      { variable: 'termination.severance_pay', label: 'Severance Pay (THB)' },
      { variable: 'termination.remaining_annual_leave', label: 'Remaining Annual Leave (Days)' },
      { variable: 'termination.remaining_public_holidays', label: 'Remaining Public Holidays (Days)' },
      { variable: 'termination.remaining_keep_day_off', label: 'Keep Day Off (Days)' },
      { variable: 'termination.remaining_ot_lieu', label: 'Overtime in Lieu (Days)' },
      { variable: 'termination.remaining_leave_total', label: 'Total Remaining Leave (Days)' },
      { variable: 'termination.service_charge_months', label: 'Service Charge Months' },
      { variable: 'termination.service_charge_payout_dates', label: 'Service Charge Payout Dates' },
      { variable: 'termination.salary_due', label: 'Remaining Salary Due (THB)' },
      { variable: 'termination.reason_code', label: 'SSO Reason Code' },
      { variable: 'termination.unused_leave_payout', label: 'Unused Leave Payout (THB)' },
      { variable: 'termination.notice_pay', label: 'Payment in Lieu of Notice (THB)' },
      { variable: 'termination.severance_amount', label: 'Severance Amount (THB)' },
      { variable: 'termination.service_charge_payout', label: 'Service Charge Payout (THB)' },
      { variable: 'termination.total_payout', label: 'Total Net Payout (THB)' },
    ],
  },
  {
    label: 'Warning',
    variables: [
      { variable: 'warning.issued_date', label: 'Issued Date' },
      { variable: 'warning.violation_date', label: 'Violation Date' },
      { variable: 'warning.violation_time', label: 'Violation Time' },
      { variable: 'warning.violation_type', label: 'Violation Type (Minor/Major/Serious)' },
      { variable: 'warning.violation_details', label: 'Violation Details' },
      { variable: 'warning.warning_type', label: 'Type of Warning' },
      { variable: 'warning.warning_number', label: 'Warning Number' },
      { variable: 'warning.warning_count', label: 'Warning Count (1st/2nd/Final)' },
      { variable: 'warning.disciplinary_action', label: 'Disciplinary Action Details' },
      { variable: 'warning.expiry_date', label: 'Expiry Date (1 Year from Violation)' },
    ],
  },
  {
    label: 'Branch',
    variables: [
      { variable: 'branch.name', label: 'Branch Name' },
      { variable: 'branch.address', label: 'Branch Address' },
      { variable: 'branch.logo_url', label: 'Branch Logo URL' },
    ],
  },
  {
    label: 'Clause Blocks',
    variables: [
      { variable: 'incentive_clause_block', label: 'Incentive/Commission and Allowance' },
      { variable: 'special_terms_block', label: 'Special Terms (Custom Clauses)' },
      { variable: 'visa_sponsorship_block', label: 'Visa & Work Permit Sponsorship' },
    ],
  },
];
