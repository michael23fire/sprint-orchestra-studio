import { api } from './client';

export interface IssueLinkDto {
  id: number;
  relation: string;
  linkedIssueId: number;
  linkedIssueKey: string;
  linkedIssueTitle: string;
  createdAt: string;
}

export interface CreateIssueLinkRequest {
  relation: string;
  targetIssueKey: string;
}

export const issueLinkApi = {
  getByIssue: (issueId: number) => api.get<IssueLinkDto[]>(`/api/issues/${issueId}/links`),
  create: (issueId: number, req: CreateIssueLinkRequest) => api.post<IssueLinkDto>(`/api/issues/${issueId}/links`, req),
  delete: (issueId: number, linkId: number) => api.delete<void>(`/api/issues/${issueId}/links/${linkId}`),
};
