import { describe, expect, it } from 'vitest';
import {
  compareByDeadline,
  completedOnTime,
  isTaskOverdue,
} from '../../src/modules/tasks/tasks.rules.js';

describe('task rules (SRS 3.6)', () => {
  it('overdue = deadline passed and not done (FR-TSK-03)', () => {
    expect(isTaskOverdue('2026-03-01', 'in_progress', '2026-03-02')).toBe(true);
    expect(isTaskOverdue('2026-03-02', 'in_progress', '2026-03-02')).toBe(false);
    expect(isTaskOverdue('2026-03-01', 'done', '2026-03-02')).toBe(false);
    expect(isTaskOverdue(null, 'blocked', '2026-03-02')).toBe(false);
  });

  it('on time = completed on or before the deadline (FR-TSK-04)', () => {
    expect(completedOnTime('2026-03-02', '2026-03-02')).toBe(true);
    expect(completedOnTime('2026-03-02', '2026-03-03')).toBe(false);
    expect(completedOnTime(null, '2026-03-03')).toBe(true);
  });

  it('sorts by deadline with undated tasks last (US-TECH-004)', () => {
    const tasks = [
      { id: 1, deadline: null },
      { id: 2, deadline: '2026-05-01' },
      { id: 3, deadline: '2026-04-01' },
      { id: 4, deadline: '2026-04-01' },
    ];
    expect([...tasks].sort(compareByDeadline).map((t) => t.id)).toEqual([3, 4, 2, 1]);
  });
});
