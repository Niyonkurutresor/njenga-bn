/**
 * Permission catalogue — every action the system can authorise, as `module:action`.
 *
 * The catalogue is code (an action only exists if code enforces it); which ROLE holds which
 * permission is data in `role_permissions`, editable by Directors (FR-USR-03, NFR-13).
 * Default grants (SRS section 5) live in ./default-roles.ts.
 *
 * Keep `frontend/src/lib/permissions.ts` in sync (tests/permissions-sync.test.ts enforces it).
 */
export const PERMISSIONS = {
  // Users & roles (SRS 3.1)
  USERS_VIEW: 'users:view',
  USERS_MANAGE: 'users:manage',
  ROLES_VIEW: 'roles:view',
  ROLES_MANAGE: 'roles:manage',

  // Requests & approval workflow (SRS 3.2)
  REQUESTS_CREATE: 'requests:create',
  REQUESTS_VIEW_ALL: 'requests:view_all',
  REQUESTS_REVIEW: 'requests:review',
  REQUESTS_APPROVE: 'requests:approve',
  REQUESTS_DISBURSE: 'requests:disburse',

  // Finance, budgets, loans (SRS 3.3)
  FINANCE_VIEW: 'finance:view',
  FINANCE_MANAGE: 'finance:manage',
  /** Edit a recorded payment after the 24h lock (FR-FIN-10, BRL-09). */
  FINANCE_OVERRIDE: 'finance:override',

  // Payroll & casual workers (SRS 3.4)
  PAYROLL_VIEW: 'payroll:view',
  PAYROLL_MANAGE: 'payroll:manage',
  CASUAL_WORKERS_MANAGE: 'casual_workers:manage',
  ATTENDANCE_RECORD: 'attendance:record',

  // Projects (SRS 3.5)
  PROJECTS_VIEW: 'projects:view',
  /** See only projects the user is a member/lead of. */
  PROJECTS_VIEW_ASSIGNED: 'projects:view_assigned',
  PROJECTS_MANAGE: 'projects:manage',

  // Tasks (SRS 3.6)
  TASKS_VIEW: 'tasks:view',
  TASKS_VIEW_ASSIGNED: 'tasks:view_assigned',
  TASKS_MANAGE: 'tasks:manage',

  // Technician & operations reporting (SRS 3.7)
  FIELD_REPORTS_VIEW: 'field_reports:view',
  FIELD_REPORTS_SUBMIT: 'field_reports:submit',
  FIELD_REPORTS_VERIFY: 'field_reports:verify',
  OPS_REPORTS_SUBMIT: 'ops_reports:submit',

  // Farm & agronomy (SRS 3.8)
  FARM_VIEW: 'farm:view',
  FARM_MANAGE: 'farm:manage',
  INSPECTIONS_CREATE: 'inspections:create',

  // Business development, CRM, sales (SRS 3.9)
  CRM_VIEW: 'crm:view',
  CRM_MANAGE: 'crm:manage',
  SALES_RECORD: 'sales:record',

  // Inventory & procurement (SRS 3.10)
  INVENTORY_VIEW: 'inventory:view',
  INVENTORY_MANAGE: 'inventory:manage',

  // Meetings (SRS 3.11)
  MEETINGS_MANAGE: 'meetings:manage',

  // Reports (SRS 3.13) — one permission per report family
  REPORTS_FINANCE: 'reports:finance',
  REPORTS_PROJECTS: 'reports:projects',
  REPORTS_OPERATIONS: 'reports:operations',
  REPORTS_FARM: 'reports:farm',
  REPORTS_BUSINESS: 'reports:business',
  REPORTS_EXPORT: 'reports:export',
  REPORT_REQUESTS_CREATE: 'report_requests:create',

  // Audit (SRS 3.16)
  AUDIT_VIEW: 'audit:view',
  RECORDS_RESTORE: 'records:restore',
} as const;

export type Permission = (typeof PERMISSIONS)[keyof typeof PERMISSIONS];

export const ALL_PERMISSIONS: readonly Permission[] = Object.values(PERMISSIONS);

export function isPermission(value: string): value is Permission {
  return (ALL_PERMISSIONS as readonly string[]).includes(value);
}

