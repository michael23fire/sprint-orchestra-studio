import { api } from './client';

export interface UserDto {
  id: number;
  username: string;
  name: string;
  email: string;
  avatarColor: string;
  passwordLoginEnabled: boolean;
}

export interface CreateUserRequest {
  username: string;
  name: string;
  email: string;
  avatarColor?: string;
}

export const userApi = {
  getAll: () => api.get<UserDto[]>('/api/users'),
  getById: (id: number) => api.get<UserDto>(`/api/users/${id}`),
  create: (req: CreateUserRequest) => api.post<UserDto>('/api/users', req),
  delete: (id: number) => api.delete<void>(`/api/users/${id}`),
};
