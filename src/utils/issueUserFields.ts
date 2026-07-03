import type { Ticket } from '../types/ticket';
import { USERS } from '../context/UserContext';

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
