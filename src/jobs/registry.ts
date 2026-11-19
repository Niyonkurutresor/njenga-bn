import { crmJobs } from '../modules/crm/crm.jobs.js';
import { farmJobs } from '../modules/farm/farm.jobs.js';
import { fieldJobs } from '../modules/field/field.jobs.js';
import { meetingJobs } from '../modules/meetings/meetings.jobs.js';
import { reportJobs } from '../modules/reports/reports.jobs.js';
import { requestJobs } from '../modules/requests/requests.jobs.js';
import type { JobDefinition } from './job.types.js';

/** Every scheduled job in the system. Modules export `<module>Jobs` arrays; register them here. */
export const ALL_JOBS: readonly JobDefinition[] = [
  ...requestJobs,
  ...farmJobs,
  ...fieldJobs,
  ...crmJobs,
  ...meetingJobs,
  ...reportJobs,
];
