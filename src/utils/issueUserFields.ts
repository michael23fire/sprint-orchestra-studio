import type { Ticket } from '../types/ticket';
import { USERS, type AppUser } from '../context/UserContext';

export function assigneeSelection(name: string | undefined): Pick<Ticket, 'assignee' | 'assigneeId'> {
  if (!name) return { assignee: undefined, assigneeId: undefined };
  const u = USERS.find((x) => x.name === name);
  return { assignee: name, assigneeId: u ? Number(u.id) : undefined };
}

export function reporterSelection(name: string | undefined): Pick<Ticket, 'reporter' | 'reporterId'> {
  if (!name) return { reporter: undefined, reporterId: undefined };
  const u = USERS.find((x) => x.name === name);
  return { reporter: name, reporterId: u ? Number(u.id) : undefined };
}

/** People who can be assigned / set as reporter in a space. */
export function usersInSpace(users: AppUser[], memberIds: Iterable<string>): AppUser[] {
  const allowed = new Set(Array.from(memberIds, String));
  return users
    .filter((u) => allowed.has(String(u.id)))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Space members for a picker, plus the current selection if they are no longer a member
 * (so the select still displays the existing value until the user changes it).
 */
export function spaceUserPickerOptions(
  users: AppUser[],
  memberIds: Iterable<string>,
  current?: { id?: number | string; name?: string },
): AppUser[] {
  const list = usersInSpace(users, memberIds);
  if (current?.id == null && !current?.name) return list;
  const id = current.id != null ? String(current.id) : undefined;
  if (id && list.some((u) => String(u.id) === id)) return list;
  if (current.name && list.some((u) => u.name === current.name)) return list;
  const orphan =
    (id ? users.find((u) => String(u.id) === id) : undefined)
    ?? (current.name ? users.find((u) => u.name === current.name) : undefined);
  if (!orphan) return list;
  return [...list, orphan].sort((a, b) => a.name.localeCompare(b.name));
}
