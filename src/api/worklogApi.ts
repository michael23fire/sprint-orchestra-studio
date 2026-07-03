import { api } from './client';

export interface WorkLogDto {
  id: number;
  issueId: number;
  authorId: number;
  authorName: string;
  spentMinutes: number;
  note: string | null;
  logDate: string;
  createdAt: string;
  updatedAt: string;
}

export interface CreateWorkLogRequest {
  authorId: number;
  spentMinutes: number;
  note?: string;
  logDate?: string;
}

export interface UpdateWorkLogRequest {
  spentMinutes?: number;
  note?: string;
  logDate?: string;
}

export const worklogApi = {
  getByIssue: (issueId: number) =>
    api.get<WorkLogDto[]>(`/api/issues/${issueId}/worklogs`),
  create: (issueId: number, req: CreateWorkLogRequest) =>
    api.post<WorkLogDto>(`/api/issues/${issueId}/worklogs`, req),
  update: (issueId: number, workLogId: number, req: UpdateWorkLogRequest) =>
    api.put<WorkLogDto>(`/api/issues/${issueId}/worklogs/${workLogId}`, req),
  delete: (issueId: number, workLogId: number) =>
    api.delete<void>(`/api/issues/${issueId}/worklogs/${workLogId}`),
};