/** Human-readable grouping for the role editor UI. */
export const PERMISSION_GROUPS: {
  module: string;
  permissions: { key: Permission; label: string }[];
}[] = [
  {
    module: 'Users and roles',
    permissions: [
      { key: PERMISSIONS.USERS_VIEW, label: 'View users' },
      { key: PERMISSIONS.USERS_MANAGE, label: 'Create, edit, deactivate users' },
      { key: PERMISSIONS.ROLES_VIEW, label: 'View roles' },
      { key: PERMISSIONS.ROLES_MANAGE, label: 'Configure roles and permissions' },
    ],
  },
  {
    module: 'Requests',
    permissions: [
      { key: PERMISSIONS.REQUESTS_CREATE, label: 'Submit own requests' },
      { key: PERMISSIONS.REQUESTS_VIEW_ALL, label: 'View all requests' },
      { key: PERMISSIONS.REQUESTS_REVIEW, label: 'Review, forward and return requests' },
      { key: PERMISSIONS.REQUESTS_APPROVE, label: 'Approve or reject requests' },
      { key: PERMISSIONS.REQUESTS_DISBURSE, label: 'Record disbursements' },
    ],
  },
  {
    module: 'Finance, budgets, loans',
    permissions: [
      { key: PERMISSIONS.FINANCE_VIEW, label: 'View finance' },
      { key: PERMISSIONS.FINANCE_MANAGE, label: 'Record transactions, budgets, loans' },
      { key: PERMISSIONS.FINANCE_OVERRIDE, label: 'Edit payments after 24 hours' },
    ],
  },
  {
    module: 'Payroll and casual workers',
    permissions: [
      { key: PERMISSIONS.PAYROLL_VIEW, label: 'View payroll' },
      { key: PERMISSIONS.PAYROLL_MANAGE, label: 'Run and pay payroll' },
      { key: PERMISSIONS.CASUAL_WORKERS_MANAGE, label: 'Register casual workers' },
      { key: PERMISSIONS.ATTENDANCE_RECORD, label: 'Record attendance' },
    ],
  },
  {
    module: 'Projects and tasks',
    permissions: [
      { key: PERMISSIONS.PROJECTS_VIEW, label: 'View all projects' },
      { key: PERMISSIONS.PROJECTS_VIEW_ASSIGNED, label: 'View assigned projects' },
      { key: PERMISSIONS.PROJECTS_MANAGE, label: 'Create and manage projects' },
      { key: PERMISSIONS.TASKS_VIEW, label: 'View all tasks' },
      { key: PERMISSIONS.TASKS_VIEW_ASSIGNED, label: 'View own tasks' },
      { key: PERMISSIONS.TASKS_MANAGE, label: 'Create and assign tasks' },
    ],
  },
  {
    module: 'Technician and operations reports',
    permissions: [
      { key: PERMISSIONS.FIELD_REPORTS_VIEW, label: 'View technician reports' },
      { key: PERMISSIONS.FIELD_REPORTS_SUBMIT, label: 'Submit progress reports and issues' },
      { key: PERMISSIONS.FIELD_REPORTS_VERIFY, label: 'Verify reports, record site visits' },
      { key: PERMISSIONS.OPS_REPORTS_SUBMIT, label: 'Submit daily operations report' },
    ],
  },
  {
    module: 'Farm and agronomy',
    permissions: [
      { key: PERMISSIONS.FARM_VIEW, label: 'View farm' },
      { key: PERMISSIONS.FARM_MANAGE, label: 'Manage greenhouses, daily reports, harvests' },
      { key: PERMISSIONS.INSPECTIONS_CREATE, label: 'Record crop inspections' },
    ],
  },
  {
    module: 'Business development',
    permissions: [
      { key: PERMISSIONS.CRM_VIEW, label: 'View leads and customers' },
      { key: PERMISSIONS.CRM_MANAGE, label: 'Manage leads, customers, deals' },
      { key: PERMISSIONS.SALES_RECORD, label: 'Record sales and interactions' },
    ],
  },
  {
    module: 'Inventory and procurement',
    permissions: [
      { key: PERMISSIONS.INVENTORY_VIEW, label: 'View stock' },
      { key: PERMISSIONS.INVENTORY_MANAGE, label: 'Receive and issue stock' },
    ],
  },
  {
    module: 'Meetings',
    permissions: [{ key: PERMISSIONS.MEETINGS_MANAGE, label: 'Schedule meetings' }],
  },
  {
    module: 'Reports',
    permissions: [
      { key: PERMISSIONS.REPORTS_FINANCE, label: 'Financial reports' },
      { key: PERMISSIONS.REPORTS_PROJECTS, label: 'Project financial reports' },
      { key: PERMISSIONS.REPORTS_OPERATIONS, label: 'Operations reports' },
      { key: PERMISSIONS.REPORTS_FARM, label: 'Farm and crop reports' },
      { key: PERMISSIONS.REPORTS_BUSINESS, label: 'Business development and performance reports' },
      { key: PERMISSIONS.REPORTS_EXPORT, label: 'Export reports to PDF / Excel' },
      { key: PERMISSIONS.REPORT_REQUESTS_CREATE, label: 'Request reports from departments' },
    ],
  },
  {
    module: 'Audit',
    permissions: [
      { key: PERMISSIONS.AUDIT_VIEW, label: 'View audit log' },
      { key: PERMISSIONS.RECORDS_RESTORE, label: 'Restore deleted records' },
    ],
  },
];

export function hasPermissions(
  owned: readonly string[],
  required: readonly Permission[],
  mode: 'all' | 'any' = 'all',
): boolean {
  return mode === 'all'
    ? required.every((p) => owned.includes(p))
    : required.some((p) => owned.includes(p));
}
