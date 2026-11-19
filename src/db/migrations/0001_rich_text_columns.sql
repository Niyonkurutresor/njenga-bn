ALTER TABLE `customers` MODIFY COLUMN `notes` mediumtext;--> statement-breakpoint
ALTER TABLE `interactions` MODIFY COLUMN `summary` mediumtext NOT NULL;--> statement-breakpoint
ALTER TABLE `projects` MODIFY COLUMN `description` mediumtext;--> statement-breakpoint
ALTER TABLE `daily_ops_reports` MODIFY COLUMN `comments` mediumtext;--> statement-breakpoint
ALTER TABLE `field_issues` MODIFY COLUMN `description` mediumtext;--> statement-breakpoint
ALTER TABLE `field_issues` MODIFY COLUMN `resolution` mediumtext;--> statement-breakpoint
ALTER TABLE `progress_reports` MODIFY COLUMN `work_completed` mediumtext NOT NULL;--> statement-breakpoint
ALTER TABLE `progress_reports` MODIFY COLUMN `pending_work` mediumtext;--> statement-breakpoint
ALTER TABLE `progress_reports` MODIFY COLUMN `issues_summary` mediumtext;--> statement-breakpoint
ALTER TABLE `site_visits` MODIFY COLUMN `findings` mediumtext NOT NULL;--> statement-breakpoint
ALTER TABLE `farm_reports` MODIFY COLUMN `general_notes` mediumtext;--> statement-breakpoint
ALTER TABLE `inspections` MODIFY COLUMN `findings` mediumtext NOT NULL;--> statement-breakpoint
ALTER TABLE `inspections` MODIFY COLUMN `recommended_treatment` mediumtext;--> statement-breakpoint
ALTER TABLE `inspections` MODIFY COLUMN `recommended_fertiliser` mediumtext;--> statement-breakpoint
ALTER TABLE `meetings` MODIFY COLUMN `agenda` mediumtext;--> statement-breakpoint
ALTER TABLE `meetings` MODIFY COLUMN `minutes` mediumtext;--> statement-breakpoint
ALTER TABLE `report_requests` MODIFY COLUMN `description` mediumtext;--> statement-breakpoint
ALTER TABLE `report_requests` MODIFY COLUMN `response` mediumtext;