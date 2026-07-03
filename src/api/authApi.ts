import { api } from './client';
import type { UserDto } from './userApi';

export interface LoginRequest {
  username: string;
  password: string;
}

export interface AuthTokenResponse {
  accessToken: string;
  tokenType: string;
  expiresInMinutes: number;
  user: UserDto;
}

export interface AuthConfigResponse {
  githubOAuthEnabled: boolean;
}

export const authApi = {
  login: (req: LoginRequest) => api.post<AuthTokenResponse>('/api/auth/token', req),
  getConfig: () => api.get<AuthConfigResponse>('/api/auth/config'),
};
