import type { LeadStage, ProjectStatus } from '../../db/enums.js';

/** Stages that still count as live pipeline (FR-BDV-02). */
export const OPEN_STAGES: readonly LeadStage[] = [
  'new',
  'contacted',
  'proposal_sent',
  'negotiation',
];

export function isOpenStage(stage: LeadStage): boolean {
  return OPEN_STAGES.includes(stage);
}

/** Win rate = won ÷ (won + lost) × 100, 1 decimal; null when nothing was closed (FR-BDV-07). */
export function winRate(won: number, lost: number): number | null {
  const closed = won + lost;
  if (!closed) return null;
  return Math.round((won / closed) * 1000) / 10;
}

/**
 * Validates a stage change. Returns an error message or null when allowed.
 * - Lost needs a reason (FR-BDV-02).
 * - A converted lead is final.
 * - Reopening a lost lead is allowed (the route already requires crm:manage).
 */
export function stageChangeError(
  lead: { stage: LeadStage; convertedAt: Date | null },
  to: LeadStage,
  lostReason?: string | null,
): string | null {
  if (lead.convertedAt) return 'This lead has been converted and can no longer change stage';
  if (lead.stage === to) return `The lead is already ${to.replace('_', ' ')}`;
  if (to === 'lost' && !lostReason?.trim()) return 'A reason is required when a lead is lost';
  return null;
}

/** FR-BDV-04: only Won, unconverted leads can be converted. */
export function conversionError(lead: {
  stage: LeadStage;
  convertedAt: Date | null;
}): string | null {
  if (lead.convertedAt) return 'This lead has already been converted';
  if (lead.stage !== 'won') return 'Only won leads can be converted into a customer and project';
  return null;
}

/** FR-BDV-08: satisfaction is recorded after the project is completed. */
export const RATEABLE_PROJECT_STATUSES: readonly ProjectStatus[] = [
  'completed',
  'pl_analysed',
  'closed',
];

export function canRateProject(status: ProjectStatus): boolean {
  return RATEABLE_PROJECT_STATUSES.includes(status);
}
