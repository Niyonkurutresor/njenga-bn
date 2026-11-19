/**
 * Domain enumerations shared by the database schema, validation schemas and services.
 * Values are stored as-is in MySQL ENUM columns — never rename a value without a migration.
 */

export const USER_STATUSES = ['active', 'inactive'] as const;
export type UserStatus = (typeof USER_STATUSES)[number];

/** Where a cost or budget belongs (SRS 1.3 "Cost centre"). */
export const COST_CENTRE_TYPES = ['project', 'farm', 'office'] as const;
export type CostCentreType = (typeof COST_CENTRE_TYPES)[number];

// ---------- Requests & approvals (SRS 3.2) ----------
export const REQUEST_TYPES = ['funding', 'purchase'] as const;
export type RequestType = (typeof REQUEST_TYPES)[number];

export const REQUEST_STATUSES = [
  'submitted',
  'returned',
  'pending_approval',
  'approved',
  'rejected',
  'paid',
] as const;
export type RequestStatus = (typeof REQUEST_STATUSES)[number];

export const REQUEST_EVENT_ACTIONS = [
  'submitted',
  'resubmitted',
  'returned',
  'forwarded',
  'approved',
  'rejected',
  'paid',
  'commented',
] as const;
export type RequestEventAction = (typeof REQUEST_EVENT_ACTIONS)[number];

export const PAYMENT_METHODS = [
  'cash',
  'bank_transfer',
  'mobile_money',
  'cheque',
  'other',
] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

// ---------- Finance (SRS 3.3) ----------
export const TRANSACTION_DIRECTIONS = ['in', 'out'] as const;
export type TransactionDirection = (typeof TRANSACTION_DIRECTIONS)[number];

export const TRANSACTION_SOURCES = [
  'manual',
  'request',
  'payroll',
  'casual_payroll',
  'stock_purchase',
  'stock_issue',
  'loan_receipt',
  'loan_repayment',
] as const;
export type TransactionSource = (typeof TRANSACTION_SOURCES)[number];

export const CATEGORY_KINDS = ['expense', 'income'] as const;
export type CategoryKind = (typeof CATEGORY_KINDS)[number];

export const LOAN_STATUSES = ['active', 'repaid'] as const;
export type LoanStatus = (typeof LOAN_STATUSES)[number];

// ---------- Payroll (SRS 3.4) ----------
export const RUN_STATUSES = ['draft', 'paid'] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

export const WORK_SITE_TYPES = ['farm', 'project'] as const;
export type WorkSiteType = (typeof WORK_SITE_TYPES)[number];

// ---------- Projects (SRS 3.5) ----------
/** Ordered lifecycle (FR-PRJ-02). */
export const PROJECT_STATUSES = [
  'created',
  'budgeted',
  'tasks_assigned',
  'funding_requested',
  'funding_approved',
  'in_execution',
  'completed',
  'pl_analysed',
  'closed',
] as const;
export type ProjectStatus = (typeof PROJECT_STATUSES)[number];

// ---------- Tasks (SRS 3.6) ----------
export const TASK_STATUSES = ['not_started', 'in_progress', 'blocked', 'done'] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const PRIORITIES = ['low', 'medium', 'high', 'urgent'] as const;
export type Priority = (typeof PRIORITIES)[number];

// ---------- Field operations (SRS 3.7) ----------
export const PROGRESS_REPORT_STATUSES = ['submitted', 'verified', 'queried'] as const;
export type ProgressReportStatus = (typeof PROGRESS_REPORT_STATUSES)[number];

export const SEVERITIES = ['low', 'medium', 'high'] as const;
export type Severity = (typeof SEVERITIES)[number];

export const ISSUE_STATUSES = ['open', 'resolved'] as const;
export type IssueStatus = (typeof ISSUE_STATUSES)[number];

// ---------- Farm (SRS 3.8) ----------
export const PLOT_KINDS = ['greenhouse', 'field_block'] as const;
export type PlotKind = (typeof PLOT_KINDS)[number];

export const PLOT_STATUSES = ['active', 'fallow', 'maintenance'] as const;
export type PlotStatus = (typeof PLOT_STATUSES)[number];

export const CROP_HEALTH = ['good', 'fair', 'poor'] as const;
export type CropHealth = (typeof CROP_HEALTH)[number];

/** Pest/disease severity, including "none" for clean observations. */
export const OBSERVATION_SEVERITIES = ['none', 'low', 'medium', 'high'] as const;
export type ObservationSeverity = (typeof OBSERVATION_SEVERITIES)[number];

export const HARVEST_UNITS = ['kg', 'units'] as const;
export type HarvestUnit = (typeof HARVEST_UNITS)[number];

export const HARVEST_GRADES = ['A', 'B', 'C', 'reject'] as const;
export type HarvestGrade = (typeof HARVEST_GRADES)[number];

export const INSPECTION_STATUSES = ['open', 'treated', 'closed'] as const;
export type InspectionStatus = (typeof INSPECTION_STATUSES)[number];

// ---------- CRM (SRS 3.9) ----------
export const LEAD_STAGES = [
  'new',
  'contacted',
  'proposal_sent',
  'negotiation',
  'won',
  'lost',
] as const;
export type LeadStage = (typeof LEAD_STAGES)[number];

export const CUSTOMER_TYPES = ['company', 'individual'] as const;
export type CustomerType = (typeof CUSTOMER_TYPES)[number];

export const INTERACTION_TYPES = ['call', 'meeting', 'email', 'visit', 'note'] as const;
export type InteractionType = (typeof INTERACTION_TYPES)[number];

// ---------- Inventory (SRS 3.10) ----------
export const STOCK_MOVEMENT_TYPES = ['receipt', 'issue', 'adjustment'] as const;
export type StockMovementType = (typeof STOCK_MOVEMENT_TYPES)[number];

// ---------- Meetings (SRS 3.11) ----------
export const MEETING_STATUSES = ['scheduled', 'completed', 'cancelled'] as const;
export type MeetingStatus = (typeof MEETING_STATUSES)[number];

// ---------- Reports (SRS 3.13) ----------
export const REPORT_REQUEST_STATUSES = ['open', 'delivered', 'cancelled'] as const;
export type ReportRequestStatus = (typeof REPORT_REQUEST_STATUSES)[number];
