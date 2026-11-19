import { describe, expect, it } from 'vitest';
import {
  availableLifecycleActions,
  isProjectDelayed,
  projectPercentComplete,
  transitionError,
} from '../../src/modules/projects/projects.rules.js';

describe('project % complete (FR-PRJ-05)', () => {
  it('uses the latest verified progress report when there is one', () => {
    expect(
      projectPercentComplete({
        status: 'in_execution',
        latestVerifiedPercent: 65,
        doneTasks: 1,
        totalTasks: 10,
      }),
    ).toBe(65);
  });

  it('falls back to done ÷ total tasks', () => {
    expect(
      projectPercentComplete({
        status: 'in_execution',
        latestVerifiedPercent: null,
        doneTasks: 1,
        totalTasks: 3,
      }),
    ).toBe(33);
  });

  it('is null with no reports and no tasks, 100 once completed', () => {
    const base = { latestVerifiedPercent: null, doneTasks: 0, totalTasks: 0 };
    expect(projectPercentComplete({ ...base, status: 'budgeted' })).toBeNull();
    expect(projectPercentComplete({ ...base, status: 'completed' })).toBe(100);
  });
});

describe('Delayed flag (FR-PRJ-06)', () => {
  it('flags a running project past its end date', () => {
    expect(isProjectDelayed('2026-01-10', 'in_execution', '2026-01-11')).toBe(true);
  });
  it('does not flag on the end date, without one, or once completed', () => {
    expect(isProjectDelayed('2026-01-11', 'in_execution', '2026-01-11')).toBe(false);
    expect(isProjectDelayed(null, 'in_execution', '2026-01-11')).toBe(false);
    expect(isProjectDelayed('2026-01-10', 'completed', '2026-01-11')).toBe(false);
    expect(isProjectDelayed('2026-01-10', 'closed', '2026-01-11')).toBe(false);
  });
});

describe('lifecycle gates (FR-PRJ-02/03, BRL-07)', () => {
  it('requires a budget before leaving Created', () => {
    expect(transitionError('created', 'in_execution')).toMatch(/budget/i);
    expect(transitionError('created', 'budgeted')).toMatch(/Finance/);
  });

  it('starts execution from Budgeted or a funding status', () => {
    expect(transitionError('budgeted', 'in_execution')).toBeNull();
    expect(transitionError('funding_approved', 'in_execution')).toBeNull();
    expect(transitionError('completed', 'in_execution')).not.toBeNull();
  });

  it('completes only from execution, closes only after P/L analysis (BRL-07)', () => {
    expect(transitionError('in_execution', 'completed')).toBeNull();
    expect(transitionError('budgeted', 'completed')).not.toBeNull();
    expect(transitionError('completed', 'closed')).toMatch(/BRL-07/);
    expect(transitionError('pl_analysed', 'closed')).toBeNull();
    expect(transitionError('closed', 'in_execution')).toMatch(/closed/);
  });

  it('automatic statuses cannot be set by hand', () => {
    expect(transitionError('budgeted', 'tasks_assigned')).not.toBeNull();
    expect(transitionError('budgeted', 'funding_requested')).not.toBeNull();
  });

  it('lists the actions available from each status', () => {
    expect(availableLifecycleActions('created')).toEqual([]);
    expect(availableLifecycleActions('tasks_assigned')).toEqual(['start_execution']);
    expect(availableLifecycleActions('in_execution')).toEqual(['complete']);
    expect(availableLifecycleActions('completed')).toEqual(['pl_analysis']);
    expect(availableLifecycleActions('pl_analysed')).toEqual(['pl_analysis', 'close']);
    expect(availableLifecycleActions('closed')).toEqual([]);
  });
});
