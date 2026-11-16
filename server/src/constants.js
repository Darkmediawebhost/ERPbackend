export const PERMISSIONS = [
  'dashboard.view',
  'founders.view',
  'founders.manage',
  'clients.view',
  'clients.manage',
  'projects.view',
  'projects.manage',
  'payments.view',
  'payments.manage',
  'income.view',
  'income.manage',
  'expenses.view',
  'expenses.manage',
  'banks.view',
  'banks.manage',
  'ledger.view',
  'ledger.post',
  'founderFinance.view',
  'founderFinance.manage',
  'invoices.view',
  'invoices.manage',
  'employees.view',
  'employees.manage',
  'attendance.view',
  'attendance.manage',
  'salary.view',
  'salary.manage',
  'calendar.view',
  'calendar.manage',
  'notes.view',
  'notes.manage',
  'reports.view',
  'reports.export',
  'notifications.view',
  'settings.view',
  'settings.manage',
  'users.manage',
];

export const EMPLOYEE_PERMISSIONS = [
  'dashboard.view',
  'projects.view',
  'calendar.view',
  'notes.view',
  'attendance.view',
  'notifications.view',
];

export const COFOUNDER_PERMISSIONS = PERMISSIONS.filter(
  (permission) => permission !== 'users.manage' && permission !== 'settings.manage',
);

export const INCOME_CATEGORIES = [
  'Website Development',
  'Software Development',
  'Digital Marketing',
  'Video Editing',
  'Branding',
  'Freelance Work',
  'Maintenance',
  'Client Payments',
  'Other Income',
];

export const EXPENSE_CATEGORIES = [
  'Food',
  'Rent',
  'Employee Salary',
  'Electricity',
  'Internet',
  'Software Subscription',
  'ads Marketing',
  'Other Expenses',
];

export const INCOME_ACCOUNT_CODES = {
  'Website Development': '4010',
  'Software Development': '4020',
  'Digital Marketing': '4030',
  'Video Editing': '4040',
  Branding: '4050',
  'Freelance Work': '4060',
  Maintenance: '4070',
  'Client Payments': '4080',
  'Other Income': '4090',
};

export const EXPENSE_ACCOUNT_CODES = {
  Food: '5000',
  Rent: '5010',
  'Employee Salary': '5020',
  Electricity: '5030',
  Internet: '5040',
  Hosting: '5050',
  Domain: '5060',
  'Software Subscription': '5070',
  'Online Subscription': '5080',
  Marketing: '5090',
  'ads Marketing': '5095',
  Travel: '5100',
  'Office Supplies': '5110',
  Equipment: '5120',
  Maintenance: '5130',
  'Other Expenses': '5190',
};

export const SYSTEM_ACCOUNTS = [
  { code: '1000', name: 'Company Cash', type: 'asset', subtype: 'cash', normalBalance: 'debit' },
  { code: '1300', name: 'Employee Advances', type: 'asset', subtype: 'advance', normalBalance: 'debit' },
  { code: '2100', name: 'GST Payable', type: 'liability', subtype: 'tax', normalBalance: 'credit' },
  { code: '3000', name: 'Retained Earnings', type: 'equity', subtype: 'retained', normalBalance: 'credit' },
  { code: '3900', name: 'Opening Balance Equity', type: 'equity', subtype: 'opening', normalBalance: 'credit' },
  ...INCOME_CATEGORIES.map((name) => ({
    code: INCOME_ACCOUNT_CODES[name],
    name,
    type: 'income',
    subtype: 'operating',
    normalBalance: 'credit',
  })),
  ...EXPENSE_CATEGORIES.map((name) => ({
    code: EXPENSE_ACCOUNT_CODES[name],
    name,
    type: 'expense',
    subtype: 'operating',
    normalBalance: 'debit',
  })),
];

export const PAYMENT_METHODS = ['cash', 'bank_transfer'];

export const PROJECT_STATUSES = ['Planning', 'Not Started', 'In Progress', 'Review', 'Completed', 'On Hold'];

export const TASK_STATUSES = ['To Do', 'In Progress', 'Review', 'Completed'];

export const PAYMENT_TYPES = ['monthly_subscription', 'project_based', 'one_time', 'maintenance'];

export const RECURRING_PAYMENT_TYPES = ['monthly_subscription', 'maintenance'];

export const NOTE_COLORS = ['white', 'gray', 'ink', 'tint'];

export const EVENT_TYPES = [
  'Client Meeting',
  'Project Deadline',
  'Payment Due',
  'Employee Event',
  'Business Meeting',
  'Personal Reminder',
];
