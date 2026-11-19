import { ALL_PERMISSIONS, PERMISSIONS as P, type Permission } from './permissions.js';

/** The seven NGL roles (FR-USR-02). Codes are stable identifiers used by the app. */
export const ROLE_CODES = {
  DIRECTOR: 'director',
  OFFICE_ADMIN: 'office_admin',
  BDM: 'business_development_manager',
  OPS_MANAGER: 'operations_manager',
  TECHNICIAN: 'technician',
  FARM_MANAGER: 'farm_manager',
  AGRONOMIST: 'agronomist',
} as const;

export type RoleCode = (typeof ROLE_CODES)[keyof typeof ROLE_CODES];

export interface DefaultRole {
  code: RoleCode;
  name: string;
  description: string;
  permissions: readonly Permission[];
}

/**
 * Default grants, mapped from the SRS section 5 matrix
 * (F = full, A = approve, C = create/edit own, V = view, O = own records only).
 * Directors can change these at runtime; the seed only applies them to fresh roles.
 */
export const DEFAULT_ROLES: readonly DefaultRole[] = [
  {
    code: ROLE_CODES.DIRECTOR,
    name: 'Director',
    description: 'Directors / CEOs: approve spending, see everything, manage users',
    permissions: ALL_PERMISSIONS.filter(
      (p) =>
        // Directors approve rather than submit or disburse (matrix: Requests = A)
        p !== P.REQUESTS_CREATE &&
        p !== P.REQUESTS_REVIEW &&
        p !== P.REQUESTS_DISBURSE &&
        // They see farm/CRM/inventory/field data but do not operate it (matrix: V)
        p !== P.FARM_MANAGE &&
        p !== P.INSPECTIONS_CREATE &&
        p !== P.CRM_MANAGE &&
        p !== P.SALES_RECORD &&
        p !== P.INVENTORY_MANAGE &&
        p !== P.FIELD_REPORTS_SUBMIT &&
        p !== P.FIELD_REPORTS_VERIFY &&
        p !== P.OPS_REPORTS_SUBMIT &&
        p !== P.TASKS_VIEW_ASSIGNED &&
        p !== P.PROJECTS_VIEW_ASSIGNED,
    ),
  },
  {
    code: ROLE_CODES.OFFICE_ADMIN,
    name: 'Office Administrator',
    description: 'Request queue, payments, expenses, budgets, payroll, loans and reports',
    permissions: [
      P.USERS_VIEW,
      P.ROLES_VIEW,
      P.REQUESTS_CREATE,
      P.REQUESTS_VIEW_ALL,
      P.REQUESTS_REVIEW,
      P.REQUESTS_DISBURSE,
      P.FINANCE_VIEW,
      P.FINANCE_MANAGE,
      P.PAYROLL_VIEW,
      P.PAYROLL_MANAGE,
      P.CASUAL_WORKERS_MANAGE,
      P.ATTENDANCE_RECORD,
      P.PROJECTS_VIEW,
      P.TASKS_VIEW,
      P.FIELD_REPORTS_VIEW,
      P.FARM_VIEW,
      P.CRM_VIEW,
      P.INVENTORY_VIEW,
      P.MEETINGS_MANAGE,
      P.REPORTS_FINANCE,
      P.REPORTS_PROJECTS,
      P.REPORTS_OPERATIONS,
      P.REPORTS_FARM,
      P.REPORTS_BUSINESS,
      P.REPORTS_EXPORT,
    ],
  },
  {
    code: ROLE_CODES.BDM,
    name: 'Business Development Manager',
    description: 'Projects, teams, clients, deals and meetings',
    permissions: [
      P.REQUESTS_CREATE,
      P.FINANCE_VIEW,
      P.PROJECTS_VIEW,
      P.PROJECTS_MANAGE,
      P.TASKS_VIEW,
      P.TASKS_MANAGE,
      P.FIELD_REPORTS_VIEW,
      P.CRM_VIEW,
      P.CRM_MANAGE,
      P.SALES_RECORD,
      P.INVENTORY_VIEW,
      P.MEETINGS_MANAGE,
      P.REPORTS_PROJECTS,
      P.REPORTS_BUSINESS,
      P.REPORTS_EXPORT,
    ],
  },
  {
    code: ROLE_CODES.OPS_MANAGER,
    name: 'Operations Manager',
    description:
      'Running projects, technicians, site visits, procurement and daily operations report',
    permissions: [
      P.REQUESTS_CREATE,
      P.FINANCE_VIEW,
      P.ATTENDANCE_RECORD,
      P.CASUAL_WORKERS_MANAGE,
      P.PROJECTS_VIEW,
      P.PROJECTS_MANAGE,
      P.TASKS_VIEW,
      P.TASKS_MANAGE,
      P.FIELD_REPORTS_VIEW,
      P.FIELD_REPORTS_VERIFY,
      P.OPS_REPORTS_SUBMIT,
      P.FARM_VIEW,
      P.CRM_VIEW,
      P.SALES_RECORD,
      P.INVENTORY_VIEW,
      P.INVENTORY_MANAGE,
      P.MEETINGS_MANAGE,
      P.REPORTS_PROJECTS,
      P.REPORTS_OPERATIONS,
      P.REPORTS_EXPORT,
    ],
  },
  {
    code: ROLE_CODES.TECHNICIAN,
    name: 'Technician',
    description: 'Assigned work, progress updates, photos and issues from site',
    permissions: [
      P.REQUESTS_CREATE,
      P.PROJECTS_VIEW_ASSIGNED,
      P.TASKS_VIEW_ASSIGNED,
      P.FIELD_REPORTS_SUBMIT,
    ],
  },
  {
    code: ROLE_CODES.FARM_MANAGER,
    name: 'Farm Manager',
    description: 'Daily farm report, crop health, attendance, harvests and supply requests',
    permissions: [
      P.REQUESTS_CREATE,
      P.CASUAL_WORKERS_MANAGE,
      P.ATTENDANCE_RECORD,
      P.TASKS_VIEW_ASSIGNED,
      P.TASKS_MANAGE,
      P.FARM_VIEW,
      P.FARM_MANAGE,
      P.INVENTORY_VIEW,
      P.REPORTS_FARM,
      P.REPORTS_EXPORT,
    ],
  },
  {
    code: ROLE_CODES.AGRONOMIST,
    name: 'Agronomist',
    description: 'Crop inspections, disease reports and treatment recommendations',
    permissions: [
      P.REQUESTS_CREATE,
      P.TASKS_VIEW_ASSIGNED,
      P.FARM_VIEW,
      P.INSPECTIONS_CREATE,
      P.REPORTS_FARM,
      P.REPORTS_EXPORT,
    ],
  },
];
