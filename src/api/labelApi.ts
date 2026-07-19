import { api } from './client';

export interface LabelDto {
  id: number;
  spaceId: number;
  name: string;
}

export const labelApi = {
  getBySpace: (spaceId: number) =>
    api.get<LabelDto[]>(`/api/spaces/${spaceId}/labels`),
  create: (spaceId: number, name: string) =>
    api.post<LabelDto>(`/api/spaces/${spaceId}/labels`, { name }),
  delete: (spaceId: number, labelId: number) =>
    api.delete<void>(`/api/spaces/${spaceId}/labels/${labelId}`),
};
