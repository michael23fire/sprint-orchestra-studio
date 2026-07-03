import { api } from './client';

export interface SprintDto {
  id: number;
  spaceId: number;
  name: string;
  goal: string | null;
  startDate: string | null;
  endDate: string | null;
  status: string;
}

export interface CreateSprintRequest {
  name: string;
  goal?: string;
  startDate?: string;
  endDate?: string;
  status?: string;
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
  delete: (spaceId: number, id: number) =>
    api.delete<void>(`/api/spaces/${spaceId}/sprints/${id}`),
};
