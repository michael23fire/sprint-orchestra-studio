import { api } from './client';
import type { UserDto } from './userApi';
import type { GroupDto } from './groupApi';

export interface SpaceDto {
  id: number;
  name: string;
  key: string;
  color: string;
  ownerId: number;
  members: UserDto[];
  groups: GroupDto[];
}

export interface CreateSpaceRequest {
  name: string;
  key: string;
  color: string;
}

export interface AddMemberRequest {
  userId: number;
  role?: string;
}

export const spaceApi = {
  getAll: (userId?: number) =>
    api.get<SpaceDto[]>(userId != null ? `/api/spaces?userId=${userId}` : '/api/spaces'),
  getById: (id: number) => api.get<SpaceDto>(`/api/spaces/${id}`),
  create: (req: CreateSpaceRequest, ownerId: number) =>
    api.post<SpaceDto>(`/api/spaces?ownerId=${ownerId}`, req),
  update: (id: number, req: Partial<CreateSpaceRequest>) =>
    api.put<SpaceDto>(`/api/spaces/${id}`, req),
  delete: (id: number) => api.delete<void>(`/api/spaces/${id}`),

  getMembers: (spaceId: number) => api.get<UserDto[]>(`/api/spaces/${spaceId}/members`),
  addMember: (spaceId: number, req: AddMemberRequest) =>
    api.post<void>(`/api/spaces/${spaceId}/members`, req),
  removeMember: (spaceId: number, userId: number) =>
    api.delete<void>(`/api/spaces/${spaceId}/members/${userId}`),

  getGroups: (spaceId: number) => api.get<GroupDto[]>(`/api/spaces/${spaceId}/groups`),
  addGroup: (spaceId: number, groupId: number) =>
    api.post<void>(`/api/spaces/${spaceId}/groups`, { groupId }),
  removeGroup: (spaceId: number, groupId: number) =>
    api.delete<void>(`/api/spaces/${spaceId}/groups/${groupId}`),
};
