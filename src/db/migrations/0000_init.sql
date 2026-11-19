CREATE TABLE `password_reset_tokens` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`user_id` bigint unsigned NOT NULL,
	`token_hash` varchar(64) NOT NULL,
	`expires_at` datetime(3) NOT NULL,
	`used_at` datetime(3),
	`created_at` datetime(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP(3)),
	CONSTRAINT `password_reset_tokens_id` PRIMARY KEY(`id`),
	CONSTRAINT `prt_token_uq` UNIQUE(`token_hash`)
);
--> statement-breakpoint
CREATE TABLE `role_permissions` (
	`role_id` bigint unsigned NOT NULL,
	`permission` varchar(64) NOT NULL,
	`created_at` datetime(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP(3)),
	CONSTRAINT `role_permissions_role_id_permission_pk` PRIMARY KEY(`role_id`,`permission`)
);
--> statement-breakpoint
CREATE TABLE `roles` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`code` varchar(50) NOT NULL,
	`name` varchar(100) NOT NULL,
	`description` text,
	`is_system` boolean NOT NULL DEFAULT false,
	`created_at` datetime(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP(3)),
	`updated_at` datetime(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP(3)),
	CONSTRAINT `roles_id` PRIMARY KEY(`id`),
	CONSTRAINT `roles_code_uq` UNIQUE(`code`)
);
--> statement-breakpoint
CREATE TABLE `users` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`name` varchar(150) NOT NULL,
	`email` varchar(191) NOT NULL,
	`phone` varchar(20),
	`password_hash` varchar(255) NOT NULL,
	`role_id` bigint unsigned NOT NULL,
	`status` enum('active','inactive') NOT NULL DEFAULT 'active',
	`job_title` varchar(100),
	`department` varchar(100),
	`failed_login_attempts` int NOT NULL DEFAULT 0,
	`locked_until` datetime(3),
	`last_login_at` datetime(3),
	`password_changed_at` datetime(3),
	`created_at` datetime(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP(3)),
	`updated_at` datetime(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP(3)),
	CONSTRAINT `users_id` PRIMARY KEY(`id`),
	CONSTRAINT `users_email_uq` UNIQUE(`email`),
	CONSTRAINT `users_phone_uq` UNIQUE(`phone`)
);
--> statement-breakpoint
CREATE TABLE `audit_logs` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`user_id` bigint unsigned,
	`action` varchar(40) NOT NULL,
	`entity_type` varchar(60) NOT NULL,
	`entity_id` varchar(64),
	`old_values` json,
	`new_values` json,
	`ip_address` varchar(64),
	`user_agent` varchar(255),
	`created_at` datetime(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP(3)),
	CONSTRAINT `audit_logs_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `documents` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`entity_type` varchar(60) NOT NULL,
	`entity_id` varchar(64) NOT NULL,
	`file_name` varchar(255) NOT NULL,
	`mime_type` varchar(120) NOT NULL,
	`size_bytes` int NOT NULL,
	`url` varchar(500) NOT NULL,
	`storage_key` varchar(255) NOT NULL,
	`uploaded_by` bigint unsigned NOT NULL,
	`created_at` datetime(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP(3)),
	`deleted_at` datetime(3),
	CONSTRAINT `documents_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `notification_preferences` (
	`user_id` bigint unsigned NOT NULL,
	`type` varchar(60) NOT NULL,
	`email_enabled` boolean NOT NULL DEFAULT true,
	`sms_enabled` boolean NOT NULL DEFAULT true,
	CONSTRAINT `notification_preferences_user_id_type_pk` PRIMARY KEY(`user_id`,`type`)
);
--> statement-breakpoint
CREATE TABLE `notifications` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`user_id` bigint unsigned NOT NULL,
	`type` varchar(60) NOT NULL,
	`title` varchar(200) NOT NULL,
	`body` text,
	`link` varchar(255),
	`entity_type` varchar(60),
	`entity_id` varchar(64),
	`read_at` datetime(3),
	`created_at` datetime(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP(3)),
	CONSTRAINT `notifications_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `sequences` (
	`name` varchar(40) NOT NULL,
	`value` int NOT NULL DEFAULT 0,
	CONSTRAINT `sequences_name` PRIMARY KEY(`name`)
);
--> statement-breakpoint
CREATE TABLE `customer_contacts` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`customer_id` bigint unsigned NOT NULL,
	`name` varchar(150) NOT NULL,
	`position` varchar(100),
	`phone` varchar(30),
	`email` varchar(191),
	`created_at` datetime(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP(3)),
	CONSTRAINT `customer_contacts_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `customers` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`name` varchar(191) NOT NULL,
	`type` enum('company','individual') NOT NULL DEFAULT 'company',
	`email` varchar(191),
	`phone` varchar(30),
	`address` varchar(255),
	`notes` text,
	`created_by` bigint unsigned,
	`created_at` datetime(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP(3)),
	`updated_at` datetime(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP(3)),
	`deleted_at` datetime(3),
	CONSTRAINT `customers_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `interactions` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`customer_id` bigint unsigned,
	`lead_id` bigint unsigned,
	`type` enum('call','meeting','email','visit','note') NOT NULL,
	`summary` text NOT NULL,
	`occurred_at` datetime(3) NOT NULL,
	`user_id` bigint unsigned NOT NULL,
	`created_at` datetime(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP(3)),
	CONSTRAINT `interactions_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `leads` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`title` varchar(191) NOT NULL,
	`company_name` varchar(191) NOT NULL,
	`contact_name` varchar(150),
	`contact_phone` varchar(30),
	`contact_email` varchar(191),
	`source` varchar(100),
	`estimated_value` decimal(15,2) NOT NULL DEFAULT 0,
	`expected_close_date` date,
	`stage` enum('new','contacted','proposal_sent','negotiation','won','lost') NOT NULL DEFAULT 'new',
	`lost_reason` text,
	`owner_id` bigint unsigned NOT NULL,
	`follow_up_date` date,
	`follow_up_notified_at` datetime(3),
	`customer_id` bigint unsigned,
	`project_id` bigint unsigned,
	`converted_at` datetime(3),
	`created_at` datetime(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP(3)),
	`updated_at` datetime(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP(3)),
	`deleted_at` datetime(3),
	CONSTRAINT `leads_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `sales` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`customer_id` bigint unsigned NOT NULL,
	`project_id` bigint unsigned,
	`amount` decimal(15,2) NOT NULL,
	`sale_date` date NOT NULL,
	`description` text,
	`recorded_by` bigint unsigned NOT NULL,
	`created_at` datetime(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP(3)),
	`updated_at` datetime(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP(3)),
	`deleted_at` datetime(3),
	CONSTRAINT `sales_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `satisfaction_ratings` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`project_id` bigint unsigned NOT NULL,
	`customer_id` bigint unsigned,
	`rating` tinyint NOT NULL,
	`comment` text,
	`recorded_by` bigint unsigned NOT NULL,
	`created_at` datetime(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP(3)),
	CONSTRAINT `satisfaction_ratings_id` PRIMARY KEY(`id`),
	CONSTRAINT `satisfaction_project_uq` UNIQUE(`project_id`)
);
--> statement-breakpoint
CREATE TABLE `project_members` (
	`project_id` bigint unsigned NOT NULL,
	`user_id` bigint unsigned NOT NULL,
	`assigned_by` bigint unsigned,
	`created_at` datetime(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP(3)),
	CONSTRAINT `project_members_project_id_user_id_pk` PRIMARY KEY(`project_id`,`user_id`)
);
--> statement-breakpoint
CREATE TABLE `project_status_history` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`project_id` bigint unsigned NOT NULL,
	`from_status` enum('created','budgeted','tasks_assigned','funding_requested','funding_approved','in_execution','completed','pl_analysed','closed'),
	`to_status` enum('created','budgeted','tasks_assigned','funding_requested','funding_approved','in_execution','completed','pl_analysed','closed') NOT NULL,
	`changed_by` bigint unsigned,
	`note` text,
	`created_at` datetime(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP(3)),
	CONSTRAINT `project_status_history_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `projects` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`code` varchar(20) NOT NULL,
	`name` varchar(191) NOT NULL,
	`customer_id` bigint unsigned,
	`client_name` varchar(191),
	`location` varchar(191),
	`contract_value` decimal(15,2) NOT NULL DEFAULT 0,
	`start_date` date,
	`end_date` date,
	`status` enum('created','budgeted','tasks_assigned','funding_requested','funding_approved','in_execution','completed','pl_analysed','closed') NOT NULL DEFAULT 'created',
	`project_lead_id` bigint unsigned,
	`description` text,
	`completed_at` datetime(3),
	`closed_at` datetime(3),
	`pl_snapshot` json,
	`created_by` bigint unsigned,
	`created_at` datetime(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP(3)),
	`updated_at` datetime(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP(3)),
	`deleted_at` datetime(3),
	CONSTRAINT `projects_id` PRIMARY KEY(`id`),
	CONSTRAINT `projects_code_uq` UNIQUE(`code`)
);
--> statement-breakpoint
CREATE TABLE `tasks` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`project_id` bigint unsigned,
	`title` varchar(191) NOT NULL,
	`description` text,
	`assignee_id` bigint unsigned NOT NULL,
	`created_by` bigint unsigned NOT NULL,
	`priority` enum('low','medium','high','urgent') NOT NULL DEFAULT 'medium',
	`deadline` date,
	`status` enum('not_started','in_progress','blocked','done') NOT NULL DEFAULT 'not_started',
	`completed_at` datetime(3),
	`meeting_action_point_id` bigint unsigned,
	`created_at` datetime(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP(3)),
	`updated_at` datetime(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP(3)),
	`deleted_at` datetime(3),
	CONSTRAINT `tasks_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `budget_lines` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`budget_id` bigint unsigned NOT NULL,
	`category_id` bigint unsigned NOT NULL,
	`amount` decimal(15,2) NOT NULL,
	CONSTRAINT `budget_lines_id` PRIMARY KEY(`id`),
	CONSTRAINT `budget_lines_uq` UNIQUE(`budget_id`,`category_id`)
);
--> statement-breakpoint
CREATE TABLE `budgets` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`name` varchar(150) NOT NULL,
	`cost_centre_type` enum('project','farm','office') NOT NULL,
	`project_id` bigint unsigned,
	`period_start` date,
	`period_end` date,
	`amount` decimal(15,2) NOT NULL,
	`notes` text,
	`created_by` bigint unsigned,
	`created_at` datetime(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP(3)),
	`updated_at` datetime(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP(3)),
	`deleted_at` datetime(3),
	CONSTRAINT `budgets_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `categories` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`name` varchar(100) NOT NULL,
	`kind` enum('expense','income') NOT NULL DEFAULT 'expense',
	`is_active` boolean NOT NULL DEFAULT true,
	`created_at` datetime(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP(3)),
	`updated_at` datetime(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP(3)),
	CONSTRAINT `categories_id` PRIMARY KEY(`id`),
	CONSTRAINT `categories_name_kind_uq` UNIQUE(`name`,`kind`)
);
--> statement-breakpoint
CREATE TABLE `loan_repayments` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`loan_id` bigint unsigned NOT NULL,
	`payment_date` date NOT NULL,
	`amount` decimal(15,2) NOT NULL,
	`reference` varchar(100),
	`notes` text,
	`recorded_by` bigint unsigned NOT NULL,
	`created_at` datetime(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP(3)),
	CONSTRAINT `loan_repayments_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `loans` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`lender` varchar(150) NOT NULL,
	`principal` decimal(15,2) NOT NULL,
	`interest_rate` decimal(6,3) NOT NULL DEFAULT 0,
	`interest_charged` decimal(15,2) NOT NULL DEFAULT 0,
	`start_date` date NOT NULL,
	`term_months` int,
	`repayment_schedule` text,
	`purpose` text,
	`status` enum('active','repaid') NOT NULL DEFAULT 'active',
	`created_by` bigint unsigned,
	`created_at` datetime(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP(3)),
	`updated_at` datetime(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP(3)),
	`deleted_at` datetime(3),
	CONSTRAINT `loans_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `transactions` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`direction` enum('in','out') NOT NULL,
	`transaction_date` date NOT NULL,
	`amount` decimal(15,2) NOT NULL,
	`category_id` bigint unsigned,
	`cost_centre_type` enum('project','farm','office') NOT NULL,
	`project_id` bigint unsigned,
	`payment_method` enum('cash','bank_transfer','mobile_money','cheque','other'),
	`reference` varchar(100),
	`description` text,
	`source` enum('manual','request','payroll','casual_payroll','stock_purchase','stock_issue','loan_receipt','loan_repayment') NOT NULL DEFAULT 'manual',
	`source_id` bigint unsigned,
	`loan_id` bigint unsigned,
	`affects_cash` boolean NOT NULL DEFAULT true,
	`affects_pnl` boolean NOT NULL DEFAULT true,
	`recorded_by` bigint unsigned NOT NULL,
	`created_at` datetime(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP(3)),
	`updated_at` datetime(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP(3)),
	`deleted_at` datetime(3),
	CONSTRAINT `transactions_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `request_events` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`request_id` bigint unsigned NOT NULL,
	`actor_id` bigint unsigned NOT NULL,
	`action` enum('submitted','resubmitted','returned','forwarded','approved','rejected','paid','commented') NOT NULL,
	`from_status` enum('submitted','returned','pending_approval','approved','rejected','paid'),
	`to_status` enum('submitted','returned','pending_approval','approved','rejected','paid'),
	`comment` text,
	`created_at` datetime(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP(3)),
	CONSTRAINT `request_events_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `requests` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`reference` varchar(20) NOT NULL,
	`type` enum('funding','purchase') NOT NULL,
	`requester_id` bigint unsigned NOT NULL,
	`amount` decimal(15,2) NOT NULL,
	`purpose` text NOT NULL,
	`category_id` bigint unsigned,
	`cost_centre_type` enum('project','farm','office') NOT NULL,
	`project_id` bigint unsigned,
	`needed_by` date,
	`status` enum('submitted','returned','pending_approval','approved','rejected','paid') NOT NULL DEFAULT 'submitted',
	`exceeds_budget` boolean NOT NULL DEFAULT false,
	`rejection_reason` text,
	`decided_by` bigint unsigned,
	`decided_at` datetime(3),
	`paid_amount` decimal(15,2),
	`paid_on` date,
	`payment_method` enum('cash','bank_transfer','mobile_money','cheque','other'),
	`payment_reference` varchar(100),
	`disbursed_by` bigint unsigned,
	`transaction_id` bigint unsigned,
	`escalated_at` datetime(3),
	`created_at` datetime(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP(3)),
	`updated_at` datetime(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP(3)),
	`deleted_at` datetime(3),
	CONSTRAINT `requests_id` PRIMARY KEY(`id`),
	CONSTRAINT `requests_reference_uq` UNIQUE(`reference`)
);
--> statement-breakpoint
CREATE TABLE `attendance` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`worker_id` bigint unsigned NOT NULL,
	`work_date` date NOT NULL,
	`site_type` enum('farm','project') NOT NULL,
	`project_id` bigint unsigned,
	`present` boolean NOT NULL,
	`recorded_by` bigint unsigned NOT NULL,
	`created_at` datetime(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP(3)),
	CONSTRAINT `attendance_id` PRIMARY KEY(`id`),
	CONSTRAINT `attendance_worker_date_uq` UNIQUE(`worker_id`,`work_date`)
);
--> statement-breakpoint
CREATE TABLE `casual_pay_items` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`run_id` bigint unsigned NOT NULL,
	`worker_id` bigint unsigned NOT NULL,
	`days_present` int NOT NULL,
	`daily_rate` decimal(15,2) NOT NULL,
	`amount` decimal(15,2) NOT NULL,
	`transaction_id` bigint unsigned,
	`site_type` enum('farm','project') NOT NULL,
	`project_id` bigint unsigned,
	`paid` boolean NOT NULL DEFAULT false,
	CONSTRAINT `casual_pay_items_id` PRIMARY KEY(`id`),
	CONSTRAINT `casual_pay_items_uq` UNIQUE(`run_id`,`worker_id`)
);
--> statement-breakpoint
CREATE TABLE `casual_pay_runs` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`period_start` date NOT NULL,
	`period_end` date NOT NULL,
	`status` enum('draft','paid') NOT NULL DEFAULT 'draft',
	`total` decimal(15,2) NOT NULL DEFAULT 0,
	`created_by` bigint unsigned NOT NULL,
	`paid_by` bigint unsigned,
	`paid_at` datetime(3),
	`created_at` datetime(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP(3)),
	`updated_at` datetime(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP(3)),
	CONSTRAINT `casual_pay_runs_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `casual_workers` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`full_name` varchar(150) NOT NULL,
	`national_id` varchar(40) NOT NULL,
	`phone` varchar(30),
	`daily_rate` decimal(15,2) NOT NULL,
	`site_type` enum('farm','project') NOT NULL DEFAULT 'farm',
	`project_id` bigint unsigned,
	`status` enum('active','inactive') NOT NULL DEFAULT 'active',
	`created_at` datetime(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP(3)),
	`updated_at` datetime(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP(3)),
	`deleted_at` datetime(3),
	CONSTRAINT `casual_workers_id` PRIMARY KEY(`id`),
	CONSTRAINT `casual_workers_nid_uq` UNIQUE(`national_id`)
);
--> statement-breakpoint
CREATE TABLE `employees` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`user_id` bigint unsigned,
	`full_name` varchar(150) NOT NULL,
	`job_title` varchar(100),
	`department` varchar(100),
	`phone` varchar(30),
	`national_id` varchar(40),
	`bank_account` varchar(60),
	`basic_salary` decimal(15,2) NOT NULL DEFAULT 0,
	`allowances` decimal(15,2) NOT NULL DEFAULT 0,
	`deductions` decimal(15,2) NOT NULL DEFAULT 0,
	`hire_date` date,
	`cost_centre_type` enum('project','farm','office') NOT NULL DEFAULT 'office',
	`project_id` bigint unsigned,
	`status` enum('active','inactive') NOT NULL DEFAULT 'active',
	`created_at` datetime(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP(3)),
	`updated_at` datetime(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP(3)),
	`deleted_at` datetime(3),
	CONSTRAINT `employees_id` PRIMARY KEY(`id`),
	CONSTRAINT `employees_user_uq` UNIQUE(`user_id`)
);
--> statement-breakpoint
CREATE TABLE `payroll_items` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`run_id` bigint unsigned NOT NULL,
	`employee_id` bigint unsigned NOT NULL,
	`basic_salary` decimal(15,2) NOT NULL,
	`allowances` decimal(15,2) NOT NULL,
	`deductions` decimal(15,2) NOT NULL,
	`net_pay` decimal(15,2) NOT NULL,
	`transaction_id` bigint unsigned,
	CONSTRAINT `payroll_items_id` PRIMARY KEY(`id`),
	CONSTRAINT `payroll_items_uq` UNIQUE(`run_id`,`employee_id`)
);
--> statement-breakpoint
CREATE TABLE `payroll_runs` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`period` varchar(7) NOT NULL,
	`status` enum('draft','paid') NOT NULL DEFAULT 'draft',
	`total_net` decimal(15,2) NOT NULL DEFAULT 0,
	`created_by` bigint unsigned NOT NULL,
	`paid_by` bigint unsigned,
	`paid_at` datetime(3),
	`created_at` datetime(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP(3)),
	`updated_at` datetime(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP(3)),
	CONSTRAINT `payroll_runs_id` PRIMARY KEY(`id`),
	CONSTRAINT `payroll_runs_period_uq` UNIQUE(`period`)
);
--> statement-breakpoint
CREATE TABLE `daily_ops_reports` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`report_date` date NOT NULL,
	`submitted_by` bigint unsigned NOT NULL,
	`summary` json NOT NULL,
	`comments` text,
	`created_at` datetime(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP(3)),
	`updated_at` datetime(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP(3)),
	CONSTRAINT `daily_ops_reports_id` PRIMARY KEY(`id`),
	CONSTRAINT `daily_ops_reports_uq` UNIQUE(`submitted_by`,`report_date`)
);
--> statement-breakpoint
CREATE TABLE `field_issues` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`project_id` bigint unsigned NOT NULL,
	`progress_report_id` bigint unsigned,
	`raised_by` bigint unsigned NOT NULL,
	`title` varchar(191) NOT NULL,
	`description` text,
	`severity` enum('low','medium','high') NOT NULL,
	`status` enum('open','resolved') NOT NULL DEFAULT 'open',
	`resolution` text,
	`resolved_by` bigint unsigned,
	`resolved_at` datetime(3),
	`created_at` datetime(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP(3)),
	`updated_at` datetime(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP(3)),
	CONSTRAINT `field_issues_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `progress_reports` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`project_id` bigint unsigned NOT NULL,
	`technician_id` bigint unsigned NOT NULL,
	`report_date` date NOT NULL,
	`work_completed` text NOT NULL,
	`pending_work` text,
	`percent_complete` tinyint unsigned NOT NULL,
	`issues_summary` text,
	`latitude` decimal(10,7),
	`longitude` decimal(10,7),
	`status` enum('submitted','verified','queried') NOT NULL DEFAULT 'submitted',
	`verified_by` bigint unsigned,
	`verified_at` datetime(3),
	`query_comment` text,
	`technician_response` text,
	`client_ref` varchar(64),
	`created_at` datetime(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP(3)),
	`updated_at` datetime(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP(3)),
	CONSTRAINT `progress_reports_id` PRIMARY KEY(`id`),
	CONSTRAINT `progress_reports_client_ref_uq` UNIQUE(`client_ref`)
);
--> statement-breakpoint
CREATE TABLE `site_visits` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`project_id` bigint unsigned NOT NULL,
	`visited_by` bigint unsigned NOT NULL,
	`visit_date` date NOT NULL,
	`findings` text NOT NULL,
	`created_at` datetime(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP(3)),
	`updated_at` datetime(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP(3)),
	CONSTRAINT `site_visits_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `farm_report_entries` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`report_id` bigint unsigned NOT NULL,
	`greenhouse_id` bigint unsigned NOT NULL,
	`greenhouse_status` varchar(191),
	`crop_health` enum('good','fair','poor') NOT NULL DEFAULT 'good',
	`irrigation_done` boolean NOT NULL DEFAULT false,
	`pests_observed` text,
	`severity` enum('none','low','medium','high') NOT NULL DEFAULT 'none',
	CONSTRAINT `farm_report_entries_id` PRIMARY KEY(`id`),
	CONSTRAINT `farm_report_entries_uq` UNIQUE(`report_id`,`greenhouse_id`)
);
--> statement-breakpoint
CREATE TABLE `farm_reports` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`report_date` date NOT NULL,
	`submitted_by` bigint unsigned NOT NULL,
	`irrigation_notes` text,
	`visitors` text,
	`equipment_condition` text,
	`general_notes` text,
	`client_ref` varchar(64),
	`created_at` datetime(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP(3)),
	`updated_at` datetime(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP(3)),
	CONSTRAINT `farm_reports_id` PRIMARY KEY(`id`),
	CONSTRAINT `farm_reports_date_uq` UNIQUE(`report_date`),
	CONSTRAINT `farm_reports_client_ref_uq` UNIQUE(`client_ref`)
);
--> statement-breakpoint
CREATE TABLE `greenhouses` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`name` varchar(100) NOT NULL,
	`kind` enum('greenhouse','field_block') NOT NULL DEFAULT 'greenhouse',
	`size_sqm` decimal(12,2),
	`current_crop` varchar(100),
	`planting_date` date,
	`status` enum('active','fallow','maintenance') NOT NULL DEFAULT 'active',
	`notes` text,
	`created_at` datetime(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP(3)),
	`updated_at` datetime(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP(3)),
	`deleted_at` datetime(3),
	CONSTRAINT `greenhouses_id` PRIMARY KEY(`id`),
	CONSTRAINT `greenhouses_name_uq` UNIQUE(`name`)
);
--> statement-breakpoint
CREATE TABLE `harvests` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`greenhouse_id` bigint unsigned NOT NULL,
	`crop` varchar(100) NOT NULL,
	`quantity` decimal(14,3) NOT NULL,
	`unit` enum('kg','units') NOT NULL DEFAULT 'kg',
	`grade` enum('A','B','C','reject') NOT NULL DEFAULT 'A',
	`harvest_date` date NOT NULL,
	`notes` text,
	`recorded_by` bigint unsigned NOT NULL,
	`created_at` datetime(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP(3)),
	`updated_at` datetime(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP(3)),
	`deleted_at` datetime(3),
	CONSTRAINT `harvests_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `inspections` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`greenhouse_id` bigint unsigned NOT NULL,
	`agronomist_id` bigint unsigned NOT NULL,
	`inspection_date` date NOT NULL,
	`findings` text NOT NULL,
	`disease_identified` varchar(191),
	`severity` enum('none','low','medium','high') NOT NULL DEFAULT 'none',
	`recommended_treatment` text,
	`recommended_fertiliser` text,
	`follow_up_date` date,
	`status` enum('open','treated','closed') NOT NULL DEFAULT 'open',
	`created_at` datetime(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP(3)),
	`updated_at` datetime(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP(3)),
	`deleted_at` datetime(3),
	CONSTRAINT `inspections_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `daily_financial_reports` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`report_date` date NOT NULL,
	`data` json NOT NULL,
	`created_at` datetime(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP(3)),
	CONSTRAINT `daily_financial_reports_id` PRIMARY KEY(`id`),
	CONSTRAINT `dfr_date_uq` UNIQUE(`report_date`)
);
--> statement-breakpoint
CREATE TABLE `materials` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`name` varchar(150) NOT NULL,
	`sku` varchar(60),
	`unit` varchar(20) NOT NULL,
	`quantity_on_hand` decimal(14,3) NOT NULL DEFAULT 0,
	`reorder_level` decimal(14,3) NOT NULL DEFAULT 0,
	`average_unit_cost` decimal(15,2) NOT NULL DEFAULT 0,
	`low_stock_notified_at` datetime(3),
	`created_at` datetime(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP(3)),
	`updated_at` datetime(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP(3)),
	`deleted_at` datetime(3),
	CONSTRAINT `materials_id` PRIMARY KEY(`id`),
	CONSTRAINT `materials_sku_uq` UNIQUE(`sku`)
);
--> statement-breakpoint
CREATE TABLE `meeting_action_points` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`meeting_id` bigint unsigned NOT NULL,
	`description` text NOT NULL,
	`assignee_id` bigint unsigned,
	`due_date` date,
	`task_id` bigint unsigned,
	`created_at` datetime(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP(3)),
	CONSTRAINT `meeting_action_points_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `meeting_participants` (
	`meeting_id` bigint unsigned NOT NULL,
	`user_id` bigint unsigned NOT NULL,
	CONSTRAINT `meeting_participants_meeting_id_user_id_pk` PRIMARY KEY(`meeting_id`,`user_id`)
);
--> statement-breakpoint
CREATE TABLE `meetings` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`title` varchar(191) NOT NULL,
	`starts_at` datetime(3) NOT NULL,
	`ends_at` datetime(3),
	`location` varchar(191),
	`link` varchar(500),
	`agenda` text,
	`minutes` text,
	`status` enum('scheduled','completed','cancelled') NOT NULL DEFAULT 'scheduled',
	`organizer_id` bigint unsigned NOT NULL,
	`reminder_sent_at` datetime(3),
	`created_at` datetime(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP(3)),
	`updated_at` datetime(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP(3)),
	`deleted_at` datetime(3),
	CONSTRAINT `meetings_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `report_requests` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`requested_by` bigint unsigned NOT NULL,
	`assignee_id` bigint unsigned NOT NULL,
	`title` varchar(191) NOT NULL,
	`description` text,
	`due_date` date,
	`status` enum('open','delivered','cancelled') NOT NULL DEFAULT 'open',
	`response` text,
	`delivered_at` datetime(3),
	`created_at` datetime(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP(3)),
	`updated_at` datetime(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP(3)),
	CONSTRAINT `report_requests_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `stock_movements` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`material_id` bigint unsigned NOT NULL,
	`type` enum('receipt','issue','adjustment') NOT NULL,
	`quantity` decimal(14,3) NOT NULL,
	`unit_cost` decimal(15,2) NOT NULL DEFAULT 0,
	`total_cost` decimal(15,2) NOT NULL DEFAULT 0,
	`supplier` varchar(150),
	`is_imported` boolean NOT NULL DEFAULT false,
	`shipment_reference` varchar(100),
	`cost_centre_type` enum('project','farm','office'),
	`project_id` bigint unsigned,
	`movement_date` date NOT NULL,
	`notes` text,
	`transaction_id` bigint unsigned,
	`performed_by` bigint unsigned NOT NULL,
	`created_at` datetime(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP(3)),
	CONSTRAINT `stock_movements_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `password_reset_tokens` ADD CONSTRAINT `password_reset_tokens_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `role_permissions` ADD CONSTRAINT `role_permissions_role_id_roles_id_fk` FOREIGN KEY (`role_id`) REFERENCES `roles`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `users` ADD CONSTRAINT `users_role_id_roles_id_fk` FOREIGN KEY (`role_id`) REFERENCES `roles`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `audit_logs` ADD CONSTRAINT `audit_logs_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `documents` ADD CONSTRAINT `documents_uploaded_by_users_id_fk` FOREIGN KEY (`uploaded_by`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `notification_preferences` ADD CONSTRAINT `notification_preferences_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `notifications` ADD CONSTRAINT `notifications_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `customer_contacts` ADD CONSTRAINT `customer_contacts_customer_id_customers_id_fk` FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `customers` ADD CONSTRAINT `customers_created_by_users_id_fk` FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `interactions` ADD CONSTRAINT `interactions_customer_id_customers_id_fk` FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `interactions` ADD CONSTRAINT `interactions_lead_id_leads_id_fk` FOREIGN KEY (`lead_id`) REFERENCES `leads`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `interactions` ADD CONSTRAINT `interactions_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `leads` ADD CONSTRAINT `leads_owner_id_users_id_fk` FOREIGN KEY (`owner_id`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `leads` ADD CONSTRAINT `leads_customer_id_customers_id_fk` FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `leads` ADD CONSTRAINT `leads_project_id_projects_id_fk` FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `sales` ADD CONSTRAINT `sales_customer_id_customers_id_fk` FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `sales` ADD CONSTRAINT `sales_project_id_projects_id_fk` FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `sales` ADD CONSTRAINT `sales_recorded_by_users_id_fk` FOREIGN KEY (`recorded_by`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `satisfaction_ratings` ADD CONSTRAINT `satisfaction_ratings_project_id_projects_id_fk` FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `satisfaction_ratings` ADD CONSTRAINT `satisfaction_ratings_customer_id_customers_id_fk` FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `satisfaction_ratings` ADD CONSTRAINT `satisfaction_ratings_recorded_by_users_id_fk` FOREIGN KEY (`recorded_by`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `project_members` ADD CONSTRAINT `project_members_project_id_projects_id_fk` FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `project_members` ADD CONSTRAINT `project_members_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `project_members` ADD CONSTRAINT `project_members_assigned_by_users_id_fk` FOREIGN KEY (`assigned_by`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `project_status_history` ADD CONSTRAINT `project_status_history_project_id_projects_id_fk` FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `project_status_history` ADD CONSTRAINT `project_status_history_changed_by_users_id_fk` FOREIGN KEY (`changed_by`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `projects` ADD CONSTRAINT `projects_customer_id_customers_id_fk` FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `projects` ADD CONSTRAINT `projects_project_lead_id_users_id_fk` FOREIGN KEY (`project_lead_id`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `projects` ADD CONSTRAINT `projects_created_by_users_id_fk` FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `tasks` ADD CONSTRAINT `tasks_project_id_projects_id_fk` FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `tasks` ADD CONSTRAINT `tasks_assignee_id_users_id_fk` FOREIGN KEY (`assignee_id`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `tasks` ADD CONSTRAINT `tasks_created_by_users_id_fk` FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `budget_lines` ADD CONSTRAINT `budget_lines_budget_id_budgets_id_fk` FOREIGN KEY (`budget_id`) REFERENCES `budgets`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `budget_lines` ADD CONSTRAINT `budget_lines_category_id_categories_id_fk` FOREIGN KEY (`category_id`) REFERENCES `categories`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `budgets` ADD CONSTRAINT `budgets_project_id_projects_id_fk` FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `budgets` ADD CONSTRAINT `budgets_created_by_users_id_fk` FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `loan_repayments` ADD CONSTRAINT `loan_repayments_loan_id_loans_id_fk` FOREIGN KEY (`loan_id`) REFERENCES `loans`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `loan_repayments` ADD CONSTRAINT `loan_repayments_recorded_by_users_id_fk` FOREIGN KEY (`recorded_by`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `loans` ADD CONSTRAINT `loans_created_by_users_id_fk` FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `transactions` ADD CONSTRAINT `transactions_category_id_categories_id_fk` FOREIGN KEY (`category_id`) REFERENCES `categories`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `transactions` ADD CONSTRAINT `transactions_project_id_projects_id_fk` FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `transactions` ADD CONSTRAINT `transactions_loan_id_loans_id_fk` FOREIGN KEY (`loan_id`) REFERENCES `loans`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `transactions` ADD CONSTRAINT `transactions_recorded_by_users_id_fk` FOREIGN KEY (`recorded_by`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `request_events` ADD CONSTRAINT `request_events_request_id_requests_id_fk` FOREIGN KEY (`request_id`) REFERENCES `requests`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `request_events` ADD CONSTRAINT `request_events_actor_id_users_id_fk` FOREIGN KEY (`actor_id`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `requests` ADD CONSTRAINT `requests_requester_id_users_id_fk` FOREIGN KEY (`requester_id`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `requests` ADD CONSTRAINT `requests_category_id_categories_id_fk` FOREIGN KEY (`category_id`) REFERENCES `categories`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `requests` ADD CONSTRAINT `requests_project_id_projects_id_fk` FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `requests` ADD CONSTRAINT `requests_decided_by_users_id_fk` FOREIGN KEY (`decided_by`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `requests` ADD CONSTRAINT `requests_disbursed_by_users_id_fk` FOREIGN KEY (`disbursed_by`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `requests` ADD CONSTRAINT `requests_transaction_id_transactions_id_fk` FOREIGN KEY (`transaction_id`) REFERENCES `transactions`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `attendance` ADD CONSTRAINT `attendance_worker_id_casual_workers_id_fk` FOREIGN KEY (`worker_id`) REFERENCES `casual_workers`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `attendance` ADD CONSTRAINT `attendance_project_id_projects_id_fk` FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `attendance` ADD CONSTRAINT `attendance_recorded_by_users_id_fk` FOREIGN KEY (`recorded_by`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `casual_pay_items` ADD CONSTRAINT `casual_pay_items_run_id_casual_pay_runs_id_fk` FOREIGN KEY (`run_id`) REFERENCES `casual_pay_runs`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `casual_pay_items` ADD CONSTRAINT `casual_pay_items_worker_id_casual_workers_id_fk` FOREIGN KEY (`worker_id`) REFERENCES `casual_workers`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `casual_pay_items` ADD CONSTRAINT `casual_pay_items_transaction_id_transactions_id_fk` FOREIGN KEY (`transaction_id`) REFERENCES `transactions`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `casual_pay_items` ADD CONSTRAINT `casual_pay_items_project_id_projects_id_fk` FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `casual_pay_runs` ADD CONSTRAINT `casual_pay_runs_created_by_users_id_fk` FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `casual_pay_runs` ADD CONSTRAINT `casual_pay_runs_paid_by_users_id_fk` FOREIGN KEY (`paid_by`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `casual_workers` ADD CONSTRAINT `casual_workers_project_id_projects_id_fk` FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `employees` ADD CONSTRAINT `employees_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `employees` ADD CONSTRAINT `employees_project_id_projects_id_fk` FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `payroll_items` ADD CONSTRAINT `payroll_items_run_id_payroll_runs_id_fk` FOREIGN KEY (`run_id`) REFERENCES `payroll_runs`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `payroll_items` ADD CONSTRAINT `payroll_items_employee_id_employees_id_fk` FOREIGN KEY (`employee_id`) REFERENCES `employees`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `payroll_items` ADD CONSTRAINT `payroll_items_transaction_id_transactions_id_fk` FOREIGN KEY (`transaction_id`) REFERENCES `transactions`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `payroll_runs` ADD CONSTRAINT `payroll_runs_created_by_users_id_fk` FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `payroll_runs` ADD CONSTRAINT `payroll_runs_paid_by_users_id_fk` FOREIGN KEY (`paid_by`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `daily_ops_reports` ADD CONSTRAINT `daily_ops_reports_submitted_by_users_id_fk` FOREIGN KEY (`submitted_by`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `field_issues` ADD CONSTRAINT `field_issues_project_id_projects_id_fk` FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `field_issues` ADD CONSTRAINT `field_issues_progress_report_id_progress_reports_id_fk` FOREIGN KEY (`progress_report_id`) REFERENCES `progress_reports`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `field_issues` ADD CONSTRAINT `field_issues_raised_by_users_id_fk` FOREIGN KEY (`raised_by`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `field_issues` ADD CONSTRAINT `field_issues_resolved_by_users_id_fk` FOREIGN KEY (`resolved_by`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `progress_reports` ADD CONSTRAINT `progress_reports_project_id_projects_id_fk` FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `progress_reports` ADD CONSTRAINT `progress_reports_technician_id_users_id_fk` FOREIGN KEY (`technician_id`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `progress_reports` ADD CONSTRAINT `progress_reports_verified_by_users_id_fk` FOREIGN KEY (`verified_by`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `site_visits` ADD CONSTRAINT `site_visits_project_id_projects_id_fk` FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `site_visits` ADD CONSTRAINT `site_visits_visited_by_users_id_fk` FOREIGN KEY (`visited_by`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `farm_report_entries` ADD CONSTRAINT `farm_report_entries_report_id_farm_reports_id_fk` FOREIGN KEY (`report_id`) REFERENCES `farm_reports`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `farm_report_entries` ADD CONSTRAINT `farm_report_entries_greenhouse_id_greenhouses_id_fk` FOREIGN KEY (`greenhouse_id`) REFERENCES `greenhouses`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `farm_reports` ADD CONSTRAINT `farm_reports_submitted_by_users_id_fk` FOREIGN KEY (`submitted_by`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `harvests` ADD CONSTRAINT `harvests_greenhouse_id_greenhouses_id_fk` FOREIGN KEY (`greenhouse_id`) REFERENCES `greenhouses`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `harvests` ADD CONSTRAINT `harvests_recorded_by_users_id_fk` FOREIGN KEY (`recorded_by`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `inspections` ADD CONSTRAINT `inspections_greenhouse_id_greenhouses_id_fk` FOREIGN KEY (`greenhouse_id`) REFERENCES `greenhouses`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `inspections` ADD CONSTRAINT `inspections_agronomist_id_users_id_fk` FOREIGN KEY (`agronomist_id`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `meeting_action_points` ADD CONSTRAINT `meeting_action_points_meeting_id_meetings_id_fk` FOREIGN KEY (`meeting_id`) REFERENCES `meetings`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `meeting_action_points` ADD CONSTRAINT `meeting_action_points_assignee_id_users_id_fk` FOREIGN KEY (`assignee_id`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `meeting_action_points` ADD CONSTRAINT `meeting_action_points_task_id_tasks_id_fk` FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `meeting_participants` ADD CONSTRAINT `meeting_participants_meeting_id_meetings_id_fk` FOREIGN KEY (`meeting_id`) REFERENCES `meetings`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `meeting_participants` ADD CONSTRAINT `meeting_participants_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `meetings` ADD CONSTRAINT `meetings_organizer_id_users_id_fk` FOREIGN KEY (`organizer_id`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `report_requests` ADD CONSTRAINT `report_requests_requested_by_users_id_fk` FOREIGN KEY (`requested_by`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `report_requests` ADD CONSTRAINT `report_requests_assignee_id_users_id_fk` FOREIGN KEY (`assignee_id`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `stock_movements` ADD CONSTRAINT `stock_movements_material_id_materials_id_fk` FOREIGN KEY (`material_id`) REFERENCES `materials`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `stock_movements` ADD CONSTRAINT `stock_movements_project_id_projects_id_fk` FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `stock_movements` ADD CONSTRAINT `stock_movements_performed_by_users_id_fk` FOREIGN KEY (`performed_by`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `users_role_idx` ON `users` (`role_id`);--> statement-breakpoint
CREATE INDEX `audit_entity_idx` ON `audit_logs` (`entity_type`,`entity_id`);--> statement-breakpoint
CREATE INDEX `audit_user_idx` ON `audit_logs` (`user_id`);--> statement-breakpoint
CREATE INDEX `audit_created_idx` ON `audit_logs` (`created_at`);--> statement-breakpoint
CREATE INDEX `documents_entity_idx` ON `documents` (`entity_type`,`entity_id`);--> statement-breakpoint
CREATE INDEX `notif_user_read_idx` ON `notifications` (`user_id`,`read_at`);--> statement-breakpoint
CREATE INDEX `customers_name_idx` ON `customers` (`name`);--> statement-breakpoint
CREATE INDEX `interactions_customer_idx` ON `interactions` (`customer_id`);--> statement-breakpoint
CREATE INDEX `leads_stage_idx` ON `leads` (`stage`);--> statement-breakpoint
CREATE INDEX `leads_owner_idx` ON `leads` (`owner_id`);--> statement-breakpoint
CREATE INDEX `sales_date_idx` ON `sales` (`sale_date`);--> statement-breakpoint
CREATE INDEX `psh_project_idx` ON `project_status_history` (`project_id`);--> statement-breakpoint
CREATE INDEX `projects_status_idx` ON `projects` (`status`);--> statement-breakpoint
CREATE INDEX `tasks_assignee_idx` ON `tasks` (`assignee_id`,`status`);--> statement-breakpoint
CREATE INDEX `tasks_project_idx` ON `tasks` (`project_id`);--> statement-breakpoint
CREATE INDEX `budgets_cost_centre_idx` ON `budgets` (`cost_centre_type`,`project_id`);--> statement-breakpoint
CREATE INDEX `loan_repayments_loan_idx` ON `loan_repayments` (`loan_id`);--> statement-breakpoint
CREATE INDEX `tx_date_idx` ON `transactions` (`transaction_date`);--> statement-breakpoint
CREATE INDEX `tx_cost_centre_idx` ON `transactions` (`cost_centre_type`,`project_id`);--> statement-breakpoint
CREATE INDEX `tx_reference_idx` ON `transactions` (`reference`);--> statement-breakpoint
CREATE INDEX `tx_source_idx` ON `transactions` (`source`,`source_id`);--> statement-breakpoint
CREATE INDEX `tx_loan_idx` ON `transactions` (`loan_id`);--> statement-breakpoint
CREATE INDEX `request_events_request_idx` ON `request_events` (`request_id`);--> statement-breakpoint
CREATE INDEX `requests_status_idx` ON `requests` (`status`);--> statement-breakpoint
CREATE INDEX `requests_requester_idx` ON `requests` (`requester_id`);--> statement-breakpoint
CREATE INDEX `requests_cost_centre_idx` ON `requests` (`cost_centre_type`,`project_id`);--> statement-breakpoint
CREATE INDEX `attendance_date_idx` ON `attendance` (`work_date`);--> statement-breakpoint
CREATE INDEX `field_issues_project_idx` ON `field_issues` (`project_id`,`status`);--> statement-breakpoint
CREATE INDEX `progress_reports_project_idx` ON `progress_reports` (`project_id`,`report_date`);--> statement-breakpoint
CREATE INDEX `progress_reports_tech_idx` ON `progress_reports` (`technician_id`);--> statement-breakpoint
CREATE INDEX `site_visits_project_idx` ON `site_visits` (`project_id`);--> statement-breakpoint
CREATE INDEX `harvests_date_idx` ON `harvests` (`harvest_date`);--> statement-breakpoint
CREATE INDEX `harvests_gh_idx` ON `harvests` (`greenhouse_id`);--> statement-breakpoint
CREATE INDEX `inspections_gh_idx` ON `inspections` (`greenhouse_id`,`inspection_date`);--> statement-breakpoint
CREATE INDEX `meetings_starts_idx` ON `meetings` (`starts_at`);--> statement-breakpoint
CREATE INDEX `report_requests_assignee_idx` ON `report_requests` (`assignee_id`,`status`);--> statement-breakpoint
CREATE INDEX `stock_movements_material_idx` ON `stock_movements` (`material_id`,`movement_date`);