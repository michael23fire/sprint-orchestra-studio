import type { AppUser } from '../context/UserContext';
import type { Ticket } from '../types/ticket';

/** Sentinel for board toolbar “Unassigned” filter (not a display name). */
export const BOARD_ASSIGNEE_FILTER_UNASSIGNED = '__unassigned__';

export function primaryAssigneeName(t: Ticket): string | undefined {
  const single = t.assignee?.trim();
  if (single) return single;
  const list = t.assignees?.map((x) => String(x).trim()).filter(Boolean);
  if (list?.length) return list[0];
  return undefined;
}

/**
 * Empty selection = show everyone (Jira “All assignees”).
 * Non-empty = OR match: ticket matches if its assignee is any selected name,
 * or if Unassigned is selected and the ticket has no assignee.
 */
export function ticketMatchesAssigneeFilter(t: Ticket, filters: readonly string[]): boolean {
  if (filters.length === 0) return true;
  const p = primaryAssigneeName(t);
  const wantUnassigned = filters.includes(BOARD_ASSIGNEE_FILTER_UNASSIGNED);
  if (!p) return wantUnassigned;
  return filters.includes(p);
}

/** Toggle a chip in the multi-select assignee filter (Jira-style stack / OR). */
export function toggleAssigneeFilter(current: readonly string[], value: string): string[] {
  if (current.includes(value)) return current.filter((x) => x !== value);
  return [...current, value];
}

/**
 * Assignee chips / filter options for Board & Backlog.
 * When `spaceMemberIds` is set, only assignees who belong to that space are listed.
 */
export function collectToolbarAssigneeNames(
  tickets: Ticket[],
  opts?: {
    excludeEpics?: boolean;
    spaceMemberIds?: Iterable<string>;
  },
): { sortedNames: string[]; anyUnassigned: boolean } {
  const memberIds = opts?.spaceMemberIds
    ? new Set(Array.from(opts.spaceMemberIds, String))
    : null;
  const names = new Set<string>();
  let anyUnassigned = false;
  for (const t of tickets) {
    if (opts?.excludeEpics && t.issueType === 'epic') continue;
    const p = primaryAssigneeName(t);
    if (!p) {
      anyUnassigned = true;
      continue;
    }
    if (memberIds) {
      if (t.assigneeId == null || !memberIds.has(String(t.assigneeId))) continue;
    }
    names.add(p);
  }
  return {
    sortedNames: Array.from(names).sort((a, b) => a.localeCompare(b)),
    anyUnassigned,
  };
}

export function initialsForPerson(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length >= 2) {
    return `${parts[0].charAt(0)}${parts[parts.length - 1].charAt(0)}`.toUpperCase();
  }
  const one = parts[0] ?? '?';
  return one.slice(0, Math.min(2, one.length)).toUpperCase();
}

export function resolveAssigneeAvatarBackground(name: string, users: AppUser[]): string {
  const u = users.find((x) => x.name === name);
  return u?.avatarColor ?? 'linear-gradient(135deg, #10b981, #059669)';
}

/** Inline avatars on the board toolbar vs overflow “+N” picker. */
export function partitionAssigneesForToolbar(
  sortedNames: string[],
  maxInline: number,
  activeFilters: readonly string[],
): { inline: string[]; overflow: string[] } {
  if (sortedNames.length <= maxInline) {
    return { inline: [...sortedNames], overflow: [] };
  }
  const naturalInline = sortedNames.slice(0, maxInline);
  const selected = activeFilters.filter(
    (f) => f !== BOARD_ASSIGNEE_FILTER_UNASSIGNED && sortedNames.includes(f),
  );
  const needPin = selected.filter((n) => !naturalInline.includes(n));
  if (needPin.length === 0) {
    return {
      inline: naturalInline,
      overflow: sortedNames.slice(maxInline),
    };
  }
  const withoutPinned = sortedNames.filter((n) => !needPin.includes(n));
  const inline = [...needPin, ...withoutPinned].slice(0, maxInline);
  const inlineSet = new Set(inline);
  const overflow = sortedNames.filter((n) => !inlineSet.has(n));
  return { inline, overflow };
}
