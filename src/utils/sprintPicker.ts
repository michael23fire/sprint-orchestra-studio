import type { Sprint } from '../types/sprint';

/**
 * Sprints that can be chosen when assigning an issue: only **active** (started) sprints.
 * If the issue already has a sprint that is not active (future/completed), keep that entry
 * visible so the user can see the current value and move it to an active sprint or backlog.
 */
export function sprintsForIssueAssignment(sprints: Sprint[], issueSprintId?: string): Sprint[] {
  const active = sprints.filter((s) => s.status === 'active');
  if (!issueSprintId) return active;
  const current = sprints.find((s) => s.id === issueSprintId);
  if (!current || current.status === 'active') return active;
  return [current, ...active.filter((s) => s.id !== current.id)];
}
