export interface JobDefinition {
  /** Unique, kebab-case, e.g. "requests:escalate-pending". */
  name: string;
  /** Cron expression evaluated in the company timezone. */
  schedule: string;
  run: () => Promise<void>;
}
