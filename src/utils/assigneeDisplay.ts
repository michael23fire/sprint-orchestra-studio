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

export function ticketMatchesAssigneeFilter(t: Ticket, filter: string | null): boolean {
  if (filter === null) return true;
  const p = primaryAssigneeName(t);
  if (filter === BOARD_ASSIGNEE_FILTER_UNASSIGNED) return !p;
  return p === filter;
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
  activeFilter: string | null,
): { inline: string[]; overflow: string[] } {
  if (sortedNames.length <= maxInline) {
    return { inline: [...sortedNames], overflow: [] };
  }
  if (
    activeFilter
    && activeFilter !== BOARD_ASSIGNEE_FILTER_UNASSIGNED
    && sortedNames.includes(activeFilter)
    && sortedNames.slice(0, maxInline).every((n) => n !== activeFilter)
  ) {
    const withoutActive = sortedNames.filter((n) => n !== activeFilter);
    const inline = [activeFilter, ...withoutActive.slice(0, maxInline - 1)];
    const inlineSet = new Set(inline);
    const overflow = sortedNames.filter((n) => !inlineSet.has(n));
    return { inline, overflow };
  }
  return {
    inline: sortedNames.slice(0, maxInline),
    overflow: sortedNames.slice(maxInline),
  };
}
