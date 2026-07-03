import { api } from './client';
import type { UserDto } from './userApi';

export interface GroupDto {
  id: number;
  name: string;
  description: string | null;
  ownerId: number;
  ownerName: string;
  members: UserDto[];
}

export interface CreateGroupRequest {
  name: string;
  description?: string;
}

export const groupApi = {
  getAll: () => api.get<GroupDto[]>('/api/groups'),
  getById: (id: number) => api.get<GroupDto>(`/api/groups/${id}`),
  create: (req: CreateGroupRequest, ownerId: number) =>
    api.post<GroupDto>(`/api/groups?ownerId=${ownerId}`, req),
  update: (id: number, req: Partial<CreateGroupRequest>) =>
    api.put<GroupDto>(`/api/groups/${id}`, req),
  delete: (id: number) => api.delete<void>(`/api/groups/${id}`),

  getMembers: (groupId: number) => api.get<UserDto[]>(`/api/groups/${groupId}/members`),
  addMember: (groupId: number, userId: number) =>
    api.post<void>(`/api/groups/${groupId}/members`, { userId }),
  removeMember: (groupId: number, userId: number) =>
    api.delete<void>(`/api/groups/${groupId}/members/${userId}`),
};
