/**
 * Sprint API service.
 *
 * Same pattern as tickets.ts — swap each function body for apiRequest()
 * when the backend is ready.
 *
 * Assumed REST endpoints:
 *   GET    /projects/:projectId/sprints          → getSprints
 *   POST   /projects/:projectId/sprints          → createSprint
 *   PATCH  /sprints/:id                          → updateSprint
 *   POST   /sprints/:id/start                    → startSprint
 *   POST   /sprints/:id/complete                 → completeSprint
 *   DELETE /sprints/:id                          → deleteSprint
 */

import type { Sprint } from '../types/sprint';
import { mockSprints } from '../data/mockSprints';
// import { apiRequest } from './client';  ← uncomment when ready

export async function getSprints(_projectId: string): Promise<Sprint[]> {
  // TODO: return apiRequest<Sprint[]>(`/projects/${_projectId}/sprints`);
  return Promise.resolve([...mockSprints]);
}

export async function createSprint(_projectId: string, data: Omit<Sprint, 'id' | 'status'>): Promise<Sprint> {
  // TODO: return apiRequest<Sprint>(`/projects/${_projectId}/sprints`, { method: 'POST', body: data });
  return Promise.resolve({ ...data, id: `sprint-${Date.now()}`, status: 'future' });
}

export async function updateSprint(id: string, changes: Partial<Sprint>): Promise<Sprint> {
  // TODO: return apiRequest<Sprint>(`/sprints/${id}`, { method: 'PATCH', body: changes });
  const sprint = mockSprints.find((s) => s.id === id);
  if (!sprint) throw new Error(`Sprint ${id} not found`);
  return Promise.resolve({ ...sprint, ...changes });
}

export async function startSprint(id: string, data: Pick<Sprint, 'startDate' | 'endDate' | 'goal'>): Promise<Sprint> {
  // TODO: return apiRequest<Sprint>(`/sprints/${id}/start`, { method: 'POST', body: data });
  return updateSprint(id, { ...data, status: 'active' });
}

export async function completeSprint(id: string): Promise<Sprint> {
  // TODO: return apiRequest<Sprint>(`/sprints/${id}/complete`, { method: 'POST' });
  return updateSprint(id, { status: 'completed' });
}

export async function deleteSprint(id: string): Promise<void> {
  // TODO: return apiRequest<void>(`/sprints/${id}`, { method: 'DELETE' });
  void id;
  return Promise.resolve();
}
