import type { IssueType, Ticket, TicketPriority, TicketStatus } from '../types/ticket';
import { primaryAssigneeName } from './assigneeDisplay';

/** Empty arrays mean “no restriction” on that dimension. */
export type IssueFilters = {
  assignees: string[];
  statuses: TicketStatus[];
  types: IssueType[];
  epicKeys: string[];
  priorities: TicketPriority[];
};

export const EMPTY_ISSUE_FILTERS: IssueFilters = {
  assignees: [],
  statuses: [],
  types: [],
  epicKeys: [],
  priorities: [],
};

export const UNASSIGNED_FILTER = '__unassigned__';

export function countActiveIssueFilters(filters: IssueFilters): number {
  return (
    filters.assignees.length +
    filters.statuses.length +
    filters.types.length +
    filters.epicKeys.length +
    filters.priorities.length
  );
}

export function hasActiveIssueFilters(filters: IssueFilters): boolean {
  return countActiveIssueFilters(filters) > 0;
}

function toggleInList<T>(list: T[], value: T): T[] {
  return list.includes(value) ? list.filter((x) => x !== value) : [...list, value];
}

export function toggleIssueFilterValue<K extends keyof IssueFilters>(
  filters: IssueFilters,
  key: K,
  value: IssueFilters[K][number],
): IssueFilters {
  const current = filters[key] as Array<IssueFilters[K][number]>;
  return { ...filters, [key]: toggleInList(current, value) };
}

/**
 * Match a ticket against multi-select filters.
 * When `skipAssignee` is true (Board already has avatar chips), assignee is ignored.
 * Pass `allTickets` so epic filters can walk story → epic for nested subtasks.
 */
export function ticketMatchesIssueFilters(
  t: Ticket,
  filters: IssueFilters,
  opts?: { skipAssignee?: boolean; allTickets?: Ticket[] },
): boolean {
  if (!opts?.skipAssignee && filters.assignees.length > 0) {
    const name = primaryAssigneeName(t);
    const ok = filters.assignees.some((a) =>
      a === UNASSIGNED_FILTER ? !name : name === a,
    );
    if (!ok) return false;
  }

  if (filters.statuses.length > 0 && !filters.statuses.includes(t.status)) {
    return false;
  }

  if (filters.types.length > 0) {
    const type = t.issueType ?? 'task';
    if (!filters.types.includes(type)) return false;
  }

  if (filters.epicKeys.length > 0) {
    if (!isUnderSelectedEpic(t, filters.epicKeys, opts?.allTickets)) return false;
  }

  if (filters.priorities.length > 0) {
    if (!t.priority || !filters.priorities.includes(t.priority)) return false;
  }

  return true;
}

function isUnderSelectedEpic(t: Ticket, epicKeys: string[], allTickets?: Ticket[]): boolean {
  if (t.issueType === 'epic') return epicKeys.includes(t.id);

  const byId = allTickets
    ? new Map(allTickets.map((x) => [x.id, x]))
    : undefined;

  let key: string | undefined = t.parentId;
  let hops = 0;
  while (key && hops < 8) {
    if (epicKeys.includes(key)) return true;
    const parent = byId?.get(key);
    if (!parent) break;
    if (parent.issueType === 'epic') return epicKeys.includes(parent.id);
    key = parent.parentId;
    hops++;
  }
  return false;
}

/** Keep parents of matched children so nested rows/cards stay coherent. */
export function withMatchedParents(matched: Ticket[], pool: Ticket[]): Ticket[] {
  const ids = new Set(matched.map((t) => t.id));
  const parentKeys = new Set<string>();
  for (const t of matched) {
    if (t.parentId) parentKeys.add(t.parentId);
  }
  const parents = pool.filter((t) => parentKeys.has(t.id) && !ids.has(t.id));
  return [...matched, ...parents];
}

/**
 * Keep subtasks of matched parents (from full pool) so board nesting / Hide-subtasks
 * still works when assignee/search filters would otherwise drop unassigned children.
 */
export function withMatchedChildren(matched: Ticket[], pool: Ticket[]): Ticket[] {
  const ids = new Set(matched.map((t) => t.id));
  const children = pool.filter(
    (t) =>
      t.issueType === 'subtask' &&
      t.parentId != null &&
      ids.has(t.parentId) &&
      !ids.has(t.id),
  );
  return children.length === 0 ? matched : [...matched, ...children];
}
