/**
 * Ticket API service.
 *
 * All functions currently return mock data so the UI works standalone.
 * To wire up the real backend, replace each function body with the
 * corresponding apiRequest() call — the signatures stay identical.
 *
 * Assumed REST endpoints (adjust to match your actual backend):
 *   GET    /sprints/:sprintId/tickets          → getTicketsBySprint
 *   GET    /tickets/:id                        → getTicketById
 *   POST   /tickets                            → createTicket
 *   PATCH  /tickets/:id                        → updateTicket
 *   DELETE /tickets/:id                        → deleteTicket
 *   GET    /tickets/:id/subtasks               → getSubtasks
 *   POST   /tickets/:parentId/subtasks         → createSubtask
 */

import type { Ticket } from '../types/ticket';
import { mockTickets } from '../data/mockTickets';
// import { apiRequest } from './client';  ← uncomment when ready

/* ---------- Read ---------- */

export async function getTicketsBySprint(_sprintId: string): Promise<Ticket[]> {
  // TODO: return apiRequest<Ticket[]>(`/sprints/${sprintId}/tickets`);
  return Promise.resolve([...mockTickets]);
}

export async function getTicketById(id: string): Promise<Ticket> {
  // TODO: return apiRequest<Ticket>(`/tickets/${id}`);
  const ticket = mockTickets.find((t) => t.id === id);
  if (!ticket) throw new Error(`Ticket ${id} not found`);
  return Promise.resolve({ ...ticket });
}

export async function getSubtasks(parentId: string): Promise<Ticket[]> {
  // TODO: return apiRequest<Ticket[]>(`/tickets/${parentId}/subtasks`);
  return Promise.resolve(mockTickets.filter((t) => t.parentId === parentId));
}

/* ---------- Create ---------- */

export async function createTicket(data: Omit<Ticket, 'id'>): Promise<Ticket> {
  // TODO: return apiRequest<Ticket>('/tickets', { method: 'POST', body: data });
  const id = `SCRUM-${Date.now()}`;
  return Promise.resolve({ ...data, id });
}

export async function createSubtask(parentId: string, data: Omit<Ticket, 'id' | 'parentId'>): Promise<Ticket> {
  // TODO: return apiRequest<Ticket>(`/tickets/${parentId}/subtasks`, { method: 'POST', body: data });
  const id = `SCRUM-${Date.now()}`;
  return Promise.resolve({ ...data, id, parentId });
}

/* ---------- Update ---------- */

export async function updateTicket(id: string, changes: Partial<Ticket>): Promise<Ticket> {
  // TODO: return apiRequest<Ticket>(`/tickets/${id}`, { method: 'PATCH', body: changes });
  const ticket = mockTickets.find((t) => t.id === id);
  if (!ticket) throw new Error(`Ticket ${id} not found`);
  return Promise.resolve({ ...ticket, ...changes });
}

/* ---------- Delete ---------- */

export async function deleteTicket(_id: string): Promise<void> {
  // TODO: return apiRequest<void>(`/tickets/${_id}`, { method: 'DELETE' });
  return Promise.resolve();
}
