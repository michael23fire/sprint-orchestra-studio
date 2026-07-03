import type { Ticket, TicketStatus } from '../types/ticket';
import { getSameStatusSubtasks, isBoardDetachedSubtask, isSubtask } from './ticketHierarchy';

export type FlatDragItem =
  | { kind: 'parent'; ticket: Ticket; depth: number }
  | { kind: 'nested-sub'; ticket: Ticket; depth: number }
  | { kind: 'detached-sub'; ticket: Ticket; depth: number };

function appendTicketBranch(
  ticket: Ticket,
  role: 'parent' | 'nested-sub' | 'detached-sub',
  depth: number,
  items: FlatDragItem[],
  allTickets: Ticket[],
  collapsedParents: Set<string>,
  hideSubtasksOnBoard: boolean,
): void {
  items.push({ kind: role, ticket, depth });
  if (hideSubtasksOnBoard) return;
  if (collapsedParents.has(ticket.id)) return;
  const nested = getSameStatusSubtasks(ticket, allTickets);
  for (const sub of nested) {
    appendTicketBranch(sub, 'nested-sub', depth + 1, items, allTickets, collapsedParents, hideSubtasksOnBoard);
  }
}

export function buildFlatDragItems(
  sectionTickets: Ticket[],
  allTickets: Ticket[],
  collapsedParents: Set<string>,
  hideSubtasksOnBoard: boolean,
): FlatDragItem[] {
  const items: FlatDragItem[] = [];
  for (const ticket of sectionTickets) {
    if (isSubtask(ticket)) {
      // Board-level hide: suppress all subtask cards, including detached subtasks.
      if (hideSubtasksOnBoard) continue;
      appendTicketBranch(ticket, 'detached-sub', 0, items, allTickets, collapsedParents, hideSubtasksOnBoard);
    } else {
      appendTicketBranch(ticket, 'parent', 0, items, allTickets, collapsedParents, hideSubtasksOnBoard);
    }
  }
  return items;
}

/**
 * Reorder only top-level board rows (parents + detached subtasks). Nested same-stage children
 * always follow their parent via `buildFlatDragItems` — never sort the flat list globally.
 */
export function orderRootsBySaved(roots: Ticket[], saved: string[] | undefined): Ticket[] {
  if (!saved?.length) return roots;
  const byId = new Map(roots.map((t) => [t.id, t]));
  const rootSet = new Set(roots.map((t) => t.id));
  const seen = new Set<string>();
  const out: Ticket[] = [];
  for (const id of saved) {
    if (rootSet.has(id) && !seen.has(id)) {
      const t = byId.get(id);
      if (t) {
        out.push(t);
        seen.add(id);
      }
    }
  }
  for (const t of roots) {
    if (!seen.has(t.id)) out.push(t);
  }
  return out;
}

/** How many root-level cards appear strictly before this flat index (for drag → root order). */
export function countRootsBeforeFlatIndex(flat: FlatDragItem[], index: number): number {
  let c = 0;
  const max = Math.min(index, flat.length);
  for (let i = 0; i < max; i++) {
    if (flat[i].kind === 'parent' || flat[i].kind === 'detached-sub') c++;
  }
  return c;
}

export function mergeSavedFlatOrder(saved: string[], currentIds: string[]): string[] {
  const set = new Set(currentIds);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of saved) {
    if (set.has(id) && !seen.has(id)) {
      out.push(id);
      seen.add(id);
    }
  }
  for (const id of currentIds) {
    if (!seen.has(id)) {
      out.push(id);
      seen.add(id);
    }
  }
  return out;
}

export function arrayMove<T>(arr: T[], from: number, to: number): T[] {
  if (from < 0 || from >= arr.length) return [...arr];
  const copy = [...arr];
  const [item] = copy.splice(from, 1);
  const clampedTo = Math.min(Math.max(0, to), copy.length);
  copy.splice(clampedTo, 0, item);
  return copy;
}

/** One board column’s top-level rows (non-subtasks + detached subtasks), preserving `tickets` iteration order. */
export function groupTicketsByBoardColumn(tickets: Ticket[]): Record<TicketStatus, Ticket[]> {
  const map: Record<TicketStatus, Ticket[]> = {
    planned: [],
    in_progress: [],
    blocked: [],
    in_review: [],
    done: [],
  };
  for (const ticket of tickets) {
    const s = ticket.status;
    if (!isSubtask(ticket)) {
      map[s].push(ticket);
    } else if (isBoardDetachedSubtask(ticket, tickets)) {
      map[s].push(ticket);
    }
  }
  return map;
}
