import type { Ticket, TicketStatus } from '../types/ticket';

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

/** All subtasks of this parent that are present in the given board ticket set (any status). */
export function getBoardSubtasks(parent: Ticket, tickets: Ticket[]): Ticket[] {
  return getDirectChildren(parent.id, tickets);
}

/** Subtasks on the board whose status differs from the parent (shown as their own cards in other columns). */
export function getOtherStatusSubtasks(parent: Ticket, tickets: Ticket[]): Ticket[] {
  return getDirectChildren(parent.id, tickets).filter((c) => c.status !== parent.status);
}

/**
 * Resolve the epic for a work item (Jira-style):
 * - Epic → itself
 * - Story/Task with parent epic → that epic
 * - Subtask → inherit epic from its parent story/task (walk up)
 */
export function resolveEpicTicket(ticket: Ticket, tickets: Ticket[]): Ticket | undefined {
  if (ticket.issueType === 'epic') return ticket;
  const byId = new Map(tickets.map((t) => [t.id, t]));
  let key: string | undefined = ticket.parentId;
  let hops = 0;
  while (key && hops < 8) {
    const node = byId.get(key);
    if (!node) break;
    if (node.issueType === 'epic') return node;
    key = node.parentId;
    hops += 1;
  }
  return undefined;
}

export function resolveEpicKey(ticket: Ticket, tickets: Ticket[]): string | undefined {
  return resolveEpicTicket(ticket, tickets)?.id;
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

/** Built-in Epic automation: derive its workflow status from all descendant work. */
export function deriveEpicStatus(epicIssueKey: string, tickets: Ticket[]): TicketStatus {
  const descendants = getDescendantKeys(epicIssueKey, tickets)
    .map((key) => tickets.find((ticket) => ticket.id === key))
    .filter((ticket): ticket is Ticket => Boolean(ticket));
  if (descendants.length === 0 || descendants.every((ticket) => ticket.status === 'planned')) {
    return 'planned';
  }
  if (descendants.every((ticket) => ticket.status === 'done')) return 'done';
  return 'in_progress';
}

export function withDerivedEpicStatuses(tickets: Ticket[]): Ticket[] {
  return tickets.map((ticket) => (
    ticket.issueType === 'epic'
      ? { ...ticket, status: deriveEpicStatus(ticket.id, tickets) }
      : ticket
  ));
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
