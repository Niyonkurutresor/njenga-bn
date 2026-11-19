import { eq } from 'drizzle-orm';
import type { Executor } from '../../db/client.js';
import { projectMembers, projectStatusHistory, projects } from '../../db/schema/index.js';
import { PROJECT_STATUSES, type ProjectStatus } from '../../db/enums.js';
import { nextReference } from '../../common/utils/sequence.js';
import { auditService } from '../audit/audit.service.js';

export interface NewProjectRecord {
  name: string;
  customerId?: number | null;
  clientName?: string | null;
  location?: string | null;
  contractValue: number;
  startDate?: string | null;
  endDate?: string | null;
  projectLeadId?: number | null;
  description?: string | null;
}

/**
 * Creates a project with its PRJ-YYYY-NNN code, status `created`, history row and audit entry.
 * Shared by the projects module (FR-PRJ-01) and lead conversion in CRM (FR-BDV-04).
 * The project lead, if any, is added to the team.
 */
export async function createProjectRecord(
  tx: Executor,
  input: NewProjectRecord,
  createdBy: number,
): Promise<{ id: number; code: string }> {
  const code = await nextReference(tx, 'PRJ', 3);
  const [res] = await tx.insert(projects).values({
    code,
    name: input.name,
    customerId: input.customerId ?? null,
    clientName: input.clientName ?? null,
    location: input.location ?? null,
    contractValue: input.contractValue,
    startDate: input.startDate ?? null,
    endDate: input.endDate ?? null,
    projectLeadId: input.projectLeadId ?? null,
    description: input.description ?? null,
    status: 'created',
    createdBy,
  });
  const id = res.insertId;
  if (input.projectLeadId) {
    await tx
      .insert(projectMembers)
      .values({ projectId: id, userId: input.projectLeadId, assignedBy: createdBy });
  }
  await tx
    .insert(projectStatusHistory)
    .values({ projectId: id, fromStatus: null, toStatus: 'created', changedBy: createdBy });
  await auditService.log(
    { action: 'create', entityType: 'project', entityId: id, newValues: { code, ...input } },
    tx,
  );
  return { id, code };
}

/**
 * Called by the finance module when a budget is set for a project: a `created` project
 * becomes `budgeted` (FR-PRJ-03 — a budget is required before moving beyond Created).
 */
export async function markProjectBudgeted(
  tx: Executor,
  projectId: number,
  changedBy: number,
): Promise<void> {
  const [project] = await tx
    .select({ status: projects.status })
    .from(projects)
    .where(eq(projects.id, projectId));
  if (project?.status !== 'created') return;
  await tx.update(projects).set({ status: 'budgeted' }).where(eq(projects.id, projectId));
  await tx.insert(projectStatusHistory).values({
    projectId,
    fromStatus: 'created',
    toStatus: 'budgeted',
    changedBy,
    note: 'Budget assigned',
  });
  await auditService.log(
    {
      action: 'status_change',
      entityType: 'project',
      entityId: projectId,
      oldValues: { status: 'created' },
      newValues: { status: 'budgeted' },
    },
    tx,
  );
}

/** Position of a status in the lifecycle (FR-PRJ-02). */
export function statusRank(status: ProjectStatus): number {
  return PROJECT_STATUSES.indexOf(status);
}

/**
 * Moves a project FORWARD to `to` if it is currently earlier in the lifecycle; never moves back.
 * Used by other modules for automatic milestones, e.g. a request for a project's funds
 * moves it to `funding_requested`, approval to `funding_approved`.
 *
 * Returns true when the status changed.
 */
export async function advanceProjectStatus(
  tx: Executor,
  projectId: number,
  to: ProjectStatus,
  changedBy: number | null,
  note?: string,
): Promise<boolean> {
  const [project] = await tx
    .select({ status: projects.status })
    .from(projects)
    .where(eq(projects.id, projectId));
  if (!project || statusRank(project.status) >= statusRank(to)) return false;
  // Automatic advancement never skips past execution-phase gates enforced by the projects module.
  if (statusRank(project.status) < statusRank('budgeted')) return false;

  await tx.update(projects).set({ status: to }).where(eq(projects.id, projectId));
  await tx.insert(projectStatusHistory).values({
    projectId,
    fromStatus: project.status,
    toStatus: to,
    changedBy,
    note: note ?? null,
  });
  await auditService.log(
    {
      action: 'status_change',
      entityType: 'project',
      entityId: projectId,
      oldValues: { status: project.status },
      newValues: { status: to },
    },
    tx,
  );
  return true;
}
