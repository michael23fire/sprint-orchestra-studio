import type { Sprint } from '../types/sprint';

/** Inclusive date-range overlap (YYYY-MM-DD strings). */
export function sprintDatesOverlap(
  aStart: string,
  aEnd: string,
  bStart: string,
  bEnd: string,
): boolean {
  if (!aStart || !aEnd || !bStart || !bEnd) return false;
  return aStart <= bEnd && bStart <= aEnd;
}

/**
 * Jira-default (no Parallel Sprints): active + future sprints in a space
 * must not have overlapping date ranges. Completed sprints are ignored.
 */
export function findOverlappingSprint(
  sprints: Sprint[],
  startDate: string,
  endDate: string,
  excludeSprintId?: string,
): Sprint | null {
  if (!startDate || !endDate) return null;
  for (const s of sprints) {
    if (excludeSprintId && s.id === excludeSprintId) continue;
    if (s.status === 'completed') continue;
    if (!s.startDate || !s.endDate) continue;
    if (sprintDatesOverlap(startDate, endDate, s.startDate, s.endDate)) return s;
  }
  return null;
}

export function validateSprintDates(
  startDate: string,
  endDate: string,
): string | null {
  if (!startDate || !endDate) return 'Start and end dates are required.';
  if (endDate < startDate) return 'End date must be on or after the start date.';
  return null;
}

export function activeSprintInSpace(sprints: Sprint[], excludeSprintId?: string): Sprint | null {
  return sprints.find((s) => s.status === 'active' && s.id !== excludeSprintId) ?? null;
}
