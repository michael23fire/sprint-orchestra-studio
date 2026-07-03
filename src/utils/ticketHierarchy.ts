import type { Ticket } from '../types/ticket';

/** Issue key of parent (Ticket.id is the issue key, e.g. SCRUM-1). */
export function isSubtask(t: Ticket): boolean {
  return t.issueType === 'subtask';
}

export function getDirectChildren(parentIssueKey: string, tickets: Ticket[]): Ticket[] {
  return tickets.filter((t) => t.parentId === parentIssueKey && t.issueType === 'subtask');
}

/** Subtasks that share the parent's column (same status) render nested under the parent on the board. */
export function getSameStatusSubtasks(parent: Ticket, tickets: Ticket[]): Ticket[] {
  return getDirectChildren(parent.id, tickets).filter((c) => c.status === parent.status);
}

/**
 * Subtask appears as its own card in a column when the parent is missing or in a different status column.
 */
export function isBoardDetachedSubtask(sub: Ticket, tickets: Ticket[]): boolean {
  if (!isSubtask(sub)) return false;
  if (!sub.parentId) return true;
  const parent = tickets.find((t) => t.id === sub.parentId);
  if (!parent) return true;
  return parent.status !== sub.status;
}

/** All descendant issue keys (nested by parentId, any issue type), depth-first pre-order. */
export function getDescendantKeys(rootIssueKey: string, tickets: Ticket[]): string[] {
  const keys: string[] = [];
  const walk = (parentKey: string) => {
    for (const t of tickets) {
      if (t.parentId === parentKey) {
        keys.push(t.id);
        walk(t.id);
      }
    }
  };
  walk(rootIssueKey);
  return keys;
}

/** Subtasks under this parent only (Jira-style sprint moves do not cascade to epic-linked stories). */
export function getDescendantSubtaskKeys(rootIssueKey: string, tickets: Ticket[]): string[] {
  const keys: string[] = [];
  const walk = (parentKey: string) => {
    for (const t of tickets) {
      if (t.parentId === parentKey && t.issueType === 'subtask') {
        keys.push(t.id);
        walk(t.id);
      }
    }
  };
  walk(rootIssueKey);
  return keys;
}
