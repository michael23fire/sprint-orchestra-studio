import { api } from './client';
import type { SprintReorderAction } from '../types/sprint';

export interface SprintDto {
  id: number;
  spaceId: number;
  name: string;
  goal: string | null;
  startDate: string | null;
  endDate: string | null;
  status: string;
  sprintOrder?: number;
}

export interface CreateSprintRequest {
  name: string;
  goal?: string;
  startDate?: string;
  endDate?: string;
  status?: string;
}

/** Jira-style complete: where incomplete issues go. */
export type IncompleteSprintDestination = 'backlog' | 'future_sprint' | 'new_sprint';

export interface CompleteSprintRequest {
  incompleteDestination?: IncompleteSprintDestination;
  moveToSprintId?: number;
  newSprintName?: string;
}

export interface ReorderSprintRequest {
  action: SprintReorderAction;
}

export const sprintApi = {
  getBySpace: (spaceId: number) =>
    api.get<SprintDto[]>(`/api/spaces/${spaceId}/sprints`),
  getById: (spaceId: number, id: number) =>
    api.get<SprintDto>(`/api/spaces/${spaceId}/sprints/${id}`),
  create: (spaceId: number, req: CreateSprintRequest) =>
    api.post<SprintDto>(`/api/spaces/${spaceId}/sprints`, req),
  update: (spaceId: number, id: number, req: Partial<CreateSprintRequest>) =>
    api.put<SprintDto>(`/api/spaces/${spaceId}/sprints/${id}`, req),
  complete: (spaceId: number, id: number, req?: CompleteSprintRequest) =>
    api.post<SprintDto>(`/api/spaces/${spaceId}/sprints/${id}/complete`, req ?? {}),
  reorder: (spaceId: number, id: number, req: ReorderSprintRequest) =>
    api.post<SprintDto[]>(`/api/spaces/${spaceId}/sprints/${id}/reorder`, req),
  delete: (spaceId: number, id: number) =>
    api.delete<void>(`/api/spaces/${spaceId}/sprints/${id}`),
};
